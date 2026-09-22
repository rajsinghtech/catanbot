import type { Action, GameState, Recommendation } from "../types.ts";
import { compactState, opponentThreat, winRoute } from "../engine/features.ts";
import { applyAction, cloneState, legalActions } from "../engine/game.ts";
import { production } from "../engine/features.ts";
import {
  forcedWin,
  heuristicScore,
  longestRoadPlanScore,
  OPERATION_RULES,
  roadExpansionScore,
  settlementPairScore,
  settlementRouteAfterRoad,
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
  const bestNonRoad = ranked.find((entry) => entry.a.type !== "BUILD_ROAD" && entry.a.type !== "PLACE_ROAD");
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

  if (guardedMockBest.type === "BUILD_ROAD" && bestNonRoad && !roadHasStrategicProof(state, guardedMockBest)) {
    guardedMockBest = bestNonRoad.a;
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
    if (picked.type === "BUILD_ROAD" && bestNonRoad && !roadHasStrategicProof(state, picked)) {
      picked = bestNonRoad.a;
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

function roadHasStrategicProof(state: GameState, action: Action): boolean {
  if (action.type !== "BUILD_ROAD" || state.phase === "road_building") return true;
  const plan = longestRoadPlanScore(state, action);
  if ((plan.claimNow && plan.secureNow) || plan.defendNow) return true;
  const me = state.players.find((player) => player.id === action.player);
  const buildingCount = (me?.settlements.length ?? 0) + (me?.cities.length ?? 0);
  const expansionPhase = buildingCount === 2 || (
    (me?.settlements.length ?? 0) >= 2 &&
    (me?.settlements.length ?? 0) < 5
  );
  if (expansionPhase && settlementRouteAfterRoad(state, action) > 0) {
    return true;
  }
  // When the expansion network has no immediately reachable house, allow
  // the best bounded frontier edge to start the route. Requiring an immediate
  // settlement here made the bot stop building roads exactly when it needed a
  // first approach road, then spend the same wood/brick on trades or devs.
  if (expansionPhase) {
    const candidates = legalActions(state).filter((candidate) => candidate.type === "BUILD_ROAD");
    const bestScore = Math.max(...candidates.map((candidate) => roadExpansionScore(state, candidate)), -Infinity);
    const score = roadExpansionScore(state, action);
    // The first approach edge often cannot expose the house until the second
    // edge is paid. Requiring the old 34-point threshold made a hand with
    // wood/brick/sheep/wheat stall at two houses while the bots took the
    // reachable frontier. Keep the best bounded approach alive, but still
    // reject arbitrary backtracking edges.
    if (score >= 24 && score >= bestScore - 10) return true;
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
  if ((me?.roads.length ?? 0) >= 3) return false;
  return roadExpansionScore(state, action) >= 52;
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
