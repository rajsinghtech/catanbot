export const RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"] as const;
export type Resource = (typeof RESOURCES)[number];

export type Terrain = Resource | "desert";

export const PLAYER_COLORS = ["red", "blue", "orange", "white", "green", "brown"] as const;
export type PlayerColor = (typeof PLAYER_COLORS)[number];

export type Phase =
  | "setup_settle"
  | "setup_road"
  | "roll"
  | "discard"
  | "robber"
  | "steal"
  | "turn"
  | "monopoly"
  | "road_building"
  | "year_of_plenty"
  | "ended"
  | "special";

export type ActionType =
  | "PLACE_SETTLEMENT"
  | "PLACE_ROAD"
  | "BUILD_SETTLEMENT"
  | "BUILD_CITY"
  | "BUILD_ROAD"
  | "BUY_DEV"
  | "PLAY_KNIGHT"
  | "PLAY_MONOPOLY"
  | "PLAY_YEAR_OF_PLENTY"
  | "PLAY_ROAD_BUILDING"
  | "MOVE_ROBBER"
  | "STEAL"
  | "DISCARD"
  | "MARITIME_TRADE"
  | "ACCEPT_TRADE"
  | "REJECT_TRADE"
  | "END_TURN"
  | "ROLL";

export interface TradeOffer {
  /** Colonist's authoritative active-offer id, when the live runtime exposes it. */
  id?: string;
  from: string;
  give: Resource;
  giveCount: number;
  get: Resource;
  getCount: number;
}

export type DevKind = "knight" | "vp" | "monopoly" | "year_of_plenty" | "road_building";

export interface Port {
  ratio: 2 | 3;
  resource?: Resource;
}

export interface Hex {
  id: string;
  q: number;
  r: number;
  terrain: Terrain;
  number: number | null;
  vertices: string[];
}

export interface Vertex {
  id: string;
  hexes: string[];
  edges: string[];
  /** Index in Colonist's authoritative _tileCorners array, when attached. */
  colonistIndex?: number;
  port?: Port;
  x: number;
  y: number;
}

export interface Edge {
  id: string;
  vertices: [string, string];
  /** Index in Colonist's authoritative _tileEdges array, when attached. */
  colonistIndex?: number;
}

export interface Board {
  hexes: Record<string, Hex>;
  vertices: Record<string, Vertex>;
  edges: Record<string, Edge>;
}

export interface Hand {
  wood: number;
  brick: number;
  sheep: number;
  wheat: number;
  ore: number;
}

export interface HiddenHand {
  known: Hand;
  unknown: number;
}

export interface DevHand {
  knight: number;
  vp: number;
  monopoly: number;
  year_of_plenty: number;
  road_building: number;
}

/** Pieces observed in a live game before Colonist exposes their board ids. */
export interface UnplacedPieces {
  settlements: number;
  cities: number;
  roads: number;
}

export interface Player {
  id: string;
  name: string;
  color: PlayerColor;
  /** Colonist playerUserStates color int (1=blue, 2=red, 3=orange, 4=brown, 5=white). */
  colonistColor?: number;
  hand: Hand;
  hidden: HiddenHand;
  devs: DevHand;
  newDevs: DevHand;
  knightsPlayed: number;
  settlements: string[];
  cities: string[];
  roads: string[];
  unplaced: UnplacedPieces;
  playedDevThisTurn: boolean;
}

export interface GameConfig {
  victoryPoints: number;
  discardLimit: number;
  friendlyRobber: boolean;
  playerCount: number;
}

export interface GameState {
  config: GameConfig;
  board: Board;
  players: Player[];
  us: string;
  current: string;
  phase: Phase;
  robberHex: string;
  bank: Hand;
  deck: DevKind[];
  longestRoad: string | null;
  largestArmy: string | null;
  setupIndex: number;
  setupForward: boolean;
  /** Authoritative newest setup settlement per player; array order is not reliable. */
  setupAnchor: Record<string, string | undefined>;
  dice: [number, number] | null;
  turn: number;
  mustDiscard: Record<string, number>;
  stealFrom: string[];
  pendingRoads: number;
  pendingYop: number;
  pendingOffer: TradeOffer | null;
  needsBoardSync: boolean;
  roller: string;
  afterRobber: Phase;
  winner: string | null;
  log: string[];
}

export interface Action {
  id: string;
  type: ActionType;
  player: string;
  vertex?: string;
  edge?: string;
  hex?: string;
  stealFrom?: string;
  resource?: Resource;
  resources?: Resource[];
  give?: Resource;
  giveCount?: number;
  get?: Resource;
  discard?: Partial<Hand>;
  discardUnknown?: number;
  tradeId?: string;
  label: string;
}

export interface Recommendation {
  action: Action;
  target: string;
  reason: string;
  plan: string;
  opponentThreat: string;
  confidence: number;
  operation: ActionType;
  operationProbabilities: Record<string, number>;
  targetProbabilities: Record<string, number>;
  latencyMs: number;
  source: "jev" | "mock" | "forced";
}

export interface WinRoute {
  player: string;
  visible: number;
  hiddenMin: number;
  hiddenMax: number;
  need: number;
  notes: string[];
}

export const EMPTY_HAND = (): Hand => ({
  wood: 0,
  brick: 0,
  sheep: 0,
  wheat: 0,
  ore: 0,
});

export const EMPTY_DEVS = (): DevHand => ({
  knight: 0,
  vp: 0,
  monopoly: 0,
  year_of_plenty: 0,
  road_building: 0,
});

export const COSTS = {
  road: { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 } satisfies Hand,
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 } satisfies Hand,
  city: { wood: 0, brick: 0, sheep: 0, wheat: 2, ore: 3 } satisfies Hand,
  dev: { wood: 0, brick: 0, sheep: 1, wheat: 1, ore: 1 } satisfies Hand,
};

export const PIP: Record<number, number> = {
  2: 1,
  3: 2,
  4: 3,
  5: 4,
  6: 5,
  8: 5,
  9: 4,
  10: 3,
  11: 2,
  12: 1,
};
