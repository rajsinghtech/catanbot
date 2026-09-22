import assert from "node:assert/strict";
import { test } from "node:test";
import { legalActions, newGame } from "../src/engine/game.ts";
import { decide } from "../src/policy/jev.ts";
import {
  autoClickAllowed,
  clickFor,
  inBox,
  islandBox,
  mapInitialPlacementConfirmation,
  mapIslandClick,
  occupyUs,
  pickUiHit,
  vertexClickCluster,
} from "../src/play/target.ts";
import { mergeLiveAppState } from "../src/server.ts";
import type { Recommendation } from "../src/types.ts";

test("fast trade projection does not erase the live app turn state", () => {
  const full = mergeLiveAppState({}, {
    currentState: {
      actionState: 0,
      turnState: 2,
      completedTurns: 98,
      currentTurnPlayerColor: 1,
    },
    diceState: { diceThrown: true },
  });
  const tradeOnly = mergeLiveAppState(full, { currentState: {}, diceState: {} });
  assert.equal(tradeOnly.actionState, 0);
  assert.equal(tradeOnly.turnState, 2);
  assert.equal(tradeOnly.completedTurns, 98);
  assert.equal(tradeOnly.currentPlayerColor, 1);
  assert.equal(tradeOnly.diceThrown, true);
});

test("setup-house rec click names that same vertex", async () => {
  const g = newGame({ playerCount: 2 }, { seed: 9, us: "red" });
  const rec = await decide(g);
  const click = clickFor(g, rec);
  assert.ok(click);
  assert.equal(click.kind, "board");
  assert.equal(Number.isFinite(click.x), true);
  assert.equal(Number.isFinite(click.y), true);
  const house = legalActions(g).find((a) => a.id === rec.action.id);
  assert.ok(house?.vertex);
  assert.equal(click.vertex, house.vertex);
});

test("island mapping stays on the hex island and out of the log strip", async () => {
  const g = newGame({ playerCount: 4 }, { seed: 9, us: "red" });
  const rec = await decide(g);
  const click = clickFor(g, rec);
  assert.ok(click?.x != null && click.y != null);
  const canvas = { left: 100, top: 40, width: 1174, height: 861 };
  const island = islandBox(canvas);
  const log = {
    left: canvas.left + canvas.width * 0.66,
    top: canvas.top,
    width: canvas.width * 0.34,
    height: canvas.height,
  };
  const hexes = Object.values(g.board.hexes);
  const pt = mapIslandClick(hexes, click.x!, click.y!, canvas);
  assert.ok(pt);
  assert.equal(inBox(pt.x, pt.y, island), true);
  assert.equal(inBox(pt.x, pt.y, log), false);
  const east = mapIslandClick(hexes, Math.max(...hexes.map((h) => h.q)) + 1, 0, canvas);
  assert.ok(east);
  assert.equal(inBox(east.x, east.y, island), true);
  assert.equal(inBox(east.x, east.y, log), false);
  const south = mapIslandClick(hexes, 0, 2, canvas);
  const north = mapIslandClick(hexes, 0, -2, canvas);
  assert.ok(south && north);
  assert.equal(south.y > north.y, true);
  assert.equal(south.y > island.top + island.height * 0.55, true);
});

test("initial placement confirmation is above the selected board point", () => {
  const canvas = { left: 165, top: 0, width: 1110, height: 813 };
  const point = { x: 406, y: 354 };
  const settlement = mapInitialPlacementConfirmation(point, canvas, "settlement");
  const road = mapInitialPlacementConfirmation(point, canvas, "road");
  assert.equal(settlement.x, point.x);
  assert.equal(road.x, point.x);
  assert.equal(Math.round(point.y - settlement.y), 47);
  assert.equal(Math.round(point.y - road.y), 51);
});

test("vertex click cluster keeps the rec point and rings around it", async () => {
  const g = newGame({ playerCount: 2 }, { seed: 9, us: "red" });
  const rec = await decide(g);
  const click = clickFor(g, rec);
  assert.ok(click?.x != null && click.y != null);
  const canvas = { left: 100, top: 40, width: 1174, height: 861 };
  const hexes = Object.values(g.board.hexes);
  const pt = mapIslandClick(hexes, click.x!, click.y!, canvas);
  assert.ok(pt);
  const cluster = vertexClickCluster(pt.x, pt.y);
  assert.equal(cluster[0].x, pt.x);
  assert.equal(cluster[0].y, pt.y);
  assert.equal(cluster.length > 6, true);
  const island = islandBox(canvas);
  const near = cluster.filter((p) => inBox(p.x, p.y, island));
  assert.equal(near.length > 6, true);
});

