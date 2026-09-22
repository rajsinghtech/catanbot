import { PIP, RESOURCES, type Action, type GameState, type Resource, type WinRoute } from "../types.ts";
import { handSize, player, roadLength, totalVP, visibleVP } from "./game.ts";
import { resourceOf } from "./map.ts";

export function production(state: GameState, id: string): Record<Resource, number> {
  const p = player(state, id);
  const out = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  const owned = new Set([...p.settlements, ...p.cities]);
  for (const hex of Object.values(state.board.hexes)) {
    const res = resourceOf(hex);
    if (!res || hex.number == null) continue;
    const pips = PIP[hex.number] ?? 0;
    const blocked = hex.id === state.robberHex ? 0 : 1;
    for (const vid of hex.vertices) {
      if (!owned.has(vid)) continue;
      const mult = p.cities.includes(vid) ? 2 : 1;
      out[res] += pips * mult * blocked;
    }
  }
  return out;
}

export function winRoute(state: GameState, id: string): WinRoute {
  const vis = visibleVP(state, id);
  const hid = player(state, id).devs.vp;
  const need = Math.max(0, state.config.victoryPoints - vis - hid);
  const notes: string[] = [];
  const p = player(state, id);
  const citiesLeft = 4 - p.cities.length - p.unplaced.cities;
  const settlesLeft = 5 - p.settlements.length - p.unplaced.settlements - p.cities.length - p.unplaced.cities;
  notes.push(`${citiesLeft} cities, ${settlesLeft} settlements remain`);
  if (state.longestRoad === id) notes.push("holds longest road");
  else notes.push(`road ${roadLength(state, id)} vs LR ${state.longestRoad ? roadLength(state, state.longestRoad) : 0}`);
  if (state.largestArmy === id) notes.push("holds largest army");
  else notes.push(`army ${p.knightsPlayed}`);
  notes.push(`${p.devs.vp} hidden VP, ${p.devs.knight + p.newDevs.knight} unplayed knights`);
  return {
    player: id,
    visible: vis,
    hiddenMin: hid,
    hiddenMax: hid + p.devs.knight + p.devs.monopoly + p.devs.year_of_plenty + p.devs.road_building,
    need,
    notes,
  };
}

export function opponentThreat(state: GameState, us: string): string {
  const others = state.players.filter((p) => p.id !== us);
  if (others.length === 0) return "No opponent.";
  others.sort((a, b) => totalVP(state, b.id) - totalVP(state, a.id));
  const o = others[0];
  const route = winRoute(state, o.id);
  const prod = production(state, o.id);
  const top = RESOURCES.slice().sort((a, b) => prod[b] - prod[a])[0];
  return `${o.name} at ${route.visible}+${route.hiddenMin} VP, needs ${route.need}. Strongest production ${top}. ${route.notes[1]}.`;
}

export function compactState(state: GameState, actions: Action[]): unknown {
  return {
    rules: state.config,
    turn: state.turn,
    phase: state.phase,
    current: state.current,
    us: state.us,
    dice: state.dice,
    robber: state.robberHex,
    awards: { longestRoad: state.longestRoad, largestArmy: state.largestArmy },
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      vp: visibleVP(state, p.id),
      hiddenVp: p.devs.vp,
      total: totalVP(state, p.id),
      hand: p.id === state.us || p.id === state.current ? p.hand : { total: handSize(p), known: p.hidden.known },
      pieces: {
        settlements: p.settlements.length + p.unplaced.settlements,
        cities: p.cities.length + p.unplaced.cities,
        roads: p.roads.length + p.unplaced.roads,
        unplaced: p.unplaced,
        roadLen: roadLength(state, p.id),
        knightsPlayed: p.knightsPlayed,
      },
      devs: p.id === state.us ? { ...p.devs, new: p.newDevs } : { boughtUnknown: true },
      production: production(state, p.id),
      win: winRoute(state, p.id),
    })),
    hexes: Object.values(state.board.hexes).map((h) => ({
      id: h.id,
      t: h.terrain,
      n: h.number,
      blocked: h.id === state.robberHex,
    })),
    legal: actions.map((a) => ({ id: a.id, type: a.type, label: a.label })),
    doctrine: [
      "Maximize P(we hit VP target before any opponent).",
      "Do not chase pip count, unused cards, or pretty boards.",
      "Wheat and ore dominate city/dev engines; brick/wood dominate expansion and road wars.",
      "Denial of an opponent win sequence can beat a greedy self-build.",
      "A two-road Longest Road swing is a four-VP relative swing.",
      "Robber attacks the opponent's NEXT action, not their historically strongest tile.",
      "Friendly robber: no steal/block of players under 3 visible VP.",
      "Endgame at ~11+ effective VP: search the win sequence.",
    ],
  };
}
