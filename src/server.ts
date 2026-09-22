import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_DEVS, type DevHand, type GameState, type Recommendation, type Resource } from "./types.ts";
import { applyAction, legalActions, newGame, refreshAwards, stealCandidates, syncSetupFromPieces, totalVP, visibleVP } from "./engine/game.ts";
import { opponentThreat, production, winRoute } from "./engine/features.ts";
import { decide, jevStatus, printRec } from "./policy/jev.ts";
import { heuristicScore, roadExpansionScore, roadOpenSettlementTarget } from "./policy/doctrine.ts";
import { decodeIncoming, liveSeatsFromPayload } from "./colonist/ws.ts";
import { parseLogLine } from "./colonist/log.ts";
import { applyLogEvent, applyOccupancyFromMapState, observedMapPieces } from "./colonist/apply.ts";
import {
  applyHarbors,
  buildBoardFromColonistHexes,
  edgeFromColonistEdge,
  edgeFromVertices,
  findMapState,
  harborsFromPayload,
  harborsFromMapState,
  hexesFromMapState,
  vertexFromColonistCorner,
  type ColonistHexIn,
} from "./engine/colonist_board.ts";
import type { Action } from "./types.ts";
import { clickFor, type BoardClick } from "./play/target.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.CATANBOT_PORT ?? 8765);

export type ActionIntent = {
  actionId: string;
  vertex?: string;
  edge?: string;
  hex?: string;
  /** Colonist action state observed immediately before the sender call. */
  appActionState?: number;
  appCompletedTurns?: number;
  sentAt: number;
  attempts: number;
};

type Snapshot = {
  ok: true;
  mode: string;
  live: boolean;
  colonistBoard: boolean;
  hexCount: number;
  startedAt: number;
  game: GameState;
  rec: Recommendation | null;
  recText: string;
  legal: ReturnType<typeof legalActions>;
  youPrompt: "settlement" | "road" | null;
  play: PlayState;
  app: LiveAppView;
  supportedActions: SupportedAction[];
  click: BoardClick | null;
  scores: { id: string; name: string; visible: number; total: number; prod: ReturnType<typeof production> }[];
  routes: ReturnType<typeof winRoute>[];
  jev: ReturnType<typeof jevStatus>;
};

type PlayMode = "recommendation" | "auto-bots" | "paused-bots" | "armed-match";
type PlayOwner = "startup" | "driver" | "user";

type PlayState = {
  on: boolean;
  vsBots: boolean;
  mode: PlayMode;
  owner: PlayOwner;
  /** null means the driver/startup policy still owns the toggle. */
  manualOverride: boolean | null;
  pending: ActionIntent | null;
};

type SupportedAction = {
  type: string;
  menu: string;
  actuation: string;
};

type LiveAppView = {
  connected: boolean;
  actionState: number | null;
  actionLabel: string;
  turnState: number | null;
  turnLabel: string;
  diceThrown: boolean | null;
  completedTurns: number | null;
  currentPlayerColor: number | null;
  lastSeenAt: number | null;
};

const SUPPORTED_ACTIONS: SupportedAction[] = [
  { type: "ROLL", menu: "Dice", actuation: "Colonist sender + visible button fallback" },
  { type: "END_TURN", menu: "Turn", actuation: "Colonist sender + visible button fallback" },
  { type: "BUILD_SETTLEMENT", menu: "Build", actuation: "Authoritative corner index" },
  { type: "BUILD_CITY", menu: "Build", actuation: "Authoritative corner index" },
  { type: "BUILD_ROAD", menu: "Build", actuation: "Authoritative edge index" },
  { type: "BUY_DEV", menu: "Build", actuation: "Colonist sender + visible button fallback" },
  { type: "MARITIME_TRADE", menu: "Trade", actuation: "Colonist sender + visible button fallback" },
  { type: "ACCEPT_TRADE", menu: "Trade response", actuation: "Offer id / response enum" },
  { type: "REJECT_TRADE", menu: "Trade response", actuation: "Offer id / response enum" },
  { type: "DISCARD", menu: "Discard", actuation: "Resource-card selection" },
  { type: "PLAY_KNIGHT", menu: "Development card", actuation: "Card enum + robber follow-up" },
  { type: "PLAY_MONOPOLY", menu: "Development card", actuation: "Card enum + resource follow-up" },
  { type: "PLAY_YEAR_OF_PLENTY", menu: "Development card", actuation: "Card enum + two-resource follow-up" },
  { type: "PLAY_ROAD_BUILDING", menu: "Development card", actuation: "Card enum + two-road follow-up" },
  { type: "MOVE_ROBBER", menu: "Robber", actuation: "Authoritative hex target" },
  { type: "STEAL", menu: "Robber", actuation: "Player color / sender call" },
  { type: "PLACE_SETTLEMENT", menu: "Setup", actuation: "Authoritative corner index + confirm" },
  { type: "PLACE_ROAD", menu: "Setup", actuation: "Authoritative edge index + confirm" },
  { type: "SPECIAL_MENU", menu: "Expansion menus", actuation: "Recognized and surfaced; base-Catan mode pauses safely" },
];

const APP_ACTION_LABELS: Record<number, string> = {
  0: "main action menu",
  1: "initial settlement",
  2: "initial settlement",
  3: "initial road",
  4: "road placement",
  6: "settlement placement",
  7: "city placement",
  24: "move robber",
  25: "move robber",
  26: "move robber",
  27: "choose player to steal",
  28: "discard cards",
  29: "discard cards",
  30: "road building · road 1",
  31: "road building · road 2",
  32: "year of plenty · choose 2 resources",
  33: "monopoly · choose a resource",
  37: "city to pillage · expansion menu",
  42: "road to remove · expansion menu",
  48: "commercial harbor · choose player/resource",
  52: "merchant fleet · choose resource",
  53: "resource monopoly · choose resource",
  54: "commodity monopoly · choose resource",
};

const SPECIAL_ACTION_STATES = new Set([37, 42, 48, 52, 53, 54]);

const TURN_STATE_LABELS: Record<number, string> = {
  1: "before/after dice",
  2: "main turn",
  3: "game over",
};

type AppStatePayload = {
  myColor?: number;
  currentState?: {
    completedTurns?: number;
    turnState?: number;
    actionState?: number;
    currentTurnPlayerColor?: number;
  };
  diceState?: { diceThrown?: boolean; dice1?: number; dice2?: number };
  isGameOver?: boolean;
  robber?: { q?: number; r?: number };
  /** End-screen winner from Colonist's authoritative gameEndData projection. */
  winnerColor?: number | null;
  players?: Array<{
    color?: number;
    username?: string;
    isBot?: boolean;
    cards?: number[];
    /** Colonist mechanicDevelopmentCardsState.players[color].developmentCards.cards. */
    devCards?: number[];
    /** Historical development-card ids from Colonist's authoritative state. */
    devCardsUsed?: number[];
    victoryPointsState?: Record<string, number>;
  }>;
  /** Colonist game-store trade projection; this replaces DOM-only trade prompts. */
  tradeOffers?: Array<{
    id?: string;
    creator?: number;
    offeredResources?: number[];
    wantedResources?: number[];
    playerResponses?: Record<string, number>;
  }>;
  /** Runtime identity for rendered board locations; indices are the sender's API ids. */
  boardLocations?: {
    corners?: Array<{ i?: number; x?: number; y?: number; z?: number }>;
    edges?: Array<{
      i?: number;
      x?: number;
      y?: number;
      z?: number;
      a?: { x?: number; y?: number; z?: number };
      b?: { x?: number; y?: number; z?: number };
    }>;
  };
  mapState?: unknown;
};

