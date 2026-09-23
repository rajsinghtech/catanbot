import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAction, legalActions, newGame, refreshAwards, roadLength, syncSetupFromPieces, totalVP, visibleVP } from "../src/engine/game.ts";
import { buildStandardBoard } from "../src/engine/map.ts";
import { parseLogLine } from "../src/colonist/log.ts";
import { heuristicScore, longestRoadPlanScore, setupSecondSettlementScore } from "../src/policy/doctrine.ts";
import { decide } from "../src/policy/jev.ts";

test("click target for a setup house is a finite board point", async () => {
  const { newGame, legalActions } = await import("../src/engine/game.ts");
  const { clickFor } = await import("../src/play/target.ts");
  const { decide } = await import("../src/policy/jev.ts");
  const g = newGame({ playerCount: 2 }, { seed: 9, us: "red" });
  const rec = await decide(g);
  const click = clickFor(g, rec);
  assert.ok(click);
  assert.equal(click.kind, "board");
  assert.equal(typeof click.x, "number");
  assert.equal(Number.isFinite(click.x), true);
  assert.equal(Number.isFinite(click.y), true);
  const house = legalActions(g).find((a) => a.id === rec.action.id);
  assert.ok(house?.vertex);
  assert.equal(click.vertex, house.vertex);
});

test("portEdgeStates sit on the two vertices of that Colonist edge", async () => {
  const {
    applyHarbors,
    buildBoardFromColonistHexes,
    edgeFromColonistEdge,
    harborsFromMapState,
  } = await import("../src/engine/colonist_board.ts");
  const coords: Array<[number, number]> = [
    [0, -2], [1, -2], [2, -2], [-1, -1], [0, -1], [1, -1], [2, -1],
    [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0],
    [-2, 1], [-1, 1], [0, 1], [1, 1], [-2, 2], [-1, 2], [0, 2],
  ];
  const tiles = coords.map(([x, y], i) => ({
    x,
    y,
    type: i === 8 ? 0 : 1,
    diceNumber: i === 8 ? null : 6,
  }));
  const portEdgeStates = {
    1: { x: 0, y: -2, z: 0, type: 1 },
    2: { x: -2, y: 0, z: 1, type: 2 },
    3: { x: -2, y: 1, z: 2, type: 3 },
    4: { x: 0, y: 2, z: 2, type: 4 },
    5: { x: 1, y: 1, z: 2, type: 5 },
    6: { x: 2, y: -2, z: 0, type: 6 },
    7: { x: 2, y: -1, z: 0, type: 1 },
    8: { x: 1, y: -2, z: 0, type: 1 },
    9: { x: -1, y: -1, z: 0, type: 1 },
  };
  const board = buildBoardFromColonistHexes(tiles);
  const harbors = harborsFromMapState({ portEdgeStates });
  assert.equal(harbors.length, 9);
  assert.equal(harbors[0].z, 0);
  applyHarbors(board, harbors);

  const generic = edgeFromColonistEdge(board, { x: 0, y: -2, z: 0 });
  assert.ok(generic);
  for (const vid of board.edges[generic].vertices) {
    assert.equal(board.vertices[vid].port?.ratio, 3);
    assert.equal(board.vertices[vid].port?.resource, undefined);
  }
  const wood = edgeFromColonistEdge(board, { x: -2, y: 0, z: 1 });
  assert.ok(wood);
  for (const vid of board.edges[wood].vertices) {
    assert.equal(board.vertices[vid].port?.ratio, 2);
    assert.equal(board.vertices[vid].port?.resource, "wood");
  }
  const ore = edgeFromColonistEdge(board, { x: 2, y: -2, z: 0 });
  assert.ok(ore);
  for (const vid of board.edges[ore].vertices) {
    assert.equal(board.vertices[vid].port?.resource, "ore");
  }
  const brickPorts = Object.values(board.vertices).filter((v) => v.port?.resource === "brick");
  assert.equal(brickPorts.length, 2);
});

