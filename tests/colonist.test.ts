import assert from "node:assert/strict";
import { test } from "node:test";
import { applyLogEvent } from "../src/colonist/apply.ts";
import { parseLogLine } from "../src/colonist/log.ts";
import { buildBoardFromColonistHexes } from "../src/engine/colonist_board.ts";
import { applyAction, cloneState, newGame, legalActions, roadLength, roadSpots, totalVP, visibleVP } from "../src/engine/game.ts";
import { production } from "../src/engine/features.ts";
import { boundedSecureLongestRoadRace, forcedWin, heuristicScore, longestRoadPlanScore, openingResourceResilience, roadBuildingHasStrategicProof, roadExpansionScore, roadMaterialsSupportedAfterAction, roadOpenSettlementTarget, roadOpensSupportedEndgameHouse, roadReservesExpansionLane, settlementPairScore, settlementRouteAfterRoad, settlementRouteHasResourceSupport } from "../src/policy/doctrine.ts";
import { decide } from "../src/policy/jev.ts";

function event(text: string, icons: string[] = [], extra: Record<string, unknown> = {}) {
  return { ...parseLogLine(text, icons), ...extra };
}

test("Colonist vkeys share one physical point across incident hexes", () => {
  const raw = [
    [0, -2], [1, -2], [2, -2],
    [-1, -1], [0, -1], [1, -1], [2, -1],
    [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0],
    [-2, 1], [-1, 1], [0, 1], [1, 1],
    [-2, 2], [-1, 2], [0, 2],
  ].map(([q, r], i) => ({ q, r, type: i % 5, diceNumber: 6 }));
  const board = buildBoardFromColonistHexes(raw);
  const target = board.vertices["0,-1|1,-1|1,-2"];
  assert.ok(target);
  assert.ok(Math.abs(target.x) < 1e-9);
  assert.equal(target.y, -2);
  const incident = target.hexes.map((id) => board.hexes[id].vertices.indexOf(target.id)).sort((a, b) => a - b);
  assert.deepEqual(incident, [1, 3, 5]);
});

test("Colonist settlement logs add the settlement VP and use websocket location metadata", () => {
  const state = newGame({ playerCount: 2 }, { seed: 4, names: ["Alice", "Bob"] });
  const vertex = legalActions(state).find((action) => action.type === "PLACE_SETTLEMENT")?.vertex;
  assert.ok(vertex);

  applyLogEvent(state, event("Alice built a Settlement (+1 VP)"), { vertex });

  const alice = state.players.find((p) => p.name === "Alice");
  assert.ok(alice);
  assert.ok(alice.settlements.includes(vertex));
  assert.equal(visibleVP(state, alice.id), 1);
  assert.equal(totalVP(state, alice.id), 1);
  assert.equal(state.phase, "setup_road");
});

test("a setup house without a live corner never creates a guessed road source", () => {
  const state = newGame({ playerCount: 2 }, { seed: 41, names: ["Alice", "Bob"] });

  applyLogEvent(state, event("Alice placed a Settlement (+1 VP)"));

  const alice = state.players[0];
  assert.equal(alice.settlements.length, 0);
  assert.equal(alice.unplaced.settlements, 1);
  assert.equal(state.needsBoardSync, true);
  assert.equal(legalActions(state).length, 0);
});

test("Colonist roll seven creates discard obligations", () => {
  const state = newGame({ playerCount: 2 }, { seed: 5, names: ["Alice", "Bob"] });
  state.phase = "roll";
  state.current = "red";
  const alice = state.players[0];
  alice.hand.wheat = 10;
  alice.hidden.known.wheat = 10;

  applyLogEvent(state, event("Alice rolled", ["dice_3", "dice_4"]));

  assert.deepEqual(state.dice, [3, 4]);
  assert.equal(state.mustDiscard[alice.id], 5);
  assert.equal(state.phase, "discard");
  assert.equal(state.current, alice.id);
});

test("Colonist discard logs remove named cards and resume at the robber", () => {
  const state = newGame({ playerCount: 2 }, { seed: 6, names: ["Alice", "Bob"] });
  const alice = state.players[0];
  state.phase = "discard";
  state.current = alice.id;
  state.roller = alice.id;
  state.mustDiscard[alice.id] = 2;
  alice.hand.wheat = 2;
  alice.hidden.known.wheat = 2;

  applyLogEvent(state, event("Alice discarded 2 wheat"));

  assert.equal(alice.hand.wheat, 0);
  assert.equal(alice.hidden.known.wheat, 0);
  assert.equal(state.mustDiscard[alice.id], undefined);
  assert.equal(state.phase, "robber");
});

test("unknown discard state gives advice instead of inventing card identities", () => {
  const state = newGame({ playerCount: 2 }, { seed: 61, names: ["Alice", "Bob"] });
  const alice = state.players[0];
  state.phase = "discard";
  state.current = alice.id;
  state.mustDiscard[alice.id] = 2;
  alice.hand.wheat = 2;
  alice.hidden.known.wheat = 2;
  alice.hidden.unknown = 3;

  const action = legalActions(state)[0];
  assert.equal(action.type, "DISCARD");
  assert.deepEqual(action.discard, {});
  assert.equal(action.discardUnknown, 2);
  assert.match(action.label, /exact identities are hidden/i);
  assert.match(action.label, /keep wheat and ore/i);
});

test("an unidentified stolen card stays hidden instead of becoming a guessed resource", () => {
  const state = newGame({ playerCount: 2, friendlyRobber: false }, { seed: 7, names: ["Alice", "Bob"] });
  const alice = state.players[0];
  const bob = state.players[1];
  state.phase = "steal";
  state.afterRobber = "turn";
  bob.hand.wheat = 2;
  bob.hidden.known.wheat = 2;

  applyLogEvent(state, event("Alice stole from Bob", ["Resource Card"]));

  assert.equal(alice.hidden.unknown, 1);
  assert.equal(alice.hand.wood + alice.hand.brick + alice.hand.sheep + alice.hand.wheat + alice.hand.ore, 0);
  assert.equal(state.phase, "turn");
});

test("player trade offer parses and forces accept/reject recs", async () => {
  const { parseLogLine } = await import("../src/colonist/log.ts");
  const { applyLogEvent } = await import("../src/colonist/apply.ts");
  const { newGame, legalActions } = await import("../src/engine/game.ts");
  const { decide } = await import("../src/policy/jev.ts");
  const ev = parseLogLine("Hamlin wants to give 1 wheat for 1 ore");
  assert.equal(ev.kind, "offer");
  assert.equal(ev.give, "wheat");
  assert.equal(ev.get, "ore");
  const g = newGame({ playerCount: 2 }, { names: ["You", "Hamlin"], us: "red" });
  g.players[1].name = "Hamlin";
  g.players[0].hand.ore = 1;
  g.players[0].hand.wheat = 1;
  g.players[0].hand.sheep = 1;
  applyLogEvent(g, ev);
  assert.ok(g.pendingOffer);
  assert.equal(g.pendingOffer?.from, "blue");
  const acts = legalActions(g);
  assert.ok(acts.some((a) => a.type === "ACCEPT_TRADE"));
  assert.ok(acts.some((a) => a.type === "REJECT_TRADE"));
  const rec = await decide(g);
  assert.ok(rec.action.type === "ACCEPT_TRADE" || rec.action.type === "REJECT_TRADE");
});

