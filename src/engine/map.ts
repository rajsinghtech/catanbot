import type { Board, Edge, Hex, Port, Resource, Terrain, Vertex } from "../types.ts";

const HEX_COORDS: [number, number][] = [
  [0, -2],
  [1, -2],
  [2, -2],
  [-1, -1],
  [0, -1],
  [1, -1],
  [2, -1],
  [-2, 0],
  [-1, 0],
  [0, 0],
  [1, 0],
  [2, 0],
  [-2, 1],
  [-1, 1],
  [0, 1],
  [1, 1],
  [-2, 2],
  [-1, 2],
  [0, 2],
];

const TERRAIN_BAG: Terrain[] = [
  "wood",
  "wood",
  "wood",
  "wood",
  "sheep",
  "sheep",
  "sheep",
  "sheep",
  "wheat",
  "wheat",
  "wheat",
  "wheat",
  "brick",
  "brick",
  "brick",
  "ore",
  "ore",
  "ore",
  "desert",
];

const NUMBER_BAG = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

const SIZE = 1;
const SQRT3 = Math.sqrt(3);
const DIRS: [number, number][] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

function hexPixel(q: number, r: number): [number, number] {
  return [SQRT3 * SIZE * (q + r / 2), (3 / 2) * SIZE * r];
}

function cornerPixel(q: number, r: number, i: number): [number, number] {
  const [cx, cy] = hexPixel(q, r);
  // Keep the geometric order aligned with vkey and Colonist's z corners:
  // [SE, NE, N, NW, SW, S].
  const angle = (Math.PI / 180) * (30 - 60 * i);
  return [cx + SIZE * Math.cos(angle), cy + SIZE * Math.sin(angle)];
}

function vkey(q: number, r: number, i: number): string {
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

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const PORT_RESOURCES: Array<Port["resource"]> = [
  undefined,
  undefined,
  undefined,
  undefined,
  "wood",
  "brick",
  "sheep",
  "wheat",
  "ore",
];

/** Offline engine fixture only; live Colonist state replaces this board before deciding. */
export function buildStandardBoard(seed = 1): Board {
  const rng = mulberry32(seed);
  const terrain = shuffle(TERRAIN_BAG, rng);
  const numbers = shuffle(NUMBER_BAG, rng);
  let n = 0;

  const hexes: Record<string, Hex> = {};
  const vertices: Record<string, Vertex> = {};
  const edges: Record<string, Edge> = {};

  for (let i = 0; i < HEX_COORDS.length; i++) {
    const [q, r] = HEX_COORDS[i];
    const t = terrain[i];
    const id = `h:${q},${r}`;
    const corners: string[] = [];
    for (let c = 0; c < 6; c++) {
      const [x, y] = cornerPixel(q, r, c);
      const vid = vkey(q, r, c);
      corners.push(vid);
      if (!vertices[vid]) {
        vertices[vid] = { id: vid, hexes: [], edges: [], x, y };
      }
      if (!vertices[vid].hexes.includes(id)) vertices[vid].hexes.push(id);
    }
    hexes[id] = {
      id,
      q,
      r,
      terrain: t,
      number: t === "desert" ? null : numbers[n++],
      vertices: corners,
    };
    for (let c = 0; c < 6; c++) {
      const a = corners[c];
      const b = corners[(c + 1) % 6];
      const eid = edgeKey(a, b);
      if (!edges[eid]) {
        edges[eid] = { id: eid, vertices: a < b ? [a, b] : [b, a] };
      }
      if (!vertices[a].edges.includes(eid)) vertices[a].edges.push(eid);
      if (!vertices[b].edges.includes(eid)) vertices[b].edges.push(eid);
    }
  }

  const desert = Object.values(hexes).find((h) => h.terrain === "desert");
  if (!desert) throw new Error("desert missing");

  assignPorts(vertices, rng);
  return { hexes, vertices, edges };
}

function assignPorts(vertices: Record<string, Vertex>, rng: () => number): void {
  const coastal = Object.values(vertices).filter((v) => v.hexes.length <= 2);
  coastal.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
  const ports = shuffle(PORT_RESOURCES, rng);
  const step = Math.max(1, Math.floor(coastal.length / 9));
  let p = 0;
  for (let i = 0; i < coastal.length && p < ports.length; i += step) {
    const v = coastal[i];
    const res = ports[p++];
    v.port = res ? { ratio: 2, resource: res } : { ratio: 3 };
    const neighborIds = v.edges
      .flatMap((eid) => {
        const [a, b] = eid.split("|");
        return [a, b];
      })
      .filter((id) => id !== v.id);
    const mate = neighborIds
      .map((id) => vertices[id])
      .filter((n) => n && n.hexes.length <= 2)
      .sort((a, b) => Math.hypot(a.x - v.x, a.y - v.y) - Math.hypot(b.x - v.x, b.y - v.y))[0];
    if (mate && !mate.port) mate.port = v.port;
  }
}

export function otherVertex(edge: Edge, vertex: string): string {
  return edge.vertices[0] === vertex ? edge.vertices[1] : edge.vertices[0];
}

export function hexByCoords(board: Board, q: number, r: number): Hex | undefined {
  return board.hexes[`h:${q},${r}`];
}

export function resourceOf(hex: Hex): Resource | null {
  return hex.terrain === "desert" ? null : hex.terrain;
}
