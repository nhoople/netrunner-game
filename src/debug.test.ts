import assert from "node:assert/strict";
import { test } from "node:test";
import { learnToPlaySetup } from "./decks.js";
import type { GameState } from "netrunner-engine";
import { openGolden, stepGolden } from "./golden.js";
import { invariantReport } from "./inspect.js";
import { printedTextFor } from "./printed.js";
import { createMatch, forgetMatch, MatchError } from "./match.js";
import { CI_FUZZ, leakKey, playMatch, readBaseline } from "./visibility-fuzz.js";

function hedgeInHand() {
  return () => {
    const state = learnToPlaySetup(1);
    const id = [...state.corp.hand, ...state.corp.deck].find(
      (cardId) => state.cards[cardId]?.defId === "hedge-fund",
    );
    if (!id) throw new Error("expected Hedge Fund");
    state.corp.deck = state.corp.deck.filter((cardId) => cardId !== id);
    if (!state.corp.hand.includes(id)) state.corp.hand.push(id);
    state.cards[id]!.zone = "corp:hq";
    return state;
  };
}

test("a visible card's Effect IR is op and kind, and a hidden card is not", () => {
  const match = createMatch({ setup: hedgeInHand() });
  const corp = match.snapshotForToken(match.tokens.corp);
  const hedge = Object.entries(corp.glossary).find(([, card]) => card.title === "Hedge Fund");
  assert.ok(hedge);
  assert.equal(hedge[1].ir?.some((line) => line.op === "do" && line.kind === "gain_credits"), true);
  const runner = match.snapshotForToken(match.tokens.runner);
  assert.equal(runner.glossary[hedge[0]], undefined);
  assert.equal(JSON.stringify(runner).includes("Hedge Fund"), false);
});

test("a visible card carries its printed text beside its Effect IR, and a hidden card does not (V2, CR 1.2.1)", () => {
  const match = createMatch({ setup: hedgeInHand() });
  const corp = match.snapshotForToken(match.tokens.corp);
  const hedge = Object.entries(corp.glossary).find(([, card]) => card.title === "Hedge Fund");
  assert.ok(hedge);
  assert.equal(hedge[1].printed, "Gain 9[credit].");
  assert.ok(hedge[1].ir?.length);
  // Nothing at the cards pin is marked unsupported for Hedge Fund.
  assert.equal(hedge[1].unsupported, undefined);
  const runner = match.snapshotForToken(match.tokens.runner);
  assert.equal(runner.glossary[hedge[0]], undefined);
  assert.equal(JSON.stringify(runner).includes("Hedge Fund"), false);
  assert.equal(printedTextFor("hedge-fund"), "Gain 9[credit].");
  assert.equal(printedTextFor("../cards-pin"), undefined);
  assert.equal(printedTextFor("not-a-card"), undefined);
});

test("a card's unsupported note reaches the glossary", () => {
  const match = createMatch({
    setup: () => {
      const state = hedgeInHand()();
      const id = state.corp.hand.find((cardId) => state.cards[cardId]?.defId === "hedge-fund")!;
      (state.cards[id] as { unsupported?: string[] }).unsupported = ["planted clause"];
      return state;
    },
  });
  const corp = match.snapshotForToken(match.tokens.corp);
  const hedge = Object.values(corp.glossary).find((card) => card.title === "Hedge Fund");
  assert.deepEqual(hedge?.unsupported, ["planted clause"]);
  forgetMatch(match.id);
});

test("the debug view shows both seats and a facedown deck card the seat cannot see", () => {
  const match = createMatch({ setup: () => learnToPlaySetup(2) });
  const debug = match.snapshotForToken(match.tokens.debug);
  assert.equal(debug.viewer, "debug");
  assert.equal(debug.debug?.corp.viewer, "corp");
  assert.equal(debug.debug?.runner.viewer, "runner");
  const hidden = debug.debug?.board.runner.deck[0];
  assert.ok(hidden?.title);
  const corp = match.snapshotForToken(match.tokens.corp);
  assert.equal(JSON.stringify(corp).includes(hidden!.title!), false);
  assert.equal(typeof corp.timings.queryLegalityMs, "number");
  assert.equal(corp.timings.applyIntentMs, null);
  assert.equal(corp.debug, undefined);
});

test("a golden transcript steps forward and back through its intents", () => {
  const opened = openGolden("ice-etr-failure");
  assert.ok(opened);
  assert.equal(opened.position, 0);
  assert.equal(opened.intent, null);
  assert.ok(opened.total > 1);
  const forward = stepGolden(opened.id, 1);
  assert.equal(forward?.position, 1);
  assert.ok(forward?.intent);
  assert.equal(typeof forward?.applyIntentMs, "number");
  const back = stepGolden(opened.id, -1);
  assert.equal(back?.position, 0);
  assert.equal(back?.intent, null);
  assert.equal(openGolden("not-a-golden"), undefined);
});

