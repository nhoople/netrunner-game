# Netrunner game

The multiplayer Android: Netrunner game. It plays through the other three repositories and does not redefine cards, rules text, or rules evaluation.

This repo is in the initial stage: a local two-seat table for verifying the engine. Matchmaking, accounts, and a full product UI come later, in this repo.

**Repo:** [github.com/nhoople/netrunner-game](https://github.com/nhoople/netrunner-game)

| Dependency | Pin | What this repo uses it for |
| --- | --- | --- |
| [netrunner-engine](https://github.com/nhoople/netrunner-engine) | [`data/engine-pin.json`](data/engine-pin.json) (`v1.144.0`) | Game state, legality, and effect evaluation |
| [netrunner-cards-data](https://github.com/nhoople/netrunner-cards-data) | [`data/cards-pin.json`](data/cards-pin.json) (`v1.144.0`) | Card definitions |
| [netrunner-comprehensive-rules-data](https://github.com/nhoople/netrunner-comprehensive-rules-data) | [`data/cr-pin.json`](data/cr-pin.json) (`v26.03`) | Rules index and node text |

See [`NOTICE`](NOTICE). Code here is MIT. Vendored rules and card text stay reference material.

## Layout

Keep the four checkouts as siblings:

```text
Documents/Netrunner/
  netrunner-comprehensive-rules-data/
  netrunner-cards-data/
  netrunner-engine/
  netrunner-game/          ← this repo
```

`npm run fetch-engine` clones engine tag `v1.144.0` into `deps/netrunner-engine`. Card and rules JSON are fetched by tag into `vendor/` and are not committed. Cards pin `v1.144.0`. `v26.03` is the current Comprehensive Rules release.

## Setup

Requires Node.js 20+.

```bash
npm run fetch-engine  # deps/netrunner-engine at v1.144.0
npm install
npm run build:engine
npm run fetch-data    # vendor/cr-data and vendor/cards-data
npm run typecheck     # tsc --noEmit
npm run check         # engine state + one card + one rule id
npm test              # pins, seat views, chat rooms, concede
npm start             # http://127.0.0.1:8787
```

`npm start` serves a two-seat test table. Create a match and open the Corp and Runner links. The spectator link watches the same match with both hands hidden, reads table chat, and speaks in a separate room. The game uses the System Gateway learn-to-play decks. Table chat is on the page.

`npm run check` prints the engine pin, Comprehensive Rules version, rule `1.2.1`, the supported card count, and a description of a fresh game state.

CI on pull requests and `master` fetches the pinned engine, cards, and rules, then runs typecheck, `npm test`, and `npm run check`.
