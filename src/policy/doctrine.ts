import { COSTS, PIP, RESOURCES, type Action, type GameState, type Hand, type Resource } from "../types.ts";
import {
  applyAction,
  cloneState,
  handSize,
  legalActions,
  player,
  roadLength,
  roadSpots,
  settlementSpots,
  totalVP,
  visibleVP,
} from "../engine/game.ts";
import { production } from "../engine/features.ts";
import { resourceOf } from "../engine/map.ts";

function canPay(h: Hand, cost: Hand): boolean {
  return RESOURCES.every((r) => h[r] >= cost[r]);
}

function afterSwap(h: Hand, give: Resource, giveN: number, get: Resource, getN: number): Hand {
  return { ...h, [give]: h[give] - giveN, [get]: h[get] + getN };
}

function unlockLabel(before: Hand, after: Hand): string | null {
  if (!canPay(before, COSTS.city) && canPay(after, COSTS.city)) return "city";
  if (!canPay(before, COSTS.settlement) && canPay(after, COSTS.settlement)) return "settlement";
  if (!canPay(before, COSTS.dev) && canPay(after, COSTS.dev)) return "dev card";
  if (!canPay(before, COSTS.road) && canPay(after, COSTS.road)) return "road";
  return null;
}

const RESOURCE_STRATEGIC_WEIGHT: Record<Resource, number> = {
  wood: 1,
  brick: 1,
  sheep: 0.96,
  wheat: 1.22,
  ore: 1.16,
};

function boardPips(state: GameState, resource: Resource): number {
  return Object.values(state.board.hexes).reduce((sum, hex) => {
    if (resourceOf(hex) !== resource || hex.number == null) return sum;
    return sum + (PIP[hex.number] ?? 0);
  }, 0);
}

function localPips(state: GameState, vertex: string, resource: Resource): number {
  const v = state.board.vertices[vertex];
  if (!v) return 0;
  return v.hexes.reduce((sum, hid) => {
    const hex = state.board.hexes[hid];
    return resourceOf(hex) === resource && hex.number != null ? sum + (PIP[hex.number] ?? 0) : sum;
  }, 0);
}

function placementWeight(state: GameState, id: string, resource: Resource, local: number): number {
  const current = production(state, id)[resource];
  const board = boardPips(state, resource);
  const average = RESOURCES.reduce((sum, r) => sum + boardPips(state, r), 0) / RESOURCES.length;
  const scarcity = average > 0 ? Math.max(0, Math.min(1, (average - board) / average)) : 0;
  const coverage = current === 0 ? 1 : current < 5 ? 0.45 : 0;
  // Wheat/ore support every major mid-game conversion, but a low-supply
  // resource still gets value even when its pip count is not glamorous.
  return RESOURCE_STRATEGIC_WEIGHT[resource] * (1 + coverage * 0.7 + scarcity * 0.18 + (local >= 4 ? 0.08 : 0));
}

function resourcePressure(state: GameState, id: string, resource: Resource): number {
  const p = player(state, id);
  let pressure = 0;
  if (p.settlements.length > 0 && p.hand[resource] < COSTS.city[resource]) pressure += 1.2;
  if (p.settlements.length < 5 && settlementSpots(state, p, false).length > 0 && p.hand[resource] < COSTS.settlement[resource]) {
    pressure += 1.35;
  }
  if (state.deck.length > 0 && p.hand[resource] < COSTS.dev[resource]) pressure += 0.85;
  if (p.hand[resource] < COSTS.road[resource]) pressure += resource === "wood" || resource === "brick" ? 0.75 : 0;
  return pressure;
}

function opponentTradeUnlock(state: GameState, offer: NonNullable<GameState["pendingOffer"]>): string | null {
  const sender = player(state, offer.from);
  const after = afterSwap(sender.hand, offer.give, offer.giveCount, offer.get, offer.getCount);
  return unlockLabel(sender.hand, after);
}

function costDistance(hand: Hand, cost: Hand): number {
  return RESOURCES.reduce((sum, resource) => sum + Math.max(0, cost[resource] - hand[resource]), 0);
}

function strategicTradeValue(state: GameState, id: string, before: Hand, after: Hand, offered: Resource): number {
  const me = player(state, id);
  const goals: Array<[Hand, number]> = [
    [COSTS.settlement, 15],
    [COSTS.city, 13],
    [COSTS.road, 9],
    [COSTS.dev, 8],
  ];
  let value = 0;
  for (const [cost, weight] of goals) value += (costDistance(before, cost) - costDistance(after, cost)) * weight;

  const ownProduction = production(state, id);
  if (ownProduction[offered] === 0) value += 15;
  else if (ownProduction[offered] < 5) value += 7;
  if ((offered === "wood" || offered === "brick") && bestReachableSettlementValue(state, id) > 0) value += 8;
  if (offered === "wheat" || offered === "ore") value += 4;

  // A trade is more valuable when it lowers the number of missing cards for a
  // real, reachable target, not merely because the hand is larger afterward.
  const reachable = bestReachableSettlementValue(state, id);
  if (reachable > 0) {
    const beforeMissing = costDistance(before, COSTS.settlement);
    const afterMissing = costDistance(after, COSTS.settlement);
    if (afterMissing < beforeMissing) value += reachable * 0.18;
  }
  if (me.settlements.length + me.cities.length === 2 && costDistance(after, COSTS.settlement) < costDistance(before, COSTS.settlement)) {
    // Third settlement timing is a major competitive milestone; accept a
    // preparatory trade even when it is not yet a same-turn build.
    value += 12;
  }
  return value;
}

type StrategyProfile = "road" | "engine" | "port" | "balanced";

function strategyProfile(state: GameState, id: string): StrategyProfile {
  const p = player(state, id);
  const prod = production(state, id);
  const road = prod.wood + prod.brick;
  const engine = prod.wheat * 1.1 + prod.ore * 1.25 + prod.sheep * 0.8;
  const port = [...p.settlements, ...p.cities].reduce((sum, vertex) => {
    const value = state.board.vertices[vertex]?.port;
    if (!value) return sum;
    if (value.ratio === 2 && value.resource) return sum + (prod[value.resource] >= 4 ? 12 : 2);
    return sum + 3;
  }, 0);
  if (port >= 14 && port >= road * 0.7) return "port";
  if (road >= engine * 1.18 && road >= 10) return "road";
  if (engine >= road * 1.12 && engine >= 13) return "engine";
  return "balanced";
}

function profileBias(state: GameState, action: Action): number {
  if (state.phase === "setup_settle" || state.phase === "setup_road") return 0;
  const profile = strategyProfile(state, action.player);
  switch (action.type) {
    case "BUILD_ROAD":
    case "PLACE_ROAD":
      return profile === "road" ? 8 : profile === "engine" ? -3 : 0;
    case "BUILD_SETTLEMENT":
      return profile === "road" || profile === "port" ? 5 : 2;
    case "BUILD_CITY":
      return profile === "engine" || profile === "port" ? 7 : 2;
    case "BUY_DEV":
      return profile === "engine" || profile === "port" ? 7 : 0;
    case "MARITIME_TRADE":
      return profile === "port" ? 5 : 0;
    default:
      return 0;
  }
}

function diceCoverage(state: GameState, vertex: string): number {
  const v = state.board.vertices[vertex];
  if (!v) return 0;
  const numbers = new Set<number>();
  let duplicate = 0;
  for (const hid of v.hexes) {
    const number = state.board.hexes[hid]?.number;
    if (number == null) continue;
    if (numbers.has(number)) duplicate += 1;
    numbers.add(number);
  }
  // A little number diversity reduces normal-dice variance; it should never
  // outweigh a strong 6/8, so this remains a tie-break rather than a rule.
  return numbers.size * 1.6 - duplicate * 1.2;
}

function bestRobberValueAfterKnight(state: GameState, us: string): number {
  const sim = cloneState(state);
  sim.current = us;
  sim.phase = "robber";
  sim.afterRobber = state.phase === "roll" ? "roll" : "turn";
  const moves = legalActions(sim).filter((action) => action.type === "MOVE_ROBBER");
  return Math.max(0, ...moves.map((action) => heuristicScore(sim, action)));
}

