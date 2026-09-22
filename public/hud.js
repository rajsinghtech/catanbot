const $ = (id) => document.getElementById(id);

const TERRAIN_FILL = {
  wood: "#2f6b3a",
  brick: "#b8432a",
  sheep: "#8fbf6a",
  wheat: "#d9a441",
  ore: "#5d6d7a",
  desert: "#c4b08a",
};

const PIECE_FILL = {
  red: "#d23c2a",
  blue: "#2a6ad2",
  orange: "#e07a16",
  white: "#f4efe6",
  green: "#2f8f4e",
  brown: "#7a4a28",
};

const HEX_SIZE = 1;
const SQRT3 = Math.sqrt(3);

function hexCenter(q, r) {
  return [SQRT3 * HEX_SIZE * (q + r / 2), 1.5 * HEX_SIZE * r];
}

function hexCorners(q, r) {
  const [cx, cy] = hexCenter(q, r);
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (30 - 60 * i);
    pts.push([cx + HEX_SIZE * Math.cos(a), cy + HEX_SIZE * Math.sin(a)]);
  }
  return pts;
}

function vertexXY(board, vid) {
  const v = board.vertices[vid];
  if (!v) return null;
  if (Number.isFinite(v.x) && Number.isFinite(v.y)) return [v.x, v.y];
  const points = v.hexes.map((id) => {
    const h = board.hexes[id];
    if (!h) return null;
    const index = h.vertices.indexOf(vid);
    return index < 0 ? null : hexCorners(h.q, h.r)[index];
  }).filter(Boolean);
  if (!points.length) return null;
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
}

function labelVertex(board, vid) {
  const v = board.vertices[vid];
  if (!v) return vid.slice(0, 18);
  return v.hexes
    .map((hid) => {
      const h = board.hexes[hid];
      return h.number ? `${h.number} ${h.terrain}` : h.terrain;
    })
    .join(" / ");
}

function labelEdge(board, eid) {
  const e = board.edges[eid];
  if (!e) return "that edge";
  const left = new Set(board.vertices[e.vertices[0]]?.hexes ?? []);
  const shared = (board.vertices[e.vertices[1]]?.hexes ?? []).filter((id) => left.has(id));
  const ids = shared.length ? shared : [...left];
  const names = [...new Set(ids.map((hid) => {
    const h = board.hexes[hid];
    return h?.number ? `${h.number} ${h.terrain}` : h?.terrain;
  }).filter(Boolean))];
  return names.join(" / ") || "the coast";
}

function recHeadline(snap, rec) {
  if (!rec) return "Waiting for a legal move.";
  const g = snap.game;
  const p = g.players.find((x) => x.id === rec.action.player);
  const name = p?.name ?? rec.action.player;
  const nS = p ? p.settlements.length + (p.unplaced?.settlements ?? 0) : 0;
  const mine = rec.action.player === g.us;
  const youPrompt = snap.youPrompt;
  const ourClick = mine || (youPrompt && rec.action.player === g.us);
  if (!ourClick && rec.action.type.startsWith("PLACE_") && !youPrompt) {
    return `Wait — ${name} is placing. Your next rec is not this click.`;
  }
  if (rec.action.type === "DISCARD") {
    const d = rec.action.discard || {};
    const bits = ["wood", "brick", "sheep", "wheat", "ore"].filter((r) => d[r]).map((r) => `${d[r]} ${r}`);
    if (bits.length) return `DISCARD ${bits.join(", ")} — keep wheat and ore`;
    return rec.action.label || "DISCARD extras. Keep wheat and ore; dump sheep, wood, brick.";
  }
  if (rec.action.type === "ACCEPT_TRADE") {
    return rec.action.label;
  }
  if (rec.action.type === "REJECT_TRADE") {
    return rec.action.label;
  }
  if (rec.action.type === "MARITIME_TRADE") {
    return rec.action.label;
  }
  if (rec.action.type === "PLACE_SETTLEMENT" || rec.action.type === "BUILD_SETTLEMENT") {
    const usP = g.players.find((x) => x.id === g.us);
    const ourHouses = usP ? usP.settlements.length + (usP.unplaced?.settlements ?? 0) : nS;
    const spot = rec.action.vertex ? labelVertex(g.board, rec.action.vertex) : rec.target;
    if ((mine || youPrompt === "settlement") && ourHouses === 1) return `YOUR SECOND HOUSE on ${spot}`;
    if ((mine || youPrompt === "settlement") && ourHouses === 0) return `YOUR FIRST HOUSE on ${spot}`;
    if (nS <= 1) return `${name}: PLACE HOUSE on ${spot}`;
    return `${name}: PLACE HOUSE on ${spot}, then a road off that house`;
  }
  if (rec.action.type === "PLACE_ROAD" || rec.action.type === "BUILD_ROAD") {
    const house = rec.action.vertex ? labelVertex(g.board, rec.action.vertex) : null;
    const along = rec.action.edge ? labelEdge(g.board, rec.action.edge) : rec.action.label;
    if (rec.action.type === "PLACE_ROAD") {
      if (house) return `${name}: PLACE HOUSE on ${house}. Then road along ${along}`;
      return `${name}: waiting for the exact house corner before recommending a road`;
    }
    return rec.action.label;
  }
  return rec.action.label;
}