const clients = new Set<ServerResponse>();
let game = newGame({ playerCount: 2 }, { seed: 7, us: "red" });
let rec: Recommendation | null = null;
let demoTimer: ReturnType<typeof setInterval> | null = null;
let live = false;
let colonistBoard = false;
let gameId = "";
let livePrompt: { prompt: "settlement" | "road" | null; toMove?: string } = { prompt: null };
let pendingIntent: ActionIntent | null = null;
const seenLogEvents = new Map<string, Set<string>>();
let lastDecisionFingerprint: string | null = null;
let decisionPromise: Promise<Recommendation> | null = null;
let playOn = process.env.CATANBOT_MODE === "play";
let playVsBots = process.env.CATANBOT_MODE === "play";
let manualPlayOverride: boolean | null = null;
let playOwner: PlayOwner = "startup";
let liveAppState: {
  actionState?: number;
  turnState?: number;
  diceThrown?: boolean;
  completedTurns?: number;
  currentPlayerColor?: number;
  lastSeenAt?: number;
} = {};
const startedAt = Date.now();

type LiveAppProjection = typeof liveAppState;

/**
 * The driver posts a small trade-only projection between full app-state
 * frames. Preserve fields that projection does not carry; otherwise a fast
 * trade poll can erase the authoritative turn/action state and make the
 * recommendation diagram disagree with the live Colonist UI.
 */
export function mergeLiveAppState(
  previous: LiveAppProjection,
  body: Pick<AppStatePayload, "currentState" | "diceState">,
): LiveAppProjection {
  return {
    actionState: body.currentState?.actionState ?? previous.actionState,
    turnState: body.currentState?.turnState ?? previous.turnState,
    diceThrown: body.diceState?.diceThrown ?? previous.diceThrown,
    completedTurns: body.currentState?.completedTurns ?? previous.completedTurns,
    currentPlayerColor: body.currentState?.currentTurnPlayerColor ?? previous.currentPlayerColor,
    lastSeenAt: Date.now(),
  };
}

function currentPlayState(): PlayState {
  const mode: PlayMode = playOn && playVsBots
    ? "auto-bots"
    : playOn
      ? "armed-match"
      : playVsBots
        ? "paused-bots"
        : "recommendation";
  return {
    on: playOn,
    vsBots: playVsBots,
    mode,
    owner: playOwner,
    manualOverride: manualPlayOverride,
    pending: pendingIntent,
  };
}

function updatePlay(body: {
  on?: boolean;
  vsBots?: boolean;
  source?: "driver" | "user";
  release?: boolean;
}): void {
  const fromDriver = body.source === "driver";
  if (body.release) manualPlayOverride = null;
  if (!fromDriver) {
    if (typeof body.on === "boolean") {
      playOn = body.on;
      manualPlayOverride = body.on;
    }
    if (typeof body.vsBots === "boolean") playVsBots = body.vsBots;
    if (typeof body.on === "boolean" || typeof body.vsBots === "boolean") playOwner = "user";
  } else if (manualPlayOverride == null) {
    if (typeof body.on === "boolean") playOn = body.on;
    if (typeof body.vsBots === "boolean") playVsBots = body.vsBots;
    playOwner = "driver";
  }
}

function appActionLabel(actionState: number | undefined): string {
  if (actionState == null) return "not observed";
  return APP_ACTION_LABELS[actionState] ?? `Colonist action ${actionState}`;
}

function appView(): LiveAppView {
  return {
    connected: liveAppState.lastSeenAt != null,
    actionState: liveAppState.actionState ?? null,
    actionLabel: appActionLabel(liveAppState.actionState),
    turnState: liveAppState.turnState ?? null,
    turnLabel: liveAppState.turnState == null
      ? "not observed"
      : TURN_STATE_LABELS[liveAppState.turnState] ?? `Colonist turn ${liveAppState.turnState}`,
    diceThrown: liveAppState.diceThrown ?? null,
    completedTurns: liveAppState.completedTurns ?? null,
    currentPlayerColor: liveAppState.currentPlayerColor ?? null,
    lastSeenAt: liveAppState.lastSeenAt ?? null,
  };
}

/**
 * The DOM/log stream is useful for resource and build details, but it can
 * arrive after the app's turn projection and briefly move `game.current`
 * back to the player who produced an older log line.  Once a fresh app-state
 * frame exists, its current player/action menu is authoritative for the
 * action loop. Re-apply that small state machine after log ingestion so a
 * dev-card follow-up cannot be assigned to the wrong player.
 */
function reconcileTurnFromLiveApp(): void {
  if (liveAppState.lastSeenAt == null || Date.now() - liveAppState.lastSeenAt > 2000) return;
  if (liveAppState.currentPlayerColor != null) {
    const current = game.players.find((p) => p.colonistColor === liveAppState.currentPlayerColor);
    if (current) game.current = current.id;
  }
  if (game.winner) {
    game.phase = "ended";
    return;
  }
  const actionState = liveAppState.actionState;
  const turnState = liveAppState.turnState;
  if (actionState == null && turnState == null) return;
  if (actionState === 1 || actionState === 2) game.phase = "setup_settle";
  else if (actionState === 3) game.phase = "setup_road";
  else if (actionState === 28 || actionState === 29) game.phase = "discard";
  else if (actionState === 24 || actionState === 25 || actionState === 26) game.phase = "robber";
  else if (actionState === 27) game.phase = "steal";
  else if (actionState === 30 || actionState === 31) game.phase = "road_building";
  else if (actionState === 32) game.phase = "year_of_plenty";
  else if (actionState === 33) game.phase = "monopoly";
  else if (actionState != null && SPECIAL_ACTION_STATES.has(actionState)) game.phase = "special";
  else if (turnState === 1) game.phase = liveAppState.diceThrown ? "turn" : "roll";
  else if (turnState === 2) game.phase = "turn";
}

function recommendationHasActiveActor(): boolean {
  if (!rec) return false;
  if (rec.action.id === "WAIT_TURN") return game.current !== game.us;
  if (!recommendationMatchesLiveApp()) return false;
  if (rec.action.player === game.current) return true;
  // Colonist can keep currentTurnPlayerColor on the roller while it walks
  // through the other players' seven-discard obligations. The obligation map
  // is authoritative for this one cross-player action and must not be
  // discarded as a stale recommendation.
  return rec.action.type === "DISCARD" && (game.mustDiscard[rec.action.player] ?? 0) > 0;
}

/**
 * A fresh Colonist action state is stronger than a recommendation left over
 * from the previous state machine step. This matters for fire-and-forget
 * senders: the robber, roll, or dev-card call can be accepted before the
 * next app-state POST reaches the bridge, leaving the old click visible for
 * one or two driver polls. Never expose that old click as actionable.
 */
