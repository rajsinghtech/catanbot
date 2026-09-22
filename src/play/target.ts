import type { Action, Board, GameState, Recommendation } from "../types.ts";

const SQRT3 = Math.sqrt(3);

/**
 * Colonist's WebGL board is not fitted to the canvas bounds: the log/tray
 * share the canvas and the board camera has its own center and scale. These
 * ratios are calibrated against the rendered standard 19-hex board at the
 * canvas CSS size; using the same transform for every q/r is what keeps a
 * server vertex on the rendered Colonist corner.
 */
const BOARD_CENTER = { x: 0.3534, y: 0.4718 } as const;
const BOARD_SCALE = { x: 0.0524, y: 0.07155 } as const;

function boardScale(canvas: Box): number {
  return Math.min(canvas.width * BOARD_SCALE.x, canvas.height * BOARD_SCALE.y);
}

function boardCenter(canvas: Box): { x: number; y: number } {
  return {
    x: canvas.left + canvas.width * BOARD_CENTER.x,
    y: canvas.top + canvas.height * BOARD_CENTER.y,
  };
}

export type Box = { left: number; top: number; width: number; height: number };

export type BoardClick = {
  kind: "board" | "ui";
  actionType?: Action["type"];
  ui?: string;
  prep?: string;
  x?: number;
  y?: number;
  vertex?: string;
  edge?: string;
  hex?: string;
  /** Colonist's authoritative _tileCorners/_tileEdges index. */
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

function hexCenter(q: number, r: number): [number, number] {
  return [SQRT3 * (q + r / 2), 1.5 * r];
}

function hexCorner(q: number, r: number, i: number): [number, number] {
  const [cx, cy] = hexCenter(q, r);
  const a = (Math.PI / 180) * (30 - 60 * i);
  return [cx + Math.cos(a), cy + Math.sin(a)];
}

function vertexXY(board: Board, vid: string): [number, number] | null {
  const v = board.vertices[vid];
  if (!v) return null;
  if (Number.isFinite(v.x) && Number.isFinite(v.y)) return [v.x, v.y];
  const pts: Array<[number, number]> = [];
  for (const hid of v.hexes) {
    const h = board.hexes[hid];
    if (!h) continue;
    const i = h.vertices.indexOf(vid);
    if (i < 0) continue;
    pts.push(hexCorner(h.q, h.r, i));
  }
  if (!pts.length) return null;
  return [
    pts.reduce((s, p) => s + p[0], 0) / pts.length,
    pts.reduce((s, p) => s + p[1], 0) / pts.length,
  ];
}

function ourAction(state: GameState, action: Action): boolean {
  if (action.player === state.us) return true;
  return action.type === "ACCEPT_TRADE" || action.type === "REJECT_TRADE" || action.type === "DISCARD";
}

export function islandBox(canvas: Box): Box {
  const scale = boardScale(canvas);
  const center = boardCenter(canvas);
  // Include the outer legal corner ring and the one-step probe used by the
  // driver, while ending before Colonist's right-hand log/tray.
  const halfWidth = scale * 5.35;
  const halfHeight = scale * 4.6;
  return {
    left: center.x - halfWidth,
    top: center.y - halfHeight,
    width: halfWidth * 2,
    height: halfHeight * 2,
  };
}

export function inBox(x: number, y: number, box: Box): boolean {
  return x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height;
}

/** Map a hex-space point onto the island inside a canvas that also holds the log strip. */
export function mapIslandClick(
  hexes: Array<{ q: number; r: number }>,
  x: number,
  y: number,
  canvas: Box,
): { x: number; y: number } | null {
  if (!hexes.length || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (canvas.width < 80 || canvas.height < 80) return null;
  const scale = boardScale(canvas);
  const center = boardCenter(canvas);
  return { x: center.x + x * scale, y: center.y + y * scale };
}

/**
 * Colonist's initial-placement UI is a two-step canvas interaction. The first
 * click selects the highlighted corner/edge; the confirmation sprite is drawn
 * above that selection. These offsets mirror ui-game's actual highlight sizes:
 * settlement = 1.75 * (1.2 * cornerCircleR), road = 1.75 * (hexagonHeight/4).
 */
export function mapInitialPlacementConfirmation(
  point: { x: number; y: number },
  canvas: Box,
  prep: "settlement" | "road",
): { x: number; y: number } {
  const scale = boardScale(canvas);
  const offset = prep === "road" ? (7 / 8) * scale : (4.2 / 5.2) * scale;
  return { x: point.x, y: point.y - offset };
}

/** Prefer the smallest on-screen control matching a UI rec (skip log/tray parents). */
export function pickUiHit(
  nodes: Array<{ t: string; x: number; y: number; w: number; h: number }>,
  re: RegExp,
): { x: number; y: number } | null {
  let best: { x: number; y: number; area: number } | null = null;
  for (const n of nodes) {
    const t = n.t.replace(/\s+/g, " ").trim();
    if (t.length > 40) continue;
    if (!re.test(t)) continue;
    if (n.w < 8 || n.h < 8 || n.w > 320 || n.h > 120) continue;
    const area = n.w * n.h;
    if (!best || area < best.area) best = { x: n.x, y: n.y, area };
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** Screen points around a rec vertex/edge so a small Colonist pip still gets a hit. */
export function vertexClickCluster(x: number, y: number): Array<{ x: number; y: number }> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
  const out: Array<{ x: number; y: number }> = [{ x, y }];
  for (const r of [12, 22]) {
    for (let a = 0; a < 6; a++) {
      const rad = (a * Math.PI) / 3;
      out.push({ x: x + r * Math.cos(rad), y: y + r * Math.sin(rad) });
    }
  }
  return out;
}

export function autoClickAllowed(play: { on: boolean; vsBots: boolean }, href: string): boolean {
  if (!play.on || !play.vsBots) return false;
  if (/ranked/i.test(href)) return false;
  return true;
}

export function occupyUs(
  state: GameState,
  body: { vertex?: string; edge?: string; hex?: string },
): boolean {
  const usP = state.players.find((p) => p.id === state.us);
  if (!usP) return false;
  const setup = state.turn === 0 || state.phase === "setup_settle" || state.phase === "setup_road";
  const houseCap = setup ? 2 : 5;
  const roadCap = setup ? 2 : 15;
  let ok = false;
  if (body.edge && state.board.edges[body.edge]) {
    const taken = state.players.some((p) => p.roads.includes(body.edge!));
    if (!taken && usP.roads.length < roadCap) {
      usP.roads.push(body.edge);
      usP.unplaced.roads = Math.max(0, usP.unplaced.roads - 1);
    }
    ok = usP.roads.includes(body.edge);
  } else if (body.vertex && state.board.vertices[body.vertex]) {
    const taken = state.players.some(
      (p) => p.settlements.includes(body.vertex!) || p.cities.includes(body.vertex!),
    );
    if (!taken && usP.settlements.length + usP.cities.length < houseCap) {
      usP.settlements.push(body.vertex);
      usP.unplaced.settlements = Math.max(0, usP.unplaced.settlements - 1);
    }
    ok = usP.settlements.includes(body.vertex) || usP.cities.includes(body.vertex);
  }
  if (body.hex && state.board.hexes[body.hex]) {
    state.robberHex = body.hex;
    ok = true;
  }
  return ok;
}

export function clickFor(state: GameState, rec: Recommendation | null): BoardClick | null {
  if (!rec) return null;
  const a = rec.action;
  if (a.id === "WAIT_BOARD") return null;
  if (!ourAction(state, a)) return null;

  const ui: Partial<Record<Action["type"], string>> = {
    ROLL: "roll",
    END_TURN: "end_turn",
    BUY_DEV: "buy_dev",
    ACCEPT_TRADE: "accept",
    REJECT_TRADE: "reject",
    DISCARD: "discard",
    PLAY_KNIGHT: "knight",
    PLAY_MONOPOLY: "monopoly",
    PLAY_YEAR_OF_PLENTY: "year",
    PLAY_ROAD_BUILDING: "road_building",
    MARITIME_TRADE: "trade",
    STEAL: "steal",
  };
  if (ui[a.type]) {
    const victim = a.stealFrom ? state.players.find((p) => p.id === a.stealFrom) : undefined;
    return {
      kind: "ui",
      actionType: a.type,
      ui: ui[a.type],
      stealFrom: a.stealFrom,
      stealFromColor: victim?.colonistColor,
      give: a.give,
      giveCount: a.giveCount,
      get: a.get,
      getCount: a.getCount,
      resource: a.resource,
      resources: a.resources,
      tradeId: a.tradeId,
      discard: a.discard,
      discardUnknown: a.discardUnknown,
      label: a.label,
      actionId: a.id,
    };
  }

  let prep: string | undefined;
  if (a.type === "PLACE_SETTLEMENT" || a.type === "BUILD_SETTLEMENT") prep = "settlement";
  if (a.type === "PLACE_ROAD" || a.type === "BUILD_ROAD") prep = "road";
  if (a.type === "BUILD_CITY") prep = "city";
  if (a.type === "MOVE_ROBBER") prep = "robber";

  if (a.edge && (a.type === "PLACE_ROAD" || a.type === "BUILD_ROAD")) {
    const e = state.board.edges[a.edge];
    if (!e) return null;
    const p = vertexXY(state.board, e.vertices[0]);
    const q = vertexXY(state.board, e.vertices[1]);
    if (!p || !q) return null;
    return {
      kind: "board",
      prep,
      x: (p[0] + q[0]) / 2,
      y: (p[1] + q[1]) / 2,
      edge: a.edge,
      colonistIndex: e.colonistIndex,
      label: a.label,
      actionId: a.id,
    };
  }
  if (a.vertex) {
    const xy = vertexXY(state.board, a.vertex);
    if (!xy) return null;
    return {
      kind: "board",
      prep,
      x: xy[0],
      y: xy[1],
      vertex: a.vertex,
      colonistIndex: state.board.vertices[a.vertex]?.colonistIndex,
      label: a.label,
      actionId: a.id,
    };
  }
  if (a.edge) {
    const e = state.board.edges[a.edge];
    if (!e) return null;
    const p = vertexXY(state.board, e.vertices[0]);
    const q = vertexXY(state.board, e.vertices[1]);
    if (!p || !q) return null;
    return {
      kind: "board",
      prep,
      x: (p[0] + q[0]) / 2,
      y: (p[1] + q[1]) / 2,
      edge: a.edge,
      colonistIndex: e.colonistIndex,
      label: a.label,
      actionId: a.id,
    };
  }
  if (a.hex) {
    const h = state.board.hexes[a.hex];
    if (!h) return null;
    const [x, y] = hexCenter(h.q, h.r);
    return { kind: "board", prep, x, y, hex: a.hex, label: a.label, actionId: a.id };
  }
  return null;
}