test("trade response does not feed an opponent's immediate city", () => {
  const state = newGame({ playerCount: 4 }, { seed: 14, names: ["You", "Leader", "Blue", "White"], us: "red" });
  const leader = state.players[1];
  leader.settlements.push(Object.keys(state.board.vertices)[0]);
  leader.hand.wood = 1;
  leader.hand.wheat = 2;
  leader.hand.ore = 2;
  state.players[0].hand.ore = 1;
  state.pendingOffer = {
    id: "offer-city",
    from: leader.id,
    give: "wood",
    giveCount: 1,
    get: "ore",
    getCount: 1,
  };

  const actions = legalActions(state);
  const accept = actions.find((action) => action.type === "ACCEPT_TRADE");
  const reject = actions.find((action) => action.type === "REJECT_TRADE");
  assert.ok(accept);
  assert.ok(reject);
  assert.ok(heuristicScore(state, reject) > heuristicScore(state, accept));
});

test("trade response values a scarce brick that advances a real settlement route", () => {
  const state = newGame({ playerCount: 4 }, { seed: 15, names: ["You", "Neighbor", "Blue", "White"], us: "red" });
  const me = state.players[0];
  me.settlements.push(Object.keys(state.board.vertices)[0]);
  me.hand.wood = 1;
  me.hand.sheep = 1;
  me.hand.wheat = 1;
  me.hand.ore = 1;
  state.pendingOffer = {
    id: "offer-scarce-brick",
    from: state.players[1].id,
    give: "brick",
    giveCount: 1,
    get: "ore",
    getCount: 1,
  };

  const actions = legalActions(state);
  const accept = actions.find((action) => action.type === "ACCEPT_TRADE");
  const reject = actions.find((action) => action.type === "REJECT_TRADE");
  assert.ok(accept);
  assert.ok(reject);
  assert.ok(heuristicScore(state, accept) > heuristicScore(state, reject));
});

test("two-building funnel accepts a player brick offer that fixes the expansion bottleneck", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, names: ["You", "Neighbor", "Blue", "White"], us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  me.settlements = [vertices[0], vertices.find((vertex) => vertex !== vertices[0] &&
    !state.board.vertices[vertices[0]].edges.some((edge) => state.board.edges[edge].vertices.includes(vertex)))!];
  me.hand = { wood: 1, brick: 0, sheep: 0, wheat: 1, ore: 1 };
  state.pendingOffer = {
    id: "offer-expansion-brick",
    from: state.players[1].id,
    give: "brick",
    giveCount: 1,
    get: "ore",
    getCount: 1,
  };

  const actions = legalActions(state);
  const accept = actions.find((action) => action.type === "ACCEPT_TRADE");
  const reject = actions.find((action) => action.type === "REJECT_TRADE");
  assert.ok(accept);
  assert.ok(reject);
  assert.ok(heuristicScore(state, accept) > heuristicScore(state, reject));
});

test("trade scoring keeps a hidden-hand near-win sender in the decision", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, names: ["You", "Leader", "Blue", "White"], us: "red" });
  const me = state.players[0];
  const sender = state.players[1];
  const vertices = Object.keys(state.board.vertices);
  sender.cities = vertices.slice(0, 4);
  sender.hidden.unknown = 5;
  me.hand.ore = 1;
  state.pendingOffer = {
    id: "offer-hidden-leader",
    from: sender.id,
    give: "wood",
    giveCount: 1,
    get: "ore",
    getCount: 1,
  };

  const actions = legalActions(state);
  const accept = actions.find((action) => action.type === "ACCEPT_TRADE");
  const reject = actions.find((action) => action.type === "REJECT_TRADE");
  assert.ok(accept);
  assert.ok(reject);
  assert.ok(heuristicScore(state, reject) > heuristicScore(state, accept));
});

test("friendly robber skips an ineligible victim", () => {
  const state = newGame({ playerCount: 2, friendlyRobber: true }, { seed: 8, names: ["Alice", "Bob"] });
  const alice = state.players[0];
  const bob = state.players[1];
  state.phase = "steal";
  state.afterRobber = "turn";
  state.stealFrom = [bob.id];
  bob.hand.ore = 1;
  bob.hidden.known.ore = 1;

  applyLogEvent(state, event("Alice stole from Bob", ["Resource Card"]));

  assert.equal(alice.hidden.unknown, 0);
  assert.equal(bob.hand.ore, 1);
  assert.equal(state.phase, "turn");
});

test("setup settlement scoring values the pair and denial, not only raw pips", () => {
  const state = newGame({ playerCount: 2 }, { seed: 3, names: ["Alice", "Bob"] });
  const actions = legalActions(state).filter((action) => action.type === "PLACE_SETTLEMENT");
  const scores = actions.map((action) => ({ action, score: settlementPairScore(state, action) }));
  const bestPair = scores.slice().sort((a, b) => b.score - a.score)[0];
  const bestHeuristic = actions
    .map((action) => ({ action, score: heuristicScore(state, action) }))
    .sort((a, b) => b.score - a.score)[0];

  assert.ok(bestPair.score > 0);
  assert.ok(bestHeuristic.action.vertex);
  const label = bestHeuristic.action.label.toLowerCase();
  assert.match(label, /wheat|ore/);
});

test("opening resilience prefers independent city resources when alternatives exist", () => {
  const base = newGame({ playerCount: 4 }, { seed: 8, us: "red" });
  const vertices = Object.keys(base.board.vertices);
  const pairs: Array<{ score: number; criticalSources: number }> = [];
  for (const first of vertices) {
    for (const second of vertices) {
      if (first >= second) continue;
      if (base.board.vertices[first].edges.some((edge) => base.board.edges[edge].vertices.includes(second))) continue;
      const state = structuredClone(base);
      state.players[0].settlements = [first, second];
      state.current = "red";
      state.phase = "setup_settle";
      const hexes = new Set<string>();
      for (const vertex of [first, second]) {
        for (const hex of state.board.vertices[vertex].hexes) {
          const terrain = state.board.hexes[hex].terrain;
          if (terrain === "wheat" || terrain === "ore") hexes.add(hex);
        }
      }
      const criticalSources = hexes.size;
      const score = openingResourceResilience(state, "red", [first, second]);
      if (criticalSources === 1 && score < 0) pairs.push({ score, criticalSources });
      if (criticalSources >= 2 && score > 0) pairs.push({ score, criticalSources });
    }
  }
  const fragile = pairs.find((pair) => pair.criticalSources === 1);
  const resilient = pairs.find((pair) => pair.criticalSources >= 2);
  assert.ok(fragile, "fixture should contain a fragile critical-resource pair");
  assert.ok(resilient, "fixture should contain a resilient critical-resource pair");
  assert.ok(resilient.score > fragile.score);
});

test("near-win hidden hands make Monopoly target the opponent's strongest production", () => {
  const state = newGame({ playerCount: 4, victoryPoints: 10 }, { seed: 8, us: "red" });
  state.phase = "roll";
  state.current = "red";
  state.turn = 1;
  state.players[0].devs.monopoly = 1;
  const opponent = state.players[1];
  const vertices = Object.keys(state.board.vertices);
  opponent.settlements = vertices.slice(0, 8);
  opponent.hand = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  opponent.hidden.unknown = 8;
  const productionByResource = {
    wood: production(state, opponent.id).wood,
    brick: production(state, opponent.id).brick,
    sheep: production(state, opponent.id).sheep,
    wheat: production(state, opponent.id).wheat,
    ore: production(state, opponent.id).ore,
  };
  const expected = Object.entries(productionByResource).sort((a, b) => b[1] - a[1])[0][0];
  const choices = legalActions(state).filter((action) => action.type === "PLAY_MONOPOLY");
  const best = choices.slice().sort((a, b) => heuristicScore(state, b) - heuristicScore(state, a))[0];
  assert.equal(visibleVP(state, opponent.id), 8);
  assert.equal(best.resource, expected);
});

