import { COSTS, type Action, type GameState, type Recommendation } from "../types.ts";
import { compactState, opponentThreat, winRoute } from "../engine/features.ts";
import { applyAction, cloneState, legalActions, totalVP } from "../engine/game.ts";
import { production } from "../engine/features.ts";
import {
  forcedWin,
  boundedSecureLongestRoadRace,
  canPay,
  heuristicScore,
  longestRoadPlanScore,
  OPERATION_RULES,
  roadExpansionScore,
  roadBuildingHasStrategicProof,
  roadOpenSettlementTarget,
  settlementPairScore,
  settlementRouteAfterRoad,
  settlementRouteAfterTwoRoads,
  settlementRouteAfterThreeRoads,
  settlementRouteAfterFourRoads,
  settlementRouteCanPayAfterRoads,
  settlementRouteHasResourceSupport,
  setupSecondSettlementScore,
  TARGET_RULES,
} from "./doctrine.ts";

const MAX_PER_TYPE = 36;
const DEFAULT_JEV_CALLS_PER_EPOCH = 1;
const DEFAULT_GATEWAY_COOLDOWN_MS = 2200;

type JevEpoch = {
  board: GameState["board"] | null;
  key: string;
  calls: number;
};

// A live Colonist state can emit several app-state frames while one turn is
// settling. One Jev evaluation is enough to choose the strategic operation;
// subsequent same-epoch follow-ups use the bounded local doctrine. This keeps
// the direct Gateway path fast and prevents the free upstream model from being
// hammered by duplicate frames.
let jevEpoch: JevEpoch = { board: null, key: "", calls: 0 };
let gatewayCooldownUntil = 0;
let gatewayCooldownMs = DEFAULT_GATEWAY_COOLDOWN_MS;
let lastGatewayErrorAt = 0;
const stats = {
  gatewayAttempts: 0,
  gatewaySuccesses: 0,
  gatewayRateLimits: 0,
  gatewayErrors: 0,
};

export function jevStatus() {
  return {
    ...stats,
    gatewayCooldownMs: Math.max(0, gatewayCooldownUntil - Date.now()),
    callsPerEpoch: Math.max(1, Number(process.env.JEV_CALLS_PER_EPOCH ?? DEFAULT_JEV_CALLS_PER_EPOCH)),
  };
}

function jevEpochKey(state: GameState): string {
  return JSON.stringify([
    state.current,
    state.turn,
    state.phase,
    state.setupIndex,
    state.setupForward,
    state.pendingRoads,
    state.pendingYop,
    state.afterRobber,
  ]);
}

function canSpendJev(state: GameState): boolean {
  if (state.board !== jevEpoch.board) {
    jevEpoch = { board: state.board, key: "", calls: 0 };
  }
  const key = jevEpochKey(state);
  if (key !== jevEpoch.key) {
    jevEpoch.key = key;
    jevEpoch.calls = 0;
  }
  const budget = Math.max(1, Number(process.env.JEV_CALLS_PER_EPOCH ?? DEFAULT_JEV_CALLS_PER_EPOCH));
  if (jevEpoch.calls >= budget) return false;
  jevEpoch.calls += 1;
  return true;
}

function gatewayCoolingDown(): boolean {
  return Date.now() < gatewayCooldownUntil;
}

function setupProduction(state: GameState, action: Action, resource: keyof ReturnType<typeof production>): number {
  if (state.phase !== "setup_settle" || action.type !== "PLACE_SETTLEMENT" || !action.vertex) return 0;
  try {
    const after = cloneState(state);
    applyAction(after, action, () => 0.5);
    return production(after, action.player)[resource];
  } catch {
    return 0;
  }
}

function setupWheatProduction(state: GameState, action: Action): number {
  return setupProduction(state, action, "wheat");
}