test("Place Settlement UI click picks the small action-bar label", () => {
  const hit = pickUiHit(
    [
      { t: "Place Settlement03:331554", x: 579, y: 981, w: 823, h: 468 },
      { t: "Place Settlement", x: 780, y: 1090, w: 251, h: 81 },
      { t: "Place Settlement", x: 803, y: 1110, w: 197, h: 24 },
    ],
    /^Place Settlement/,
  );
  assert.ok(hit);
  assert.equal(hit.x, 803);
  assert.equal(hit.y, 1110);
});

test("roll and end-turn recs are UI clicks", () => {
  const g = newGame({ playerCount: 2 }, { seed: 3, us: "red" });
  g.phase = "roll";
  g.current = g.us;
  const roll: Recommendation = {
    action: { id: "ROLL", type: "ROLL", player: g.us, label: "Roll dice" },
    target: "dice",
    reason: "roll",
    plan: "roll",
    opponentThreat: "",
    confidence: 1,
    operation: "ROLL",
    operationProbabilities: {},
    targetProbabilities: {},
    latencyMs: 0,
    source: "mock",
  };
  const rollClick = clickFor(g, roll);
  assert.equal(rollClick?.kind, "ui");
  assert.equal(rollClick?.ui, "roll");

  g.phase = "turn";
  const end: Recommendation = {
    ...roll,
    action: { id: "END_TURN", type: "END_TURN", player: g.us, label: "End turn" },
    operation: "END_TURN",
  };
  const endClick = clickFor(g, end);
  assert.equal(endClick?.kind, "ui");
  assert.equal(endClick?.ui, "end_turn");
});

test("ranked URLs and vsBots false produce no auto-click", async () => {
  const g = newGame({ playerCount: 2 }, { seed: 9, us: "red" });
  const rec = await decide(g);
  assert.ok(clickFor(g, rec));
  assert.equal(autoClickAllowed({ on: true, vsBots: true }, "https://colonist.io/#game1"), true);
  assert.equal(autoClickAllowed({ on: false, vsBots: true }, "https://colonist.io/#game1"), false);
  assert.equal(autoClickAllowed({ on: true, vsBots: false }, "https://colonist.io/#game1"), false);
  assert.equal(autoClickAllowed({ on: true, vsBots: true }, "https://colonist.io/ranked"), false);
  assert.equal(autoClickAllowed({ on: true, vsBots: true }, "https://colonist.io/#ranked123"), false);
  const wait: Recommendation = {
    action: { id: "WAIT_BOARD", type: "END_TURN", player: g.us, label: "Waiting for the live Colonist board" },
    target: "board",
    reason: "wait",
    plan: "",
    opponentThreat: "",
    confidence: 0,
    operation: "END_TURN",
    operationProbabilities: {},
    targetProbabilities: {},
    latencyMs: 0,
    source: "mock",
  };
  assert.equal(clickFor(g, wait), null);
  g.current = g.players[1].id;
  const opp = await decide(g);
  opp.action.player = g.players[1].id;
  assert.equal(clickFor(g, opp), null);
});

test("road rec click targets the edge not the house vertex", async () => {
  const g = newGame({ playerCount: 2 }, { seed: 9, us: "red" });
  const rec = await decide(g);
  const house = clickFor(g, rec);
  assert.ok(house?.vertex);
  occupyUs(g, { vertex: house.vertex });
  g.phase = "setup_road";
  g.current = g.us;
  g.needsBoardSync = false;
  const rec2 = await decide(g);
  assert.equal(rec2.action.type, "PLACE_ROAD");
  const click = clickFor(g, rec2);
  assert.ok(click?.edge);
  assert.equal(click.kind, "board");
  assert.equal(click.vertex, undefined);
  assert.equal(occupyUs(g, { edge: click.edge }), true);
  assert.equal(g.players[0].roads.includes(click.edge), true);
});

test("played house click occupies that rec vertex", async () => {
  const g = newGame({ playerCount: 2 }, { seed: 9, us: "red" });
  const rec = await decide(g);
  const house = clickFor(g, rec);
  assert.ok(house?.vertex);
  assert.equal(occupyUs(g, { vertex: house.vertex }), true);
  assert.equal(g.players[0].settlements.includes(house.vertex), true);
});

test("occupyUs does not mint extra setup houses from missed clicks", async () => {
  const g = newGame({ playerCount: 4 }, { seed: 9, us: "red" });
  const verts = Object.keys(g.board.vertices);
  assert.equal(occupyUs(g, { vertex: verts[0] }), true);
  assert.equal(occupyUs(g, { vertex: verts[1] }), true);
  assert.equal(occupyUs(g, { vertex: verts[2] }), false);
  assert.equal(g.players[0].settlements.length, 2);
  assert.equal(g.players[0].settlements.includes(verts[2]), false);
});

