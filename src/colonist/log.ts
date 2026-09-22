export type LogEvent = {
  kind:
    | "roll"
    | "got"
    | "built"
    | "stole"
    | "robber"
    | "discard"
    | "trade"
    | "offer"
    | "dev"
    | "award"
    | "friendly"
    | "win"
    | "other";
  actor?: string;
  target?: string;
  resources: string[];
  dice?: [number, number];
  total?: number;
  vp?: number;
  build?: "settlement" | "city" | "road";
  setup?: boolean;
  vertex?: string;
  edge?: string;
  hex?: string;
  give?: string;
  giveCount?: number;
  get?: string;
  getCount?: number;
  tradeId?: string;
  count?: number;
  summary: string;
  raw: string;
};

const BUILD = /(built|placed) a (Settlement|City|Road)/i;
const GOT = /(?:got|received|gained)/i;
const ROLLED = /rolled/i;
const STOLE = /stole/i;
const ROBBER = /moved Robber/i;
const DISCARD = /discarded/i;
const GAVE = /gave .* and got/i;
const WANTS = /wants to give/i;
const FRIENDLY = /Friendly Robber/i;
const DEV = /bought a development|played (a )?Knight|Year of Plenty|Monopoly|Road Building/i;
const AWARD = /Longest Road|Largest Army/i;

function diceFrom(icons: string[]): [number, number] | undefined {
  const d = icons.filter((i) => i.startsWith("dice_")).map((i) => Number(i.slice(5)));
  if (d.length >= 2) return [d[0], d[1]];
  return undefined;
}

function actorFrom(raw: string): string | undefined {
  const match = raw.match(
    /^(.+?)\s+(?:rolled|built|placed|stole|moved|discarded|gave|wants|got|received|gained|bought|played)\b/i,
  );
  return match?.[1]?.trim() || raw.split(/\s+/)[0] || undefined;
}

function resourceName(value: string): string | undefined {
  const lower = value.toLowerCase().replace(/[_-]/g, " ");
  if (/\b(?:lumber|wood)\b/.test(lower)) return "wood";
  if (/\b(?:brick|clay)\b/.test(lower)) return "brick";
  if (/\b(?:wool|sheep)\b/.test(lower)) return "sheep";
  if (/\bwheat\b/.test(lower)) return "wheat";
  if (/\bore\b/.test(lower)) return "ore";
  return undefined;
}

function resourceMentions(raw: string): string[] {
  const out: string[] = [];
  for (const match of raw.matchAll(/\b(?:lumber|wood|brick|clay|wool|sheep|wheat|ore)\b/gi)) {
    const resource = resourceName(match[0]);
    if (resource) out.push(resource);
  }
  return out;
}

export function parseLogLine(text: string, icons: string[] = []): LogEvent {
  const raw = text.trim();
  const actor = actorFrom(raw);
  const resources = icons.filter((i) => resourceName(i));
  if (resources.length === 0) resources.push(...resourceMentions(raw));
  const vpMatch = raw.match(/\+(\d+) VP/);
  const vp = vpMatch ? Number(vpMatch[1]) : undefined;
  const buildMatch = raw.match(BUILD);
  const rollMatch = raw.match(/\brolled(?:\s+(?:a|total|sum)\s+of)?\s+(\d+)\b/i);
  const discardMatch = raw.match(/\bdiscarded\s+(\d+)/i);
  const gotCountMatch = raw.match(/\b(?:got|received|gained)\s+(\d+)\b/i);
  const tradeMatch = raw.match(
    /\bgave\s+(?:(\d+)\s+)?([^\s,]+).*?\band\s+got\s+(?:(\d+)\s+)?([^\s,.]+)/i,
  );
  const stealTarget = raw.match(/\bfrom\s+(.+?)(?:[.!?]|$)/i)?.[1]?.trim();
  const target = stealTarget || raw.match(/\bto\s+(.+?)(?:[.!?]|$)/i)?.[1]?.trim();
  const dice = diceFrom(icons);
  const total = rollMatch ? Number(rollMatch[1]) : dice ? dice[0] + dice[1] : undefined;
  const build = buildMatch
    ? (buildMatch[2].toLowerCase() as "settlement" | "city" | "road")
    : undefined;
  const give = tradeMatch ? resourceName(tradeMatch[2]) : undefined;
  const get = tradeMatch ? resourceName(tradeMatch[4]) : undefined;

  if (FRIENDLY.test(raw)) return { kind: "friendly", resources, summary: raw, raw };
  const won = raw.match(/^(.+?)\s+(?:won the game|has won)\b/i);
  if (won) {
    return { kind: "win", actor: won[1].trim(), resources, summary: raw, raw };
  }
  if (ROLLED.test(raw)) {
    return {
      kind: "roll",
      actor,
      resources,
      dice,
      total,
      summary: raw,
      raw,
    };
  }
  if (BUILD.test(raw)) {
    return {
      kind: "built",
      actor,
      resources,
      build,
      setup: buildMatch?.[1].toLowerCase() === "placed",
      vp,
      summary: raw,
      raw,
    };
  }
  if (STOLE.test(raw)) return { kind: "stole", actor, target, resources, summary: raw, raw };
  if (ROBBER.test(raw)) return { kind: "robber", actor, resources, summary: raw, raw };
  if (DISCARD.test(raw)) {
    return { kind: "discard", actor, resources, count: discardMatch ? Number(discardMatch[1]) : undefined, summary: raw, raw };
  }
  if (GAVE.test(raw)) {
    return {
      kind: "trade",
      actor,
      target,
      resources,
      give,
      giveCount: tradeMatch?.[1] ? Number(tradeMatch[1]) : undefined,
      get,
      getCount: tradeMatch?.[3] ? Number(tradeMatch[3]) : undefined,
      summary: raw,
      raw,
    };
  }
  if (WANTS.test(raw)) {
    const offer =
      raw.match(
        /wants to give\s+(?:(\d+)\s+)?(lumber|wood|brick|clay|wool|sheep|wheat|ore)\s+(?:and\s+get|for)\s+(?:(\d+)\s+)?(lumber|wood|brick|clay|wool|sheep|wheat|ore)/i,
      ) ??
      raw.match(
        /wants to give you\s+(?:(\d+)\s+)?(lumber|wood|brick|clay|wool|sheep|wheat|ore).*?(?:for|get)\s+(?:(\d+)\s+)?(lumber|wood|brick|clay|wool|sheep|wheat|ore)/i,
      );
    return {
      kind: "offer",
      actor,
      resources,
      give: offer ? resourceName(offer[2]) : resources[0],
      giveCount: offer?.[1] ? Number(offer[1]) : 1,
      get: offer ? resourceName(offer[4]) : resources[1],
      getCount: offer?.[3] ? Number(offer[3]) : 1,
      target,
      summary: raw,
      raw,
    };
  }
  if (DEV.test(raw)) return { kind: "dev", actor, resources, summary: raw, raw };
  if (AWARD.test(raw)) return { kind: "award", actor, resources, vp, summary: raw, raw };
  if (GOT.test(raw)) {
    return {
      kind: "got",
      actor,
      resources,
      count: gotCountMatch ? Number(gotCountMatch[1]) : undefined,
      summary: raw,
      raw,
    };
  }
  return { kind: "other", actor, resources, vp, summary: raw || "(empty)", raw };
}