function drawBoard(snap) {
  const svg = $("board");
  const g = snap.game;
  const board = g.board;
  if (!snap.colonistBoard) {
    svg.innerHTML = "";
    $("boardCap").textContent = snap.live
      ? "Waiting for the live Colonist board; no dummy map is shown."
      : "Attach a live Colonist tab to draw its board.";
    return;
  }
  const rec = snap.rec?.action;
  const hexes = Object.values(board.hexes);
  if (!hexes.length) {
    svg.innerHTML = "";
    return;
  }

  const recHouse =
    rec && (rec.type === "PLACE_ROAD" || rec.type === "BUILD_ROAD") ? rec.vertex : rec?.vertex;
  const recEdge = rec && (rec.type === "PLACE_ROAD" || rec.type === "BUILD_ROAD") ? rec.edge : null;
  const recSettle =
    rec && (rec.type === "PLACE_SETTLEMENT" || rec.type === "BUILD_SETTLEMENT") ? rec.vertex : null;
  const houseVid = recSettle || recHouse;

  const corners = [];
  for (const h of hexes) for (const p of hexCorners(h.q, h.r)) corners.push(p);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const pad = 1.4;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const maxX = Math.max(...xs) + pad;
  const maxY = Math.max(...ys) + pad;
  svg.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);

  const parts = [`<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="#1a4a6a"/>`];

  for (const h of hexes) {
    const pts = hexCorners(h.q, h.r).map((p) => p.join(",")).join(" ");
    const [x, y] = hexCenter(h.q, h.r);
    const blocked = h.id === g.robberHex;
    const glow = (recSettle && h.vertices.includes(recSettle)) || (recHouse && h.vertices.includes(recHouse));
    parts.push(
      `<polygon points="${pts}" fill="${TERRAIN_FILL[h.terrain] || "#888"}" stroke="${glow ? "#f3e2c4" : "#0b1f18"}" stroke-width="${glow ? 0.08 : 0.04}" opacity="${blocked ? 0.55 : 1}"/>`,
    );
    parts.push(
      `<text x="${x}" y="${y - 0.22}" text-anchor="middle" font-size="0.16" fill="#f7f1e4" font-weight="700">${h.terrain.toUpperCase()}</text>`,
    );
    if (h.number) {
      const hot = h.number === 6 || h.number === 8;
      parts.push(`<circle cx="${x}" cy="${y + 0.14}" r="0.26" fill="#f3e2c4" stroke="#17110b" stroke-width="0.025"/>`);
      parts.push(
        `<text x="${x}" y="${y + 0.22}" text-anchor="middle" font-size="0.3" font-weight="700" fill="${hot ? "#b8432a" : "#17110b"}">${h.number}</text>`,
      );
    }
    if (blocked) parts.push(`<circle cx="${x}" cy="${y + 0.48}" r="0.1" fill="#111"/>`);
  }

  for (const p of g.players) {
    for (const eid of p.roads) {
      const e = board.edges[eid];
      if (!e) continue;
      const a = vertexXY(board, e.vertices[0]);
      const b = vertexXY(board, e.vertices[1]);
      if (!a || !b) continue;
      parts.push(
        `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${PIECE_FILL[p.id] || "#ddd"}" stroke-width="0.1" stroke-linecap="round"/>`,
      );
    }
    for (const vid of p.settlements.concat(p.cities)) {
      if (!board.vertices[vid]) continue;
      const point = vertexXY(board, vid);
      if (!point) continue;
      const [x, y] = point;
      const city = p.cities.includes(vid);
      parts.push(
        `<circle cx="${x}" cy="${y}" r="${city ? 0.16 : 0.12}" fill="${PIECE_FILL[p.id] || "#ddd"}" stroke="#17110b" stroke-width="0.03"/>`,
      );
    }
  }

  const stubVid = recHouse || recSettle;
  if (stubVid) {
    for (const e of Object.values(board.edges)) {
      if (!e.vertices.includes(stubVid)) continue;
      const a = vertexXY(board, e.vertices[0]);
      const b = vertexXY(board, e.vertices[1]);
      if (!a || !b) continue;
      const chosen = e.id === recEdge;
      parts.push(
        `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${chosen ? "#f3e2c4" : "#e8c36a"}" stroke-width="${chosen ? 0.16 : 0.08}" stroke-linecap="round"/>`,
      );
      if (chosen) {
        parts.push(
          `<text x="${(a[0] + b[0]) / 2}" y="${(a[1] + b[1]) / 2 - 0.14}" text-anchor="middle" font-size="0.2" fill="#f3e2c4" font-weight="700">ROAD</text>`,
        );
      }
    }
  }

  if (houseVid && board.vertices[houseVid]) {
    const point = vertexXY(board, houseVid);
    if (point) {
      const [x, y] = point;
      parts.push(
        `<circle cx="${x}" cy="${y}" r="0.2" fill="#f3e2c4" stroke="#17110b" stroke-width="0.04"/>`,
        `<text x="${x}" y="${y - 0.32}" text-anchor="middle" font-size="0.22" fill="#f3e2c4" font-weight="700">HOUSE</text>`,
      );
    }
  }

  const cx = hexes.reduce((s, h) => s + hexCenter(h.q, h.r)[0], 0) / hexes.length;
  const cy = hexes.reduce((s, h) => s + hexCenter(h.q, h.r)[1], 0) / hexes.length;
  const drawnPortEdges = new Set();
  for (const e of Object.values(board.edges)) {
    const va = board.vertices[e.vertices[0]];
    const vb = board.vertices[e.vertices[1]];
    if (!va?.port || !vb?.port) continue;
    if (va.port.ratio !== vb.port.ratio || va.port.resource !== vb.port.resource) continue;
    if (drawnPortEdges.has(e.id)) continue;
    drawnPortEdges.add(e.id);
    const a = vertexXY(board, va.id);
    const b = vertexXY(board, vb.id);
    if (!a || !b) continue;
    const x = (a[0] + b[0]) / 2;
    const y = (a[1] + b[1]) / 2;
    let ox = x - cx;
    let oy = y - cy;
    const olen = Math.hypot(ox, oy) || 1;
    ox /= olen;
    oy /= olen;
    const px = x + ox * 0.7;
    const py = y + oy * 0.7;
    const fill = va.port.resource ? TERRAIN_FILL[va.port.resource] : "#f3e2c4";
    const label = va.port.ratio === 3 ? "3:1" : `2:1 ${va.port.resource}`;
    parts.push(
      `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#d4b483" stroke-width="0.07"/>`,
      `<line x1="${x}" y1="${y}" x2="${px}" y2="${py}" stroke="#d4b483" stroke-width="0.09"/>`,
      `<ellipse cx="${px}" cy="${py}" rx="0.34" ry="0.2" fill="#efe6d4" stroke="#17110b" stroke-width="0.025"/>`,
      `<polygon points="${px},${py - 0.26} ${px - 0.16},${py + 0.08} ${px + 0.16},${py + 0.08}" fill="${fill}" stroke="#17110b" stroke-width="0.02"/>`,
      `<text x="${px}" y="${py + 0.46}" text-anchor="middle" font-size="0.18" font-weight="700" fill="#f3e2c4">${label}</text>`,
    );
  }

  svg.innerHTML = parts.join("");
  $("boardCap").textContent = houseVid
    ? "Gold HOUSE is the corner. Sit there, then a road on one of its 3 sides."
    : "Pointy-top hexes, same as Colonist. Ports sit on the coast.";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function modeLabel(play) {
  if (play.mode === "auto-bots") return "auto-play · bots";
  if (play.mode === "paused-bots") return "auto off · bot match";
  if (play.mode === "armed-match") return "armed · attached match";
  return "recommendation-only";
}