function actionMatchesLiveApp(action: Action | undefined): boolean {
  if (!action || liveAppState.lastSeenAt == null || Date.now() - liveAppState.lastSeenAt > 2000) return true;
  const actionState = liveAppState.actionState;
  const current = liveAppState.currentPlayerColor == null
    ? null
    : game.players.find((p) => p.colonistColor === liveAppState.currentPlayerColor)?.id ?? null;
  const actor = current == null || action.player === current;
  // A paid-road sender has already opened Colonist's board picker. An older
  // decision can finish during that transition, but no trade/end-turn/dev
  // action is valid until the pending edge is confirmed.
  if (actionState === 4) return actor && action.type === "BUILD_ROAD";
  switch (action.type) {
    case "ROLL":
      return actor && actionState === 0 && liveAppState.turnState === 1 && !liveAppState.diceThrown;
    case "END_TURN":
      return actor && actionState === 0 && (liveAppState.turnState === 2 || Boolean(liveAppState.diceThrown));
    case "MOVE_ROBBER":
      return actor && (actionState == null || actionState === 24 || actionState === 25 || actionState === 26);
    case "STEAL":
      return actor && (actionState == null || actionState === 27);
    case "DISCARD":
      return actionState == null || actionState === 28 || actionState === 29;
    case "PLACE_SETTLEMENT":
      return actor && (actionState == null || actionState === 1 || actionState === 2);
    case "PLACE_ROAD":
      return actor && (actionState == null || actionState === 3);
    case "BUILD_SETTLEMENT":
      return actor && (actionState == null || actionState === 0 || actionState === 6);
    case "BUILD_CITY":
      return actor && (actionState == null || actionState === 0 || actionState === 7);
    case "BUILD_ROAD":
      return actor && (actionState == null || actionState === 0 || actionState === 4 || actionState === 30 || actionState === 31);
    case "PLAY_YEAR_OF_PLENTY":
      return actor && (actionState == null || actionState === 0 || actionState === 32);
    case "PLAY_MONOPOLY":
      return actor && (actionState == null || actionState === 0 || actionState === 33);
    case "PLAY_ROAD_BUILDING":
      return actor && (actionState == null || actionState === 0 || actionState === 30 || actionState === 31);
    case "PLAY_KNIGHT":
      return actor && (actionState == null || actionState === 0);
    case "ACCEPT_TRADE":
    case "REJECT_TRADE":
      return Boolean(game.pendingOffer);
    default:
      return true;
  }
}

function recommendationMatchesLiveApp(): boolean {
  return actionMatchesLiveApp(rec?.action);
}

/**
 * Colonist uses actionState 4 after the paid-road sender has opened the board
 * picker. The strategic engine is already back in `turn` at that point, but
 * the browser still needs one legal edge confirmation before it can continue.
 * Surface a scored road immediately instead of allowing END_TURN or a stale
 * recommendation to hide the required board click.
 */
function liveRoadPlacementAction(): Action | null {
  if (liveAppState.actionState !== 4 || liveAppState.lastSeenAt == null) return null;
  const actor = liveAppState.currentPlayerColor == null
    ? game.current
    : game.players.find((p) => p.colonistColor === liveAppState.currentPlayerColor)?.id;
  if (actor !== game.us) return null;
  // Log/websocket frames can briefly move `game.current` back to the player
  // who produced an older event. The live app picker is authoritative here.
  if (game.current !== game.us) game.current = game.us;
  return legalActions(game)
    .filter((action) => action.player === game.us && action.type === "BUILD_ROAD")
    .sort((a, b) => heuristicScore(game, b) - heuristicScore(game, a))[0] ?? null;
}

function forcedLiveRoadRecommendation(action: Action): Recommendation {
  const route = winRoute(game, game.us);
  return {
    action,
    target: action.edge ?? action.type,
    reason: "Colonist is already in paid-road placement; confirm a legal strategic edge before continuing.",
    plan: route.need <= 2
      ? "Convert remaining VP via city/dev/award. Interrupt any opponent win on sight."
      : "City the best wheat/ore, buy devs, contest army, expand only for scarce resources or cuts.",
    opponentThreat: "",
    confidence: 100,
    operation: "BUILD_ROAD",
    operationProbabilities: {},
    targetProbabilities: {},
    latencyMs: 0,
    source: "forced",
  };
}

function reconcileLiveRoadPlacement(): void {
  const action = liveRoadPlacementAction();
  if (!action) return;
  const currentRoadStillLegal = rec?.action.type === "BUILD_ROAD"
    && rec.action.player === game.us
    && legalActions(game).some((candidate) => candidate.id === rec?.action.id);
  if (currentRoadStillLegal) return;
  rec = forcedLiveRoadRecommendation(action);
  lastDecisionFingerprint = decisionFingerprint();
}

function waitingRec(): Recommendation {
  const action: Action = {
    id: "WAIT_BOARD",
    type: "END_TURN",
    player: game.us,
    label: "Waiting for the live Colonist board",
  };
  return {
    action,
    target: "not attached",
    reason:
      "No live Colonist board is attached yet. Open the game tab with the Catanbot extension; its WebSocket or DOM bridge must provide tileHexStates before a board-specific recommendation is possible.",
    plan: "Keep playing. Recs start as soon as this process sees your hexes.",
    opponentThreat: "Unknown until the live board is attached.",
    confidence: 0,
    operation: "END_TURN",
    operationProbabilities: {},
    targetProbabilities: {},
    latencyMs: 0,
    source: "mock",
  };
}

function waitingTurnRec(): Recommendation {
  const current = game.players.find((p) => p.id === game.current);
  const action: Action = {
    id: "WAIT_TURN",
    type: "END_TURN",
    player: game.current,
    label: `Waiting for ${current?.name ?? game.current}`,
  };
  return {
    action,
    target: "WAIT_TURN",
    reason: "The live Colonist turn belongs to another seat; waiting for our actionable menu.",
    plan: "Respond immediately when our turn, discard, robber, or trade state becomes authoritative.",
    opponentThreat: opponentThreat(game, game.us),
    confidence: 100,
    operation: "END_TURN",
    operationProbabilities: {},
    targetProbabilities: {},
    latencyMs: 0,
    source: "forced",
  };
}

function ingestHexes(
  raw: ColonistHexIn[],
  harbors?: Parameters<typeof applyHarbors>[1],
  opts: { authoritative?: boolean } = {},
): number {
  if (demoTimer) {
    clearInterval(demoTimer);
    demoTimer = null;
  }
  const existing = Object.keys(game.board.hexes).length;
  if (!opts.authoritative) {
    if (colonistBoard && harbors?.length) applyHarbors(game.board, harbors);
    live = true;
    return existing;
  }
  const board = buildBoardFromColonistHexes(raw);
  if (harbors?.length) applyHarbors(board, harbors);
  game.board = board;
  for (const p of game.players) {
    p.settlements = p.settlements.filter((id) => board.vertices[id]);
    p.cities = p.cities.filter((id) => board.vertices[id]);
    p.roads = p.roads.filter((id) => board.edges[id]);
  }
  const desert = Object.values(board.hexes).find((h) => h.terrain === "desert");
  game.robberHex = board.hexes[game.robberHex]
    ? game.robberHex
    : desert?.id ?? Object.keys(board.hexes)[0];
  colonistBoard = true;
  live = true;
  return Object.keys(board.hexes).length;
}

export function snapshot(): Snapshot {
  reconcileTurnFromLiveApp();
  if (rec && !game.pendingOffer && !recommendationHasActiveActor()) {
    // A late log can leave an otherwise valid recommendation attached to the
    // previous player for one request. Never expose that stale action to the
    // driver; the next app-state frame will refresh the correct menu.
    if (process.env.CATANBOT_DEBUG_JEV === "1") console.log("rec-cleared-snapshot", rec.action.type, liveAppState.actionState, game.phase, game.current, game.us);
    rec = null;
    lastDecisionFingerprint = null;
  }
  reconcilePendingIntent();
  reconcileLiveRoadPlacement();
  return {
    ok: true,
    mode: process.env.CATANBOT_MODE ?? "recommend",
    live,
    colonistBoard,
    live,
    needsBoardSync: game.needsBoardSync,
    hexCount: Object.keys(game.board.hexes).length,
    startedAt,
    game,
    rec,
    recText: rec ? printRec(rec) : "",
    legal: legalActions(game),
    youPrompt: livePrompt.prompt,
    play: currentPlayState(),
    app: appView(),
    supportedActions: SUPPORTED_ACTIONS,
    click: playOn && playVsBots && rec ? clickFor(game, rec) : null,
    scores: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      visible: visibleVP(game, p.id),
      total: totalVP(game, p.id),
      prod: production(game, p.id),
    })),
    routes: game.players.map((p) => winRoute(game, p.id)),
    jev: jevStatus(),
  };
}

/** Compact snapshot used by the live driver; avoid serializing legalActions and
 * the full board on every 300ms control-loop tick. */
