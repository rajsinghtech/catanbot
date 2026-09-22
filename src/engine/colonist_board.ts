import type { Board, Edge, Hex, Port, Resource, Terrain, Vertex } from "../types.ts";

const TYPE_TERRAIN: Record<number, Terrain> = {
  0: "desert",
  1: "wood",
  2: "brick",
  3: "sheep",
  4: "wheat",
  5: "ore",
};

const NAME_TERRAIN: Record<string, Terrain> = {
  desert: "desert",
  wood: "wood",
  lumber: "wood",
  brick: "brick",
  clay: "brick",
  sheep: "sheep",
  wool: "sheep",
  wheat: "wheat",
  grain: "wheat",
  ore: "ore",
};

const DIRS: [number, number][] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

const SIZE = 1;
const SQRT3 = Math.sqrt(3);

function hexPixel(q: number, r: number): [number, number] {
  return [SQRT3 * SIZE * (q + r / 2), (3 / 2) * SIZE * r];
}

function cornerPixel(q: number, r: number, i: number): [number, number] {
  const [cx, cy] = hexPixel(q, r);
  // vkey's corner order is [SE, NE, N, NW, SW, S]. This also makes
  // Colonist z=0 (north) and z=1 (south) agree with the rendered board.
  const angle = (Math.PI / 180) * (30 - 60 * i);
  return [cx + SIZE * Math.cos(angle), cy + SIZE * Math.sin(angle)];
}

