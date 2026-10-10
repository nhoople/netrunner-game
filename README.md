# Netrunner game

These repositories stay separate and are consumed by release tag.

The multiplayer Android: Netrunner game. It plays through the other three repositories and does not redefine cards, rules text, or rules evaluation.

This repo is in the initial stage: a local two-seat table for verifying the engine. Matchmaking, accounts, and a full product UI come later, in this repo.

**Repo:** [github.com/nhoople/netrunner-game](https://github.com/nhoople/netrunner-game)

| Dependency | Pin | What this repo uses it for |
| --- | --- | --- |
| [netrunner-engine](https://github.com/nhoople/netrunner-engine) | [`data/engine-pin.json`](data/engine-pin.json) (`v1.145.0`) | Game state, legality, and effect evaluation |
| [netrunner-cards-data](https://github.com/nhoople/netrunner-cards-data) | [`data/cards-pin.json`](data/cards-pin.json) (`v1.145.0`) | Card definitions |
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

`npm run fetch-engine` clones engine tag `v1.145.0` into `deps/netrunner-engine`. Card and rules JSON are fetched by tag into `vendor/` and are not committed. Cards pin `v1.145.0`. `v26.03` is the current Comprehensive Rules release.

## Setup

Requires Node.js 24+.

```bash
npm run fetch-engine  # deps/netrunner-engine at v1.145.0
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

## Table against the engine checkout

`npm start` uses the clone from `npm run fetch-engine`. To try sibling engine edits on the table before a release, link that checkout and build it. The sibling needs its own `vendor/` (`npm run prepare-data` in `netrunner-engine`).

```bash
rm -rf deps/netrunner-engine
ln -s ../../netrunner-engine deps/netrunner-engine
npm run build --prefix ../netrunner-engine
npm start
```

Rebuild the engine after further edits, then refresh http://127.0.0.1:8787. `npm run fetch-engine` puts tag `v1.145.0` back. Run that before `npm test` or `npm run check`.

The later product client is Vite and SolidJS, beside this verification table. Its board is a CSS perspective plane: Corp servers along the far edge, ice in columns toward the Runner. Each seat still sees only what the Comprehensive Rules allow. That client waits until the current table phase exits.
