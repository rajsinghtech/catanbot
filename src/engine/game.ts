import {
  COSTS,
  EMPTY_DEVS,
  EMPTY_HAND,
  PLAYER_COLORS,
  RESOURCES,
  type Action,
  type Board,
  type DevHand,
  type DevKind,
  type GameConfig,
  type GameState,
  type Hand,
  type Player,
  type Resource,
} from "../types.ts";
import { buildStandardBoard, otherVertex, resourceOf } from "./map.ts";

const DEV_DECK: DevKind[] = [
  ...Array(14).fill("knight"),
  ...Array(5).fill("vp"),
  ...Array(2).fill("monopoly"),
  ...Array(2).fill("year_of_plenty"),
  ...Array(2).fill("road_building"),
] as DevKind[];

function cloneHand(h: Hand): Hand {
  return { wood: h.wood, brick: h.brick, sheep: h.sheep, wheat: h.wheat, ore: h.ore };
}

function handCount(h: Hand): number {
  return h.wood + h.brick + h.sheep + h.wheat + h.ore;
}

function hasCost(h: Hand, cost: Hand): boolean {
  return RESOURCES.every((r) => h[r] >= cost[r]);
}

function pay(h: Hand, cost: Hand): void {
  for (const r of RESOURCES) h[r] -= cost[r];
}

