import {
  EMPTY_DEVS,
  EMPTY_HAND,
  PLAYER_COLORS,
  RESOURCES,
  type GameState,
  type Hand,
  type Player,
  type Resource,
} from "../types.ts";
import {
  handSize,
  refreshAwards,
  stealCandidates,
  syncSetupFromPieces,
} from "../engine/game.ts";
import type { LogEvent } from "./log.ts";
import { edgeFromColonistEdge, edgeFromVertices, findMapState, vertexFromColonistCorner } from "../engine/colonist_board.ts";

/** Metadata from Colonist's websocket is intentionally treated as untrusted. */
export type WsPayload = unknown;

type RecordLike = Record<string, unknown>;
type BuildKind = "settlement" | "city" | "road";

const RESOURCE_ALIASES: Array<[Resource, RegExp]> = [
  ["wood", /\b(?:wood|lumber|forest)\b/i],
  ["brick", /\b(?:brick|clay)\b/i],
  ["sheep", /\b(?:sheep|wool)\b/i],
  ["wheat", /\b(?:wheat|grain)\b/i],
  ["ore", /\bore\b/i],
];

const COSTS: Record<BuildKind, Partial<Hand>> = {
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  road: { wood: 1, brick: 1 },
};

function asRecord(value: unknown): RecordLike | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function walkPayload(payload: unknown): RecordLike[] {
  const out: RecordLike[] = [];
  const queue: unknown[] = [payload];
  const seen = new Set<object>();
  let steps = 0;
  while (queue.length && steps++ < 4000) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const record = asRecord(current);
    if (!record || seen.has(record)) continue;
    seen.add(record);
    out.push(record);
    for (const value of Object.values(record)) {
      if (asRecord(value) || Array.isArray(value)) queue.push(value);
    }
  }
  return out;
}

function payloadValues(payload: unknown, keys: string[]): unknown[] {
  const wanted = new Set(keys.map(normalizedKey));
  const values: unknown[] = [];
  for (const record of walkPayload(payload)) {
    for (const [key, value] of Object.entries(record)) {
      if (wanted.has(normalizedKey(key))) values.push(value);
    }
  }
  return values;
}

function firstPayloadValue(payload: unknown, keys: string[]): unknown {
  return payloadValues(payload, keys)[0];
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["name", "playerName", "username", "userName", "displayName", "color", "id", "value"]) {
    const found = record[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function integerAt(value: unknown, fallback: number): number {
  const n = numberValue(value);
  return n === undefined ? fallback : Math.max(0, Math.floor(n));
}

function resourceName(value: unknown): Resource | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[_-]/g, " ");
  return RESOURCE_ALIASES.find(([, pattern]) => pattern.test(normalized))?.[0];
}

function resourceEntries(value: unknown): Resource[] {
  if (typeof value === "string") {
    const matches: Resource[] = [];
    const normalized = value.replace(/[_-]/g, " ");
    for (const [resource, pattern] of RESOURCE_ALIASES) {
      if (pattern.test(normalized)) matches.push(resource);
    }
    return matches;
  }
  if (Array.isArray(value)) return value.flatMap(resourceEntries);
  const record = asRecord(value);
  if (!record) return [];
  const out: Resource[] = [];
  for (const r of RESOURCES) {
    const count = integerAt(record[r], 0);
    for (let i = 0; i < count; i++) out.push(r);
  }
  return out;
}

function eventResources(event: LogEvent, payload: unknown): Resource[] {
  const out = event.resources.flatMap(resourceEntries);
  if (out.length) return out;
  const payloadResourceValues = [
    firstPayloadValue(payload, ["resources", "resource", "cards", "card"]),
  ];
  for (const value of payloadResourceValues) out.push(...resourceEntries(value));
  return out;
}