test("prompt scrape is diagnostic and cannot rewrite observed pieces or turn", async () => {
  const { applySeats, resetGame, snapshot } = await import("../src/server.ts");
  resetGame(4, ["Izak", "Waly", "Beare", "Russon"], "Izak");
  applySeats({
    href: "https://colonist.io/#promptgame",
    players: ["Izak", "Waly", "Beare", "Russon"],
    you: "Izak",
  });
  const verts = Object.keys(snapshot().game.board.vertices);
  occupyUs(snapshot().game, { vertex: verts[0] });
  occupyUs(snapshot().game, { edge: Object.keys(snapshot().game.board.edges)[0] });
  applySeats({
    href: "https://colonist.io/#promptgame",
    players: ["Izak", "Waly", "Beare", "Russon"],
    you: "Izak",
  });
  const before = snapshot();
  const beforePieces = structuredClone(before.game.players[0]);
  const beforePhase = before.game.phase;
  const beforeCurrent = before.game.current;
  applySeats({
    href: "https://colonist.io/#promptgame",
    players: ["Izak", "Waly", "Beare", "Russon"],
    you: "Izak",
    prompt: "settlement",
  });
  const after = snapshot();
  assert.equal(after.youPrompt, "settlement");
  assert.equal(after.game.phase, beforePhase);
  assert.equal(after.game.current, beforeCurrent);
  assert.deepEqual(after.game.players[0], beforePieces);
});

test("played action is pending until the observed projection contains its target", async () => {
  const { noteActionIntent, resetGame, snapshot } = await import("../src/server.ts");
  resetGame(4, ["Izak", "Waly", "Beare", "Russon"], "Izak");
  const stateBefore = structuredClone(snapshot().game);
  const vertex = Object.keys(stateBefore.board.vertices)[0];
  const pending = noteActionIntent({ actionId: `PLACE_SETTLEMENT:red:${vertex}`, vertex });
  assert.equal(pending?.vertex, vertex);
  assert.deepEqual(snapshot().game.players[0].settlements, stateBefore.players[0].settlements);
  assert.equal(snapshot().play.pending?.actionId, pending?.actionId);

  const us = snapshot().game.players.find((p) => p.id === snapshot().game.us)!;
  us.settlements.push(vertex);
  assert.equal(snapshot().play.pending, null);
});

test("hashed Colonist username is us even when listed second", async () => {
  const { applySeats, resetGame, snapshot } = await import("../src/server.ts");
  resetGame(4, ["Stets", "Izak#5548", "Keene", "Ljoka"]);
  applySeats({
    href: "https://colonist.io/#ussecond",
    players: ["Stets", "Izak#5548", "Keene", "Ljoka"],
  });
  const snap = snapshot();
  assert.equal(snap.game.players.find((p) => p.id === snap.game.us)?.name, "Izak#5548");
});

test("a short seat scrape does not shrink a 4p bot game to 2p", async () => {
  const { applySeats, resetGame, snapshot } = await import("../src/server.ts");
  resetGame(4, ["Izak", "Malan", "Moskow", "Lyns"], "Izak");
  applySeats({
    href: "https://colonist.io/#fourseat",
    players: ["Izak", "Malan", "Moskow", "Lyns"],
    you: "Izak",
  });
  assert.equal(snapshot().game.players.length, 4);
  assert.equal(snapshot().game.config.victoryPoints, 10);
  applySeats({
    href: "https://colonist.io/#fourseat",
    players: ["Izak", "Malan"],
    you: "Izak",
  });
  const after = snapshot();
  assert.equal(after.game.players.length, 4);
  assert.equal(after.game.config.victoryPoints, 10);
  assert.equal(after.game.players[0].name, "Izak");
});

test("new Colonist game hash starts with empty pieces", async () => {
  const { applySeats, resetGame, snapshot } = await import("../src/server.ts");
  const { occupyUs } = await import("../src/play/target.ts");
  resetGame(4, ["Izak", "Waly", "Beare", "Russon"], "Izak");
  applySeats({
    href: "https://colonist.io/#gameold",
    players: ["Izak", "Waly", "Beare", "Russon"],
    you: "Izak",
  });
  const before = snapshot();
  const vid = Object.keys(before.game.board.vertices)[0];
  occupyUs(before.game, { vertex: vid });
  assert.equal(snapshot().game.players[0].settlements.length, 1);
  applySeats({
    href: "https://colonist.io/#gamenew",
    players: ["Izak", "Waly", "Beare", "Russon"],
    you: "Izak",
  });
  const after = snapshot();
  assert.equal(after.game.players[0].settlements.length, 0);
  assert.equal(after.game.players[1].settlements.length, 0);
});
