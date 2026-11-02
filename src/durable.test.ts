import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { learnToPlaySetup } from "./decks.js";
import { loadDurableMatches, saveDurableMatch } from "./durable.js";
import { createMatch, type SeatSnapshot } from "./match.js";

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "netrunner-match-"));
  dirs.push(dir);
  return dir;
}

function handTitles(snapshot: SeatSnapshot): string[] {
  const view = snapshot.view as { self?: { hand?: string[] } };
  const hand = view.self?.hand ?? [];
  return hand.map((id) => snapshot.glossary[id]?.title ?? id);
}

describe("durable matches", () => {
  it("reloads the same seat snapshot from the applied-intent log", async () => {
    const dir = tempDir();
    const opening = { seed: 7, preset: "starter" as const };
    const match = createMatch({
      id: "keep-hand",
      setup: () => learnToPlaySetup(opening.seed, opening.preset),
    });
    await match.submit(match.tokens.corp, "keep", { type: "keep_starting_hand" });
    await match.postChat("corp", "table", "shuffled");
    const before = match.snapshotForToken(match.tokens.corp);
    saveDurableMatch(dir, match, opening);

    const [loaded] = loadDurableMatches(dir);
    assert.ok(loaded);
    const after = loaded.snapshotForToken(loaded.tokens.corp);
    assert.deepEqual(handTitles(after), handTitles(before));
    assert.equal(after.log.at(-1)?.summary, before.log.at(-1)?.summary);
    assert.equal(after.chat.at(-1)?.text, "shuffled");
    assert.equal(after.viewer, "corp");
    const runner = JSON.stringify(loaded.snapshotForToken(loaded.tokens.runner));
    for (const title of handTitles(after)) assert.equal(runner.includes(title), false);
  });

  it("drops intents the log page rewound before the file was written", async () => {
    const dir = tempDir();
    const opening = { seed: 9, preset: "starter" as const };
    const match = createMatch({
      id: "rewound",
      setup: () => learnToPlaySetup(opening.seed),
      onRecord: (current) => saveDurableMatch(dir, current, opening),
    });
    await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
    await match.submit(match.tokens.runner, "keep-runner", { type: "keep_starting_hand" });
    await match.seek(match.tokens.log, 1);
    const [loaded] = loadDurableMatches(dir);
    assert.ok(loaded);
    assert.equal(loaded.gameLog().length, 1);
    assert.equal(loaded?.gameLog()[0]?.summary.includes("Corp"), true);
    assert.equal(loaded?.snapshotForToken(loaded.tokens.runner).log.some((entry) => entry.summary.includes("Runner")), false);
  });

  it("skips a file that is not a match record", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "notes.json"), "{not json");
    writeFileSync(join(dir, "other.json"), JSON.stringify({ v: 1, id: "../escape" }));
    assert.deepEqual(loadDurableMatches(dir), []);
  });
});