function setupDoctrinePick(state: GameState, actions: Action[]): Action | null {
  if (state.phase !== "setup_settle") return null;
  const settlements = actions.filter((action) => action.type === "PLACE_SETTLEMENT" && action.vertex);
  if (!settlements.length) return null;
  const me = state.players.find((player) => player.id === state.current);
  if (!me) return null;
  let viable = settlements;
  const before = production(state, state.current);
  const expansion = ["wood", "brick"] as const;
  const firstExpansion = settlements.filter((action) => expansion.some((resource) => setupProduction(state, action, resource) > 0));
  if (me.settlements.length === 0 && firstExpansion.length) {
    // A high-pip wheat/ore corner with no road resource is not a viable
    // opening when the board still offers wood or brick. Keep JEV inside the
    // resource-complete opening set instead of trying to repair this with
    // several player trades later.
    viable = firstExpansion;
  } else if (me.settlements.length > 0) {
    // On the reverse-order pick, cover the full settlement cost shape. The
    // old guard only looked for wood/brick, which allowed an ore-rich corner
    // with no sheep to win on pips even though it could not expand.
    const missingExpansion = (["wood", "brick", "sheep", "wheat"] as const)
      .filter((resource) => before[resource] <= 0);
    const complement = settlements.filter((action) => missingExpansion.some((resource) => setupProduction(state, action, resource) > 0));
    if (missingExpansion.length && complement.length) viable = complement;
  }
  return viable
    .map((action) => ({
      action,
      score: me.settlements.length === 0
        ? settlementPairScore(state, action)
        : setupSecondSettlementScore(state, state.current, action.vertex!),
    }))
    .sort((a, b) => b.score - a.score || heuristicScore(state, b.action) - heuristicScore(state, a.action))[0].action;
}

function noteGatewaySuccess(): void {
  gatewayCooldownUntil = 0;
  gatewayCooldownMs = DEFAULT_GATEWAY_COOLDOWN_MS;
  stats.gatewaySuccesses += 1;
}

function noteGatewayRateLimit(res: Response): void {
  stats.gatewayRateLimits += 1;
  const retryAfter = Number(res.headers.get("retry-after"));
  const serverDelay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
  const delay = Math.max(gatewayCooldownMs, serverDelay);
  gatewayCooldownUntil = Date.now() + Math.min(15000, delay);
  gatewayCooldownMs = Math.min(15000, Math.max(DEFAULT_GATEWAY_COOLDOWN_MS, gatewayCooldownMs * 2));
}

function logGatewayFailure(backend: JevBackend, error: unknown): void {
  const now = Date.now();
  if (now - lastGatewayErrorAt < 3000) return;
  lastGatewayErrorAt = now;
  console.error(`${backend.kind} Jev failed, using mock`, error);
}

type JevBackend = {
  kind: "gateway" | "proxy";
  endpoint: string;
  apiKey?: string;
  model: string;
};

type ChoiceAnswer = {
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
};

function jevBackend(): JevBackend | null {
  if (process.env.JEV_OFFLINE === "1") return null;
  const gatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (gatewayKey) {
    return {
      kind: "gateway",
      endpoint: process.env.JEV_GATEWAY_ENDPOINT?.trim() || "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
      apiKey: gatewayKey,
      model: process.env.JEV_MODEL?.trim() || "typesafe-ai/jev",
    };
  }

  // The execution environment exposes an authenticated OpenAI-compatible
  // proxy, but not necessarily a Vercel AI Gateway key. Opt into that
  // endpoint explicitly for live play so unit tests and recommendation-only
  // commands never make an accidental network call.
  const proxyEnabled = process.env.JEV_PROVIDER === "openai" || process.env.JEV_PROXY_ENABLED === "1";
  const proxyKey = process.env.OPENAI_API_KEY?.trim();
  const base = (process.env.OPENAI_BASE_URL?.trim() || "http://ai/v1").replace(/\/$/, "");
  // The development web proxy is intentionally keyless. Only permit that
  // exception for the exact internal hostname; every other OpenAI-compatible
  // endpoint still requires an explicit API key.
  const keylessInternalProxy = base === "http://ai/v1";
  if (!proxyEnabled || (!proxyKey && !keylessInternalProxy)) return null;
  return {
    kind: "proxy",
    endpoint: `${base}/chat/completions`,
    apiKey: proxyKey || undefined,
    model: process.env.JEV_PROXY_MODEL?.trim() || "google/gemini-3.1-flash-lite",
  };
}