function tradeIdFromPayload(payload: unknown): string | undefined {
  for (const record of walkPayload(payload)) {
    const offered = record.offeredResources ?? record.offered ?? record.give;
    const wanted = record.wantedResources ?? record.wanted ?? record.get;
    if (offered == null && wanted == null) continue;
    for (const key of ["id", "tradeId", "offerId", "trade_id"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function expandedResources(resources: Resource[], count: number | undefined): Resource[] {
  if (resources.length === 1 && count !== undefined && count > 1) {
    return Array.from({ length: count }, () => resources[0]);
  }
  return resources;
}

function playerKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function locationString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["id", "key", "value", "vertex", "edge", "hex", "tileId"]) {
    const found = record[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return undefined;
}

function colonistCornerFromUnknown(value: unknown): { x?: number; y?: number; z?: number; q?: number; r?: number } | undefined {
  if (typeof value === "string") {
    const parts = value.split(/[,\s]+/).map((p) => Number(p)).filter((n) => !Number.isNaN(n));
    if (parts.length >= 3) return { x: parts[0], y: parts[1], z: parts[2] };
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const z = numberValue(record.z ?? record.corner ?? record.dir);
  const x = numberValue(record.x ?? record.q);
  const y = numberValue(record.y ?? record.r);
  if (x === undefined || y === undefined || z === undefined) return undefined;
  return { x, y, z };
}

function resolveBoardLocation(state: GameState, value: unknown, kind: "vertex" | "edge"): string | undefined {
  const direct = locationString(value);
  if (direct) {
    if (kind === "vertex" && state.board.vertices[direct]) return direct;
    if (kind === "edge" && state.board.edges[direct]) return direct;
  }
  const corner = colonistCornerFromUnknown(value) ?? colonistCornerFromUnknown(direct);
  if (kind === "vertex" && corner) return vertexFromColonistCorner(state.board, corner);
  if (kind === "edge") {
    if (corner) {
      const eid = edgeFromColonistEdge(state.board, corner);
      if (eid) return eid;
    }
    const rec = asRecord(value);
    const from = rec ? colonistCornerFromUnknown(rec.from ?? rec.a ?? rec.start) : undefined;
    const to = rec ? colonistCornerFromUnknown(rec.to ?? rec.b ?? rec.end) : undefined;
    if (from && to) {
      const a = vertexFromColonistCorner(state.board, from);
      const b = vertexFromColonistCorner(state.board, to);
      if (a && b) return edgeFromVertices(state.board, a, b);
    }
  }
  return undefined;
}

function payloadPlayerReference(payload: unknown, role: "actor" | "target"): unknown {
  if (role === "actor") {
    return firstPayloadValue(payload, [
      "actor",
      "actorName",
      "player",
      "playerName",
      "user",
      "username",
      "thief",
      "sourcePlayer",
      "playerId",
      "actorId",
      "userId",
      "sourcePlayerId",
    ]);
  }
  return firstPayloadValue(payload, [
    "target",
    "targetName",
    "victim",
    "victimName",
    "stealFrom",
    "fromPlayer",
    "recipient",
    "targetId",
    "victimId",
    "stealFromId",
    "recipientId",
  ]);
}

function isBoardLocation(state: GameState, value: string): boolean {
  return Boolean(state.board.hexes[value] || state.board.vertices[value] || state.board.edges[value]);
}

function findExistingPlayer(state: GameState, value: string | undefined): Player | undefined {
  if (!value) return undefined;
  const key = playerKey(value);
  const alias = key === "you" || key === "me" ? state.us : key === "us" ? state.us : undefined;
  return state.players.find((p) =>
    playerKey(p.id) === (alias ?? key) || playerKey(p.name) === (alias ?? key),
  );
}

function makePlayer(state: GameState, name: string): Player {
  const used = new Set(state.players.map((p) => p.color));
  const color = PLAYER_COLORS.find((candidate) => !used.has(candidate));
  if (!color) throw new Error(`cannot add Colonist player ${name}: all six colors are used`);
  const created: Player = {
    id: color,
    name,
    color,
    hand: EMPTY_HAND(),
    hidden: { known: EMPTY_HAND(), unknown: 0 },
    devs: EMPTY_DEVS(),
    newDevs: EMPTY_DEVS(),
    knightsPlayed: 0,
    settlements: [],
    cities: [],
    roads: [],
    unplaced: { settlements: 0, cities: 0, roads: 0 },
    playedDevThisTurn: false,
  };
  state.players.push(created);
  state.config.playerCount = state.players.length;
  return created;
}

function resolvePlayer(
  state: GameState,
  eventReference: string | undefined,
  payload: unknown,
  role: "actor" | "target",
  create = true,
): Player | undefined {
  const payloadReference = textValue(payloadPlayerReference(payload, role));
  const references = [eventReference, payloadReference].filter(
    (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index,
  );
  for (const reference of references) {
    const existing = findExistingPlayer(state, reference);
    if (existing) return existing;
  }
  if (!create) return undefined;
  const name = references.find((value) => !isBoardLocation(state, value));
  if (!name) return undefined;
  return makePlayer(state, name);
}

function actorFor(state: GameState, event: LogEvent, payload: unknown): Player | undefined {
  return resolvePlayer(state, event.actor, payload, "actor", true) ?? state.players.find((p) => p.id === state.current);
}

function targetFor(state: GameState, event: LogEvent, payload: unknown, create = true): Player | undefined {
  return resolvePlayer(state, event.target, payload, "target", create);
}

function addKnown(state: GameState, p: Player, resource: Resource, count: number): void {
  if (count <= 0) return;
  p.hand[resource] += count;
  p.hidden.known[resource] += count;
  state.bank[resource] = Math.max(0, state.bank[resource] - count);
}

function removeKnown(p: Player, resource: Resource, count: number): number {
  const removed = Math.min(Math.max(0, p.hand[resource]), Math.max(0, count));
  p.hand[resource] -= removed;
  p.hidden.known[resource] = Math.max(0, p.hidden.known[resource] - removed);
  return removed;
}

function returnKnown(state: GameState, p: Player, resource: Resource, count: number): number {
  const removed = removeKnown(p, resource, count);
  state.bank[resource] += removed;
  return removed;
}

function observedHandSize(p: Player): number {
  return handSize(p);
}

function addUnknown(p: Player, count: number): void {
  p.hidden.unknown += Math.max(0, count);
}

function removeUnknown(p: Player, count: number): number {
  const removed = Math.min(p.hidden.unknown, Math.max(0, count));
  p.hidden.unknown -= removed;
  return removed;
}

function removeOneUnidentifiedCard(p: Player): void {
  const unknown = p.hidden.unknown;
  const known = RESOURCES.filter((r) => p.hand[r] > 0);
  const knownCount = RESOURCES.reduce((sum, r) => sum + p.hand[r], 0);
  if (unknown > 0) {
    // Once the victim has a mixture of known and unknown cards, the remaining
    // composition is no longer identifiable after a random steal.
    for (const r of RESOURCES) removeKnown(p, r, p.hand[r]);
    p.hidden.unknown = Math.max(0, knownCount + unknown - 1);
    return;
  }
  if (known.length === 1) {
    // If every card has the same identity, the random card is still known.
    removeKnown(p, known[0], 1);
    return;
  }
  if (knownCount > 0) {
    for (const r of RESOURCES) removeKnown(p, r, p.hand[r]);
    p.hidden.unknown = knownCount - 1;
  }
}

function payCost(state: GameState, p: Player, kind: BuildKind): void {
  for (const r of RESOURCES) {
    const required = COSTS[kind][r] ?? 0;
    if (!required) continue;
    const known = returnKnown(state, p, r, required);
    const missing = required - known;
    if (missing > 0) removeUnknown(p, missing);
  }
}

function addUnique(list: string[], value: string | undefined): boolean {
  if (!value || list.includes(value)) return false;
  list.push(value);
  return true;
}

function occupancyKind(rec: RecordLike): "settlement" | "city" | "road" | undefined {
  const piece = textValue(rec.building ?? rec.piece ?? rec.kind ?? rec.structure ?? rec.type)?.toLowerCase();
  if (piece) {
    if (/road/.test(piece)) return "road";
    if (/city|town/.test(piece)) return "city";
    if (/settle|house/.test(piece)) return "settlement";
  }
  const n = numberValue(rec.building ?? rec.buildingType ?? rec.pieceType ?? rec.structureType);
  if (n === 1) return "settlement";
  if (n === 2) return "city";
  if (n === 3) return "road";
  return undefined;
}

/** Colonist playerUserStates / piece owner ints. */
const COLONIST_COLOR_ID: Record<number, string> = {
  1: "blue",
  2: "red",
  3: "orange",
  4: "brown",
  5: "white",
  6: "green",
};

function mapEntries(value: unknown): Array<{ id: string; rec: RecordLike }> {
  if (!value || typeof value !== "object") return [];
  const pairs: Array<[unknown, unknown]> = value instanceof Map
    ? [...value.entries()]
    : Array.isArray(value)
      ? value.map((item, i) => [i, item] as [unknown, unknown])
      : Object.entries(value as Record<string, unknown>);
  const out: Array<{ id: string; rec: RecordLike }> = [];
  for (const [id, item] of pairs) {
    const rec = asRecord(item);
    if (rec) out.push({ id: String(id), rec });
  }
  return out;
}

function findKeyed(payload: unknown, keys: string[], depth = 0): unknown {
  if (!payload || depth > 12) return undefined;
  const wanted = new Set(keys.map(normalizedKey));
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findKeyed(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const rec = payload instanceof Map
    ? Object.fromEntries(payload.entries()) as RecordLike
    : asRecord(payload);
  if (!rec) return undefined;
  for (const [key, value] of Object.entries(rec)) {
    if (wanted.has(normalizedKey(key)) && value != null) return value;
  }
  for (const value of Object.values(rec)) {
    if (value && typeof value === "object") {
      const found = findKeyed(value, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function colonistColorOf(value: unknown): { id?: number; name?: string } {
  if (typeof value === "number" && Number.isFinite(value)) {
    const id = Math.floor(value);
    return { id, name: COLONIST_COLOR_ID[id] };
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return colonistColorOf(Number(trimmed));
    const name = trimmed.toLowerCase();
    const match = Object.entries(COLONIST_COLOR_ID).find(([, n]) => n === name);
    return { name, id: match ? Number(match[0]) : undefined };
  }
  const rec = asRecord(value);
  if (!rec) return {};
  return colonistColorOf(
    rec.selectedColor ?? rec.playerColor ?? rec.colorId ?? rec.color ?? rec.id ?? rec.owner,
  );
}

function hasOwner(rec: RecordLike): boolean {
  const owner = rec.owner ?? rec.playerColor ?? rec.player ?? rec.color;
  if (owner == null || owner === 0 || owner === false || owner === "") return false;
  if (typeof owner === "number" && owner <= 0) return false;
  return true;
}

function occupantFor(state: GameState, rec: RecordLike): Player | undefined {
  const name = textValue(
    rec.playerName ?? rec.username ?? rec.ownerName ?? rec.user ?? rec.displayName,
  );
  const color = colonistColorOf(
    rec.owner ?? rec.playerColor ?? rec.selectedColor ?? rec.color ?? rec.player,
  );
  if (name) {
    const existing = findExistingPlayer(state, name);
    if (existing) {
      if (color.id != null) existing.colonistColor = color.id;
      return existing;
    }
  }
  if (color.id != null) {
    const byColonist = state.players.find((p) => p.colonistColor === color.id);
    if (byColonist) return byColonist;
  }
  if (color.name) {
    return state.players.find((p) => p.color === color.name || p.id === color.name);
  }
  return undefined;
}

function bindPlayersFromPayload(state: GameState, payload: unknown): void {
  const raw = findKeyed(payload, ["playerUserStates", "playerStates", "users", "gamePlayers"]);
  if (raw == null) return;
  const list = mapEntries(raw);
  const records = list.length ? list.map((e) => e.rec) : walkPayload(raw);
  for (const rec of records) {
    const name = textValue(
      rec.username ?? rec.playerName ?? rec.name ?? rec.userName ?? rec.displayName,
    );
    if (!name) continue;
    const color = colonistColorOf(
      rec.selectedColor ?? rec.playerColor ?? rec.color ?? rec.colorId ?? rec.owner,
    );
    const p = findExistingPlayer(state, name);
    if (p && color.id != null) p.colonistColor = color.id;
  }
}

function cornerKind(rec: RecordLike): "settlement" | "city" | undefined {
  const kind = occupancyKind(rec);
  if (kind === "road") return undefined;
  if (kind === "city") return "city";
  if (kind === "settlement") return "settlement";
  if (!hasOwner(rec)) return undefined;
  return "settlement";
}

function edgeOwned(rec: RecordLike): boolean {
  const kind = occupancyKind(rec);
  if (kind === "road") return true;
  if (kind === "settlement" || kind === "city") return false;
  return hasOwner(rec);
}

function placePiece(p: Player, kind: "settlement" | "city" | "road", location: string): boolean {
  if (kind === "road") {
    if (addUnique(p.roads, location)) {
      p.unplaced.roads = Math.max(0, p.unplaced.roads - 1);
      return true;
    }
    return false;
  }
  if (kind === "city") {
    p.settlements = p.settlements.filter((vid) => vid !== location);
    if (addUnique(p.cities, location)) {
      p.unplaced.settlements = Math.max(0, p.unplaced.settlements - 1);
      p.unplaced.cities = Math.max(0, p.unplaced.cities - 1);
      return true;
    }
    return false;
  }
  if (p.cities.includes(location)) return false;
  if (addUnique(p.settlements, location)) {
    p.unplaced.settlements = Math.max(0, p.unplaced.settlements - 1);
    return true;
  }
  return false;
}

const cornerCoordsByGame = new WeakMap<GameState, Map<string, { x: number; y: number; z: number }>>();
const edgeCoordsByGame = new WeakMap<GameState, Map<string, { x: number; y: number; z: number }>>();
/** Survives resetGame so occupancy diffs still resolve after a new GameState. */
const cornerCoordsLive = new Map<string, { x: number; y: number; z: number }>();
const edgeCoordsLive = new Map<string, { x: number; y: number; z: number }>();

function coordStore(
  bag: WeakMap<GameState, Map<string, { x: number; y: number; z: number }>>,
  state: GameState,
): Map<string, { x: number; y: number; z: number }> {
  let store = bag.get(state);
  if (!store) {
    store = new Map();
    bag.set(state, store);
  }
  return store;
}

function rememberXyz(
  store: Map<string, { x: number; y: number; z: number }>,
  live: Map<string, { x: number; y: number; z: number }>,
  id: string,
  rec: RecordLike,
): RecordLike {
  const x = numberValue(rec.x ?? rec.q);
  const y = numberValue(rec.y ?? rec.r);
  const z = numberValue(rec.z);
  if (x !== undefined && y !== undefined && z !== undefined) {
    const xyz = { x, y, z };
    store.set(id, xyz);
    live.set(id, xyz);
  }
  const saved = store.get(id) ?? live.get(id);
  if (!saved) return rec;
  return { ...rec, x: rec.x ?? saved.x, y: rec.y ?? saved.y, z: rec.z ?? saved.z };
}

function collectMapPieces(state: GameState, payload: unknown): {
  pieces: Array<{ player: Player; kind: "settlement" | "city" | "road"; location: string }>;
  snapshot: boolean;
} {
  bindPlayersFromPayload(state, payload);
  const map = findMapState(payload) ?? asRecord(payload);
  const pieces: Array<{ player: Player; kind: "settlement" | "city" | "road"; location: string }> = [];
  const cornerRaw = map?.tileCornerStates ?? findKeyed(payload, ["tileCornerStates"]);
  const edgeRaw = map?.tileEdgeStates ?? findKeyed(payload, ["tileEdgeStates"]);
  const corners = mapEntries(cornerRaw);
  const edges = mapEntries(edgeRaw);
  if (!corners.length && !edges.length) return { pieces, snapshot: false };
  const cornerStore = coordStore(cornerCoordsByGame, state);
  const edgeStore = coordStore(edgeCoordsByGame, state);
  if (corners.length >= 40) {
    cornerStore.clear();
    cornerCoordsLive.clear();
  }
  if (edges.length >= 40) {
    edgeStore.clear();
    edgeCoordsLive.clear();
  }
  for (const { id, rec } of corners) {
    const full = rememberXyz(cornerStore, cornerCoordsLive, id, rec);
    const kind = cornerKind(full);
    if (!kind) continue;
    const who = occupantFor(state, full);
    if (!who) continue;
    const location = resolveBoardLocation(state, full, "vertex");
    if (!location) continue;
    pieces.push({ player: who, kind, location });
  }
  for (const { id, rec } of edges) {
    const full = rememberXyz(edgeStore, edgeCoordsLive, id, rec);
    if (!edgeOwned(full)) continue;
    const who = occupantFor(state, full);
    if (!who) continue;
    const location = resolveBoardLocation(state, full, "edge");
    if (!location) continue;
    pieces.push({ player: who, kind: "road", location });
  }
  const snapshot = pieces.length > 0 && (corners.length >= 40 || (corners.length >= 20 && edges.length >= 20));
  return { pieces, snapshot };
}

/**
 * Return the app-state occupancy with its player identity intact. The server
 * uses this separate projection to detect the newest setup settlement; the
 * ordinary occupancy importer is allowed to rebuild arrays in board order.
 */
export function observedMapPieces(
  state: GameState,
  payload: unknown,
): Array<{ player: Player; kind: "settlement" | "city" | "road"; location: string }> {
  return collectMapPieces(state, payload).pieces;
}

/** Rebuild or merge occupancy for every seat from Colonist map corners/edges. */
export function applyOccupancyFromMapState(state: GameState, payload: unknown): number {
  const { pieces, snapshot } = collectMapPieces(state, payload);
  if (snapshot) {
    for (const p of state.players) {
      p.settlements = [];
      p.cities = [];
      p.roads = [];
    }
    for (const piece of pieces) placePiece(piece.player, piece.kind, piece.location);
    for (const p of state.players) {
      p.unplaced.settlements = 0;
      p.unplaced.cities = 0;
      p.unplaced.roads = 0;
    }
    state.needsBoardSync = false;
    syncSetupFromPieces(state);
    return pieces.length;
  }
  if (pieces.length) {
    let placed = 0;
    for (const piece of pieces) {
      if (placePiece(piece.player, piece.kind, piece.location)) placed += 1;
    }
    if (placed) {
      if (state.players.some((p) => p.settlements.some((id) => state.board.vertices[id]))) {
        state.needsBoardSync = false;
      }
      syncSetupFromPieces(state);
    }
    return placed;
  }
  return applyOccupancyFromPayload(state, payload);
}

export function applyOccupancyFromPayload(state: GameState, payload: unknown): number {
  let placed = 0;
  for (const rec of walkPayload(payload)) {
    const kind = occupancyKind(rec);
    if (!kind) continue;
    const road = kind === "road";
    const rawLocation = road
      ? rec.edge ?? rec.road ?? rec.edgeId ?? rec.roadId ?? rec.location ?? rec
      : rec.vertex ?? rec.corner ?? rec.vertexId ?? rec.location ?? rec;
    const location = resolveBoardLocation(state, rawLocation, road ? "edge" : "vertex");
    if (!location) continue;
    const p = occupantFor(state, rec);
    if (!p) continue;
    if (placePiece(p, kind, location)) placed += 1;
  }
  if (placed && state.players.every((p) =>
    p.unplaced.settlements === 0 && p.unplaced.cities === 0 && p.unplaced.roads === 0
  )) {
    state.needsBoardSync = false;
    syncSetupFromPieces(state);
  }
  return placed;
}

function applyBuild(state: GameState, event: LogEvent, payload: unknown, actor: Player): void {
  const buildValue = textValue(firstPayloadValue(payload, ["build", "building", "piece", "type"]));
  const build = (event.build ?? buildValue?.toLowerCase()) as BuildKind | undefined;
  if (build !== "settlement" && build !== "city" && build !== "road") return;

  const setupValue = firstPayloadValue(payload, ["setup", "isSetup"]);
  const setup = event.setup === true || setupValue === true || state.phase === "setup_settle" || state.phase === "setup_road";
  const locationKey = build === "settlement" || build === "city" ? "vertex" : "edge";
  const eventLocation = locationKey === "vertex" ? event.vertex : event.edge;
  const rawLocation = eventLocation ?? firstPayloadValue(payload, [
    locationKey,
    `${locationKey}Id`,
    build === "road" ? "roadId" : "buildingVertexId",
    "location",
    "position",
    "corner",
  ]);
  const location = resolveBoardLocation(state, rawLocation, locationKey);

  if (!setup) payCost(state, actor, build);
  const cap = setup ? 2 : build === "road" ? 15 : build === "city" ? 4 : 5;
  if (build === "settlement" && location) addUnique(actor.settlements, location);
  else if (build === "settlement" && actor.settlements.length + actor.unplaced.settlements < cap) {
    actor.unplaced.settlements += 1;
  }
  if (build === "city" && location) {
    actor.settlements = actor.settlements.filter((value) => value !== location);
    if (!addUnique(actor.cities, location) && actor.unplaced.settlements > 0) {
      actor.unplaced.settlements -= 1;
    }
  }
  if (build === "city" && !location) {
    if (actor.unplaced.settlements > 0) actor.unplaced.settlements -= 1;
    actor.unplaced.cities += 1;
  }
  if (build === "road" && location) addUnique(actor.roads, location);
  else if (build === "road" && actor.roads.length + actor.unplaced.roads < cap) {
    actor.unplaced.roads += 1;
  }

  if (setup && build === "settlement") {
    if (location) state.setupAnchor[actor.id] = location;
    state.current = actor.id;
    state.phase = "setup_road";
    if (!location) state.needsBoardSync = true;
  } else if (setup && build === "road") {
    if (!location) state.needsBoardSync = true;
  } else if (state.phase !== "ended") {
    state.current = actor.id;
    if (state.phase === "setup_road") state.phase = "turn";
  }
  syncSetupFromPieces(state);
  refreshAwards(state);
}

function rollDice(event: LogEvent, payload: unknown): [number, number] | undefined {
  const raw = event.dice ?? firstPayloadValue(payload, ["dice", "roll"]);
  const values = Array.isArray(raw)
    ? raw
    : asRecord(raw)
      ? [
          (raw as RecordLike).a ?? (raw as RecordLike).first ?? (raw as RecordLike).one,
          (raw as RecordLike).b ?? (raw as RecordLike).second ?? (raw as RecordLike).two,
        ]
      : [];
  if (values.length < 2) return undefined;
  const a = numberValue(values[0]);
  const b = numberValue(values[1]);
  return a === undefined || b === undefined ? undefined : [a, b];
}

function applyRoll(state: GameState, event: LogEvent, payload: unknown, actor: Player): void {
  const dice = rollDice(event, payload);
  if (dice) state.dice = dice;
  state.roller = actor.id;
  state.current = actor.id;
  const payloadTotal = numberValue(firstPayloadValue(payload, ["total", "sum"]));
  const total = event.total ?? payloadTotal ?? (dice ? dice[0] + dice[1] : undefined);
  if (total === undefined) return;

  if (total !== 7) {
    state.mustDiscard = {};
    state.phase = "turn";
    return;
  }

  state.mustDiscard = {};
  for (const p of state.players) {
    const count = observedHandSize(p);
    if (count > state.config.discardLimit) state.mustDiscard[p.id] = Math.floor(count / 2);
  }
  const usP = state.players.find((p) => p.id === state.us);
  if (usP && !(state.mustDiscard[usP.id] > 0) && observedHandSize(usP) > state.config.discardLimit) {
    state.mustDiscard[usP.id] = Math.floor(observedHandSize(usP) / 2);
  }
  state.afterRobber = "turn";
  const next =
    (state.mustDiscard[state.us] ?? 0) > 0
      ? usP
      : state.players.find((p) => (state.mustDiscard[p.id] ?? 0) > 0);
  if (next) {
    state.current = next.id;
    state.phase = "discard";
  } else if (usP && observedHandSize(usP) === 0) {
    state.current = usP.id;
    state.phase = "discard";
  } else {
    state.current = actor.id;
    state.phase = "robber";
  }
}

function robberHex(state: GameState, event: LogEvent, payload: unknown): string | undefined {
  const raw = event.hex ?? locationString(firstPayloadValue(payload, ["hex", "hexId", "tile", "tileId", "robberHex"]));
  if (raw && state.board.hexes[raw]) return raw;
  const fromRaw = event.raw.match(/\b(h:-?\d+,-?\d+)\b/i)?.[1];
  return fromRaw && state.board.hexes[fromRaw] ? fromRaw : undefined;
}

function applyRobber(state: GameState, event: LogEvent, payload: unknown, actor: Player): void {
  const hex = robberHex(state, event, payload);
  if (hex) state.robberHex = hex;
  state.current = actor.id;
  if (!hex) return;

  const explicitTarget = targetFor(state, event, payload, false);
  const candidates = explicitTarget
    ? (stealCandidates(state, hex, actor.id).includes(explicitTarget.id) ? [explicitTarget.id] : [])
    : stealCandidates(state, hex, actor.id);
  state.stealFrom = candidates;
  if (candidates.length) {
    state.afterRobber = "turn";
    state.phase = "steal";
  } else {
    state.phase = state.afterRobber;
  }
}

function applyDiscard(state: GameState, event: LogEvent, payload: unknown, actor: Player): void {
  const countValue = firstPayloadValue(payload, ["count", "amount", "quantity"]);
  const count = integerAt(event.count ?? countValue, state.mustDiscard[actor.id] ?? 0);
  const resources = expandedResources(eventResources(event, payload), count || undefined);
  if (count > 0 && resources.length === 0) {
    // A bare "discarded N" log does not reveal which known cards left. Keep
    // the count exact but hide the surviving composition instead of choosing
    // a resource order locally.
    const remaining = Math.max(0, observedHandSize(actor) - count);
    for (const resource of RESOURCES) {
      actor.hand[resource] = 0;
      actor.hidden.known[resource] = 0;
    }
    actor.hidden.unknown = remaining;
    delete state.mustDiscard[actor.id];
    const nextUnknown = state.players.find((p) => (state.mustDiscard[p.id] ?? 0) > 0);
    if (nextUnknown) state.current = nextUnknown.id;
    else {
      state.current = state.roller || actor.id;
      state.phase = "robber";
    }
    return;
  }
  let removed = 0;
  for (const resource of resources) {
    const known = returnKnown(state, actor, resource, 1);
    if (known === 0) removed += removeUnknown(actor, 1);
    else removed += 1;
  }
  const remaining = Math.max(0, count - removed);
  if (remaining) {
    removed += removeUnknown(actor, remaining);
    let fallback = remaining;
    for (const r of RESOURCES) {
      if (fallback <= 0) break;
      const n = returnKnown(state, actor, r, fallback);
      fallback -= n;
      removed += n;
    }
  }
  delete state.mustDiscard[actor.id];
  const next = state.players.find((p) => (state.mustDiscard[p.id] ?? 0) > 0);
  if (next) state.current = next.id;
  else {
    state.current = state.roller || actor.id;
    state.phase = "robber";
  }
}

function applyTrade(state: GameState, event: LogEvent, payload: unknown, actor: Player): void {
  const values = eventResources(event, payload);
  const give = resourceName(event.give) ?? values[0];
  const get = resourceName(event.get) ?? values[1];
  if (!give || !get) return;
  const payloadGiveCount = firstPayloadValue(payload, ["giveCount", "offeredCount", "amountGiven"]);
  const payloadGetCount = firstPayloadValue(payload, ["getCount", "receivedCount", "amountReceived"]);
  const giveCount = integerAt(event.giveCount ?? payloadGiveCount, 1);
  const getCount = integerAt(event.getCount ?? payloadGetCount, 1);
  const other = targetFor(state, event, payload, false);

  if (other && other.id !== actor.id) {
    returnKnown(state, actor, give, giveCount);
    other.hand[give] += giveCount;
    other.hidden.known[give] += giveCount;
    returnKnown(state, other, get, getCount);
    actor.hand[get] += getCount;
    actor.hidden.known[get] += getCount;
    return;
  }

  returnKnown(state, actor, give, giveCount);
  actor.hand[get] += getCount;
  actor.hidden.known[get] += getCount;
  state.bank[get] = Math.max(0, state.bank[get] - getCount);
}

function applySteal(state: GameState, event: LogEvent, payload: unknown, actor: Player): void {
  const victim = targetFor(state, event, payload, true);
  if (!victim || victim.id === actor.id) return;
  if (state.config.friendlyRobber && !isRobbable(state, victim)) {
    state.stealFrom = state.stealFrom.filter((id) => id !== victim.id);
    if (state.phase === "steal" && state.stealFrom.length === 0) state.phase = state.afterRobber;
    return;
  }

  const countValue = firstPayloadValue(payload, ["count", "amount", "quantity"]);
  const resources = expandedResources(eventResources(event, payload), integerAt(event.count ?? countValue, 1));
  if (resources.length) {
    for (const resource of resources) {
      const removed = removeKnown(victim, resource, 1);
      if (removed === 0) removeUnknown(victim, 1);
      actor.hand[resource] += 1;
      actor.hidden.known[resource] += 1;
    }
  } else {
    const count = integerAt(event.count ?? countValue, 1);
    for (let i = 0; i < count; i++) {
      removeOneUnidentifiedCard(victim);
      addUnknown(actor, 1);
    }
  }
  state.stealFrom = [];
  state.current = actor.id;
  state.phase = state.afterRobber === "roll" ? "roll" : "turn";
}

function isRobbable(state: GameState, victim: Player): boolean {
  if (!state.config.friendlyRobber) return true;
  return victim.settlements.length + victim.unplaced.settlements +
    (victim.cities.length + victim.unplaced.cities) * 2 +
    (state.longestRoad === victim.id ? 2 : 0) +
    (state.largestArmy === victim.id ? 2 : 0) >= 3;
}

function applyAward(state: GameState, event: LogEvent, payload: unknown, actor?: Player): void {
  if (!actor) return;
  const text = `${event.raw} ${textValue(firstPayloadValue(payload, ["award", "type"])) ?? ""}`.toLowerCase();
  if (text.includes("longest road")) state.longestRoad = actor.id;
  if (text.includes("largest army")) state.largestArmy = actor.id;
}

function appendLog(state: GameState, event: LogEvent): void {
  if (event.summary && state.log[state.log.length - 1] !== event.summary) state.log.push(event.summary);
}

/**
 * Reconcile one observed Colonist log event into the local advisory state.
 *
 * This deliberately does not call engine actions: a log is an observation,
 * not permission to click a ranked game. Unknown random steals remain unknown
 * instead of being assigned to a guessed resource.
 */
export function applyLogEvent(state: GameState, event: LogEvent, wsPayload?: WsPayload): GameState {
  const payload = wsPayload;
  if (payload) applyOccupancyFromMapState(state, payload);
  const actor = event.kind === "friendly" ? undefined : actorFor(state, event, payload);
  if (event.kind === "win") {
    const winner = actor ?? (event.actor ? findExistingPlayer(state, event.actor) : undefined);
    if (winner) {
      state.winner = winner.id;
      state.phase = "ended";
      state.log.push(`${winner.name} wins`);
    }
    appendLog(state, event);
    return state;
  }

  if (actor) {
    switch (event.kind) {
      case "got": {
        const resources = expandedResources(eventResources(event, payload), integerAt(
          event.count ?? firstPayloadValue(payload, ["count", "amount", "quantity"]),
          1,
        ));
        if (resources.length) for (const r of resources) addKnown(state, actor, r, 1);
        else addUnknown(actor, integerAt(event.count ?? firstPayloadValue(payload, ["count", "amount", "quantity"]), 1));
        if (
          /received starting resources/i.test(event.raw) &&
          actor.settlements.length + actor.unplaced.settlements < 2
        ) {
          const rawLocation = locationString(firstPayloadValue(payload, [
            "vertex",
            "vertexId",
            "buildingVertexId",
            "location",
          ]));
          if (rawLocation && state.board.vertices[rawLocation]) {
            addUnique(actor.settlements, rawLocation);
          } else {
            actor.unplaced.settlements += 1;
            state.needsBoardSync = true;
          }
          syncSetupFromPieces(state);
        }
        break;
      }
      case "built":
        applyBuild(state, event, payload, actor);
        break;
      case "roll":
        applyRoll(state, event, payload, actor);
        break;
      case "robber":
        applyRobber(state, event, payload, actor);
        break;
      case "stole":
        applySteal(state, event, payload, actor);
        break;
      case "discard":
        applyDiscard(state, event, payload, actor);
        break;
      case "trade":
        applyTrade(state, event, payload, actor);
        state.pendingOffer = null;
        break;
      case "offer": {
        const give = resourceName(event.give) ?? eventResources(event, payload)[0];
        const get = resourceName(event.get) ?? eventResources(event, payload)[1];
        if (give && get && actor.id !== state.us) {
          state.pendingOffer = {
            id: event.tradeId ?? tradeIdFromPayload(payload),
            from: actor.id,
            give,
            giveCount: integerAt(event.giveCount, 1),
            get,
            getCount: integerAt(event.getCount, 1),
          };
        }
        break;
      }
      case "award":
        applyAward(state, event, payload, actor);
        break;
      default:
        break;
    }
  }
  if (event.kind === "friendly" && state.phase === "steal" && state.stealFrom.length === 0) {
    state.phase = state.afterRobber;
  }
  appendLog(state, event);
  return state;
}

// Small aliases make the module convenient for callers that call the operation
// "apply" rather than "applyLogEvent" without changing the canonical API.
export const applyEvent = applyLogEvent;
export const applyColonistEvent = applyLogEvent;
export const applyLog = applyLogEvent;
export default applyLogEvent;