function settlementSpotValue(state: GameState, id: string, vertex: string): number {
  const v = state.board.vertices[vertex];
  if (!v) return -Infinity;
  const prod = production(state, id);
  const seen = new Set<Resource>();
  let score = 0;
  for (const hid of v.hexes) {
    const hex = state.board.hexes[hid];
    const resource = resourceOf(hex);
    const pips = hex.number == null ? 0 : PIP[hex.number] ?? 0;
    const weight = resource ? placementWeight(state, id, resource, pips) : 1;
    score += pips * (3 + (resource === "wheat" || resource === "ore" ? 4 : 0)) * weight;
    if (resource && prod[resource] === 0) score += 12 * RESOURCE_STRATEGIC_WEIGHT[resource];
    else if (resource && prod[resource] < 5) score += (5 - prod[resource]) * 1.5 * RESOURCE_STRATEGIC_WEIGHT[resource];
    if (resource && !seen.has(resource)) {
      seen.add(resource);
      score += 3 * RESOURCE_STRATEGIC_WEIGHT[resource];
    }
  }
  score += diceCoverage(state, vertex);
  if (v.port) {
    if (v.port.ratio === 2 && v.port.resource) {
      const aligned = localPips(state, vertex, v.port.resource);
      // A matching 2:1 port is a conversion engine only when this corner can
      // actually feed it. A weak, unaligned port should not beat production.
      score += aligned >= 4 ? 18 : aligned > 0 ? 10 : 3;
    } else {
      score += 6;
    }
  }
  return score;
}

function bestOpenSettlementValue(state: GameState, id: string): number {
  const spots = settlementSpots(state, player(state, id), true);
  return Math.max(0, ...spots.map((vertex) => settlementSpotValue(state, id, vertex)));
}

function bestReachableSettlementValue(state: GameState, id: string): number {
  const spots = settlementSpots(state, player(state, id), false);
  return Math.max(0, ...spots.map((vertex) => settlementSpotValue(state, id, vertex)));
}

/**
 * The first two settlements are the opening; the third settlement is the
 * expansion funnel.  A common weak-game pattern is to have two houses, pay
 * the wood/brick needed to point a road somewhere, then spend the remaining
 * wheat/sheep/ore on dev cards before that road can become a house.  Keep the
 * policy aware of whether a road actually creates a reachable settlement so
 * this phase is treated as a conversion problem rather than a raw road race.
 */
export function settlementRouteAfterRoad(state: GameState, action: Action): number {
  if (action.type !== "BUILD_ROAD" || !action.edge) return 0;
  const after = cloneState(state);
  const p = player(after, action.player);
  if (!p.roads.includes(action.edge)) p.roads.push(action.edge);
  if (state.phase !== "road_building") {
    p.hand.wood = Math.max(0, p.hand.wood - COSTS.road.wood);
    p.hand.brick = Math.max(0, p.hand.brick - COSTS.road.brick);
  }
  return bestReachableSettlementValue(after, action.player);
}

function thirdSettlementFunnel(state: GameState, id: string): {
  active: boolean;
  missing: number;
  cityMissing: number;
  reachableValue: number;
  bestRoadRoute: number;
} {
  const me = player(state, id);
  // A city replaces a settlement in the state arrays, but it does not erase
  // the two-building opening milestone. Keep the funnel active at one house
  // plus one city as well: otherwise the first city accidentally authorizes a
  // dev-card loop while the player is still missing the road-to-third-house
  // conversion.
  const active = me.settlements.length + me.cities.length === 2;
  if (!active) {
    return { active: false, missing: 99, cityMissing: 99, reachableValue: 0, bestRoadRoute: 0 };
  }
  const roads = roadSpots(state, me).map((edge) => settlementRouteAfterRoad(state, {
    id: `FUNNEL:${edge}`,
    type: "BUILD_ROAD",
    player: id,
    edge,
    label: "funnel road",
  })).sort((a, b) => b - a);
  return {
    active,
    missing: costDistance(me.hand, COSTS.settlement),
    cityMissing: costDistance(me.hand, COSTS.city),
    reachableValue: bestReachableSettlementValue(state, id),
    bestRoadRoute: roads[0] ?? 0,
  };
}

function vertexOwner(state: GameState, vertex: string): string | undefined {
  return state.players.find((p) => p.settlements.includes(vertex) || p.cities.includes(vertex))?.id;
}

/**
 * Estimate how much territory a road opens for the next settlement.  A raw
 * road count is a poor proxy: the useful road is the one that points at a
 * legal, high-production intersection and still has alternatives behind it.
 * This is deliberately a small bounded graph search so it stays cheap on the
 * live 19-hex board.
 */
export function roadExpansionScore(state: GameState, action: Action): number {
  if (!action.edge || !state.board.edges[action.edge]) return -Infinity;
  const beforePlayer = player(state, action.player);
  const edge = state.board.edges[action.edge];
  const beforeNetwork = new Set<string>([
    ...beforePlayer.settlements,
    ...beforePlayer.cities,
    ...beforePlayer.roads.flatMap((id) => state.board.edges[id]?.vertices ?? []),
  ]);
  const after = cloneState(state);
  const afterPlayer = player(after, action.player);
  if (!afterPlayer.roads.includes(action.edge)) afterPlayer.roads.push(action.edge);
  const postRoadHand = { ...afterPlayer.hand };
  if (action.type === "BUILD_ROAD" && state.phase !== "road_building") {
    postRoadHand.wood -= COSTS.road.wood;
    postRoadHand.brick -= COSTS.road.brick;
  }
  const canFinishSettlementAfterRoad = canPay(postRoadHand, COSTS.settlement);

  // Setup roads have an explicit source house.  For normal roads, prefer the
  // endpoint that is new to our network; scoring from the old network would
  // make every branch look equally good and produced arbitrary-looking roads.
  const fresh = edge.vertices.filter((vertex) => !beforeNetwork.has(vertex));
  const starts = action.vertex && edge.vertices.includes(action.vertex)
    ? edge.vertices.filter((vertex) => vertex !== action.vertex)
    : fresh.length > 0
      ? fresh
      : edge.vertices;
  const backtrack = action.vertex && edge.vertices.includes(action.vertex)
    ? action.vertex
    : fresh.length > 0
      ? edge.vertices.find((vertex) => beforeNetwork.has(vertex))
      : undefined;

  const legalSettlementSpots = new Set(settlementSpots(after, afterPlayer, true));
  const distance = new Map<string, number>();
  const queue: Array<{ vertex: string; depth: number }> = [];
  for (const vertex of starts) {
    if (!distance.has(vertex)) {
      distance.set(vertex, 0);
      queue.push({ vertex, depth: 0 });
    }
  }
  const maxDepth = 3;
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    const vertexState = after.board.vertices[current.vertex];
    if (!vertexState) continue;
    for (const edgeId of vertexState.edges) {
      if (edgeId === action.edge && current.vertex !== starts[0]) continue;
      const nextEdge = after.board.edges[edgeId];
      if (!nextEdge) continue;
      const next = nextEdge.vertices[0] === current.vertex ? nextEdge.vertices[1] : nextEdge.vertices[0];
      const owner = vertexOwner(after, next);
      // An opposing settlement is a hard road-network break.  Our own
      // settlement/city is a valid connection point.
      if (owner && owner !== action.player) continue;
      if (next === backtrack && current.depth === 0) continue;
      const roadOwner = after.players.find((p) => p.roads.includes(edgeId))?.id;
      if (roadOwner && roadOwner !== action.player) continue;
      const nextDepth = current.depth + 1;
      if (nextDepth < (distance.get(next) ?? Infinity)) {
        distance.set(next, nextDepth);
        queue.push({ vertex: next, depth: nextDepth });
      }
    }
  }

  const targets = [...distance.entries()]
    .filter(([vertex, depth]) => legalSettlementSpots.has(vertex) && depth <= maxDepth)
    .map(([vertex, depth]) => ({ vertex, depth, value: settlementSpotValue(after, action.player, vertex) }))
    .sort((a, b) => b.value - a.value || a.depth - b.depth);

  // A frontier is not actually ours if an opponent can settle there first.
  // Keep this deliberately conservative: it only counts spots that are
  // already reachable from that opponent's road network, not speculative
  // two-turn races.
  const opponentFrontier = new Set<string>();
  for (const opponent of after.players.filter((p) => p.id !== action.player)) {
    for (const vertex of settlementSpots(after, opponent, false)) opponentFrontier.add(vertex);
  }

  let score = 0;
  for (const target of targets.slice(0, 6)) {
    const depthWeight = target.depth === 0 ? 2.8 : target.depth === 1 ? 1.35 : target.depth === 2 ? 0.62 : 0.24;
    const contestedWeight = opponentFrontier.has(target.vertex) ? 0.35 : 1;
    score += (target.value + 18) * depthWeight * contestedWeight;
    if (canFinishSettlementAfterRoad) {
      score += target.depth === 0 ? 30 : target.depth === 1 ? 16 : 6;
    }
  }
  const immediate = targets.filter((target) => target.depth === 0);
  if (immediate.length) {
    score += 32 + Math.max(...immediate.map((target) => target.value)) * 0.9;
    score += Math.min(2, immediate.length - 1) * 14;
  } else if (targets.length === 0) {
    // A road that points into an occupied corner or a closed rim is usually
    // a tempo loss.  It can still be legal, so penalize rather than forbid it.
    score -= 26;
  } else {
    score -= 8;
  }

  // Keep the frontier value on the same scale as a build action.  The raw
  // sum above intentionally looks at several possible future intersections;
  // using it unscaled made an ordinary road beat an immediately available
  // settlement or city simply because it had many theoretical paths.
  score *= 0.13;

  const beforeLength = roadLength(state, action.player);
  const afterLength = roadLength(after, action.player);
  // Road length is useful as an expansion signal, but it is not itself the
  // Longest Road award.  Award/race value is handled by
  // longestRoadPlanScore below, where we can check whether the chain can be
  // cut immediately.  Keeping that concern out of the frontier score stops a
  // long but unsafe branch from beating a payable settlement.
  score += (afterLength - beforeLength) * 14;

  const opponentBestLength = Math.max(
    0,
    ...state.players.filter((p) => p.id !== action.player).map((p) => roadLength(state, p.id)),
  );
  const security = roadSecurity(after, action.player, afterLength);
  if (security.blockers > 0) {
    // An accessible settlement that breaks the claimed chain is a direct
    // denial threat. Penalize the road even when it reaches five; otherwise
    // the raw Longest Road bonus makes the bot repeatedly walk into traps.
    score -= Math.min(38, security.maxDrop * 14 + security.blockers * 5);
    if (afterLength >= 5 && security.worstLength < 5) score -= 28;
    if (afterLength >= 5 && security.worstLength <= opponentBestLength) score -= 18;
  }

  // Taking an edge that an opponent currently needs is a meaningful cut,
  // especially when they already have a road network worth contesting.
  for (const opponent of state.players.filter((p) => p.id !== action.player)) {
    if (!roadSpots(state, opponent).includes(action.edge)) continue;
    const opponentLength = roadLength(state, opponent.id);
    score += 5 + Math.min(18, opponentLength * 2);
  }
  return score;
}

