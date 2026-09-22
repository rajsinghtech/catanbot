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

type DoctrineMemo = {
  signature: string;
  values: Map<string, unknown>;
};

const doctrineMemos = new WeakMap<GameState, DoctrineMemo>();

function doctrineStateSignature(state: GameState): string {
  return [
    state.phase,
    state.current,
    state.turn,
    state.robberHex,
    state.pendingOffer?.id ?? "",
    ...state.players.map((p) => [
      p.id,
      p.hand.wood,
      p.hand.brick,
      p.hand.sheep,
      p.hand.wheat,
      p.hand.ore,
      p.settlements.join(","),
      p.cities.join(","),
      p.roads.join(","),
      p.knightsPlayed,
    ].join(":")),
  ].join("|");
}

function doctrineMemo<T>(state: GameState, key: string, compute: () => T): T {
  const signature = doctrineStateSignature(state);
  let memo = doctrineMemos.get(state);
  if (!memo || memo.signature !== signature) {
    memo = { signature, values: new Map() };
    doctrineMemos.set(state, memo);
  }
  if (memo.values.has(key)) return memo.values.get(key) as T;
  const value = compute();
  memo.values.set(key, value);
  return value;
}

export function canPay(h: Hand, cost: Hand): boolean {
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

function openingResourceSources(state: GameState, vertices: string[]): Record<Resource, Set<string>> {
  const out = Object.fromEntries(RESOURCES.map((resource) => [resource, new Set<string>()])) as Record<Resource, Set<string>>;
  for (const vertex of vertices) {
    for (const hid of state.board.vertices[vertex]?.hexes ?? []) {
      const hex = state.board.hexes[hid];
      const resource = resourceOf(hex);
      if (!resource || hex.number == null) continue;
      out[resource].add(hid);
    }
  }
  return out;
}

function independentResourcePips(
  state: GameState,
  vertex: string,
  resource: Resource,
  excludedHexes: Set<string>,
): number {
  return (state.board.vertices[vertex]?.hexes ?? []).reduce((sum, hid) => {
    if (excludedHexes.has(hid)) return sum;
    const hex = state.board.hexes[hid];
    return resourceOf(hex) === resource && hex.number != null ? sum + (PIP[hex.number] ?? 0) : sum;
  }, 0);
}

/**
 * A high-pip opening resource on one hex is still a single point of failure:
 * one robber move can erase the city/dev engine. Reward a second independent
 * source and penalize a fragile one only when the remaining setup board has a
 * real alternative. This keeps forced weak maps playable while preferring the
 * resilient pair a competitive player would choose.
 */
export function openingResourceResilience(state: GameState, id: string, vertices: string[]): number {
  const sources = openingResourceSources(state, vertices);
  const open = settlementSpots(state, player(state, id), true);
  let score = 0;
  for (const resource of RESOURCES) {
    const source = sources[resource];
    if (source.size >= 2) {
      score += resource === "wheat" || resource === "ore" ? 22 : 8;
      continue;
    }
    if (source.size !== 1) continue;
    const alternative = open.some((candidate) => independentResourcePips(state, candidate, resource, source) > 0);
    if (!alternative) continue;
    if (resource === "ore") score -= 66;
    else if (resource === "wheat") score -= 58;
    else score -= 12;
  }
  return score;
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

/**
 * A player offer is also a move for the other seat.  The sender is visible in
 * the live offer projection, but their exact hand usually is not, so price the
 * counterparty from both sources: known-card unlocks and the public board
 * position/resource pressure that explains why they requested this card.
 * This keeps an offer from a near-win city/road player from looking like a
 * generic one-for-one swap.
 */
function opponentTradePositionPressure(state: GameState, offer: NonNullable<GameState["pendingOffer"]>): number {
  const sender = player(state, offer.from);
  let pressure = 0;
  const threat = opponentThreatScore(state, sender.id);
  if (threat > 0) pressure += threat * 0.2;
  if (opponentIsDangerous(state, sender.id)) pressure += 14;

  // The requested card is the best public clue to the sender's immediate
  // route. A wheat/ore request from a player with settlements/cities is often
  // a city hinge; wood/brick/sheep/wheat is usually an expansion hinge.
  pressure += resourcePressure(state, sender.id, offer.get) * 8;
  if ((offer.get === "wheat" || offer.get === "ore") && sender.settlements.length > 0) pressure += 8;
  if ((offer.get === "wood" || offer.get === "brick" || offer.get === "sheep" || offer.get === "wheat") &&
    sender.settlements.length < 5 && settlementSpots(state, sender, false).length > 0) {
    pressure += 7;
  }
  if ((offer.get === "wood" || offer.get === "brick") && roadLength(state, sender.id) >= 3) pressure += 6;

  // When the sender's resource cards are known, compare their actual one-turn
  // ceiling after the swap. Hidden opponent cards remain covered by the
  // public-pressure terms above rather than being guessed as zero.
  if (sender.hand[offer.give] >= offer.giveCount) {
    const afterState = cloneState(state);
    const afterSender = player(afterState, sender.id);
    afterSender.hand = afterSwap(sender.hand, offer.give, offer.giveCount, offer.get, offer.getCount);
    const ceilingDelta = oneTurnVpCeiling(afterState, sender.id) - oneTurnVpCeiling(state, sender.id);
    if (ceilingDelta > 0) pressure += ceilingDelta * 24;
    const unlock = opponentTradeUnlock(state, offer);
    if (unlock === "city") pressure += 26;
    else if (unlock === "settlement") pressure += 22;
    else if (unlock === "road") pressure += 12;
    else if (unlock === "dev card") pressure += 8;
  }
  return pressure;
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

function ownRobberBlockValue(state: GameState, id: string): { value: number; resource: Resource | null } {
  const hex = state.board.hexes[state.robberHex];
  const resource = hex ? resourceOf(hex) : null;
  if (!hex || !resource || hex.number == null) return { value: 0, resource };
  const pips = PIP[hex.number] ?? 0;
  const me = player(state, id);
  const units = hex.vertices.reduce((sum, vertex) => {
    if (me.cities.includes(vertex)) return sum + 2;
    if (me.settlements.includes(vertex)) return sum + 1;
    return sum;
  }, 0);
  const weight = resource === "wheat" || resource === "ore" ? 1.7 : 1;
  return { value: units * pips * weight, resource };
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

function newReachableSettlementValue(state: GameState, id: string, before: Set<string>): number {
  const spots = settlementSpots(state, player(state, id), false)
    .filter((vertex) => !before.has(vertex));
  return Math.max(0, ...spots.map((vertex) => settlementSpotValue(state, id, vertex)));
}

/**
 * The first two settlements are the opening; the next settlement run is the
 * expansion funnel. A common weak-game pattern is to have two or three
 * houses, pay the wood/brick needed to point a road somewhere, then spend
 * the remaining wheat/sheep/ore on dev cards before the next house exists.
 * Keep the policy aware of whether a road actually creates a reachable
 * settlement so this phase is treated as a conversion problem rather than a
 * raw road race.
 */
function settlementRouteAfterRoadUncached(state: GameState, action: Action): number {
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

export function settlementRouteAfterRoad(state: GameState, action: Action): number {
  return doctrineMemo(state, `route1:${action.id}:${action.edge ?? ""}`, () =>
    settlementRouteAfterRoadUncached(state, action));
}

/**
 * A first approach road can be strategically correct even when it does not
 * expose a settlement immediately. Look one legal road farther, but only on
 * the bounded frontier created by the candidate; this keeps the live policy
 * fast while avoiding the old one-ply road veto.
 */
function settlementRouteAfterRoadsUncached(state: GameState, action: Action, maxRoads: number): number {
  if (action.type !== "BUILD_ROAD" || !action.edge) return 0;
  try {
    // Only count intersections opened by this candidate. Using the whole
    // post-action network here made an unrelated old house route prove every
    // new road, including an edge that pointed into an opponent-occupied
    // dead zone.
    const beforeReachable = new Set(settlementSpots(state, player(state, action.player), false));
    const first = cloneState(state);
    applyAction(first, action, () => 0.5);
    let best = newReachableSettlementValue(first, action.player, beforeReachable);
    let frontier = [first];
    for (let depth = 1; depth < maxRoads; depth += 1) {
      const next: GameState[] = [];
      for (const node of frontier) {
        const candidates = legalActions(node)
          .filter((candidate) => candidate.type === "BUILD_ROAD" && candidate.player === action.player)
          .sort((a, b) => roadExpansionScore(node, b) - roadExpansionScore(node, a))
          .slice(0, 6);
        for (const candidate of candidates) {
          try {
            const after = cloneState(node);
            applyAction(after, candidate, () => 0.5);
            best = Math.max(best, newReachableSettlementValue(after, action.player, beforeReachable));
            next.push(after);
          } catch {
            // A stale/partial board should simply remove this branch from the
            // bounded forecast; it must never make a road look more valuable.
          }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return Math.max(0, best);
  } catch {
    return 0;
  }
}

function settlementRouteAfterRoads(state: GameState, action: Action, maxRoads: number): number {
  return doctrineMemo(state, `route:${maxRoads}:${action.id}:${action.edge ?? ""}`, () =>
    settlementRouteAfterRoadsUncached(state, action, maxRoads));
}

/**
 * The route value above intentionally ignores hand shape so it can compare
 * future intersections. The live decision guard also needs a harder proof:
 * after the bounded road sequence, is a settlement actually payable at one
 * of those reachable intersections? Without this check the bot can trade
 * into a pretty road chain, spend two or three pairs, and still have no
 * house—the repeated two-settlement loss pattern.
 */
function settlementRouteCanPayAfterRoadsUncached(state: GameState, action: Action, maxRoads: number): boolean {
  if (action.type !== "BUILD_ROAD" || !action.edge) return false;
  try {
    const beforeReachable = new Set(settlementSpots(state, player(state, action.player), false));
    const first = cloneState(state);
    applyAction(first, action, () => 0.5);
    let frontier = [first];
    for (let depth = 0; depth < maxRoads; depth += 1) {
      for (const node of frontier) {
        if (legalActions(node).some((candidate) =>
          candidate.type === "BUILD_SETTLEMENT" && candidate.vertex && !beforeReachable.has(candidate.vertex),
        )) return true;
      }
      if (depth + 1 >= maxRoads) break;
      const next: GameState[] = [];
      for (const node of frontier) {
        const candidates = legalActions(node)
          .filter((candidate) => candidate.type === "BUILD_ROAD" && candidate.player === action.player)
          .sort((a, b) => roadExpansionScore(node, b) - roadExpansionScore(node, a))
          .slice(0, 6);
        for (const candidate of candidates) {
          try {
            const after = cloneState(node);
            applyAction(after, candidate, () => 0.5);
            next.push(after);
          } catch {
            // Ignore malformed/stale branches; another legal route may still
            // establish the payable-house proof.
          }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
  } catch {
    return false;
  }
  return false;
}

export function settlementRouteCanPayAfterRoads(state: GameState, action: Action, maxRoads: number): boolean {
  return doctrineMemo(state, `payroute:${maxRoads}:${action.id}:${action.edge ?? ""}`, () =>
    settlementRouteCanPayAfterRoadsUncached(state, action, maxRoads));
}

/**
 * A settlement route can be strategically live before its last card is in
 * hand. The old road guard treated "not payable this instant" as "not a
 * route", which made the bot pass on a strong frontier and then cycle
 * through 2:1 trades. Accept a bounded route when every missing settlement
 * card has a visible production or port source; this is still a concrete
 * conversion proof, not a generic invitation to chase Longest Road.
 */
function settlementRouteHasResourceSupportUncached(
  state: GameState,
  action: Action,
  maxRoads: number,
): boolean {
  if (action.type !== "BUILD_ROAD" || !action.edge) return false;
  try {
    const beforeReachable = new Set(settlementSpots(state, player(state, action.player), false));
    const first = cloneState(state);
    applyAction(first, action, () => 0.5);
    let frontier = [first];
    for (let depth = 0; depth < maxRoads; depth += 1) {
      for (const node of frontier) {
        if (newReachableSettlementValue(node, action.player, beforeReachable) <= 0) continue;
        if (settlementResourcesSupported(node, action.player)) return true;
      }
      if (depth + 1 >= maxRoads) break;
      const next: GameState[] = [];
      for (const node of frontier) {
        const candidates = legalActions(node)
          .filter((candidate) => candidate.type === "BUILD_ROAD" && candidate.player === action.player)
          .sort((a, b) => roadExpansionScore(node, b) - roadExpansionScore(node, a))
          .slice(0, 6);
        for (const candidate of candidates) {
          try {
            const after = cloneState(node);
            applyAction(after, candidate, () => 0.5);
            next.push(after);
          } catch {
            // Keep the bounded route forecast resilient to partial live maps.
          }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
  } catch {
    return false;
  }
  return false;
}

function settlementResourcesSupported(state: GameState, id: string): boolean {
  const me = player(state, id);
  const missing = RESOURCES.filter((resource) => me.hand[resource] < COSTS.settlement[resource]);
  if (missing.length > 3) return false;
  const prod = production(state, id);
  const ports = [...me.settlements, ...me.cities]
    .map((vertex) => state.board.vertices[vertex]?.port)
    .filter((port): port is NonNullable<typeof port> => Boolean(port));
  return missing.every((resource) => {
    if (prod[resource] > 0) return true;
    if (ports.some((port) => port.ratio === 2 && port.resource === resource)) {
      return RESOURCES.some((other) => other !== resource && me.hand[other] >= 4);
    }
    if (ports.some((port) => port.ratio === 3 && !port.resource)) {
      return handSize(me) - me.hand[resource] >= 3;
    }
    return false;
  });
}

export function settlementRouteHasResourceSupport(
  state: GameState,
  action: Action,
  maxRoads: number,
): boolean {
  return doctrineMemo(state, `supportroute:${maxRoads}:${action.id}:${action.edge ?? ""}`, () =>
    settlementRouteHasResourceSupportUncached(state, action, maxRoads));
}

export function settlementRouteAfterTwoRoads(state: GameState, action: Action): number {
  return settlementRouteAfterRoads(state, action, 2);
}

export function settlementRouteAfterThreeRoads(state: GameState, action: Action): number {
  return settlementRouteAfterRoads(state, action, 3);
}

export function settlementRouteAfterFourRoads(state: GameState, action: Action): number {
  return settlementRouteAfterRoads(state, action, 4);
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
  // plus one city as well. Once a third building exists, switch to the
  // city/development engine: continuing to value every fourth/fifth house as
  // an opening expansion made the bot trade a brick surplus into wood/sheep
  // while opponents converted wheat/ore into the final VP race.
  const buildingCount = me.settlements.length + me.cities.length;
  const active = buildingCount === 2;
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
function roadExpansionScoreUncached(state: GameState, action: Action): number {
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
    // Reaching an opponent's settlement is a hard stop. The candidate road
    // itself may legally terminate at that corner, but our network cannot
    // continue through it; expanding from this start was the dead-zone bug.
    const currentOwner = vertexOwner(after, current.vertex);
    if (currentOwner && currentOwner !== action.player) continue;
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
    // a tempo loss. It can still be legal, so penalize it heavily rather than
    // letting the raw road-length bonus turn a dead zone into the best edge.
    score -= 110;
  } else {
    score -= 8;
  }

  // Keep the frontier value on the same scale as a build action.  The raw
  // sum above intentionally looks at several possible future intersections;
  // using it unscaled made an ordinary road beat an immediately available
  // settlement or city simply because it had many theoretical paths.
  score *= 0.13;
  if (targets.length === 0) {
    const cutsOpponentFrontier = state.players
      .filter((p) => p.id !== action.player)
      .some((p) => roadSpots(state, p).includes(action.edge!));
    score -= cutsOpponentFrontier ? 8 : 28;
  }

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

export function roadExpansionScore(state: GameState, action: Action): number {
  return doctrineMemo(state, `road:${action.id}:${action.edge ?? ""}`, () =>
    roadExpansionScoreUncached(state, action));
}

function openSettlementVertex(state: GameState, vertex: string): boolean {
  if (!state.board.vertices[vertex] || vertexOwner(state, vertex)) return false;
  for (const edgeId of state.board.vertices[vertex].edges) {
    const edge = state.board.edges[edgeId];
    if (!edge) continue;
    const other = edge.vertices[0] === vertex ? edge.vertices[1] : edge.vertices[0];
    if (vertexOwner(state, other)) return false;
  }
  return true;
}

/** Minimum unbuilt roads from the player's existing network to each vertex. */
function roadNetworkDistances(state: GameState, id: string): Map<string, number> {
  const me = player(state, id);
  const distances = new Map<string, number>();
  const queue: Array<{ vertex: string; distance: number }> = [];
  const seed = (vertex: string) => {
    const owner = vertexOwner(state, vertex);
    if (owner && owner !== id) return;
    if (distances.get(vertex) === 0) return;
    distances.set(vertex, 0);
    queue.unshift({ vertex, distance: 0 });
  };

  for (const vertex of [...me.settlements, ...me.cities]) seed(vertex);
  for (const edgeId of me.roads) {
    for (const vertex of state.board.edges[edgeId]?.vertices ?? []) seed(vertex);
  }

  while (queue.length) {
    const current = queue.shift()!;
    if (current.distance !== distances.get(current.vertex)) continue;
    for (const edgeId of state.board.vertices[current.vertex]?.edges ?? []) {
      const edge = state.board.edges[edgeId];
      if (!edge) continue;
      const next = edge.vertices[0] === current.vertex ? edge.vertices[1] : edge.vertices[0];
      const owner = vertexOwner(state, next);
      if (owner && owner !== id) continue;
      const roadOwner = state.players.find((candidate) => candidate.roads.includes(edgeId))?.id;
      if (roadOwner && roadOwner !== id) continue;
      const distance = current.distance + (roadOwner === id ? 0 : 1);
      if (distance >= (distances.get(next) ?? Infinity)) continue;
      distances.set(next, distance);
      const item = { vertex: next, distance };
      if (roadOwner === id) queue.unshift(item);
      else queue.push(item);
    }
  }
  return distances;
}

/**
 * Find a real open settlement whose unpaid-road distance improves after the
 * candidate. `roadExpansionScore` deliberately mixes frontier value and
 * Longest Road value; the live road guard needs a narrower topology fact so a
 * short, well-supported approach is distinguishable from a branch that merely
 * has a high raw road score or sits beside an unrelated route.
 */
function roadOpenSettlementTargetUncached(
  state: GameState,
  action: Action,
  maxFutureRoads = 3,
): { value: number; depth: number; contested: boolean } {
  if (action.type !== "BUILD_ROAD" || !action.edge || !state.board.edges[action.edge]) {
    return { value: 0, depth: Infinity, contested: false };
  }
  const before = player(state, action.player);
  const beforeReachable = new Set(settlementSpots(state, before, false));
  const beforeDistances = roadNetworkDistances(state, action.player);
  const after = cloneState(state);
  const afterPlayer = player(after, action.player);
  if (!afterPlayer.roads.includes(action.edge)) afterPlayer.roads.push(action.edge);
  const afterDistances = roadNetworkDistances(after, action.player);
  const opponentFrontier = new Set<string>();
  for (const opponent of after.players.filter((p) => p.id !== action.player)) {
    for (const spot of settlementSpots(after, opponent, false)) opponentFrontier.add(spot);
  }

  let best = { value: 0, depth: Infinity, contested: false };
  for (const [vertex, depth] of afterDistances) {
    if (depth > maxFutureRoads || beforeReachable.has(vertex) || !openSettlementVertex(after, vertex)) continue;
    // The candidate must shorten this exact settlement route. Finding a good
    // corner somewhere else from an already-connected endpoint does not prove
    // that the selected edge advances expansion.
    if (depth >= (beforeDistances.get(vertex) ?? Infinity)) continue;
    const value = settlementSpotValue(after, action.player, vertex);
    const contested = opponentFrontier.has(vertex);
    if (value > best.value || (value === best.value && depth < best.depth)) {
      best = { value, depth, contested };
    }
  }
  return best;
}

export function roadOpenSettlementTarget(
  state: GameState,
  action: Action,
  maxFutureRoads = 3,
): { value: number; depth: number; contested: boolean } {
  return doctrineMemo(state, `opentarget:${maxFutureRoads}:${action.id}:${action.edge ?? ""}`, () =>
    roadOpenSettlementTargetUncached(state, action, maxFutureRoads));
}

/**
 * A good competitive road is sometimes a reservation, not an immediate
 * house. It claims an uncontested lane to a valuable intersection so the
 * next road/roll/trade can convert it before an opponent does. This proof is
 * intentionally narrower than a generic frontier score: it must point to a
 * real open target within two future paid roads, have a resource-supported
 * conversion path, and not be a direct-build opportunity in disguise.
 */
export function roadReservesExpansionLane(state: GameState, action: Action): boolean {
  return doctrineMemo(state, `reserve-lane:${action.id}:${action.edge ?? ""}`, () => {
    if (action.type !== "BUILD_ROAD" || state.phase === "road_building" || !action.edge) return false;
    const me = player(state, action.player);
    const buildingCount = me.settlements.length + me.cities.length;
    const target = state.config.victoryPoints;

    if (
      me.settlements.length === 0 ||
      me.settlements.length >= 5 ||
      buildingCount >= 9 ||
      me.roads.length >= 7 ||
      totalVP(state, action.player) >= target - 1
    ) return false;

    // A direct legal house is the conversion we are reserving the lane for;
    // spending its cards on a road is never the preferred reservation.
    if (canPay(me.hand, COSTS.settlement) && settlementSpots(state, me, false).length > 0) return false;
    const cityPayable = canPay(me.hand, COSTS.city);
    // A city is a concrete VP/production conversion. Even with one
    // settlement left, reserve the lane only before the city hinge is
    // payable; the last-anchor heuristic below still protects the settlement
    // when the city is not yet available.
    if (cityPayable) return false;

    const openTarget = roadOpenSettlementTarget(state, action, 3);
    if (
      openTarget.contested ||
      openTarget.value < 45 ||
      !Number.isFinite(openTarget.depth) ||
      openTarget.depth > 2
    ) return false;

    const roadScore = roadExpansionScore(state, action);
    if (roadScore < 18) return false;

    // There must be an actual bounded route, not just a valuable vertex in a
    // graph search. Resource support may come from current production/ports;
    // it need not mean the settlement is payable this exact turn.
    const routeValue = openTarget.depth === 0
      ? openTarget.value
      : openTarget.depth === 1
        ? settlementRouteAfterTwoRoads(state, action)
        : settlementRouteAfterThreeRoads(state, action);
    const routeSupported = openTarget.depth === 0 ||
      settlementRouteHasResourceSupport(state, action, Math.min(3, openTarget.depth + 1));
    if (routeValue < 45 && !routeSupported) return false;

    // Reserve a lane only when the road cards can plausibly be replenished.
    // Production is deliberately enough here: this is a plan over several
    // turns, not a claim that the whole route is already in hand.
    const prod = production(state, action.player);
    const roadSupply = me.hand.wood + me.hand.brick >= 3 ||
      prod.wood + prod.brick > 0 ||
      (me.hand.wood >= 1 && prod.brick > 0) ||
      (me.hand.brick >= 1 && prod.wood > 0);
    if (!roadSupply) return false;

    // If an opponent is already one visible conversion from winning, a
    // multi-road reservation is too slow. Immediate denial/award logic still
    // runs above this helper and can choose a road for the right reason.
    const opponentNearWin = state.players
      .filter((opponent) => opponent.id !== action.player)
      .some((opponent) => opponentIsDangerous(state, opponent.id));
    if (opponentNearWin && openTarget.depth > 0) return false;

    // A last settlement plus a city is the important case from the live loss:
    // before the city hinge is payable, do not spend the final expansion
    // anchor's road cards on an unsecured branch. Other expansion shapes use
    // the same bounded proof and also yield to a direct city above.
    return true;
  });
}

/**
 * Score the first edge of a Road Building pair by the best legal second edge
 * it enables.  A greedy first-edge score routinely chose a pretty branch that
 * left the second free road disconnected from the next house.  The pair is a
 * single tempo decision: preserve the first edge's frontier value, then add
 * the best second-edge frontier and the settlement that the completed pair
 * exposes.
 */
function roadBuildingFirstScore(state: GameState, action: Action): number {
  const firstScore = roadExpansionScore(state, action);
  if (state.phase !== "road_building" || action.type !== "BUILD_ROAD") return firstScore;

  const first = cloneState(state);
  try {
    applyAction(first, action, () => 0.5);
  } catch {
    return firstScore;
  }
  const secondActions = legalActions(first).filter((candidate) => candidate.type === "BUILD_ROAD");
  if (!secondActions.length) return firstScore - 12;

  let bestPair = -Infinity;
  for (const second of secondActions) {
    const afterPair = cloneState(first);
    try {
      applyAction(afterPair, second, () => 0.5);
    } catch {
      continue;
    }
    const secondScore = roadExpansionScore(first, second);
    const us = player(afterPair, action.player);
    const house = bestReachableSettlementValue(afterPair, action.player);
    const settlementMissing = costDistance(us.hand, COSTS.settlement);
    let pair = secondScore;
    if (house > 0) {
      // A reachable house is the purpose of expansion.  Reward a pair that
      // can pay it now much more than a generic frontier extension.
      pair += 48 + house * 0.42;
      if (settlementMissing <= 1) pair += 22;
      if (canPay(us.hand, COSTS.settlement)) pair += 46;
    } else {
      // Keep Longest Road/territory pairs available, but do not let an
      // unconnected two-edge branch outrank a route that reaches a house.
      pair -= 14;
    }
    if (pair > bestPair) bestPair = pair;
  }
  return firstScore + (Number.isFinite(bestPair) ? bestPair * 0.72 : -12);
}

/**
 * A Road Building card is two free roads, but it is still a scarce tempo
 * action.  The card needs a concrete conversion: the completed pair must
 * make a settlement legal now, or it must create a defensible Longest Road
 * claim/defense that survives one rival extension.  Raw frontier value is
 * deliberately not enough here; that was the live failure where the bot
 * spent the card on a contested branch while a rival already had 11 roads.
 */
export function roadBuildingHasStrategicProof(state: GameState, us = state.us): boolean {
  return doctrineMemo(state, `road-building-proof:${us}`, () => {
    const sim = cloneState(state);
    sim.current = us;
    sim.phase = "road_building";
    sim.pendingRoads = 2;
    const firstActions = legalActions(sim).filter((action) => action.type === "BUILD_ROAD");
    if (!firstActions.length) return false;
    const beforeReachable = new Set(settlementSpots(state, player(state, us), false));
    const opponentFrontier = new Set<string>();
    for (const opponent of state.players.filter((candidate) => candidate.id !== us)) {
      for (const vertex of settlementSpots(state, opponent, false)) opponentFrontier.add(vertex);
    }
    const meBefore = player(state, us);
    const expansionAvailable = meBefore.settlements.length < 5 &&
      meBefore.settlements.length + meBefore.cities.length < 9 &&
      totalVP(state, us) < state.config.victoryPoints - 2 &&
      !state.players.some((opponent) => opponent.id !== us && opponentIsDangerous(state, opponent.id));
    const beforeLength = roadLength(state, us);
    const currentRivalLength = Math.max(
      0,
      ...state.players.filter((p) => p.id !== us).map((p) => roadLength(state, p.id)),
    );

    for (const firstAction of firstActions) {
      const afterFirst = cloneState(sim);
      try {
        applyAction(afterFirst, firstAction, () => 0.5);
      } catch {
        continue;
      }
      const secondActions = legalActions(afterFirst).filter((action) => action.type === "BUILD_ROAD");
      // A pair is the normal case.  If the first road exhausts the legal
      // frontier, still evaluate it: a single bridge edge can immediately
      // take/defend the award on a crowded board.
      const candidates = secondActions.length ? secondActions : [null];
      for (const secondAction of candidates) {
        const afterPair = secondAction ? cloneState(afterFirst) : afterFirst;
        if (secondAction) {
          try {
            applyAction(afterPair, secondAction, () => 0.5);
          } catch {
            continue;
          }
        }

        const canBuildHouse = legalActions(afterPair).some((action) => action.type === "BUILD_SETTLEMENT");
        if (canBuildHouse) return true;

        if (expansionAvailable && settlementResourcesSupported(afterPair, us)) {
          const supportedLane = settlementSpots(afterPair, player(afterPair, us), false).some((vertex) =>
            !beforeReachable.has(vertex) &&
            !opponentFrontier.has(vertex) &&
            settlementSpotValue(afterPair, us, vertex) >= 45,
          );
          if (supportedLane) return true;
        }

        const pairLength = roadLength(afterPair, us);
        const rivalNextLength = Math.max(
          0,
          ...afterPair.players
            .filter((p) => p.id !== us)
            .map((p) => opponentRoadLengthAfterOneRoad(afterPair, p.id)),
        );
        const security = roadSecurity(afterPair, us, pairLength);
        const rivalCanThreatenHolder = state.longestRoad === us &&
          Math.max(currentRivalLength, rivalNextLength) >= beforeLength;
        const secureAward = pairLength >= 5 &&
          pairLength > rivalNextLength &&
          security.worstLength > rivalNextLength &&
          (state.longestRoad !== us || (rivalCanThreatenHolder && pairLength > beforeLength));
        if (secureAward) return true;
      }
    }
    return false;
  });
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

function opponentRoadLengthAfterOneRoadUncached(state: GameState, id: string): number {
  const opponent = player(state, id);
  let best = roadLength(state, id);
  for (const edge of roadSpots(state, opponent)) {
    const next = cloneState(state);
    const nextOpponent = player(next, id);
    if (nextOpponent.roads.includes(edge)) continue;
    nextOpponent.roads.push(edge);
    best = Math.max(best, roadLength(next, id));
  }
  return best;
}

function opponentRoadLengthAfterOneRoad(state: GameState, id: string): number {
  return doctrineMemo(state, `opponent-road-next:${id}`, () =>
    opponentRoadLengthAfterOneRoadUncached(state, id));
}

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
  const opponentNextLength = Math.max(
    0,
    ...state.players
      .filter((p) => p.id !== us)
      .map((p) => opponentRoadLengthAfterOneRoad(state, p.id)),
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
  // A bridge can be the strongest Longest Road move even when neither
  // component is long by itself. If the first edge increases the longest path
  // by more than one, it joined two of our own road islands; always search that
  // race instead of dismissing it behind the old component-length gate.
  const bridgeMove = immediateLength > beforeLength + 1;
  const nearRace = beforeLength >= 3 || opponentLength >= 4 || state.longestRoad === us || bridgeMove;
  if (!nearRace && immediateLength < target) return noPlan;

  const needsImmediateSecurity =
    (state.longestRoad !== us && immediateLength >= target) ||
    (state.longestRoad === us && opponentNextLength >= beforeLength && immediateLength > beforeLength);
  const immediateSecurity = needsImmediateSecurity
    ? roadSecurity(first, us, immediateLength)
    : { blockers: 0, maxDrop: 0, worstLength: immediateLength };
  const secureNow = immediateLength >= target && immediateSecurity.worstLength > opponentNextLength;
  const claimNow = state.longestRoad !== us && immediateLength >= target;
  const defendNow =
    state.longestRoad === us &&
    opponentNextLength >= beforeLength &&
    immediateLength > beforeLength &&
    immediateSecurity.worstLength > opponentNextLength;

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
  // A future award is only secure if the current rival cannot add one legal
  // road before our bounded route completes. The old check compared against
  // the rival's present length only, which incorrectly called a three-edge
  // race "secure" while the rival could simply extend from 4 to 5.
  const secureSoon = claimSoon && goalSecurity.worstLength > opponentNextLength;
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

/**
 * A future Longest Road route is actionable only when it is a real race, not
 * just a pretty branch.  Keep this separate from `claimNow`: the first edge
 * can be the correct investment even when two more edges are needed, but the
 * route must be bounded, already secure against the current holder, and not
 * consume a hand that can immediately build a city or settlement.
 */
export function boundedSecureLongestRoadRace(
  state: GameState,
  action: Action,
  plan = longestRoadPlanScore(state, action),
): boolean {
  if (action.type !== "BUILD_ROAD" || !action.edge || state.phase === "setup_road") return false;
  const me = player(state, action.player);
  const postRoadHand = state.phase === "road_building"
    ? me.hand
    : {
        ...me.hand,
        wood: me.hand.wood - COSTS.road.wood,
        brick: me.hand.brick - COSTS.road.brick,
      };
  const settlementGap = costDistance(postRoadHand, COSTS.settlement);
  const canBuildSettlementNow =
    me.settlements.length + me.cities.length < 9 &&
    me.settlements.length < 5 &&
    canPay(me.hand, COSTS.settlement) &&
    settlementSpots(state, me, false).length > 0;

  return state.longestRoad !== action.player &&
    !canBuildSettlementNow &&
    !canPay(me.hand, COSTS.city) &&
    plan.claimSoon &&
    plan.secureSoon &&
    plan.roadsToGoal !== null &&
    plan.roadsToGoal <= 3 &&
    plan.opponentLength >= 4 &&
    plan.bestLength >= Math.max(5, plan.opponentLength + 1) &&
    me.roads.length < 6 &&
    settlementGap <= 3 &&
    roadExpansionScore(state, action) >= 24;
}

function roadBuildingValue(state: GameState, us: string): number {
  const strategicProof = roadBuildingHasStrategicProof(state, us);
  if (!strategicProof) {
    // Keep this well below END_TURN after the global threat/tempo terms are
    // added in heuristicScore. A free-road pair without a supported house
    // lane or secure award is not a reason to spend the card.
    return -96;
  }
  const sim = cloneState(state);
  sim.current = us;
  sim.phase = "road_building";
  sim.pendingRoads = 2;
  const first = legalActions(sim).filter((action) => action.type === "BUILD_ROAD");
  if (!first.length) return -18;
  const rankedFirst = first
    .map((action) => ({ action, score: roadBuildingFirstScore(sim, action) }))
    .sort((a, b) => b.score - a.score);
  const bestFirst = rankedFirst[0];
  applyAction(sim, bestFirst.action, () => 0.5);
  const second = legalActions(sim)
    .filter((action) => action.type === "BUILD_ROAD")
    .map((action) => roadExpansionScore(sim, action))
    .sort((a, b) => b - a)[0] ?? 0;
  const house = bestReachableSettlementValue(sim, us);
  // `roadBuildingHasStrategicProof` also admits a supported, uncontested
  // settlement lane created by the complete pair. Do not reapply a first-road
  // payable-house test here: that made the proof pass while the card's value
  // was still scored as if the pair had no conversion.
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
  else if (
    me.settlements.length >= 2 &&
    me.settlements.length + me.cities.length >= 3 &&
    cityCanBeUnlockedByPortTrade(state, me, after)
  ) {
    // A city can be one legal maritime trade away even when this card cannot
    // pay it directly. Count that complete conversion route: otherwise a
    // sheep+ore pair that unlocks a dev card can beat two ore, despite an
    // owned 2:1 port turning the latter into a city this turn.
    score += 56;
  }

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
  const ownedVertices = [...owned];
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
  score += openingResourceResilience(sim, id, ownedVertices);
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
        const wheatOptionExists = settlementSpots(sim, player(sim, id), true).some(
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
  if (before.ore <= 0 && after.ore > 0) score += after.sheep > 0 ? 36 : 18;
  if (after.ore <= 0) {
    const oreOptionExists = settlementSpots(sim, player(sim, id), true).some(
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

  // In reverse setup order this settlement is the only source of the
  // starting cards. A pair can look complete in aggregate while the second
  // house hands us only brick/ore and strands the first road until a lucky
  // roll. Prefer an immediately playable wood/brick/sheep/wheat shape when an
  // open alternative exists; retain the combined-pair score above for boards
  // where that resource is genuinely unavailable.
  const openSecondSpots = settlementSpots(sim, player(sim, id), true);
  const immediateResourcePenalty: Record<"wood" | "brick" | "sheep" | "wheat", number> = {
    wood: 78,
    brick: 72,
    sheep: 68,
    wheat: 42,
  };
  for (const resource of expansion) {
    if (starting[resource] > 0) continue;
    const alternativeExists = openSecondSpots.some((spot) => localPips(sim, spot, resource) > 0);
    if (alternativeExists) score -= immediateResourcePenalty[resource];
  }

  // A merely non-zero resource is not enough for the reverse-order house.
  // One-pip sheep/wood/brick coverage still leaves the opening pair waiting
  // several rolls for its first road or settlement. Prefer a real production
  // floor when an uncontested alternative can supply it; this is deliberately
  // softer than the zero-resource veto so a strong 6/8 corner can still win.
  const openingFloor: Record<"wood" | "brick" | "sheep" | "wheat", number> = {
    wood: 3,
    brick: 3,
    sheep: 3,
    wheat: 3,
  };
  const lowProductionPenalty: Record<"wood" | "brick" | "sheep" | "wheat", number> = {
    wood: 34,
    brick: 38,
    sheep: 52,
    wheat: 28,
  };
  for (const resource of expansion) {
    const shortfall = Math.max(0, openingFloor[resource] - after[resource]);
    const bestAlternative = Math.max(0, ...openSecondSpots.map((spot) => localPips(sim, spot, resource)));
    if (shortfall > 0 && bestAlternative > after[resource] + 0.5) {
      score -= shortfall * lowProductionPenalty[resource];
    }
  }

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
  // The reverse-order pick is contested. If a first house can take wood now,
  // prefer securing it instead of assuming the later house will still have a
  // road resource available.
  if (firstResources.has("wood")) score += 30;
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
      ["wood", 210],
      ["brick", 160],
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

    // Opening coverage is not binary. A pair that technically produces one
    // brick or one wheat still waits through too many rolls to make its first
    // road/house, and the live bot then tries to repair the deficit with
    // 4:1 trades. Enforce a modest production floor when the remaining board
    // can supply a stronger complement; soften it for a matching 2:1 port.
    const productionFloor: Record<Resource, number> = {
      wood: 3,
      brick: 3,
      sheep: 3,
      wheat: 3,
      ore: 3,
    };
    const floorPenalty: Record<Resource, number> = {
      wood: 58,
      brick: 72,
      sheep: 58,
      wheat: 48,
      ore: 42,
    };
    for (const resource of RESOURCES) {
      const shortfall = Math.max(0, productionFloor[resource] - pairProduction[resource]);
      if (!shortfall || !available(resource)) continue;
      const matchingPort = [...pairPlayer.settlements, ...pairPlayer.cities].some((vertex) => {
        const port = complement.state.board.vertices[vertex]?.port;
        return port?.ratio === 2 && port.resource === resource;
      });
      score -= shortfall * floorPenalty[resource] * (matchingPort ? 0.35 : 1);
    }
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

function roadBuildingWinsImmediately(state: GameState, id: string): boolean {
  const sim = cloneState(state);
  sim.current = id;
  const play = legalActions(sim).find((action) => action.type === "PLAY_ROAD_BUILDING");
  if (!play) return false;
  try {
    applyAction(sim, play, () => 0.5);
  } catch {
    return false;
  }

  for (const firstAction of legalActions(sim).filter((action) => action.type === "BUILD_ROAD")) {
    const afterFirst = cloneState(sim);
    try {
      applyAction(afterFirst, firstAction, () => 0.5);
    } catch {
      continue;
    }
    if (afterFirst.winner === id || totalVP(afterFirst, id) >= afterFirst.config.victoryPoints) return true;
    if (afterFirst.phase !== "road_building") continue;

    for (const secondAction of legalActions(afterFirst).filter((action) => action.type === "BUILD_ROAD")) {
      const afterPair = cloneState(afterFirst);
      try {
        applyAction(afterPair, secondAction, () => 0.5);
      } catch {
        continue;
      }
      if (afterPair.winner === id || totalVP(afterPair, id) >= afterPair.config.victoryPoints) return true;
    }
  }
  return false;
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
      if (totalVP(state, a.player) + 2 < state.config.victoryPoints) continue;
      // One road can join two separate networks, so the longest path may jump
      // by several edges. Simulate the legal placement instead of assuming it
      // adds exactly one to the current maximum.
      const next = cloneState(state);
      try {
        applyAction(next, a, () => 0.5);
      } catch {
        continue;
      }
      if (next.winner === a.player) return a;
    }
    if (a.type === "PLAY_KNIGHT" && knightWouldTakeLargestArmy(state, a.player)) {
      // Largest Army is a hidden two-VP swing just like Longest Road. A
      // third knight can be the immediate win even when no city or house is
      // payable, so it belongs in the forced-win layer.
      if (totalVP(state, a.player) + 2 >= state.config.victoryPoints) return a;
    }
    if (
      a.type === "PLAY_ROAD_BUILDING" &&
      totalVP(state, a.player) + 2 >= state.config.victoryPoints &&
      roadBuildingWinsImmediately(state, a.player)
    ) {
      // If the free-road pair really reaches the victory threshold, the award
      // need not survive a rival reply: the game ends on the winning road.
      return a;
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
 * Public threat budget for a live opponent. Their hand and hidden VP cards
 * are unavailable, so a hand-based one-turn ceiling is not a sufficient
 * defense signal. Visible VP plus an award/structure swing is the race clock.
 */
function opponentThreatScore(state: GameState, id: string): number {
  const p = player(state, id);
  const target = state.config.victoryPoints;
  const visible = visibleVP(state, id);
  const potentialRoadAward = state.longestRoad === id ? 0 : roadLength(state, id) >= 4 ? 2 : 0;
  const potentialArmyAward = state.largestArmy === id ? 0 : p.knightsPlayed >= 2 ? 2 : 0;
  const projected = visible + potentialRoadAward + potentialArmyAward;
  let score = projected >= target ? 150 : projected === target - 1 ? 125 : projected === target - 2 ? 92 : projected === target - 3 ? 58 : 0;
  if (state.longestRoad === id && visible >= target - 3) score += 28;
  if (state.largestArmy === id && visible >= target - 3) score += 24;
  if (roadLength(state, id) >= 6) score += 18;
  if (p.knightsPlayed >= 3) score += 18;
  return score;
}

/**
 * Price whether the selected move changes the public race. This stays local
 * and bounded so it can run on every legal action without another evaluator
 * round or a large rollout.
 */
function threatResponseValue(state: GameState, action: Action): number {
  const threats = state.players
    .filter((p) => p.id !== action.player)
    .map((p) => ({ player: p, score: opponentThreatScore(state, p.id) }))
    .filter((entry) => entry.score > 0);
  if (!threats.length) return 0;
  const strongest = Math.max(...threats.map((entry) => entry.score));
  let value = 0;

  if (action.type === "BUILD_ROAD" && action.edge) {
    const cuts = threats.filter((entry) => roadSpots(state, entry.player).includes(action.edge!));
    if (cuts.length) {
      value += cuts.reduce((sum, entry) => sum + entry.score * 0.72, 0);
    } else if (state.longestRoad && threats.some((entry) => entry.player.id === state.longestRoad)) {
      // A disconnected road is usually a tempo sink while the LR holder is
      // one point from winning. Let a cut/house/robber action beat it.
      value -= strongest * 0.34;
    }
  }

  if ((action.type === "BUILD_SETTLEMENT" || action.type === "PLACE_SETTLEMENT") && action.vertex) {
    for (const entry of threats) {
      const adjacentToTheirRoad = state.board.vertices[action.vertex]?.edges.some((edge) => entry.player.roads.includes(edge));
      if (adjacentToTheirRoad || settlementSpots(state, entry.player, true).includes(action.vertex)) {
        value += entry.score * 0.38;
      }
    }
  }

  if (action.type === "MOVE_ROBBER" && action.hex) {
    const hex = state.board.hexes[action.hex];
    const pips = hex?.number == null ? 0 : PIP[hex.number] ?? 0;
    const resource = hex ? resourceOf(hex) : null;
    for (const entry of threats) {
      const units = (hex?.vertices ?? []).reduce((sum, vertex) => {
        if (entry.player.cities.includes(vertex)) return sum + 2;
        if (entry.player.settlements.includes(vertex)) return sum + 1;
        return sum;
      }, 0);
      if (!units) continue;
      const resourceWeight = resource === "wheat" || resource === "ore" ? 1.45 : 1;
      value += entry.score * 0.24 + units * pips * resourceWeight * (1 + entry.score / 180);
    }
  }

  if (action.type === "PLAY_KNIGHT") {
    // Playing now buys the robber interruption before the rival's next roll;
    // the following MOVE_ROBBER target is scored separately.
    value += strongest * 0.38;
  }

  if (state.pendingOffer && (action.type === "ACCEPT_TRADE" || action.type === "REJECT_TRADE")) {
    const sender = threats.find((entry) => entry.player.id === state.pendingOffer?.from);
    if (sender) {
      if (action.type === "REJECT_TRADE") value += sender.score * 0.18;
      else if (opponentTradeUnlock(state, state.pendingOffer)) value -= sender.score * 0.48;
    }
  }

  if (["BUY_DEV", "MARITIME_TRADE", "END_TURN"].includes(action.type)) {
    value -= strongest * 0.16;
  }
  return value;
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

function discardHandAfter(me: GameState["players"][number], action: Action): Hand {
  const after = { ...me.hand };
  for (const resource of RESOURCES) after[resource] = Math.max(0, after[resource] - (action.discard?.[resource] ?? 0));
  return after;
}

/**
 * Production with the robber removed.  A resource can look dead in the
 * current snapshot only because the robber is sitting on its tile; that is
 * different from a resource the player's board can never replace.  Discard
 * decisions should use both values.
 */
function potentialProduction(state: GameState, id: string): Record<Resource, number> {
  const me = player(state, id);
  const owned = new Set([...me.settlements, ...me.cities]);
  const out: Record<Resource, number> = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  for (const hex of Object.values(state.board.hexes)) {
    const resource = resourceOf(hex);
    if (!resource || hex.number == null) continue;
    const pips = PIP[hex.number] ?? 0;
    for (const vertex of hex.vertices) {
      if (!owned.has(vertex)) continue;
      out[resource] += pips * (me.cities.includes(vertex) ? 2 : 1);
    }
  }
  return out;
}

function cityUpgradeValue(state: GameState, id: string): number {
  const me = player(state, id);
  return Math.max(0, ...me.settlements.map((vertex) => {
    const v = state.board.vertices[vertex];
    if (!v) return 0;
    return v.hexes.reduce((sum, hexId) => {
      const hex = state.board.hexes[hexId];
      const resource = resourceOf(hex);
      const pips = hex.number == null ? 0 : PIP[hex.number] ?? 0;
      return sum + pips * (resource === "wheat" || resource === "ore" ? 1.7 : 1);
    }, 0);
  }));
}

function bestPortRatio(state: GameState, me: GameState["players"][number], resource: Resource): number {
  let ratio = 4;
  for (const vertex of [...me.settlements, ...me.cities]) {
    const port = state.board.vertices[vertex]?.port;
    if (!port) continue;
    if (port.ratio === 3) ratio = Math.min(ratio, 3);
    if (port.ratio === 2 && port.resource === resource) ratio = 2;
  }
  return ratio;
}

function cityCanBeUnlockedByPortTrade(
  state: GameState,
  me: GameState["players"][number],
  hand: Hand,
): boolean {
  if (canPay(hand, COSTS.city)) return true;
  for (const give of RESOURCES) {
    const rate = bestPortRatio(state, me, give);
    if (hand[give] < rate) continue;
    for (const get of ["wheat", "ore"] as const) {
      if (get === give || state.bank[get] <= 0) continue;
      if (canPay(afterSwap(hand, give, rate, get, 1), COSTS.city)) return true;
    }
  }
  return false;
}

/**
 * Score a discard by the board position it leaves behind. A seven is not a
 * generic "dump low cards" event: the right choice protects the cheapest
 * reachable build, the resource engine that replaces the discarded cards,
 * and any matching port. This stays local because Colonist exposes our hand
 * and the full board even while the robber/discard menu is open.
 */
function discardBoardValue(state: GameState, action: Action): number {
  if (action.type !== "DISCARD") return 0;
  const me = player(state, action.player);
  const after = discardHandAfter(me, action);
  const openHouse = settlementSpots(state, me, false).length > 0;
  const openRoad = roadSpots(state, me).length > 0;
  const preserveExpansion = me.settlements.length + me.cities.length === 2 || (
    me.settlements.length <= 1 &&
    me.cities.length > 0 &&
    openHouse
  );
  const reachableHouseValue = bestReachableSettlementValue(state, action.player);
  const openHouseValue = bestOpenSettlementValue(state, action.player);
  const cityValue = cityUpgradeValue(state, action.player);
  const activeProduction = production(state, action.player);
  const replaceableProduction = potentialProduction(state, action.player);
  const cityMissing = costDistance(me.hand, COSTS.city);
  const cityOreReserve = me.settlements.length > 0 && me.hand.ore >= COSTS.city.ore;
  let score = 0;

  const goals: Array<{ cost: Hand; weight: number; available: boolean }> = [
    {
      cost: COSTS.settlement,
      // A reachable house is worth more than an abstract four-card recipe.
      // If the network is not connected yet, retain some value for an open
      // house but do not let it beat a live city engine by itself.
      weight: reachableHouseValue > 0
        ? (preserveExpansion ? 34 : 28) + Math.min(18, reachableHouseValue * 0.12)
        : preserveExpansion ? 23 : openHouse ? 13 : 0,
      available: openHouse && me.settlements.length < 5,
    },
    {
      cost: COSTS.city,
      weight: preserveExpansion ? 9 : 22 + Math.min(12, cityValue * 0.12),
      available: me.settlements.length > 0,
    },
    { cost: COSTS.road, weight: openRoad ? 10 : 0, available: openRoad },
    { cost: COSTS.dev, weight: 7, available: state.deck.length > 0 },
  ];
  for (const goal of goals) {
    if (!goal.available) continue;
    const beforeMissing = costDistance(me.hand, goal.cost);
    const afterMissing = costDistance(after, goal.cost);
    score += (beforeMissing - afterMissing) * goal.weight;
    if (afterMissing === 0) {
      score += goal.cost === COSTS.settlement
        ? 64 + Math.min(32, reachableHouseValue * 0.2)
        : goal.cost === COSTS.city
          ? 46 + Math.min(26, cityValue * 0.25)
          : goal.cost === COSTS.road ? 18 : 12;
    }
  }

  // A legal house is only valuable when it is connected to the existing road
  // network. Reward preserving a complete route, and distinguish it from an
  // attractive but disconnected hand that cannot actually spend the cards.
  if (openHouse && canPay(after, COSTS.settlement)) {
    score += 68 + reachableHouseValue * 0.3;
  }
  if (me.settlements.length > 0 && canPay(after, COSTS.city)) {
    score += (preserveExpansion ? 12 : 42) + cityValue * 0.22;
  }
  if (openRoad && canPay(after, COSTS.road)) score += 18;

  // Do not throw away the ore reserve for a city merely because wheat has not
  // arrived yet. A productive wheat board can repair that hinge; an oreless
  // board cannot replace three ore at all. This is especially important with
  // one settlement left: the old last-settlement guard preferred keeping
  // every expansion card and could discard four ore, leaving no legal city
  // conversion and no road/house core either.
  if (cityOreReserve && after.ore < COSTS.city.ore && cityMissing > 0) {
    score -= (COSTS.city.ore - after.ore) * 22;
  }

  const boardProduction = RESOURCES.reduce((sum, resource) => sum + boardPips(state, resource), 0);
  const averageBoardPips = boardProduction / RESOURCES.length;
  for (const resource of RESOURCES) {
    const discarded = action.discard?.[resource] ?? 0;
    if (!discarded) continue;
    let cardValue = 1.5 + resourcePressure(state, action.player, resource) * 2.4;
    // A resource the board cannot produce for us is genuinely scarce. A
    // currently blocked resource is not: the robber can move, so use the
    // unblocked ceiling before deciding it is safe to throw away.
    if (replaceableProduction[resource] <= 0) cardValue += 5.2;
    else if (replaceableProduction[resource] <= 2) cardValue += 2.8;
    else if (replaceableProduction[resource] >= 8) cardValue -= 1.8;
    if (activeProduction[resource] === 0 && replaceableProduction[resource] > 0) cardValue -= 0.7;
    if (averageBoardPips > 0 && boardPips(state, resource) < averageBoardPips * 0.8) cardValue += 1.2;
    const ratio = bestPortRatio(state, me, resource);
    if (ratio === 2) {
      const beforePairs = Math.floor(me.hand[resource] / 2);
      const afterPairs = Math.floor(after[resource] / 2);
      if (beforePairs > afterPairs) cardValue += 5.2;
      else if (after[resource] >= 2) cardValue += 2.2;
    } else if (ratio === 3 && Math.floor(me.hand[resource] / 3) > Math.floor(after[resource] / 3)) {
      cardValue += 2.2;
    }
    score -= discarded * cardValue;
  }
  return score;
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
  s += threatResponseValue(state, action);
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
      if (action.type === "BUILD_SETTLEMENT" && me.settlements.length >= 3 &&
        me.cities.length === 0 && canPay(me.hand, COSTS.city)) {
        // Once three settlements exist, a payable city is the normal engine
        // conversion. A fourth house can still win when it is forced/denies,
        // but it should not beat the first city merely because its base
        // settlement score is high.
        s -= 24;
      }
      break;
    }
    case "PLACE_ROAD":
    case "BUILD_ROAD": {
      s += action.type === "PLACE_ROAD" ? 10 : 8;
      const roadValue = state.phase === "road_building"
        ? roadBuildingFirstScore(state, action)
        : roadExpansionScore(state, action);
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
        const secureRaceApproach = boundedSecureLongestRoadRace(state, action, lrPlan);
        const canBuyDev = state.deck.length > 0 && canPay(me.hand, COSTS.dev);
        const routeAfter = settlementRouteAfterRoad(state, action);
        const routeAfterTwo = settlementRouteAfterTwoRoads(state, action);
        const routeAfterThree = settlementRouteAfterThreeRoads(state, action);
        const postRoadHand = state.phase === "road_building"
          ? me.hand
          : { ...me.hand, wood: me.hand.wood - COSTS.road.wood, brick: me.hand.brick - COSTS.road.brick };
        const postRoadSettlementGap = costDistance(postRoadHand, COSTS.settlement);
        const preserveLastSettlement = me.settlements.length === 1 &&
          me.cities.length >= 1 &&
          totalVP(state, us) < state.config.victoryPoints - 1 &&
          me.roads.length < 9;
        const cityPayableNow = canPay(me.hand, COSTS.city);
        const immediateHouseAfterRoad = settlementRouteCanPayAfterRoads(state, action, 1);
        const reservesExpansionLane = roadReservesExpansionLane(state, action);
        const anchorFrontier = (preserveLastSettlement && roadValue >= 24 &&
          (!cityPayableNow || immediateHouseAfterRoad)) || reservesExpansionLane;
        // Roads are an investment, not a default resource sink. Once the
        // player has a network of four or more, make the policy prove that
        // the next edge creates a real settlement route or a defensible LR
        // swing. This is the opportunity-cost layer that stops attractive
        // frontier geometry from consuming the wheat/sheep/ore needed for
        // cities and development cards.
        if (!secureAwardSwing && !secureRaceApproach) {
          if (me.roads.length >= 4 && !anchorFrontier) s -= 32;
          if (me.roads.length >= 6 && !anchorFrontier) s -= 45;
          if (me.roads.length >= 8 && !anchorFrontier) s -= 55;
          if (canBuyDev && !anchorFrontier) s -= 22;
          if (!lrPlan.claimSoon && !anchorFrontier) s -= 28;
          if (!lrPlan.claimSoon && roadValue < 52 && !anchorFrontier) s -= 18;
          // Preserve a near-complete conversion hand. The missing card may
          // arrive from the next roll or a one-card trade; spending wood and
          // brick on a road here throws away a city/settlement tempo.
          const cityMissing = costDistance(me.hand, COSTS.city);
          const settlementMissing = costDistance(me.hand, COSTS.settlement);
          if (cityMissing <= 1) s -= anchorFrontier ? 8 : 34;
          if (settlementMissing <= 1) s -= anchorFrontier ? 8 : 30;
        if (state.phase !== "road_building" && me.roads.length >= 2 && postRoadSettlementGap > 1 &&
          routeAfterTwo < 70 && routeAfterThree < 70 && !anchorFrontier) {
            // A third paid road is not an expansion plan when it consumes the
            // only wood/brick pair and still leaves multiple settlement cards
            // missing. Penalize this before the raw frontier/Longest Road
            // score can turn it into the trade -> road -> empty-hand loop.
            s -= 72 + Math.min(42, (postRoadSettlementGap - 1) * 14);
            if (routeAfter <= 0) s -= 20;
          }
          if (routeAfter <= 0 && routeAfterTwo >= 70 && postRoadSettlementGap <= 2 && me.roads.length < 5) {
            // A one-ply route is not the only legitimate expansion shape. A
            // good two-edge approach is worth preserving when the next house
            // is close enough to convert before the road chain becomes a
            // speculative Longest Road sink.
            s += 30 + routeAfterTwo * 0.14;
          }
          if (routeAfter <= 0 && routeAfterTwo < 70 && routeAfterThree >= 70 &&
            postRoadSettlementGap <= 3 && me.roads.length < 6) {
            // Some contested corners take three paid edges. Preserve that
            // route only when the bounded forecast can actually reach a
            // valuable house before the current road hand is exhausted.
            s += 24 + routeAfterThree * 0.1;
          }
          if (anchorFrontier) {
            // Once the last settlement is still available, the expansion
            // road is the conversion engine. Give the best frontier enough
            // weight to beat END_TURN/BUY_DEV after the route forecast has
            // already ruled out the cheap one-ply path.
            s += 70;
          }
        }
        const canBuildSettlement =
          me.settlements.length + me.cities.length < 9 &&
          me.settlements.length < 5 &&
          canPay(me.hand, COSTS.settlement) &&
          settlementSpots(state, me, false).length > 0;
        if (canBuildSettlement && !anchorFrontier) {
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
        if (canBuildCity && !anchorFrontier) s -= 22;
        if (funnel.active && !secureAwardSwing) {
          if (routeAfter > 0 && funnel.reachableValue <= 0) {
            // This is the useful road: it immediately turns the network into
            // a legal third-settlement route.  Let it beat a passive dev
            // purchase even when the house still needs one more roll/trade.
            s += 34 + routeAfter * 0.22;
          } else if (routeAfter <= 0 && funnel.reachableValue <= 0) {
            // If no one-edge road exposes a house, the best frontier edge can
            // still be the necessary first step of a two-road route. Keep
            // that bounded expansion move alive; otherwise the policy can
            // trade/dev-loop forever with two houses and an unreachable
            // third settlement.
            if (funnel.bestRoadRoute <= 0 && roadValue >= 24 && me.roads.length <= 5) s += 12;
            else s -= 24;
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
      if (me.settlements.length >= 3 && me.cities.length === 0) {
        // The first city after a three-settlement expansion is a production
        // and VP conversion, not just another one-point build. This keeps a
        // strong ore/wheat engine from continuing into a fourth house while
        // the opponents are already converting their opening pair.
        s += 24;
      }
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
      // A city is only +1 VP and it consumes the settlement that anchors a
      // future expansion. Once the player is down to one settlement, do not
      // automatically turn it into a third/fourth city when an open house
      // route still exists; that was the live failure where the bot ended up
      // with three cities, no settlement, and no wood/sheep to re-expand.
      const openHouse = settlementSpots(state, me, false).length > 0;
      const openHouseAnywhere = settlementSpots(state, me, true).length > 0;
      const directCityWin = totalVP(state, us) + 1 >= state.config.victoryPoints;
      const lowAnchorVp = totalVP(state, us) < state.config.victoryPoints - 2;
      const anchorRoadAvailable = legalActions(state)
        .filter((candidate) => candidate.type === "BUILD_ROAD")
        .some((candidate) => {
          if (roadReservesExpansionLane(state, candidate)) return true;
          if (roadExpansionScore(state, candidate) < 28) return false;
          // If a city is already payable, only suppress it for an expansion
          // road when that exact road exposes a house we can pay now. A
          // multi-road forecast is too slow in the endgame: it lets the bot
          // trade away city ore for an unsecured Longest Road story while a
          // rival is one VP from winning.
          return settlementRouteCanPayAfterRoads(state, candidate, 1);
        });
      const anchorRoute = me.settlements.length === 1 && me.cities.length >= 1 &&
        !directCityWin && anchorRoadAvailable;
      if (funnel.active && !directCityWin && (funnel.reachableValue > 0 || funnel.bestRoadRoute > 0)) {
        // During the two-building funnel a city is only one VP, while a
        // reachable third settlement adds a building, production, and a new
        // expansion edge. Preserve that route unless the city is the actual
        // winning point; otherwise a productive opening repeatedly converts
        // its second house too early and loses the settlement race.
        s -= funnel.reachableValue > 0 ? 72 : 42;
      }
      if (me.settlements.length === 1 && me.cities.length >= 1 && !directCityWin && (openHouse || openHouseAnywhere || anchorRoute)) {
        // A last settlement is an expansion anchor, not just a one-VP city
        // discount. Preserve it when one paid road still reaches a valuable
        // frontier; otherwise the bot can lock itself into three cities at
        // 6–7 VP while a rival wins the board's road/settlement race.
        s -= anchorRoute ? (lowAnchorVp ? 170 : 100) : (lowAnchorVp ? 145 : 72);
        if (bestReachableSettlementValue(state, us) > 0) s -= 18;
        if (opponentNearWin && anchorRoute) s -= 20;
      }
      break;
    }
    case "BUY_DEV": {
      s += 18;
      if (myProd.ore + myProd.wheat + myProd.sheep >= 10) s += 8;
      if (me.knightsPlayed >= 2) s += 12;
      if (me.devs.knight + me.devs.monopoly + me.devs.year_of_plenty + me.devs.road_building === 0) s += 6;
      // Devs are the right conversion when expansion is currently blocked,
      // but should not outrank an immediately payable house/city just because
      // the hand happens to contain sheep-wheat-ore.
      if (settlementSpots(state, me, false).length === 0) s += 8;
      if (endgame) s += 10;
      // A development card consumes wheat/sheep/ore. If the hand is already
      // one card from a city, buying a card is usually a self-inflicted tempo
      // loss: hold the conversion hand for the next roll/trade instead. This
      // is especially important after the third settlement, where the old
      // policy repeatedly bought devs while sitting one ore or wheat short.
      const cityMissing = costDistance(me.hand, COSTS.city);
      if (me.settlements.length > 0 && cityMissing <= 1) s -= 42;
      else if (me.settlements.length > 0 && cityMissing <= 2) s -= 24;
      else if (me.settlements.length > 0 && cityMissing <= 3 && myProd.wheat + myProd.ore >= 7) s -= 14;
      if (funnel.active) {
        // A dev card is a secondary conversion while the player still has
        // only the opening pair.  In particular, spending sheep/wheat/ore
        // for a card while missing wood/brick creates the long stalls seen in
        // the losing traces.  Keep the card available when the route is
        // blocked, but make it lose to a real expansion route.
        if (funnel.missing <= 2 && funnel.reachableValue > 0) s -= 48;
        else if (funnel.missing <= 3 && (funnel.reachableValue > 0 || funnel.bestRoadRoute > 0)) s -= 28;
        else if (funnel.missing <= 3) s -= 12;

        // When the opening pair is still missing a settlement card, buying a
        // dev with the same sheep/wheat/ore hand is usually a conversion
        // dead-end. Hold the cards for the next road/house route; let a dev
        // win only when the settlement lane is genuinely closed.
        const missingExpansionCard = (Object.keys(COSTS.settlement) as Resource[])
          .some((resource) => me.hand[resource] < COSTS.settlement[resource]);
        if (missingExpansionCard && (
          me.hand.wood < COSTS.settlement.wood ||
          me.hand.brick < COSTS.settlement.brick ||
          me.hand.sheep < COSTS.settlement.sheep
        )) {
          s -= 34;
          if (funnel.reachableValue > 0 || funnel.bestRoadRoute > 0) s -= 18;
        }
      }
      break;
    }
    case "PLAY_KNIGHT": {
      s += 12;
      const strongestOpponent = opp
        .slice()
        .sort((a, b) => totalVP(state, b.id) - totalVP(state, a.id))[0];
      const takesLargestArmy = knightWouldTakeLargestArmy(state, us);
      if (me.knightsPlayed === 2) s += 24;
      if (takesLargestArmy) {
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
      const ownRobber = ownRobberBlockValue(state, us);
      if (ownRobber.value > 0) {
        // Clearing our own blocked production is an immediate tempo repair,
        // not a speculative robber play. Ore/wheat are weighted more heavily
        // because a blocked city engine can strand every later conversion.
        s += 24 + ownRobber.value * (ownRobber.resource === "wheat" || ownRobber.resource === "ore" ? 3.4 : 2.1);
        if (ownRobber.resource === "wheat" || ownRobber.resource === "ore") s += 12;
      }
      if (robberValue < 20 && me.knightsPlayed < 2) s -= 16;
      if (!strongestOpponent && me.knightsPlayed === 0) s -= 8;
      // Before the dice, a weak robber move is usually worth less than the
      // information and production from rolling first. Spend the knight now
      // only for Largest Army, a dangerous opponent, or a genuinely valuable
      // interruption; this is different from the post-roll choice where the
      // board has already delivered its resource result.
      const urgentKnight = takesLargestArmy || opponentNearWin || robberValue >= 36 ||
        ownRobber.value >= 5;
      if (state.phase === "roll" && !urgentKnight) s -= 24;
      if (state.phase === "turn" && !takesLargestArmy && robberValue < 20) s -= 8;
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
            if (pl.id === us) {
              const ownWeight = res === "wheat" || res === "ore" ? 1.8 : 1;
              ours += n * pips * ownWeight;
              // Avoid moving the robber onto a productive own hex even when
              // an opponent tile has only a slightly better raw pip score.
              if (res === "wheat" || res === "ore") s -= n * pips * 2;
            }
            else {
              const pressure = res ? resourcePressure(state, pl.id, res) : 0;
              const rivalProduction = res ? production(state, pl.id)[res] : 0;
              const dangerous = opponentIsDangerous(state, pl.id);
              theirs += n * pips * (res === "wheat" || res === "ore" ? 1.4 : 1) * (1 + pressure * 0.42);
              if (pressure >= 1.5) s += n * 4;
              // A hidden hand is not evidence that a visible 8/10-point
              // opponent has nothing. When the robber can interrupt that
              // opponent's productive tile, denial is worth more than the
              // ordinary pip/steal estimate.
              if (dangerous) {
                // Prefer the resource that actually powers the opponent's
                // next build. The prior multiplier mostly selected the
                // highest-pip tile, even when it ignored a Longest Road
                // holder's brick/wood engine.
                theirs += n * pips * (3 + rivalProduction * 0.85);
                if (state.longestRoad === pl.id && (res === "wood" || res === "brick")) {
                  theirs += n * pips * 2.5;
                }
                s += n * (10 + rivalProduction * 2.5);
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

        // Monopoly is strongest when its cards immediately become a VP build
        // or deny a near-win. Estimate hidden cards conservatively from the
        // known hand plus the public production/unknown-card pool; do not
        // burn it pre-roll for a speculative one-card scoop.
        const unknown = opp.reduce((n, o) => n + o.hidden.unknown, 0);
        const estimatedGain = held + Math.min(4, Math.floor(productionThreat / 8)) + Math.min(3, Math.floor(unknown / 5));
        const after = { ...me.hand, [action.resource]: me.hand[action.resource] + estimatedGain };
        const directCity = me.settlements.length > 0 && canPay(after, COSTS.city);
        const directSettlement = me.settlements.length < 5 &&
          settlementSpots(state, me, false).length > 0 && canPay(after, COSTS.settlement);
        if (directCity || directSettlement) s += 22;
        if (estimatedGain < 3 && !opponentNearWin) s -= 24;
        if (state.phase === "roll" && !directCity && !directSettlement && !opponentNearWin && estimatedGain < 4) s -= 20;
      }
      break;
    case "PLAY_ROAD_BUILDING":
      {
        const cardValue = roadBuildingValue(state, us);
        const strategicProof = roadBuildingHasStrategicProof(state, us);
        s += cardValue;
        // Free roads are a conversion card, not two lottery tickets. Before a
        // roll, preserve it unless the pair already proves a house/award/cut;
        // after a roll, the same proof can be acted on immediately.
        if (state.phase === "roll" && cardValue < 36 && !opponentNearWin) s -= 20;
        if (cardValue >= 80) s += 12;
        if (!strategicProof) s -= 60;
      }
      if (endgame) s += 12;
      break;
    case "PLAY_YEAR_OF_PLENTY": {
      if (action.resources?.length || action.resource) {
        s += yearOfPlentyActionValue(state, action);
      } else {
        s += yearOfPlentyValue(state, us);
      }
      const resources = action.resources ?? (action.resource ? [action.resource] : []);
      if (resources.length) {
        const after = { ...me.hand };
        for (const resource of resources.slice(0, 2)) after[resource] += 1;
        const directCity = me.settlements.length > 0 && canPay(after, COSTS.city);
        const directSettlement = me.settlements.length < 5 &&
          settlementSpots(state, me, false).length > 0 && canPay(after, COSTS.settlement);
        // YOP should normally convert into a concrete build. If it does not,
        // rolling first is the higher-information timing unless an opponent
        // is about to win or the card itself prevents a discard/lockout.
        if (directCity || directSettlement) s += 16;
        else if (state.phase === "roll" && !opponentNearWin) s -= 18;
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
        // Accepting is not neutral: it gives the sender the exact resource
        // requested from their public board/position. Keep the sender's
        // identity in the calculation even when their hand is hidden.
        s -= opponentTradePositionPressure(state, o);
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
      if (state.pendingOffer) {
        if (state.pendingOffer.get === "wheat" || state.pendingOffer.get === "ore") s += 10;
        // The fast response path still uses the same strategic score: decline
        // is more valuable when this particular sender is close to a visible
        // city/settlement/award breakpoint.
        s += opponentTradePositionPressure(state, state.pendingOffer) * 0.45;
      }
      break;
    case "MARITIME_TRADE": {
      s += 4;
      const give = action.give;
      const get = action.get;
      const n = action.giveCount ?? 4;
      if (give && get) {
        const after = afterSwap(me.hand, give, n, get, 1);
        const unlock = unlockLabel(me.hand, after);
        const cityProgress = costDistance(me.hand, COSTS.city) - costDistance(after, COSTS.city);
        const noCityEngine = me.settlements.length >= 3 && me.cities.length === 0;
        const directSettlementAfter = me.settlements.length < 5 &&
          settlementSpots(state, me, false).length > 0 &&
          canPay(after, COSTS.settlement);
        const cityReserveSpent = noCityEngine && !directSettlementAfter && (
          (give === "ore" && me.hand.ore >= COSTS.city.ore && after.ore < COSTS.city.ore) ||
          (give === "wheat" && me.hand.wheat >= COSTS.city.wheat && after.wheat < COSTS.city.wheat)
        );
        if (unlock === "city") s += 44;
        else if (unlock === "settlement") s += 34;
        else if (unlock === "dev card") s += 22;
        else if (unlock === "road") s += 14;
        if (cityProgress > 0) s += cityProgress * 18;
        if (noCityEngine) {
          if (directSettlementAfter) {
            // Spending a city card is acceptable when the same conversion
            // immediately produces the next legal house.
            s += 28;
          } else if (cityReserveSpent) {
            // Do not turn a three-settlement engine into a fourth-settlement
            // stall by trading away the exact ore/wheat reserve for a card
            // that does not complete a real build.
            s -= 58;
          }
          if ((get === "ore" || get === "wheat") && cityProgress > 0) s += 12;
        }
        if (me.settlements.length > 0 && costDistance(me.hand, COSTS.city) <= 2 && (get === "wheat" || get === "ore")) {
          s += 12;
        }
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

          // A reachable settlement is still the goal even when the road is
          // already in place. In that state the useful bank card is whichever
          // missing settlement resource is most likely to arrive next; ore is
          // not interchangeable with wood/brick/sheep/wheat just because it
          // makes a city-shaped hand. The previous rule only protected the
          // no-reachable-house case, which let 4 ore -> wheat/ore trades keep
          // the bot in a two-house stall.
          const expansionPressure = me.settlements.length < 5 &&
            (me.settlements.length >= 2 || me.cities.length === 0) &&
            settlementSpots(state, me, false).length > 0;
          if (expansionPressure) {
            if (get !== "ore" && me.hand[get] < COSTS.settlement[get]) {
              s += get === "wood" || get === "brick" ? 18 : 14;
            }
            if (get === "ore" && !canPay(after, COSTS.city)) s -= 20;
            if (get === "wood" || get === "brick") {
              if (me.hand.wood <= 0 && me.hand.brick <= 0) s += 18;
              else if (me.hand[get] <= 0) s += 8;
            }
          }
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
        const settlementProgress = costDistance(me.hand, COSTS.settlement) - costDistance(after, COSTS.settlement);
        const roadProgress = costDistance(me.hand, COSTS.road) - costDistance(after, COSTS.road);
        const devProgress = costDistance(me.hand, COSTS.dev) - costDistance(after, COSTS.dev);
        const nearSettlement = settlementProgress > 0 && costDistance(after, COSTS.settlement) <= 2;
        const nearCity = cityProgress > 0 && costDistance(after, COSTS.city) <= 2;
        const nearRoad = roadProgress > 0 && costDistance(after, COSTS.road) <= 1;
        const nearDev = devProgress > 0 && costDistance(after, COSTS.dev) <= 1;
        const funnelRoadTrade = funnel.active && me.roads.length >= 2 &&
          funnel.reachableValue <= 0 && (get === "wood" || get === "brick");
        if (!unlock && reachableHouse <= 0 && !nearSettlement && !nearCity && !nearRoad && !nearDev && !funnelRoadTrade) {
          // Preserve the hand when this bank conversion does not unlock or
          // materially approach any build. In particular, do not trade
          // wheat into ore solely because an ore port is available; that
          // creates a city-shaped hand while the real bottleneck is the next
          // settlement/road.
          s -= 34;
        }
        if (get === "wheat" || get === "ore") s += 6;
        if (get === "brick" || get === "wood") s += 3;
        if (funnel.active) {
          const beforeMissing = costDistance(me.hand, COSTS.settlement);
          const afterMissing = costDistance(after, COSTS.settlement);
          const progress = beforeMissing - afterMissing;
          // During the two-building funnel, settlement-card progress is the
          // primary bank-trade objective. A 2:1 port conversion that trades
          // away an expansion card for wheat/ore can look productive while
          // leaving the bot with no third house for the next dozen rolls.
          if (progress > 0) s += 30 + progress * 18;
          else if (progress < 0) s += progress * 32;
          if (get !== "ore" && me.hand[get] < COSTS.settlement[get]) s += 24;
          if (get !== "ore" && me.hand[get] < COSTS.settlement[get] && after[get] >= COSTS.settlement[get]) s += 32;
          if (get === "ore" && !canPay(after, COSTS.city)) s -= 28;
          if ((get === "wood" || get === "brick") && me.roads.length >= 2 && funnel.reachableValue <= 0) {
            // A bank conversion can be the first step toward the next road
            // even when the current graph has no immediately reachable house.
            // Keep that active expansion lane above a passive end turn.
            s += 26;
          }
          if (canPay(after, COSTS.settlement) && settlementSpots(state, me, false).length > 0) s += 48;
          if (progress <= 0 && funnel.reachableValue <= 0 && funnel.bestRoadRoute <= 0) s -= 18;

          // After three paid roads, a 4:1 trade that only produces the
          // next road card is usually a dead-end: it spends the wheat that
          // completes the house while the network still has no payable
          // settlement. Hold the cards for a roll/city route instead of
          // repeating the old trade -> road -> empty-hand loop.
          if (me.roads.length >= 3 && funnel.reachableValue <= 0 && funnel.bestRoadRoute <= 0 &&
            !canPay(after, COSTS.settlement) && !canPay(after, COSTS.city)) {
            s -= 70;
          }
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
      if (handSize(me) <= state.config.discardLimit && me.settlements.length > 0) {
        const cityMissing = costDistance(me.hand, COSTS.city);
        if (cityMissing <= 1) s += 22;
        else if (cityMissing <= 2) s += 10;
      }
      break;
    case "DISCARD": {
      const d = action.discard ?? {};
      s += 5;
      s += discardBoardValue(state, action);
      const nearWinExpansion = me.settlements.length === 0 && totalVP(state, us) >= state.config.victoryPoints - 1;
      const discardCityMissing = costDistance(me.hand, COSTS.city);
      const preserveLastExpansion = me.settlements.length <= 1 && me.cities.length > 0 &&
        settlementSpots(state, me, true).length > 0 &&
        // If the last settlement is still present but the city engine is one
        // production hinge short, keep the ore reserve and let the board
        // repair wheat/ore over the next roll. The expansion-only override is
        // for a complete city hand or a hand that is not a live city route.
        !(discardCityMissing > 0 && discardCityMissing <= 2 && me.hand.ore >= COSTS.city.ore);
      const preserveOpeningExpansion = funnel.active &&
        me.settlements.length < 5 &&
        settlementSpots(state, me, true).length > 0;
      for (const r of RESOURCES) {
        const n = d[r] ?? 0;
        if (nearWinExpansion || preserveLastExpansion) {
          // A player with only cities can still win the final point through a
          // new settlement, and a one-settlement city engine still needs an
          // expansion anchor. Both routes require wood/brick/sheep/wheat to
          // survive the discard. Ore is useful for cities, not for the next
          // house; discard it before the cards that can be converted into a
          // settlement after Road Building or a port trade.
          if (r === "ore") s += n * 5;
          else if (r === "wheat") s -= n * 6;
          else s -= n * 8;
        } else if (preserveOpeningExpansion) {
          // During the two-building funnel, preserve the four cards that can
          // make the next settlement. Discard ore duplicates first; dumping
          // brick/sheep/wood here creates the exact dead position where the
          // bot can only buy devs or trade in circles.
          if (r === "ore") s += n * 7;
          else if (r === "wheat") s -= n * 5;
          else if (r === "sheep") s -= n * 7;
          else s -= n * 9;
        } else if (r === "wheat" || r === "ore") s -= n * 3;
        else s -= n;
      }
      if (nearWinExpansion || preserveLastExpansion) {
        // These positions still need an expansion anchor. Even if a card is
        // plentiful on the board, throwing away wood/brick/sheep/wheat here
        // can make the next house impossible; ore is the safe discard when
        // the hand has no immediate city conversion.
        for (const resource of ["wood", "brick", "sheep", "wheat"] as const) {
          s -= (d[resource] ?? 0) * 30;
        }
      } else if (preserveOpeningExpansion) {
        // In the opening funnel, retain the road/house core even when one of
        // those resources is above the nominal settlement cost. Discard an
        // extra wheat only after the minimum house cards are protected; the
        // remaining candidates are ore duplicates.
        for (const resource of ["wood", "brick", "sheep"] as const) {
          s -= (d[resource] ?? 0) * 20;
        }
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
