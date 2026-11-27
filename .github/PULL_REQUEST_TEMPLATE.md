## Summary

<!-- What changed and why (1–3 bullets). -->

## Proof

<!-- How the maintainer can see this working without reading code: a played match or the part of one this changes, a before-and-after screenshot or recording, or a test whose name states the behavior in plain words. Docs, tooling, or dependency-only PRs: `n/a — <reason>`. -->

## Review

<!-- For a code change: the `/code-review` level, what it found, and what was fixed or why not. Otherwise: `none — <reason>`. -->

## Found, not fixed

<!-- Each thing noticed that this PR does not change: what it is, where it went (issue, plan, or a fix-now session), and why. See "Findings" in https://github.com/nhoople/netrunner/blob/main/docs/how-we-work.md. Write `none` if nothing. -->

## What each seat sees

For a change to the table, the match protocol, or a view: which Comprehensive Rules node says who may see it (cite the number), or `n/a — <reason>`.

- [ ] No seat is shown information the CR hides from it, and none loses information the CR lets it see

## Tests

- [ ] A test covers the behavior (under `tests/`); an engine rules change is tested in the engine, not here
- [ ] `npm test`, `npm run typecheck`, `npm run typecheck:client`, `npm run build:client`, and `npm run check` pass

## Pins

- [ ] Unchanged
- [ ] `data/engine-pin.json` / `data/cards-pin.json` moved to a release tag (never `master`); the [pin table](https://github.com/nhoople/netrunner#readme) follows