export async function decide(state: GameState): Promise<Recommendation> {
  const started = Date.now();
  const legal = legalActions(state);
  if (legal.length === 0) {
    throw new Error("no legal actions");
  }
  const backend = jevBackend();

  const ranked = legal
    .map((a) => ({ a, s: heuristicScore(state, a) }))
    .sort((x, y) => y.s - x.s);

  // Trade responses are time-sensitive and deterministic once the
  // authoritative offer/card projection is present. Do not put them behind
  // a network Jev round; a stale pending offer is more damaging than the
  // small benefit of another deliberation pass. The same heuristic still
  // decides accept versus reject.
  if (state.pendingOffer) {
    const trade = ranked.find((entry) => entry.a.type === "ACCEPT_TRADE" || entry.a.type === "REJECT_TRADE");
    if (trade) {
      return format(
        state,
        trade.a,
        "mock",
        0.9,
        {},
        {},
        Date.now() - started,
        "Immediate authoritative trade response; keep the offer state from going stale.",
      );
    }
  }

  // Do not spend a network round deciding a state with exactly one legal
  // action. This is common for roll/end-turn transitions and is pure latency
  // with no decision quality benefit; JEV remains the chooser whenever there
  // is an actual operation or target tradeoff.
  if (legal.length === 1) {
    return format(
      state,
      legal[0],
      "forced",
      1,
      {},
      {},
      Date.now() - started,
      `Only legal action: ${legal[0].label}.`,
    );
  }

  const byType = new Map<string, Action[]>();
  for (const { a } of ranked) {
    const list = byType.get(a.type) ?? [];
    if (list.length < MAX_PER_TYPE) list.push(a);
    byType.set(a.type, list);
  }

  const candidates = [...byType.values()].flat();
  const mockBest = ranked[0].a;
  const setupBest = setupDoctrinePick(state, legal);
  const bestDirectBuild = ranked.find((entry) => entry.a.type === "BUILD_SETTLEMENT" || entry.a.type === "BUILD_CITY");
  const bestBuildOrNonRoad = bestDirectBuild ?? ranked.find((entry) => entry.a.type !== "BUILD_ROAD" && entry.a.type !== "PLACE_ROAD");
  let guardedMockBest =
    mockBest.type === "BUILD_ROAD" && bestDirectBuild && bestDirectBuild.s + 12 >= heuristicScore(state, mockBest)
      ? bestDirectBuild.a
      : mockBest;

  // Setup settlement choice is a high-leverage opening constraint, not a
  // normal target-ranking question. JEV still evaluates the operation and
  // supplies the strategic framework, but its target cannot discard the
  // pair/coverage model and select a pretty high-pip corner that strands the
  // next two builds. This is the concrete guardrail for the bad live games
  // where the second house repeated wheat and skipped sheep/ore coverage.
  if (setupBest) guardedMockBest = setupBest;

  if (guardedMockBest.type === "BUILD_ROAD" && bestBuildOrNonRoad && !roadHasStrategicProof(state, guardedMockBest)) {
    // A rejected road must fall back to a real build before passive END_TURN.
    // The previous fallback selected the highest-scoring non-road action;
    // after the road guard penalized a speculative frontier that was often
    // END_TURN, so a payable city was silently skipped instead of restored.
    guardedMockBest = bestBuildOrNonRoad.a;
  }

  if (guardedMockBest.type === "PLAY_ROAD_BUILDING" && bestBuildOrNonRoad && !roadBuildingHasStrategicProof(state, state.us)) {
    // Do not let the remote evaluator spend two free roads on a merely
    // attractive branch.  The card must already have a legal house route or
    // a secure Longest Road conversion in the local authoritative state.
    guardedMockBest = bestBuildOrNonRoad.a;
  }

  // Once we are within two VP of the target, a legal city/settlement is the
  // fastest reliable win progress. Do not let a road, dev purchase, or end
  // turn consume that tempo; forcedWin still handles the exact final point.
  if (bestDirectBuild && winRoute(state, state.us).need <= 2 && !isDirectVpBuild(guardedMockBest)) {
    guardedMockBest = bestDirectBuild.a;
  }

  // A second setup settlement with no wheat can produce impressive pips and
  // still strand the opening: no city, dev card, or reliable settlement
  // conversion is available. If the board has any legal wheat corner, keep
  // both the local fallback and Jev's target inside that viable opening set.
  if (state.phase === "setup_settle" && playerHasOpeningSettlement(state)) {
    const setup = byType.get("PLACE_SETTLEMENT") ?? [];
    const wheat = setup.filter((action) => setupWheatProduction(state, action) > 0);
    if (wheat.length && setupWheatProduction(state, guardedMockBest) <= 0) {
      guardedMockBest = wheat
        .slice()
        .sort((a, b) => heuristicScore(state, b) - heuristicScore(state, a))[0];
    }
  }

  const win = forcedWin(state);
  if (win) {
    return format(state, win, "forced", 0.99, {}, {}, Date.now() - started, "Forced win or award swing.");
  }

  if (!backend || (backend.kind === "gateway" && gatewayCoolingDown()) || !canSpendJev(state)) {
    return format(state, guardedMockBest, "mock", 0.55, {}, {}, Date.now() - started, mockReason(state, guardedMockBest));
  }

  try {
    const answers = await evaluateJev(state, byType, candidates, backend);
    const op = answers.operation?.choice ?? mockBest.type;
    const pool = byType.get(op) ?? candidates;
    const targetKey = `${op.toLowerCase()}_target`;
    const targetChoice = answers[targetKey]?.choice;
    const modelPicked =
      pool.find((a) => a.id === targetChoice) ??
      pool.find((a) => a.type === op) ??
      guardedMockBest;
    const directBuild = ranked.find((entry) => entry.a.type === "BUILD_SETTLEMENT" || entry.a.type === "BUILD_CITY");
    // Jev still chooses the operation, but an immediate house/city must not
    // lose to a merely attractive road frontier. Keep a road only when its
    // engine score is materially better (award/win/cut territory).
    let picked =
      modelPicked.type === "BUILD_ROAD" && directBuild && directBuild.s + 12 >= heuristicScore(state, modelPicked)
        ? directBuild.a
        : modelPicked;
    if (directBuild && winRoute(state, state.us).need <= 2 && !isDirectVpBuild(picked)) {
      picked = directBuild.a;
    }
    if (picked.type === "BUILD_ROAD" && bestBuildOrNonRoad && !roadHasStrategicProof(state, picked)) {
      picked = bestBuildOrNonRoad.a;
    }
    if (picked.type === "PLAY_ROAD_BUILDING" && bestBuildOrNonRoad && !roadBuildingHasStrategicProof(state, state.us)) {
      picked = bestBuildOrNonRoad.a;
    }
    if (state.phase === "setup_settle" && playerHasOpeningSettlement(state) && picked.type === "PLACE_SETTLEMENT") {
      const wheat = (byType.get("PLACE_SETTLEMENT") ?? []).filter((action) => setupWheatProduction(state, action) > 0);
      if (wheat.length && setupWheatProduction(state, picked) <= 0) {
        picked = wheat
          .slice()
          .sort((a, b) => heuristicScore(state, b) - heuristicScore(state, a))[0];
      }
    }
    if (setupBest) picked = setupBest;
    // JEV is the strategic evaluator, but a remote operation choice must not
    // throw away a materially stronger legal VP/build route. Keep the model's
    // choice when it is a close call; fall back to the doctrine when the
    // selected action is clearly dominated (the live failure mode was passing
    // or buying a low-tempo card while an immediate city/settlement existed).
    if (heuristicScore(state, picked) + 18 < heuristicScore(state, guardedMockBest)) {
      picked = guardedMockBest;
    }
    const conf = answers.operation?.confidence ?? answers.operation?.probabilities?.[op] ?? 0.6;
    return format(
      state,
      picked,
      "jev",
      Math.round((conf as number) * 100) / 100,
      answers.operation?.probabilities ?? {},
      answers[targetKey]?.probabilities ?? {},
      Date.now() - started,
      `${backend.kind === "gateway" ? "JEV" : "JEV-compatible evaluator"} selected the operation; ${mockReason(state, picked)}`,
    );
  } catch (err) {
    logGatewayFailure(backend, err);
    return format(state, guardedMockBest, "mock", 0.4, {}, {}, Date.now() - started, mockReason(state, guardedMockBest));
  }
}