function roadSecurity(state: GameState, us: string, afterLength: number): {
  blockers: number;
  maxDrop: number;
  worstLength: number;
} {
  let blockers = 0;
  let maxDrop = 0;
  let worstLength = afterLength;
  const seen = new Set<string>();
  for (const opponent of state.players.filter((p) => p.id !== us)) {
    for (const vertex of settlementSpots(state, opponent, false)) {
      if (seen.has(vertex) || vertexOwner(state, vertex)) continue;
      seen.add(vertex);
      const blocked = cloneState(state);
      const blocker = player(blocked, opponent.id);
      blocker.settlements.push(vertex);
      const blockedLength = roadLength(blocked, us);
      if (blockedLength >= afterLength) continue;
      blockers += 1;
      maxDrop = Math.max(maxDrop, afterLength - blockedLength);
      worstLength = Math.min(worstLength, blockedLength);
    }
  }
  return { blockers, maxDrop, worstLength };
}

export interface LongestRoadPlan {
  immediateLength: number;
  bestLength: number;
  opponentLength: number;
  roadsToGoal: number | null;
  claimNow: boolean;
  secureNow: boolean;
  claimSoon: boolean;
  secureSoon: boolean;
  defendNow: boolean;
  value: number;
}

type RoadPlanNode = { state: GameState; path: string[] };

function addRoadForPlan(state: GameState, us: string, edge: string, pay: boolean): GameState {
  const next = cloneState(state);
  const p = player(next, us);
  if (!p.roads.includes(edge)) p.roads.push(edge);
  if (pay) {
    p.hand.wood = Math.max(0, p.hand.wood - COSTS.road.wood);
    p.hand.brick = Math.max(0, p.hand.brick - COSTS.road.brick);
  }
  return next;
}

function roadPlanExtensions(node: RoadPlanNode, us: string): RoadPlanNode[] {
  const p = player(node.state, us);
  const candidates = roadSpots(node.state, p)
    .filter((edge) => !node.path.includes(edge))
    .map((edge) => {
      const next = addRoadForPlan(node.state, us, edge, false);
      const nextLength = roadLength(next, us);
      const nextOptions = roadSpots(next, player(next, us)).length;
      return { edge, next, nextLength, nextOptions };
    })
    .sort((a, b) => b.nextLength - a.nextLength || b.nextOptions - a.nextOptions || a.edge.localeCompare(b.edge))
    .slice(0, 5);
  return candidates.map(({ edge, next }) => ({ state: next, path: [...node.path, edge] }));
}

/**
 * Evaluate a road as part of an actual Longest Road race.  The search is
 * intentionally shallow: one road is the move being considered and two
 * more roads are enough to catch the common endgame swing without putting a
 * network request or a large graph search on the live action path.
 */
export function longestRoadPlanScore(state: GameState, action: Action): LongestRoadPlan {
  const us = action.player;
  const opponentLength = Math.max(
    0,
    ...state.players.filter((p) => p.id !== us).map((p) => roadLength(state, p.id)),
  );
  const beforeLength = roadLength(state, us);
  const noPlan: LongestRoadPlan = {
    immediateLength: beforeLength,
    bestLength: beforeLength,
    opponentLength,
    roadsToGoal: null,
    claimNow: false,
    secureNow: false,
    claimSoon: false,
    secureSoon: false,
    defendNow: false,
    value: 0,
  };
  if (action.type !== "BUILD_ROAD" || !action.edge || !state.board.edges[action.edge]) return noPlan;

  const first = addRoadForPlan(state, us, action.edge, state.phase !== "road_building");
  const immediateLength = roadLength(first, us);
  const target = Math.max(5, opponentLength + 1);
  if (state.longestRoad === us && opponentLength < beforeLength) {
    return { ...noPlan, immediateLength, bestLength: immediateLength, value: -22 };
  }
  const nearRace = beforeLength >= 3 || opponentLength >= 4 || state.longestRoad === us;
  if (!nearRace && immediateLength < target) return noPlan;

  const needsImmediateSecurity =
    (state.longestRoad !== us && immediateLength >= target) ||
    (state.longestRoad === us && opponentLength >= beforeLength && immediateLength > beforeLength);
  const immediateSecurity = needsImmediateSecurity
    ? roadSecurity(first, us, immediateLength)
    : { blockers: 0, maxDrop: 0, worstLength: immediateLength };
  const secureNow = immediateLength >= target && immediateSecurity.worstLength > opponentLength;
  const claimNow = state.longestRoad !== us && immediateLength >= target;
  const defendNow =
    state.longestRoad === us &&
    opponentLength >= beforeLength &&
    immediateLength > beforeLength &&
    immediateSecurity.worstLength > opponentLength;

  const nodes: RoadPlanNode[] = [{ state: first, path: [action.edge] }];
  let frontier = nodes.slice();
  for (let depth = 0; depth < 2; depth++) {
    const next: RoadPlanNode[] = [];
    for (const node of frontier) next.push(...roadPlanExtensions(node, us));
    if (!next.length) break;
    nodes.push(...next);
    // Keep the bounded search cheap while preserving the best topological
    // branches from each depth. The first edge remains the authoritative
    // action; this only estimates whether the race is real.
    frontier = next
      .sort((a, b) => roadLength(b.state, us) - roadLength(a.state, us) || b.path.length - a.path.length)
      .slice(0, 10);
  }

  let bestLength = immediateLength;
  let goalPath: string[] | null = immediateLength >= target ? [action.edge] : null;
  let goalSecurity = immediateSecurity;
  let goalLength = immediateLength;
  for (const node of nodes) {
    const length = roadLength(node.state, us);
    if (length > bestLength) bestLength = length;
    if (length < target) continue;
    const security = node.path.length === 1 ? immediateSecurity : roadSecurity(node.state, us, length);
    const betterGoal =
      !goalPath ||
      node.path.length < goalPath.length ||
      (node.path.length === goalPath.length && length > goalLength) ||
      (node.path.length === goalPath.length && length === goalLength && security.worstLength > goalSecurity.worstLength);
    if (betterGoal) {
      goalPath = node.path;
      goalLength = length;
      goalSecurity = security;
    }
  }
  const claimSoon = goalPath !== null;
  const secureSoon = claimSoon && goalSecurity.worstLength > opponentLength;
  const roadsToGoal = goalPath ? goalPath.length : null;

  let value = 0;
  if (claimNow) {
    // The award is a real two-VP swing, but only the secure version deserves
    // to beat an immediately available house/city.
    value += secureNow ? 78 : 20;
    if (totalVP(state, us) + 2 >= state.config.victoryPoints) value += secureNow ? 70 : 12;
  } else if (state.longestRoad !== us && claimSoon) {
    // A future race is useful context, not permission to tunnel on roads.
    // It gets a modest bonus and is later gated against direct builds.
    value += secureSoon ? 26 : 8;
    if (roadsToGoal === 2) value += 8;
  } else if (defendNow) {
    value += 46;
  } else if (state.longestRoad === us && opponentLength < beforeLength) {
    // Once the award is safe, additional roads are usually inferior to a
    // settlement/city unless they are a necessary denial move.
    value -= 22;
  }
  return {
    immediateLength,
    bestLength,
    opponentLength,
    roadsToGoal,
    claimNow,
    secureNow,
    claimSoon,
    secureSoon,
    defendNow,
    value,
  };
}