test("colonist ingest lays down coastal ports", async () => {
  const { buildBoardFromColonistHexes } = await import("../src/engine/colonist_board.ts");
  const tiles = [];
  for (const [q, r] of [
    [0, -2], [1, -2], [2, -2], [-1, -1], [0, -1], [1, -1], [2, -1],
    [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0],
    [-2, 1], [-1, 1], [0, 1], [1, 1], [-2, 2], [-1, 2], [0, 2],
  ]) {
    tiles.push({ x: q, y: r, type: 1, diceNumber: 6 });
  }
  tiles[8].type = 0;
  tiles[8].diceNumber = null;
  const board = buildBoardFromColonistHexes(tiles);
  const ports = Object.values(board.vertices).filter((v) => v.port);
  assert.ok(ports.length >= 8);
});

test("standard map has 19 hexes, 54 vertices, 72 edges", () => {
  const b = buildStandardBoard(1);
  assert.equal(Object.keys(b.hexes).length, 19);
  assert.equal(Object.keys(b.vertices).length, 54);
  assert.equal(Object.keys(b.edges).length, 72);
  const desert = Object.values(b.hexes).filter((h) => h.terrain === "desert");
  assert.equal(desert.length, 1);
});

test("supports 2-6 players with 1v1 rules defaulting to 15 VP", () => {
  const g2 = newGame({ playerCount: 2 });
  assert.equal(g2.config.victoryPoints, 15);
  assert.equal(g2.config.discardLimit, 9);
  assert.equal(g2.config.friendlyRobber, true);
  const g4 = newGame({ playerCount: 4 });
  assert.equal(g4.config.victoryPoints, 10);
  assert.equal(g4.players.length, 4);
  const g6 = newGame({ playerCount: 6 }, { names: ["a", "b", "c", "d", "e", "f"] });
  assert.equal(g6.players.length, 6);
});

test("unmodeled Colonist expansion menus pause safely instead of guessing a turn action", () => {
  const g = newGame({ playerCount: 4 }, { seed: 21, us: "red" });
  g.phase = "special";
  assert.deepEqual(legalActions(g), []);
});

test("setup places settlements with distance rule then second-ring resources", () => {
  const g = newGame({ playerCount: 2 }, { seed: 3 });
  const first = legalActions(g);
  assert.ok(first.length > 10);
  applyAction(g, first[0]);
  const roads = legalActions(g);
  assert.equal(g.phase, "setup_road");
  assert.ok(roads.length >= 1);
  applyAction(g, roads[0]);
  assert.equal(g.current, "blue");
});

test("a full 2p setup plus rolls does not crash and produces legal actions", () => {
  const g = newGame({ playerCount: 2 }, { seed: 11, us: "red" });
  let guard = 0;
  while (g.phase !== "roll" && guard++ < 20) {
    const acts = legalActions(g);
    assert.ok(acts.length, `no acts in ${g.phase}`);
    applyAction(g, acts[0], () => 0.1);
  }
  assert.equal(g.phase, "roll");
  assert.equal(g.players[0].settlements.length, 2);
  assert.equal(g.players[1].settlements.length, 2);
  const acts = legalActions(g);
  assert.ok(acts.some((a) => a.type === "ROLL"));
});

test("self-play 80 plies stays legal and keeps VP in range", () => {
  const g = newGame({ playerCount: 3 }, { seed: 42, names: ["A", "B", "C"] });
  for (let i = 0; i < 80; i++) {
    const acts = legalActions(g);
    if (g.phase === "ended" || acts.length === 0) break;
    const scored = acts
      .map((a) => ({ a, s: heuristicScore(g, a) }))
      .sort((x, y) => y.s - x.s);
    applyAction(g, scored[0].a, () => ((i + 1) * 17 % 100) / 100);
    for (const p of g.players) {
      assert.ok(totalVP(g, p.id) >= visibleVP(g, p.id));
      assert.ok(totalVP(g, p.id) <= 20);
    }
  }
  assert.ok(g.turn >= 1 || g.phase === "ended" || g.phase.startsWith("setup"));
});

