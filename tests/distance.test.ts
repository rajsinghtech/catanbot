import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAction, legalActions, newGame, player, roadSpots } from "../src/engine/game.ts";
import { applyLogEvent, applyOccupancyFromPayload } from "../src/colonist/apply.ts";
import { parseLogLine } from "../src/colonist/log.ts";
import { decide } from "../src/policy/jev.ts";
import { forcedWin, heuristicScore } from "../src/policy/doctrine.ts";
import { edgeFromColonistEdge, vkey } from "../src/engine/colonist_board.ts";
import type { Action, GameState } from "../src/types.ts";

function neighborIds(state: GameState, vid: string): string[] {
  const v = state.board.vertices[vid];
  return v.edges.map((eid) => {
    const e = state.board.edges[eid];
    return e.vertices[0] === vid ? e.vertices[1] : e.vertices[0];
  });
}

function settlementIds(acts: Action[]): string[] {
  return acts.filter((a) => a.type === "PLACE_SETTLEMENT" || a.type === "BUILD_SETTLEMENT").map((a) => a.vertex!);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeak(state: GameState): Action {
  const acts = legalActions(state);
  assert.ok(acts.length, `no legal for ${state.current} ${state.phase}`);
  return acts
    .map((a) => ({ a, s: heuristicScore(state, a) }))
    .sort((x, y) => x.s - y.s || x.a.id.localeCompare(y.a.id))[0].a;
}

async function pickUs(state: GameState): Promise<Action> {
  const acts = legalActions(state);
  const rec = await decide(state);
  const hit =
    acts.find((a) => a.id === rec.action.id) ??
    acts.find((a) => a.type === rec.action.type && a.vertex === rec.action.vertex && a.edge === rec.action.edge);
  assert.ok(hit, `decide returned illegal ${rec.action.id} among ${acts.map((a) => a.id).join(",")}`);
  const forced = forcedWin(state);
  return forced && acts.some((a) => a.id === forced.id) ? acts.find((a) => a.id === forced.id)! : hit;
}

test("after an opponent sits on V, our legal houses skip V and every one-edge neighbor", () => {
  const g = newGame({ playerCount: 2 }, { seed: 1, names: ["Us", "Opp"], us: "red" });
  applyAction(g, legalActions(g).find((a) => a.type === "PLACE_SETTLEMENT")!);
  applyAction(g, legalActions(g).find((a) => a.type === "PLACE_ROAD")!);
  g.current = "blue";
  g.phase = "setup_settle";
  const oppHouse = legalActions(g).find((a) => a.type === "PLACE_SETTLEMENT")!;
  const V = oppHouse.vertex!;
  applyAction(g, oppHouse);
  applyAction(g, legalActions(g).find((a) => a.type === "PLACE_ROAD")!);
  g.current = "red";
  g.phase = "setup_settle";
  g.setupForward = false;
  const ours = settlementIds(legalActions(g));
  assert.equal(ours.includes(V), false);
  for (const n of neighborIds(g, V)) assert.equal(ours.includes(n), false);
});

test("a Colonist settlement log without a board vertex stays unplaced", () => {
  const g = newGame({ playerCount: 2 }, { seed: 2, names: ["Us", "Opp"], us: "red" });
  const opp = player(g, "blue");
  const before = opp.settlements.slice();
  applyLogEvent(g, parseLogLine("Opp built a Settlement"));
  assert.equal(opp.unplaced.settlements, 1);
  assert.deepEqual(
    opp.settlements.filter((vid) => g.board.vertices[vid]),
    before.filter((vid) => g.board.vertices[vid]),
  );
});

test("a settlement log with a real vertex occupies it and decide never names it or its neighbors", async () => {
  const g = newGame({ playerCount: 2 }, { seed: 3, names: ["Us", "Opp"], us: "red" });
  applyAction(g, legalActions(g).find((a) => a.type === "PLACE_SETTLEMENT")!);
  applyAction(g, legalActions(g).find((a) => a.type === "PLACE_ROAD")!);
  const V = Object.keys(g.board.vertices).find((vid) => {
    const acts = legalActions({ ...g, current: "blue", phase: "setup_settle" });
    return settlementIds(acts).includes(vid);
  })!;
  g.current = "blue";
  g.phase = "setup_settle";
  const ev = parseLogLine("Opp built a Settlement");
  ev.vertex = V;
  ev.build = "settlement";
  applyLogEvent(g, ev);
  assert.ok(player(g, "blue").settlements.includes(V));
  g.current = "red";
  g.phase = "setup_settle";
  g.setupForward = false;
  const legal = legalActions(g);
  const banned = new Set([V, ...neighborIds(g, V)]);
  for (const a of legal) {
    if (a.vertex) assert.equal(banned.has(a.vertex), false);
  }
  const rec = await decide(g);
  const match = legal.find((a) => a.id === rec.action.id);
  assert.ok(match);
  if (match.vertex) assert.equal(banned.has(match.vertex), false);
});

test("Colonist corner {x:0,y:0,z:0} occupies north vkey(0,0,2) and bans neighbors", async () => {
  const g = newGame({ playerCount: 2 }, { seed: 4, names: ["Us", "Opp"], us: "red" });
  const north = vkey(0, 0, 2);
  const south = vkey(0, 0, 5);
  assert.ok(g.board.vertices[north]);
  const ev = parseLogLine("Opp built a Settlement");
  ev.build = "settlement";
  applyLogEvent(g, ev, { vertex: { x: 0, y: 0, z: 0 } });
  assert.ok(player(g, "blue").settlements.includes(north));
  assert.equal(player(g, "blue").settlements.includes(south), false);
  applyOccupancyFromPayload(g, {
    building: "settlement",
    playerName: "Opp",
    x: 0,
    y: 0,
    z: 0,
  });
  assert.ok(player(g, "blue").settlements.includes(north));
  g.current = "red";
  g.phase = "setup_settle";
  g.setupForward = false;
  const legal = legalActions(g);
  const banned = new Set([north, ...neighborIds(g, north)]);
  for (const a of legal) {
    if (a.vertex) assert.equal(banned.has(a.vertex), false);
  }
  const rec = await decide(g);
  const match = legal.find((a) => a.id === rec.action.id);
  assert.ok(match);
  if (match.vertex) assert.equal(banned.has(match.vertex), false);
});

test("Colonist edge {x,y,z} occupies that hex side and is not a legal road", () => {
  const g = newGame({ playerCount: 2 }, { seed: 4, names: ["Us", "Opp"], us: "red" });
  const eid = edgeFromColonistEdge(g.board, { x: 0, y: 0, z: 1 });
  assert.ok(eid);
  assert.ok(g.board.edges[eid]);
  const ev = parseLogLine("Opp built a Road");
  ev.build = "road";
  applyLogEvent(g, ev, { edge: { x: 0, y: 0, z: 1 } });
  assert.ok(player(g, "blue").roads.includes(eid));
  assert.equal(roadSpots(g, player(g, "red")).includes(eid), false);
  g.current = "red";
  g.phase = "setup_road";
  for (const a of legalActions(g)) {
    assert.notEqual(a.edge, eid);
  }
  applyOccupancyFromPayload(g, {
    piece: "road",
    playerName: "Opp",
    x: 0,
    y: 0,
    z: 0,
  });
  const nw = edgeFromColonistEdge(g.board, { x: 0, y: 0, z: 0 });
  assert.ok(nw);
  assert.ok(player(g, "blue").roads.includes(nw));
  assert.equal(roadSpots(g, player(g, "red")).includes(nw), false);
});

test("heuristic us wins a majority of fixed-seed 2p games vs lowest-heuristic opponent", async () => {
  const seeds = [2, 3, 5, 7, 11, 13, 17];
  let wins = 0;
  const rows: string[] = [];
  for (const seed of seeds) {
    const rng = mulberry32(seed * 17);
    const g = newGame({ playerCount: 2, victoryPoints: 10, friendlyRobber: false, discardLimit: 7 }, {
      seed,
      names: ["Us", "Opp"],
      us: "red",
    });
    let illegal = 0;
    for (let ply = 0; ply < 280 && g.phase !== "ended"; ply++) {
      const acts = legalActions(g);
      if (!acts.length) break;
      const chosen = g.current === g.us ? await pickUs(g) : pickWeak(g);
      if (!acts.some((a) => a.id === chosen.id)) illegal += 1;
      applyAction(g, chosen, rng);
    }
    assert.equal(illegal, 0, `illegal apply seed ${seed}`);
    const usVp = g.players[0].settlements.length + g.players[0].cities.length * 2 + (g.longestRoad === "red" ? 2 : 0) + (g.largestArmy === "red" ? 2 : 0) + g.players[0].devs.vp;
    const oppVp = g.players[1].settlements.length + g.players[1].cities.length * 2 + (g.longestRoad === "blue" ? 2 : 0) + (g.largestArmy === "blue" ? 2 : 0) + g.players[1].devs.vp;
    const usWin = g.winner === "red" || usVp > oppVp;
    if (usWin) wins += 1;
    rows.push(`seed=${seed} winner=${g.winner} usVP=${usVp} oppVP=${oppVp} win=${usWin}`);
  }
  console.log(rows.join("\n"));
  assert.ok(wins > seeds.length / 2, `us wins ${wins}/${seeds.length}: ${rows.join("; ")}`);
});
