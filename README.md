# Netrunner game

Host for playing Android: Netrunner through the other three repositories. This repo does not redefine cards, rules text, or rules evaluation.

**Repo:** [github.com/nhoople/netrunner-game](https://github.com/nhoople/netrunner-game)

| Dependency | Pin | What this repo uses it for |
| --- | --- | --- |
| [netrunner-engine](https://github.com/nhoople/netrunner-engine) | [`data/engine-pin.json`](data/engine-pin.json) (`v1.142.2`) | Game state, legality, and effect evaluation |
| [netrunner-cards-data](https://github.com/nhoople/netrunner-cards-data) | [`data/cards-pin.json`](data/cards-pin.json) (`v1.142.2`) | Card definitions |
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

`npm run fetch-engine` clones engine tag `v1.142.2` into `deps/netrunner-engine`. Card and rules JSON are fetched by tag into `vendor/` and are not committed. `v26.03` is the current Comprehensive Rules release.

## Setup

Requires Node.js 20+.

```bash
npm run fetch-engine  # deps/netrunner-engine at v1.142.2
npm install
npm run build:engine
npm run fetch-data    # vendor/cr-data and vendor/cards-data
npm run check         # engine state + one card + one rule id
npm test              # seat views, chat rooms, concede
npm start             # http://127.0.0.1:8787
```

`npm start` serves a two-seat test table. Create a match and open the Corp and Runner links. The game uses the System Gateway learn-to-play decks. Table chat is on the page. Spectators are not given a link yet; their chat room is separate from the seats.

`npm run check` prints the engine pin, Comprehensive Rules version, rule `1.2.1`, the supported card count, and a description of a fresh game state.
