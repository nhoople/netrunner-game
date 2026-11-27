# Agent notes

This is the match host and web table of the Netrunner project. Full instructions for coding agents are in the project repo's [`CLAUDE.md`](https://github.com/nhoople/netrunner/blob/main/CLAUDE.md), and the git and release process is in [`docs/git-hygiene.md`](https://github.com/nhoople/netrunner/blob/main/docs/git-hygiene.md).

- The four repositories stay separate: `netrunner-engine`, `netrunner-cards-data`, `netrunner-comprehensive-rules-data`, and `netrunner-game`. The game and the engine consume the others by release tag, not by `master` and not as workspace packages. Do not recommend merging them, an npm workspace, or Turborepo unless asked to change that release model.
- The game plays through the pinned engine and does not redefine cards or rules. Do not hide information a seat may see, or reveal what it may not.
- Setup: `npm run fetch-engine && npm install && npm run build:engine && npm run fetch-data`, in that order: `package.json` installs the engine from `deps/netrunner-engine`, which `fetch-engine` creates.
- Before committing, add or update a test for the behavior and run `npm run format` and `npm test` (CI also runs `format:check`, `lint`, `typecheck`, `typecheck:client`, `typecheck:browser`, `knip`, `build:client`, `check`, and `test:browser`). Browser tests get a server and match from `browser/fixture.ts` and save screenshots with `browser/screenshots.ts`.
- Work on a `claude/<descriptive-name>` branch and merge by pull request; `master` takes no direct push.
