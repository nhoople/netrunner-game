/**
 * Pending abilities and choices from hidden cards in each seat's snapshot
 * (CR audit program, fix-now session FX-view, 2026-11-21).
 *
 * A facedown card in Archives is hidden from the Runner (CR 4.4.6c,
 * CR 10.2.2a), and the Runner cannot learn it (CR 10.2.2b). Decided
 * 2026-11-21: a facedown Subliminal Messaging's turn-begin offer is private
 * to the Corp until it reveals the card; revealing is public (CR 1.21.3).
 * So the Runner's and the spectator's snapshots carry no pending ability,
 * choice or log line from it, and the fuzz oracle watches every snapshot.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GameState } from "netrunner-engine";
import { createMatch, forgetMatch, type SeatSnapshot } from "../../src/match/match.js";
import { checkScenario, scenarioSetup } from "../../src/setup/scenario.js";
import { VisibilityWatch } from "../../src/visibility/visibility-fuzz.js";

const CORP_DECK = ["hedge-fund", "hedge-fund", "hedge-fund", "hedge-fund", "hedge-fund"];
const RUNNER_DECK = ["sure-gamble", "sure-gamble", "sure-gamble", "sure-gamble", "sure-gamble"];

/** The Corp's turn begins after a Runner turn with no run; Archives holds a facedown Subliminal Messaging. */
function subliminalTurn(faceup = false): VisibilityWatch {
  const checked = checkScenario({
    turn: "corp",
    start: "turn",
    turnNumber: 3,
    corp: {
      identity: "the-syndicate-profit-over-principle",
      hand: ["hedge-fund"],
      deck: CORP_DECK,
      ...(faceup ? { discard: ["subliminal-messaging"] } : { discardFacedown: ["subliminal-messaging"] }),
    },
    runner: { identity: "the-catalyst-convention-breaker", hand: ["sure-gamble"], deck: RUNNER_DECK },
  });
  if (!checked.ok) throw new Error(checked.error);
  const setup: () => GameState = scenarioSetup(checked.scenario, 7);
  return new VisibilityWatch(createMatch({ setup, scenario: true }), "startup", 7);
}

function subliminalId(w: VisibilityWatch): string {
  const found = Object.values(w.state.cards).find((card) => card.title === "Subliminal Messaging");
  assert.ok(found, "Subliminal Messaging is in the match");
  return found.id;
}

function view(snapshot: SeatSnapshot): Record<string, unknown> {
  return snapshot.view as Record<string, unknown>;
}

async function pickOffer(w: VisibilityWatch, pattern: RegExp): Promise<void> {
  const entry = w.snaps.corp.legal.find((item) => pattern.test(item.label));
  assert.ok(entry, `the Corp is offered ${pattern}: ${w.snaps.corp.legal.map((e) => e.label).join(" | ")}`);
  assert.equal(await w.submit("corp", entry.intent), true);
}

test("the Runner's and the spectator's snapshots carry no pending ability, choice or log line from a facedown Subliminal Messaging (CR 10.2.2a, 10.2.2b)", async () => {
  const w = subliminalTurn();
  const id = subliminalId(w);
  assert.equal(w.state.pendingChoice?.sourceId, id, "the Corp is asked");
  assert.ok(
    w.snaps.corp.legal.some((entry) => /Reveal Subliminal Messaging/.test(entry.label)),
    "the Corp sees its own offer (CR 4.4.6c)",
  );
  for (const viewer of ["runner", "spectator"] as const) {
    const text = JSON.stringify(w.snaps[viewer]);
    assert.doesNotMatch(text, /Subliminal/, `${viewer} snapshot names the card`);
    assert.ok(!text.includes(id), `${viewer} snapshot names the card's id`);
  }
  const runner = view(w.snaps.runner);
  assert.equal(runner.pendingChoice, null, "the Runner's view has no choice from it");
  assert.deepEqual(runner.pendingAbilities, [], "the Runner's view has no pending ability from it");
  assert.equal(runner.pendingEffectContinuation, null);
  forgetMatch(w.match.id);
  assert.deepEqual(w.leaks, [], "the fuzz oracle finds no leak");
});

test("when the Corp declines a facedown Subliminal Messaging, the Runner's and the spectator's logs gain no line about it (CR 10.2.2a)", async () => {
  const w = subliminalTurn();
  const runnerBefore = w.snaps.runner.log.length;
  const spectatorBefore = w.snaps.spectator.log.length;
  await pickOffer(w, /Decline$/);
  assert.equal(w.snaps.runner.log.length, runnerBefore);
  assert.equal(w.snaps.spectator.log.length, spectatorBefore);
  assert.ok(
    w.snaps.corp.log.some((entry) => /Decline/.test(entry.summary)),
    "the Corp's own log has its pick",
  );
  forgetMatch(w.match.id);
  assert.deepEqual(w.leaks, [], "the fuzz oracle finds no leak");
});

test("when the Corp reveals a facedown Subliminal Messaging, every seat's log shows the reveal (CR 1.21.3)", async () => {
  const w = subliminalTurn();
  await pickOffer(w, /Reveal Subliminal Messaging/);
  for (const viewer of ["runner", "spectator"] as const) {
    const last = w.snaps[viewer].log.at(-1)?.summary ?? "";
    assert.match(last, /reveals Subliminal Messaging/, `${viewer} sees the reveal`);
  }
  forgetMatch(w.match.id);
});

test("a faceup Subliminal Messaging's offer is open: the Runner's snapshot shows the Corp is asked (CR 4.4.6c, 10.2.3a)", async () => {
  const w = subliminalTurn(true);
  const runner = view(w.snaps.runner);
  assert.ok(runner.pendingChoice, "the Runner sees the open choice");
  forgetMatch(w.match.id);
});
