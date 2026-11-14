/**
 * Start from a position (verification table V3).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { GameState } from "netrunner-engine";
import { learnToPlaySetup, matchSetupFromBody, setupForOpening } from "./decks.js";
import { loadDurableMatches, saveDurableMatch } from "./durable.js";
import { createMatch, forgetMatch, type Match } from "./match.js";
import { checkScenario, scenarioRequest, scenarioSetup, type Scenario } from "./scenario.js";
import { checkSnapshot, leakKey, playMatch, readBaseline } from "./visibility-fuzz.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SAMPLE = {
  turn: "runner",
  start: "action",
  turnNumber: 2,
  corp: {
    identity: "the-syndicate-profit-over-principle",
    credits: 7,
    hand: ["hedge-fund", "ice-wall"],
    deck: ["hedge-fund", "ice-wall", "hedge-fund", "palisade", "tithe"],
    discardFacedown: ["offworld-office"],
    installed: [
      { card: "tithe", server: "hq", rezzed: true },
      { card: "ice-wall", server: "hq" },
      { card: "palisade", server: "remote-1" },
      { card: "offworld-office", server: "remote-1", advancements: 2 },
    ],
  },
  runner: {
    identity: "the-catalyst-convention-breaker",
    credits: 6,
    clicks: 4,
    hand: ["sure-gamble", "jailbreak"],
    deck: ["sure-gamble", "jailbreak", "sure-gamble", "creative-commission"],
    discard: ["vrcation"],
    installed: [{ card: "cleaver" }],
  },
};

function sample(): Scenario {
  const checked = checkScenario(structuredClone(SAMPLE));
  if (!checked.ok) throw new Error(checked.error);
  return checked.scenario;
}

function rawState(match: Match): GameState {
  return (match as unknown as { state: GameState }).state;
}

function titles(state: GameState, ids: readonly string[]): string[] {
  return ids.map((id) => state.cards[id]?.title ?? id);
}

test("a scenario builds the listed position", () => {
  const match = createMatch({ setup: scenarioSetup(sample(), 11), scenario: true });
  const state = rawState(match);
  assert.equal(state.activeSide, "runner");
  assert.equal(state.turnNumber, 2);
  assert.equal(state.timingKey, "runner.takeAction");
  assert.equal(state.runner.clicks, 4);
  assert.equal(state.runner.credits, 6);
  assert.equal(state.corp.credits, 7);
  assert.deepEqual(titles(state, state.servers.hq.ice), ["Tithe", "Ice Wall"], "outermost first (CR 6.4.1)");
  const [tithe, wall] = state.servers.hq.ice.map((id) => state.cards[id]!);
  assert.equal(tithe!.rezzed && tithe!.faceup, true);
  assert.equal(wall!.rezzed || wall!.faceup, false);
  const remote = state.servers["remote-1" as keyof GameState["servers"]]!;
  assert.deepEqual(titles(state, remote.root), ["Offworld Office"]);
  assert.equal(state.cards[remote.root[0]!]!.advancementCounters, 2);
  assert.equal(state.nextRemoteNumber, 2);
  assert.deepEqual(titles(state, state.corp.deck), ["Hedge Fund", "Ice Wall", "Hedge Fund", "Palisade", "Tithe"]);
  assert.deepEqual(titles(state, state.runner.installed), ["Cleaver"]);
  assert.equal(state.cards[state.corp.discardPile[0]!]!.faceup, false);
  assert.equal(state.cards[state.runner.discardPile[0]!]!.faceup, true);
  // Card ids say nothing about the card (CR 1.21.1).
  for (const id of [...remote.root, ...state.corp.hand]) assert.match(id, /^c_[0-9a-z]{6}$/);
  assert.equal(match.snapshotForRole("runner").scenario, true);
  forgetMatch(match.id);
});

test("a scenario that starts at the turn lets the engine grant clicks and the Corp draw", () => {
  const scenario = { ...sample(), turn: "corp" as const, start: "turn" as const };
  const match = createMatch({ setup: scenarioSetup(scenario, 3) });
  const state = rawState(match);
  assert.equal(state.activeSide, "corp");
  assert.equal(state.corp.clicks, 3);
  assert.deepEqual(titles(state, state.corp.hand), ["Hedge Fund", "Ice Wall", "Hedge Fund"], "drew the top card");
  forgetMatch(match.id);
});

test("a scenario names only real cards in the right places", () => {
  const bad = (change: (body: typeof SAMPLE) => void, pattern: RegExp) => {
    const body = structuredClone(SAMPLE);
    change(body);
    const checked = checkScenario(body);
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.match(checked.error, pattern);
  };
  bad((b) => (b.corp.hand = ["not-a-card"]), /unknown card not-a-card/);
  bad((b) => (b.corp.hand = ["sure-gamble"]), /not a corp card/);
  bad((b) => (b.runner.identity = "sure-gamble"), /not an identity/);
  bad((b) => b.corp.installed.push({ card: "offworld-office", server: "hq" }), /CR 3\.6\.1/);
  bad((b) => b.corp.installed.push({ card: "nico-campaign", server: "remote-1" }), /CR 4\.6\.6e/);
  bad((b) => b.corp.installed.push({ card: "hedge-fund", server: "remote-2" }), /operation is not installed/);
  bad((b) => b.corp.installed.push({ card: "palisade", server: "remote-2", slot: "root" } as never), /not installed in a root/);
  bad((b) => b.corp.installed.push({ card: "tithe", server: "nowhere" }), /server must be/);
  bad((b) => b.runner.installed.push({ card: "sure-gamble" }), /event is not installed/);
  bad((b) => (b.turn = "both"), /turn must be/);
});

test("a scenario starts only from a debug token, and never through the deck route", () => {
  const live = createMatch({ setup: () => learnToPlaySetup(1) });
  const body = (debugToken: string) => ({ debugToken, scenario: structuredClone(SAMPLE) });
  for (const token of [live.tokens.corp, live.tokens.runner, live.tokens.spectator, live.tokens.log, "", "nope"]) {
    const refused = scenarioRequest(body(token), 1);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.status, 403);
  }
  const accepted = scenarioRequest({ ...body(live.tokens.debug), seed: 42 }, 1);
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.seed, 42);
  // The deck route takes no scenario, so it is never format-checked or given a product seat there.
  const viaDecks = matchSetupFromBody({ scenario: SAMPLE }, 1);
  assert.equal(viaDecks.ok, false);
  if (!viaDecks.ok) assert.equal(viaDecks.status, 400);
  forgetMatch(live.id);
});

test("a scenario match restarts to the same position", async () => {
  const dir = mkdtempSync(join(tmpdir(), "netrunner-scenario-"));
  dirs.push(dir);
  const opening = { seed: 5, scenario: sample() };
  const match = createMatch({ id: "scenario-restart", setup: setupForOpening(opening), scenario: true });
  for (let step = 0; step < 3; step++) {
    const both = match.snapshotForRole("debug").debug!;
    const seat = both.corp.legal.length ? "corp" : "runner";
    const choice = both[seat].legal.find((entry) => entry.intent.type === "basic_draw") ?? both[seat].legal[0]!;
    await match.submit(match.tokens.debug, `step-${step}`, choice.intent, seat);
  }
  const before = match.snapshotForRole("debug");
  saveDurableMatch(dir, match, opening);
  forgetMatch(match.id);
  const [loaded] = loadDurableMatches(dir);
  assert.ok(loaded);
  assert.equal(loaded.scenario, true);
  const after = loaded.snapshotForRole("debug");
  assert.deepEqual(after.debug!.board, before.debug!.board);
  assert.deepEqual(after.log, before.log);
  assert.equal(after.scenario, true);
  forgetMatch(loaded.id);
});

test("a scenario match's seat links show no hidden card at the start (CR 1.21.1, CR 10.2.2a)", () => {
  const match = createMatch({ setup: scenarioSetup(sample(), 9), scenario: true });
  const state = rawState(match);
  const none = new Set<string>();
  for (const viewer of ["corp", "runner", "spectator"] as const) {
    const snapshot = match.snapshotForRole(viewer);
    assert.deepEqual(checkSnapshot(viewer, state, snapshot, null, none, new Set()).leaks, [], viewer);
  }
  // The facedown Ice Wall, remote cards, and facedown Archives card stay hidden from the Runner.
  const runner = JSON.stringify(match.snapshotForRole("runner"));
  for (const title of ["Palisade", "Offworld Office"]) assert.equal(runner.includes(title), false, title);
  forgetMatch(match.id);
});

test("the visibility fuzz runs over a scenario match through both drivers", async () => {
  const recorded = new Set(readBaseline().leaks.map(leakKey));
  for (const driver of ["seat", "debug"] as const) {
    const result = await playMatch("startup", 13, 60, driver, scenarioSetup(sample(), 13));
    assert.notEqual(result.ended, "crash", result.detail ?? "");
    assert.ok(result.steps > 0);
    const added = result.leaks.map(leakKey).filter((key) => !recorded.has(key));
    assert.deepEqual(added, [], driver);
  }
});

test("a run approaches the first listed ice first (CR 6.4.1)", async () => {
  const match = createMatch({ setup: scenarioSetup(sample(), 21), scenario: true });
  const runHq = match.snapshotForRole("debug").debug!.runner.legal.find((entry) => entry.label.startsWith("Run HQ"));
  assert.ok(runHq);
  await match.submit(match.tokens.debug, "run-hq", runHq.intent, "runner");
  const approached = rawState(match).log.find((line) => line.startsWith("Approach ice "));
  assert.match(approached ?? "", /^Approach ice Tithe at position 0/);
  forgetMatch(match.id);
});

test("a scenario opening breaks no engine invariant (V4)", () => {
  const match = createMatch({ setup: scenarioSetup(sample(), 17), scenario: true });
  assert.deepEqual(match.snapshotForRole("debug").debug!.invariants.problems, []);
  forgetMatch(match.id);
});
