(() => {
  if (window.__catanbotAttachInstalled) return;
  window.__catanbotAttachInstalled = true;
  const BRIDGE = "http://127.0.0.1:8765";

  const post = (path, body) =>
    globalThis.chrome?.runtime?.sendMessage
      ? chrome.runtime.sendMessage({ source: "catanbot-bridge", path, body }).catch(() => {})
      : fetch(`${BRIDGE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).catch(() => {});

  const getState = () => new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      fetch(`${BRIDGE}/api/state`).then((r) => r.json()).then(resolve).catch(reject);
      return;
    }
    chrome.runtime.sendMessage({ source: "catanbot-bridge", path: "/api/state", method: "GET", body: {} }, (reply) => {
      if (chrome.runtime.lastError || !reply?.ok) {
        reject(new Error(chrome.runtime.lastError?.message || reply?.error || "bridge request failed"));
        return;
      }
      resolve(reply.data);
    });
  });

  const TERRAIN = {
    lumber: "wood",
    wood: "wood",
    brick: "brick",
    clay: "brick",
    wool: "sheep",
    sheep: "sheep",
    wheat: "wheat",
    grain: "wheat",
    ore: "ore",
    desert: "desert",
  };

  function scrapeTiles() {
    const byPos = new Map();
    for (const img of document.querySelectorAll("img")) {
      const alt = (img.alt || "").toLowerCase();
      const box = img.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) continue;
      const key = `${Math.round(box.left / 8)},${Math.round(box.top / 8)}`;
      const cur = byPos.get(key) || { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const tile = alt.match(
        /(lumber|wood|brick|clay|wool|sheep|wheat|grain|ore|desert)\s*tile|tile.*?(lumber|wood|brick|wool|sheep|wheat|ore|desert)/,
      );
      const prob = alt.match(/prob[_\s-]?(\d+)/);
      if (tile) cur.terrain = TERRAIN[tile[1] || tile[2]] || tile[1] || tile[2];
      if (prob) cur.number = Number(prob[1]);
      if (cur.terrain || cur.number) byPos.set(key, cur);
    }
    return [...byPos.values()].filter((t) => t.terrain);
  }

  function cubeRound(q, r) {
    let x = q;
    let z = r;
    let y = -x - z;
    let rx = Math.round(x);
    let ry = Math.round(y);
    let rz = Math.round(z);
    const xd = Math.abs(rx - x);
    const yd = Math.abs(ry - y);
    const zd = Math.abs(rz - z);
    if (xd > yd && xd > zd) rx = -ry - rz;
    else if (yd > zd) ry = -rx - rz;
    else rz = -rx - ry;
    return { q: rx, r: rz };
  }

  function axialGuess(tiles) {
    if (!tiles.length) return tiles;
    const dists = [];
    for (let i = 0; i < tiles.length; i++) {
      let best = Infinity;
      for (let j = 0; j < tiles.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(tiles[i].x - tiles[j].x, tiles[i].y - tiles[j].y);
        if (d < best && d > 8) best = d;
      }
      if (best < Infinity) dists.push(best);
    }
    dists.sort((a, b) => a - b);
    const neighbor = dists[Math.floor(dists.length / 2)] || 80;
    const size = neighbor / Math.sqrt(3);
    const cx = tiles.reduce((s, t) => s + t.x, 0) / tiles.length;
    const cy = tiles.reduce((s, t) => s + t.y, 0) / tiles.length;
    return tiles.map((t) => {
      const x = t.x - cx;
      const y = t.y - cy;
      const q = ((2 / 3) * x) / size;
      const r = ((-1 / 3) * x + (Math.sqrt(3) / 3) * y) / size;
      const axial = cubeRound(q, r);
      return { q: axial.q, r: axial.r, terrain: t.terrain, number: t.number ?? null };
    });
  }

  function harborGuess(rawHarbors, tiles) {
    if (!rawHarbors.length || !tiles.length) return [];
    const dists = [];
    for (let i = 0; i < tiles.length; i++) {
      let best = Infinity;
      for (let j = 0; j < tiles.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(tiles[i].x - tiles[j].x, tiles[i].y - tiles[j].y);
        if (d < best && d > 8) best = d;
      }
      if (best < Infinity) dists.push(best);
    }
    dists.sort((a, b) => a - b);
    const neighbor = dists[Math.floor(dists.length / 2)] || 80;
    const size = neighbor / Math.sqrt(3);
    const cx = tiles.reduce((s, t) => s + t.x, 0) / tiles.length;
    const cy = tiles.reduce((s, t) => s + t.y, 0) / tiles.length;
    return rawHarbors.map((h) => {
      const x = h.x - cx;
      const y = h.y - cy;
      const axial = cubeRound((2 / 3) * x / size, (-1 / 3) * x / size + (Math.sqrt(3) / 3) * y / size);
      return { q: axial.q, r: axial.r, ratio: h.ratio, resource: h.resource };
    });
  }

  function scrapeHarbors() {
    const out = [];
    for (const img of document.querySelectorAll("img")) {
      const text = `${img.alt || ""} ${img.className || ""}`.toLowerCase();
      if (!/(port|harbor|harbour)/i.test(text)) continue;
      const box = img.getBoundingClientRect();
      if (box.width < 5 || box.height < 5) continue;
      const ratioMatch = text.match(/([23])\s*(?::|to)\s*1/);
      const resource = Object.keys(TERRAIN).find((name) => new RegExp(`\\b${name}\\b`, "i").test(text));
      out.push({
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
        ratio: ratioMatch ? Number(ratioMatch[1]) : undefined,
        resource: resource ? TERRAIN[resource] : undefined,
      });
    }
    return out;
  }

  async function sendBoard() {
    try {
      const d = await fetch(`${BRIDGE}/api/health`).then((r) => r.json());
      if (d.colonistBoard && d.hexCount >= 19) return;
    } catch {
      /* HUD offline; still try a DOM board so recs can start */
    }
    const rawTiles = scrapeTiles();
    const tiles = axialGuess(rawTiles);
    if (tiles.length >= 10) {
      const harbors = harborGuess(scrapeHarbors(), rawTiles);
      await post("/api/board", { tiles, harbors });
    }
  }

  function overlay() {
    if (window.__catanbotOverlayStarted) return;
    window.__catanbotOverlayStarted = true;
    if (typeof window.__catanbotHudVisible !== "boolean") {
      window.__catanbotHudVisible = false;
    }
    const isVisible = () => window.__catanbotHudVisible === true;
    const applyVisibility = (el) => {
      if (!el) return;
      el.style.display = isVisible() ? "block" : "none";
      el.setAttribute("aria-hidden", String(!isVisible()));
    };
    const ensure = () => {
      let el = document.getElementById("catanbot-overlay");
      if (el) {
        applyVisibility(el);
        return el;
      }
      el = document.createElement("div");
      el.id = "catanbot-overlay";
      el.style.cssText =
        "display:none;position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:360px;padding:14px 16px;background:#f3e2c4;color:#17110b;font:16px/1.3 Georgia,serif;box-shadow:0 12px 32px rgba(0,0,0,.35);pointer-events:none";
      (document.body || document.documentElement).appendChild(el);
      applyVisibility(el);
      return el;
    };
    const setVisible = (next) => {
      window.__catanbotHudVisible = Boolean(next);
      applyVisibility(document.getElementById("catanbot-overlay"));
    };
    const toggle = () => setVisible(!isVisible());
    window.__catanbotSetHudVisible = setVisible;
    window.__catanbotToggleHud = toggle;
    if (!window.__catanbotHudKeyHandler) {
      window.__catanbotHudKeyHandler = (event) => {
        if (event.altKey && event.shiftKey && event.code === "KeyC") {
          event.preventDefault();
          event.stopPropagation();
          toggle();
        }
      };
      window.addEventListener("keydown", window.__catanbotHudKeyHandler, true);
    }
    const tick = async () => {
      const el = ensure();
      try {
        const d = await getState();
        const rec = d.rec;
        const warn = d.colonistBoard ? "" : "NOT YOUR BOARD — attach failed or still waiting for hexes.\n";
        const mode = d.play ? `auto: ${d.play.mode} (${d.play.owner})\n` : "";
        const menu = d.app?.actionLabel ? `menu: ${d.app.actionLabel}\n` : "";
        el.textContent = warn + mode + menu + (rec ? rec.action.label + "\n" + (rec.reason || "") : "no rec");
      } catch {
        el.textContent = "Catanbot HUD offline at 127.0.0.1:8765";
      }
    };
    tick();
    setInterval(tick, 1200);
  }

  function scrapeSeats() {
    const youEl = document.querySelector(
      '[class*="currentUser"] [class*="username"], [data-testid*="current-user"], [aria-current="true"], .usernameLarge-FoNEago3, .web-header-username',
    );
    const you = youEl?.textContent?.trim();
    const names = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[class*="username"], [class*="playerName"], [data-player-name], .usernameLarge-FoNEago3')) {
      const t = el.textContent?.trim();
      if (!t || t.length > 28 || /^\d+$/.test(t)) continue;
      if (/player|remove ads|chat|place /i.test(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      names.push(t);
    }
    if (you && !seen.has(you)) names.push(you);
    if (names.length >= 2 || you) {
      post("/api/seats", {
        you,
        players: names,
        href: location.href,
      });
    }
  }

  sendBoard();
  scrapeSeats();
  overlay();
  setInterval(sendBoard, 4000);
  setInterval(scrapeSeats, 3000);
})();