test("a third knight that takes Largest Army is recognized as a forced win", () => {
  const state = newGame({ playerCount: 4, victoryPoints: 10 }, { seed: 8, us: "red" });
  const me = state.players[0];
  me.cities = Object.keys(state.board.vertices).slice(0, 4);
  me.knightsPlayed = 2;
  me.devs.knight = 1;
  state.players[1].knightsPlayed = 2;
  state.phase = "roll";
  state.current = me.id;
  state.turn = 1;

  const win = forcedWin(state);
  assert.equal(win?.type, "PLAY_KNIGHT");
});

test("a weak pre-roll knight waits for a better robber window", () => {
  const state = newGame({ playerCount: 4 }, { seed: 8, us: "red" });
  const me = state.players[0];
  me.devs.knight = 1;
  state.phase = "roll";
  state.current = me.id;
  state.turn = 1;

  const play = legalActions(state).find((action) => action.type === "PLAY_KNIGHT");
  const roll = legalActions(state).find((action) => action.type === "ROLL");
  assert.ok(play);
  assert.ok(roll);
  assert.ok(heuristicScore(state, roll) > heuristicScore(state, play));
});

test("a knight clears our blocked ore or wheat engine before a passive roll", () => {
  const state = newGame({ playerCount: 4 }, { seed: 8, us: "red" });
  const me = state.players[0];
  const vertex = Object.keys(state.board.vertices).find((candidate) =>
    state.board.vertices[candidate].hexes.some((hex) => {
      const tile = state.board.hexes[hex];
      return (tile.terrain === "ore" || tile.terrain === "wheat") && tile.number != null;
    }),
  );
  assert.ok(vertex);
  const blocked = state.board.vertices[vertex].hexes.find((hex) => {
    const tile = state.board.hexes[hex];
    return (tile.terrain === "ore" || tile.terrain === "wheat") && tile.number != null;
  });
  assert.ok(blocked);
  me.settlements = [vertex];
  me.devs.knight = 1;
  state.robberHex = blocked;
  state.phase = "roll";
  state.current = me.id;
  state.turn = 1;

  const play = legalActions(state).find((action) => action.type === "PLAY_KNIGHT");
  const roll = legalActions(state).find((action) => action.type === "ROLL");
  assert.ok(play);
  assert.ok(roll);
  assert.ok(heuristicScore(state, play) > heuristicScore(state, roll));
});