export function vkey(q: number, r: number, i: number): string {
  const a: [number, number][] = [
    [q, r],
    [q + DIRS[i][0], r + DIRS[i][1]],
    [q + DIRS[(i + 5) % 6][0], r + DIRS[(i + 5) % 6][1]],
  ];
  return a
    .map(([qq, rr]) => `${qq},${rr}`)
    .sort()
    .join("|");
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export type ColonistHarborIn = {
  x?: number;
  y?: number;
  q?: number;
  r?: number;
  z?: number;
  type?: number;
  resource?: string;
  ratio?: 2 | 3;
};

export type ColonistHexIn = {
  id?: string | number;
  x?: number;
  y?: number;
  q?: number;
  r?: number;
  type?: number;
  terrain?: string;
  diceNumber?: number | null;
  number?: number | null;
};

/** Colonist corners are (hex q,r, z) with z=0 the up vertex and z=1 the down vertex. */
export function vertexFromColonistCorner(
  board: Board,
  raw: { x?: number; y?: number; z?: number; q?: number; r?: number },
): string | undefined {
  const q = raw.q ?? raw.x;
  const r = raw.r ?? raw.y;
  const z = raw.z;
  if (typeof q !== "number" || typeof r !== "number" || typeof z !== "number" || Number.isNaN(q + r + z)) {
    return undefined;
  }
  const i = z === 0 ? 2 : 5;
  const id = vkey(q, r, i);
  return board.vertices[id]?.id;
}

/** Colonist edges are (hex q,r, z) with z in {0,1,2} = NW / W / SW of that hex. */
export function edgeFromColonistEdge(
  board: Board,
  raw: { x?: number; y?: number; z?: number; q?: number; r?: number },
): string | undefined {
  const q = raw.q ?? raw.x;
  const r = raw.r ?? raw.y;
  const z = raw.z;
  if (typeof q !== "number" || typeof r !== "number" || typeof z !== "number" || Number.isNaN(q + r + z)) {
    return undefined;
  }
  if (z < 0 || z > 2) return undefined;
  const dir = 2 + z;
  const a = vkey(q, r, dir);
  const b = vkey(q, r, (dir + 1) % 6);
  return edgeFromVertices(board, a, b);
}

export function edgeFromVertices(board: Board, a: string, b: string): string | undefined {
  for (const e of Object.values(board.edges)) {
    if (e.vertices.includes(a) && e.vertices.includes(b)) return e.id;
  }
  return undefined;
}

export function terrainFromColonist(type?: number, name?: string): Terrain {
  if (typeof type === "number" && type in TYPE_TERRAIN) return TYPE_TERRAIN[type];
  if (name) {
    const t = NAME_TERRAIN[name.toLowerCase()];
    if (t) return t;
  }
  return "desert";
}

export function buildBoardFromColonistHexes(raw: ColonistHexIn[]): Board {
  const hexes: Record<string, Hex> = {};
  const vertices: Record<string, Vertex> = {};
  const edges: Record<string, Edge> = {};

  for (const t of raw) {
    const q = t.q ?? t.x;
    const r = t.r ?? t.y;
    if (typeof q !== "number" || typeof r !== "number") continue;
    const terrain = terrainFromColonist(t.type, t.terrain);
    const dice = t.diceNumber ?? t.number ?? null;
    const id = `h:${q},${r}`;
    const corners: string[] = [];
    for (let c = 0; c < 6; c++) {
      const [x, y] = cornerPixel(q, r, c);
      const vid = vkey(q, r, c);
      corners.push(vid);
      if (!vertices[vid]) vertices[vid] = { id: vid, hexes: [], edges: [], x, y };
      if (!vertices[vid].hexes.includes(id)) vertices[vid].hexes.push(id);
    }
    hexes[id] = {
      id,
      q,
      r,
      terrain,
      number: terrain === "desert" || !dice ? null : Number(dice),
      vertices: corners,
    };
    for (let c = 0; c < 6; c++) {
      const a = corners[c];
      const b = corners[(c + 1) % 6];
      const eid = edgeKey(a, b);
      if (!edges[eid]) edges[eid] = { id: eid, vertices: a < b ? [a, b] : [b, a] };
      if (!vertices[a].edges.includes(eid)) vertices[a].edges.push(eid);
      if (!vertices[b].edges.includes(eid)) vertices[b].edges.push(eid);
    }
  }
  if (Object.keys(hexes).length === 0) throw new Error("no colonist hexes");
  const board: Board = { hexes, vertices, edges };
  assignDefaultPorts(board);
  return board;
}

const HARBOR_TYPE: Record<number, Port> = {
  0: { ratio: 3 },
  1: { ratio: 2, resource: "wood" },
  2: { ratio: 2, resource: "brick" },
  3: { ratio: 2, resource: "sheep" },
  4: { ratio: 2, resource: "wheat" },
  5: { ratio: 2, resource: "ore" },
};

/** Colonist portEdgeStates type ints: 1 = 3:1, 2–6 = 2:1 wood…ore. */
const PORT_EDGE_TYPE: Record<number, Port> = {
  1: { ratio: 3 },
  2: { ratio: 2, resource: "wood" },
  3: { ratio: 2, resource: "brick" },
  4: { ratio: 2, resource: "sheep" },
  5: { ratio: 2, resource: "wheat" },
  6: { ratio: 2, resource: "ore" },
};

function portFromHarbor(h: ColonistHarborIn): Port {
  if (h.ratio === 2 || h.ratio === 3) {
    return h.resource && h.resource !== "desert"
      ? { ratio: h.ratio, resource: terrainFromColonist(undefined, h.resource) as Resource }
      : { ratio: h.ratio };
  }
  if (typeof h.z === "number" && Number.isFinite(h.z) && typeof h.type === "number" && PORT_EDGE_TYPE[h.type]) {
    return { ...PORT_EDGE_TYPE[h.type] };
  }
  if (typeof h.type === "number" && PORT_EDGE_TYPE[h.type] && !HARBOR_TYPE[h.type]) {
    return { ...PORT_EDGE_TYPE[h.type] };
  }
  if (typeof h.type === "number" && HARBOR_TYPE[h.type]) return { ...HARBOR_TYPE[h.type] };
  if (h.resource) {
    const t = terrainFromColonist(undefined, h.resource);
    if (t !== "desert") return { ratio: 2, resource: t };
  }
  return { ratio: 3 };
}

/** Vertices of a Colonist edge (q,r,z) with z in {0,1,2} = NW / W / SW. */
export function colonistEdgeVertices(q: number, r: number, z: number): [string, string] {
  if (z >= 0 && z <= 2) {
    const dir = 2 + z;
    return [vkey(q, r, dir), vkey(q, r, (dir + 1) % 6)];
  }
  const i = ((z % 6) + 6) % 6;
  return [vkey(q, r, i), vkey(q, r, (i + 1) % 6)];
}

function islandCenter(board: Board): { x: number; y: number } {
  const hs = Object.values(board.hexes);
  const x = hs.reduce((s, h) => s + hexPixel(h.q, h.r)[0], 0) / hs.length;
  const y = hs.reduce((s, h) => s + hexPixel(h.q, h.r)[1], 0) / hs.length;
  return { x, y };
}

function coastalVerts(board: Board, hex: Hex): Vertex[] {
  const c = islandCenter(board);
  return hex.vertices
    .map((id) => board.vertices[id])
    .filter((v) => v && v.hexes.length <= 2)
    .sort((a, b) => Math.hypot(b.x - c.x, b.y - c.y) - Math.hypot(a.x - c.x, a.y - c.y));
}

export function applyHarbors(board: Board, harbors: ColonistHarborIn[]): void {
  const usable = harbors.filter((h) => {
    const q = h.q ?? h.x;
    const r = h.r ?? h.y;
    return typeof q === "number" && Number.isFinite(q) && typeof r === "number" && Number.isFinite(r);
  });
  if (!usable.length) return;

  const next = new Map<string, Port>();
  const stamp = (vid: string | undefined, port: Port) => {
    if (vid && board.vertices[vid]) next.set(vid, port);
  };

  for (const h of usable) {
    const q = h.q ?? h.x;
    const r = h.r ?? h.y;
    if (typeof q !== "number" || typeof r !== "number") continue;
    const port = portFromHarbor(h);
    if (typeof h.z === "number" && Number.isFinite(h.z)) {
      const [a, b] = colonistEdgeVertices(q, r, h.z);
      stamp(a, port);
      stamp(b, port);
      const eid = edgeFromColonistEdge(board, { q, r, z: h.z });
      if (eid) for (const vid of board.edges[eid].vertices) stamp(vid, port);
      continue;
    }
    if (board.hexes[`h:${q},${r}`]) {
      for (const v of coastalVerts(board, board.hexes[`h:${q},${r}`]).slice(0, 2)) stamp(v.id, port);
      continue;
    }
    let best: Hex | undefined;
    let bestD = Infinity;
    for (const hex of Object.values(board.hexes)) {
      const d = (hex.q - q) ** 2 + (hex.r - r) ** 2;
      if (d < bestD && d <= 3) {
        bestD = d;
        best = hex;
      }
    }
    if (best) {
      for (const v of coastalVerts(board, best).slice(0, 2)) stamp(v.id, port);
    }
  }

  if (next.size < 8) return;
  for (const v of Object.values(board.vertices)) delete v.port;
  for (const [id, port] of next) board.vertices[id].port = port;
}

function assignDefaultPorts(board: Board): void {
  const coastal = Object.values(board.vertices).filter((v) => v.hexes.length <= 2);
  coastal.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
  const bag: Array<Port["resource"]> = [undefined, undefined, undefined, undefined, "wood", "brick", "sheep", "wheat", "ore"];
  const step = Math.max(1, Math.floor(coastal.length / 9));
  let p = 0;
  for (let i = 0; i < coastal.length && p < bag.length; i += step) {
    const v = coastal[i];
    const res = bag[p++];
    v.port = res ? { ratio: 2, resource: res } : { ratio: 3 };
    const mates = v.edges
      .map((eid) => board.edges[eid])
      .filter(Boolean)
      .map((e) => (e.vertices[0] === v.id ? e.vertices[1] : e.vertices[0]))
      .map((id) => board.vertices[id])
      .filter((n) => n && n.hexes.length <= 2 && !n.port);
    mates.sort((a, b) => Math.hypot(a.x - v.x, a.y - v.y) - Math.hypot(b.x - v.x, b.y - v.y));
    if (mates[0]) mates[0].port = v.port;
  }
}

export function findMapState(node: unknown, depth = 0): Record<string, unknown> | null {
  if (!node || depth > 16) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findMapState(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const rec = node instanceof Map
    ? Object.fromEntries(node.entries()) as Record<string, unknown>
    : node as Record<string, unknown>;
  if (rec.tileHexStates && typeof rec.tileHexStates === "object") return rec;
  if (rec.mapState && typeof rec.mapState === "object") {
    const inner = findMapState(rec.mapState, depth + 1);
    if (inner) return inner;
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object") {
      const found = findMapState(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function harborsFromMapState(mapState: Record<string, unknown>): ColonistHarborIn[] {
  const out: ColonistHarborIn[] = [];
  const coordinateKey = (value: string): { q: number; r: number } | undefined => {
    const match = value.match(/(-?\d+(?:\.\d+)?)[,:/_ -]+(-?\d+(?:\.\d+)?)/);
    return match ? { q: Number(match[1]), r: Number(match[2]) } : undefined;
  };
  const take = (raw: unknown, fallback?: { q: number; r: number }) => {
    if (!raw || typeof raw !== "object") return;
    const entries = Array.isArray(raw)
      ? raw.map((item) => ({ item }))
      : raw instanceof Map
        ? [...raw.entries()].map(([id, item]) => ({ id: String(id), item }))
        : Object.entries(raw as Record<string, unknown>).map(([id, item]) => ({ id, item }));
    for (const { id, item } of entries) {
      const parsed = id ? coordinateKey(id) : undefined;
      const position = parsed ?? fallback;
      if (typeof item === "number" || typeof item === "string") {
        const type = Number(item);
        if (position && Number.isFinite(type)) out.push({ q: position.q, r: position.r, type });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const t = item as Record<string, unknown>;
      out.push({
        x: t.x == null ? undefined : Number(t.x),
        y: t.y == null ? undefined : Number(t.y),
        q: t.q == null ? position?.q : Number(t.q),
        r: t.r == null ? position?.r : Number(t.r),
        z: t.z == null && t.dir == null && t.edge == null ? undefined : Number(t.z ?? t.dir ?? t.edge),
        type: t.type == null && t.harborType == null && t.portType == null
          ? undefined
          : Number(t.type ?? t.harborType ?? t.portType),
        resource: typeof t.resource === "string" ? t.resource : typeof t.good === "string" ? t.good : undefined,
        ratio: t.ratio === 2 || t.ratio === 3 ? t.ratio : undefined,
      });
    }
  };
  if (mapState.portEdgeStates) take(mapState.portEdgeStates);
  if (out.length) return out.filter((h) => h.x != null || h.q != null);
  for (const key of ["tileHarborStates", "harborStates", "harbors", "harbourStates", "harbours"]) {
    if (mapState[key]) take(mapState[key]);
  }
  if (!out.length) {
    for (const [k, v] of Object.entries(mapState)) {
      if (/harbou?r/i.test(k)) take(v);
    }
  }
  const tiles = mapState.tileHexStates;
  if (tiles && typeof tiles === "object") {
    const entries = tiles instanceof Map
      ? [...tiles.entries()].map(([id, raw]) => [String(id), raw] as const)
      : Object.entries(tiles as Record<string, unknown>);
    for (const [id, raw] of entries) {
      if (!raw || typeof raw !== "object") continue;
      const tile = raw as Record<string, unknown>;
      const harbor = tile.harbor ?? tile.harbour ?? tile.port;
      const q = Number(tile.q ?? tile.x);
      const r = Number(tile.r ?? tile.y);
      const fallback = Number.isFinite(q) && Number.isFinite(r) ? { q, r } : coordinateKey(id);
      if (harbor && fallback) take(Array.isArray(harbor) ? harbor : [harbor], fallback);
      else if (tile.harborType != null && fallback) take([{ harborType: tile.harborType }], fallback);
    }
  }
  return out.filter((h) => h.x != null || h.q != null);
}

export function harborsFromPayload(node: unknown, depth = 0): ColonistHarborIn[] {
  if (!node || depth > 12 || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((item) => harborsFromPayload(item, depth + 1));
  const rec = node instanceof Map
    ? Object.fromEntries(node.entries()) as Record<string, unknown>
    : node as Record<string, unknown>;
  const out = harborsFromMapState(rec);
  for (const value of Object.values(rec)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...harborsFromPayload(value, depth + 1));
    }
  }
  const seen = new Set<string>();
  return out.filter((h) => {
    const q = h.q ?? h.x;
    const r = h.r ?? h.y;
    const id = `${q},${r},${h.z ?? ""}:${h.type ?? ""}:${h.resource ?? ""}:${h.ratio ?? ""}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function hexesFromMapState(mapState: Record<string, unknown>): ColonistHexIn[] {
  const rawTiles = mapState.tileHexStates;
  const tiles = rawTiles && typeof rawTiles === "object"
    ? rawTiles instanceof Map
      ? [...rawTiles.entries()].map(([id, tile]) => [String(id), tile] as const)
      : Object.entries(rawTiles as Record<string, Record<string, unknown>>)
    : [];
  const out: ColonistHexIn[] = [];
  for (const [id, t] of tiles) {
    if (!t || typeof t !== "object") continue;
    const coordinate = id.match(/(-?\d+(?:\.\d+)?)[,:/_ -]+(-?\d+(?:\.\d+)?)/);
    const q = Number(t.q ?? t.axialQ ?? t.x ?? (coordinate ? coordinate[1] : NaN));
    const r = Number(t.r ?? t.axialR ?? t.y ?? (coordinate ? coordinate[2] : NaN));
    if (!Number.isFinite(q) || !Number.isFinite(r)) continue;
    out.push({
      id,
      q,
      r,
      x: Number.isFinite(Number(t.x)) ? Number(t.x) : undefined,
      y: Number.isFinite(Number(t.y)) ? Number(t.y) : undefined,
      type: t.type == null ? undefined : Number(t.type),
      terrain: typeof t.terrain === "string" ? t.terrain : typeof t.resource === "string" ? t.resource : undefined,
      diceNumber: t.diceNumber == null
        ? t.number == null ? null : Number(t.number)
        : Number(t.diceNumber),
    });
  }
  return out;
}

export function labelVertex(board: Board, vid: string): string {
  const v = board.vertices[vid];
  if (!v) return vid;
  return v.hexes
    .map((hid) => {
      const h = board.hexes[hid];
      return h.number ? `${h.number}-${h.terrain}` : h.terrain;
    })
    .join(" / ");
}

export function resourceOf(hex: Hex): Resource | null {
  return hex.terrain === "desert" ? null : hex.terrain;
}