function driverSnapshot() {
  reconcileTurnFromLiveApp();
  if (rec && !game.pendingOffer && !recommendationHasActiveActor()) {
    if (process.env.CATANBOT_DEBUG_JEV === "1") console.log("rec-cleared-driver", rec.action.type, liveAppState.actionState, game.phase, game.current, game.us);
    rec = null;
    lastDecisionFingerprint = null;
  }
  reconcilePendingIntent();
  reconcileLiveRoadPlacement();
  return {
    ok: true,
    rec,
    click: playOn && playVsBots && rec ? clickFor(game, rec) : null,
    game: {
      us: game.us,
      current: game.current,
      phase: game.phase,
      winner: game.winner,
      config: game.config,
      players: game.players.map((p) => ({
        id: p.id,
        name: p.name,
        settlements: p.settlements,
        cities: p.cities,
        roads: p.roads,
      })),
    },
    colonistBoard,
    play: currentPlayState(),
    app: appView(),
  };
}

function broadcast(): void {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(payload);
}

function decisionFingerprint(): string {
  return JSON.stringify({
    colonistBoard,
    config: game.config,
    us: game.us,
    current: game.current,
    phase: game.phase,
    robberHex: game.robberHex,
    dice: game.dice,
    turn: game.turn,
    setupIndex: game.setupIndex,
    setupForward: game.setupForward,
    setupAnchor: game.setupAnchor,
    pendingRoads: game.pendingRoads,
    pendingYop: game.pendingYop,
    pendingOffer: game.pendingOffer,
    longestRoad: game.longestRoad,
    largestArmy: game.largestArmy,
    winner: game.winner,
    board: Object.values(game.board.hexes).map((hex) => [hex.id, hex.terrain, hex.number, hex.vertices]),
    ports: Object.values(game.board.vertices)
      .filter((vertex) => vertex.port)
      .map((vertex) => [vertex.id, vertex.port]),
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      colonistColor: p.colonistColor,
      hand: p.hand,
      hidden: p.hidden,
      devs: p.devs,
      newDevs: p.newDevs,
      knightsPlayed: p.knightsPlayed,
      settlements: p.settlements,
      cities: p.cities,
      roads: p.roads,
      unplaced: p.unplaced,
      playedDevThisTurn: p.playedDevThisTurn,
    })),
  });
}

/**
 * Card/development projections can be hydrated in several app-state frames
 * without changing the turn in which an action is legal. A JEV request often
 * finishes during that hydration window. Keep a smaller context fingerprint
 * for accepting a still-legal answer; full-state changes still trigger a new
 * recommendation on the next refresh.
 */
function decisionContextFingerprint(): string {
  return JSON.stringify({
    us: game.us,
    current: game.current,
    phase: game.phase,
    turn: game.turn,
    dice: game.dice,
    setupIndex: game.setupIndex,
    setupForward: game.setupForward,
    pendingRoads: game.pendingRoads,
    pendingYop: game.pendingYop,
    pendingOffer: game.pendingOffer,
    longestRoad: game.longestRoad,
    largestArmy: game.largestArmy,
    winner: game.winner,
    board: Object.values(game.board.hexes).map((hex) => [hex.id, hex.terrain, hex.number, hex.vertices]),
    pieces: game.players.map((p) => ({ id: p.id, settlements: p.settlements, cities: p.cities, roads: p.roads })),
  });
}

function debugTradeChoice(action: Action): void {
  if (process.env.CATANBOT_DEBUG_TRADE !== "1" ||
    (action.type !== "ACCEPT_TRADE" && action.type !== "REJECT_TRADE") ||
    !game.pendingOffer) return;
  const sender = game.players.find((p) => p.id === game.pendingOffer?.from);
  console.log("trade-choice", JSON.stringify({
    action: action.type,
    offerId: game.pendingOffer.id,
    from: sender?.name,
    fromId: sender?.id,
    fromVisibleVp: sender ? visibleVP(game, sender.id) : null,
    fromTotalVp: sender ? totalVP(game, sender.id) : null,
    fromSettlements: sender?.settlements.length,
    fromCities: sender?.cities.length,
    fromRoads: sender?.roads.length,
    fromKnights: sender?.knightsPlayed,
    offer: game.pendingOffer,
    knownHand: sender?.hand,
    unknownCards: sender?.hidden.unknown,
  }));
}

export async function refreshRec(force = false): Promise<Recommendation> {
  reconcileTurnFromLiveApp();
  reconcilePendingIntent();
  if (rec && !game.pendingOffer && !recommendationHasActiveActor()) {
    if (process.env.CATANBOT_DEBUG_JEV === "1") console.log("rec-stale-app", rec.action.type, liveAppState.actionState);
    rec = null;
    lastDecisionFingerprint = null;
  }
  const fingerprint = decisionFingerprint();
  if (!force && rec && fingerprint === lastDecisionFingerprint) return rec;
  const urgentTrade = Boolean(
    game.pendingOffer &&
    legalActions(game).some((action) => action.type === "ACCEPT_TRADE" || action.type === "REJECT_TRADE"),
  );
  if (urgentTrade) {
    // A trade response is local and time-sensitive. Do not let an older Jev
    // request hold the offer behind a network round.
    try {
      rec = await decide(game);
    } catch {
      rec = waitingRec();
    }
    debugTradeChoice(rec.action);
    lastDecisionFingerprint = decisionFingerprint();
    broadcast();
    return rec;
  }
  if (playOn && playVsBots && game.current !== game.us && (game.mustDiscard[game.us] ?? 0) <= 0) {
    // In bot-match mode the other seats are authoritative but not ours to
    // click. Exposing their forced END_TURN/ROLL recommendations made the HUD
    // look out of sync and caused the driver to churn through stale snapshots
    // while waiting for our next menu.
    rec = waitingTurnRec();
    lastDecisionFingerprint = fingerprint;
    broadcast();
    return rec;
  }
  if (decisionPromise) return decisionPromise;
  decisionPromise = (async () => {
    const contextFingerprint = decisionContextFingerprint();
    const usHasHouse = game.players.find((p) => p.id === game.us)?.settlements.some((id) => game.board.vertices[id]);
    const waitingOnPieces = game.needsBoardSync && game.phase !== "setup_settle" && !(game.phase === "setup_road" && usHasHouse);
    try {
      const nextRec = !live || !colonistBoard
        ? waitingRec()
        : waitingOnPieces
          ? {
              ...waitingRec(),
              reason:
                "The live board is attached, but Colonist has not supplied the corner/edge ids for an observed piece yet. Waiting for the next GameStart/state frame; no guessed road or intersection will be recommended.",
              target: "board piece metadata",
            }
          : await decide(game);
      if (process.env.CATANBOT_DEBUG_DISCARD === "1" && nextRec.action.type === "DISCARD") {
        const holder = game.players.find((p) => p.id === nextRec.action.player);
        const rankedDiscards = legalActions(game)
          .filter((action) => action.type === "DISCARD")
          .sort((a, b) => heuristicScore(game, b) - heuristicScore(game, a))
          .slice(0, 5)
          .map((action) => ({ discard: action.discard, score: heuristicScore(game, action) }));
        console.log("discard-choice", JSON.stringify({
          phase: game.phase,
          current: game.current,
          roller: game.roller,
          player: nextRec.action.player,
          hand: holder?.hand,
          production: holder ? production(game, holder.id) : null,
          discard: nextRec.action.discard,
          top: rankedDiscards,
        }));
      }
      if (process.env.CATANBOT_DEBUG_ROAD === "1" && nextRec.action.type === "BUILD_ROAD") {
        const holder = game.players.find((p) => p.id === nextRec.action.player);
        const target = roadOpenSettlementTarget(game, nextRec.action, 3);
        console.log("road-choice", JSON.stringify({
          phase: game.phase,
          current: game.current,
          player: nextRec.action.player,
          hand: holder?.hand,
          roads: holder?.roads.length,
          edge: nextRec.action.edge,
          score: roadExpansionScore(game, nextRec.action),
          target,
        }));
      }
      debugTradeChoice(nextRec.action);
      const afterFingerprint = decisionFingerprint();
      const afterContextFingerprint = decisionContextFingerprint();
      const contextStable = afterContextFingerprint === contextFingerprint;
      const actionStillLegal = legalActions(game).some((action) => action.id === nextRec.action.id);
      const liveActionStillMatches = actionMatchesLiveApp(nextRec.action);
      const accept = actionStillLegal && (afterFingerprint === fingerprint || contextStable || liveActionStillMatches);
      if (process.env.CATANBOT_DEBUG_JEV === "1") {
        console.log(
          "decision-result",
          nextRec.source,
          nextRec.action.type,
          nextRec.latencyMs,
          accept ? "accepted" : "discarded",
          accept ? "" : JSON.stringify({
            contextStable,
            actionStillLegal,
            liveActionStillMatches,
            current: game.current,
            phase: game.phase,
            turn: game.turn,
            actionId: nextRec.action.id,
            legalTypes: [...new Set(legalActions(game).map((action) => action.type))],
          }),
        );
      }
      if (accept) {
        rec = nextRec;
        lastDecisionFingerprint = afterFingerprint;
      }
    } catch {
      if (process.env.CATANBOT_DEBUG_JEV === "1") console.log("decision-error");
      const afterFingerprint = decisionFingerprint();
      if (afterFingerprint === fingerprint) {
        rec = waitingRec();
        lastDecisionFingerprint = afterFingerprint;
      }
    }
    // If app-state changed while Jev was evaluating, the next request sees a
    // different fingerprint and immediately refreshes the recommendation.
    if (!lastDecisionFingerprint && decisionFingerprint() === fingerprint) lastDecisionFingerprint = fingerprint;
    broadcast();
    return rec;
  })();
  try {
    return await decisionPromise;
  } finally {
    decisionPromise = null;
  }
}