function roadBuildingValue(state: GameState, us: string): number {
  const sim = cloneState(state);
  sim.current = us;
  sim.phase = "road_building";
  sim.pendingRoads = 2;
  const first = legalActions(sim).filter((action) => action.type === "BUILD_ROAD");
  if (!first.length) return -18;
  const rankedFirst = first
    .map((action) => ({ action, score: roadExpansionScore(sim, action) }))
    .sort((a, b) => b.score - a.score);
  const bestFirst = rankedFirst[0];
  applyAction(sim, bestFirst.action, () => 0.5);
  const second = legalActions(sim)
    .filter((action) => action.type === "BUILD_ROAD")
    .map((action) => roadExpansionScore(sim, action))
    .sort((a, b) => b - a)[0] ?? 0;
  const house = bestReachableSettlementValue(sim, us);
  const award = longestRoadPlanScore(state, bestFirst.action);
  return bestFirst.score + second * 0.72 + (house > 0 ? house * 0.34 : -8) + award.value * 0.65;
}

function yearOfPlentyActionValue(state: GameState, action: Action): number {
  const me = player(state, action.player);
  const resources = action.resources ?? (action.resource ? [action.resource] : []);
  if (!resources.length) return yearOfPlentyValue(state, action.player);
  const after = { ...me.hand };
  for (const resource of resources.slice(0, 2)) after[resource] += 1;
  const unlock = unlockLabel(me.hand, after);
  const unlockScore = unlock === "city" ? 66 : unlock === "settlement" ? 56 : unlock === "dev card" ? 26 : unlock === "road" ? 20 : 0;
  let score = 14 + unlockScore;

  // Year of Plenty is a tempo card, not a generic wheat/ore bonus. Prefer the
  // pair that completes the cheapest real route, especially the missing sheep
  // or expansion card that turns an existing road into a settlement. The old
  // branch scored only resource adjectives, which made every pair tie and
  // caused the bridge to pick the first legal pair arbitrarily.
  const beforeSettlement = costDistance(me.hand, COSTS.settlement);
  const afterSettlement = costDistance(after, COSTS.settlement);
  const beforeCity = costDistance(me.hand, COSTS.city);
  const afterCity = costDistance(after, COSTS.city);
  score += (beforeSettlement - afterSettlement) * 24;
  score += (beforeCity - afterCity) * 18;
  if (canPay(after, COSTS.settlement) && settlementSpots(state, me, false).length > 0) score += 58;
  if (canPay(after, COSTS.city) && me.settlements.length > 0) score += 70;

  // Once the player has three or more buildings, the reliable two-point
  // route is usually a city/development engine rather than another expansion
  // detour. If ore is already in hand and wheat is the only city hinge, make
  // YOP explicitly choose wheat (including wheat + wheat) instead of a
  // generic resource pair. This is the live failure mode where the bot took
  // wood + sheep and remained one wheat short while an opponent was on 9 VP.
  if (me.settlements.length + me.cities.length >= 3 && me.settlements.length > 0) {
    const cityWheatMissing = Math.max(0, COSTS.city.wheat - me.hand.wheat);
    const cityOreMissing = Math.max(0, COSTS.city.ore - me.hand.ore);
    const wheatAdded = resources.filter((resource) => resource === "wheat").length;
    const oreAdded = resources.filter((resource) => resource === "ore").length;
    if (cityOreMissing === 0 && cityWheatMissing > 0) score += wheatAdded * 58;
    if (cityWheatMissing === 0 && cityOreMissing > 0) score += oreAdded * 46;
    if (cityWheatMissing > 0 && cityOreMissing > 0 && wheatAdded > 0 && oreAdded > 0) score += 48;
  }

  for (const resource of resources) {
    if (me.hand[resource] === 0) score += 11;
    if (resource === "wheat" || resource === "ore") score += 5;
    if (resource === "wood" || resource === "brick") score += 3;
  }
  if (me.settlements.length + me.cities.length === 2 && afterSettlement < beforeSettlement) score += 18;
  return score;
}

function yearOfPlentyValue(state: GameState, us: string): number {
  let best = 0;
  for (const a of RESOURCES) {
    if (state.bank[a] <= 0) continue;
    for (const b of RESOURCES) {
      if (state.bank[b] - (a === b ? 1 : 0) <= 0) continue;
      best = Math.max(best, yearOfPlentyActionValue(state, {
        id: `YOP:${a}:${b}`,
        type: "PLAY_YEAR_OF_PLENTY",
        player: us,
        resource: a,
        resources: [a, b],
        label: `Year of Plenty ${a} + ${b}`,
      }));
    }
  }
  return best || 14;
}

function placeForEstimate(state: GameState, id: string, vertex: string): void {
  const p = player(state, id);
  if (!p.settlements.includes(vertex) && !p.cities.includes(vertex)) p.settlements.push(vertex);
}

function opponentDenial(state: GameState, us: string, vertex: string): number {
  const after = cloneState(state);
  placeForEstimate(after, us, vertex);
  return state.players
    .filter((p) => p.id !== us)
    .reduce((denial, opponent) => {
      const before = bestOpenSettlementValue(state, opponent.id);
      const afterValue = bestOpenSettlementValue(after, opponent.id);
      return denial + Math.max(0, before - afterValue);
    }, 0);
}

/**
 * The reverse-order setup settlement is not a second copy of the opening
 * pick.  It is the hand that has to carry the first two builds: a corner
 * with excellent pips but no sheep (or no expansion resource) often leaves
 * the player unable to convert those pips into a settlement, city, or dev.
 * Score the pair's combined coverage and its actual starting cards before
 * allowing raw production to break the tie.
 */
export function setupSecondSettlementScore(state: GameState, id: string, vertex: string): number {
  const me = player(state, id);
  if (me.settlements.length === 0) return 0;
  const before = production(state, id);
  const sim = cloneState(state);
  placeForEstimate(sim, id, vertex);
  const after = production(sim, id);
  const owned = new Set<string>([...me.settlements, vertex]);
  const starting: Record<Resource, number> = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  const covered = new Set<Resource>();
  for (const ownedVertex of owned) {
    for (const hid of sim.board.vertices[ownedVertex]?.hexes ?? []) {
      const hex = sim.board.hexes[hid];
      const resource = resourceOf(hex);
      if (!resource) continue;
      covered.add(resource);
      starting[resource] += 1;
    }
  }

  // Keep the reverse-order pick tied to real production.  Coverage is the
  // constraint, not a substitute for pips: an all-resource corner that never
  // rolls is not a useful complement to the opening settlement.
  let score = settlementSpotValue(state, id, vertex) * 0.55;
  const expansion = ["wood", "brick", "sheep", "wheat"] as const;
  for (const resource of expansion) {
    if (before[resource] <= 0 && after[resource] > 0) score += 24;
    if (resource === "brick" && before.brick <= 0 && after.brick > 0) {
      // Brick is not interchangeable with a generic extra resource in the
      // reverse-order pick: it is the card that turns the first pair into a
      // road and then a third settlement.  When the opening house has no
      // brick, prefer a viable brick corner even if a wheat/sheep corner has
      // slightly prettier raw pips.
      score += 55;
    }
    // A pair with no brick/wood/sheep is not merely a little less balanced:
    // it cannot make the next settlement without repeated trades. Treat a
    // missing expansion resource as a strategic veto unless the map makes it
    // genuinely unavoidable. Wheat is still important, but can be converted
    // through a port/city line, so its penalty is slightly softer.
    if (after[resource] <= 0) {
      if (resource === "wheat") {
        // Wheat is the conversion hinge for cities, devs, and most third
        // settlements. A wheatless second settlement is only acceptable when
        // the remaining board genuinely offers no wheat corner.
        const wheatOptionExists = settlementSpots(sim, me, true).some(
          (spot) => localPips(sim, spot, "wheat") > 0,
        );
        score -= wheatOptionExists ? 108 : 35;
      } else {
        // Sheep is the settlement hinge in an otherwise attractive
        // wheat/wood/brick/ore pair: without it, the third settlement and
        // development-card routes depend on repeated player trades. Price it
        // at least as heavily as ore because an ore-rich pair with no sheep
        // can city, but cannot expand.
        score -= resource === "sheep" ? 145 : resource === "brick" ? 82 : 70;
      }
    }
    if (starting[resource] > 0) score += 3;
  }
  // Ore is a strong city/dev resource, but missing it is less damaging when
  // the first settlement already has wheat/ore production.  In a four-player
  // opening, however, a wheat-heavy first pick plus a no-ore second pick can
  // strand the player in a low-VP trade loop, so price a viable ore corner
  // when one remains.
  if (before.ore <= 0 && after.ore > 0) score += 18;
  if (after.ore <= 0) {
    const oreOptionExists = settlementSpots(sim, me, true).some(
      (spot) => localPips(sim, spot, "ore") > 0,
    );
    const alignedOrePort = sim.board.vertices[vertex]?.port?.ratio === 2 &&
      sim.board.vertices[vertex]?.port?.resource === "ore" &&
      localPips(sim, vertex, "ore") > 0;
    // Ore is the city/dev conversion engine. A pair that completely misses
    // it can still race settlements, but only when the remaining board has
    // no viable ore corner. Keep a pretty wheat/wood/sheep second pick from
    // erasing an available ore complement through raw pip count.
    score -= alignedOrePort ? 24 : oreOptionExists ? 112 : 30;
  }
  score += covered.size * 5;

  // Reward a pair that can plausibly convert its first roll sequence into a
  // build. These are deliberately smaller than the core coverage terms so a
  // 6/8 remains valuable, but a duplicated wheat corner cannot erase a
  // missing settlement resource.
  score += Math.min(8, starting.wood) * 2;
  score += Math.min(8, starting.brick) * 2;
  score += Math.min(8, starting.sheep) * 2;
  score += Math.min(8, starting.wheat) * 1.5;
  score += Math.min(8, starting.ore) * 1.25;
  score += (after.wood + after.brick + after.sheep) * 0.35;
  score += (after.wheat + after.ore) * 0.24;
  const expansionCovered = (["wood", "brick", "sheep", "wheat"] as const)
    .filter((resource) => after[resource] > 0).length;
  score += expansionCovered * 9;
  if (expansionCovered === 4) score += 35;

  const port = sim.board.vertices[vertex]?.port;
  if (port) {
    if (port.ratio === 2 && port.resource && after[port.resource] >= 4) score += 20;
    else if (port.ratio === 3) score += 4;
  }
  return score;
}

