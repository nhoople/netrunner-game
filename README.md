# Netrunner game

Part of [nhoople/netrunner](https://github.com/nhoople/netrunner). These repositories stay separate and are consumed by release tag.

The multiplayer Android: Netrunner game. It plays through the other three repositories and does not redefine cards, rules text, or rules evaluation.

This repo is a local two-seat table for verifying the engine, plus the product client at `/play/`. Next is a Discord Activity (Phase 6 in the project [roadmap](https://github.com/nhoople/netrunner/blob/main/docs/roadmap.md)), with Discord as the account and the conversation.

**Repo:** [github.com/nhoople/netrunner-game](https://github.com/nhoople/netrunner-game)

| Dependency | Pin | What this repo uses it for |
| --- | --- | --- |
| [netrunner-engine](https://github.com/nhoople/netrunner-engine) | [`data/engine-pin.json`](data/engine-pin.json) | Game state, legality, and effect evaluation |
| [netrunner-cards-data](https://github.com/nhoople/netrunner-cards-data) | [`data/cards-pin.json`](data/cards-pin.json) | Card definitions |
| [netrunner-comprehensive-rules-data](https://github.com/nhoople/netrunner-comprehensive-rules-data) | [`data/cr-pin.json`](data/cr-pin.json) | Rules index and node text |

See [`NOTICE`](NOTICE). Code here is MIT. Vendored rules and card text stay reference material.

## Layout

Every folder in the repo has a row here. `tests/repo/layout.test.ts` fails on a folder this table leaves out, on a row for a folder that is gone, and on a test file outside a folder under `tests/`.

| Folder | What it holds |
| --- | --- |
| `src/` | The match host. The two entry points sit at the top: `server.ts` (`npm start`) and `check.ts` (`npm run check`) |
| `src/match/` | One match: applying intents, the snapshot each seat, spectator and log viewer receives, where each legal entry sits on the board, and the stops for automatic passing |
| `src/setup/` | How a match is dealt: the learn-to-play decks, submitted decks, and debug scenarios |
| `src/records/` | Match files on disk (a restart replays them) and the engine test fixture export |
| `src/cards/` | What a card shows: printed text, default printing code, and image link |
| `src/debug/` | The debug page's tools: board changes, the internal board and invariants, why not, and golden transcripts |
| `src/visibility/` | The visibility fuzz oracle. Test code: the server does not import it |
| `src/web/` | Which `public/` file an HTTP path serves |
| `client/` | The product client (Vite and SolidJS). `npm run build:client` writes it to `public/play/`, served at `/play/` |
| `client/src/` | The product client's board model and components |
| `public/` | The verification table's pages (`table.html` at `/`, `debug.html`, `log.html`), served as they are. Its paths are web addresses, so files here keep their places |
| `public/backs/` | Corp and Runner card backs |
| `tests/` | Every test, in the folders below. A test file directly in `tests/` fails the layout check |
| `tests/match/` | Tests for `src/match/` |
| `tests/setup/` | Tests for `src/setup/` |
| `tests/records/` | Tests for `src/records/` |
| `tests/cards/` | Tests for `src/cards/` |
| `tests/debug/` | Tests for `src/debug/` |
| `tests/visibility/` | The visibility fuzz and scenario sweeps: what each seat may see (CR 10.2.2a) |
| `tests/web/` | Tests for `src/web/` |
| `tests/client/` | Tests for `client/src/`, including the client lint rules |
| `tests/repo/` | Checks on the repository itself: the pins agree, this layout map, and test placement |
| `tests/browser/` | Playwright tests of `/play/` and the table pages. `fixture.ts` starts a server and a match; `screenshots.ts` saves the pictures |
| `tests/baselines/` | Baselines the tests compare against: the visibility fuzz's known leaks (shrink only) |
| `scripts/` | `fetch-engine.mjs`, `fetch-data.mjs`, and the visibility fuzz command (`npm run fuzz:visibility`) |
| `data/` | The three pin files. Match files go in `data/matches/` (not tracked) |
| `docs/` | [`legal-intents.md`](docs/legal-intents.md): every intent type and what it points at |
| `docs/proof/` | Screenshots that PRs link as proof |
| `.github/` | The PR template and Dependabot settings |
| `.github/workflows/` | CI and the PR body check |

Not tracked, so not in the table: `deps/netrunner-engine/` (the pinned engine, from `npm run fetch-engine`), `vendor/` (card and rules JSON at the pinned tags, from `npm run fetch-data`), `public/play/` (the built client), `data/matches/`, `test-results/`, `playwright-report/`, and `node_modules/`.

## Sibling checkouts

Keep the four checkouts as siblings:

```text
Documents/Netrunner/
  netrunner-comprehensive-rules-data/
  netrunner-cards-data/
  netrunner-engine/
  netrunner-game/          ← this repo
```

The versions are in the pin files above and the project [pin table](https://github.com/nhoople/netrunner#readme).

## Setup

Requires Node.js 26+. The setup, test and check commands are in [`AGENTS.md`](AGENTS.md), their one home, so this README does not repeat them.

`npm start` serves a two-seat test table at http://127.0.0.1:8787. Each match is written under `data/matches` (or `MATCH_DIR`) as the opening deal and the applied-intent log. A restart deals that opening and replays the log, and the same seat tokens still open it. The opening seed also seeds every later shuffle and random pick, and a card's id does not name the card. A match file written before that (record version 1) cannot be replayed and is left out. Create a match and open the Corp and Runner links. The spectator link watches the same match with both hands hidden, reads table chat, and speaks in a separate room. The log link shows the shared record and restores a position. The debug link shows both seat snapshots and the internal board, including facedown cards, and steps an engine golden transcript. A card a seat can see shows its Effect IR. Each snapshot reports how long `queryLegality` and the last `applyIntent` took. A match with no deck body uses the System Gateway learn-to-play starters. `{ "preset": "expanded" }` uses those starters plus the booster cards after the STOP HERE divider. A JSON body with `corp` and `runner` decks (`identityId` and `cards`) is checked with `deckbuildingReport` before the match is created (CR 1.4, CR 3.1.2). Format bans are not checked. Table chat is on the page.

`npm run check` prints the engine pin, Comprehensive Rules version, rule `1.2.1`, the supported card count, and a description of a fresh game state.

CI on pull requests and `master` fetches the pinned engine, cards, and rules, then runs the Prettier format check, lint, typecheck, the product client and browser test typechecks, the product client build, `npm test`, `npm run check`, and the browser smoke tests. The browser tests start the server themselves (`tests/browser/fixture.ts`) on a free port with an empty `MATCH_DIR`, and fail on a page error or a missing board part. They do not compare pictures. CI uploads the screenshots as the `browser-screenshots` artifact.

## Table against the engine checkout

`npm start` uses the clone from `npm run fetch-engine`. To try sibling engine edits on the table before a release, link that checkout and build it. The sibling needs its own `vendor/` (`npm run prepare-data` in `netrunner-engine`).

```bash
rm -rf deps/netrunner-engine
ln -s ../../netrunner-engine deps/netrunner-engine
npm run build --prefix ../netrunner-engine
npm start
```

Rebuild the engine after further edits, then refresh http://127.0.0.1:8787. `npm run fetch-engine` puts the pinned tag back. Run that before `npm test` or `npm run check`.

The product client is Vite and SolidJS in `client/`, beside this verification table. `npm run build:client` writes it to `public/play`, and the server serves that at `/play/`. It uses the same match protocol: a seat token, a snapshot, and intents. The board is a CSS perspective plane: Corp servers along the far edge, ice in columns toward the Runner. A seat still sees only what that snapshot includes (CR 10.2.2a). The verification table stays at `/`. Each legal entry carries a `group`, an `anchor`, an optional `target`, and one `default`; [`docs/legal-intents.md`](docs/legal-intents.md) lists every intent type and what it points at.