export async function stepDemo(): Promise<void> {
  if (game.phase === "ended") {
    game = newGame(
      { playerCount: 2 },
      { seed: Date.now() % 99991, us: "red" },
    );
  }
  rec = await decide(game);
  const acts = legalActions(game);
  const chosen = acts.find((a) => a.id === rec?.action.id) ?? acts[0];
  if (chosen) applyAction(game, chosen);
  rec = await decide(game);
  lastDecisionFingerprint = decisionFingerprint();
  broadcast();
}

export function resetGame(playerCount = 2, names?: string[], you?: string): void {
  const count = Math.max(2, names?.length ?? playerCount, playVsBots ? 4 : 0);
  const labeled = names?.length ? names.slice(0, count) : undefined;
  game = newGame(
    { playerCount: count },
    { seed: Date.now() % 99991, names: labeled, us: "red" },
  );
  if (you) {
    const named = game.players.find((p) => p.name === you) ?? game.players[0];
    named.name = you;
    game.us = named.id;
  }
  rec = null;
  lastDecisionFingerprint = null;
  colonistBoard = false;
  livePrompt = { prompt: null };
  pendingIntent = null;
  appDevObservations.clear();
  appSetupLocations.clear();
  lastAppActionState = undefined;
  liveAppState = {};
  broadcast();
}

function parsePrompt(raw: unknown): "settlement" | "road" | null {
  const text = String(raw ?? "").toLowerCase();
  if (text.includes("settlement") || text.includes("house")) return "settlement";
  if (text.includes("road")) return "road";
  return null;
}

function intentWasObserved(intent: ActionIntent): boolean {
  const usP = game.players.find((p) => p.id === game.us);
  if (!usP) return false;
  if (intent.vertex) return usP.settlements.includes(intent.vertex) || usP.cities.includes(intent.vertex);
  if (intent.edge) return usP.roads.includes(intent.edge);
  // A robber can already be on the recommended hex, so a hex-only click is
  // deliberately not acknowledged from the projection alone.
  return false;
}

function reconcilePendingIntent(): void {
  if (!pendingIntent) return;
  // A setup click is only valid in its corresponding Colonist action state.
  // If the authoritative state has advanced, never let an unobserved/stale
  // board intent suppress the next action (most visibly, the first roll).
  if (pendingIntent.actionId.startsWith("PLACE_SETTLEMENT:") && game.phase !== "setup_settle") {
    pendingIntent = null;
    return;
  }
  if (pendingIntent.actionId.startsWith("PLACE_ROAD:") && game.phase !== "setup_road") {
    pendingIntent = null;
    return;
  }
  if (intentWasObserved(pendingIntent)) {
    pendingIntent = null;
    return;
  }
  // A robber move changes no occupied vertex/edge. The app-state state
  // machine is the authoritative acknowledgement: once Colonist leaves the
  // robber phase, the selected hex has been accepted.
  if (pendingIntent.hex && pendingIntent.actionId.startsWith("MOVE_ROBBER:") && game.phase !== "robber") {
    pendingIntent = null;
  }
}

function applyColonistLocationIndices(locations: AppStatePayload["boardLocations"]): void {
  if (!locations) return;
  for (const raw of locations.corners ?? []) {
    if (!Number.isInteger(raw.i)) continue;
    const id = vertexFromColonistCorner(game.board, raw);
    if (id && game.board.vertices[id].colonistIndex == null) game.board.vertices[id].colonistIndex = raw.i;
  }
  for (const raw of locations.edges ?? []) {
    if (!Number.isInteger(raw.i)) continue;
    const a = raw.a ? vertexFromColonistCorner(game.board, raw.a) : undefined;
    const b = raw.b ? vertexFromColonistCorner(game.board, raw.b) : undefined;
    // Prefer the runtime endpoint identity. Some HexEdge instances expose
    // endpoints whose shared vertex is represented by the neighboring hex;
    // in that case the raw (x,y,z) identity is still a useful fallback.
    const id = (a && b ? edgeFromVertices(game.board, a, b) : undefined)
      ?? edgeFromColonistEdge(game.board, raw);
    if (id && game.board.edges[id].colonistIndex == null) game.board.edges[id].colonistIndex = raw.i;
  }
}

const COLONIST_RESOURCE: Record<number, keyof GameState["players"][number]["hand"]> = {
  1: "wood",
  2: "brick",
  3: "sheep",
  4: "wheat",
  5: "ore",
};

const COLONIST_DEV: Record<number, keyof DevHand> = {
  11: "knight",
  12: "vp",
  13: "monopoly",
  14: "road_building",
  15: "year_of_plenty",
};

type AppDevObservation = {
  turn: number;
  available: DevHand;
  used: DevHand;
  newCards: DevHand;
  playedThisTurn: boolean;
};

const appDevObservations = new Map<string, AppDevObservation>();
const appSetupLocations = new Map<string, Set<string>>();
let lastAppActionState: number | undefined;

function countColonistDevs(cards: unknown): DevHand | null {
  if (!Array.isArray(cards)) return null;
  const out = EMPTY_DEVS();
  for (const card of cards) {
    const kind = COLONIST_DEV[Number(card)];
    if (kind) out[kind] += 1;
  }
  return out;
}

function positiveDevDiff(next: DevHand, prior: DevHand): DevHand {
  return {
    knight: Math.max(0, next.knight - prior.knight),
    vp: Math.max(0, next.vp - prior.vp),
    monopoly: Math.max(0, next.monopoly - prior.monopoly),
    year_of_plenty: Math.max(0, next.year_of_plenty - prior.year_of_plenty),
    road_building: Math.max(0, next.road_building - prior.road_building),
  };
}