type SetupComplement = {
  score: number;
  vertex: string;
  state: GameState;
};

function likelyComplement(state: GameState, action: Action): SetupComplement | null {
  if (state.phase !== "setup_settle" || !action.vertex) return null;
  const me = player(state, action.player);
  if (me.settlements.length > 0) return null;

  const sim = cloneState(state);
  const opening = legalActions(sim).find(
    (candidate) => candidate.type === "PLACE_SETTLEMENT" && candidate.player === action.player && candidate.vertex === action.vertex,
  );
  if (!opening) {
    placeForEstimate(sim, action.player, action.vertex);
  } else {
    applyAction(sim, opening, () => 0.5);
  }

  let guard = 0;
  while (sim.phase !== "ended" && guard++ < 24) {
    if (sim.phase === "setup_road") {
      const road = legalActions(sim).find((candidate) => candidate.type === "PLACE_ROAD");
      if (!road) break;
      applyAction(sim, road, () => 0.5);
      continue;
    }
    if (sim.phase !== "setup_settle") break;
    if (sim.current === action.player && player(sim, action.player).settlements.length >= 1) {
      const choices = legalActions(sim)
        .filter((candidate) => candidate.type === "PLACE_SETTLEMENT" && candidate.vertex)
        .map((candidate) => ({
          candidate,
          score: setupSecondSettlementScore(sim, action.player, candidate.vertex!) +
            settlementSpotValue(sim, action.player, candidate.vertex!) * 0.35,
        }))
        .sort((a, b) => b.score - a.score);
      const best = choices[0];
      if (!best?.candidate.vertex) return null;
      const pair = cloneState(sim);
      placeForEstimate(pair, action.player, best.candidate.vertex);
      return { score: Math.max(0, best.score), vertex: best.candidate.vertex, state: pair };
    }
    const opponentPick = legalActions(sim)
      .filter((candidate) => candidate.type === "PLACE_SETTLEMENT" && candidate.vertex)
      .sort((a, b) => settlementSpotValue(sim, sim.current, b.vertex!) - settlementSpotValue(sim, sim.current, a.vertex!))[0];
    if (!opponentPick) break;
    applyAction(sim, opponentPick, () => 0.5);
  }
  return null;
}

function likelyComplementValue(state: GameState, action: Action): number {
  return likelyComplement(state, action)?.score ?? 0;
}

export function settlementPairScore(state: GameState, action: Action): number {
  if (state.phase !== "setup_settle" || !action.vertex) return 0;
  const current = settlementSpotValue(state, action.player, action.vertex);
  const complement = likelyComplement(state, action);
  const denial = opponentDenial(state, action.player, action.vertex);
  let score = current + (complement?.score ?? 0) * 0.9 + denial * 2.2;

  // A first house that only has wheat/ore/wood can look excellent on pips
  // while leaving the reverse-order player with no reliable sheep or brick.
  // Competitive openings need an expansion resource shape, not just a high
  // expected-card total: the pair must be able to make a road and settlement
  // before dev-card tempo becomes relevant. Keep the penalty small enough
  // that an exceptional 6/8/5 corner can still win, but reject the common
  // two-resource trap when both brick and sheep are absent from the first
  // house.
  const firstResources = new Set<Resource>();
  for (const hid of state.board.vertices[action.vertex]?.hexes ?? []) {
    const resource = resourceOf(state.board.hexes[hid]);
    if (resource) firstResources.add(resource);
  }
  const firstExpansion = ["wood", "brick", "sheep", "wheat"] as const;
  score += firstExpansion.filter((resource) => firstResources.has(resource)).length * 22;
  if (!firstResources.has("brick") && !firstResources.has("sheep")) score -= 70;
  if (!firstResources.has("wood") && !firstResources.has("brick")) score -= 42;

  // The first house is not a standalone pip-maximization problem.  A pair
  // with no wood or brick production can be trapped for many turns even when
  // its raw numbers look excellent; it cannot expand without repeated trades
  // and usually loses the race to the third settlement.  Penalize that only
  // when the remaining open board still offers the missing resource, so a
  // genuinely resource-poor board does not make the opening impossible.
  if (complement) {
    const pairPlayer = player(complement.state, action.player);
    const available = (resource: Resource) => settlementSpots(complement.state, pairPlayer, true).some(
      (spot) => localPips(complement.state, spot, resource) > 0,
    );
    const pairProduction = production(complement.state, action.player);
    const penalties: Array<[Resource, number]> = [
      ["wood", 150],
      ["brick", 135],
      ["wheat", 125],
      ["sheep", 145],
      ["ore", 112],
    ];
    for (const [resource, penalty] of penalties) {
      if (pairProduction[resource] <= 0 && available(resource)) score -= penalty;
      else if (pairProduction[resource] < 2 && available(resource)) score -= penalty * 0.18;
    }
    if (pairProduction.wood <= 0 && pairProduction.brick <= 0 && (available("wood") || available("brick"))) {
      score -= 90;
    }
    const covered = (Object.keys(pairProduction) as Resource[]).filter((resource) => pairProduction[resource] > 0).length;
    // Diversity is a competitive tempo constraint, not a cosmetic tie-break:
    // every missing build resource creates another trade/roll cycle. Reward a
    // complete pair enough that a high-pip duplicate cannot hide the stall.
    score += covered * 19;
    if (pairProduction.ore > 0) score += 22;
    if (pairProduction.wheat > 0) score += 18;
    const expansionCovered = (["wood", "brick", "sheep", "wheat"] as const)
      .filter((resource) => pairProduction[resource] > 0).length;
    score += expansionCovered * 12;
    if (expansionCovered === 4) score += 38;
  }
  return score;
}

export const setupSettlementPairScore = settlementPairScore;

function knightWouldTakeLargestArmy(state: GameState, id: string): boolean {
  const me = player(state, id);
  if (state.largestArmy === id || me.knightsPlayed + 1 < 3) return false;
  const strongestOther = Math.max(
    0,
    ...state.players.filter((p) => p.id !== id).map((p) => p.knightsPlayed),
  );
  return me.knightsPlayed + 1 > strongestOther;
}

export function forcedWin(state: GameState): Action | null {
  const acts = legalActions(state);
  for (const a of acts) {
    if (a.type === "BUILD_CITY" || a.type === "BUILD_SETTLEMENT") {
      const p = player(state, a.player);
      // A city replaces a settlement, so it is a one-VP increase (2 VP on
      // the city minus the settlement's existing 1 VP), not a two-VP swing.
      // Treating it as +2 can fire this layer one turn too early and send the
      // bot into a non-winning city while an award or second build was still
      // required.
      const gain = a.type === "BUILD_CITY" ? 1 : 1;
      if (totalVP(state, p.id) + gain >= state.config.victoryPoints) return a;
    }
    if (a.type === "BUILD_ROAD" && state.longestRoad !== a.player) {
      if (totalVP(state, a.player) + 2 >= state.config.victoryPoints) {
        const len = roadLength(state, a.player);
        const held = state.longestRoad ? roadLength(state, state.longestRoad) : 4;
        if (len + 1 > held && len + 1 >= 5) return a;
      }
    }
    if (a.type === "PLAY_KNIGHT" && knightWouldTakeLargestArmy(state, a.player)) {
      // Largest Army is a hidden two-VP swing just like Longest Road. A
      // third knight can be the immediate win even when no city or house is
      // payable, so it belongs in the forced-win layer.
      if (totalVP(state, a.player) + 2 >= state.config.victoryPoints) return a;
    }
  }
  return null;
}