function add(h: Hand, r: Resource, n: number): void {
  h[r] += n;
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

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const DEFAULT_1V1: GameConfig = {
  victoryPoints: 15,
  discardLimit: 9,
  friendlyRobber: true,
  playerCount: 2,
};

export const DEFAULT_4P: GameConfig = {
  victoryPoints: 10,
  discardLimit: 7,
  friendlyRobber: false,
  playerCount: 4,
};

function makePlayer(i: number, name?: string): Player {
  return {
    id: PLAYER_COLORS[i],
    name: name ?? PLAYER_COLORS[i],
    color: PLAYER_COLORS[i],
    hand: EMPTY_HAND(),
    hidden: { known: EMPTY_HAND(), unknown: 0 },
    devs: EMPTY_DEVS(),
    newDevs: EMPTY_DEVS(),
    knightsPlayed: 0,
    settlements: [],
    cities: [],
    roads: [],
    unplaced: { settlements: 0, cities: 0, roads: 0 },
    playedDevThisTurn: false,
  };
}

export function newGame(
  config: Partial<GameConfig> = {},
  opts: { seed?: number; names?: string[]; us?: string } = {},
): GameState {
  const playerCount = config.playerCount ?? 2;
  if (playerCount < 2 || playerCount > 6) throw new Error("playerCount must be 2-6");
  const cfg: GameConfig = {
    victoryPoints: config.victoryPoints ?? (playerCount === 2 ? 15 : 10),
    discardLimit: config.discardLimit ?? (playerCount === 2 ? 9 : 7),
    friendlyRobber: config.friendlyRobber ?? playerCount === 2,
    playerCount,
  };
  const rng = mulberry32(opts.seed ?? 1);
  const board = buildStandardBoard(opts.seed ?? 1);
  const desert = Object.values(board.hexes).find((h) => h.terrain === "desert")!;
  const players = Array.from({ length: playerCount }, (_, i) => makePlayer(i, opts.names?.[i]));
  return {
    config: cfg,
    board,
    players,
    us: opts.us ?? players[0].id,
    current: players[0].id,
    phase: "setup_settle",
    robberHex: desert.id,
    bank: { wood: 19, brick: 19, sheep: 19, wheat: 19, ore: 19 },
    deck: shuffle(DEV_DECK, rng),
    longestRoad: null,
    largestArmy: null,
    setupIndex: 0,
    setupForward: true,
    setupAnchor: {},
    dice: null,
    turn: 0,
    mustDiscard: {},
    stealFrom: [],
    pendingRoads: 0,
    pendingYop: 0,
    pendingOffer: null,
    needsBoardSync: false,
    roller: players[0].id,
    afterRobber: "turn",
    winner: null,
    log: [`game start ${playerCount}p to ${cfg.victoryPoints} VP`],
  };
}

export function player(state: GameState, id: string): Player {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new Error(`no player ${id}`);
  return p;
}

export function visibleVP(state: GameState, id: string): number {
  const p = player(state, id);
  let vp =
    p.settlements.length +
    p.unplaced.settlements +
    (p.cities.length + p.unplaced.cities) * 2;
  if (state.longestRoad === id) vp += 2;
  if (state.largestArmy === id) vp += 2;
  return vp;
}

export function totalVP(state: GameState, id: string): number {
  return visibleVP(state, id) + player(state, id).devs.vp;
}

export function robable(state: GameState, id: string): boolean {
  if (!state.config.friendlyRobber) return true;
  return visibleVP(state, id) >= 3;
}

function ownerOfVertex(state: GameState, vid: string): Player | undefined {
  return state.players.find((p) => p.settlements.includes(vid) || p.cities.includes(vid));
}

function ownerOfEdge(state: GameState, eid: string): Player | undefined {
  return state.players.find((p) => p.roads.includes(eid));
}

function distanceOk(state: GameState, vid: string): boolean {
  const v = state.board.vertices[vid];
  if (!v) return false;
  for (const eid of v.edges) {
    const other = otherVertex(state.board.edges[eid], vid);
    if (ownerOfVertex(state, other)) return false;
  }
  return !ownerOfVertex(state, vid);
}

function connectedRoad(state: GameState, p: Player, eid: string): boolean {
  const e = state.board.edges[eid];
  for (const vid of e.vertices) {
    if (p.settlements.includes(vid) || p.cities.includes(vid)) return true;
    const v = state.board.vertices[vid];
    if (ownerOfVertex(state, vid) && ownerOfVertex(state, vid)!.id !== p.id) continue;
    if (v.edges.some((x) => p.roads.includes(x))) return true;
  }
  return false;
}

function settlementSpots(state: GameState, p: Player, setup: boolean): string[] {
  return Object.keys(state.board.vertices).filter((vid) => {
    if (!distanceOk(state, vid)) return false;
    if (setup) return true;
    const v = state.board.vertices[vid];
    return v.edges.some((eid) => p.roads.includes(eid));
  });
}

function roadSpots(state: GameState, p: Player, setupVertex?: string): string[] {
  return Object.keys(state.board.edges).filter((eid) => {
    if (ownerOfEdge(state, eid)) return false;
    if (p.roads.length >= 15) return false;
    if (setupVertex) return state.board.edges[eid].vertices.includes(setupVertex);
    return connectedRoad(state, p, eid);
  });
}

function takeFromBank(state: GameState, r: Resource, n: number): number {
  const got = Math.min(n, state.bank[r]);
  state.bank[r] -= got;
  return got;
}

function giveToBank(state: GameState, r: Resource, n: number): void {
  state.bank[r] += n;
}

export function produce(state: GameState, total: number): void {
  if (total === 7) return;
  for (const hex of Object.values(state.board.hexes)) {
    if (hex.number !== total || hex.id === state.robberHex) continue;
    const res = resourceOf(hex);
    if (!res) continue;
    for (const vid of hex.vertices) {
      for (const p of state.players) {
        let qty = 0;
        if (p.settlements.includes(vid)) qty = 1;
        if (p.cities.includes(vid)) qty = 2;
        if (!qty) continue;
        const got = takeFromBank(state, res, qty);
        add(p.hand, res, got);
        add(p.hidden.known, res, got);
      }
    }
  }
}

export function roadLength(state: GameState, id: string): number {
  const p = player(state, id);
  if (p.roads.length === 0) return 0;
  const adj = new Map<string, string[]>();
  for (const eid of p.roads) {
    const edge = state.board.edges[eid];
    if (!edge) continue;
    const [a, b] = edge.vertices;
    const blockA = ownerOfVertex(state, a);
    const blockB = ownerOfVertex(state, b);
    if (!(blockA && blockA.id !== id)) {
      adj.set(a, [...(adj.get(a) ?? []), b]);
    }
    if (!(blockB && blockB.id !== id)) {
      adj.set(b, [...(adj.get(b) ?? []), a]);
    }
  }
  let best = 0;
  const nodes = [...adj.keys()];
  const dfs = (node: string, from: string | null, used: Set<string>): number => {
    let local = 0;
    for (const nxt of adj.get(node) ?? []) {
      if (nxt === from) continue;
      const k = node < nxt ? `${node}|${nxt}` : `${nxt}|${node}`;
      if (used.has(k)) continue;
      used.add(k);
      local = Math.max(local, 1 + dfs(nxt, node, used));
      used.delete(k);
    }
    return local;
  };
  for (const start of nodes) best = Math.max(best, dfs(start, null, new Set()));
  return best;
}

export function refreshAwards(state: GameState): void {
  let bestRoad = 0;
  let roadHolder: string | null = null;
  for (const p of state.players) {
    const len = roadLength(state, p.id);
    if (len >= 5 && len > bestRoad) {
      bestRoad = len;
      roadHolder = p.id;
    } else if (len === bestRoad && roadHolder && p.id !== roadHolder) {
      if (state.longestRoad === p.id) roadHolder = p.id;
    }
  }
  if (bestRoad < 5) roadHolder = null;
  if (state.longestRoad && roadHolder && roadLength(state, state.longestRoad) === bestRoad) {
    roadHolder = state.longestRoad;
  }
  state.longestRoad = roadHolder;

  let bestArmy = 0;
  let armyHolder: string | null = null;
  for (const p of state.players) {
    if (p.knightsPlayed >= 3 && p.knightsPlayed > bestArmy) {
      bestArmy = p.knightsPlayed;
      armyHolder = p.id;
    }
  }
  if (bestArmy < 3) armyHolder = null;
  if (state.largestArmy && armyHolder && player(state, state.largestArmy).knightsPlayed === bestArmy) {
    armyHolder = state.largestArmy;
  }
  state.largestArmy = armyHolder;
}

function checkWin(state: GameState): void {
  for (const p of state.players) {
    if (totalVP(state, p.id) >= state.config.victoryPoints) {
      state.winner = p.id;
      state.phase = "ended";
      state.log.push(`${p.name} wins with ${totalVP(state, p.id)}`);
    }
  }
}

function setupNext(state: GameState): void {
  const n = state.players.length;
  if (state.setupForward) {
    if (state.setupIndex === n - 1) {
      state.setupForward = false;
    } else {
      state.setupIndex += 1;
    }
  } else {
    if (state.setupIndex === 0) {
      state.phase = "roll";
      state.current = state.players[0].id;
      state.turn = 1;
      return;
    }
    state.setupIndex -= 1;
  }
  state.current = state.players[state.setupIndex].id;
  state.phase = "setup_settle";
}

function grantSetupResources(state: GameState, p: Player, vid: string): void {
  const v = state.board.vertices[vid];
  for (const hid of v.hexes) {
    const res = resourceOf(state.board.hexes[hid]);
    if (!res) continue;
    const got = takeFromBank(state, res, 1);
    add(p.hand, res, got);
    add(p.hidden.known, res, got);
  }
}

function aid(type: string, parts: Array<string | undefined>): string {
  return [type, ...parts.filter(Boolean)].join(":");
}

function labelVertex(state: GameState, vid: string): string {
  const v = state.board.vertices[vid];
  const bits = v.hexes.map((hid) => {
    const h = state.board.hexes[hid];
    return h.number ? `${h.number}-${h.terrain}` : h.terrain;
  });
  const port = v.port ? ` ${v.port.resource ?? "3:1"} port` : "";
  return bits.join(" / ") + port;
}

function houseCount(state: GameState, p: Player): number {
  return p.settlements.filter((id) => state.board.vertices[id]).length + p.unplaced.settlements;
}

function roadCount(state: GameState, p: Player): number {
  return p.roads.filter((id) => state.board.edges[id]).length + p.unplaced.roads;
}

export function syncSetupFromPieces(state: GameState): void {
  if (state.phase === "ended") return;
  if (state.phase === "discard" || state.phase === "robber" || state.phase === "steal") return;
  if (state.turn > 0 && (state.phase === "roll" || state.phase === "turn")) return;

  const needRoad = state.players.find((pl) => houseCount(state, pl) > roadCount(state, pl));
  if (needRoad) {
    state.current = needRoad.id;
    state.phase = "setup_road";
    return;
  }
  const done = (n: number) =>
    state.players.every((pl) => houseCount(state, pl) >= n && roadCount(state, pl) >= n);
  if (done(2)) {
    state.phase = "roll";
    state.current = state.players[0].id;
    state.turn = Math.max(1, state.turn);
    return;
  }
  const usP = state.players.find((pl) => pl.id === state.us);
  if (usP && houseCount(state, usP) === 1) {
    const othersDone = state.players.filter((pl) => pl.id !== state.us).every((pl) => houseCount(state, pl) >= 2);
    if (othersDone) {
      state.current = usP.id;
      state.phase = "setup_settle";
      state.setupForward = false;
      state.setupIndex = state.players.indexOf(usP);
      return;
    }
  }
  if (done(1)) {
    for (let i = state.players.length - 1; i >= 0; i--) {
      if (houseCount(state, state.players[i]) < 2) {
        state.current = state.players[i].id;
        state.phase = "setup_settle";
        state.setupForward = false;
        state.setupIndex = i;
        return;
      }
    }
  }
  for (let i = 0; i < state.players.length; i++) {
    if (houseCount(state, state.players[i]) < 1) {
      state.current = state.players[i].id;
      state.phase = "setup_settle";
      state.setupForward = true;
      state.setupIndex = i;
      return;
    }
  }
}

export function legalActions(state: GameState): Action[] {
  if (state.phase === "ended" || state.winner) return [];
  const p = player(state, state.current);
  const acts: Action[] = [];

  if (state.pendingOffer && state.pendingOffer.from !== state.us) {
    const o = state.pendingOffer;
    const from = player(state, o.from);
    const usP = player(state, state.us);
    if (usP.hand[o.get] >= o.getCount) {
      acts.push({
        id: "ACCEPT_TRADE",
        type: "ACCEPT_TRADE",
        player: state.us,
        give: o.get,
        giveCount: o.getCount,
        get: o.give,
        tradeId: o.id,
        label: `ACCEPT ${from.name}'s ${o.giveCount} ${o.give} for your ${o.getCount} ${o.get}`,
      });
    }
    acts.push({
      id: "REJECT_TRADE",
      type: "REJECT_TRADE",
      player: state.us,
      tradeId: o.id,
      label: `DECLINE ${from.name}'s ${o.giveCount} ${o.give} for ${o.getCount} ${o.get}`,
    });
    return acts;
  }

  // Colonist expansion/special menus are observed by the live adapter even
  // though the base-Catan engine does not model their extra pieces. Stop
  // safely instead of inventing a normal turn action while that menu is open.
  if (state.phase === "special") return acts;

  if (state.needsBoardSync && state.phase !== "setup_settle") {
    const hasHouse = p.settlements.some((id) => state.board.vertices[id]);
    if (!(state.phase === "setup_road" && hasHouse)) return acts;
  }

  if (state.phase === "setup_settle") {
    const cap = state.setupForward ? 1 : 2;
    if (houseCount(state, p) >= cap) return acts;
    for (const vid of settlementSpots(state, p, true)) {
      acts.push({
        id: aid("PLACE_SETTLEMENT", [p.id, vid]),
        type: "PLACE_SETTLEMENT",
        player: p.id,
        vertex: vid,
        label: `Place settlement on ${labelVertex(state, vid)}`,
      });
    }
    return acts;
  }

  if (state.phase === "setup_road") {
    if (p.settlements.length === 0) {
      if (p.unplaced.settlements > 0) return acts;
      for (const vid of settlementSpots(state, p, true)) {
        acts.push({
          id: aid("PLACE_SETTLEMENT", [p.id, vid]),
          type: "PLACE_SETTLEMENT",
          player: p.id,
          vertex: vid,
          label: `Place settlement on ${labelVertex(state, vid)}`,
        });
      }
      return acts;
    }
    // Live Colonist snapshots enumerate map locations in board order, not
    // placement order, and the occupancy/action-state frames can arrive out
    // of order. During setup the correct anchor is the settlement that does
    // not already have one of this player's roads incident to it. This is a
    // stronger invariant than chronology: the first setup house has its road
    // by the time the second setup house needs one. Keep setupAnchor as a
    // fallback for the tiny transition window before the first road appears.
    const unconnected = p.settlements.filter((vid) => {
      const vertex = state.board.vertices[vid];
      return vertex && !vertex.edges.some((eid) => p.roads.includes(eid));
    });
    const last = unconnected.length === 1
      ? unconnected[0]
      : state.setupAnchor[p.id] ?? p.settlements[p.settlements.length - 1];
    if (!last) return acts;
    for (const eid of roadSpots(state, p, last)) {
      const edge = state.board.edges[eid];
      if (!edge) continue;
      const a = new Set(state.board.vertices[edge.vertices[0]]?.hexes ?? []);
      const shared = (state.board.vertices[edge.vertices[1]]?.hexes ?? []).filter((h) => a.has(h));
      const along = (shared.length ? shared : [...a])
        .map((hid) => {
          const h = state.board.hexes[hid];
          return h.number ? `${h.number} ${h.terrain}` : h.terrain;
        })
        .join(" / ");
      acts.push({
        id: aid("PLACE_ROAD", [p.id, eid]),
        type: "PLACE_ROAD",
        player: p.id,
        edge: eid,
        vertex: last,
        label: `Road off your new house along ${along || "that hex"}`,
      });
    }
    return acts;
  }

  const discardNeed = state.mustDiscard[state.us] ?? state.mustDiscard[p.id] ?? 0;
  if (state.phase === "discard" || discardNeed > 0) {
    const who =
      (state.mustDiscard[state.us] ?? 0) > 0 ? player(state, state.us) : (state.mustDiscard[p.id] ?? 0) > 0 ? p : p;
    const need = state.mustDiscard[who.id] ?? 0;
    if (need > 0) collectDiscards(who, need, acts);
    else {
      acts.push({
        id: "DISCARD_ADVICE",
        type: "DISCARD",
        player: who.id,
        discard: {},
        label: "Discard half (keep wheat and ore; dump sheep, wood, brick first)",
      });
    }
    return acts;
  }

  if (state.phase === "robber") {
    for (const hex of Object.values(state.board.hexes)) {
      if (hex.id === state.robberHex) continue;
      const victims = stealCandidates(state, hex.id, p.id);
      if (victims.length === 0) {
        acts.push({
          id: aid("MOVE_ROBBER", [hex.id, "-"]),
          type: "MOVE_ROBBER",
          player: p.id,
          hex: hex.id,
          label: `Robber on ${hex.number ?? "-"} ${hex.terrain}`,
        });
      } else {
        for (const v of victims) {
          acts.push({
            id: aid("MOVE_ROBBER", [hex.id, v]),
            type: "MOVE_ROBBER",
            player: p.id,
            hex: hex.id,
            stealFrom: v,
            label: `Block ${hex.number ?? "-"} ${hex.terrain}, steal ${player(state, v).name}`,
          });
        }
      }
    }
    return acts;
  }

  if (state.phase === "steal") {
    for (const v of state.stealFrom) {
      acts.push({
        id: aid("STEAL", [v]),
        type: "STEAL",
        player: p.id,
        stealFrom: v,
        label: `Steal from ${player(state, v).name}`,
      });
    }
    return acts;
  }

  if (state.phase === "road_building") {
    for (const eid of roadSpots(state, p)) {
      acts.push({
        id: aid("BUILD_ROAD", [eid]),
        type: "BUILD_ROAD",
        player: p.id,
        edge: eid,
        label: `Free road ${eid}`,
      });
    }
    if (acts.length === 0) {
      acts.push({
        id: "END_ROAD_BUILDING",
        type: "END_TURN",
        player: p.id,
        label: "No legal free road",
      });
    }
    return acts;
  }

  if (state.phase === "year_of_plenty") {
    const count = Math.min(2, Math.max(1, state.pendingYop));
    if (count === 1) {
      for (const r of RESOURCES) {
        if (state.bank[r] <= 0) continue;
        acts.push({
          id: aid("YOP", [r]),
          type: "PLAY_YEAR_OF_PLENTY",
          player: p.id,
          resource: r,
          resources: [r],
          label: `Year of Plenty ${r}`,
        });
      }
    } else {
      for (let i = 0; i < RESOURCES.length; i++) {
        const a = RESOURCES[i];
        if (state.bank[a] <= 0) continue;
        for (let j = i; j < RESOURCES.length; j++) {
          const b = RESOURCES[j];
          if (state.bank[b] - (b === a ? 1 : 0) <= 0) continue;
          acts.push({
            id: aid("YOP", [a, b]),
            type: "PLAY_YEAR_OF_PLENTY",
            player: p.id,
            resource: a,
            resources: [a, b],
            label: `Year of Plenty ${a} + ${b}`,
          });
        }
      }
    }
    return acts;
  }

  if (state.phase === "monopoly") {
    for (const r of RESOURCES) {
      acts.push({
        id: aid("MONOPOLY", [r]),
        type: "PLAY_MONOPOLY",
        player: p.id,
        resource: r,
        label: `Monopoly ${r}`,
      });
    }
    return acts;
  }

  if (state.phase === "roll") {
    if (!p.playedDevThisTurn && p.devs.knight > 0) {
      acts.push({
        id: "PLAY_KNIGHT",
        type: "PLAY_KNIGHT",
        player: p.id,
        label: "Play knight",
      });
    }
    // Catan permits all playable development cards (except a card bought
    // during the current turn) before the dice are rolled.  Keeping these in
    // the roll phase is important for the simulator adapter and for live
    // Colonist states where the card menu is available before ROLL.
    if (!p.playedDevThisTurn && p.devs.monopoly > 0) {
      for (const r of RESOURCES) {
        acts.push({
          id: aid("MONOPOLY", [r]),
          type: "PLAY_MONOPOLY",
          player: p.id,
          resource: r,
          label: `Monopoly ${r}`,
        });
      }
    }
    if (!p.playedDevThisTurn && p.devs.road_building > 0) {
      acts.push({
        id: "PLAY_ROAD_BUILDING",
        type: "PLAY_ROAD_BUILDING",
        player: p.id,
        label: "Play road building",
      });
    }
    if (!p.playedDevThisTurn && p.devs.year_of_plenty > 0) {
      acts.push({
        id: "PLAY_YOP",
        type: "PLAY_YEAR_OF_PLENTY",
        player: p.id,
        label: "Play year of plenty",
      });
    }
    acts.push({ id: "ROLL", type: "ROLL", player: p.id, label: "Roll dice" });
    return acts;
  }

  if (state.phase === "turn") {
    if (!p.playedDevThisTurn) {
      if (p.devs.knight > 0) {
        acts.push({ id: "PLAY_KNIGHT", type: "PLAY_KNIGHT", player: p.id, label: "Play knight" });
      }
      if (p.devs.monopoly > 0) {
        for (const r of RESOURCES) {
          acts.push({
            id: aid("MONOPOLY", [r]),
            type: "PLAY_MONOPOLY",
            player: p.id,
            resource: r,
            label: `Monopoly ${r}`,
          });
        }
      }
      if (p.devs.road_building > 0) {
        acts.push({
          id: "PLAY_ROAD_BUILDING",
          type: "PLAY_ROAD_BUILDING",
          player: p.id,
          label: "Play road building",
        });
      }
      if (p.devs.year_of_plenty > 0) {
        acts.push({
          id: "PLAY_YOP",
          type: "PLAY_YEAR_OF_PLENTY",
          player: p.id,
          label: "Play year of plenty",
        });
      }
    }
    if (p.settlements.length + p.cities.length < 9 && p.settlements.length < 5 && hasCost(p.hand, COSTS.settlement)) {
      for (const vid of settlementSpots(state, p, false)) {
        acts.push({
          id: aid("BUILD_SETTLEMENT", [vid]),
          type: "BUILD_SETTLEMENT",
          player: p.id,
          vertex: vid,
          label: `Settle ${labelVertex(state, vid)}`,
        });
      }
    }
    if (p.cities.length < 4 && p.settlements.length > 0 && hasCost(p.hand, COSTS.city)) {
      for (const vid of p.settlements) {
        acts.push({
          id: aid("BUILD_CITY", [vid]),
          type: "BUILD_CITY",
          player: p.id,
          vertex: vid,
          label: `City ${labelVertex(state, vid)}`,
        });
      }
    }
    if (p.roads.length < 15 && hasCost(p.hand, COSTS.road)) {
      for (const eid of roadSpots(state, p)) {
        acts.push({
          id: aid("BUILD_ROAD", [eid]),
          type: "BUILD_ROAD",
          player: p.id,
          edge: eid,
          label: `Road ${eid}`,
        });
      }
    }
    if (state.deck.length > 0 && hasCost(p.hand, COSTS.dev)) {
      acts.push({ id: "BUY_DEV", type: "BUY_DEV", player: p.id, label: "Buy development card" });
    }
    for (const r of RESOURCES) {
      const rate = tradeRate(p, state.board, r);
      if (p.hand[r] >= rate) {
        for (const g of RESOURCES) {
          if (g === r || state.bank[g] <= 0) continue;
          acts.push({
            id: aid("TRADE", [r, String(rate), g]),
            type: "MARITIME_TRADE",
            player: p.id,
            give: r,
            giveCount: rate,
            get: g,
            label: `Trade ${rate} ${r} → ${g}`,
          });
        }
      }
    }
    acts.push({ id: "END_TURN", type: "END_TURN", player: p.id, label: "End turn" });
  }
  return acts;
}

function tradeRate(p: Player, board: Board, r: Resource): number {
  let rate = 4;
  for (const vid of [...p.settlements, ...p.cities]) {
    const port = board.vertices[vid]?.port;
    if (!port) continue;
    if (port.ratio === 3) rate = Math.min(rate, 3);
    if (port.resource === r) rate = Math.min(rate, 2);
  }
  return rate;
}

function stealCandidates(state: GameState, hexId: string, thief: string): string[] {
  const hex = state.board.hexes[hexId];
  const ids = new Set<string>();
  for (const vid of hex.vertices) {
    const o = ownerOfVertex(state, vid);
    if (o && o.id !== thief && robable(state, o.id) && handCount(o.hand) + o.hidden.unknown > 0) ids.add(o.id);
  }
  return [...ids];
}

function collectDiscards(p: Player, need: number, acts: Action[]): void {
  if (p.hidden.unknown > 0) {
    acts.push({
      id: aid("DISCARD_ADVICE", [p.id]),
      type: "DISCARD",
      player: p.id,
      discard: {},
      // Preserve the obligation even when the resource identities are not
      // observable. The live driver can select exactly this many cards from
      // Colonist's authoritative hand projection; an empty advice action
      // used to send zero cards and leave the robber menu half-complete.
      discardUnknown: need,
      label: `Discard ${need} cards; exact identities are hidden. Keep wheat and ore; dump sheep, wood, brick first`,
    });
    return;
  }
  const totalCards = handCount(p.hand);
  if (totalCards <= need) {
    const discard: Partial<Hand> = {};
    for (const r of RESOURCES) if (p.hand[r]) discard[r] = p.hand[r];
    acts.push({
      id: aid("DISCARD", [p.id, "all"]),
      type: "DISCARD",
      player: p.id,
      discard,
      discardUnknown: p.hidden.unknown,
      label: `Discard ${need}`,
    });
    return;
  }
  // Enumerate resource-count combinations rather than individual card
  // indexes. This is both smaller and complete: the old card-level recursion
  // stopped after 256 shapes, often before it reached the ore/wheat-heavy
  // option that the board-aware policy should compare.
  const rec = (index: number, left: number, d: Partial<Hand>) => {
    if (index === RESOURCES.length) {
      if (left !== 0) return;
      const key = RESOURCES.map((r) => `${r}${d[r] ?? 0}`).join("");
      acts.push({
        id: aid("DISCARD", [p.id, key]),
        type: "DISCARD",
        player: p.id,
        discard: { ...d },
        discardUnknown: 0,
        label: `Discard ${RESOURCES.filter((r) => d[r]).map((r) => `${d[r]} ${r}`).join(", ")}`,
      });
      return;
    }
    const resource = RESOURCES[index];
    const max = Math.min(p.hand[resource], left);
    for (let count = 0; count <= max; count += 1) {
      if (count) d[resource] = count;
      else delete d[resource];
      rec(index + 1, left - count, d);
    }
    delete d[resource];
  };
  rec(0, need, {});
}

function spendDev(p: Player, kind: Exclude<DevKind, "vp">): void {
  if (p.devs[kind] <= 0) throw new Error(`no ${kind}`);
  p.devs[kind] -= 1;
  p.playedDevThisTurn = true;
}

function nextDiscarder(state: GameState): string | null {
  for (const p of state.players) {
    if ((state.mustDiscard[p.id] ?? 0) > 0) return p.id;
  }
  return null;
}

export function applyAction(state: GameState, action: Action, rng: () => number = Math.random): GameState {
  const p = player(state, action.player);
  switch (action.type) {
    case "PLACE_SETTLEMENT": {
      if (!action.vertex) throw new Error("vertex");
      p.settlements.push(action.vertex);
      state.setupAnchor[p.id] = action.vertex;
      if (!state.setupForward) grantSetupResources(state, p, action.vertex);
      state.phase = "setup_road";
      state.log.push(`${p.name} placed a settlement`);
      break;
    }
    case "PLACE_ROAD": {
      if (!action.edge) throw new Error("edge");
      p.roads.push(action.edge);
      state.log.push(`${p.name} placed a road`);
      setupNext(state);
      break;
    }
    case "ROLL": {
      const a = 1 + Math.floor(rng() * 6);
      const b = 1 + Math.floor(rng() * 6);
      state.dice = [a, b];
      state.roller = p.id;
      const total = a + b;
      state.log.push(`${p.name} rolled ${total}`);
      if (total === 7) {
        state.mustDiscard = {};
        for (const pl of state.players) {
          const n = handCount(pl.hand);
          if (n > state.config.discardLimit) state.mustDiscard[pl.id] = Math.floor(n / 2);
        }
        state.afterRobber = "turn";
        const d = nextDiscarder(state);
        if (d) {
          state.phase = "discard";
          state.current = d;
        } else {
          state.phase = "robber";
          state.current = p.id;
        }
      } else {
        produce(state, total);
        state.phase = "turn";
      }
      break;
    }
    case "DISCARD": {
      const d = action.discard ?? {};
      for (const r of RESOURCES) {
        const n = d[r] ?? 0;
        p.hand[r] -= n;
        p.hidden.known[r] = Math.max(0, p.hidden.known[r] - n);
        giveToBank(state, r, n);
      }
      p.hidden.unknown = Math.max(0, p.hidden.unknown - (action.discardUnknown ?? 0));
      delete state.mustDiscard[p.id];
      const d2 = nextDiscarder(state);
      if (d2) state.current = d2;
      else {
        state.current = state.roller;
        state.phase = "robber";
      }
      state.log.push(`${p.name} discarded`);
      break;
    }
    case "MOVE_ROBBER": {
      if (!action.hex) throw new Error("hex");
      state.robberHex = action.hex;
      state.log.push(`${p.name} moved robber`);
      if (action.stealFrom) stealOne(state, p, action.stealFrom, rng);
      resumeAfterRobber(state, p);
      break;
    }
    case "STEAL": {
      if (action.stealFrom) stealOne(state, p, action.stealFrom, rng);
      resumeAfterRobber(state, p);
      break;
    }
    case "BUILD_SETTLEMENT": {
      if (!action.vertex) throw new Error("vertex");
      pay(p.hand, COSTS.settlement);
      for (const r of RESOURCES) {
        giveToBank(state, r, COSTS.settlement[r]);
        p.hidden.known[r] = Math.max(0, p.hidden.known[r] - COSTS.settlement[r]);
      }
      p.settlements.push(action.vertex);
      refreshAwards(state);
      state.log.push(`${p.name} built a settlement`);
      break;
    }
    case "BUILD_CITY": {
      if (!action.vertex) throw new Error("vertex");
      pay(p.hand, COSTS.city);
      for (const r of RESOURCES) {
        giveToBank(state, r, COSTS.city[r]);
        p.hidden.known[r] = Math.max(0, p.hidden.known[r] - COSTS.city[r]);
      }
      p.settlements = p.settlements.filter((v) => v !== action.vertex);
      p.cities.push(action.vertex);
      state.log.push(`${p.name} built a city`);
      break;
    }
    case "BUILD_ROAD": {
      if (!action.edge) throw new Error("edge");
      if (state.phase !== "road_building") {
        pay(p.hand, COSTS.road);
        giveToBank(state, "wood", 1);
        giveToBank(state, "brick", 1);
        p.hidden.known.wood = Math.max(0, p.hidden.known.wood - 1);
        p.hidden.known.brick = Math.max(0, p.hidden.known.brick - 1);
      }
      p.roads.push(action.edge);
      refreshAwards(state);
      state.log.push(`${p.name} built a road`);
      if (state.phase === "road_building") {
        state.pendingRoads -= 1;
        if (state.pendingRoads <= 0) state.phase = "turn";
      }
      break;
    }
    case "BUY_DEV": {
      pay(p.hand, COSTS.dev);
      for (const r of RESOURCES) {
        giveToBank(state, r, COSTS.dev[r]);
        p.hidden.known[r] = Math.max(0, p.hidden.known[r] - COSTS.dev[r]);
      }
      const card = state.deck.shift();
      if (!card) throw new Error("empty deck");
      if (card === "vp") p.devs.vp += 1;
      else p.newDevs[card] += 1;
      state.log.push(`${p.name} bought a dev card`);
      break;
    }
    case "PLAY_KNIGHT": {
      spendDev(p, "knight");
      p.knightsPlayed += 1;
      refreshAwards(state);
      state.afterRobber = state.phase === "roll" ? "roll" : "turn";
      state.phase = "robber";
      state.log.push(`${p.name} played a knight`);
      break;
    }
    case "PLAY_MONOPOLY": {
      if (!action.resource) throw new Error("resource");
      if (state.phase !== "monopoly") {
        spendDev(p, "monopoly");
        state.phase = "monopoly";
        state.log.push(`${p.name} played monopoly`);
        break;
      }
      let got = 0;
      for (const o of state.players) {
        if (o.id === p.id) continue;
        got += o.hand[action.resource];
        o.hand[action.resource] = 0;
        o.hidden.known[action.resource] = 0;
      }
      p.hand[action.resource] += got;
      p.hidden.known[action.resource] += got;
      state.log.push(`${p.name} monopolized ${action.resource} (${got})`);
      state.phase = "turn";
      break;
    }
    case "PLAY_ROAD_BUILDING": {
      spendDev(p, "road_building");
      state.phase = "road_building";
      state.pendingRoads = 2;
      state.log.push(`${p.name} played road building`);
      break;
    }
    case "PLAY_YEAR_OF_PLENTY": {
      if (state.phase !== "year_of_plenty") {
        spendDev(p, "year_of_plenty");
        state.phase = "year_of_plenty";
        state.pendingYop = 2;
        state.log.push(`${p.name} played year of plenty`);
        break;
      }
      const resources = action.resources?.length ? action.resources : action.resource ? [action.resource] : [];
      if (!resources.length) throw new Error("resource");
      for (const resource of resources.slice(0, state.pendingYop)) {
        const got = takeFromBank(state, resource, 1);
        add(p.hand, resource, got);
        add(p.hidden.known, resource, got);
        state.pendingYop -= 1;
      }
      if (state.pendingYop <= 0) state.phase = "turn";
      break;
    }
    case "ACCEPT_TRADE": {
      const o = state.pendingOffer;
      if (!o) break;
      const usP = player(state, state.us);
      const them = player(state, o.from);
      usP.hand[o.get] = Math.max(0, usP.hand[o.get] - o.getCount);
      usP.hidden.known[o.get] = Math.max(0, usP.hidden.known[o.get] - o.getCount);
      them.hand[o.get] += o.getCount;
      them.hand[o.give] = Math.max(0, them.hand[o.give] - o.giveCount);
      them.hidden.known[o.give] = Math.max(0, them.hidden.known[o.give] - o.giveCount);
      usP.hand[o.give] += o.giveCount;
      usP.hidden.known[o.give] += o.giveCount;
      state.pendingOffer = null;
      state.log.push(`${usP.name} accepted ${them.name}'s ${o.give} for ${o.get}`);
      break;
    }
    case "REJECT_TRADE": {
      const o = state.pendingOffer;
      const them = o ? player(state, o.from).name : "them";
      state.pendingOffer = null;
      state.log.push(`${player(state, action.player).name} declined a trade from ${them}`);
      break;
    }
    case "MARITIME_TRADE": {
      const give = action.give!;
      const get = action.get!;
      const n = action.giveCount ?? 4;
      p.hand[give] -= n;
      p.hidden.known[give] = Math.max(0, p.hidden.known[give] - n);
      giveToBank(state, give, n);
      const got = takeFromBank(state, get, 1);
      add(p.hand, get, got);
      add(p.hidden.known, get, got);
      state.log.push(`${p.name} traded ${n} ${give} for ${get}`);
      break;
    }
    case "END_TURN": {
      if (state.phase === "road_building") {
        state.pendingRoads = 0;
        state.phase = "turn";
        break;
      }
      p.playedDevThisTurn = false;
      for (const k of Object.keys(p.newDevs) as (keyof DevHand)[]) {
        p.devs[k] += p.newDevs[k];
        p.newDevs[k] = 0;
      }
      const idx = state.players.findIndex((x) => x.id === p.id);
      state.current = state.players[(idx + 1) % state.players.length].id;
      state.phase = "roll";
      state.turn += 1;
      state.log.push(`${p.name} ended turn`);
      break;
    }
  }
  refreshAwards(state);
  checkWin(state);
  return state;
}

function stealOne(state: GameState, thief: Player, victimId: string, rng: () => number): void {
  const v = player(state, victimId);
  const pool: Resource[] = [];
  for (const r of RESOURCES) for (let i = 0; i < v.hand[r]; i++) pool.push(r);
  if (pool.length === 0) return;
  const r = pool[Math.floor(rng() * pool.length)];
  v.hand[r] -= 1;
  v.hidden.known[r] = Math.max(0, v.hidden.known[r] - 1);
  thief.hand[r] += 1;
  thief.hidden.known[r] += 1;
  state.log.push(`${thief.name} stole from ${v.name}`);
}

function resumeAfterRobber(state: GameState, p: Player): void {
  state.phase = state.afterRobber;
  state.current = p.id;
  state.stealFrom = [];
}

export function cloneState(state: GameState): GameState {
  return structuredClone(state);
}

export function handSize(p: Player): number {
  return handCount(p.hand) + p.hidden.unknown;
}

export { handCount, tradeRate, settlementSpots, roadSpots, stealCandidates };
