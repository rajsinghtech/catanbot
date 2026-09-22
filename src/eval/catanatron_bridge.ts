/**
 * JSONL bridge used by tools/catanatron_eval.py.
 *
 * Catanatron owns the rules loop and supplies its legal actions. This module
 * reconstructs the equivalent catanbot GameState, lets the normal policy
 * score it, and returns the index of one of Catanatron's original actions.
 * Keeping the protocol at the process boundary makes the optional GPL
 * simulator dependency unnecessary for the live Colonist package.
 */

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  EMPTY_DEVS,
  EMPTY_HAND,
  PLAYER_COLORS,
  RESOURCES,
  type Action,
  type Board,
  type DevHand,
  type GameState,
  type Hand,
  type Player,
  type PlayerColor,
  type Resource,
  type Terrain,
} from "../types.ts";
import { cloneState, legalActions } from "../engine/game.ts";
import { decide } from "../policy/jev.ts";
import { heuristicScore } from "../policy/doctrine.ts";

type ResourceCounts = Record<Resource, number>;

export type CatanatronPlayerInput = {
  id: string;
  name?: string;
  hand?: Partial<ResourceCounts>;
  hiddenKnown?: Partial<ResourceCounts>;
  hiddenUnknown?: number;
  devs?: Partial<DevHand>;
  newDevs?: Partial<DevHand>;
  knightsPlayed?: number;
  settlements?: string[];
  cities?: string[];
  roads?: string[];
  playedDevThisTurn?: boolean;
};

export type CatanatronBoardInput = {
  hexes: Array<{
    id: string;
    q: number;
    r: number;
    terrain: Terrain;
    number: number | null;
    vertices: string[];
  }>;
  vertices: Array<{
    id: string;
    hexes: string[];
    edges: string[];
    port?: { ratio: 2 | 3; resource?: Resource };
  }>;
  edges: Array<{ id: string; vertices: [string, string] }>;
};

export type CatanatronActionInput = {
  type: string;
  vertex?: string;
  edge?: string;
  hex?: string;
  stealFrom?: string;
  resource?: Resource;
  resources?: Resource[];
  give?: Resource;
  giveCount?: number;
  get?: Resource;
  trade?: {
    from?: string;
    give?: Resource;
    giveCount?: number;
    get?: Resource;
    getCount?: number;
  };
};

export type CatanatronRequest = {
  us: string;
  current: string;
  phase: GameState["phase"];
  turn?: number;
  setupIndex?: number;
  setupForward?: boolean;
  pendingRoads?: number;
  pendingYop?: number;
  afterRobber?: GameState["afterRobber"];
  roller?: string;
  robberHex: string;
  longestRoad?: string | null;
  largestArmy?: string | null;
  bank?: Partial<Hand>;
  deckCount?: number;
  mustDiscard?: Record<string, number>;
  pendingOffer?: {
    id?: string;
    from: string;
    give: Resource;
    giveCount: number;
    get: Resource;
    getCount: number;
  };
  board: CatanatronBoardInput;
  players: CatanatronPlayerInput[];
  actions: CatanatronActionInput[];
  config: {
    playerCount: number;
    victoryPoints: number;
    discardLimit: number;
    friendlyRobber: boolean;
  };
};

function handFrom(input?: Partial<ResourceCounts>): Hand {
  const hand = EMPTY_HAND();
  for (const resource of RESOURCES) hand[resource] = Math.max(0, Number(input?.[resource] ?? 0));
  return hand;
}

function devsFrom(input?: Partial<DevHand>): DevHand {
  const devs = EMPTY_DEVS();
  for (const kind of Object.keys(devs) as Array<keyof DevHand>) {
    devs[kind] = Math.max(0, Number(input?.[kind] ?? 0));
  }
  return devs;
}

function colorFor(id: string, index: number): PlayerColor {
  return (PLAYER_COLORS.includes(id as PlayerColor) ? id : PLAYER_COLORS[index]) as PlayerColor;
}

function boardFrom(input: CatanatronBoardInput): Board {
  const hexes: Board["hexes"] = {};
  for (const hex of input.hexes) {
    hexes[hex.id] = { ...hex, vertices: [...hex.vertices] };
  }
  const vertices: Board["vertices"] = {};
  for (const vertex of input.vertices) {
    vertices[vertex.id] = {
      ...vertex,
      edges: [...vertex.edges],
      hexes: [...vertex.hexes],
      x: 0,
      y: 0,
    };
  }
  const edges: Board["edges"] = {};
  for (const edge of input.edges) {
    edges[edge.id] = { ...edge, vertices: [edge.vertices[0], edge.vertices[1]] };
  }
  return { hexes, vertices, edges };
}

