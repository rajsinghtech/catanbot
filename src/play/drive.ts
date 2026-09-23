/** CDP driver: start Colonist Play vs. Bots games and click the live rec. Ranked is never started. */

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { decode as decodeMsgpack } from "@msgpack/msgpack";
import { autoClickAllowed, pickUiHit } from "./target.ts";

const BRIDGE = process.env.CATANBOT_BRIDGE ?? "http://127.0.0.1:8765";
let CDP = process.env.CATANBOT_CDP_URL?.replace(/\/$/, "") ?? "";
const OBSERVER_DIR = join(process.cwd(), "extension");
const NATIVE_CLICK_SOURCE = join(process.cwd(), "src/play/native-click.swift");
const execFileAsync = promisify(execFile);
let ownedChrome: ReturnType<typeof spawn> | null = null;
let ownedChromeProfile: string | null = null;

type Click = {
  kind: "board" | "ui";
  actionType?: string;
  ui?: string;
  prep?: string;
  x?: number;
  y?: number;
  vertex?: string;
  edge?: string;
  hex?: string;
  colonistIndex?: number;
  stealFrom?: string;
  stealFromColor?: number;
  give?: string;
  giveCount?: number;
  get?: string;
  getCount?: number;
  resource?: string;
  resources?: string[];
  tradeId?: string;
  discard?: Record<string, number>;
  discardUnknown?: number;
  label: string;
  actionId: string;
};

type NativeClicker = {
  click: (x: number, y: number) => Promise<void>;
  close: () => void;
};