test("setup road with no house offers a settlement first", () => {
  const g = newGame({ playerCount: 2 }, { seed: 2 });
  g.phase = "setup_road";
  const acts = legalActions(g);
  assert.ok(acts.every((a) => a.type === "PLACE_SETTLEMENT"));
  assert.ok(acts.length > 0);
});

test("setup road uses the observed newest settlement instead of board-array order", () => {
  const g = newGame({ playerCount: 2 }, { seed: 12, us: "red" });
  const [older, newest] = Object.keys(g.board.vertices).slice(0, 2);
  g.players[0].settlements = [newest, older];
  g.setupAnchor[g.players[0].id] = older;
  g.phase = "setup_road";
  g.current = g.players[0].id;
  g.needsBoardSync = false;

  const actions = legalActions(g);
  assert.ok(actions.length > 0);
  assert.equal(actions.every((action) => action.vertex === older), true);
});

test("setup road prefers the only settlement without an existing road", () => {
  const g = newGame({ playerCount: 2 }, { seed: 13, us: "red" });
  const [older] = Object.keys(g.board.vertices);
  const road = Object.values(g.board.edges).find((edge) => edge.vertices.includes(older));
  assert.ok(road);
  const newest = Object.keys(g.board.vertices).find((id) => id !== older && !road.vertices.includes(id));
  assert.ok(newest);
  g.players[0].settlements = [newest, older];
  g.players[0].roads = [road.id];
  g.setupAnchor[g.players[0].id] = older;
  g.phase = "setup_road";
  g.current = g.players[0].id;
  g.needsBoardSync = false;

  const actions = legalActions(g);
  assert.ok(actions.length > 0);
  assert.equal(actions.every((action) => action.vertex === newest), true);
});

test("setup does not ask a player who already sat a house to sit another in the forward round", () => {
  const g = newGame({ playerCount: 4 }, { names: ["Edlyn", "Decato", "Masry", "You"], us: "brown" });
  g.us = "brown";
  const youPlayer = g.players[3];
  youPlayer.settlements.push(Object.keys(g.board.vertices)[0]);
  youPlayer.roads.push(Object.keys(g.board.edges)[0]);
  g.players[0].settlements.push(Object.keys(g.board.vertices)[1]);
  g.players[0].roads.push(Object.keys(g.board.edges)[1]);
  g.players[1].settlements.push(Object.keys(g.board.vertices)[2]);
  g.players[1].roads.push(Object.keys(g.board.edges)[2]);
  g.players[2].settlements.push(Object.keys(g.board.vertices)[3]);
  g.players[2].roads.push(Object.keys(g.board.edges)[3]);
  syncSetupFromPieces(g);
  assert.equal(g.setupForward, false);
  assert.equal(g.current, youPlayer.id);
  assert.equal(g.phase, "setup_settle");
  g.setupForward = true;
  g.phase = "setup_settle";
  g.current = youPlayer.id;
  const acts = legalActions(g);
  assert.equal(acts.length, 0);
});

test("second house rec is ours when others already have two houses", () => {
  const g = newGame({ playerCount: 4 }, { names: ["Rankin", "Gert", "Peery", "Izak"], us: "white" });
  g.us = g.players[3].id;
  for (const p of g.players.slice(0, 3)) {
    p.unplaced.settlements = 2;
    p.unplaced.roads = 2;
  }
  g.players[3].unplaced.settlements = 1;
  g.players[3].unplaced.roads = 1;
  g.needsBoardSync = true;
  syncSetupFromPieces(g);
  assert.equal(g.current, g.us);
  assert.equal(g.phase, "setup_settle");
  assert.equal(g.setupForward, false);
  const acts = legalActions(g);
  assert.ok(acts.some((a) => a.type === "PLACE_SETTLEMENT" && a.player === g.us));
  assert.equal(acts.some((a) => a.player !== g.us), false);
});