function oneTurnVpCeiling(state: GameState, id: string): number {
  const p = player(state, id);
  let ceiling = totalVP(state, id);
  // Building a city upgrades an existing settlement: the net VP gain is one.
  if (p.settlements.length > 0 && canPay(p.hand, COSTS.city)) ceiling = Math.max(ceiling, totalVP(state, id) + 1);
  if (
    p.settlements.length < 5 &&
    p.settlements.length + p.cities.length < 9 &&
    canPay(p.hand, COSTS.settlement) &&
    settlementSpots(state, p, false).length > 0
  ) {
    ceiling = Math.max(ceiling, totalVP(state, id) + 1);
  }
  if (p.devs.knight > 0 && p.knightsPlayed === 2) ceiling = Math.max(ceiling, totalVP(state, id) + 2);

  if (canPay(p.hand, COSTS.road) && state.longestRoad !== id) {
    const held = state.longestRoad ? roadLength(state, state.longestRoad) : 4;
    const canTakeRoad = roadSpots(state, p).some((edge) => {
      const next = cloneState(state);
      const nextP = player(next, id);
      nextP.roads.push(edge);
      return roadLength(next, id) >= 5 && roadLength(next, id) > held;
    });
    if (canTakeRoad) ceiling = Math.max(ceiling, totalVP(state, id) + 2);
  }
  return ceiling;
}

function defensiveThreatDelta(state: GameState, action: Action): number {
  const us = action.player;
  const target = state.config.victoryPoints;
  const opponents = state.players.filter((p) => p.id !== us);
  const before = Math.max(0, ...opponents.map((p) => oneTurnVpCeiling(state, p.id)));
  const visibleDanger = opponents.some((opponent) => opponentIsDangerous(state, opponent.id));
  // Do not spend extra graph/simulation time until an opponent is close
  // enough that denying their next build can change the winner.
  if (before < target - 3 && !visibleDanger) return 0;
  if (![
    "BUILD_SETTLEMENT",
    "BUILD_CITY",
    "BUILD_ROAD",
    "MOVE_ROBBER",
    "ACCEPT_TRADE",
    "MARITIME_TRADE",
  ].includes(action.type)) return 0;
  try {
    const after = cloneState(state);
    applyAction(after, action, () => 0.5);
    const afterCeiling = Math.max(0, ...after.players
      .filter((p) => p.id !== us)
      .map((p) => oneTurnVpCeiling(after, p.id)));
    const reduced = before - afterCeiling;
    if (reduced <= 0) return 0;
    const winBlock = afterCeiling < target && before >= target ? 70 : 0;
    const nearBlock = afterCeiling < target - 1 && before >= target - 1 ? 35 : 0;
    return reduced * 28 + winBlock + nearBlock;
  } catch {
    return 0;
  }
}

/**
 * Public VP alone understates an opponent who is one road/award swing away
 * from the target.  Live Colonist hides their resource hand and VP cards, so
 * use the visible board structure as the threat signal: a player at 7 VP
 * with four roads, five settlements, or a city engine deserves denial now,
 * not after the win screen appears.
 */
function opponentIsDangerous(state: GameState, id: string): boolean {
  const p = player(state, id);
  const target = state.config.victoryPoints;
  const visible = visibleVP(state, id);
  const potentialRoadAward = state.longestRoad === id ? 0 : roadLength(state, id) >= 4 ? 2 : 0;
  const potentialArmyAward = state.largestArmy === id ? 0 : p.knightsPlayed >= 2 ? 2 : 0;
  if (visible + potentialRoadAward + potentialArmyAward >= target - 1) return true;
  if (visible >= target - 3) return true;
  // In a four-player game the public board can hide a development VP, and an
  // award holder can be one turn from the win without looking like the raw
  // settlement/city leader. Treat a developed award threat as dangerous one
  // point earlier so the robber and road-cut branches start denying before
  // the final turn. This is intentionally structure-gated: it does not make
  // every player at 6 VP a target.
  if (visible >= target - 4 && (
    roadLength(state, id) >= 4 ||
    p.knightsPlayed >= 2 ||
    p.settlements.length >= 4 ||
    p.cities.length >= 2
  )) return true;
  return roadLength(state, id) >= 6 || p.knightsPlayed >= 3;
}

/**
 * A small post-action position model borrowed from the useful part of the
 * Catanatron value player: score the state after the move, not only the
 * label attached to the move.  This catches the difference between a city on
 * a productive wheat/ore corner and a city that merely satisfies the cost,
 * and between a road that opens settlement production and a road that only
 * lengthens an unsecured chain.
 */
function positionValue(state: GameState, id: string): number {
  const me = player(state, id);
  const prod = production(state, id);
  const opponents = state.players.filter((p) => p.id !== id);
  const ownProduction = prod.wood + prod.brick + prod.sheep * 0.9 + prod.wheat * 1.15 + prod.ore * 1.1;
  const enemyProduction = opponents.reduce((sum, opponent) => {
    const theirs = production(state, opponent.id);
    return sum + theirs.wood + theirs.brick + theirs.sheep * 0.9 + theirs.wheat * 1.15 + theirs.ore * 1.1;
  }, 0);
  const cityDistance = (Math.max(0, COSTS.city.wheat - me.hand.wheat) + Math.max(0, COSTS.city.ore - me.hand.ore)) / 5;
  const settlementDistance = (
    Math.max(0, COSTS.settlement.wood - me.hand.wood) +
    Math.max(0, COSTS.settlement.brick - me.hand.brick) +
    Math.max(0, COSTS.settlement.sheep - me.hand.sheep) +
    Math.max(0, COSTS.settlement.wheat - me.hand.wheat)
  ) / 4;
  const handSynergy = (2 - cityDistance - settlementDistance) / 2;
  const ownedHexes = new Set<string>();
  for (const vertex of [...me.settlements, ...me.cities]) {
    for (const hex of state.board.vertices[vertex]?.hexes ?? []) ownedHexes.add(hex);
  }
  const devCount = me.devs.knight + me.devs.monopoly + me.devs.year_of_plenty + me.devs.road_building + me.devs.vp;
  return totalVP(state, id) * 44
    + ownProduction * 2.2
    - enemyProduction * 0.22
    + settlementSpots(state, me, false).length * 0.7
    + bestReachableSettlementValue(state, id) * 0.08
    + ownedHexes.size * 0.25
    + roadLength(state, id) * 0.22
    + handSynergy * 8
    + handSize(me) * 0.08
    + devCount * 1.4
    + me.knightsPlayed * 1.1;
}

function postActionPositionDelta(state: GameState, action: Action): number {
  if (["ROLL", "END_TURN", "DISCARD", "STEAL"].includes(action.type)) return 0;
  try {
    const before = positionValue(state, action.player);
    const after = cloneState(state);
    applyAction(after, action, () => 0.5);
    return positionValue(after, action.player) - before;
  } catch {
    return 0;
  }
}