const UI_PATTERNS: Record<string, string> = {
  roll: "^(roll|roll dice)$|action-button-roll|roll-dice-button",
  end_turn: "end turn|pass[- ]turn|action-button-pass-turn",
  settlement: "^place settlement\\b",
  road: "^place road\\b",
  city: "^city\\b",
  robber: "move robber|robber",
  buy_dev: "development|buy.*development|action-button-buy-dev-card",
  knight: "knight",
  monopoly: "monopoly",
  year: "year of plenty",
  road_building: "road building",
  trade: "trade|bank|action-button-trade",
  accept: "^accept\\b",
  reject: "reject|decline",
  discard: "discard|confirm",
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json() as Promise<T>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function chromeBinary(): string {
  if (process.env.CATANBOT_CHROME) return process.env.CATANBOT_CHROME;
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return process.env.CHROME_BIN ?? "google-chrome";
}

/** Own the browser used for actuation so a stale/shared Chrome cannot swallow CDP input. */
async function startOwnedChrome(): Promise<void> {
  if (CDP) return;
  if (process.env.CATANBOT_USE_EXISTING_CDP === "1") {
    CDP = `http://127.0.0.1:${process.env.CATANBOT_CDP_PORT ?? "9222"}`;
    console.log("attaching to existing Chrome", CDP);
    return;
  }
  const port = await freePort();
  ownedChromeProfile = await mkdtemp(join(tmpdir(), "catanbot-live-profile."));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${ownedChromeProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    `--disable-extensions-except=${OBSERVER_DIR}`,
    `--load-extension=${OBSERVER_DIR}`,
    "https://colonist.io/",
  ];
  ownedChrome = spawn(chromeBinary(), args, { stdio: "ignore" });
  CDP = `http://127.0.0.1:${port}`;
  process.once("exit", () => {
    if (ownedChrome && !ownedChrome.killed) ownedChrome.kill("SIGTERM");
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${CDP}/json/version`);
      if (res.ok) {
        console.log("started owned Chrome", CDP);
        return;
      }
    } catch {
      /* Chrome is still starting. */
    }
    if (ownedChrome.exitCode != null) throw new Error(`Chrome exited ${ownedChrome.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chrome did not open CDP at ${CDP}`);
}

async function stopOwnedChrome(): Promise<void> {
  const child = ownedChrome;
  ownedChrome = null;
  if (child && !child.killed) child.kill("SIGTERM");
  const profile = ownedChromeProfile;
  ownedChromeProfile = null;
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
}

function attachRpc(ws: WebSocket, onEvent?: (method: string, params: Record<string, unknown>) => void) {
  const pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
  const callTimeoutMs = Math.max(1500, Number(process.env.CATANBOT_CDP_TIMEOUT_MS ?? 3000));
  let next = 1;
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: unknown;
    };
    if (msg.method && onEvent) onEvent(msg.method, msg.params ?? {});
    if (msg.id == null) return;
    const fn = pending.get(msg.id);
    if (!fn) return;
    pending.delete(msg.id);
    fn(msg);
  });
  async function call(method: string, params: Record<string, unknown> = {}) {
    const id = next++;
    const msg = await new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: `CDP timeout calling ${method}` });
      }, callTimeoutMs);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ error });
      }
    });
    if (msg.error) throw new Error(JSON.stringify(msg.error));
    return msg.result;
  }
  async function evalOn(expression: string): Promise<unknown> {
    const result = (await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }
  async function mouse(x: number, y: number) {
    const px = Math.round(x);
    const py = Math.round(y);
    await evalOn(`(() => {
      window.__catanbotInputSeen = 0;
      document.addEventListener("mousedown", () => { window.__catanbotInputSeen += 1; }, { capture: true, once: true });
    })()`);
    const at = async (type: string, extra: Record<string, unknown> = {}) =>
      call("Input.dispatchMouseEvent", { type, x: px, y: py, pointerType: "mouse", ...extra });
    let cdpInputAvailable = true;
    for (const [type, extra, pause] of [
      ["mouseMoved", {}, 50],
      ["mousePressed", { button: "left", buttons: 1, clickCount: 1 }, 60],
      ["mouseReleased", { button: "left", buttons: 0, clickCount: 1 }, 0],
    ] as const) {
      try {
        await at(type, extra);
      } catch {
        cdpInputAvailable = false;
        break;
      }
      if (pause) await new Promise((r) => setTimeout(r, pause));
    }
    let delivered = false;
    if (cdpInputAvailable) {
      try {
        delivered = Boolean(await evalOn("window.__catanbotInputSeen > 0"));
      } catch {
        delivered = false;
      }
    }
    if (!delivered) {
      // Some hosted Chrome sessions accept CDP commands but drop the input at
      // the renderer boundary. Keep the fallback in this one driver so the
      // extension remains observation-only and the server still waits for
      // observed occupancy.
      const point = JSON.stringify({ x: px, y: py });
      try {
        await evalOn(`(() => {
          const p = ${point};
          const target = document.elementFromPoint(p.x, p.y) || document.body;
          const base = { bubbles: true, cancelable: true, view: window, clientX: p.x, clientY: p.y, screenX: p.x, screenY: p.y, button: 0 };
          const emit = (type, buttons) => {
            if (typeof PointerEvent === "function") {
              target.dispatchEvent(new PointerEvent(type, { ...base, pointerId: 1, isPrimary: true, pointerType: "mouse", buttons }));
            }
            target.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), { ...base, buttons }));
          };
          emit("pointermove", 0);
          emit("pointerdown", 1);
          emit("pointerup", 0);
          target.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
          const control = target.closest?.("button, a, [role=button]");
          if (control && control !== target) control.click();
          return true;
        })()`);
      } catch {
        /* The target may have navigated while the fallback was dispatched. */
      }
    }
  }
  return { call, evalOn, mouse };
}

async function startNativeClicker(cdp: { evalOn: (expression: string) => Promise<unknown> }): Promise<{
  clicker: NativeClicker;
  origin: { x: number; y: number };
} | null> {
  if (process.platform !== "darwin") return null;
  const binary = join(tmpdir(), `catanbot-native-click-${process.pid}`);
  try {
    await execFileAsync("swiftc", ["-O", NATIVE_CLICK_SOURCE, "-o", binary]);
    const probe = await execFileAsync(binary, ["--probe"]);
    if (probe.stdout.trim() !== "ready") throw new Error("macOS accessibility input is unavailable");
    const boundsText = (await execFileAsync("osascript", [
      "-e",
      'tell application "Google Chrome" to get bounds of front window',
    ])).stdout;
    const bounds = [...boundsText.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    const metrics = (await cdp.evalOn("({ innerWidth, innerHeight })")) as {
      innerWidth?: number;
      innerHeight?: number;
    } | undefined;
    if (bounds.length < 4 || !metrics?.innerWidth || !metrics.innerHeight) throw new Error("no Chrome window metrics");
    const [left, top, right, bottom] = bounds;
    const origin = {
      x: left + Math.max(0, (right - left - metrics.innerWidth) / 2),
      y: top + Math.max(0, bottom - top - metrics.innerHeight),
    };
    await execFileAsync("osascript", ["-e", 'tell application "Google Chrome" to activate']);
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
    const waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    let buffer = "";
    let closed = false;
    const fail = (error: Error) => {
      while (waiters.length) waiters.shift()!.reject(error);
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const waiter = waiters.shift();
        if (waiter) {
          if (line === "ok") waiter.resolve();
          else waiter.reject(new Error(`native click helper: ${line || "error"}`));
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.on("error", (error) => fail(error));
    child.on("exit", (code) => {
      closed = true;
      if (code) fail(new Error(`native click helper exited ${code}`));
    });
    return {
      origin,
      clicker: {
        click: (x, y) => new Promise<void>((resolve, reject) => {
          if (closed) {
            reject(new Error("native click helper closed"));
            return;
          }
          waiters.push({ resolve, reject });
          child.stdin.write(`${origin.x + x} ${origin.y + y}\n`);
        }),
        close: () => {
          closed = true;
          child.stdin.end();
          child.kill();
          void rm(binary, { force: true });
        },
      },
    };
  } catch (error) {
    await rm(binary, { force: true }).catch(() => {});
    console.log("native input unavailable", String(error));
    return null;
  }
}

async function findPage(): Promise<{ wsUrl: string; url: string }> {
  for (let i = 0; i < 12; i++) {
    const tabs = await json<Array<{ type: string; url: string; webSocketDebuggerUrl: string }>>(`${CDP}/json/list`);
    const page = tabs.find((t) => t.type === "page" && /colonist\.io/i.test(t.url));
    if (page) return { wsUrl: page.webSocketDebuggerUrl, url: page.url };
    try {
      await fetch(`${CDP}/json/new?https://colonist.io/`, { method: "PUT" });
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("no colonist tab");
}

async function main() {
  await startOwnedChrome();
  await json(`${BRIDGE}/api/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ on: true, vsBots: true, source: "driver" }),
  });

  const page = await findPage();
  let href = page.url;
  let lastHrefReadAt = Date.now();
  let locationSyncsRemaining = 12;
  const ws = new WebSocket(page.wsUrl);
  await new Promise((r, j) => {
    ws.onopen = () => r(null);
    ws.onerror = () => j(new Error("cdp"));
  });
  const cdp = attachRpc(ws, (method, params) => {
    if (method === "Page.frameNavigated") {
      const frame = params.frame as { parentId?: string; url?: string } | undefined;
      if (frame && !frame.parentId && frame.url) {
        href = frame.url;
        lastHrefReadAt = Date.now();
      }
      return;
    }
    if (method === "Network.webSocketFrameSent") {
      const sent = params.response as { opcode?: number; payloadData?: string } | undefined;
      if (sent?.payloadData && sent.opcode === 2) {
        try {
          const frame = decodeMsgpack(Buffer.from(sent.payloadData, "base64").subarray(3)) as {
            data?: { action?: string; payload?: unknown };
          };
          if (frame?.data?.action) console.log("ws-action", frame.data.action, JSON.stringify(frame.data.payload));
        } catch {
          /* Heartbeats and non-action frames are intentionally ignored. */
        }
      }
      return;
    }
    if (method !== "Network.webSocketFrameReceived") return;
    const response = params.response as { opcode?: number; payloadData?: string } | undefined;
    if (!response?.payloadData || response.opcode !== 2) return;
    const raw = Buffer.from(response.payloadData, "base64");
    const ping = Buffer.from([0x82, 0xa2, 0x69, 0x64, 0xa3, 0x31, 0x33, 0x36]);
    if (raw.length <= 40 && raw.subarray(0, ping.length).equals(ping)) return;
    // Do not issue a Runtime.evaluate for every websocket frame. Colonist
    // sends frequent heartbeats; that old per-frame URL lookup saturated CDP
    // and made the action loop look offline. Page.frameNavigated keeps href
    // current without competing with app-state reads.
    void fetch(`${BRIDGE}/api/ws`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ b64: response.payloadData, href }),
    }).catch(() => {});
  });
  await cdp.call("Runtime.enable");
  await cdp.call("Network.enable");
  await cdp.call("Page.enable");
  const [injectSource, hudSource] = await Promise.all([
    readFile(join(OBSERVER_DIR, "inject.js"), "utf8"),
    readFile(join(OBSERVER_DIR, "hud.js"), "utf8"),
  ]);
  // Install the websocket observer and the driver-owned HUD before the app
  // creates its socket. Branded Google Chrome ignores unpacked-extension
  // command-line flags, so the live driver cannot depend on the extension for
  // visibility or state display.
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: injectSource });
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: hudSource });
  await cdp.evalOn(hudSource).catch(() => {});
  try {
    await cdp.call("Page.bringToFront");
  } catch {
    /* some Chrome builds want Target.activateTarget */
  }
  const native = await startNativeClicker(cdp);
  const clickAt = async (x: number, y: number) => {
    if (native) return native.clicker.click(x, y);
    return cdp.mouse(x, y);
  };
  type AppBoardResult = {
    ok: boolean;
    mode?: "prepare" | "action" | "followup";
    locationIndex?: number;
    state?: string;
    reason?: string;
  };
  type AppSignature = {
    myColor?: number;
    currentTurnPlayerColor?: number;
    completedTurns?: number;
    turnState?: number;
    actionState?: number;
    diceThrown?: boolean;
    cards?: number[];
    devCards?: number[];
    usedDevCards?: number[];
    tradeExists?: boolean;
    tradeResponse?: number | null;
  };

  // Colonist's webpack module ids change between deployments. Resolve the
  // game-manager singleton from the current bundle instead of relying on one
  // stale numeric id; cache the discovered module id in this page afterward.
  const COLONIST_MANAGER_LOOKUP = `(() => {
    const req = window.__catanbotWebpackRequire;
    if (typeof req !== "function") return null;
    const find = (id) => {
      try {
        const exports = req(id);
        const values = [exports?.IH, exports?.default, ...(exports && typeof exports === "object" ? Object.values(exports) : [])];
        return values.find((value) => value && typeof value === "object" && value.gameController && value.socketGameSend) || null;
      } catch {
        return null;
      }
    };
    const cached = window.__catanbotManagerModuleId;
    if (cached != null) {
      const manager = find(cached);
      if (manager) return manager;
    }
    for (const id of [47570, 67210]) {
      const manager = find(id);
      if (manager) {
        window.__catanbotManagerModuleId = id;
        return manager;
      }
    }
    for (const [id, factory] of Object.entries(req.m || {})) {
      if (!String(factory).includes("socketGameSend")) continue;
      const manager = find(id);
      if (manager) {
        window.__catanbotManagerModuleId = Number(id);
        return manager;
      }
    }
    return null;
  })()`;

  /**
   * Use Colonist's own loaded game manager for board actions. The canvas is a
   * rendered view, not the protocol's coordinate system: its viewport can be
   * shifted by ads, the log strip, and responsive layout. The app already has
   * the authoritative HexCorner/HexEdge index and the sender that validates
   * it, so board actuation should go through that boundary and wait for the
   * websocket/map projection to acknowledge it.
   */
  const appBoardActuate = async (click: Click): Promise<AppBoardResult> => {
    const target = JSON.stringify({
      actionId: click.actionId,
      actionType: click.actionType ?? null,
      prep: click.prep ?? null,
      x: click.x ?? null,
      y: click.y ?? null,
      vertex: click.vertex ?? null,
      edge: click.edge ?? null,
      hex: click.hex ?? null,
      colonistIndex: click.colonistIndex ?? null,
      stealFrom: click.stealFrom ?? null,
      stealFromColor: click.stealFromColor ?? null,
      give: click.give ?? null,
      giveCount: click.giveCount ?? null,
      get: click.get ?? null,
      getCount: click.getCount ?? null,
      resource: click.resource ?? null,
      resources: click.resources ?? null,
      tradeId: click.tradeId ?? null,
      discard: click.discard ?? null,
      discardUnknown: click.discardUnknown ?? null,
    });
    const result = (await cdp.evalOn(`(() => {
      const target = ${target};
      const chunks = window.webpackChunkkatan;
      if (!chunks) return { ok: false, reason: "Colonist webpack runtime unavailable" };
      let req = window.__catanbotWebpackRequire;
      if (typeof req !== "function") {
        try {
          chunks.push([[Date.now()], {}, (runtime) => { req = runtime; }]);
        } catch (error) {
          return { ok: false, reason: String(error) };
        }
        if (typeof req === "function") window.__catanbotWebpackRequire = req;
      }
      if (typeof req !== "function") return { ok: false, reason: "Colonist webpack require unavailable" };
      let manager;
      try {
        manager = ${COLONIST_MANAGER_LOOKUP};
      } catch (error) {
        return { ok: false, reason: "Colonist game manager unavailable: " + String(error) };
      }
      if (!manager?.socketGameSend) return { ok: false, reason: "Colonist game manager is not in a live game" };

      const actionType = String(target.actionType || target.actionId || "").split(":", 1)[0];
      const qy = (() => {
        try {
          const actionEnums = req(22668) || {};
          return actionEnums.qy || actionEnums.Qy || {};
        } catch {
          return {};
        }
      })();
      const controllerState = manager.gameController?.currentState || {};
      const currentAction = Number.isFinite(Number(controllerState.actionState))
        ? controllerState.actionState
        : manager.gameController?.myActionState;
      const currentActionNumber = Number(currentAction);
      const resource = { wood: 1, brick: 2, sheep: 3, wheat: 4, ore: 5 };
      const resourceCard = (name) => resource[name];
      const actionEnums = (() => {
        try { return req(22668)?.qy || {}; } catch { return {}; }
      })();
      const cardEnums = (() => {
        try { return req(22668)?.O3 || {}; } catch { return {}; }
      })();
      const cardName = {
        PLAY_KNIGHT: "Knight",
        PLAY_MONOPOLY: "Monopoly",
        PLAY_YEAR_OF_PLENTY: "YearOfPlenty",
        PLAY_ROAD_BUILDING: "RoadBuilding",
      };
      const selectedResourceCards = (count) => {
        const requested = Array.isArray(target.resources) && target.resources.length
          ? target.resources
          : Array.from({ length: count }, () => target.resource);
        return requested
          .map((name) => resourceCard(name))
          .filter((card) => Number.isFinite(card));
      };
      const actualCards = () => {
        const player = (manager.gameState.players || []).find((entry) => entry.state?.color === manager.gameController?.myColor);
        return [...(player?.state?.resourceCards?.cards || player?.resourceCards?.state?.cards || [])];
      };
      if (actionType === "ACCEPT_TRADE" || actionType === "REJECT_TRADE") {
        const tradeId = String(target.tradeId || "");
        const activeOffers = manager.gameStore?.getState?.()?.gameState?.tradeState?.activeOffers || {};
        const offer = tradeId ? activeOffers[tradeId] : null;
        if (!tradeId || !offer || typeof manager.socketGameSend.updateTradeResponse !== "function") {
          return { ok: false, reason: "Colonist trade offer is no longer active" };
        }
        // Colonist has separate enums for the outgoing response command and
        // the stored playerResponses state: command Accept=0/Reject=1,
        // stored Pending=0/Accepted=1/Rejected=2. Sending the stored values
        // made an intended accept arrive as reject (and reject as an invalid
        // response), so the offer remained pending from our perspective.
        manager.socketGameSend.updateTradeResponse({
          id: tradeId,
          response: actionType === "ACCEPT_TRADE" ? 0 : 1,
        });
        return { ok: true, mode: "action", state: String(currentAction) };
      }
      if (actionType === "ROLL" && typeof manager.socketGameSend.clickedDice === "function") {
        manager.socketGameSend.clickedDice();
        return { ok: true, mode: "action", state: String(currentAction) };
      }
      if (actionType === "END_TURN" && typeof manager.socketGameSend.clickedPassTurn === "function") {
        manager.socketGameSend.clickedPassTurn();
        return { ok: true, mode: "action", state: String(currentAction) };
      }
      if (actionType === "BUY_DEV" && typeof manager.socketGameSend.buyDevCard === "function") {
        manager.socketGameSend.buyDevCard();
        return { ok: true, mode: "action", state: String(currentAction) };
      }
      if (actionType === "DISCARD" && typeof manager.socketGameSend.selectCards === "function") {
        const selected = [];
        const counts = target.discard || {};
        for (const [name, count] of Object.entries(counts)) {
          const card = resourceCard(name);
          for (let i = 0; Number.isFinite(card) && i < Number(count); i++) selected.push(card);
        }
        const hand = actualCards();
        const usable = selected.filter((card) => {
          const at = hand.indexOf(card);
          if (at < 0) return false;
          hand.splice(at, 1);
          return true;
        });
        const total = usable.length + Math.max(0, Number(target.discardUnknown) || 0);
        while (usable.length < total && hand.length) usable.push(hand.shift());
        if (usable.length !== total) return { ok: false, reason: "Colonist hand is not ready for discard" };
        manager.socketGameSend.selectCards(usable);
        return { ok: true, mode: "action", state: String(currentAction) };
      }
      if (["PLAY_KNIGHT", "PLAY_MONOPOLY", "PLAY_YEAR_OF_PLENTY", "PLAY_ROAD_BUILDING"].includes(actionType)) {
        const ready = actionType === "PLAY_MONOPOLY"
          ? Number(actionEnums.Select1ResourceForMonopoly) === currentActionNumber || currentActionNumber === 33
          : actionType === "PLAY_YEAR_OF_PLENTY"
            ? Number(actionEnums.Select2ResourcesForYearOfPlenty) === currentActionNumber || currentActionNumber === 32
            : false;
        if (ready && typeof manager.socketGameSend.selectCards === "function") {
          const count = actionType === "PLAY_YEAR_OF_PLENTY" ? 2 : 1;
          const cards = selectedResourceCards(count);
          if (cards.length !== count) return { ok: false, reason: "Development-card resource is missing" };
          manager.socketGameSend.selectCards(cards);
          return { ok: true, mode: "followup", state: String(currentAction) };
        }
        const cardEnum = cardEnums[cardName[actionType]];
        if (Number.isFinite(cardEnum) && typeof manager.socketGameSend.clickedDevelopmentCard === "function") {
          manager.socketGameSend.clickedDevelopmentCard(cardEnum);
          return { ok: true, mode: "action", state: String(currentAction) };
        }
        return { ok: false, reason: "Colonist development-card sender is unavailable" };
      }
      if (actionType === "MARITIME_TRADE") {
        const give = resource[target.give];
        const get = resource[target.get];
        const count = Number(target.giveCount);
        if (!Number.isFinite(give) || !Number.isFinite(get) || !Number.isFinite(count) || count < 1) {
          return { ok: false, reason: "Maritime trade recommendation is incomplete" };
        }
        if (typeof manager.socketGameSend.createTrade !== "function") {
          return { ok: false, reason: "Colonist sender missing createTrade" };
        }
        manager.socketGameSend.createTrade({
          creator: manager.gameController?.myColor,
          isBankTrade: true,
          counterOfferInResponseToTradeId: null,
          offeredResources: Array.from({ length: count }, () => give),
          wantedResources: Array.from({ length: Number(target.getCount) || 1 }, () => get),
        });
        return { ok: true, mode: "action", state: String(currentAction) };
      }
      if (!manager?.gameState?.mapState?.tileState) {
        return { ok: false, reason: "Colonist game manager is not in a live game" };
      }
      if (actionType === "STEAL") {
        let victim = null;
        if (Number.isFinite(target.stealFromColor)) {
          victim = (manager.gameState.players || []).find((player) => player.state?.color === target.stealFromColor);
        }
        if (!victim && target.stealFrom) {
          victim = (manager.gameState.players || []).find((player) => player.userState?.username === target.stealFrom);
        }
        const color = victim?.state?.color;
        if (!Number.isFinite(color) || typeof manager.socketGameSend.selectPlayer !== "function") {
          return { ok: false, reason: "Colonist victim is not selectable" };
        }
        manager.socketGameSend.selectPlayer(color);
        return { ok: true, mode: "action", state: String(currentAction), locationIndex: color };
      }
      const readyNames = target.prep === "settlement"
        ? ["InitialPlacementPlaceSettlement", "PlaceSettlement"]
        : target.prep === "road"
          ? ["InitialPlacementRoadPlacement", "PlaceRoad", "PlaceRoadForFree", "Place2MoreRoadBuilding", "Place1MoreRoadBuilding"]
          : target.prep === "city"
            ? ["PlaceCity", "PlaceCityWithDiscount"]
            : [];
      const ready = readyNames.some((name) => qy[name] === currentAction);
      const normalBuild = actionType === "BUILD_SETTLEMENT" || actionType === "BUILD_ROAD" || actionType === "BUILD_CITY";
      if (normalBuild && !ready) {
        const method = target.prep === "settlement" ? "buildSettlement" : target.prep === "road" ? "buildRoad" : "buildCity";
        if (typeof manager.socketGameSend[method] !== "function") return { ok: false, reason: "Colonist sender missing " + method };
        manager.socketGameSend[method]();
        return { ok: true, mode: "prepare", state: String(currentAction) };
      }
      if (target.prep !== "robber" && !ready) {
        return { ok: false, reason: "Colonist action state " + String(currentAction) + " is not ready for " + String(target.prep) };
      }

      const center = manager.mapController?.mapView?.mapCenter || { x: 0, y: 0 };
      const point = (corner) => {
        const p = corner.toPixel(center, 1);
        return { x: p.x - center.x, y: p.y - center.y };
      };
      const close = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.0001;
      const tileState = manager.gameState.mapState.tileState;
      let locationIndex = Number.isInteger(target.colonistIndex) ? target.colonistIndex : -1;
      if (locationIndex < 0 && target.vertex) {
        locationIndex = tileState._tileCorners.findIndex((corner) => close(point(corner.hexCorner), { x: target.x, y: target.y }));
      } else if (locationIndex < 0 && target.edge) {
        locationIndex = tileState._tileEdges.findIndex((edge) => {
          const ends = (edge.hexEdge || edge).endPoints();
          const a = point(ends[0]);
          const b = point(ends[1]);
          return close({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, { x: target.x, y: target.y });
        });
      } else if (locationIndex < 0 && target.hex) {
        const match = String(target.hex).match(/^h:(-?\\d+),(-?\\d+)$/);
        const q = match ? Number(match[1]) : undefined;
        const r = match ? Number(match[2]) : undefined;
        locationIndex = tileState.tiles.findIndex((tile) => tile.hexFace.x === q && tile.hexFace.y === r);
      }
      if (locationIndex < 0) return { ok: false, reason: "Colonist map has no matching board location" };

      // The bridge's engine/index projection can be one frame behind the
      // renderer when an opponent has just claimed an edge. Never send a road
      // confirmation based only on that cached index: ask the live Colonist
      // tile state whether the exact runtime edge is occupied first.
      if (target.prep === "road") {
        const rawEdge = tileState._tileEdges?.[locationIndex];
        const selectedPoint = rawEdge?.hexEdge || rawEdge;
        const samePoint = (value, point) => {
          const candidate = value?.hexEdge || value;
          return Number.isFinite(candidate?.x) && Number.isFinite(candidate?.y) && Number.isFinite(candidate?.z)
            && Number.isFinite(point?.x) && Number.isFinite(point?.y) && Number.isFinite(point?.z)
            && Math.abs(candidate.x - point.x) < 0.0001
            && Math.abs(candidate.y - point.y) < 0.0001
            && Math.abs(candidate.z - point.z) < 0.0001;
        };
        const edgeEntries = Object.values(tileState.tileEdgeStates || {});
        const liveEdge = edgeEntries.find((entry) => samePoint(entry, selectedPoint))
          || edgeEntries[locationIndex]
          || null;
        const owner = Number(liveEdge?.owner ?? liveEdge?.color ?? liveEdge?.playerColor);
        if (Number.isFinite(owner) && owner > 0) {
          return { ok: false, reason: "live road edge already occupied (owner " + owner + ")", locationIndex };
        }
      }

      let method;
      if (target.prep === "settlement") method = "confirmBuildSettlement";
      else if (target.prep === "city") method = "confirmBuildCity";
      else if (target.prep === "road") method = "confirmBuildRoad";
      else if (target.prep === "robber") method = "selectedTile";
      else return { ok: false, reason: "unsupported board action" };
      if (typeof manager.socketGameSend[method] !== "function") return { ok: false, reason: "Colonist sender missing " + method };
      manager.socketGameSend[method](locationIndex);
      return { ok: true, mode: "action", locationIndex, state: String(currentAction) };
    })()`)) as AppBoardResult | undefined;
    if (!result?.ok) {
      console.log("app-board-miss", result?.reason ?? "no result");
      return { ok: false, reason: result?.reason ?? "no result" };
    }
    console.log("app-board", result.mode, result.locationIndex ?? "", result.state ?? "");
    return result;
  };
  const actuateWithRetry = async (click: Click): Promise<AppBoardResult> => {
    const result = await appBoardActuate(click);
    const isTradeResponse = click.actionType === "ACCEPT_TRADE" || click.actionType === "REJECT_TRADE";
    if (result.ok || (!isTradeResponse && !/webpack|game manager|live game/i.test(result.reason ?? ""))) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return appBoardActuate(click);
  };
  const readAppSignature = async (tradeId?: string): Promise<AppSignature | null> => {
    try {
      const id = JSON.stringify(tradeId ?? "");
      return (await cdp.evalOn(`(() => {
        const chunks = window.webpackChunkkatan;
        if (!chunks) return null;
        let req = window.__catanbotWebpackRequire;
        if (typeof req !== "function") {
          chunks.push([[Date.now()], {}, (runtime) => { req = runtime; }]);
          if (typeof req === "function") window.__catanbotWebpackRequire = req;
        }
        const manager = typeof req === "function" ? ${COLONIST_MANAGER_LOOKUP} : null;
        if (!manager?.gameController) return null;
        const myColor = manager.gameController.myColor;
        const current = manager.gameController.currentState || {};
        const dice = manager.gameController.diceState || manager.gameState?.diceState || {};
        const player = (manager.gameState?.players || []).find((entry) => entry.state?.color === myColor);
        const devPlayers = manager.gameController?.stateController?.state
          ?.mechanicDevelopmentCardsState?.players || {};
        const devState = devPlayers[String(myColor)]?.developmentCards;
        const active = manager.gameStore?.getState?.()?.gameState?.tradeState?.activeOffers || {};
        const offer = active[${id}] || null;
        return {
          myColor,
          currentTurnPlayerColor: current.currentTurnPlayerColor,
          completedTurns: current.completedTurns,
          turnState: current.turnState,
          actionState: current.actionState,
          diceThrown: Boolean(dice.diceThrown),
          cards: [...(player?.state?.resourceCards?.cards || player?.resourceCards?.state?.cards || [])],
          devCards: [...(devState?.cards || [])],
          usedDevCards: [...(devState?.cardsUsed || devState?.usedCards || [])],
          tradeExists: Boolean(offer),
          tradeResponse: offer?.playerResponses?.[String(myColor)] ?? null,
        };
      })()`)) as AppSignature | null;
    } catch {
      return null;
    }
  };
  const appActionReady = (click: Click, state: AppSignature | null): boolean => {
    if (!state) return false;
    const mine = state.currentTurnPlayerColor === state.myColor;
    switch (click.actionType) {
      case "ROLL":
        return mine && state.turnState === 1 && !state.diceThrown;
      case "END_TURN":
        return mine && state.actionState === 0 && (state.turnState === 2 || (state.turnState === 1 && state.diceThrown));
      case "ACCEPT_TRADE":
      case "REJECT_TRADE":
        return state.tradeExists === true && (state.tradeResponse == null || state.tradeResponse === 0);
      case "DISCARD":
        return state.actionState === 28 || state.actionState === 29;
      case "STEAL":
        return state.actionState === 27;
      case "PLAY_YEAR_OF_PLENTY":
        // Colonist's resource-selection menu is already scoped to the local
        // player. Do not let a transient current-player projection block the
        // exact follow-up that the app is explicitly asking for.
        return mine || state.actionState === 32;
      case "PLAY_MONOPOLY":
        return mine || state.actionState === 33;
      default:
        return mine;
    }
  };
  const waitForAppActionAck = async (click: Click, before: AppSignature | null): Promise<boolean> => {
    if (!before) return false;
    const changed = (after: AppSignature | null): boolean => {
      if (!after) return false;
      if (click.actionType === "ACCEPT_TRADE" || click.actionType === "REJECT_TRADE") {
        return !after.tradeExists || after.tradeResponse !== before.tradeResponse;
      }
      if (click.actionType === "ROLL") {
        return after.diceThrown || after.actionState !== before.actionState || after.completedTurns !== before.completedTurns;
      }
      if (click.actionType === "END_TURN") {
        return after.currentTurnPlayerColor !== before.currentTurnPlayerColor || after.completedTurns !== before.completedTurns;
      }
      if (click.actionType === "STEAL") return after.actionState !== before.actionState;
      if (click.actionType === "DISCARD") {
        return (after.cards?.length ?? 0) < (before.cards?.length ?? 0) || after.actionState !== before.actionState;
      }
      if (click.actionType === "PLAY_YEAR_OF_PLENTY") {
        const requested = click.resources?.length ?? (click.resource ? 1 : 2);
        return (after.cards?.length ?? 0) >= (before.cards?.length ?? 0) + requested
          || after.actionState !== before.actionState
          || after.completedTurns !== before.completedTurns;
      }
      if (click.actionType === "BUY_DEV" || click.actionType === "MARITIME_TRADE") {
        return JSON.stringify(after.cards) !== JSON.stringify(before.cards)
          || JSON.stringify(after.devCards) !== JSON.stringify(before.devCards)
          || JSON.stringify(after.usedDevCards) !== JSON.stringify(before.usedDevCards)
          || after.actionState !== before.actionState;
      }
      return after.actionState !== before.actionState || after.completedTurns !== before.completedTurns;
    };
    const checks = click.actionType === "ACCEPT_TRADE" || click.actionType === "REJECT_TRADE" ? 8 : 12;
    for (let i = 0; i < checks; i++) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (changed(await readAppSignature(click.tradeId))) return true;
    }
    return false;
  };
  const fireAndForgetObserved = (
    actionType: string,
    before: AppSignature | null,
    after: AppSignature | null,
  ): boolean => {
    if (!before || !after) return false;
    if (actionType === "MARITIME_TRADE") {
      return JSON.stringify(after.cards) !== JSON.stringify(before.cards);
    }
    if (actionType === "BUY_DEV") {
      return JSON.stringify(after.cards) !== JSON.stringify(before.cards)
        || JSON.stringify(after.devCards) !== JSON.stringify(before.devCards)
        || JSON.stringify(after.usedDevCards) !== JSON.stringify(before.usedDevCards);
    }
    return false;
  };
  const syncAppState = async (full = false): Promise<boolean> => {
    try {
      const includeTopology = full ? "true" : "false";
      const includeLocations = full || locationSyncsRemaining > 0;
      const includeLocationsLiteral = includeLocations ? "true" : "false";
      const state = await cdp.evalOn(`(() => {
        const includeTopology = ${includeTopology};
        const includeLocations = ${includeLocationsLiteral};
        const chunks = window.webpackChunkkatan;
        if (!chunks) return null;
        let req = window.__catanbotWebpackRequire;
        if (typeof req !== "function") {
          chunks.push([[Date.now()], {}, (runtime) => { req = runtime; }]);
          if (typeof req === "function") window.__catanbotWebpackRequire = req;
        }
        if (typeof req !== "function") return null;
        const manager = ${COLONIST_MANAGER_LOOKUP};
        const tileState = manager?.gameState?.mapState?.tileState;
        if (!manager || !tileState) return null;
        const devPlayers = manager.gameController?.stateController?.state
          ?.mechanicDevelopmentCardsState?.players || {};
        const robberIndex = manager.gameStore?.getState?.()?.gameState?.mechanicRobberState?.locationTileIndex;
        const robberTile = Number.isInteger(robberIndex) ? tileState.tiles?.[robberIndex]?.hexFace : null;
        const endGamePlayers = manager.gameStore?.getState?.()?.gameEnd?.providerProps?.gameEndData
          ?.endGameState?.players || {};
        const winnerEntry = Object.values(endGamePlayers).find((entry) => entry?.winningPlayer);
        const winnerColor = Number.isFinite(winnerEntry?.color) ? winnerEntry.color : null;
        return {
          myColor: manager.gameController?.myColor,
          currentState: manager.gameController?.currentState,
          diceState: manager.gameController?.diceState,
          isGameOver: manager.gameState?.isGameOver,
          winnerColor,
          robber: robberTile ? { q: robberTile.x, r: robberTile.y } : null,
          players: (manager.gameState?.players || []).map((player) => ({
            color: player.state?.color,
            username: player.userState?.username,
            isBot: player.userState?.isBot,
            cards: player.state?.resourceCards?.cards || player.resourceCards?.state?.cards || [],
            devCards: devPlayers[String(player.state?.color)]?.developmentCards?.cards || [],
            devCardsUsed: devPlayers[String(player.state?.color)]?.developmentCardsUsed || [],
            victoryPointsState: player.state?.victoryPointsState || {},
          })),
          tradeOffers: Object.entries(
            manager.gameStore?.getState?.()?.gameState?.tradeState?.activeOffers || {},
          ).flatMap(([id, offer]) => offer ? [{
            id,
            creator: offer.creator,
            offeredResources: offer.offeredResources || [],
            wantedResources: offer.wantedResources || [],
            playerResponses: offer.playerResponses || {},
              }] : []),
          // Keep the runtime's location identity in the fast projection too.
          // It is tiny compared with tileHexStates and lets the bridge repair
          // an index map if the first state frame raced board construction.
          boardLocations: includeLocations ? {
            corners: (tileState._tileCorners || []).flatMap((corner, i) => {
              const point = corner?.hexCorner || corner;
              return Number.isFinite(point?.x) && Number.isFinite(point?.y) && Number.isFinite(point?.z)
                ? [{ i, x: point.x, y: point.y, z: point.z }]
                : [];
            }),
            edges: (tileState._tileEdges || []).flatMap((edge, i) => {
              const point = edge?.hexEdge || edge;
              const endpoints = typeof point?.endPoints === "function" ? point.endPoints() : [];
              const normalize = (corner) => {
                const value = corner?.hexCorner || corner;
                return Number.isFinite(value?.x) && Number.isFinite(value?.y) && Number.isFinite(value?.z)
                  ? { x: value.x, y: value.y, z: value.z }
                  : null;
              };
              const a = normalize(endpoints?.[0]);
              const b = normalize(endpoints?.[1]);
              return Number.isFinite(point?.x) && Number.isFinite(point?.y) && Number.isFinite(point?.z)
                ? [{ i, x: point.x, y: point.y, z: point.z, ...(a && b ? { a, b } : {}) }]
                : [];
            }),
          } : undefined,
          mapState: {
            ...(includeTopology ? { tileHexStates: tileState.tileHexStates } : {}),
            tileCornerStates: tileState.tileCornerStates,
            tileEdgeStates: tileState.tileEdgeStates,
            portEdgeStates: manager.gameState.mapState?.portState?.portEdgeStates || {},
          },
        };
      })()`);
      if (!state) return false;
      const response = await fetch(`${BRIDGE}/api/app-state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state),
      });
      if (response.ok && locationSyncsRemaining > 0) locationSyncsRemaining -= 1;
      return response.ok;
    } catch {
      /* Navigation and lobby teardown can race the diagnostic sync. */
      return false;
    }
  };
  const syncTradeState = async (): Promise<boolean> => {
    try {
      const state = await cdp.evalOn(`(() => {
        const chunks = window.webpackChunkkatan;
        if (!chunks) return null;
        let req = window.__catanbotWebpackRequire;
        if (typeof req !== "function") {
          chunks.push([[Date.now()], {}, (runtime) => { req = runtime; }]);
          if (typeof req === "function") window.__catanbotWebpackRequire = req;
        }
        const manager = typeof req === "function" ? ${COLONIST_MANAGER_LOOKUP} : null;
        if (!manager?.gameController) return null;
        const tradeState = manager.gameStore?.getState?.()?.gameState?.tradeState;
        return {
          myColor: manager.gameController.myColor,
          currentState: manager.gameController.currentState,
          tradeOffers: Object.entries(tradeState?.activeOffers || {}).flatMap(([id, offer]) => offer ? [{
            id,
            creator: offer.creator,
            offeredResources: offer.offeredResources || [],
            wantedResources: offer.wantedResources || [],
            playerResponses: offer.playerResponses || {},
          }] : []),
        };
      })()`);
      if (!state) return false;
      const response = await fetch(`${BRIDGE}/api/app-state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
  const pushHud = async (state: {
    colonistBoard: boolean;
    rec: unknown;
    game: { phase: string; current: string; winner: string | null };
    play: { pending: unknown; mode?: string; owner?: string };
    app?: { actionLabel?: string };
  }): Promise<void> => {
    const hudState = JSON.stringify({
      colonistBoard: state.colonistBoard,
      rec: state.rec,
      game: state.game,
      play: state.play,
      app: state.app,
      pending: state.play.pending,
    });
    await cdp.evalOn(`window.__catanbotSetHudState?.(${hudState})`).catch(() => {});
  };
  const waitForBridgeTradeAck = async (tradeId?: string, checks = 5): Promise<boolean> => {
    if (!tradeId) return false;
    for (let i = 0; i < checks; i++) {
      await syncTradeState();
      const state = await json<{ game?: { pendingOffer?: { id?: string } | null } }>(`${BRIDGE}/api/state`).catch(() => null);
      if (state?.game?.pendingOffer?.id !== tradeId) return true;
      if (i + 1 < checks) await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  };
  type TradeRetry = {
    click: Click;
    sentAt: number;
    nextCheckAt: number;
    attempts: number;
    nullReads: number;
  };
  const tradeRetries = new Map<string, TradeRetry>();
  const scheduleTradeRetry = (click: Click): void => {
    if (!click.tradeId || tradeRetries.has(click.tradeId)) return;
    // Keep this as data for the main loop. A detached async CDP read can race
    // the authoritative app-state sync and make a valid offer look gone.
    tradeRetries.set(click.tradeId, {
      click,
      sentAt: Date.now(),
      nextCheckAt: Date.now() + 120,
      attempts: 0,
      nullReads: 0,
    });
  };
  const processTradeRetry = async (): Promise<void> => {
    const pending = [...tradeRetries.values()].sort((a, b) => a.nextCheckAt - b.nextCheckAt)[0];
    if (!pending || Date.now() < pending.nextCheckAt) return;
    const id = pending.click.tradeId!;
    const after = await readAppSignature(id);
    let acknowledged = Boolean(after && (!after.tradeExists || (after.tradeResponse != null && after.tradeResponse !== 0)));
    // A response can remove an offer before the next renderer signature read,
    // while the bridge still has the previous projection. Refresh the tiny
    // authoritative trade slice once the propagation window has elapsed so a
    // successful accept/reject is not mistaken for a failed click.
    if (!acknowledged && Date.now() - pending.sentAt >= 180) {
      acknowledged = await waitForBridgeTradeAck(id, 1);
    }
    if (acknowledged) {
      tradeRetries.delete(id);
      console.log("trade-ack", pending.click.actionType, id, `${Date.now() - pending.sentAt}ms`);
      return;
    }

    pending.nullReads = after ? 0 : pending.nullReads + 1;
    // A renderer read can transiently return null while Chrome is busy. Give
    // the first packet a short propagation window, then resend once even if
    // the read stayed unavailable. The command is idempotent by offer id.
    const propagationWindow = 180;
    const shouldRetry = Date.now() - pending.sentAt >= propagationWindow || pending.nullReads >= 3;
    if (!shouldRetry) {
      pending.nextCheckAt = Date.now() + 70;
      return;
    }
    // The sender call is already immediate, but Colonist can take several
    // websocket/store frames to reflect the response. Keep the idempotent
    // offer-key retry alive long enough to cover that normal propagation
    // window instead of declaring a valid decline/accept lost after ~500ms.
    if (pending.attempts >= 5) {
      tradeRetries.delete(id);
      console.log("trade-unconfirmed", pending.click.actionType, id);
      return;
    }
    const retry = await actuateWithRetry(pending.click);
    pending.attempts += 1;
    pending.nextCheckAt = Date.now() + 100;
    pending.nullReads = 0;
    if (retry.ok) console.log("trade-retry", pending.click.actionType, id, `attempt ${pending.attempts}`);
  };
  const scheduleDevFollowupRetry = (click: Click, before: AppSignature | null): void => {
    if (!before || (click.actionType !== "PLAY_YEAR_OF_PLENTY" && click.actionType !== "PLAY_MONOPOLY")) return;
    void (async () => {
      // Resource selection is also a fire-and-forget sender event. A renderer
      // can acknowledge the call locally while the packet is lost during a
      // card-animation transition. Retry only while Colonist still exposes
      // the exact selection menu and no resource transfer was observed.
      await new Promise((resolve) => setTimeout(resolve, 120));
      const after = await readAppSignature();
      if (!after) return;
      const expected = click.actionType === "PLAY_YEAR_OF_PLENTY" ? 32 : 33;
      const requested = click.actionType === "PLAY_YEAR_OF_PLENTY" ? (click.resources?.length ?? 2) : 1;
      const transferred = (after.cards?.length ?? 0) >= (before.cards?.length ?? 0) + requested;
      if (transferred || Number(after.actionState) !== expected) return;
      const retry = await actuateWithRetry(click);
      if (retry.ok) console.log("dev-followup-retry", click.actionType, click.resources?.join(",") ?? click.resource ?? "");
    })().catch(() => {});
  };
  process.once("exit", () => native?.clicker.close());

  const loc = (await cdp.evalOn("location.href")) as string;
  if (!autoClickAllowed({ on: true, vsBots: true }, loc)) throw new Error("refusing ranked URL");

  const lobbyButtons = async () =>
    (await cdp.evalOn(`(() => {
      const hit = (re) => {
        for (const el of document.querySelectorAll("button, a, [role=button], p, h3, div, span")) {
          const t = (el.innerText||"").trim().replace(/\\s+/g," ");
          if (!re.test(t)) continue;
          const b = el.getBoundingClientRect();
          if (b.width>=8 && b.height>=8) return { x: b.x+b.width/2, y: b.y+b.height/2, t };
        }
        return null;
      };
      return {
        online: hit(/^Play Online$/),
        bots: hit(/^Bots$/),
        easy: hit(/^Easy$/),
        hard: hit(/^Hard$/),
        start: hit(/^Start Game$/),
      };
    })()`)) as Record<string, { x: number; y: number; t: string } | null>;

  const clickText = async (text: string): Promise<boolean> =>
    Boolean(await cdp.evalOn(`(() => {
      let best = null;
      for (const el of document.querySelectorAll("button, a, [role=button], p, h3, div, span")) {
        const t = (el.innerText || "").trim().replace(/\\s+/g, " ");
        if (t !== ${JSON.stringify(text)}) continue;
        const b = el.getBoundingClientRect();
        if (b.width < 8 || b.height < 8) continue;
        const area = b.width * b.height;
        if (!best || area < best.area) best = { el, area };
      }
      if (!best) return false;
      best.el.click();
      return true;
    })()`));

  const continueAsGuest = async (): Promise<boolean> => {
    const clicked = await clickText("Continue as Guest");
    if (clicked) {
      console.log("continued as guest");
      await new Promise((r) => setTimeout(r, 1200));
    }
    return clicked;
  };

  const dismissBeginnerPrompt = async (): Promise<boolean> => {
    const xy = (await cdp.evalOn(`(() => {
      const icon = [...document.querySelectorAll('img')].find((el) => /icon_check/i.test(el.src || ''));
      const button = icon?.closest('[class*="confirmButton"]') || document.querySelector('[class*="confirmButton"]');
      if (!button) return null;
      if ([...button.classList].some((name) => /faded/i.test(name))) return null;
      const b = button.getBoundingClientRect();
      return b.width >= 8 && b.height >= 8 ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
    })()`)) as { x: number; y: number } | null;
    if (!xy) return false;
    console.log("dismiss beginner prompt", Math.round(xy.x), Math.round(xy.y));
    await clickAt(xy.x, xy.y);
    await new Promise((r) => setTimeout(r, 350));
    return true;
  };

  await json(`${BRIDGE}/api/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ players: 4 }),
  }).catch(() => {});
  await json(`${BRIDGE}/api/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ on: true, vsBots: true, source: "driver" }),
  });
  locationSyncsRemaining = 12;
  await cdp.call("Page.navigate", { url: "https://colonist.io/" });
  await new Promise((r) => setTimeout(r, 2800));
  href = ((await cdp.evalOn("location.href")) as string) || href;
  await continueAsGuest();
  const entry = await lobbyButtons();
  if (entry.online) {
    await clickText("Play Online");
    await new Promise((r) => setTimeout(r, 2200));
  }
  const buttons = await lobbyButtons();
  console.log("lobby", JSON.stringify(buttons));
  if (buttons.bots) await clickText("Bots");
  await new Promise((r) => setTimeout(r, 500));
  const buttons2 = await lobbyButtons();
  if (buttons2.hard) await clickText("Hard");
  else if (buttons2.easy) await clickText("Easy");
  await new Promise((r) => setTimeout(r, 400));
  const buttons3 = await lobbyButtons();
  if (buttons3.start) await clickText("Start Game");
  href = ((await cdp.evalOn("location.href")) as string) || href;
  lastHrefReadAt = Date.now();
  console.log("started bot game", href);
  await dismissBeginnerPrompt();

  let streak = 0;
  // A response is idempotent at the game-protocol level. Keep it one-shot
  // per offer id: Colonist may leave a closed/rejected offer in activeOffers
  // briefly while the creator's view catches up, and retrying it only adds
  // latency and duplicate socket traffic.
  const tradeResponded = new Set<string>();
  const tradeReadyAt = new Map<string, number>();
  const sessionStart = Date.now();
  while (streak < 3 && Date.now() - sessionStart < 50 * 60 * 1000) {
  let last = "";
  let lastAt = 0;
  let boardPending: {
    actionId: string;
    click: Click;
    sentAt: number;
    attempts: number;
  } | null = null;
  let fireAndForgetPending: {
    actionId: string;
    actionType: string;
    before: AppSignature | null;
    sentAt: number;
    attempts: number;
  } | null = null;
  const t0 = Date.now();
  let occupied = false;
  let appStateReady = false;
  let lastAuxCheck = 0;
  let lastWinnerCheck = 0;
  let lastHudPush = 0;
  while (Date.now() - t0 < 15 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 120));
    // Offers can appear between full board projections. Pull only the small
    // trade slice first so the local decision/response path does not wait on
    // tile topology serialization or a slow Jev request.
    const tradeSliceSynced = await syncTradeState();
    if (tradeSliceSynced) {
      // Fast path: after the tiny authoritative trade projection arrives,
      // dispatch its accept/reject before serializing the full board state.
      // This removes the old full-sync/HUD decision path from the response
      // latency and is especially important for declining a stale offer.
      const fast = await json<{ click?: Click | null }>(`${BRIDGE}/api/driver-state`).catch(() => null);
      const fastClick = fast?.click;
      if (
        fastClick?.kind === "ui" &&
        (fastClick.actionType === "ACCEPT_TRADE" || fastClick.actionType === "REJECT_TRADE") &&
        fastClick.tradeId &&
        !tradeResponded.has(fastClick.tradeId)
      ) {
        if (!tradeReadyAt.has(fastClick.tradeId)) tradeReadyAt.set(fastClick.tradeId, Date.now());
        const result = await actuateWithRetry(fastClick);
        if (result.ok) {
          tradeResponded.add(fastClick.tradeId);
          const latency = Date.now() - (tradeReadyAt.get(fastClick.tradeId) ?? Date.now());
          tradeReadyAt.delete(fastClick.tradeId);
          console.log("trade-fast", fastClick.actionType, fastClick.tradeId, `${latency}ms`);
          scheduleTradeRetry(fastClick);
          continue;
        }
      }
    }
    await processTradeRetry();
    const synced = await syncAppState(!appStateReady);
    if (synced) appStateReady = true;
    const snap = await json<{
      rec: { action: { id: string; type: string; player: string; label: string } } | null;
      click: Click | null;
      game: {
        us: string;
        current: string;
        phase: string;
        winner: string | null;
        players: Array<{ id: string; name: string; settlements: string[]; cities: string[]; roads: string[] }>;
        board: { hexes: Record<string, { q: number; r: number }> };
        config: { victoryPoints: number };
      };
      colonistBoard: boolean;
      play: { on: boolean; vsBots: boolean; pending: unknown };
      }>(`${BRIDGE}/api/driver-state`);
    if (Date.now() - lastHudPush >= 1000) {
      lastHudPush = Date.now();
      void pushHud(snap);
    }
    const usState = snap.game.players.find((p) => p.id === snap.game.us);
    if (usState && (usState.settlements.length + usState.cities.length + usState.roads.length > 0)) {
      // This is deliberately derived from the observed projection, never from
      // the click response or the intended target.
      occupied = true;
    }
    if (Date.now() - lastHrefReadAt >= 2000 || !/#\w+/.test(href)) {
      try {
        href = ((await cdp.evalOn("location.href")) as string) || href;
        lastHrefReadAt = Date.now();
      } catch (error) {
        // A navigation can briefly detach the renderer. Do not tear down the
        // owned browser (and its HUD) for one lost Runtime.evaluate call.
        console.log("page-state retry", String(error));
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
    }
    if (!autoClickAllowed({ on: true, vsBots: true }, href) || !autoClickAllowed(snap.play ?? { on: false, vsBots: false }, href)) {
      console.log("skip click: auto vs bots gated");
      continue;
    }
    if (!/#\w+/.test(href)) {
      // Colonist fills the match hash asynchronously after Start Game. At
      // higher polling rates this branch can run before the first app-state
      // projection arrives; give that new game time to establish itself.
      // Do not trust snap.colonistBoard here: it is a cached bridge projection
      // and remains true after Colonist disconnects back to the lobby. Once
      // the startup grace period expires, a missing match URL means this game
      // is gone and the outer loop should launch a fresh one.
      if (Date.now() - t0 < 15000) continue;
      console.log("left match", href);
      break;
    }
    if (Date.now() - lastAuxCheck >= 1500) {
      lastAuxCheck = Date.now();
      try {
        if (await continueAsGuest()) continue;
        if (await dismissBeginnerPrompt()) continue;
        const reconnect = (await cdp.evalOn(`(() => {
          for (const el of document.querySelectorAll("a,button,div,span")) {
            if ((el.innerText||"").trim() !== "Reconnect") continue;
            const b = el.getBoundingClientRect();
            if (b.width > 8 && b.height > 8) return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          }
          return null;
        })()`)) as { x: number; y: number } | null;
        if (reconnect) {
          console.log("reconnect");
          await clickAt(reconnect.x, reconnect.y);
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
      } catch (error) {
        // Auxiliary DOM checks are advisory. A busy renderer must not stop
        // the authoritative app-state/action loop.
        console.log("aux-state retry", String(error));
        continue;
      }
    }
    if (snap.game.phase === "ended" && !snap.game.winner && Date.now() - lastWinnerCheck >= 250) {
      lastWinnerCheck = Date.now();
      const wonOnPage = (await cdp.evalOn(`(() => {
        const t = document.body ? document.body.innerText : "";
        const m = t.match(/([A-Za-z0-9_#.-]+)\\s+(?:won the game|has won)\\b/i);
        return m ? m[1] : null;
      })()`)) as string | null;
      if (wonOnPage) {
        await json(`${BRIDGE}/api/log`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: `${wonOnPage} won the game`, href }),
        }).catch(() => {});
        continue;
      }
    }
    if (snap.game.winner) {
      const w = snap.game.players.find((p) => p.id === snap.game.winner);
      const us = snap.game.winner === snap.game.us;
      console.log("WINNER", w?.name, us ? "US" : "THEM", "occupied", occupied);
      if (us && occupied) streak += 1;
      else streak = 0;
      console.log("streak", streak);
      break;
    }
    if (!snap.colonistBoard) {
      if (Date.now() % 4000 < 1000) console.log("wait board");
      continue;
    }
    const rec = snap.rec;
    const click = snap.click;
    if (!rec || !click || rec.action.id === "WAIT_BOARD") {
      if (Date.now() % 5000 < 1000) console.log("wait", snap.game.phase, snap.colonistBoard, rec?.action?.label);
      continue;
    }
    if (click.kind === "board" && snap.play.pending?.actionId === click.actionId) {
      if (Date.now() % 5000 < 1000) console.log("wait action ack", click.actionId);
      continue;
    }
    if (
      (click.actionType === "ACCEPT_TRADE" || click.actionType === "REJECT_TRADE") &&
      click.tradeId &&
      tradeResponded.has(click.tradeId)
    ) continue;
    if (boardPending && boardPending.actionId !== click.actionId) boardPending = null;
    if (click.kind === "board" && boardPending?.actionId === click.actionId) {
      const age = Date.now() - boardPending.sentAt;
      if (age < 1800) continue;
      if (boardPending.attempts < 2) {
        const retry = await actuateWithRetry(click);
        boardPending = {
          actionId: click.actionId,
          click,
          sentAt: Date.now(),
          attempts: boardPending.attempts + 1,
        };
        console.log("board-retry", click.actionType ?? click.prep ?? click.actionId, retry.ok ? "sent" : retry.reason ?? "failed");
        continue;
      }
      // The first sender can return normally while Colonist leaves the same
      // menu open. Release the bridge intent after bounded retries so the
      // next poll can re-read the authoritative action state and retry a
      // fresh target instead of waiting forever on one stale road click.
      console.log("board-action-timeout", click.actionType ?? click.prep ?? click.actionId);
      await json(`${BRIDGE}/api/played`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: `CLEAR:${click.actionId}` }),
      }).catch(() => {});
      boardPending = null;
      last = "";
      lastAt = 0;
      continue;
    }
    const fireAndForgetUi = click.actionType === "BUY_DEV" || click.actionType === "MARITIME_TRADE";
    if (fireAndForgetPending && fireAndForgetPending.actionId !== click.actionId) {
      fireAndForgetPending = null;
    }
    if (fireAndForgetPending?.actionId === click.actionId) {
      const after = await readAppSignature(click.tradeId);
      if (fireAndForgetObserved(fireAndForgetPending.actionType, fireAndForgetPending.before, after)) {
        console.log("app-action-ack", fireAndForgetPending.actionType);
        fireAndForgetPending = null;
        last = "";
        lastAt = 0;
      } else {
        // Keep one bounded retry for a packet lost during a Colonist card
        // animation. If the projection still never changes, pass once rather
        // than holding a stale optional action forever.
        const age = Date.now() - fireAndForgetPending.sentAt;
        if (fireAndForgetPending.attempts >= 1 && age >= 4000) {
          // A sender can return normally while the app projection never
          // changes (for example, a stale BUY_DEV menu after the deck or hand
          // changed). Holding that action forever is worse than forfeiting an
          // optional build: pass the turn once, then let the next
          // authoritative projection choose a fresh action.
          console.log("app-action-timeout", fireAndForgetPending.actionType);
          fireAndForgetPending = null;
          const fallback: Click = {
            kind: "ui",
            actionType: "END_TURN",
            ui: "end_turn",
            label: "End turn after app action timeout",
            actionId: `END_TURN_TIMEOUT:${click.actionId}`,
          };
          const passed = await actuateWithRetry(fallback);
          if (passed.ok) console.log("app-action-timeout-passed", click.actionType ?? click.ui);
          last = click.actionId;
          lastAt = Date.now();
          continue;
        }
        if (age < 4000) continue;
        fireAndForgetPending.attempts += 1;
        fireAndForgetPending.sentAt = Date.now();
        last = "";
        lastAt = 0;
        console.log("app-action-retry", click.actionType ?? click.ui);
      }
    }
    if (click.actionId === last && Date.now() - lastAt < 1500) continue;
    last = click.actionId;
    lastAt = Date.now();
    console.log("click", rec.action.type, rec.action.label);

    let acted = false;
    let recordIntent = false;
    let dispatchedAppActionState: number | undefined;
    const appUiAction = new Set([
      "ROLL", "END_TURN", "BUY_DEV", "ACCEPT_TRADE", "REJECT_TRADE", "DISCARD", "PLAY_KNIGHT", "PLAY_MONOPOLY",
      "PLAY_YEAR_OF_PLENTY", "PLAY_ROAD_BUILDING",
    ]);
    if (click.kind === "ui" && (click.ui === "steal" || click.ui === "trade" || appUiAction.has(click.actionType ?? ""))) {
      const isTradeResponse = click.actionType === "ACCEPT_TRADE" || click.actionType === "REJECT_TRADE";
      const before = isTradeResponse ? null : await readAppSignature(click.tradeId);
      if (!isTradeResponse && !appActionReady(click, before)) {
        if (Date.now() % 5000 < 1000) console.log("wait app state", click.actionType);
        continue;
      }
      const result = await actuateWithRetry(click);
      if (!result.ok) continue;
      const parsedState = Number(result.state);
      if (Number.isFinite(parsedState)) dispatchedAppActionState = parsedState;
      if (isTradeResponse) {
        // updateTradeResponse is a fire-and-forget socket action. Treat the
        // sender call as the acknowledgement and let the 200ms app-state
        // sync observe the store update. Waiting for that propagation here
        // added latency and, when the store lagged, resent the same response
        // several times before the offer disappeared.
        if (click.tradeId) tradeResponded.add(click.tradeId);
        if (click.tradeId) {
          const latency = Date.now() - (tradeReadyAt.get(click.tradeId) ?? Date.now());
          tradeReadyAt.delete(click.tradeId);
          console.log("trade-dispatched", click.actionType, click.tradeId, `${latency}ms`);
          scheduleTradeRetry(click);
        } else {
          console.log("trade-dispatched", click.actionType, "");
        }
      } else if (fireAndForgetUi) {
        // Colonist's bank/development senders are fire-and-forget. The local
        // runtime can remain in actionState 0 while the resource/deck
        // projection catches up, so blocking for a synthetic UI ack causes
        // the same BUY_DEV or maritime trade to be sent repeatedly. The next
        // app-state sync is authoritative; the longer action-id dedup window
        // protects that transition from duplicate packets. The pending
        // signature below also lets a second intentional buy proceed as soon
        // as Colonist actually reports the first card/resource change.
        console.log("app-dispatched", click.actionType ?? click.ui);
        fireAndForgetPending = {
          actionId: click.actionId,
          actionType: click.actionType ?? click.ui ?? "",
          before,
          sentAt: Date.now(),
          attempts: fireAndForgetPending?.actionId === click.actionId ? fireAndForgetPending.attempts : 0,
        };
      } else {
        // Resource-selection follow-ups are fire-and-forget sender events just
        // like trade responses. Colonist can keep actionState=32/33 while it
        // applies the selection, so waiting for a state transition here turns
        // a successful YOP/Monopoly into a visible retry loop. The following
        // authoritative app-state sync remains the source of truth.
        if (result.mode === "followup") {
          console.log("dev-followup-dispatched", click.actionType ?? click.ui, click.resources?.join(",") ?? click.resource ?? "");
          scheduleDevFollowupRetry(click, before);
        } else {
          const appAck = await waitForAppActionAck(click, before);
          if (!appAck) {
            console.log("app-action-no-ack", click.actionType ?? click.ui);
            continue;
          }
        }
      }
      acted = true;
    } else if (click.kind === "ui") {
      const kind = click.ui;
      const nodes = (await cdp.evalOn(
        `(() => [...document.querySelectorAll("button, a, [role=button], img, div, span")].map(el => {
          const b = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return {
            t: ((el.innerText||"")+" "+(el.alt||"")+" "+(el.id||"")).trim().replace(/\\s+/g," "),
            x: b.x+b.width/2, y: b.y+b.height/2, w: b.width, h: b.height,
            visible: b.width >= 8 && b.height >= 8 && s.display !== "none" && s.visibility !== "hidden" && s.pointerEvents !== "none" && Number(s.opacity || 1) > 0.01,
          };
        }).filter(el => el.visible))()`,
      )) as Array<{ t: string; x: number; y: number; w: number; h: number }> | null;
      const xy = pickUiHit(nodes ?? [], new RegExp(UI_PATTERNS[kind ?? ""] ?? "^$", "i"));
      if (!xy) {
        console.log("ui-miss", kind);
        continue;
      }
      console.log("ui-click", kind, Math.round(xy.x), Math.round(xy.y));
      await clickAt(xy.x, xy.y);
      acted = true;
      await new Promise((r) => setTimeout(r, 80));
    }
    if (click.kind === "board" && click.x != null && click.y != null) {
      const result = await actuateWithRetry(click);
      if (!result.ok) {
        if (click.prep === "road" && /occupied/i.test(result.reason ?? "")) {
          // Release the stale bridge intent immediately. The next loop sends
          // the fresh runtime occupancy projection and can choose another
          // legal edge instead of retrying the same opponent road forever.
          console.log("board-occupied", click.edge ?? click.actionId, result.reason);
          locationSyncsRemaining = Math.max(locationSyncsRemaining, 4);
          await json(`${BRIDGE}/api/played`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ actionId: `CLEAR:${click.actionId}` }),
          }).catch(() => {});
          boardPending = null;
          last = "";
          lastAt = 0;
        }
        continue;
      }
      const parsedState = Number(result.state);
      if (Number.isFinite(parsedState)) dispatchedAppActionState = parsedState;
      acted = true;
      if (result.mode === "action") {
        boardPending = { actionId: click.actionId, click, sentAt: Date.now(), attempts: 0 };
      }
      recordIntent = result.mode === "action";
    }
    if (!acted) continue;
    if (!recordIntent) continue;
    await json(`${BRIDGE}/api/played`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actionId: click.actionId,
        vertex: click.vertex,
        edge: click.edge,
        hex: click.hex,
        appActionState: dispatchedAppActionState,
      }),
    });
  }
  if (streak >= 3) break;
  await json(`${BRIDGE}/api/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ players: 4 }),
  }).catch(() => {});
  await json(`${BRIDGE}/api/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ on: true, vsBots: true, source: "driver" }),
  }).catch(() => {});
  locationSyncsRemaining = 12;
  await cdp.call("Page.navigate", { url: "https://colonist.io/" });
  appStateReady = false;
  lastHrefReadAt = 0;
  await new Promise((r) => setTimeout(r, 2500));
  await continueAsGuest();
  const entryAgain = await lobbyButtons();
  if (entryAgain.online) {
    await clickText("Play Online");
    await new Promise((r) => setTimeout(r, 2200));
  }
  const again = await lobbyButtons();
  if (again.bots) await clickText("Bots");
  await new Promise((r) => setTimeout(r, 400));
  const difficulty = await lobbyButtons();
  if (difficulty.hard) await clickText("Hard");
  else if (difficulty.easy) await clickText("Easy");
  await new Promise((r) => setTimeout(r, 300));
  const go = await lobbyButtons();
  if (go.start) await clickText("Start Game");
  href = ((await cdp.evalOn("location.href")) as string) || href;
  lastHrefReadAt = Date.now();
  console.log("next game", href, "streak", streak);
  }
  native?.clicker.close();
  ws.close();
  await stopOwnedChrome();
  if (streak < 3) {
    console.log("FAILED streak", streak);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