test("second setup house prefers completing a missing core resource", () => {
  const g = newGame({ playerCount: 4 }, { seed: 1, us: "red" });
  const first = legalActions(g).find((action) => {
    const resources = new Set(
      (g.board.vertices[action.vertex!]?.hexes ?? [])
        .map((hex) => g.board.hexes[hex]?.terrain)
        .filter((terrain) => terrain !== "desert"),
    );
    return resources.size >= 2 && ["wood", "brick", "sheep", "wheat"].some((r) => !resources.has(r));
  });
  assert.ok(first?.vertex);
  const p = g.players[0];
  p.settlements = [first.vertex];
  g.current = p.id;
  g.phase = "setup_settle";
  g.setupForward = false;
  const firstResources = new Set(
    g.board.vertices[first.vertex].hexes
      .map((hex) => g.board.hexes[hex]?.terrain)
      .filter((terrain) => terrain !== "desert"),
  );
  const missing = ["wood", "brick", "sheep", "wheat"].find((r) => !firstResources.has(r));
  assert.ok(missing);
  const candidates = legalActions(g).filter((action) => action.type === "PLACE_SETTLEMENT");
  const completes = candidates.filter((action) =>
    g.board.vertices[action.vertex!].hexes.some((hex) => g.board.hexes[hex]?.terrain === missing),
  );
  const repeats = candidates.filter((action) =>
    !g.board.vertices[action.vertex!].hexes.some((hex) => g.board.hexes[hex]?.terrain === missing),
  );
  assert.ok(completes.length > 0 && repeats.length > 0);
  const bestCompleting = Math.max(...completes.map((action) => setupSecondSettlementScore(g, p.id, action.vertex!)));
  const bestRepeating = Math.max(...repeats.map((action) => setupSecondSettlementScore(g, p.id, action.vertex!)));
  assert.ok(bestCompleting > bestRepeating);
});

test("second setup house secures wheat when an open wheat corner remains", async () => {
  const previousOffline = process.env.JEV_OFFLINE;
  process.env.JEV_OFFLINE = "1";
  try {
    const g = newGame({ playerCount: 4 }, { seed: 1, us: "red" });
    const terrainAt = (vertex: string, terrain: string) =>
      g.board.vertices[vertex]?.hexes.some((hex) => g.board.hexes[hex]?.terrain === terrain) ?? false;
    const first = legalActions(g).find((action) =>
      action.type === "PLACE_SETTLEMENT" && action.vertex &&
      !terrainAt(action.vertex, "wheat") &&
      (terrainAt(action.vertex, "wood") || terrainAt(action.vertex, "brick")),
    );
    assert.ok(first?.vertex);

    const me = g.players[0];
    me.settlements = [first.vertex];
    g.current = me.id;
    g.phase = "setup_settle";
    g.setupForward = false;
    const candidates = legalActions(g).filter((action) => action.type === "PLACE_SETTLEMENT" && action.vertex);
    const wheat = candidates.filter((action) => terrainAt(action.vertex!, "wheat"));
    assert.ok(wheat.length > 0, "fixture should leave legal wheat corners available");

    const wheatAndExpansion = wheat.filter((action) =>
      terrainAt(action.vertex!, "wood") || terrainAt(action.vertex!, "brick"),
    );
    const rec = await decide(g);
    assert.equal(rec.action.type, "PLACE_SETTLEMENT");
    assert.ok(terrainAt(rec.action.vertex!, "wheat"), "do not give away all wheat production for a wood/brick-only corner");
    if (wheatAndExpansion.length) {
      assert.ok(wheatAndExpansion.some((action) => action.vertex === rec.action.vertex));
    }
  } finally {
    if (previousOffline === undefined) delete process.env.JEV_OFFLINE;
    else process.env.JEV_OFFLINE = previousOffline;
  }
});

test("longest road requires 5 connected roads", () => {
  const g = newGame({ playerCount: 2 }, { seed: 2 });
  assert.equal(roadLength(g, "red"), 0);
  assert.equal(g.longestRoad, null);
});