function clampNewDevCounts(available: DevHand, newCards: DevHand): DevHand {
  return {
    knight: Math.min(available.knight, newCards.knight),
    vp: Math.min(available.vp, newCards.vp),
    monopoly: Math.min(available.monopoly, newCards.monopoly),
    year_of_plenty: Math.min(available.year_of_plenty, newCards.year_of_plenty),
    road_building: Math.min(available.road_building, newCards.road_building),
  };
}

function subtractDevCounts(available: DevHand, unavailable: DevHand): DevHand {
  return {
    knight: Math.max(0, available.knight - unavailable.knight),
    vp: Math.max(0, available.vp - unavailable.vp),
    monopoly: Math.max(0, available.monopoly - unavailable.monopoly),
    year_of_plenty: Math.max(0, available.year_of_plenty - unavailable.year_of_plenty),
    road_building: Math.max(0, available.road_building - unavailable.road_building),
  };
}

function appPlayer(state: GameState, raw: { color?: number; username?: string }): GameState["players"][number] | undefined {
  if (raw.color != null) {
    const byColor = state.players.find((p) => p.colonistColor === raw.color);
    if (byColor) return byColor;
  }
  if (raw.username) {
    const byName = state.players.find((p) => p.name.toLowerCase() === raw.username!.toLowerCase());
    if (byName) return byName;
  }
  return undefined;
}

function phaseFromAppState(body: AppStatePayload): GameState["phase"] {
  const turnState = body.currentState?.turnState;
  const actionState = body.currentState?.actionState ?? 0;
  if (body.isGameOver || turnState === 3) return "ended";
  if (actionState === 1 || actionState === 2) return "setup_settle";
  if (actionState === 3) return "setup_road";
  if (actionState === 28 || actionState === 29) return "discard";
  if (actionState === 24 || actionState === 25 || actionState === 26) return "robber";
  if (actionState === 27) return "steal";
  if (actionState === 30 || actionState === 31) return "road_building";
  if (actionState === 32) return "year_of_plenty";
  if (actionState === 33) return "monopoly";
  if (SPECIAL_ACTION_STATES.has(actionState)) return "special";
  if (turnState === 1) return body.diceState?.diceThrown ? "turn" : "roll";
  if (turnState === 2) return "turn";
  return game.phase;
}

/**
 * Import the small authoritative projection exposed by Colonist's live game
 * manager. Websocket map frames establish topology; this projection supplies
 * the state machine the DOM/log stream does not reliably expose.
 */
export function applyAppState(body: AppStatePayload): void {
  const appPlayers = body.players ?? [];
  const appTurn = body.currentState?.completedTurns ?? game.turn;
  liveAppState = mergeLiveAppState(liveAppState, body);
  for (const raw of appPlayers) {
    const p = appPlayer(game, raw);
    if (!p) continue;
    if (raw.color != null) p.colonistColor = raw.color;
    if (raw.username) p.name = raw.username;
    const cards = raw.cards ?? [];
    p.hand.wood = 0;
    p.hand.brick = 0;
    p.hand.sheep = 0;
    p.hand.wheat = 0;
    p.hand.ore = 0;
    p.hidden.known.wood = 0;
    p.hidden.known.brick = 0;
    p.hidden.known.sheep = 0;
    p.hidden.known.wheat = 0;
    p.hidden.known.ore = 0;
    p.hidden.unknown = 0;
    for (const card of cards) {
      const resource = COLONIST_RESOURCE[Number(card)];
      if (resource) {
        p.hand[resource] += 1;
        p.hidden.known[resource] += 1;
      } else {
        p.hidden.unknown += 1;
      }
    }

    // Colonist keeps the exact development-card ids in a separate mechanic
    // state. Import both the playable inventory and the historical used list;
    // cards bought on this turn stay in newDevs until the turn counter moves.
    const available = countColonistDevs(raw.devCards);
    const used = countColonistDevs(raw.devCardsUsed ?? []);
    if (available && used) {
      const prior = appDevObservations.get(p.id);
      const sameTurn = prior?.turn === appTurn;
      const added = sameTurn && prior ? positiveDevDiff(available, prior.available) : EMPTY_DEVS();
      const newCards = clampNewDevCounts(
        available,
        sameTurn && prior
          ? {
              knight: prior.newCards.knight + added.knight,
              vp: prior.newCards.vp + added.vp,
              monopoly: prior.newCards.monopoly + added.monopoly,
              year_of_plenty: prior.newCards.year_of_plenty + added.year_of_plenty,
              road_building: prior.newCards.road_building + added.road_building,
            }
          : EMPTY_DEVS(),
      );
      const usedAdded = sameTurn && prior ? positiveDevDiff(used, prior.used) : EMPTY_DEVS();
      const playedThisTurn = sameTurn && prior
        ? prior.playedThisTurn || Object.values(usedAdded).some((n) => n > 0)
        : false;
      p.devs = subtractDevCounts(available, newCards);
      p.newDevs = newCards;
      p.knightsPlayed = used.knight;
      p.playedDevThisTurn = playedThisTurn;
      appDevObservations.set(p.id, { turn: appTurn, available, used, newCards, playedThisTurn });
    }
  }

  if (body.myColor != null) {
    const us = game.players.find((p) => p.colonistColor === body.myColor);
    if (us) game.us = us.id;
  }
  const currentColor = body.currentState?.currentTurnPlayerColor;
  if (currentColor != null) {
    const current = game.players.find((p) => p.colonistColor === currentColor);
    if (current) game.current = current.id;
  }
  if (body.currentState?.completedTurns != null) {
    game.turn = Math.max(0, Math.floor(body.currentState.completedTurns));
  }
  if (body.winnerColor != null) {
    const winner = game.players.find((p) => p.colonistColor === body.winnerColor);
    if (winner) game.winner = winner.id;
  }

  // Trade prompts are not ordinary buttons in Colonist. The game store has
  // the authoritative offer id, resource arrays, and this player's response
  // state; keep that projection as the only source for ACCEPT/REJECT advice.
  if (body.tradeOffers) {
    game.pendingOffer = null;
    const myColor = body.myColor;
    for (const offer of body.tradeOffers) {
      if (offer.creator == null || myColor == null || offer.creator === myColor) continue;
      const response = offer.playerResponses?.[String(myColor)];
      if (response != null && response !== 0) continue;
      const from = game.players.find((p) => p.colonistColor === offer.creator);
      const offered = (offer.offeredResources ?? [])
        .map((card) => COLONIST_RESOURCE[Number(card)])
        .filter((resource): resource is keyof GameState["players"][number]["hand"] => Boolean(resource));
      const wanted = (offer.wantedResources ?? [])
        .map((card) => COLONIST_RESOURCE[Number(card)])
        .filter((resource): resource is keyof GameState["players"][number]["hand"] => Boolean(resource));
      if (!from || !offered.length || !wanted.length) continue;
      game.pendingOffer = {
        id: offer.id,
        from: from.id,
        give: offered[0],
        giveCount: offered.length,
        get: wanted[0],
        getCount: wanted.length,
      };
      break;
    }
  }

  const dice = body.diceState;
  game.dice = dice?.diceThrown && Number.isFinite(dice.dice1) && Number.isFinite(dice.dice2)
    ? [Number(dice.dice1), Number(dice.dice2)]
    : null;
  game.roller = game.current;

  if (body.mapState) {
    const priorAppSetup = new Map(
      [...appSetupLocations.entries()].map(([id, locations]) => [id, new Set(locations)] as const),
    );
    const priorSettlements = new Map(
      game.players.map((p) => [p.id, new Set(p.settlements)]),
    );
    const tiles = hexesFromMapState(findMapState(body.mapState) ?? body.mapState);
    if (tiles.length) {
      ingestHexes(tiles, harborsFromMapState(findMapState(body.mapState) ?? {}), { authoritative: true });
    }
    const observed = observedMapPieces(game, body.mapState);
    applyOccupancyFromMapState(game, body.mapState);
    applyColonistLocationIndices(body.boardLocations);
    // Colonist's complete tileCornerStates projection is authoritative, but
    // its map iteration order is not chronological. Capture the actual newly
    // appeared settlement before asking the engine for the setup road.
    for (const p of game.players) {
      const prior = priorSettlements.get(p.id) ?? new Set<string>();
      const added = p.settlements.filter((id) => !prior.has(id));
      if (added.length === 1) game.setupAnchor[p.id] = added[0];
    }
    const observedSettlements = new Map<string, Set<string>>();
    for (const piece of observed) {
      if (piece.kind !== "settlement") continue;
      const locations = observedSettlements.get(piece.player.id) ?? new Set<string>();
      locations.add(piece.location);
      observedSettlements.set(piece.player.id, locations);
    }
    for (const p of game.players) {
      const locations = observedSettlements.get(p.id) ?? new Set<string>();
      const prior = priorAppSetup.get(p.id) ?? new Set<string>();
      appSetupLocations.set(p.id, locations);
      // This transition is the only moment at which Colonist identifies the
      // house that owns the immediately-following setup road. Use the app
      // projection's own before/after occupancy, independent of WS ordering.
      if (body.currentState?.actionState === 3 && (lastAppActionState == null || lastAppActionState === 1 || lastAppActionState === 2)) {
        const added = [...locations].filter((id) => !prior.has(id));
        if (added.length === 1) game.setupAnchor[p.id] = added[0];
      }
    }
    syncSetupFromPieces(game);
  }

  if (body.robber && Number.isFinite(body.robber.q) && Number.isFinite(body.robber.r)) {
    const robberHex = `h:${Math.floor(body.robber.q!)},${Math.floor(body.robber.r!)}`;
    if (game.board.hexes[robberHex]) game.robberHex = robberHex;
  }

  const nextPhase = phaseFromAppState(body);
  if (nextPhase === "year_of_plenty" && game.phase !== "year_of_plenty") game.pendingYop = 2;
  if (nextPhase !== "year_of_plenty") game.pendingYop = 0;
  if (nextPhase === "road_building" && game.phase !== "road_building") game.pendingRoads = 2;
  if (nextPhase !== "road_building") game.pendingRoads = 0;
  game.phase = nextPhase;
  lastAppActionState = body.currentState?.actionState;
  game.stealFrom = game.phase === "steal"
    ? stealCandidates(game, game.robberHex, game.current)
    : [];
  if (game.phase === "discard") {
    const obligations: Record<string, number> = {};
    for (const p of game.players) {
      const cards = p.hidden.unknown + Object.values(p.hand).reduce((sum, n) => sum + n, 0);
      if (cards > game.config.discardLimit) obligations[p.id] = Math.floor(cards / 2);
    }
    game.mustDiscard = obligations;
  } else {
    game.mustDiscard = {};
  }
  // Development-card and occupancy projections arrive through the app-state
  // channel rather than the log stream. Recompute awards after importing them
  // so three observed knights or a newly continuous road immediately becomes
  // visible VP and part of the decision model.
  refreshAwards(game);
  const observedActionState = body.currentState?.actionState;
  if (
    pendingIntent &&
    observedActionState != null &&
    pendingIntent.appActionState != null &&
    observedActionState !== pendingIntent.appActionState &&
    /^(?:BUILD_SETTLEMENT|BUILD_CITY|BUILD_ROAD|PLACE_SETTLEMENT|PLACE_ROAD):/.test(pendingIntent.actionId)
  ) {
    // A normal build returns Colonist to actionState 0 without changing the
    // turn. This is the authoritative ack when occupancy projection is late.
    pendingIntent = null;
  }
  game.needsBoardSync = false;
  reconcilePendingIntent();
  reconcileLiveRoadPlacement();
}