function playerHasOpeningSettlement(state: GameState): boolean {
  return (state.players.find((p) => p.id === state.current)?.settlements.length ?? 0) > 0;
}

function isDirectVpBuild(action: Action): boolean {
  return action.type === "BUILD_SETTLEMENT" || action.type === "BUILD_CITY";
}

function canPaySettlementAfterRoad(state: GameState, action: Action): boolean {
  return settlementGapAfterRoad(state, action) === 0;
}

function settlementGapAfterRoad(state: GameState, action: Action): number {
  const me = state.players.find((player) => player.id === action.player);
  if (!me) return Number.POSITIVE_INFINITY;
  const hand = { ...me.hand };
  if (state.phase !== "road_building") {
    hand.wood -= COSTS.road.wood;
    hand.brick -= COSTS.road.brick;
  }
  return (Object.keys(COSTS.settlement) as Array<keyof typeof COSTS.settlement>)
    .reduce((missing, resource) => missing + Math.max(0, COSTS.settlement[resource] - hand[resource]), 0);
}

function roadHasStrategicProof(state: GameState, action: Action): boolean {
  if (action.type !== "BUILD_ROAD" || state.phase === "road_building") return true;
  const plan = longestRoadPlanScore(state, action);
  if ((plan.claimNow && plan.secureNow) || plan.defendNow) return true;
  if (boundedSecureLongestRoadRace(state, action, plan)) {
    // A bounded, secure race is a valid investment even when the next house
    // is not payable yet. This is intentionally narrower than `claimSoon`:
    // the current holder must already be at four roads, the route must reach
    // the award within three total edges, and no direct VP conversion may be
    // sacrificed for it.
    return true;
  }
  const me = state.players.find((player) => player.id === action.player);
  const buildingCount = (me?.settlements.length ?? 0) + (me?.cities.length ?? 0);
  const roadCount = me?.roads.length ?? 0;
  const gap = settlementGapAfterRoad(state, action);
  const cityPayableNow = Boolean(me && canPay(me.hand, COSTS.city));
  const expansionPhase = buildingCount === 2 || (
    (me?.settlements.length ?? 0) >= 2 &&
    (me?.settlements.length ?? 0) < 5
  );
  const openTarget = roadOpenSettlementTarget(state, action, 3);
  const expansionCardsCanReplenish = Boolean(me && (me.hand.wood >= 2 || me.hand.brick >= 2));
  const quickRoadScore = roadExpansionScore(state, action);
  const openTargetApproach = expansionPhase &&
    roadCount < 5 &&
    openTarget.value >= 45 &&
    openTarget.depth <= 2 &&
    quickRoadScore >= 18 &&
    (!openTarget.contested || openTarget.depth === 0 || quickRoadScore >= 45) &&
    !cityPayableNow &&
    gap <= 4 &&
    expansionCardsCanReplenish;
  if (openTargetApproach) {
    // A candidate can be the right first edge even when the next road cards
    // are not in hand yet. Require a bounded open house, a replenishable
    // wood/brick lane, and no immediately payable city. This is deliberately
    // topology-based so an opponent settlement remains a hard stop rather
    // than becoming a fake Longest Road invitation.
    return true;
  }

  // Only run the deeper route forecasts after the cheap, board-aware open
  // target check above. These searches are useful for a committed route, but
  // doing all of them for every legal road was the main live latency spike.
  const oneRoadRoute = settlementRouteAfterRoad(state, action);
  const twoRoadRoute = settlementRouteAfterTwoRoads(state, action);
  const threeRoadRoute = settlementRouteAfterThreeRoads(state, action);
  const fourRoadRoute = roadCount >= 3 && threeRoadRoute < 70
    ? settlementRouteAfterFourRoads(state, action)
    : 0;
  const oneRoadPayable = settlementRouteCanPayAfterRoads(state, action, 1);
  const twoRoadPayable = settlementRouteCanPayAfterRoads(state, action, 2);
  const threeRoadPayable = settlementRouteCanPayAfterRoads(state, action, 3);
  const fourRoadPayable = roadCount >= 3 && threeRoadRoute < 70
    ? settlementRouteCanPayAfterRoads(state, action, 4)
    : false;
  const oneRoadSupported = settlementRouteHasResourceSupport(state, action, 1);
  const twoRoadSupported = settlementRouteHasResourceSupport(state, action, 2);
  const anchorExpansion = (me?.settlements.length ?? 0) === 1 &&
    (me?.cities.length ?? 0) >= 1 &&
    totalVP(state, action.player) < state.config.victoryPoints - 1 &&
    (oneRoadRoute > 0 || twoRoadRoute >= 70 || threeRoadRoute >= 70 || fourRoadRoute >= 70) &&
    gap <= 3 &&
    roadExpansionScore(state, action) >= 28 &&
    (!cityPayableNow || oneRoadPayable);
  const anchorFrontier = (me?.settlements.length ?? 0) === 1 &&
    (me?.cities.length ?? 0) >= 1 &&
    totalVP(state, action.player) < state.config.victoryPoints - 1 &&
    roadCount < 9 &&
    (oneRoadRoute > 0 || twoRoadRoute >= 70 || threeRoadRoute >= 70) &&
    roadExpansionScore(state, action) >= 24 &&
    (!cityPayableNow || oneRoadPayable);
  if (expansionPhase && settlementRouteAfterRoad(state, action) > 0 && canPaySettlementAfterRoad(state, action) && oneRoadPayable) {
    return true;
  }
  if (expansionPhase && roadCount < 5 && twoRoadRoute >= 70 && gap <= 2 && twoRoadPayable) {
    // Keep a real two-edge approach alive after the opening network. The
    // first edge need not expose the house yet, but it must lead to a good
    // second edge and leave at most two settlement cards missing.
    return true;
  }
  if (expansionPhase && roadCount < 2 &&
    (oneRoadRoute > 0 || twoRoadRoute >= 70) && gap <= 3 &&
    (oneRoadSupported || twoRoadSupported)) {
    // Resource support can justify the opening approach, before the network
    // has committed to a side of the board. Once two roads are down, the
    // opponent gets intervening turns and this same heuristic becomes a
    // license to chase an unsecured route with the last wood/brick pair.
    return true;
  }
  if (expansionPhase && roadCount < 6 && threeRoadRoute >= 70 && gap <= 3 && threeRoadPayable) {
    // A blocked or contested corner can need a third paid edge. This is still
    // a concrete settlement route, not a generic Longest Road invitation:
    // every edge in the bounded forecast is currently legal and payable.
    return true;
  }
  if (expansionPhase && roadCount < 7 && fourRoadRoute >= 70 && gap <= 4 && fourRoadPayable) {
    // A long contested approach is still valid when all four paid edges are
    // presently affordable and the route forecast reaches a real house.
    return true;
  }
  // When the expansion network has no immediately reachable house, only keep
  // a first approach edge if the bounded forecast already reaches a concrete
  // settlement route. A raw frontier score is not enough: the previous
  // exception let a two-road player spend the last wood/brick on an attractive
  // edge while the house remained unreachable.
  if (expansionPhase) {
    const candidates = legalActions(state).filter((candidate) => candidate.type === "BUILD_ROAD");
    const bestScore = Math.max(...candidates.map((candidate) => roadExpansionScore(state, candidate)), -Infinity);
    const score = roadExpansionScore(state, action);
    if (roadCount < 2 && (oneRoadRoute > 0 || twoRoadRoute >= 70) &&
      (oneRoadSupported || twoRoadSupported || gap <= 1) &&
      (!cityPayableNow || oneRoadPayable) &&
      score >= 24 && score >= bestScore - 10) return true;
  }
  if (cityPayableNow && !oneRoadPayable) {
    // A legal city is a concrete VP/production conversion. Do not spend its
    // ore on a speculative road chain unless the first road immediately
    // exposes a payable house; secure Longest Road/defense already returned
    // above. This is the final guard against trade -> road -> no conversion.
    return false;
  }
  // A two-road forecast is not a secure award. The opponent gets a turn
  // between those roads and can extend, cut, or take the same route. Treating
  // `claimSoon` as proof was the losing pattern in simulation: the bot spent
  // its wood/brick on a pretty chain, then had no city/settlement engine. A
  // future race may still win through the normal score when no conversion is
  // available, but it must not override a non-road action here.
  // A fresh frontier can justify the first few roads, but once three paid
  // roads are down the network must prove an actual award swing or immediate
  // settlement route before consuming another wood/brick pair. This keeps a
  // pretty but unsecured Longest Road chase from starving the VP engine.
  if (roadCount >= 3 && !anchorExpansion && !anchorFrontier) return false;
  if (roadCount >= 2 && gap > 1 && !anchorExpansion && !anchorFrontier) return false;
  if (anchorExpansion) return true;
  if (anchorFrontier) {
    const candidates = legalActions(state).filter((candidate) => candidate.type === "BUILD_ROAD");
    const bestScore = Math.max(...candidates.map((candidate) => roadExpansionScore(state, candidate)), -Infinity);
    return roadExpansionScore(state, action) >= bestScore - 10;
  }
  return false;
}