export function heuristicScore(state: GameState, action: Action): number {
  const us = action.player;
  const me = player(state, us);
  let s = 0;
  const myProd = production(state, us);
  const opp = state.players.filter((p) => p.id !== us);
  const oppVp = Math.max(0, ...opp.map((p) => totalVP(state, p.id)));
  const myVp = totalVP(state, us);
  const endgame = myVp >= state.config.victoryPoints - 4 || oppVp >= state.config.victoryPoints - 4;
  const opponentNearWin = opp.some((p) => opponentIsDangerous(state, p.id));
  const funnel = thirdSettlementFunnel(state, us);

  // Add a direct win-sequence defense layer before operation-specific
  // heuristics.  A good self-build is still secondary when a settlement,
  // road cut, or other legal action removes an opponent's immediate VP path.
  s += defensiveThreatDelta(state, action);
  s += postActionPositionDelta(state, action);

  switch (action.type) {
    case "PLACE_SETTLEMENT":
    case "BUILD_SETTLEMENT": {
      s += 40;
      if (action.vertex) {
        if (state.phase === "setup_settle" && action.type === "PLACE_SETTLEMENT") {
          // The opening pick is a package: value the likely reverse-order
          // complement and the high-value spot this pick removes from rivals.
          s += me.settlements.length === 0
            ? settlementPairScore(state, action)
            : setupSecondSettlementScore(state, us, action.vertex);
        } else {
          s += settlementSpotValue(state, us, action.vertex);
          const v = state.board.vertices[action.vertex];
          for (const o of opp) {
            const shares = v.hexes.some((hx) =>
              state.board.hexes[hx].vertices.some((vid) => o.settlements.includes(vid) || o.cities.includes(vid)),
            );
            if (shares) s += 6;
          }
        }
        const v = state.board.vertices[action.vertex];
        // settlementSpotValue already prices a port against the production it
        // can actually convert; keep only a small execution tie-break here.
        if (v.port) s += v.port.ratio === 2 ? 2 : 1;
      }
      if (me.settlements.length + me.cities.length === 2) s += 10;
      if (me.settlements.length + me.cities.length === 2) s += 8;
      else if (me.settlements.length + me.cities.length === 3) s += 4;
      break;
    }
    case "PLACE_ROAD":
    case "BUILD_ROAD": {
      s += action.type === "PLACE_ROAD" ? 10 : 8;
      const roadValue = roadExpansionScore(state, action);
      s += roadValue;
      const lrPlan = longestRoadPlanScore(state, action);
      s += lrPlan.value;
      if (action.type === "BUILD_ROAD" && state.longestRoad === us && !lrPlan.defendNow) {
        // A holder with a safe margin should convert the hand into VP,
        // production, or dev-card tempo instead of spending another road on
        // a vanity extension. Only an actual rival-length threat can reopen
        // this branch.
        s -= 28;
      }
      if (action.type === "BUILD_ROAD") {
        const secureAwardSwing = (lrPlan.claimNow && lrPlan.secureNow) || lrPlan.defendNow;
        const canBuyDev = state.deck.length > 0 && canPay(me.hand, COSTS.dev);
        // Roads are an investment, not a default resource sink. Once the
        // player has a network of four or more, make the policy prove that
        // the next edge creates a real settlement route or a defensible LR
        // swing. This is the opportunity-cost layer that stops attractive
        // frontier geometry from consuming the wheat/sheep/ore needed for
        // cities and development cards.
        if (!secureAwardSwing) {
          if (me.roads.length >= 4) s -= 32;
          if (me.roads.length >= 6) s -= 45;
          if (me.roads.length >= 8) s -= 55;
          if (canBuyDev) s -= 22;
          if (!lrPlan.claimSoon) s -= 28;
          if (!lrPlan.claimSoon && roadValue < 52) s -= 18;
          // Preserve a near-complete conversion hand. The missing card may
          // arrive from the next roll or a one-card trade; spending wood and
          // brick on a road here throws away a city/settlement tempo.
          const cityMissing = costDistance(me.hand, COSTS.city);
          const settlementMissing = costDistance(me.hand, COSTS.settlement);
          if (cityMissing <= 1) s -= 34;
          if (settlementMissing <= 1) s -= 30;
        }
        const canBuildSettlement =
          me.settlements.length + me.cities.length < 9 &&
          me.settlements.length < 5 &&
          canPay(me.hand, COSTS.settlement) &&
          settlementSpots(state, me, false).length > 0;
        if (canBuildSettlement) {
          // A house is the direct VP/production action.  Yield to it unless
          // this road is an immediate, secure Longest Road award/defense.
          const bestHouse = bestReachableSettlementValue(state, us);
          s -= 34;
          if (!secureAwardSwing) {
            s -= 24;
            if (roadValue < bestHouse + 24) s -= 18;
          }
        }
        const canBuildCity = me.cities.length < 4 && me.settlements.length > 0 && canPay(me.hand, COSTS.city);
        if (canBuildCity) s -= 22;
        if (funnel.active && !secureAwardSwing) {
          const routeAfter = settlementRouteAfterRoad(state, action);
          if (routeAfter > 0 && funnel.reachableValue <= 0) {
            // This is the useful road: it immediately turns the network into
            // a legal third-settlement route.  Let it beat a passive dev
            // purchase even when the house still needs one more roll/trade.
            s += 34 + routeAfter * 0.22;
          } else if (routeAfter <= 0 && funnel.reachableValue <= 0) {
            // A road that still does not expose a house is speculation during
            // the two-settlement phase.  It must prove a secure award swing
            // before taking priority over the conversion funnel.
            s -= 24;
          }
        }
      }
      for (const rival of opp) {
        if (!roadSpots(state, rival).includes(action.edge!)) continue;
        const rivalLen = roadLength(state, rival.id);
        // A cut is much more valuable when the rival is one road from the
        // award or one award away from winning. This is the table-level
        // denial that raw road length misses.
        if (rivalLen >= 4) s += 14;
        if (opponentIsDangerous(state, rival.id)) s += 22;
      }
      if (endgame) s += 10;
      break;
    }
    case "BUILD_CITY": {
      s += 55;
      if (action.vertex) {
        const v = state.board.vertices[action.vertex];
        for (const hid of v.hexes) {
          const h = state.board.hexes[hid];
          const res = resourceOf(h);
          const pips = h.number ? PIP[h.number] : 0;
          s += pips * 4;
          if (res === "wheat" || res === "ore") s += pips * 3;
        }
      }
      break;
    }
    case "BUY_DEV":
      s += 18;
      if (myProd.ore + myProd.wheat + myProd.sheep >= 10) s += 8;
      if (me.knightsPlayed >= 2) s += 12;
      if (me.devs.knight + me.devs.monopoly + me.devs.year_of_plenty + me.devs.road_building === 0) s += 6;
      // Devs are the right conversion when expansion is currently blocked,
      // but should not outrank an immediately payable house/city just because
      // the hand happens to contain sheep-wheat-ore.
      if (settlementSpots(state, me, false).length === 0) s += 8;
      if (endgame) s += 10;
      if (funnel.active) {
        // A dev card is a secondary conversion while the player still has
        // only the opening pair.  In particular, spending sheep/wheat/ore
        // for a card while missing wood/brick creates the long stalls seen in
        // the losing traces.  Keep the card available when the route is
        // blocked, but make it lose to a real expansion route.
        if (funnel.missing <= 2 && funnel.reachableValue > 0) s -= 48;
        else if (funnel.missing <= 3 && (funnel.reachableValue > 0 || funnel.bestRoadRoute > 0)) s -= 28;
        else if (funnel.missing <= 3) s -= 12;
      }
      break;
    case "PLAY_KNIGHT": {
      s += 12;
      const strongestOpponent = opp
        .slice()
        .sort((a, b) => totalVP(state, b.id) - totalVP(state, a.id))[0];
      if (me.knightsPlayed === 2) s += 24;
      if (knightWouldTakeLargestArmy(state, us)) {
        s += 70;
        if (totalVP(state, us) + 2 >= state.config.victoryPoints) s += 100;
      }
      if (strongestOpponent && opponentIsDangerous(state, strongestOpponent.id)) s += 18;
      if (strongestOpponent) {
        const targetPressure = Math.max(...RESOURCES.map((r) => resourcePressure(state, strongestOpponent.id, r)));
        s += targetPressure * 4;
      }
      const robberValue = bestRobberValueAfterKnight(state, us);
      s += Math.max(0, robberValue - 20) * 0.22;
      if (robberValue < 20 && me.knightsPlayed < 2) s -= 16;
      if (!strongestOpponent && me.knightsPlayed === 0) s -= 8;
      break;
    }
    case "MOVE_ROBBER": {
      s += 15;
      if (action.hex) {
        const h = state.board.hexes[action.hex];
        const pips = h.number ? PIP[h.number] : 0;
        const res = resourceOf(h);
        let theirs = 0;
        let ours = 0;
        for (const vid of h.vertices) {
          for (const pl of state.players) {
            const n = pl.cities.includes(vid) ? 2 : pl.settlements.includes(vid) ? 1 : 0;
            if (!n) continue;
              if (pl.id === us) ours += n * pips;
            else {
              const pressure = res ? resourcePressure(state, pl.id, res) : 0;
              theirs += n * pips * (res === "wheat" || res === "ore" ? 1.4 : 1) * (1 + pressure * 0.42);
              if (pressure >= 1.5) s += n * 4;
              // A hidden hand is not evidence that a visible 8/10-point
              // opponent has nothing. When the robber can interrupt that
              // opponent's productive tile, denial is worth more than the
              // ordinary pip/steal estimate.
              if (opponentIsDangerous(state, pl.id)) {
                theirs += n * pips * 3;
                s += n * 10;
              }
            }
          }
        }
        s += theirs * 4 - ours * 5;
      }
      if (action.stealFrom) s += opponentNearWin ? 22 : 6;
      break;
    }
    case "PLAY_MONOPOLY":
      s += 20;
      if (action.resource) {
        const held = opp.reduce((n, o) => n + o.hand[action.resource as Resource], 0);
        s += held * 8;
        // Opponent resource identities are usually hidden in live Colonist
        // state. Production and unknown-hand size are the best available
        // estimate of what a Monopoly can actually take, especially when a
        // public near-win makes tempo denial more important than another
        // passive build turn.
        const resource = action.resource as Resource;
        const productionThreat = opp.reduce(
          (n, o) => n + production(state, o.id)[resource] * (opponentIsDangerous(state, o.id) ? 2 : 1),
          0,
        );
        s += productionThreat * (opponentNearWin ? 2.5 : 1.2);
        s += Math.min(20, opp.reduce((n, o) => n + o.hidden.unknown, 0) * (opponentNearWin ? 1.5 : 0.5));
        if (opponentNearWin) s += 45;
      }
      break;
    case "PLAY_ROAD_BUILDING":
      s += roadBuildingValue(state, us);
      if (endgame) s += 12;
      break;
    case "PLAY_YEAR_OF_PLENTY": {
      if (action.resources?.length || action.resource) {
        s += yearOfPlentyActionValue(state, action);
      } else {
        s += yearOfPlentyValue(state, us);
      }
      break;
    }
    case "ACCEPT_TRADE": {
      const o = state.pendingOffer;
      s += 10;
      if (o) {
        const after = afterSwap(me.hand, o.get, o.getCount, o.give, o.giveCount);
        const unlock = unlockLabel(me.hand, after);
        const settlementMissingBefore = costDistance(me.hand, COSTS.settlement);
        const settlementMissingAfter = costDistance(after, COSTS.settlement);
        const settlementProgress = settlementMissingBefore - settlementMissingAfter;
        s += strategicTradeValue(state, us, me.hand, after, o.give);
        if (funnel.active) {
          // Player offers are the scarce-resource valve in the two-building
          // phase. A one-card brick/sheep/wood gain can be more valuable than
          // preserving the card the opponent requested because it turns an
          // otherwise stalled road into the third house. The old response
          // path mostly priced the opponent's next build and rejected these
          // offers, leaving the bot with two houses and no expansion card.
          if ((o.give === "wood" || o.give === "brick" || o.give === "sheep" || o.give === "wheat") && me.hand[o.give] < COSTS.settlement[o.give]) {
            s += 20;
          }
          if (settlementProgress > 0) s += 18 + settlementProgress * 8;
          if (canPay(after, COSTS.settlement) && settlementSpots(state, me, false).length > 0) s += 46;
        }
        if (unlock === "city") s += 48;
        else if (unlock === "settlement") s += 36;
        else if (unlock === "dev card") s += 24;
        else if (unlock === "road") s += 16;
        if (funnel.active) {
          // In the two-building expansion phase, a trade that unlocks a road
          // or house is worth more than one that merely unlocks a dev card.
          // The latter was a live/simulator failure: ore -> sheep completed a
          // dev-card hand, while ore -> brick completed the road needed for
          // the third settlement.
          if (unlock === "settlement") s += 26;
          else if (unlock === "road") s += 22;
          else if (unlock === "dev card") s -= 18;
        }
        if (o.give === "wheat" || o.give === "ore") s += 8;
        if ((o.get === "wheat" || o.get === "ore") && !unlock && strategicTradeValue(state, us, me.hand, after, o.give) < 8) s -= 12;
        const senderUnlock = opponentTradeUnlock(state, o);
        const ownExpansionTrade = funnel.active && settlementProgress > 0;
        if (senderUnlock === "city") s -= ownExpansionTrade ? 14 : 36;
        else if (senderUnlock === "settlement") s -= ownExpansionTrade ? 10 : 28;
        else if (senderUnlock === "dev card") s -= ownExpansionTrade ? 8 : 18;
        else if (senderUnlock === "road") s -= ownExpansionTrade ? 5 : 12;
        if (senderUnlock && opponentIsDangerous(state, o.from)) s -= 14;
        if (after[o.get] < 0) s -= 40;
      }
      break;
    }
    case "REJECT_TRADE":
      s += 7;
      if (state.pendingOffer && (state.pendingOffer.get === "wheat" || state.pendingOffer.get === "ore")) s += 10;
      break;
    case "MARITIME_TRADE": {
      s += 4;
      const give = action.give;
      const get = action.get;
      const n = action.giveCount ?? 4;
      if (give && get) {
        const after = afterSwap(me.hand, give, n, get, 1);
        const unlock = unlockLabel(me.hand, after);
        if (unlock === "city") s += 44;
        else if (unlock === "settlement") s += 34;
        else if (unlock === "dev card") s += 22;
        else if (unlock === "road") s += 14;
        if (funnel.active) {
          if (unlock === "settlement") s += 26;
          else if (unlock === "road") s += 22;
          else if (unlock === "dev card") s -= 18;

          // When the opening pair is stalled, an immediately payable dev card
          // is not automatically the best conversion. If both road resources
          // are currently empty and no house is reachable, keep the trade
          // aimed at wood/brick so the next roll can restore the expansion
          // lane. This fixes the recurring wheat -> ore -> dev loop that left
          // the bot with cities but no legal third settlement.
          const expansionResource = get !== "ore";
          const roadBottleneck = me.hand.wood <= 0 && me.hand.brick <= 0 && bestReachableSettlementValue(state, us) <= 0;
          if (roadBottleneck && !expansionResource) s -= 34;
          if (roadBottleneck && (get === "wood" || get === "brick")) {
            s += 24;
            const otherRoad = get === "wood" ? "brick" : "wood";
            const prod = production(state, us);
            // Take the less-produced road card first; the board is more likely
            // to supply the complementary card on the next roll.
            s += Math.max(0, prod[otherRoad] - prod[get]) * 0.65;
          }
          if (get === "sheep" && me.hand.sheep < COSTS.settlement.sheep) s += 12;
        }

        // A trade is often the preparatory move for a settlement already
        // reachable from the existing road network. Value that one-turn
        // route explicitly so the bot does not spend the same tempo extending
        // roads toward a less-secure future house.
        const reachableHouse = bestReachableSettlementValue(state, us);
        if (reachableHouse > 0) {
          const beforeMissing = RESOURCES.reduce(
            (sum, resource) => sum + Math.max(0, COSTS.settlement[resource] - me.hand[resource]),
            0,
          );
          const afterMissing = RESOURCES.reduce(
            (sum, resource) => sum + Math.max(0, COSTS.settlement[resource] - after[resource]),
            0,
          );
          const progress = beforeMissing - afterMissing;
          s += reachableHouse * 0.22;
          if (canPay(after, COSTS.settlement)) s += 62 + reachableHouse * 0.3;
          else if (progress > 0) s += progress * 12 + reachableHouse * 0.08;
        }
        if (get === "wheat" || get === "ore") s += 6;
        if (get === "brick" || get === "wood") s += 3;
        if (funnel.active) {
          const beforeMissing = costDistance(me.hand, COSTS.settlement);
          const afterMissing = costDistance(after, COSTS.settlement);
          const progress = beforeMissing - afterMissing;
          if (progress > 0) s += 20 + progress * 12;
          if (canPay(after, COSTS.settlement) && settlementSpots(state, me, false).length > 0) s += 48;
          if (progress <= 0 && funnel.reachableValue <= 0 && funnel.bestRoadRoute <= 0) s -= 10;
        }
      }
      break;
    }
    case "ROLL":
      s += 5;
      if (handSize(me) > state.config.discardLimit && !me.devs.knight) s += 20;
      break;
    case "END_TURN":
      s -= 2;
      if (handSize(me) > state.config.discardLimit) s -= 15;
      break;
    case "DISCARD": {
      const d = action.discard ?? {};
      s += 5;
      for (const r of RESOURCES) {
        const n = d[r] ?? 0;
        if (r === "wheat" || r === "ore") s -= n * 3;
        else s -= n;
      }
      break;
    }
    default:
      s += 1;
  }
  s += profileBias(state, action);
  if (visibleVP(state, us) >= 11) s += action.type.startsWith("BUILD") ? 8 : 0;
  return s;
}