export function stateFromCatanatron(input: CatanatronRequest): GameState {
  const board = boardFrom(input.board);
  const players: Player[] = input.players.map((source, index) => {
    const hand = handFrom(source.hand);
    return {
      id: source.id,
      name: source.name ?? source.id,
      color: colorFor(source.id, index),
      hand,
      hidden: {
        known: handFrom(source.hiddenKnown ?? source.hand),
        unknown: Math.max(0, Number(source.hiddenUnknown ?? 0)),
      },
      devs: devsFrom(source.devs),
      newDevs: devsFrom(source.newDevs),
      knightsPlayed: Math.max(0, Number(source.knightsPlayed ?? 0)),
      settlements: [...(source.settlements ?? [])],
      cities: [...(source.cities ?? [])],
      roads: [...(source.roads ?? [])],
      unplaced: { settlements: 0, cities: 0, roads: 0 },
      playedDevThisTurn: Boolean(source.playedDevThisTurn),
    };
  });

  const bank = handFrom(input.bank);
  const deck = Array.from({ length: Math.max(0, input.deckCount ?? 0) }, () => "knight" as const);
  const mustDiscard: Record<string, number> = {};
  for (const [id, amount] of Object.entries(input.mustDiscard ?? {})) {
    if (amount > 0) mustDiscard[id] = amount;
  }

  return {
    config: {
      playerCount: input.config.playerCount,
      victoryPoints: input.config.victoryPoints,
      discardLimit: input.config.discardLimit,
      friendlyRobber: input.config.friendlyRobber,
    },
    board,
    players,
    us: input.us,
    current: input.current,
    phase: input.phase,
    robberHex: input.robberHex,
    bank,
    deck,
    longestRoad: input.longestRoad ?? null,
    largestArmy: input.largestArmy ?? null,
    setupIndex: input.setupIndex ?? players.findIndex((p) => p.id === input.current),
    setupForward: input.setupForward ?? false,
    setupAnchor: {},
    dice: null,
    turn: input.turn ?? 0,
    mustDiscard,
    stealFrom: [],
    pendingRoads: input.pendingRoads ?? 0,
    pendingYop: input.pendingYop ?? 0,
    pendingOffer: input.pendingOffer ? { ...input.pendingOffer } : null,
    needsBoardSync: false,
    roller: input.roller ?? input.current,
    afterRobber: input.afterRobber ?? "turn",
    winner: null,
    log: [],
  };
}

function findLegal(legal: Action[], predicate: (action: Action) => boolean): Action | null {
  return legal.find(predicate) ?? null;
}

