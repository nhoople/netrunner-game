/**
 * Visibility fuzz (CR audit tool 1.7). See `visibility-fuzz.ts` for the
 * oracle, the hidden classes with their CR rules, and how titles are matched.
 *
 * The baseline `test/baselines/visibility-leaks.json` only shrinks: a leak it
 * does not list fails, and so does a listed leak this run no longer finds.
 * After fixing a leak, drop its entry (or rerun
 * `npm run fuzz:visibility -- --write-baseline` and check the diff only removes).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GameState } from "netrunner-engine";
import type { SeatSnapshot } from "./match.js";
import { createMatch } from "./match.js";
import {
  CI_FUZZ,
  checkSnapshot,
  hiddenFrom,
  leakKey,
  readBaseline,
  runFuzz,
  setupFor,
} from "./visibility-fuzz.js";

const none = new Set<string>();

function plantedState(): { state: GameState; facedown: string; handId: string } {
  const state = setupFor("learn_to_play", 7)();
  const [facedown, handId] = state.corp.hand;
  // Install one HQ card facedown in a remote root by hand.
  state.corp.hand = state.corp.hand.filter((id) => id !== facedown);
  state.cards[facedown!]!.zone = "server:remote-1:root";
  state.cards[facedown!]!.faceup = false;
  state.cards[facedown!]!.rezzed = false;
  return { state, facedown: facedown!, handId: handId! };
}

test("the oracle hides hands, decks and facedown cards by seat (CR 10.2.2a, CR 4.1.5, CR 1.21.1)", () => {
  const { state, facedown, handId } = plantedState();
  const runner = hiddenFrom(state, "runner");
  const corp = hiddenFrom(state, "corp");
  const spectator = hiddenFrom(state, "spectator");
  assert.equal(runner.get(handId)?.cls, "hand");
  assert.equal(runner.get(facedown)?.cls, "facedown_installed");
  assert.equal(corp.has(handId), false);
  assert.equal(corp.has(facedown), false, "the Corp may look at its facedown cards (CR 1.21.2a)");
  assert.equal(corp.get(state.corp.deck[0]!)?.cls, "deck", "a deck is hidden from its owner too (CR 4.1.5)");
  assert.equal(spectator.get(handId)?.cls, "hand");
  assert.equal(spectator.get(state.runner.hand[0]!)?.cls, "hand");
  assert.equal(spectator.get(facedown)?.cls, "facedown_installed");
  state.cards[facedown]!.lookedBy = "runner";
  assert.equal(hiddenFrom(state, "runner").has(facedown), false, "a look opens the card to that seat (CR 1.21.2)");
  assert.equal(hiddenFrom(state, "spectator").has(facedown), true, "but not to the spectator");
});

test("the checker finds planted ids and linked titles, and skips open copies", () => {
  const { state, facedown, handId } = plantedState();
  const title = state.cards[facedown]!.title;
  const snapshot = {
    view: {
      run: { accessCandidates: [handId] },
      servers: [{ root: [{ id: facedown, title }] }],
    },
    glossary: { [facedown]: { title } },
    log: [{ summary: `Corp installs ${state.cards[handId]!.title}` }],
  } as unknown as SeatSnapshot;
  const { leaks } = checkSnapshot("runner", state, snapshot, null, none, new Set());
  const keys = new Set(leaks.map(leakKey));
  assert.ok(keys.has("runner id hand view.run.accessCandidates[]"), [...keys].join("\n"));
  assert.ok(keys.has("runner title facedown_installed view.servers[].root[].title"), [...keys].join("\n"));
  assert.ok(keys.has("runner title facedown_installed glossary.{id}.title"), [...keys].join("\n"));
  // The same title on an open copy is not a leak.
  const open = Object.values(state.cards).find((card) => card.side === "corp" && card.type !== "identity" && card.id !== facedown);
  state.corp.deck = state.corp.deck.filter((id) => id !== open!.id);
  state.corp.hand = state.corp.hand.filter((id) => id !== open!.id);
  state.corp.discardPile.push(open!.id);
  open!.zone = "corp:archives";
  open!.faceup = true;
  const copy = { view: { note: open!.title } } as unknown as SeatSnapshot;
  const sameTitle = checkSnapshot("runner", state, copy, null, none, new Set()).leaks;
  assert.deepEqual(sameTitle, []);
});

test("the opening snapshots show no hidden card", () => {
  const match = createMatch({ setup: setupFor("learn_to_play", 1) });
  const state = (match as unknown as { state: GameState }).state;
  for (const viewer of ["corp", "runner", "spectator"] as const) {
    const snapshot = match.snapshotForRole(viewer);
    assert.deepEqual(checkSnapshot(viewer, state, snapshot, null, none, new Set()).leaks, [], viewer);
  }
});

test("seeded matches leak nothing the baseline does not list, and the baseline only shrinks", async () => {
  const baseline = readBaseline();
  assert.deepEqual(
    { seeds: baseline.seeds, steps: baseline.steps, formats: baseline.formats },
    { seeds: CI_FUZZ.seeds, steps: CI_FUZZ.steps, formats: CI_FUZZ.formats },
    "the baseline was recorded with a different CI run",
  );
  const run = await runFuzz(CI_FUZZ.formats, CI_FUZZ.seeds, CI_FUZZ.steps);
  const crashes = run.results.filter((result) => result.ended === "crash");
  assert.deepEqual(crashes.map((r) => `${r.format}#${r.seed}@${r.steps}: ${r.detail}`), []);
  const found = new Set(run.leaks.keys());
  const recorded = new Set(baseline.leaks.map(leakKey));
  const added = [...found].filter((key) => !recorded.has(key)).map((key) => {
    const leak = run.leaks.get(key)!;
    return `${key} (${leak.format}#${leak.seed}@${leak.step} ${leak.card}: ${JSON.stringify(leak.value)})`;
  });
  const gone = [...recorded].filter((key) => !found.has(key));
  assert.deepEqual(added, [], "new visibility leaks");
  assert.deepEqual(gone, [], "fixed leaks still in test/baselines/visibility-leaks.json: remove them");
  const steps = run.results.reduce((sum, result) => sum + result.steps, 0);
  console.log(`visibility fuzz: ${run.results.length} matches, ${steps} steps, ${run.ms} ms, ${found.size} baselined leaks`);
});