/** Record a click as an intent; only observed Colonist state may acknowledge it. */
export function noteActionIntent(body: {
  actionId?: string;
  vertex?: string;
  edge?: string;
  hex?: string;
  appActionState?: number;
  appCompletedTurns?: number;
}): ActionIntent | null {
  if (!body.actionId) return pendingIntent;
  // UI actions (roll, pass, trade, etc.) have no board target that can be
  // proven from occupancy. They are synchronized by the app-state projection
  // instead of becoming an unresolvable pending board intent.
  if (!body.vertex && !body.edge && !body.hex) {
    pendingIntent = null;
    return null;
  }
  const sameTarget = pendingIntent
    && pendingIntent.actionId === body.actionId
    && pendingIntent.vertex === body.vertex
    && pendingIntent.edge === body.edge
    && pendingIntent.hex === body.hex;
  pendingIntent = {
    actionId: body.actionId,
    vertex: body.vertex,
    edge: body.edge,
    hex: body.hex,
    appActionState: Number.isFinite(body.appActionState) ? body.appActionState : undefined,
    appCompletedTurns: Number.isFinite(body.appCompletedTurns) ? body.appCompletedTurns : undefined,
    sentAt: Date.now(),
    attempts: sameTarget ? pendingIntent.attempts + 1 : 1,
  };
  reconcilePendingIntent();
  return pendingIntent;
}

function acceptLogEvent(eventKey: string | undefined, href: string | undefined): boolean {
  if (!eventKey) return true;
  const id = (href ?? "").split("#")[1] || gameId || "unknown";
  let seen = seenLogEvents.get(id);
  if (!seen) {
    seen = new Set();
    seenLogEvents.set(id, seen);
  }
  if (seen.has(eventKey)) return false;
  seen.add(eventKey);
  while (seen.size > 1000) seen.delete(seen.values().next().value!);
  return true;
}