test("a city is only a one-VP forced-win increment", () => {
  const state = newGame({ playerCount: 4, victoryPoints: 10 }, { seed: 8, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  me.settlements = vertices.slice(0, 2);
  me.cities = vertices.slice(2, 5);
  me.hand = { wood: 0, brick: 0, sheep: 0, wheat: 2, ore: 3 };
  state.phase = "turn";
  state.current = me.id;
  state.turn = 1;
  // 2 settlements + 3 cities = 8 VP. One city only reaches 9.
  assert.equal(forcedWin(state), null);
  me.devs.vp = 1;
  assert.equal(forcedWin(state)?.type, "BUILD_CITY");
});

test("two-settlement funnel prefers a road route over spending the near-house hand on a dev card", () => {
  const state = newGame({ playerCount: 2 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  const first = vertices[0];
  const firstRoad = state.board.vertices[first].edges[0];
  const second = vertices.find((vertex) => vertex !== first && !state.board.vertices[first].edges.some((edge) =>
    state.board.edges[edge].vertices.includes(vertex),
  ));
  assert.ok(second);
  me.settlements = [first, second];
  me.roads = [firstRoad];
  me.hand = { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 1 };
  state.phase = "turn";
  state.current = me.id;
  state.turn = 1;

  const road = legalActions(state).find(
    (action) => action.type === "BUILD_ROAD" && settlementRouteAfterRoad(state, action) > 0,
  );
  const buyDev = legalActions(state).find((action) => action.type === "BUY_DEV");
  assert.ok(road);
  assert.ok(buyDev);
  assert.ok(heuristicScore(state, road) > heuristicScore(state, buyDev));
});

test("a city does not disable the road-to-third-house funnel", () => {
  const state = newGame({ playerCount: 2 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  const first = vertices[0];
  const second = vertices.find((vertex) => vertex !== first && !state.board.vertices[first].edges.some((edge) =>
    state.board.edges[edge].vertices.includes(vertex),
  ));
  assert.ok(second);
  me.settlements = [first];
  me.cities = [second];
  me.roads = [state.board.vertices[first].edges[0]];
  me.hand = { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 1 };
  state.phase = "turn";
  state.current = me.id;
  state.turn = 1;

  const road = legalActions(state).find(
    (action) => action.type === "BUILD_ROAD" && settlementRouteAfterRoad(state, action) > 0,
  );
  const buyDev = legalActions(state).find((action) => action.type === "BUY_DEV");
  assert.ok(road);
  assert.ok(buyDev);
  assert.ok(heuristicScore(state, road) > heuristicScore(state, buyDev));
});

test("Year of Plenty completes a build route instead of taking the first pair", () => {
  const state = newGame({ playerCount: 2 }, { seed: 23, us: "red" });
  const me = state.players[0];
  me.settlements = [Object.keys(state.board.vertices)[0]];
  me.roads = [state.board.vertices[me.settlements[0]].edges[0]];
  me.hand = { wood: 1, brick: 1, sheep: 0, wheat: 2, ore: 1 };
  state.phase = "year_of_plenty";
  state.current = me.id;
  state.pendingYop = 2;

  const options = legalActions(state).filter((action) => action.type === "PLAY_YEAR_OF_PLENTY");
  const sheepOre = options.find((action) => action.resources?.join(":") === "sheep:ore");
  const woodOre = options.find((action) => action.resources?.join(":") === "wood:ore");
  assert.ok(sheepOre);
  assert.ok(woodOre);
  assert.ok(heuristicScore(state, sheepOre) > heuristicScore(state, woodOre));
});

test("Year of Plenty completes a city hinge after expansion", () => {
  const state = newGame({ playerCount: 2 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  me.settlements = vertices.slice(0, 3);
  me.hand = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 3 };
  state.phase = "year_of_plenty";
  state.current = me.id;
  state.pendingYop = 2;

  const options = legalActions(state).filter((action) => action.type === "PLAY_YEAR_OF_PLENTY");
  const wheatWheat = options.find((action) => action.resources?.join(":") === "wheat:wheat");
  const woodSheep = options.find((action) => action.resources?.join(":") === "wood:sheep");
  assert.ok(wheatWheat);
  assert.ok(woodSheep);
  assert.ok(heuristicScore(state, wheatWheat) > heuristicScore(state, woodSheep));
});

test("Year of Plenty sees an ore pair that completes a city through a 2:1 port", () => {
  const state = newGame({ playerCount: 2 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  me.settlements = vertices.slice(0, 3);
  state.board.vertices[me.settlements[0]].port = { ratio: 2, resource: "brick" };
  me.hand = { wood: 3, brick: 2, sheep: 0, wheat: 3, ore: 0 };
  state.phase = "year_of_plenty";
  state.current = me.id;
  state.pendingYop = 2;

  const options = legalActions(state).filter((action) => action.type === "PLAY_YEAR_OF_PLENTY");
  const twoOre = options.find((action) => action.resources?.join(":") === "ore:ore");
  const sheepOre = options.find((action) => action.resources?.join(":") === "sheep:ore");
  assert.ok(twoOre);
  assert.ok(sheepOre);
  assert.ok(heuristicScore(state, twoOre) > heuristicScore(state, sheepOre));

  const afterPlenty = applyAction(state, twoOre);
  const brickPortTrade = legalActions(afterPlenty).find((action) =>
    action.type === "MARITIME_TRADE" && action.give === "brick" && action.get === "ore",
  );
  assert.ok(brickPortTrade);
  const afterTrade = applyAction(afterPlenty, brickPortTrade);
  assert.ok(legalActions(afterTrade).some((action) => action.type === "BUILD_CITY"));
});

test("holds a near-city hand instead of buying a development card", () => {
  const state = newGame({ playerCount: 2 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const settlement = Object.keys(state.board.vertices)[0];
  me.settlements = [settlement];
  me.hand = { wood: 0, brick: 0, sheep: 1, wheat: 2, ore: 2 };
  state.phase = "turn";
  state.current = me.id;
  state.turn = 1;

  const buyDev = legalActions(state).find((action) => action.type === "BUY_DEV");
  const endTurn = legalActions(state).find((action) => action.type === "END_TURN");
  assert.ok(buyDev);
  assert.ok(endTurn);
  assert.ok(heuristicScore(state, endTurn) > heuristicScore(state, buyDev));
});

test("low-VP last settlement anchor beats a non-winning second city", () => {
  const state = newGame({ playerCount: 4 }, { seed: 29, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  me.settlements = [vertices[0]];
  me.cities = [vertices[10]];
  me.hand = { wood: 0, brick: 0, sheep: 0, wheat: 2, ore: 3 };
  state.phase = "turn";
  state.current = me.id;
  state.turn = 1;

  const city = legalActions(state).find((action) => action.type === "BUILD_CITY");
  const endTurn = legalActions(state).find((action) => action.type === "END_TURN");
  assert.ok(city);
  assert.ok(endTurn);
  assert.ok(heuristicScore(state, endTurn) > heuristicScore(state, city));
});

test("a payable city beats a speculative road chain", async () => {
  const previousOffline = process.env.JEV_OFFLINE;
  process.env.JEV_OFFLINE = "1";
  try {
    const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
    const me = state.players[0];
    const vertices = Object.keys(state.board.vertices);
    me.settlements = [vertices[0]];
    me.cities = [vertices[10]];
    me.roads = [roadSpots(state, me)[0]];
    me.hand = { wood: 1, brick: 1, sheep: 0, wheat: 2, ore: 3 };
    state.phase = "turn";
    state.current = me.id;
    state.turn = 10;

    const rec = await decide(state);
    assert.equal(rec.action.type, "BUILD_CITY");
  } finally {
    if (previousOffline === undefined) delete process.env.JEV_OFFLINE;
    else process.env.JEV_OFFLINE = previousOffline;
  }
});

test("near-win city engine preserves expansion cards during discard", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
  const me = state.players[0];
  me.cities = Object.keys(state.board.vertices).slice(0, 3);
  me.roads = [Object.keys(state.board.edges)[0]];
  me.devs.vp = 1;
  me.hand = { wood: 2, brick: 0, sheep: 2, wheat: 1, ore: 5 };
  state.largestArmy = me.id;
  state.phase = "discard";
  state.current = me.id;
  state.mustDiscard[me.id] = 5;

  const discards = legalActions(state).filter((action) => action.type === "DISCARD");
  const best = discards.slice().sort((a, b) => heuristicScore(state, b) - heuristicScore(state, a))[0];
  assert.ok(best);
  assert.equal(best.discard?.wood ?? 0, 0);
  assert.equal(best.discard?.sheep ?? 0, 0);
  assert.equal(best.discard?.wheat ?? 0, 0);
  assert.equal(best.discard?.ore, 5);
});

test("a one-settlement city engine keeps expansion cards during discard", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  me.settlements = [vertices[0]];
  me.cities = [vertices[10]];
  me.roads = [Object.keys(state.board.edges)[0]];
  me.hand = { wood: 0, brick: 3, sheep: 1, wheat: 2, ore: 4 };
  state.phase = "discard";
  state.current = me.id;
  state.mustDiscard[me.id] = 4;

  const discards = legalActions(state).filter((action) => action.type === "DISCARD");
  const best = discards.slice().sort((a, b) => heuristicScore(state, b) - heuristicScore(state, a))[0];
  assert.ok(best);
  assert.equal(best.discard?.brick ?? 0, 0);
  assert.equal(best.discard?.sheep ?? 0, 0);
  assert.equal(best.discard?.wheat ?? 0, 0);
  assert.equal(best.discard?.ore, 4);
});

test("a one-settlement city engine keeps the exact ore reserve while the board supplies wheat", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  me.settlements = [vertices[0]];
  me.cities = [vertices[10], vertices[20]];
  me.roads = Object.keys(state.board.edges).slice(0, 4);
  me.hand = { wood: 0, brick: 3, sheep: 0, wheat: 0, ore: 5 };
  state.phase = "discard";
  state.current = me.id;
  state.mustDiscard[me.id] = 4;

  const discards = legalActions(state).filter((action) => action.type === "DISCARD");
  const best = discards.slice().sort((a, b) => heuristicScore(state, b) - heuristicScore(state, a))[0];
  assert.ok(best);
  assert.equal(best.discard?.brick, 2);
  assert.equal(best.discard?.ore, 2);
});

test("the expansion funnel trades toward a road instead of a dev-card unlock", () => {
  const state = newGame({ playerCount: 2 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  const first = vertices[0];
  const second = vertices.find((vertex) => vertex !== first && !state.board.vertices[first].edges.some((edge) =>
    state.board.edges[edge].vertices.includes(vertex),
  ));
  assert.ok(second);
  me.settlements = [first, second];
  me.roads = [state.board.vertices[first].edges[0]];
  me.hand = { wood: 1, brick: 0, sheep: 0, wheat: 1, ore: 5 };
  state.phase = "turn";
  state.current = me.id;
  state.turn = 1;

  const oreToBrick = legalActions(state).find((action) =>
    action.type === "MARITIME_TRADE" && action.give === "ore" && action.get === "brick",
  );
  const oreToSheep = legalActions(state).find((action) =>
    action.type === "MARITIME_TRADE" && action.give === "ore" && action.get === "sheep",
  );
  assert.ok(oreToBrick);
  assert.ok(oreToSheep);
  assert.ok(heuristicScore(state, oreToBrick) > heuristicScore(state, oreToSheep));
});

test("after the third building, a surplus road card converts into the city engine", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  me.settlements = vertices.slice(0, 3);
  me.cities = [vertices[3]];
  me.roads = Object.keys(state.board.edges).slice(0, 4);
  me.hand = { wood: 0, brick: 4, sheep: 0, wheat: 2, ore: 2 };
  state.phase = "turn";
  state.current = me.id;
  state.turn = 1;

  const brickToOre = legalActions(state).find((action) =>
    action.type === "MARITIME_TRADE" && action.give === "brick" && action.get === "ore",
  );
  const brickToWood = legalActions(state).find((action) =>
    action.type === "MARITIME_TRADE" && action.give === "brick" && action.get === "wood",
  );
  assert.ok(brickToOre);
  assert.ok(brickToWood);
  assert.ok(heuristicScore(state, brickToOre) > heuristicScore(state, brickToWood));
});

test("three settlements protect the no-city ore reserve from a non-converting trade", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  me.settlements = vertices.slice(0, 3);
  me.roads = Object.keys(state.board.edges).slice(0, 4);
  me.hand = { wood: 0, brick: 0, sheep: 1, wheat: 0, ore: 4 };
  state.phase = "turn";
  state.current = me.id;

  const oreToWheat = legalActions(state).find((action) =>
    action.type === "MARITIME_TRADE" && action.give === "ore" && action.get === "wheat",
  );
  const endTurn = legalActions(state).find((action) => action.type === "END_TURN");
  assert.ok(oreToWheat);
  assert.ok(endTurn);
  // Four ore into one wheat creates neither a legal settlement nor a city;
  // preserving the city reserve is the better competitive tempo.
  assert.ok(heuristicScore(state, endTurn) > heuristicScore(state, oreToWheat));
});

test("a third expansion road can claim a valuable settlement lane before the house is payable", async () => {
  const previousOffline = process.env.JEV_OFFLINE;
  process.env.JEV_OFFLINE = "1";
  try {
    const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
    const me = state.players[0];
    const vertices = Object.keys(state.board.vertices);
    const first = vertices[0];
    const second = vertices.find((vertex) => vertex !== first && !state.board.vertices[first].edges.some((edge) =>
      state.board.edges[edge].vertices.includes(vertex),
    ));
    assert.ok(second);
    me.settlements = [first, second];
    me.roads = [state.board.vertices[first].edges[0]];
    const secondRoad = roadSpots(state, me)[0];
    assert.ok(secondRoad);
    me.roads.push(secondRoad);
    me.hand = { wood: 1, brick: 1, sheep: 1, wheat: 4, ore: 0 };
    state.phase = "turn";
    state.current = me.id;
    state.turn = 1;

    const lane = legalActions(state)
      .filter((action) => action.type === "BUILD_ROAD")
      .map((action) => ({ action, target: roadOpenSettlementTarget(state, action, 3) }))
      .filter(({ target }) => target.value >= 45 && target.depth <= 2 && !target.contested)
      .sort((a, b) => heuristicScore(state, b.action) - heuristicScore(state, a.action))[0];
    assert.ok(lane, "fixture should expose a valuable, uncontested settlement lane");
    assert.equal(roadReservesExpansionLane(state, lane.action), true);

    const rec = await decide(state);
    assert.equal(rec.action.type, "BUILD_ROAD");
    assert.equal(rec.action.edge, lane.action.edge);
  } finally {
    if (previousOffline === undefined) delete process.env.JEV_OFFLINE;
    else process.env.JEV_OFFLINE = previousOffline;
  }
});

test("a supported one-edge house route survives late-game road saturation", async () => {
  const previousOffline = process.env.JEV_OFFLINE;
  process.env.JEV_OFFLINE = "1";
  try {
    const state = newGame({ playerCount: 4 }, { seed: 1, us: "red" });
    const me = state.players[0];
    const start = "-1,-1|-1,0|0,-1";
    const firstRoad = "-1,-1|-1,0|0,-1|-1,-1|0,-1|0,-2";
    const endpoints = state.board.edges[firstRoad].vertices;
    const remoteCities = Object.keys(state.board.vertices)
      .filter((vertex) => vertex !== start && !endpoints.includes(vertex))
      .slice(0, 3);
    me.settlements = [];
    me.cities = [start, ...remoteCities]; // 8 visible VP, no expansion anchor left.
    // Inert identities model a long network already spent elsewhere; the
    // live candidate remains the only route that opens this isolated spot.
    me.roads = [firstRoad, ...Array.from({ length: 7 }, (_, i) => `prior-road-${i}`)];
    me.hand = { wood: 1, brick: 2, sheep: 1, wheat: 0, ore: 0 };
    state.current = me.id;
    state.phase = "turn";
    state.turn = 100;

    const road = legalActions(state)
      .filter((action) => action.type === "BUILD_ROAD")
      .find((action) => roadOpensSupportedEndgameHouse(state, action));
    const endTurn = legalActions(state).find((action) => action.type === "END_TURN");
    assert.ok(road, "fixture should have a supported, direct, uncontested new house spot");
    assert.ok(endTurn);
    assert.equal(roadReservesExpansionLane(state, road), false, "ordinary lane reservation is intentionally capped at seven roads");
    assert.ok(heuristicScore(state, road) > heuristicScore(state, endTurn));

    const rec = await decide(state);
    assert.equal(rec.action.type, "BUILD_ROAD");
    assert.equal(rec.action.edge, road.edge);
  } finally {
    if (previousOffline === undefined) delete process.env.JEV_OFFLINE;
    else process.env.JEV_OFFLINE = previousOffline;
  }
});

test("a road ending at an opponent settlement is treated as a dead zone", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const opponent = state.players[1];
  const start = Object.keys(state.board.vertices)[0];
  const seedEdge = state.board.vertices[start].edges[0];
  const middle = state.board.edges[seedEdge].vertices.find((vertex) => vertex !== start);
  assert.ok(middle);
  const deadEdge = state.board.vertices[middle].edges.find((edge) => edge !== seedEdge);
  assert.ok(deadEdge);
  const blocked = state.board.edges[deadEdge].vertices.find((vertex) => vertex !== middle);
  assert.ok(blocked);

  me.settlements = [start];
  me.roads = [seedEdge];
  me.hand = { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 };
  opponent.settlements = [blocked];
  state.phase = "turn";
  state.current = me.id;

  const road = legalActions(state).find((action) => action.type === "BUILD_ROAD" && action.edge === deadEdge);
  const endTurn = legalActions(state).find((action) => action.type === "END_TURN");
  assert.ok(road);
  assert.ok(endTurn);
  assert.equal(roadOpenSettlementTarget(state, road, 3).value, 0);
  assert.ok(roadExpansionScore(state, road) < 0);
  assert.ok(heuristicScore(state, road) < heuristicScore(state, endTurn));
});

test("Longest Road planner values a bridge between two short road islands", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
  const me = state.players[0];
  me.settlements = [
    "-1,-1|-1,-2|0,-2",
    "1,-2|2,-2|2,-3",
  ];
  me.roads = [
    "-1,-1|0,-1|0,-2|0,-1|0,-2|1,-2",
    "-1,-1|-1,-2|0,-2|-1,-1|0,-1|0,-2",
    "0,-2|1,-2|1,-3|1,-2|1,-3|2,-3",
    "1,-2|1,-3|2,-3|1,-2|2,-2|2,-3",
  ];
  me.hand = { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 };
  state.phase = "turn";
  state.current = me.id;
  const bridge = legalActions(state).find((action) =>
    action.type === "BUILD_ROAD" && action.edge === "0,-1|0,-2|1,-2|0,-2|1,-2|1,-3",
  );
  assert.ok(bridge);
  const plan = longestRoadPlanScore(state, bridge);
  assert.equal(plan.immediateLength, 5);
  assert.equal(plan.claimNow, true);
  assert.equal(plan.secureNow, true);
  const endTurn = legalActions(state).find((action) => action.type === "END_TURN");
  assert.ok(endTurn);
  assert.ok(heuristicScore(state, bridge) > heuristicScore(state, endTurn));
});

test("Road Building is rejected when no house lane has a resource source and no award is secure", () => {
  const state = newGame({ playerCount: 4 }, { seed: 1, us: "red" });
  const me = state.players[0];
  me.settlements = [Object.keys(state.board.vertices)[0]];
  me.devs.road_building = 1;
  me.hand = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  state.phase = "turn";
  state.current = me.id;

  const roadBuilding = legalActions(state).find((action) => action.type === "PLAY_ROAD_BUILDING");
  const endTurn = legalActions(state).find((action) => action.type === "END_TURN");
  assert.ok(roadBuilding);
  assert.ok(endTurn);
  assert.equal(roadBuildingHasStrategicProof(state), false);
  assert.ok(heuristicScore(state, roadBuilding) < heuristicScore(state, endTurn));
});

test("Road Building proof accepts an immediate secure bridge award", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
  const me = state.players[0];
  me.settlements = [
    "-1,-1|-1,-2|0,-2",
    "1,-2|2,-2|2,-3",
  ];
  me.roads = [
    "-1,-1|0,-1|0,-2|0,-1|0,-2|1,-2",
    "-1,-1|-1,-2|0,-2|-1,-1|0,-1|0,-2",
    "0,-2|1,-2|1,-3|1,-2|1,-3|2,-3",
    "1,-2|1,-3|2,-3|1,-2|2,-2|2,-3",
  ];
  me.devs.road_building = 1;
  me.hand = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  state.phase = "turn";
  state.current = me.id;

  const roadBuilding = legalActions(state).find((action) => action.type === "PLAY_ROAD_BUILDING");
  assert.ok(roadBuilding);
  assert.equal(roadBuildingHasStrategicProof(state), true);
});

test("forced-win search finds a two-road Longest Road win from Road Building", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const anchors = ["-1,-1|-1,-2|0,-2", "1,-2|2,-2|2,-3"];
  me.settlements = [];
  me.cities = [...anchors, ...Object.keys(state.board.vertices).filter((vertex) => !anchors.includes(vertex)).slice(0, 2)];
  me.roads = [
    "-1,-1|0,-1|0,-2|0,-1|0,-2|1,-2",
    "-1,-1|-1,-2|0,-2|-1,-1|0,-1|0,-2",
    "0,-2|1,-2|1,-3|1,-2|1,-3|2,-3",
    "1,-2|1,-3|2,-3|1,-2|2,-2|2,-3",
  ];
  me.devs.road_building = 1;
  me.hand = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  state.phase = "roll";
  state.current = me.id;
  state.longestRoad = null;
  state.largestArmy = null;

  assert.equal(totalVP(state, me.id), 8);
  assert.equal(forcedWin(state)?.type, "PLAY_ROAD_BUILDING");
});

test("forced-win search simulates a paid road that joins two networks for Longest Road", () => {
  const state = newGame({ playerCount: 4, victoryPoints: 10 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const opponent = state.players[1];
  const bridge = "-1,-1|-1,-2|0,-2|-1,-2|0,-2|0,-3";
  me.roads = [
    "0,-1|0,-2|1,-2|0,-2|1,-2|1,-3",
    "0,-2|0,-3|1,-3|0,-2|1,-2|1,-3",
    "-1,-2|0,-2|0,-3|0,-2|0,-3|1,-3",
    "-1,-1|-1,-2|0,-2|-1,-1|0,-1|0,-2",
    "-1,-1|-1,0|0,-1|-1,-1|0,-1|0,-2",
    "-1,-1|-1,0|-2,0|-1,-1|-1,0|0,-1",
  ];
  opponent.roads = [
    "0,-1|0,-2|1,-2|0,-1|1,-1|1,-2",
    "0,-1|1,-1|1,-2|1,-1|1,-2|2,-2",
    "1,-1|1,-2|2,-2|1,-2|2,-2|2,-3",
    "1,-2|1,-3|2,-3|1,-2|2,-2|2,-3",
    "0,-2|1,-2|1,-3|1,-2|1,-3|2,-3",
  ];
  const ownPathVertices = [
    "0,-1|0,-2|1,-2",
    "0,-2|1,-2|1,-3",
    "0,-2|0,-3|1,-3",
    "-1,-2|0,-2|0,-3",
    "-1,-1|-1,-2|0,-2",
    "-1,-1|0,-1|0,-2",
    "-1,-1|-1,0|0,-1",
    "-1,-1|-1,0|-2,0",
  ];
  const opponentPathVertices = [
    "0,-1|1,-1|1,-2",
    "1,-1|1,-2|2,-2",
    "1,-2|2,-2|2,-3",
    "1,-2|1,-3|2,-3",
    "0,-2|1,-2|1,-3",
  ];
  const usedVertices = new Set([...ownPathVertices, ...opponentPathVertices]);
  const spareVertices = Object.keys(state.board.vertices).filter((vertex) => !usedVertices.has(vertex));
  me.settlements = [ownPathVertices[0], ownPathVertices[4], ...spareVertices.slice(0, 2)];
  me.cities = spareVertices.slice(2, 4);
  me.hand = { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 };
  state.longestRoad = opponent.id;
  state.current = me.id;
  state.phase = "turn";
  state.turn = 1;

  assert.equal(totalVP(state, me.id), 8);
  assert.equal(roadLength(state, me.id), 3);
  assert.equal(roadLength(state, opponent.id), 5);
  const bridgeAction = legalActions(state).find((action) => action.type === "BUILD_ROAD" && action.edge === bridge);
  assert.ok(bridgeAction);

  const winningAction = forcedWin(state);
  assert.equal(winningAction?.type, "BUILD_ROAD");
  assert.ok(winningAction);
  const won = applyAction(structuredClone(state), winningAction, () => 0.5);
  assert.equal(won.longestRoad, me.id);
  assert.equal(won.winner, me.id);
});

test("Road Building accepts a supported uncontested settlement lane even when the house is not payable", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  const first = vertices[0];
  const second = vertices.find((vertex) => vertex !== first && !state.board.vertices[first].edges.some((edge) =>
    state.board.edges[edge].vertices.includes(vertex),
  ));
  assert.ok(second);
  me.settlements = [first, second];
  me.roads = [state.board.vertices[first].edges[0]];
  me.roads.push(roadSpots(state, me)[0]);
  me.devs.road_building = 1;
  // The pair will expose a valuable third-house route. Wheat, wood, and brick
  // are absent from hand but all have visible production sources.
  me.hand = { wood: 0, brick: 0, sheep: 1, wheat: 0, ore: 0 };
  state.phase = "turn";
  state.current = me.id;

  const roadBuilding = legalActions(state).find((action) => action.type === "PLAY_ROAD_BUILDING");
  const endTurn = legalActions(state).find((action) => action.type === "END_TURN");
  assert.ok(roadBuilding);
  assert.ok(endTurn);
  assert.equal(roadBuildingHasStrategicProof(state), true);
  assert.ok(heuristicScore(state, roadBuilding) > heuristicScore(state, endTurn));
});

test("an unsecured Longest Road race does not justify a road before a house is payable", () => {
  const state = newGame({ playerCount: 4 }, { seed: 1, us: "red" });
  const me = state.players[0];
  const opponent = state.players[1];
  me.settlements = ["0,-1|0,0|1,-1"];
  me.roads = [
    "-1,0|0,-1|0,0|0,-1|0,0|1,-1",
    "-1,0|-1,1|0,0|-1,0|0,-1|0,0",
  ];
  me.hand = { wood: 1, brick: 1, sheep: 1, wheat: 0, ore: 0 };
  opponent.roads = [
    "2,-1|2,-2|3,-2|2,-1|3,-1|3,-2",
    "2,-1|2,0|3,-1|2,-1|3,-1|3,-2",
    "1,0|2,-1|2,0|2,-1|2,0|3,-1",
    "1,-1|1,0|2,-1|1,0|2,-1|2,0",
  ];
  state.phase = "turn";
  state.current = me.id;
  state.turn = 1;

  const road = legalActions(state).find((action) =>
    action.type === "BUILD_ROAD" && action.edge === "0,-1|0,0|1,-1|0,-1|1,-1|1,-2",
  );
  const endTurn = legalActions(state).find((action) => action.type === "END_TURN");
  assert.ok(road);
  assert.ok(endTurn);
  const plan = longestRoadPlanScore(state, road);
  assert.equal(roadMaterialsSupportedAfterAction(state, road), false);
  assert.equal(roadReservesExpansionLane(state, road), false);
  assert.equal(plan.claimNow, false);
  assert.equal(plan.secureNow, false);
  assert.equal(plan.claimSoon, true);
  // The rival is four roads long but can extend to five immediately. A
  // three-edge route that only beats the rival's current length is not a
  // secure investment.
  assert.equal(plan.secureSoon, false);
  assert.equal(plan.roadsToGoal, 3);
  assert.equal(boundedSecureLongestRoadRace(state, road, plan), false);
  assert.ok(heuristicScore(state, road) < heuristicScore(state, endTurn));
});

test("a bounded open settlement route can justify an approach road with one spare road card", () => {
  const state = newGame({ playerCount: 4 }, { seed: 1, us: "red" });
  const me = state.players[0];
  me.settlements = ["0,-1|0,-2|1,-2", "0,-2|0,-3|1,-3"];
  me.roads = [
    "0,-1|0,-2|1,-2|0,-2|1,-2|1,-3",
    "0,-2|0,-3|1,-3|0,-2|1,-2|1,-3",
  ];
  me.hand = { wood: 3, brick: 1, sheep: 1, wheat: 1, ore: 0 };
  state.phase = "turn";
  state.current = me.id;

  const road = legalActions(state)
    .filter((action) => action.type === "BUILD_ROAD")
    .map((action) => ({ action, target: roadOpenSettlementTarget(state, action, 3) }))
    .find(({ target }) => target.value > 45 && target.depth <= 2);
  assert.ok(road);
  assert.equal(road.target.contested, false);
});

test("a supported uncontested lane stays reserved before the settlement is payable", () => {
  const state = newGame({ playerCount: 4 }, { seed: 1, us: "red" });
  const me = state.players[0];
  me.settlements = ["0,-1|0,-2|1,-2"];
  me.cities = ["0,-2|0,-3|1,-3"];
  me.roads = [
    "0,-1|0,-2|1,-2|0,-2|1,-2|1,-3",
    "0,-2|0,-3|1,-3|0,-2|1,-2|1,-3",
  ];
  // The next house is not payable, but there are enough road cards and
  // production support to reserve a valuable, uncontested two-road lane.
  me.hand = { wood: 3, brick: 3, sheep: 1, wheat: 1, ore: 0 };
  state.phase = "turn";
  state.current = me.id;

  const road = legalActions(state)
    .filter((action) => action.type === "BUILD_ROAD")
    .find((action) => roadReservesExpansionLane(state, action));
  assert.ok(road);
  const target = roadOpenSettlementTarget(state, road, 3);
  assert.equal(target.contested, false);
  assert.ok(target.value >= 45);
  assert.ok(target.depth <= 2);
  assert.ok(heuristicScore(state, road) > heuristicScore(state, legalActions(state).find((action) => action.type === "END_TURN")!));
});

test("a city can anchor an expansion road toward a useful port", () => {
  const state = newGame({ playerCount: 4 }, { seed: 1, us: "red" });
  const me = state.players[0];
  me.settlements = [];
  me.cities = ["0,-1|0,-2|1,-2", "0,-2|0,-3|1,-3"];
  me.roads = [
    "0,-1|0,-2|1,-2|0,-2|1,-2|1,-3",
    "0,-2|0,-3|1,-3|0,-2|1,-2|1,-3",
  ];
  // This road spends the last wood/brick pair. The next approach road must
  // wait for production, while the house is supported by the wood harbor and
  // resource engine. The open generic-harbor corner adds a useful wheat stream.
  me.hand = { wood: 1, brick: 1, sheep: 0, wheat: 2, ore: 0 };
  state.phase = "turn";
  state.current = me.id;

  const port = state.board.vertices["-1,-1|-1,-2|0,-2"];
  assert.deepEqual(port.port, { ratio: 3 });
  const road = legalActions(state).find((action) =>
    action.type === "BUILD_ROAD" && action.edge === "-1,-2|0,-2|0,-3|0,-2|0,-3|1,-3",
  );
  assert.ok(road);
  assert.equal(settlementRouteHasResourceSupport(state, road, 2), false);
  const target = roadOpenSettlementTarget(state, road, 3);
  assert.equal(target.contested, false);
  assert.ok(target.value >= 45, `valuable port route scored only ${target.value}`);
  assert.ok(target.depth <= 2);
  assert.equal(roadMaterialsSupportedAfterAction(state, road), true);
  assert.equal(roadReservesExpansionLane(state, road), true);
  assert.ok(heuristicScore(state, road) > heuristicScore(state, legalActions(state).find((action) => action.type === "END_TURN")!));

  const withoutPort = cloneState(state);
  delete withoutPort.board.vertices[port.id].port;
  const sameRoadWithoutPort = legalActions(withoutPort).find((action) =>
    action.type === "BUILD_ROAD" && action.edge === road.edge,
  );
  assert.ok(sameRoadWithoutPort);
  const noPortTarget = roadOpenSettlementTarget(withoutPort, sameRoadWithoutPort, 3);
  assert.ok(target.value > noPortTarget.value + 10);
  assert.equal(roadReservesExpansionLane(withoutPort, sameRoadWithoutPort), false);
});

test("a payable reachable house still beats an unplanned expansion road", () => {
  const state = newGame({ playerCount: 4 }, { seed: 1, us: "red" });
  const me = state.players[0];
  const first = Object.keys(state.board.vertices)[0];
  me.settlements = [first];
  const firstRoad = state.board.vertices[first].edges[0];
  me.roads = [firstRoad];
  const farEnd = state.board.edges[firstRoad].vertices.find((vertex) => vertex !== first)!;
  const secondRoad = state.board.vertices[farEnd].edges.find((edge) => edge !== firstRoad);
  assert.ok(secondRoad);
  me.roads.push(secondRoad);
  me.hand = { wood: 2, brick: 2, sheep: 1, wheat: 1, ore: 1 };
  state.phase = "turn";
  state.current = me.id;

  const actions = legalActions(state);
  const house = actions
    .filter((action) => action.type === "BUILD_SETTLEMENT")
    .sort((a, b) => heuristicScore(state, b) - heuristicScore(state, a))[0];
  const roads = actions.filter((action) => action.type === "BUILD_ROAD");
  assert.ok(house);
  assert.ok(roads.length > 0);
  assert.ok(roads.every((road) => !roadReservesExpansionLane(state, road)));
  assert.ok(heuristicScore(state, house) > Math.max(...roads.map((road) => heuristicScore(state, road))));
});

test("a one-card house route beats buying a development card in the opening funnel", () => {
  const state = newGame({ playerCount: 2 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  const first = vertices[0];
  const second = vertices.find((vertex) => vertex !== first && !state.board.vertices[first].edges.some((edge) =>
    state.board.edges[edge].vertices.includes(vertex),
  ));
  assert.ok(second);
  me.settlements = [first, second];
  me.roads = [state.board.vertices[first].edges[0]];
  me.hand = { wood: 1, brick: 0, sheep: 1, wheat: 4, ore: 1 };
  state.phase = "turn";
  state.current = me.id;
  state.turn = 1;

  const trade = legalActions(state).find((action) =>
    action.type === "MARITIME_TRADE" && action.give === "wheat" && action.get === "brick",
  );
  const buyDev = legalActions(state).find((action) => action.type === "BUY_DEV");
  assert.ok(trade);
  assert.ok(buyDev);
  assert.ok(heuristicScore(state, trade) > heuristicScore(state, buyDev));
});

test("opening-funnel discard enumeration keeps the expansion hand and drops ore duplicates", () => {
  const state = newGame({ playerCount: 4 }, { seed: 23, us: "red" });
  const me = state.players[0];
  const vertices = Object.keys(state.board.vertices);
  me.settlements = [vertices[0], vertices[10]];
  me.roads = [Object.keys(state.board.edges)[0]];
  me.hand = { wood: 1, brick: 2, sheep: 1, wheat: 2, ore: 3 };
  state.phase = "discard";
  state.current = me.id;
  state.mustDiscard[me.id] = 4;

  const discards = legalActions(state).filter((action) => action.type === "DISCARD");
  const best = discards.slice().sort((a, b) => heuristicScore(state, b) - heuristicScore(state, a))[0];
  assert.ok(best);
  assert.equal(best.discard?.wood ?? 0, 0);
  assert.equal(best.discard?.brick ?? 0, 0);
  assert.equal(best.discard?.sheep ?? 0, 0);
  assert.equal(best.discard?.wheat ?? 0, 1);
  assert.equal(best.discard?.ore, 3);
});

test("board-aware discard preserves a two-for-one expansion port pair", () => {
  const state = newGame({ playerCount: 4 }, { seed: 4, us: "red" });
  const me = state.players[0];
  const portVertex = "0,-2|1,-2|1,-3";
  const other = Object.keys(state.board.vertices).find((vertex) =>
    vertex !== portVertex && !state.board.vertices[portVertex].edges.some((edge) =>
      state.board.edges[edge].vertices.includes(vertex),
    ),
  );
  assert.ok(other);
  me.settlements = [portVertex, other];
  me.roads = [state.board.vertices[portVertex].edges[0], state.board.vertices[other].edges[0]];
  me.hand = { wood: 3, brick: 2, sheep: 2, wheat: 2, ore: 3 };
  state.phase = "discard";
  state.current = me.id;
  state.mustDiscard[me.id] = 6;

  const best = legalActions(state)
    .filter((action) => action.type === "DISCARD")
    .sort((a, b) => heuristicScore(state, b) - heuristicScore(state, a))[0];
  assert.ok(best);
  assert.equal(best.discard?.wood ?? 0, 0);
  assert.equal(best.discard?.ore, 3);
});

test("won the game log sets the Colonist winner", () => {
  const state = newGame({ playerCount: 4 }, { seed: 4, names: ["Izak", "Lise", "Zuzana", "Ru"], us: "red" });
  applyLogEvent(state, parseLogLine("Izak won the game"));
  assert.equal(state.winner, "red");
  assert.equal(state.phase, "ended");
});

test("mapState corners occupy every seat by Colonist color id", async () => {
  const { applyOccupancyFromMapState } = await import("../src/colonist/apply.ts");
  const { vkey } = await import("../src/engine/colonist_board.ts");
  const { occupyUs } = await import("../src/play/target.ts");
  const state = newGame({ playerCount: 4 }, { seed: 4, names: ["Izak", "Lise", "Zuzana", "Ru"], us: "red" });
  const north = vkey(0, 0, 2);
  const liseA = vkey(1, 0, 5);
  const liseB = vkey(-1, 1, 2);
  const zuzana = vkey(0, 1, 5);
  const ru = vkey(1, -1, 2);
  const fake = Object.keys(state.board.vertices).find((id) => id !== north);
  assert.ok(fake);
  occupyUs(state, { vertex: fake });
  occupyUs(state, { vertex: north });
  occupyUs(state, { vertex: liseA });
  assert.equal(state.players[0].settlements.length, 2);

  const tileCornerStates: Record<string, { x: number; y: number; z: number; owner?: number; building?: number }> = {};
  let n = 0;
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      for (const z of [0, 1]) {
        n += 1;
        tileCornerStates[String(n)] = { x, y, z };
      }
    }
  }
  tileCornerStates.izak = { x: 0, y: 0, z: 0, owner: 2, building: 1 };
  tileCornerStates.liseA = { x: 1, y: 0, z: 1, owner: 1, building: 1 };
  tileCornerStates.liseB = { x: -1, y: 1, z: 0, owner: 1, building: 1 };
  tileCornerStates.zuzana = { x: 0, y: 1, z: 1, owner: 3, building: 1 };
  tileCornerStates.ru = { x: 1, y: -1, z: 0, owner: 5, building: 1 };
  const tileEdgeStates = {
    izakRoad: { x: 0, y: 0, z: 1, owner: 2 },
  };
  const placed = applyOccupancyFromMapState(state, {
    playerUserStates: {
      2: { username: "Izak", selectedColor: 2 },
      1: { username: "Lise", selectedColor: 1 },
      3: { username: "Zuzana", selectedColor: 3 },
      5: { username: "Ru", selectedColor: 5 },
    },
    tileHexStates: { 1: { x: 0, y: 0, type: 1, diceNumber: 6 } },
    tileCornerStates,
    tileEdgeStates,
  });
  assert.ok(placed >= 5);
  const izak = state.players.find((p) => p.name === "Izak")!;
  const lise = state.players.find((p) => p.name === "Lise")!;
  const zuz = state.players.find((p) => p.name === "Zuzana")!;
  const ruP = state.players.find((p) => p.name === "Ru")!;
  assert.deepEqual(izak.settlements, [north]);
  assert.equal(izak.settlements.includes(fake), false);
  assert.equal(lise.settlements.includes(liseA), true);
  assert.equal(lise.settlements.includes(liseB), true);
  assert.equal(zuz.settlements.includes(zuzana), true);
  assert.equal(ruP.settlements.includes(ru), true);
  assert.equal(izak.roads.length, 1);
});

test("occupancy diffs that only send owner reuse GameStart corner coordinates", async () => {
  const { applyOccupancyFromMapState } = await import("../src/colonist/apply.ts");
  const { vkey } = await import("../src/engine/colonist_board.ts");
  const state = newGame({ playerCount: 2 }, { seed: 4, names: ["Izak", "Hinson"], us: "red" });
  const north = vkey(0, 0, 2);
  applyOccupancyFromMapState(state, {
    tileHexStates: { 1: { x: 0, y: 0, type: 1, diceNumber: 6 } },
    tileCornerStates: { 7: { x: 0, y: 0, z: 0 } },
  });
  assert.equal(state.players[1].settlements.includes(north), false);
  const placed = applyOccupancyFromMapState(state, {
    tileCornerStates: { 7: { owner: 1, building: 1 } },
    playerUserStates: { 1: { username: "Hinson", selectedColor: 1 } },
  });
  assert.ok(placed >= 1);
  const hinson = state.players.find((p) => p.name === "Hinson")!;
  assert.equal(hinson.settlements.includes(north), true);
});

test("nested occupancy diffs without tileHexStates still occupy a corner", async () => {
  const { applyOccupancyFromMapState } = await import("../src/colonist/apply.ts");
  const { vkey } = await import("../src/engine/colonist_board.ts");
  const state = newGame({ playerCount: 2 }, { seed: 4, names: ["Izak", "Eadie"], us: "red" });
  const north = vkey(0, 0, 2);
  applyOccupancyFromMapState(state, {
    tileHexStates: { 1: { x: 0, y: 0, type: 1, diceNumber: 6 } },
    tileCornerStates: { 9: { x: 0, y: 0, z: 0 } },
  });
  const placed = applyOccupancyFromMapState(state, {
    data: { tileCornerStates: { 9: { owner: 1, building: 1 } } },
    playerUserStates: { 1: { username: "Eadie", selectedColor: 1 } },
  });
  assert.ok(placed >= 1);
  const eadie = state.players.find((p) => p.name === "Eadie")!;
  assert.equal(eadie.settlements.includes(north), true);
});

test("occupancy diffs still resolve after a new GameState like resetGame", async () => {
  const { applyOccupancyFromMapState } = await import("../src/colonist/apply.ts");
  const { vkey } = await import("../src/engine/colonist_board.ts");
  const first = newGame({ playerCount: 2 }, { seed: 4, names: ["Izak", "Kela"], us: "red" });
  const north = vkey(0, 0, 2);
  applyOccupancyFromMapState(first, {
    tileHexStates: { 1: { x: 0, y: 0, type: 1, diceNumber: 6 } },
    tileCornerStates: { 12: { x: 0, y: 0, z: 0 } },
  });
  const next = newGame({ playerCount: 2 }, { seed: 5, names: ["Izak", "Kela"], us: "red" });
  const placed = applyOccupancyFromMapState(next, {
    tileCornerStates: { 12: { owner: 1, building: 1 } },
    playerUserStates: { 1: { username: "Kela", selectedColor: 1 } },
  });
  assert.ok(placed >= 1);
  const kela = next.players.find((p) => p.name === "Kela")!;
  assert.equal(kela.settlements.includes(north), true);
});