async function evaluateJev(
  state: GameState,
  byType: Map<string, Action[]>,
  candidates: Action[],
  backend: JevBackend,
): Promise<Record<string, ChoiceAnswer>> {
  const operations: Record<string, string> = {};
  for (const [type, list] of byType) {
    operations[type] = `${list[0].label}. ${list.length} legal target(s).`;
  }
  const questions: Record<string, unknown> = {
    operation: {
      type: "choice",
      instructions: OPERATION_RULES,
      criteria: operations,
    },
  };
  for (const [type, list] of byType) {
    if (list.length === 1 && !list[0].vertex && !list[0].hex && !list[0].edge && !list[0].resource) continue;
    const criteria: Record<string, string> = {};
    for (const a of list) {
      let detail = `engine priority ${Math.round(heuristicScore(state, a))}`;
      if (a.type === "BUILD_ROAD" || a.type === "PLACE_ROAD") {
        const frontier = roadExpansionScore(state, a);
        const race = longestRoadPlanScore(state, a);
        detail += `; frontier ${Math.round(frontier)}; LR ${race.immediateLength}/${race.opponentLength}`;
        if (race.roadsToGoal != null) detail += `; roads-to-award ${race.roadsToGoal}`;
        if (race.claimNow || race.defendNow) detail += `; ${race.secureNow || race.defendNow ? "secure" : "unsafe"} award swing`;
      }
      criteria[a.id] = `${a.label} [${detail}]`;
    }
    questions[`${type.toLowerCase()}_target`] = {
      type: "choice",
      instructions: { operation: type, rules: TARGET_RULES },
      criteria,
    };
  }

  const compact = compactState(state, candidates);
  const timeoutMs = Math.max(400, Number(process.env.JEV_TIMEOUT_MS ?? 2600));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (backend.kind === "gateway") {
      stats.gatewayAttempts += 1;
      const res = await fetch(backend.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${backend.apiKey}`,
          "Content-Type": "application/json",
          "ai-gateway-protocol-version": "0.0.1",
          "ai-gateway-auth-method": "api-key",
          "ai-evaluation-model-specification-version": "4",
          "ai-model-id": backend.model,
        },
        body: JSON.stringify({ state: compact, questions }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        noteGatewayRateLimit(res);
        throw new Error(`gateway 429 ${await res.text()}`);
      }
      if (!res.ok) {
        stats.gatewayErrors += 1;
        throw new Error(`gateway ${res.status} ${await res.text()}`);
      }
      const json = (await res.json()) as { answers?: Record<string, ChoiceAnswer> };
      if (!json.answers) throw new Error("gateway response omitted answers");
      noteGatewaySuccess();
      return json.answers;
    }

    const prompt = [
      "You are JEV, the core decision evaluator for a competitive Catan bot.",
      "Choose the operation that maximizes the probability of reaching the VP target before an opponent.",
      "Return only one JSON object. Include `operation` with a `choice` equal to one operation key and its confidence.",
      "Also include the matching `<operation lowercase>_target` answer with a `choice` equal to one legal action id.",
      "Do not invent actions, ids, resources, or targets. Respect the doctrine and the legal list.",
      JSON.stringify({ state: compact, questions }),
    ].join("\n");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (backend.apiKey) headers.Authorization = `Bearer ${backend.apiKey}`;
    const res = await fetch(backend.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: backend.model,
        messages: [
          { role: "system", content: "Return strict JSON only; no markdown fences or explanation." },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 700,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`proxy ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
    const content = json.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : content;
    if (!text) throw new Error("proxy response omitted content");
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned) as { answers?: Record<string, ChoiceAnswer> } | Record<string, ChoiceAnswer>;
    return "answers" in parsed && parsed.answers ? parsed.answers : parsed;
  } finally {
    clearTimeout(timer);
  }
}