function renderSupportedMenus(actions) {
  $("menuList").innerHTML = (actions || [])
    .map((entry) => `<div class="menu-row"><b>${escapeHtml(entry.menu)} · ${escapeHtml(entry.type)}</b><span>${escapeHtml(entry.actuation)}</span></div>`)
    .join("");
}

function render(snap) {
  const rec = snap.rec;
  const g = snap.game;
  const cur = g.players.find((p) => p.id === g.current);
  const play = snap.play || { on: false, vsBots: false, mode: "recommendation", owner: "startup", manualOverride: null };
  const app = snap.app || {};
  $("meta").textContent = snap.colonistBoard
    ? `LIVE · ${snap.hexCount} hexes · ${g.phase} · turn ${g.turn} · ${g.config.playerCount}p to ${g.config.victoryPoints} VP`
    : snap.live ? `ATTACHING · waiting for Colonist board` : `OFFLINE · no live Colonist board`;
  $("connection").textContent = snap.colonistBoard ? "live board" : snap.live ? "attached" : "offline";
  $("statusDot").classList.toggle("live", Boolean(snap.live));
  $("demo").disabled = Boolean(snap.live);
  $("step").disabled = Boolean(snap.live);
  $("latency").textContent = rec ? `${rec.latencyMs} ms · ${rec.source}` : "idle";
  $("modeChip").textContent = modeLabel(play);
  $("controlOwner").textContent = play.manualOverride == null ? play.owner : "user override";
  $("matchKind").textContent = snap.colonistBoard
    ? play.vsBots ? "bot match" : "attached match"
    : snap.live ? "syncing board" : "not attached";
  $("liveMenu").textContent = app.actionLabel || "not observed";
  $("legalSummary").textContent = snap.legal?.length
    ? snap.legal.map((action) => action.type).join(" · ")
    : "none";
  $("configSummary").textContent = `${modeLabel(play)} · ${play.vsBots ? "bot automation selected" : "recommendations work in any attached match"}. ${app.connected ? `Colonist menu: ${app.actionLabel}.` : "Waiting for the Colonist app state."}`;
  const help = play.mode === "auto-bots"
    ? "Auto-play is ON for the bot match. Turn it off at any time; the user override is sticky."
    : play.mode === "paused-bots"
      ? "Auto-play is OFF. The bot-match setting is retained, but no action will be clicked."
      : play.mode === "armed-match"
        ? "Automation is armed, but it will not click an attached non-bot match. Use recommendation-only for live play."
        : "Recommendations stay visible, but no action is sent.";
  $("modeHelp").textContent = help;
  for (const [id, active] of [
    ["modeRecommend", play.mode === "recommendation"],
    ["modeBots", play.mode === "auto-bots"],
    ["modeOff", play.mode === "paused-bots"],
  ]) $(id).classList.toggle("active", active);
  $("whoTurn").textContent = cur
    ? `On the clock: ${cur.name} · ${cur.settlements.length + (cur.unplaced?.settlements ?? 0)} houses · ${cur.cities.length + (cur.unplaced?.cities ?? 0)} cities · ${cur.roads.length + (cur.unplaced?.roads ?? 0)} roads`
    : "";
  $("action").textContent = recHeadline(snap, rec);
  $("target").textContent = rec?.action?.vertex
    ? labelVertex(g.board, rec.action.vertex)
    : rec?.action?.edge
      ? "along " + labelEdge(g.board, rec.action.edge)
      : rec?.target || "";
  $("reason").textContent = rec ? rec.reason : "";
  $("plan").textContent = rec ? rec.plan : "";
  $("threat").textContent = rec ? rec.opponentThreat : "";
  $("source").textContent = rec ? rec.source : "—";
  $("confidence").textContent = rec ? `confidence ${rec.confidence}` : "";
  $("facts").textContent = `robber ${g.robberHex} · LR ${g.longestRoad || "—"} · LA ${g.largestArmy || "—"}`;
  renderSupportedMenus(snap.supportedActions);

  $("rail").innerHTML = snap.scores
    .map((s) => {
      const p = g.players.find((x) => x.id === s.id);
      const prod = Object.entries(s.prod)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k} ${v}`)
        .join(" · ");
      const you = s.id === g.us ? "you" : "";
      const turn = s.id === g.current ? " · to move" : "";
      return `<article class="seat"><div class="who">${s.name} ${you}${turn}</div><b>${s.visible}<span style="opacity:.55">/${s.total}</span></b><div class="pips">${p ? `${p.settlements.length + (p.unplaced?.settlements ?? 0)}S ${p.cities.length + (p.unplaced?.cities ?? 0)}C ${p.roads.length + (p.unplaced?.roads ?? 0)}R` : ""} · ${prod}</div></article>`;
    })
    .join("");

  const hexes = Object.values(g.board.hexes).slice().sort((a, b) => (b.number || 0) - (a.number || 0));
  const ports = [];
  const seen = new Set();
  for (const e of Object.values(g.board.edges)) {
    const va = g.board.vertices[e.vertices[0]];
    const vb = g.board.vertices[e.vertices[1]];
    if (!va?.port || !vb?.port) continue;
    if (va.port.ratio !== vb.port.ratio || va.port.resource !== vb.port.resource) continue;
    const k = `${e.id}:${va.port.ratio}:${va.port.resource ?? "any"}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ports.push(va.port.ratio === 3 ? "3:1" : `2:1 ${va.port.resource}`);
  }
  $("hexlist").innerHTML =
    hexes.map((h) => `<div>${h.number ?? "—"} ${h.terrain}${h.id === g.robberHex ? "  robber" : ""}</div>`).join("") +
    (ports.length ? `<div style="grid-column:1/-1;margin-top:6px">Ports: ${ports.join(" · ")}</div>` : "");
  $("log").innerHTML = (g.log || [])
    .slice(-12)
    .reverse()
    .map((line) => `<li>${line}</li>`)
    .join("");

  drawBoard(snap);
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(path);
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("json") ? res.json() : res.text();
}

