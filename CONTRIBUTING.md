# Contributing

This is the match host and web table. It is part of [nhoople/netrunner](https://github.com/nhoople/netrunner); the git and release process is in that repo's [`docs/git-hygiene.md`](https://github.com/nhoople/netrunner/blob/main/docs/git-hygiene.md).

- **Scope:** the game plays through the pinned engine. Rules, card definitions, and rules text live in their own repositories; a rules fix goes to the engine and reaches the game through a pin bump.
- **Setup:** `npm install && npm run fetch-engine && npm run build:engine && npm run fetch-data`.
- **Before a pull request:** add or update a test in `src/*.test.ts`, then run `npm test`, `npm run typecheck`, `npm run typecheck:client`, `npm run build:client`, and `npm run check`. CI runs these as `test`.
- **What a seat sees:** follow the Comprehensive Rules on hidden and open information, and cite the rule in the PR.
- **Pins:** `data/engine-pin.json` and `data/cards-pin.json` name release tags, never `master`. A pin bump updates the project [pin table](https://github.com/nhoople/netrunner#readme) in the same pass.
