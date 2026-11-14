/**
 * Export a match as an engine test fixture (verification table V5).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { GameState } from "netrunner-engine";
import { learnToPlaySetup, setupForOpening } from "./decks.js";
import { exportMatch, exportRequest, replayFixture, stateHash, type MatchFixture } from "./export.js";
import { createMatch, forgetMatch, type Match } from "./match.js";
import { checkScenario } from "./scenario.js";

async function play(match: Match, steps: number): Promise<void> {
  for (let step = 0; step < steps; step++) {
    if (match.result().done) return;
    const both = match.snapshotForRole("debug").debug!;
    const seat = both.corp.legal.length ? "corp" : "runner";
    const legal = both[seat].legal;
    if (!legal.length) return;
    await match.submit(match.tokens.debug, `play-${step}`, legal[(step * 5) % legal.length]!.intent, seat);
  }
}

function rawState(match: Match): GameState {
  return (match as unknown as { state: GameState }).state;
}

test("an exported match replays from its JSON to the same final state", async () => {
  const opening = { seed: 8, preset: "starter" as const };
  const match = createMatch({ setup: setupForOpening(opening), opening });
  await play(match, 60);
  const fixture = JSON.parse(JSON.stringify(exportMatch(match, new Date("2026-11-14T00:00:00Z")))) as MatchFixture;
  assert.equal(fixture.format, "netrunner-game-export");
  assert.equal(fixture.version, 1);
  assert.deepEqual(fixture.source.opening, opening);
  const pinned = JSON.parse(readFileSync(new URL("../data/engine-pin.json", import.meta.url), "utf8")) as { tag: string };
  assert.equal(fixture.source.engine, pinned.tag);
  // The log holds only the seats' intents; the trace also has the windows the host passed.
  const logged = match.gameLog().filter((entry) => entry.ok && entry.kind === "intent").length;
  assert.equal(fixture.steps.filter((step) => step.logSeq !== null).length, logged);
  assert.ok(fixture.steps.length >= logged);
  const replayed = replayFixture(fixture.opening, fixture.steps);
  assert.equal(stateHash(replayed.state), fixture.final.stateHash);
  assert.equal(fixture.final.stateHash, stateHash(rawState(match)));
  assert.deepEqual(replayed.failures, fixture.failures);
  assert.equal(fixture.final.timingKey, rawState(match).timingKey);
  forgetMatch(match.id);
});

test("an export lists invariant failures in the playout seed shape", async () => {
  const match = createMatch({
    setup: () => {
      const state = learnToPlaySetup(5);
      state.cards[state.runner.hand[0]!]!.rezzed = true; // CR 8.1.4f
      return state;
    },
  });
  await play(match, 3);
  const fixture = exportMatch(match);
  assert.deepEqual(
    fixture.failures.map(({ code, step }) => ({ code, step })),
    [{ code: "RUNNER_CARD_REZZED", step: -1 }],
  );
  assert.equal(typeof fixture.failures[0]!.detail, "string");
  assert.deepEqual(fixture.final.invariants, ["RUNNER_CARD_REZZED"]);
  assert.equal(fixture.source.opening, null);
  forgetMatch(match.id);
});

test("a scenario match exports with its scenario as the opening", async () => {
  const checked = checkScenario({
    turn: "runner",
    start: "action",
    corp: {
      identity: "the-syndicate-profit-over-principle",
      deck: ["hedge-fund", "hedge-fund"],
      installed: [{ card: "tithe", server: "hq", rezzed: true }],
    },
    runner: { identity: "the-catalyst-convention-breaker", hand: ["sure-gamble"], deck: ["sure-gamble"] },
  });
  assert.ok(checked.ok);
  const opening = { seed: 3, scenario: checked.scenario };
  const match = createMatch({ setup: setupForOpening(opening), scenario: true, opening });
  await play(match, 8);
  const fixture = exportMatch(match);
  assert.deepEqual(fixture.source.opening, opening);
  assert.equal(stateHash(replayFixture(fixture.opening, fixture.steps).state), fixture.final.stateHash);
  forgetMatch(match.id);
});

test("a conceded match exports the steps before the concede", async () => {
  const match = createMatch({ setup: () => learnToPlaySetup(2) });
  await play(match, 4);
  const before = stateHash(rawState(match));
  await match.concede(match.tokens.corp);
  const fixture = exportMatch(match);
  assert.equal(fixture.source.hostEnd, "concede");
  assert.equal(fixture.final.stateHash, before);
  assert.equal(fixture.final.done, false, "the concede is not an engine action");
  forgetMatch(match.id);
});

test("only the debug token exports a match", () => {
  const match = createMatch({ setup: () => learnToPlaySetup(1) });
  for (const token of [match.tokens.corp, match.tokens.runner, match.tokens.spectator, match.tokens.log, "", "nope"]) {
    const refused = exportRequest(token);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.status, 403);
  }
  const allowed = exportRequest(match.tokens.debug);
  assert.equal(allowed.ok && allowed.match.id, match.id);
  forgetMatch(match.id);
});