export const OPERATION_RULES = `Pick the legal operation that most increases P(we reach the VP target before any opponent).
Colonist ranked 1v1 is 15 VP, discard 9, friendly robber; 4p is 10 VP, discard 7.
Never pick a move just because it is conventional. Prefer tempo, denial, and win-sequence over raw pips.
Forced wins and opponent-win interruptions beat every other consideration.
Opening setup: prefer a two-settlement pair with wheat and at least two expansion resources; do not choose a high-pip wheatless pair when a viable wheat corner exists.
City upgrades a settlement for +1 net VP; a settlement is +1; Longest Road/Largest Army are +2 only when the award is actually secure.
Roads are a means to an open, valuable settlement or a secure award/cut, not a default way to spend wood and brick. If the opening pair has no reachable house and both road cards are empty, trade toward wood/brick before buying a dev card for a merely convenient conversion.
Endgame: when our win route needs two VP or fewer, take a legal city/settlement before a slower road, dev purchase, trade, or end turn unless the latter directly blocks an opponent's immediate win.`;

export const TARGET_RULES = `Pick the target that matches the chosen operation.
Prefer scarce wheat/ore, blocking the opponent's next build, ports that convert excess, and road cuts that steal Longest Road.
Robber: attack the resource they need next, not their historically strongest tile.`;