$("demo").onclick = async () => {
  await post("/api/demo", { on: true });
};
$("step").onclick = async () => {
  render(await post("/api/step", {}));
};
$("reset").onclick = async () => {
  const n = Number($("seats").value);
  render(await post("/api/reset", { players: n }));
};
async function setMode(mode) {
  try {
    const body = mode === "bots"
      ? { on: true, vsBots: true, source: "user" }
      : mode === "recommendation"
        ? { on: false, vsBots: false, source: "user" }
        : { on: false, vsBots: true, source: "user" };
    render(await post("/api/play", body));
  } catch (error) {
    $("modeHelp").textContent = `Could not change automation: ${error}`;
  }
}
$("modeRecommend").onclick = () => setMode("recommendation");
$("modeBots").onclick = () => setMode("bots");
$("modeOff").onclick = () => setMode("off");
$("refresh").onclick = async () => {
  try {
    render(await post("/api/decide", {}));
  } catch (error) {
    $("connection").textContent = `refresh failed: ${error}`;
  }
};
function bindStream() {
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    try {
      render(JSON.parse(ev.data));
    } catch (err) {
      console.error(err);
      $("action").textContent = String(err);
    }
  };
  es.onerror = () => {
    es.close();
    setTimeout(bindStream, 1000);
  };
}
bindStream();
fetch("/api/state")
  .then((r) => r.json())
  .then(render)
  .catch((err) => {
    $("action").textContent = "HUD cannot reach the bot at :8765";
    console.error(err);
  });
