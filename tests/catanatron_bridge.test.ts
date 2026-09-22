import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStandardBoard } from "../src/engine/map.ts";
import { legalActions } from "../src/engine/game.ts";
import { mapCatanatronAction, stateFromCatanatron, type CatanatronRequest } from "../src/eval/catanatron_bridge.ts";

function request(overrides: Partial<CatanatronRequest> = {}): CatanatronRequest {
  const board = buildStandardBoard(3);
  return {
    us: "red",
    current: "red",
    phase: "setup_settle",
    robberHex: Object.keys(board.hexes).find((id) => board.hexes[id].terrain === "desert")!,
    board: {
      hexes: Object.values(board.hexes).map(({ id, q, r, terrain, number, vertices }) => ({ id, q, r, terrain, number, vertices })),
      vertices: Object.values(board.vertices).map(({ id, hexes, edges, port }) => ({ id, hexes, edges, port })),
      edges: Object.values(board.edges).map(({ id, vertices }) => ({ id, vertices })),
    },
    players: [
      { id: "red", hand: {}, settlements: [], cities: [], roads: [] },
      { id: "blue", hand: {}, settlements: [], cities: [], roads: [] },
    ],
    actions: [],
    config: { playerCount: 2, victoryPoints: 15, discardLimit: 9, friendlyRobber: true },
    ...overrides,
  };
}

test("Catanatron setup actions map to the same engine-legal target", () => {
  const input = request();
  const vertex = input.board.vertices[0].id;
  input.actions = [{ type: "BUILD_SETTLEMENT", vertex }];
  const state = stateFromCatanatron(input);
  const mapped = mapCatanatronAction(state, input.actions[0]);
  assert.equal(mapped?.type, "PLACE_SETTLEMENT");
  assert.equal(mapped?.vertex, vertex);
  assert.ok(legalActions(state).some((action) => action.id === mapped?.id));
});

test("Catanatron pre-roll development cards are present in the bridge state", () => {
  const input = request({
    phase: "roll",
    players: [
      {
        id: "red",
        hand: {},
        devs: { road_building: 1, monopoly: 1, year_of_plenty: 1 },
        settlements: [],
        cities: [],
        roads: [],
      },
      { id: "blue", hand: {}, settlements: [], cities: [], roads: [] },
    ],
  });
  input.actions = [
    { type: "PLAY_ROAD_BUILDING" },
    { type: "PLAY_MONOPOLY", resource: "wheat" },
    { type: "PLAY_YEAR_OF_PLENTY", resources: ["wheat", "ore"] },
    { type: "ROLL" },
  ];
  const state = stateFromCatanatron(input);
  const legal = legalActions(state);
  assert.ok(legal.some((action) => action.type === "PLAY_ROAD_BUILDING"));
  assert.ok(legal.some((action) => action.type === "PLAY_MONOPOLY" && action.resource === "wheat"));
  assert.ok(legal.some((action) => action.type === "PLAY_YEAR_OF_PLENTY"));
  assert.equal(mapCatanatronAction(state, input.actions[0])?.type, "PLAY_ROAD_BUILDING");
});