test("the debug page plays both seats on the live match (verification table V1)", async () => {
  const match = createMatch({ setup: () => learnToPlaySetup(3) });
  const first = match.snapshotForToken(match.tokens.debug).debug!;
  const actor = first.corp.legal.length > 0 ? "corp" : "runner";
  const other = actor === "corp" ? "runner" : "corp";
  const entry = first[actor].legal[0]!;
  // Acting for the seat without priority is refused like a seat link would be.
  await assert.rejects(match.submit(match.tokens.debug, "wrong-seat", entry.intent, other), MatchError);
  // The debug token must name the seat it acts for.
  await assert.rejects(match.submit(match.tokens.debug, "no-seat", entry.intent), /Name the seat/);
  // A seat link may not act for the other seat.
  await assert.rejects(match.submit(match.tokens[other], "borrowed", entry.intent, actor), /only for itself/);
  const reply = await match.submit(match.tokens.debug, "debug-1", entry.intent, actor);
  assert.equal(reply.viewer, "debug");
  assert.ok(reply.debug);
  const applied = match.gameLog().filter((line) => line.ok);
  assert.equal(applied.at(-1)?.seat, actor);
  assert.equal(applied.at(-1)?.intentId, "debug-1");
  // Both seats keep acting from the one page until each has moved.
  const seen = new Set<string>([actor]);
  for (let step = 0; step < 40 && seen.size < 2; step++) {
    const both = match.snapshotForToken(match.tokens.debug).debug!;
    const seat = both.corp.legal.length > 0 ? "corp" : "runner";
    const next = both[seat].legal[0];
    if (!next) break;
    await match.submit(match.tokens.debug, `debug-step-${step}`, next.intent, seat);
    seen.add(seat);
  }
  assert.deepEqual([...seen].sort(), ["corp", "runner"]);
  forgetMatch(match.id);
});

test("seat links leak nothing new when the debug page plays both seats", async () => {
  const recorded = new Set(readBaseline().leaks.map(leakKey));
  // One CI seed per format keeps this short; the seat-driven fuzz covers the rest.
  const seed = CI_FUZZ.seeds[0]!;
  for (const format of CI_FUZZ.formats) {
    const result = await playMatch(format, seed, CI_FUZZ.steps, "debug");
    assert.notEqual(result.ended, "crash", result.detail ?? "");
    assert.ok(result.steps > 0);
    const added = result.leaks.map(leakKey).filter((key) => !recorded.has(key));
    assert.deepEqual(added, [], `${format}#${seed}`);
  }
});

test("the debug view reports checkInvariants after each intent, and seats do not (V4)", async () => {
  const match = createMatch({ setup: () => learnToPlaySetup(4) });
  const opening = match.snapshotForToken(match.tokens.debug).debug!.invariants;
  assert.deepEqual(opening, { problems: [], afterSeq: null });
  const both = match.snapshotForToken(match.tokens.debug).debug!;
  const seat = both.corp.legal.length ? "corp" : "runner";
  const reply = await match.submit(match.tokens.debug, "inv-1", both[seat].legal[0]!.intent, seat);
  assert.deepEqual(reply.debug!.invariants, { problems: [], afterSeq: match.gameLog().length });
  for (const role of ["corp", "runner", "spectator", "log"] as const) {
    const snapshot = match.snapshotForRole(role);
    assert.equal(snapshot.debug, undefined, role);
    assert.equal(JSON.stringify(snapshot).includes("invariants"), false, role);
  }
  forgetMatch(match.id);
});

test("an invariant problem names its cards, and only one the last intent added is new (V4)", async () => {
  // A Runner card marked rezzed breaks CR 8.1.4f. Plant one in the opening.
  const planted = () => {
    const state = learnToPlaySetup(5);
    const id = state.runner.hand[0]!;
    state.cards[id]!.rezzed = true;
    return state;
  };
  const match = createMatch({ setup: planted });
  const opening = match.snapshotForToken(match.tokens.debug).debug!.invariants;
  assert.equal(opening.problems.length, 1);
  const [problem] = opening.problems;
  assert.equal(problem!.code, "RUNNER_CARD_REZZED");
  assert.deepEqual(problem!.rules, ["8.1.4f"]);
  assert.equal(problem!.isNew, false, "nothing is new before an intent applies");
  assert.ok(problem!.cards[0]?.title);
  // An intent that does not add the problem leaves it marked old.
  const both = match.snapshotForToken(match.tokens.debug).debug!;
  const seat = both.corp.legal.length ? "corp" : "runner";
  await match.submit(match.tokens.debug, "inv-2", both[seat].legal[0]!.intent, seat);
  const after = match.snapshotForToken(match.tokens.debug).debug!.invariants;
  assert.equal(after.problems.length, 1);
  assert.equal(after.problems[0]!.isNew, false);
  // Against a "before" that lacked it, the same problem is new.
  const state = (match as unknown as { state: GameState }).state;
  assert.equal(invariantReport(state, new Set())[0]!.isNew, true);
  assert.equal(invariantReport(state, null)[0]!.isNew, false);
  forgetMatch(match.id);
});

test("the invariant panel flags a rezzed Corp card in HQ (engine v1.147.253)", () => {
  // A Corp card out of play is unrezzed (CR 8.1.1). Plant a rezzed one in HQ.
  const planted = () => {
    const state = hedgeInHand()();
    const id = state.corp.hand.find((cardId) => state.cards[cardId]?.defId === "hedge-fund")!;
    state.cards[id]!.rezzed = true;
    return state;
  };
  const match = createMatch({ setup: planted });
  const problems = match.snapshotForToken(match.tokens.debug).debug!.invariants.problems;
  const rezzed = problems.find((problem) => problem.code === "REZZED_OUTSIDE_PLAY");
  assert.ok(rezzed, JSON.stringify(problems));
  assert.equal(rezzed.cards[0]?.title, "Hedge Fund");
  forgetMatch(match.id);
});