export function applySeats(body: {
  you?: string;
  players?: string[];
  href?: string;
  prompt?: string;
  toMove?: string;
}): void {
  const id = (body.href ?? "").split("#")[1] ?? "";
  const names = [...new Set((body.players ?? []).map((n) => n.trim()).filter(Boolean))];
  if (id && id !== gameId) {
    const hadGameId = Boolean(gameId);
    const saved = colonistBoard ? structuredClone(game.board) : null;
    const robber = game.robberHex;
    gameId = id;
    if (hadGameId) {
      const count = Math.max(names.length || 2, playVsBots ? 4 : 2);
      resetGame(count, names, body.you);
    }
    live = true;
    if (saved) {
      game.board = saved;
      colonistBoard = true;
      if (saved.hexes[robber]) game.robberHex = robber;
    }
  }
  if (names.length >= 2) {
    if (names.length > game.players.length && names.length <= 6) {
      const saved = colonistBoard ? structuredClone(game.board) : null;
      const robber = game.robberHex;
      resetGame(names.length, names, body.you);
      live = true;
      if (saved) {
        game.board = saved;
        colonistBoard = true;
        if (saved.hexes[robber]) game.robberHex = robber;
      }
    }
    names.forEach((name, i) => {
      if (!game.players[i]) return;
      game.players[i].name = name;
    });
  }
  const you = body.you || names.find((n) => /#\d/.test(n));
  if (you) {
    const named = game.players.find((p) => p.name === you) ?? game.players[0];
    named.name = you;
    game.us = named.id;
  }
  if ("prompt" in body) livePrompt.prompt = parsePrompt(body.prompt);
  if ("toMove" in body) livePrompt.toMove = body.toMove || undefined;
  syncSetupFromPieces(game);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function startServer(): Promise<{ port: number; close: () => void }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === "/api/ping" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { href?: string };
        live = true;
        json(res, { ok: true, colonistBoard, live, href: Boolean(body.href) });
        return;
      }
      if (url.pathname === "/api/health") {
        json(res, {
          ok: true,
          uptime: Date.now() - startedAt,
          players: game.players.length,
          phase: game.phase,
          live,
          colonistBoard,
          hexCount: Object.keys(game.board.hexes).length,
          youPrompt: livePrompt.prompt,
          current: game.players.find((p) => p.id === game.current)?.name,
          play: currentPlayState(),
          app: appView(),
          jev: jevStatus(),
        });
        return;
      }
      if (url.pathname === "/api/settings" && req.method === "GET") {
        json(res, {
          ok: true,
          play: currentPlayState(),
          app: appView(),
          supportedActions: SUPPORTED_ACTIONS,
          hud: { defaultVisible: false, shortcut: "Alt+Shift+C" },
        });
        return;
      }
      if (url.pathname === "/api/settings" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          autoMode?: "off" | "recommendation" | "bots";
          on?: boolean;
          vsBots?: boolean;
          release?: boolean;
        };
        if (body.autoMode === "off") updatePlay({ on: false, vsBots: true, source: "user" });
        else if (body.autoMode === "recommendation") updatePlay({ on: false, vsBots: false, source: "user" });
        else if (body.autoMode === "bots") updatePlay({ on: true, vsBots: true, source: "user" });
        else updatePlay({ on: body.on, vsBots: body.vsBots, release: body.release, source: "user" });
        json(res, {
          ok: true,
          play: currentPlayState(),
          app: appView(),
          supportedActions: SUPPORTED_ACTIONS,
        });
        return;
      }
      if (url.pathname === "/api/state") {
        json(res, snapshot());
        return;
      }
      if (url.pathname === "/api/driver-state") {
        json(res, driverSnapshot());
        return;
      }
      if (url.pathname === "/api/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname === "/api/reset" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { players?: number };
        resetGame(body.players ?? 2);
        await refreshRec();
        json(res, snapshot());
        return;
      }
      if (url.pathname === "/api/step" && req.method === "POST") {
        await stepDemo();
        json(res, snapshot());
        return;
      }
      if (url.pathname === "/api/demo" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { on?: boolean };
        if (body.on === false) {
          if (demoTimer) clearInterval(demoTimer);
          demoTimer = null;
        } else if (!demoTimer) {
          demoTimer = setInterval(() => {
            stepDemo().catch((e) => console.error(e));
          }, 900);
        }
        json(res, { ok: true, demo: Boolean(demoTimer) });
        return;
      }
      if (url.pathname === "/api/log" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as {
          text?: string;
          icons?: string[];
          you?: string;
          players?: string[];
          href?: string;
          payload?: unknown;
          wsPayload?: unknown;
          ws?: unknown;
          eventKey?: string;
        };
        if (!live) {
          if (demoTimer) clearInterval(demoTimer);
          demoTimer = null;
          live = true;
          resetGame(playVsBots ? 4 : 2);
        }
        const ev = parseLogLine(body.text ?? "", body.icons ?? []);
        if (body.players?.length || (!gameId && body.href)) applySeats(body);
        if (!acceptLogEvent(body.eventKey, body.href)) {
          await refreshRec();
          json(res, { ok: true, duplicate: true, event: ev, rec, snapshot: snapshot() });
          return;
        }
        if (body.you) {
          const named = game.players.find((p) => p.name === body.you) ?? game.players[0];
          named.name = body.you;
          game.us = named.id;
        }
        const payload = body.wsPayload ?? body.payload ?? body.ws;
        applyLogEvent(game, ev, typeof payload === "string" ? undefined : payload);
        reconcileTurnFromLiveApp();
        await refreshRec();
        json(res, { ok: true, event: ev, rec, snapshot: snapshot() });
        return;
      }
      if (url.pathname === "/api/board" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as {
          tiles?: ColonistHexIn[];
          mapState?: Record<string, unknown>;
          harbors?: Parameters<typeof applyHarbors>[1];
        };
        const tiles = body.tiles?.length
          ? body.tiles
          : body.mapState
            ? hexesFromMapState(body.mapState)
            : [];
        if (!tiles.length) {
          json(res, { ok: false, error: "no tiles" });
          return;
        }
        const harbors = body.mapState ? harborsFromMapState(body.mapState) : body.harbors ?? [];
        const n = ingestHexes(tiles, harbors, { authoritative: Boolean(body.mapState) });
        if (body.mapState) applyOccupancyFromMapState(game, body.mapState);
        await refreshRec();
        json(res, { ok: true, hexCount: n, rec });
        return;
      }
      if (url.pathname === "/api/seats" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          you?: string;
          players?: string[];
          href?: string;
          prompt?: string;
          toMove?: string;
        };
        if (demoTimer) {
          clearInterval(demoTimer);
          demoTimer = null;
        }
        live = true;
        applySeats(body);
        await refreshRec();
        json(res, snapshot());
        return;
      }
      if (url.pathname === "/api/app-state" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as AppStatePayload;
        live = true;
        applyAppState(body);
        // A pending player offer is the one exception to the background
        // refresh rule: the local accept/reject decision is deliberately
        // synchronous so the fast driver path never observes a stale rec.
        if (game.pendingOffer) await refreshRec();
        else void refreshRec().catch(() => {});
        json(res, { ok: true });
        return;
      }
      if (url.pathname === "/api/ws" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as { b64?: string; href?: string };
        const decoded = body.b64 ? decodeIncoming(Buffer.from(body.b64, "base64")) : null;
        let hexCount = 0;
        let seatsChanged = false;
        live = true;
        const frameId = (body.href ?? "").split("#")[1] ?? "";
        if (decoded?.payload) {
          const seats = liveSeatsFromPayload(decoded.payload);
          if (seats.players.length >= 2 || seats.currentUser) {
            applySeats({
              players: seats.players,
              you: seats.currentUser,
              href: body.href,
            });
            seatsChanged = true;
          } else if (frameId && frameId !== gameId) {
            // A hash-only heartbeat marks a new Colonist session. The driver
            // or an authoritative map frame owns initialization; resetting
            // here can erase a board already observed before this frame.
            gameId = frameId;
          }
          const map = findMapState(decoded.payload);
          if (map) {
            const tiles = hexesFromMapState(map);
            if (tiles.length) {
              const harbors = harborsFromPayload(decoded.payload);
              hexCount = ingestHexes(tiles, harbors.length ? harbors : harborsFromMapState(map), {
                authoritative: true,
              });
            }
          }
          if (applyOccupancyFromMapState(game, decoded.payload)) seatsChanged = true;
        }
        if (hexCount || seatsChanged) await refreshRec();
        json(res, { ok: true, decoded: decoded ? { channel: decoded.channel, error: decoded.error } : null, hexCount });
        return;
      }
      if (url.pathname === "/api/decide" && req.method === "POST") {
        await refreshRec();
        json(res, snapshot());
        return;
      }
      if (url.pathname === "/api/play" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          on?: boolean;
          vsBots?: boolean;
          source?: "driver" | "user";
          release?: boolean;
        };
        updatePlay(body);
        json(res, snapshot());
        return;
      }
      if (url.pathname === "/api/played" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          vertex?: string;
          edge?: string;
          hex?: string;
          actionId?: string;
          appActionState?: number;
          appCompletedTurns?: number;
        };
        if (playOn && playVsBots) noteActionIntent(body);
        void refreshRec().catch(() => {});
        json(res, { ok: true, pending: pendingIntent });
        return;
      }

      let path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = join(PUBLIC, path.replace(/\.\./g, ""));
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      console.error(err);
      res.writeHead(500);
      res.end("error");
    }
  });

  return new Promise((resolve) => {
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`catanbot http://127.0.0.1:${PORT}`);
      resolve({
        port: PORT,
        close: () => {
          if (demoTimer) clearInterval(demoTimer);
          server.close();
        },
      });
    });
  });
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export { game, rec };
