# Catanbot

Live Colonist advisor. A TypeScript engine enumerates legal actions; Jev (TypeSafe, via Vercel AI Gateway) picks among them. The extension is recommendation-only and never auto-clicks ranked Colonist games.

## Stack

- Engine: N-player base Catan (2–6), Colonist 1v1 ruleset when seats=2 (15 VP, discard 9, friendly robber)
- Decision: Jev Ultrafast pattern — one evaluate call, operation + target heads, recommendations carry engine action ids only
- Provider: `AI_GATEWAY_API_KEY` uses TypeSafe's `typesafe-ai/jev` directly through Vercel's evaluation endpoint; an explicitly enabled `JEV_PROVIDER=openai` is only an optional fallback
- Fallback: heuristic mock only when neither JEV provider is configured
- HUD: `http://127.0.0.1:8765`
- Colonist: Chrome extension in `extension/` streams log + MessagePack WebSocket frames to the local server

## Run

```bash
cp .env.example .env   # put the Vercel Gateway key in .env
npm install
npm test
npm run demo           # self-play into the HUD
```

Open `http://127.0.0.1:8765`. Load `extension/` unpacked on colonist.io for live recommend.

```bash
npm start              # HUD + API, no auto-play
npm run status         # health
```

For a live bot match, start both processes with the Vercel Gateway key:

```bash
AI_GATEWAY_API_KEY=... CATANBOT_MODE=play npm start
AI_GATEWAY_API_KEY=... npm run play
```

The live panel exposes the recommendation source and latency. A successful
decision shows `jev`; `mock` means the evaluator timed out or no provider was
configured.

`CATANBOT_MODE=recommend` (default). Keep ranked play in recommendation-only mode.

## Simulator evaluation

The policy can also be evaluated inside [Catanatron](https://docs.catanatron.com/),
whose `Player.decide(game, playable_actions)` hook supplies reproducible,
engine-legal decisions. The simulator is an optional external dependency; the
bridge keeps it in a separate Python process and returns only one of
Catanatron's own legal actions.

```bash
uv venv --python 3.11 .catanatron-venv
uv pip install --python .catanatron-venv/bin/python \
  'catanatron @ git+https://github.com/bcollazo/catanatron.git'
.catanatron-venv/bin/python tools/catanatron_eval.py \
  --games 10 --opponent value --verbose
```

Use `--opponent alphabeta` for the stronger depth-2 reference bot, or
`--jev` when `AI_GATEWAY_API_KEY` is exported and you intentionally want
network Jev calls during the slower benchmark. The default benchmark is
offline and uses the same local doctrine fallback that protects live action
latency.

## Controls

The full control panel at `http://127.0.0.1:8765` makes the automation boundary explicit:

- `Recommendation-only` observes any attached Colonist match and never clicks.
- `Auto-play bot match` enables the CDP driver for a non-ranked bot match.
- `Turn auto off` is a user override. It remains off when the driver resets into its next match.

The extension popup exposes the same three modes, plus attach, show/hide HUD, and a link to the full panel. The in-game HUD starts hidden; `Alt+Shift+C` toggles it. The panel reports the authoritative Colonist menu/action state and lists every base-Catan action: setup settlement/road, dice, builds, development cards, trades and trade responses, discard, robber movement, stealing, and end turn. Expansion-only menus are also recognized and surfaced; base-Catan mode pauses safely instead of guessing a click.

Auto-click is deliberately gated to non-ranked bot matches. Recommendation-only mode is the supported path for human, private, and ranked matches.

## Publishing

Before publishing to GitHub, keep `.env` out of the repository, verify that `AI_GATEWAY_API_KEY` is unset from tracked files, run `npm test`, and load `extension/` as an unpacked extension. The public repository is https://github.com/rajsinghtech/catanbot; never commit a provider key.