function mockReason(state: GameState, action: Action): string {
  const us = winRoute(state, state.us);
  return `${action.label} — we sit at ${us.visible} VP needing ${us.need}; this is the highest expected win-delta among legal moves.`;
}

function format(
  state: GameState,
  action: Action,
  source: Recommendation["source"],
  confidence: number,
  operationProbabilities: Record<string, number>,
  targetProbabilities: Record<string, number>,
  latencyMs: number,
  reason: string,
): Recommendation {
  const us = winRoute(state, state.us);
  const plan =
    us.need <= 2
      ? "Convert remaining VP via city/dev/award. Interrupt any opponent win on sight."
      : "City the best wheat/ore, buy devs, contest army, expand only for scarce resources or cuts.";
  return {
    action,
    target: action.vertex ?? action.edge ?? action.hex ?? action.resource ?? action.type,
    reason,
    plan,
    opponentThreat: opponentThreat(state, state.us),
    confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 100),
    operation: action.type,
    operationProbabilities,
    targetProbabilities,
    latencyMs,
    source,
  };
}

export function printRec(rec: Recommendation): string {
  return [
    `ACTION: ${rec.action.label}`,
    `TARGET: ${rec.target}`,
    `REASON: ${rec.reason}`,
    `PLAN: ${rec.plan}`,
    `OPPONENT THREAT: ${rec.opponentThreat}`,
    `CONFIDENCE: ${rec.confidence}`,
  ].join("\n");
}
