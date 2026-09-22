import { decode } from "@msgpack/msgpack";

export type DecodedFrame = {
  direction: "in" | "out";
  channel: string | null;
  payload: unknown;
  error?: string;
};

export type LiveSeats = {
  players: string[];
  currentUser?: string;
};

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike | null {
  if (value instanceof Map) return Object.fromEntries(value.entries()) as RecordLike;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : null;
}

function key(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function walk(value: unknown): RecordLike[] {
  const out: RecordLike[] = [];
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  while (queue.length) {
    const item = queue.shift();
    if (Array.isArray(item)) {
      queue.push(...item);
      continue;
    }
    const rec = record(item);
    if (!rec || seen.has(rec)) continue;
    seen.add(rec);
    out.push(rec);
    queue.push(...Object.values(rec).filter((v) => record(v) || Array.isArray(v)));
  }
  return out;
}

function asName(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const rec = record(value);
  if (!rec) return undefined;
  for (const field of ["name", "playerName", "username", "userName", "displayName", "nick"]) {
    const found = rec[field];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return undefined;
}

function names(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(names);
  const direct = asName(value);
  if (direct) return [direct];
  const rec = record(value);
  if (!rec) return [];
  const directStrings = Object.values(rec).filter((child): child is string => typeof child === "string" && child.trim());
  if (directStrings.length) return directStrings.map((child) => child.trim());
  return Object.values(rec).flatMap((child) => names(child));
}

/** Extract seat names without assuming a particular Colonist username. */
export function liveSeatsFromPayload(payload: unknown): LiveSeats {
  const playerKeys = new Set([
    "players", "playerlist", "gameplayers", "participants", "seats", "userlist", "playernames",
    "playeruserstates", "playerstates",
  ]);
  const currentKeys = new Set(["currentuser", "currentplayer", "loggedinuser", "you"]);
  const found: string[] = [];
  let currentUser: string | undefined;
  for (const rec of walk(payload)) {
    for (const [rawKey, value] of Object.entries(rec)) {
      const normalized = key(rawKey);
      if (playerKeys.has(normalized)) found.push(...names(value));
      if (!currentUser && currentKeys.has(normalized)) currentUser = asName(value);
    }
  }
  let players = [...new Set(found.filter((name) => name.length <= 80))];
  const userStates = walk(payload).find((rec) =>
    rec.playerUserStates || rec.playerStates,
  );
  const states = userStates?.playerUserStates ?? userStates?.playerStates;
  const orderRaw = walk(payload).find((rec) => rec.playOrder)?.playOrder;
  const playOrder = Array.isArray(orderRaw)
    ? orderRaw.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];
  if (states && typeof states === "object" && playOrder.length >= 2) {
    const byColor = new Map<number, string>();
    const entries = states instanceof Map
      ? [...states.entries()]
      : Array.isArray(states)
        ? states.map((item, i) => [i, item] as [unknown, unknown])
        : Object.entries(states as Record<string, unknown>);
    for (const [id, item] of entries) {
      const rec = record(item);
      if (!rec) continue;
      const name = asName(rec.username ?? rec.playerName ?? rec.name ?? rec.userName ?? rec);
      const color = Number(rec.selectedColor ?? rec.playerColor ?? rec.color ?? rec.colorId ?? id);
      if (name && Number.isFinite(color)) byColor.set(color, name);
    }
    const ordered = playOrder.map((c) => byColor.get(c)).filter((n): n is string => Boolean(n));
    if (ordered.length >= 2) players = [...new Set(ordered)];
  }
  if (currentUser && !players.some((name) => name.toLowerCase() === currentUser!.toLowerCase())) {
    players.push(currentUser);
  }
  return { players, currentUser };
}

export function decodeIncoming(buf: Buffer): DecodedFrame {
  try {
    const msg = decode(buf);
    if (msg && typeof msg === "object" && !Array.isArray(msg)) {
      const rec = msg as Record<string, unknown>;
      return {
        direction: "in",
        channel: typeof rec.id === "string" ? rec.id : null,
        payload: rec.data ?? rec,
      };
    }
    return { direction: "in", channel: null, payload: msg };
  } catch (err) {
    return { direction: "in", channel: null, payload: null, error: String(err) };
  }
}

export function decodeOutgoing(buf: Buffer): DecodedFrame {
  if (buf.length < 3) return { direction: "out", channel: null, payload: null, error: "truncated" };
  const nameLen = buf[2];
  const name = buf.subarray(3, 3 + nameLen).toString("ascii");
  const body = buf.subarray(3 + nameLen);
  try {
    return { direction: "out", channel: name, payload: body.length ? decode(body) : null };
  } catch (err) {
    return { direction: "out", channel: name, payload: null, error: String(err) };
  }
}