function sameResources(a: Resource[] | undefined, b: Resource[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.slice().sort().every((resource, index) => resource === b.slice().sort()[index]);
}

/** Map one simulator action onto the engine's legal action with the same intent. */
export function mapCatanatronAction(
  state: GameState,
  source: CatanatronActionInput,
  legal = legalActions(state),
): Action | null {
  const type = source.type;
  if (type === "BUILD_SETTLEMENT") {
    const wanted = state.phase === "setup_settle" ? "PLACE_SETTLEMENT" : "BUILD_SETTLEMENT";
    return findLegal(legal, (a) => a.type === wanted && a.vertex === source.vertex);
  }
  if (type === "BUILD_ROAD") {
    const wanted = state.phase === "setup_road" ? "PLACE_ROAD" : "BUILD_ROAD";
    return findLegal(legal, (a) => a.type === wanted && a.edge === source.edge);
  }
  if (type === "BUILD_CITY") return findLegal(legal, (a) => a.type === "BUILD_CITY" && a.vertex === source.vertex);
  if (type === "BUY_DEVELOPMENT_CARD") return findLegal(legal, (a) => a.type === "BUY_DEV");
  if (type === "ROLL") return findLegal(legal, (a) => a.type === "ROLL");
  if (type === "END_TURN") return findLegal(legal, (a) => a.type === "END_TURN");
  if (type === "PLAY_KNIGHT_CARD") return findLegal(legal, (a) => a.type === "PLAY_KNIGHT");
  if (type === "PLAY_ROAD_BUILDING") return findLegal(legal, (a) => a.type === "PLAY_ROAD_BUILDING");
  if (type === "PLAY_MONOPOLY") {
    return findLegal(legal, (a) => a.type === "PLAY_MONOPOLY" && a.resource === source.resource);
  }
  if (type === "PLAY_YEAR_OF_PLENTY") {
    if (state.phase === "year_of_plenty" && source.resources?.length) {
      return findLegal(legal, (a) => a.type === "PLAY_YEAR_OF_PLENTY" && sameResources(a.resources, source.resources));
    }
    return findLegal(legal, (a) => a.type === "PLAY_YEAR_OF_PLENTY");
  }
  if (type === "MOVE_ROBBER") {
    return findLegal(legal, (a) => a.type === "MOVE_ROBBER" && a.hex === source.hex && a.stealFrom === source.stealFrom);
  }
  if (type === "DISCARD_RESOURCE") {
    return findLegal(legal, (a) => a.type === "DISCARD" && Boolean(source.resource && (a.discard?.[source.resource] ?? 0) > 0))
      ?? findLegal(legal, (a) => a.type === "DISCARD");
  }
  if (type === "MARITIME_TRADE") {
    return findLegal(legal, (a) =>
      a.type === "MARITIME_TRADE" &&
      a.give === source.give &&
      a.giveCount === source.giveCount &&
      a.get === source.get,
    );
  }
  if (type === "ACCEPT_TRADE") return findLegal(legal, (a) => a.type === "ACCEPT_TRADE");
  if (type === "REJECT_TRADE") return findLegal(legal, (a) => a.type === "REJECT_TRADE");
  return null;
}

function discardMatches(source: CatanatronActionInput, action: Action): boolean {
  return source.type === "DISCARD_RESOURCE" && action.type === "DISCARD" &&
    Boolean(source.resource && (action.discard?.[source.resource] ?? 0) > 0);
}

function actionMatchesSource(source: CatanatronActionInput, mapped: Action | null, picked: Action): boolean {
  if (!mapped) return false;
  if (discardMatches(source, picked)) return true;
  return mapped.id === picked.id;
}

function chooseYearOfPlenty(
  state: GameState,
  sources: CatanatronActionInput[],
): number | null {
  const options = sources.filter((source) => source.type === "PLAY_YEAR_OF_PLENTY" && source.resources?.length);
  if (!options.length) return null;
  const sim = cloneState(state);
  sim.phase = "year_of_plenty";
  sim.pendingYop = 2;
  let bestIndex: number | null = null;
  let bestScore = -Infinity;
  for (const source of options) {
    const resources = source.resources!;
    const target: Action = {
      id: `YOP:${resources.join(":")}`,
      type: "PLAY_YEAR_OF_PLENTY",
      player: state.current,
      resource: resources[0],
      resources,
      label: `Year of Plenty ${resources.join(" + ")}`,
    };
    let score = -Infinity;
    try {
      score = heuristicScore(sim, target);
    } catch {
      score = 0;
    }
    const index = sources.indexOf(source);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

export async function chooseCatanatronAction(input: CatanatronRequest): Promise<{
  index: number;
  action: CatanatronActionInput;
  recommendation: unknown;
}> {
  const state = stateFromCatanatron(input);
  const legal = legalActions(state);
  const mapped = input.actions.map((source) => mapCatanatronAction(state, source, legal));
  let recommendation: Awaited<ReturnType<typeof decide>> | null = null;
  try {
    if (legal.length) recommendation = await decide(state);
  } catch {
    recommendation = null;
  }

  let index: number | null = null;
  if (recommendation?.action.type === "PLAY_YEAR_OF_PLENTY") {
    index = chooseYearOfPlenty(state, input.actions);
  }
  if (index == null && recommendation) {
    index = input.actions.findIndex((source, i) => actionMatchesSource(source, mapped[i], recommendation!.action));
  }
  if (index == null || index < 0) {
    let bestScore = -Infinity;
    input.actions.forEach((source, i) => {
      const candidate = mapped[i];
      if (!candidate) return;
      let score = 0;
      try {
        score = heuristicScore(state, candidate);
      } catch {
        score = 0;
      }
      if (score > bestScore) {
        bestScore = score;
        index = i;
      }
    });
  }
  if (index == null || index < 0) index = 0;
  const debugScores = process.env.CATANBOT_DEBUG_SCORES === "1"
    ? input.actions.map((source, i) => {
        const candidate = mapped[i];
        return {
          index: i,
          type: source.type,
          value: source.trade ?? (source.type === "MARITIME_TRADE"
            ? { give: source.give, giveCount: source.giveCount, get: source.get }
            : source.vertex ?? source.edge ?? source.resource ?? source.resources ?? null),
          score: candidate ? heuristicScore(state, candidate) : null,
        };
      })
    : undefined;
  return {
    index,
    action: input.actions[index],
    recommendation: recommendation
      ? {
          ...recommendation,
          action: { ...recommendation.action },
          ...(debugScores ? { debugScores } : {}),
        }
      : {
          source: "fallback",
          reason: "No equivalent local action; preserved Catanatron legality.",
          ...(debugScores ? { debugScores } : {}),
        },
  };
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of readline) {
    if (!line.trim()) continue;
    try {
      const input = JSON.parse(line) as CatanatronRequest;
      const result = await chooseCatanatronAction(input);
      process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
}
