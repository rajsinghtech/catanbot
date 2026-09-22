import assert from "node:assert/strict";
import { test } from "node:test";
import { applyLogEvent } from "../src/colonist/apply.ts";
import { parseLogLine } from "../src/colonist/log.ts";
import { buildBoardFromColonistHexes } from "../src/engine/colonist_board.ts";
import { newGame, legalActions, totalVP, visibleVP } from "../src/engine/game.ts";
import { production } from "../src/engine/features.ts";
import { forcedWin, heuristicScore, settlementPairScore, settlementRouteAfterRoad } from "../src/policy/doctrine.ts";

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
