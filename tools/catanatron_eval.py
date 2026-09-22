#!/usr/bin/env python3
"""Run reproducible Catanatron games with catanbot as a native Player.

The optional Catanatron install stays outside this repository. The Python
side owns Catanatron's rules, dice, and legal-action list; a long-lived Node
JSONL worker applies the existing catanbot policy to each decision and returns
the index of one of those legal actions.

Examples:
  python tools/catanatron_eval.py --games 10 --opponent value
  python tools/catanatron_eval.py --games 5 --opponent alphabeta --verbose
  python tools/catanatron_eval.py --games 10 --players 4 --opponent value

Install the simulator in an isolated environment first (Python 3.11+):
  uv venv --python 3.11 .catanatron-venv
  uv pip install --python .catanatron-venv/bin/python \
    'catanatron @ git+https://github.com/bcollazo/catanatron.git'
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any


RESOURCES = ("WOOD", "BRICK", "SHEEP", "WHEAT", "ORE")
RESOURCE_NAMES = {resource: resource.lower() for resource in RESOURCES}
DEVS = {
    "KNIGHT": "knight",
    "YEAR_OF_PLENTY": "year_of_plenty",
    "MONOPOLY": "monopoly",
    "ROAD_BUILDING": "road_building",
    "VICTORY_POINT": "vp",
}


def color_id(color: Any) -> str:
    return color.value.lower()


def resource_hand(state: Any, key: str) -> dict[str, int]:
    return {
        RESOURCE_NAMES[resource]: int(state.player_state[f"{key}_{resource}_IN_HAND"])
        for resource in RESOURCES
    }


def add_counts(values: dict[str, int]) -> int:
    return sum(values.values())


def tile_id(state: Any, coordinate: Any) -> str:
    tile = state.board.map.land_tiles[coordinate]
    return f"h:{tile.id}"


def node_id(node: int) -> str:
    return f"n:{node}"


def edge_id(edge: tuple[int, int]) -> str:
    a, b = sorted((int(edge[0]), int(edge[1])))
    return f"e:{a}-{b}"


def board_payload(state: Any) -> dict[str, Any]:
    board_map = state.board.map
    hexes: list[dict[str, Any]] = []
    node_hexes: dict[int, list[str]] = {int(node): [] for node in board_map.land_nodes}
    edge_vertices: set[tuple[int, int]] = set()

    for coordinate, tile in board_map.land_tiles.items():
        hid = f"h:{tile.id}"
        terrain = RESOURCE_NAMES[tile.resource] if tile.resource is not None else "desert"
        vertices = [node_id(int(node)) for node in tile.nodes.values()]
        hexes.append({
            "id": hid,
            "q": int(coordinate[0]),
            "r": int(coordinate[1]),
            "terrain": terrain,
            "number": int(tile.number) if tile.number is not None else None,
            "vertices": vertices,
        })
        for node in tile.nodes.values():
            node_hexes[int(node)].append(hid)
        for edge in tile.edges.values():
            edge_vertices.add(tuple(sorted((int(edge[0]), int(edge[1])))))

    port_by_node: dict[int, dict[str, Any]] = {}
    for port in board_map.ports_by_id.values():
        for node in port.nodes.values():
            node = int(node)
            if node not in board_map.land_nodes:
                continue
            port_by_node[node] = {
                "ratio": 2 if port.resource is not None else 3,
                **({"resource": RESOURCE_NAMES[port.resource]} if port.resource is not None else {}),
            }

    node_edges: dict[int, list[str]] = {int(node): [] for node in board_map.land_nodes}
    edges: list[dict[str, Any]] = []
    for edge in sorted(edge_vertices):
        eid = edge_id(edge)
        edges.append({"id": eid, "vertices": [node_id(edge[0]), node_id(edge[1])]})
        node_edges[edge[0]].append(eid)
        node_edges[edge[1]].append(eid)

    vertices = []
    for node in sorted(int(n) for n in board_map.land_nodes):
        vertex: dict[str, Any] = {
            "id": node_id(node),
            "hexes": node_hexes[node],
            "edges": node_edges[node],
        }
        if node in port_by_node:
            vertex["port"] = port_by_node[node]
        vertices.append(vertex)

    return {"hexes": hexes, "vertices": vertices, "edges": edges}


def buildings_for(state: Any, color: Any, kind: str) -> list[Any]:
    return list(state.buildings_by_color[color].get(kind, []))


def player_payload(state: Any, color: Any, us: Any) -> dict[str, Any]:
    from catanatron.models.enums import CITY, ROAD, SETTLEMENT

    key = f"P{state.color_to_index[color]}"
    hand = resource_hand(state, key)
    own_hand = color == us
    devs: dict[str, int] = {}
    new_devs: dict[str, int] = {}
    for catanatron_name, local_name in DEVS.items():
        count = int(state.player_state[f"{key}_{catanatron_name}_IN_HAND"])
        # Catanatron exposes a boolean snapshot for whether each non-VP card
        # existed at the start of the turn. This prevents the bridge from
        # illegally playing a development card bought during this turn.
        if catanatron_name != "VICTORY_POINT":
            can_play = bool(state.player_state.get(f"{key}_{catanatron_name}_OWNED_AT_START", False))
            count = count if can_play else 0
        if own_hand:
            devs[local_name] = count
        else:
            devs[local_name] = 0
        new_devs[local_name] = 0

    settlements = [node_id(int(node)) for node in buildings_for(state, color, SETTLEMENT)]
    cities = [node_id(int(node)) for node in buildings_for(state, color, CITY)]
    roads = [edge_id((int(edge[0]), int(edge[1]))) for edge in buildings_for(state, color, ROAD)]
    public_vp = int(state.player_state[f"{key}_VICTORY_POINTS"])
    actual_vp = int(state.player_state[f"{key}_ACTUAL_VICTORY_POINTS"])
    hidden_vp = max(0, actual_vp - public_vp) if own_hand else 0
    hidden_known = hand if own_hand else {resource: 0 for resource in hand}
    hidden_unknown = 0 if own_hand else add_counts(hand)
    return {
        "id": color_id(color),
        "name": color_id(color),
        "hand": hand if own_hand else {resource: 0 for resource in hand},
        "hiddenKnown": hidden_known,
        "hiddenUnknown": hidden_unknown,
        "devs": {**devs, "vp": hidden_vp},
        "newDevs": new_devs,
        "knightsPlayed": int(state.player_state[f"{key}_PLAYED_KNIGHT"]),
        "settlements": settlements,
        "cities": cities,
        "roads": roads,
        "playedDevThisTurn": bool(state.player_state[f"{key}_HAS_PLAYED_DEVELOPMENT_CARD_IN_TURN"]),
    }


def normalize_resource(value: Any) -> str | None:
    if value is None:
        return None
    return RESOURCE_NAMES.get(str(value))


def action_payload(state: Any, action: Any) -> dict[str, Any]:
    from catanatron.models.enums import ActionType

    result: dict[str, Any] = {"type": action.action_type.name}
    value = action.value
    if action.action_type in (ActionType.BUILD_SETTLEMENT, ActionType.BUILD_CITY):
        result["vertex"] = node_id(int(value))
    elif action.action_type == ActionType.BUILD_ROAD:
        result["edge"] = edge_id((int(value[0]), int(value[1])))
    elif action.action_type == ActionType.MOVE_ROBBER:
        coordinate, victim = value
        result["hex"] = tile_id(state, coordinate)
        result["stealFrom"] = color_id(victim) if victim is not None else None
    elif action.action_type == ActionType.DISCARD_RESOURCE:
        result["resource"] = normalize_resource(value)
    elif action.action_type == ActionType.PLAY_MONOPOLY:
        result["resource"] = normalize_resource(value)
    elif action.action_type == ActionType.PLAY_YEAR_OF_PLENTY:
        result["resources"] = [normalize_resource(resource) for resource in value]
    elif action.action_type == ActionType.MARITIME_TRADE:
        offered = [resource for resource in value[:4] if resource is not None]
        result["give"] = normalize_resource(offered[0]) if offered else None
        result["giveCount"] = len(offered)
        result["get"] = normalize_resource(value[4])
    elif action.action_type in (ActionType.ACCEPT_TRADE, ActionType.REJECT_TRADE):
        trade = value
        if isinstance(trade, (tuple, list)) and len(trade) >= 10:
            offered = [(resource, int(amount)) for resource, amount in zip(RESOURCES, trade[:5]) if amount]
            asked = [(resource, int(amount)) for resource, amount in zip(RESOURCES, trade[5:10]) if amount]
            if offered and asked:
                result["trade"] = {
                    "give": normalize_resource(offered[0][0]),
                    "giveCount": offered[0][1],
                    "get": normalize_resource(asked[0][0]),
                    "getCount": asked[0][1],
                }
    return result


def current_phase(state: Any) -> str:
    prompt = state.current_prompt.name
    if prompt == "BUILD_INITIAL_SETTLEMENT":
        return "setup_settle"
    if prompt == "BUILD_INITIAL_ROAD":
        return "setup_road"
    if prompt == "DISCARD":
        return "discard"
    if prompt == "MOVE_ROBBER":
        return "robber"
    if prompt == "DECIDE_TRADE":
        return "turn"
    if prompt == "DECIDE_ACCEPTEES":
        return "special"
    if state.is_road_building:
        return "road_building"
    key = f"P{state.color_to_index[state.current_color()]}"
    return "turn" if state.player_state[f"{key}_HAS_ROLLED"] else "roll"


def make_request(game: Any, us: Any) -> dict[str, Any]:
    state = game.state
    current = state.current_color()
    colors = list(state.colors)
    current_key = f"P{state.color_to_index[current]}"
    must_discard = {
        color_id(color): int(state.discard_counts[state.color_to_index[color]])
        for color in colors
        if int(state.discard_counts[state.color_to_index[color]]) > 0
    }
    robber_hex = tile_id(state, state.board.robber_coordinate)
    longest = color_id(state.board.road_color) if state.board.road_color is not None else None
    largest = None
    for color in colors:
        key = f"P{state.color_to_index[color]}"
        if state.player_state[f"{key}_HAS_ARMY"]:
            largest = color_id(color)
            break

    after_robber = "turn"
    if not state.player_state[f"{current_key}_HAS_ROLLED"]:
        after_robber = "roll"
    roller = color_id(colors[state.current_turn_index])

    pending_offer = None
    if state.current_prompt.name == "DECIDE_TRADE":
        offered = [
            (resource, int(amount))
            for resource, amount in zip(RESOURCES, state.current_trade[:5])
            if amount
        ]
        asked = [
            (resource, int(amount))
            for resource, amount in zip(RESOURCES, state.current_trade[5:10])
            if amount
        ]
        if offered and asked:
            pending_offer = {
                "id": "catanatron-trade",
                "from": color_id(colors[state.current_turn_index]),
                "give": normalize_resource(offered[0][0]),
                "giveCount": offered[0][1],
                "get": normalize_resource(asked[0][0]),
                "getCount": asked[0][1],
            }

    return {
        "us": color_id(us),
        "current": color_id(current),
        "phase": current_phase(state),
        "turn": int(state.num_turns),
        "setupIndex": int(state.current_player_index),
        "setupForward": len(buildings_for(state, current, "SETTLEMENT")) == 0,
        "pendingRoads": int(state.free_roads_available),
        "pendingYop": 0,
        "afterRobber": after_robber,
        "roller": roller,
        "robberHex": robber_hex,
        "longestRoad": longest,
        "largestArmy": largest,
        "bank": {
            RESOURCE_NAMES[resource]: int(state.resource_freqdeck[index])
            for index, resource in enumerate(RESOURCES)
        },
        "deckCount": len(state.development_listdeck),
        "mustDiscard": must_discard,
        "pendingOffer": pending_offer,
        "board": board_payload(state),
        "players": [player_payload(state, color, us) for color in colors],
        "actions": [action_payload(state, action) for action in game.playable_actions],
        "config": {
            "playerCount": len(colors),
            "victoryPoints": int(game.vps_to_win),
            "discardLimit": int(state.discard_limit),
            "friendlyRobber": bool(state.friendly_robber),
        },
    }


class BridgeClient:
    def __init__(self, root: Path, use_jev: bool = False):
        env = os.environ.copy()
        env["JEV_OFFLINE"] = "0" if use_jev else "1"
        self.process = subprocess.Popen(
            ["node", "--experimental-strip-types", str(root / "src/eval/catanatron_bridge.ts")],
            cwd=root,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
            bufsize=1,
        )

    def choose(self, request: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        self.process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("catanbot bridge exited without a response")
        response = json.loads(line)
        if not response.get("ok"):
            raise RuntimeError(response.get("error", "unknown catanbot bridge error"))
        return int(response["index"]), response.get("recommendation", {})

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)


def make_opponent(name: str, color: Any) -> Any:
    from catanatron import RandomPlayer
    from catanatron.players.value import ValueFunctionPlayer
    from catanatron.players.minimax import AlphaBetaPlayer

    if name == "random":
        return RandomPlayer(color)
    if name == "value":
        return ValueFunctionPlayer(color)
    if name == "contender":
        return ValueFunctionPlayer(color, ValueFunctionPlayer.Params(value_fn="contender"))
    if name == "alphabeta":
        return AlphaBetaPlayer(color, AlphaBetaPlayer.Params(depth=2, prunning=True))
    raise ValueError(f"unknown opponent: {name}")


def run(args: argparse.Namespace) -> int:
    from catanatron import Color, Game, Player

    class CatanbotPlayer(Player):
        LABEL = "catanbot"

        def __init__(self, color: Any, client: BridgeClient):
            super().__init__(color)
            self.client = client
            self.sources: Counter[str] = Counter()
            self.trace: list[dict[str, Any]] = []

        def decide(self, game: Any, playable_actions: Any) -> Any:
            request = make_request(game, self.color)
            index, recommendation = self.client.choose(request)
            self.sources[str(recommendation.get("source", "unknown"))] += 1
            if index < 0 or index >= len(playable_actions):
                raise RuntimeError(f"bridge returned illegal action index {index}/{len(playable_actions)}")
            if args.trace:
                chosen = playable_actions[index]
                self.trace.append({
                    "turn": int(game.state.num_turns),
                    "prompt": game.state.current_prompt.name,
                    "phase": request["phase"],
                    "chosen": chosen.action_type.name,
                    "value": repr(chosen.value),
                    "source": recommendation.get("source", "unknown"),
                    "reason": recommendation.get("reason", ""),
                })
            return playable_actions[index]

    root = Path(__file__).resolve().parents[1]
    client = BridgeClient(root, use_jev=args.jev)
    wins = {"catanbot": 0, args.opponent: 0, "draw": 0}
    colors = list(Color)
    opponent_colors = colors[1:args.players]
    vps_to_win = 15 if args.players == 2 else 10
    discard_limit = 9 if args.players == 2 else 7
    records: list[dict[str, Any]] = []
    try:
        for game_number in range(args.games):
            # Keep catanbot on a stable color. Catanatron still randomizes
            # the board and dice, while the extra colors exercise the same
            # multiplayer denial/trade pressure as the live match.
            bot_color = Color.RED
            catanbot = CatanbotPlayer(bot_color, client)
            players = [catanbot, *(make_opponent(args.opponent, color) for color in opponent_colors)]
            game = Game(
                players,
                seed=args.seed + game_number,
                discard_limit=discard_limit,
                friendly_robber=True,
                vps_to_win=vps_to_win,
            )
            winner = game.play()
            winner_name = "draw"
            if winner is not None:
                winner_name = "catanbot" if winner == bot_color else args.opponent
            wins[winner_name] += 1
            bot_key = f"P{game.state.color_to_index[bot_color]}"
            bot_actions = Counter(
                action_record.action.action_type.name
                for action_record in game.state.action_records
                if action_record.action.color == bot_color
            )
            actual_vp = {
                color_id(color): int(
                    game.state.player_state[
                        f"P{game.state.color_to_index[color]}_ACTUAL_VICTORY_POINTS"
                    ]
                )
                for color in colors[:args.players]
            }
            record = {
                "game": game_number + 1,
                "seed": args.seed + game_number,
                "winner": winner_name,
                "plies": len(game.state.action_records),
                "turns": int(game.state.num_turns),
                "botActualVp": int(game.state.player_state[f"{bot_key}_ACTUAL_VICTORY_POINTS"]),
                "opponentActualVp": max(
                    value for color, value in actual_vp.items() if color != color_id(bot_color)
                ),
                "actualVp": actual_vp,
                "botActions": dict(bot_actions),
                "bridgeSources": dict(catanbot.sources),
            }
            if args.trace:
                record["botTrace"] = catanbot.trace
            records.append(record)
            if args.verbose:
                print(json.dumps(record), flush=True)
    finally:
        client.close()

    summary = {
        "ok": True,
        "games": args.games,
        "players": args.players,
        "victoryPoints": vps_to_win,
        "discardLimit": discard_limit,
        "opponent": args.opponent,
        "jev": args.jev,
        "wins": wins,
        "winRate": wins["catanbot"] / args.games if args.games else 0,
        "records": records,
    }
    print(json.dumps(summary, indent=2), flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games", type=int, default=5)
    parser.add_argument("--seed", type=int, default=1000)
    parser.add_argument("--players", type=int, choices=(2, 3, 4), default=2)
    parser.add_argument(
        "--opponent",
        choices=("random", "value", "contender", "alphabeta"),
        default="value",
    )
    parser.add_argument("--jev", action="store_true", help="allow the Node worker to call the configured Jev gateway")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--trace", action="store_true", help="include every catanbot decision in each record")
    args = parser.parse_args()
    if args.games < 1:
        parser.error("--games must be positive")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