function findSimpleRoadPath(state: ReturnType<typeof newGame>, length: number): string[] {
  const walk = (vertex: string, usedEdges: Set<string>, usedVertices: Set<string>, path: string[]): string[] | null => {
    if (path.length === length) return path;
    for (const edge of Object.values(state.board.edges)) {
      if (usedEdges.has(edge.id) || !edge.vertices.includes(vertex)) continue;
      const next = edge.vertices[0] === vertex ? edge.vertices[1] : edge.vertices[0];
      if (usedVertices.has(next)) continue;
      const found = walk(
        next,
        new Set([...usedEdges, edge.id]),
        new Set([...usedVertices, next]),
        [...path, edge.id],
      );
      if (found) return found;
    }
    return null;
  };
  for (const edge of Object.values(state.board.edges)) {
    const found = walk(edge.vertices[1], new Set([edge.id]), new Set(edge.vertices), [edge.id]);
    if (found) return found;
  }
  throw new Error(`could not find a ${length}-road path`);
}

test("road claims Longest Road only when the award is immediate and secure", () => {
  const g = newGame({ playerCount: 2 }, { seed: 1, us: "red" });
  const path = findSimpleRoadPath(g, 5);
  const me = g.players[0];
  me.settlements = [g.board.edges[path[0]].vertices[0]];
  me.roads = path.slice(0, 4);
  me.hand = { wood: 3, brick: 3, sheep: 2, wheat: 2, ore: 2 };
  g.phase = "turn";
  g.current = "red";
  refreshAwards(g);

  const actions = legalActions(g);
  const road = actions.find((action) => action.type === "BUILD_ROAD" && action.edge === path[4]);
  assert.ok(road);
  const plan = longestRoadPlanScore(g, road);
  assert.equal(plan.claimNow, true);
  assert.equal(plan.secureNow, true);
  const bestHouse = Math.max(
    ...actions
      .filter((action) => action.type === "BUILD_SETTLEMENT" || action.type === "BUILD_CITY")
      .map((action) => heuristicScore(g, action)),
  );
  assert.ok(heuristicScore(g, road) > bestHouse);
});

test("a safe Longest Road holder yields to a direct settlement", () => {
  const g = newGame({ playerCount: 2 }, { seed: 1, us: "red" });
  const path = findSimpleRoadPath(g, 6);
  const me = g.players[0];
  me.settlements = [g.board.edges[path[0]].vertices[0]];
  me.roads = path.slice(0, 5);
  me.hand = { wood: 3, brick: 3, sheep: 2, wheat: 2, ore: 2 };
  g.phase = "turn";
  g.current = "red";
  refreshAwards(g);
  assert.equal(g.longestRoad, "red");

  const actions = legalActions(g);
  const road = actions.find((action) => action.type === "BUILD_ROAD" && action.edge === path[5]);
  assert.ok(road);
  assert.equal(longestRoadPlanScore(g, road).value, -22);
  const bestHouse = Math.max(
    ...actions
      .filter((action) => action.type === "BUILD_SETTLEMENT" || action.type === "BUILD_CITY")
      .map((action) => heuristicScore(g, action)),
  );
  assert.ok(bestHouse > heuristicScore(g, road));
});

test("colonist log parser reads builds, rolls, steals", () => {
  const a = parseLogLine("Rush built a Settlement  (+1 VP)", ["settlement"]);
  assert.equal(a.kind, "built");
  assert.equal(a.vp, 1);
  const b = parseLogLine("Gratia rolled", ["dice_3", "dice_4"]);
  assert.equal(b.kind, "roll");
  assert.deepEqual(b.dice, [3, 4]);
  const c = parseLogLine("Gratia stole  from Nona", ["Resource Card"]);
  assert.equal(c.kind, "stole");
  const d = parseLogLine("Friendly Robber is active, tiles available to block are limited", ["robber"]);
  assert.equal(d.kind, "friendly");
});

test("decide returns the required output fields", async () => {
  const g = newGame({ playerCount: 2 }, { seed: 9, us: "red" });
  const rec = await decide(g);
  assert.ok(rec.action.label);
  assert.ok(rec.target);
  assert.ok(rec.reason);
  assert.ok(rec.plan);
  assert.ok(rec.opponentThreat);
  assert.ok(rec.confidence >= 0 && rec.confidence <= 100);
});
