import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInvariants } from "netrunner-engine";
import {
  learnToPlayDeck,
  learnToPlaySetup,
  matchSetupFromBody,
  reviewSubmittedDeck,
} from "./decks.js";

test("no submitted decks starts the learn-to-play match", () => {
  const decision = matchSetupFromBody(undefined, 42);
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  const state = decision.setup();
  const teaching = learnToPlaySetup(42);
  assert.equal(state.corp.hand.length + state.corp.deck.length, 34);
  assert.equal(state.runner.hand.length + state.runner.deck.length, 30);
  assert.deepEqual(state.corp.hand, teaching.corp.hand);
  assert.deepEqual(state.runner.hand, teaching.runner.hand);
});

test("the expanded learn-to-play list adds the booster cards", () => {
  const decision = matchSetupFromBody({ preset: "expanded" }, 42);
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  const state = decision.setup();
  const teaching = learnToPlaySetup(42, "expanded");
  const pile = (side: "corp" | "runner") =>
    [...state[side].hand, ...state[side].deck].map((id) => state.cards[id]?.defId);
  assert.equal(state.corp.hand.length + state.corp.deck.length, 44);
  assert.equal(state.runner.hand.length + state.runner.deck.length, 40);
  assert.equal(pile("corp").filter((id) => id === "orbital-superiority").length, 2);
  assert.equal(pile("runner").filter((id) => id === "conduit").length, 2);
  assert.deepEqual(state.corp.hand, teaching.corp.hand);
  assert.match(state.log[0] ?? "", /booster cards/);
});

test("an unknown learn-to-play list is refused", () => {
  const decision = matchSetupFromBody({ preset: "startup" });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.status, 400);
});

test("the learn-to-play lists pass the deck check", () => {
  for (const side of ["corp", "runner"] as const) {
    const deck = learnToPlayDeck(side);
    const review = reviewSubmittedDeck(side, deck.identityId, deck.cards);
    assert.deepEqual(review.problems, [], side);
    assert.equal(review.legal, true, side);
  }
});

test("a submitted match is refused before it exists when a deck is short", () => {
  const corp = learnToPlayDeck("corp");
  const runner = learnToPlayDeck("runner");
  const decision = matchSetupFromBody({
    corp,
    runner: { identityId: runner.identityId, cards: runner.cards.slice(0, 29) },
  });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.status, 422);
  assert.equal(decision.runner?.legal, false);
  assert.equal(decision.runner?.report?.underMinimum, true);
  assert.match(decision.runner?.problems.join(" ") ?? "", /CR 1\.4\.3/);
});

test("a fourth copy and an agenda band miss are refused", () => {
  const runner = learnToPlayDeck("runner");
  const four = runner.cards.map((id, index) => (index === 0 ? "sure-gamble" : id));
  const copies = reviewSubmittedDeck("runner", runner.identityId, four);
  assert.equal(copies.legal, false);
  assert.equal(copies.report?.overLimit.includes("sure-gamble"), true);

  const titles = [
    "nico-campaign",
    "urtica-cipher",
    "regolith-mining-license",
    "bran-1-0",
    "diviner",
    "karuna",
    "palisade",
    "tithe",
    "whitespace",
    "seamless-launch",
    "government-subsidy",
    "hedge-fund",
    "manegarm-skunkworks",
  ];
  const corp = learnToPlayDeck("corp");
  const forty = [...titles.flatMap((id) => [id, id, id]), "send-a-message"];
  const band = reviewSubmittedDeck("corp", corp.identityId, forty);
  assert.equal(forty.length, 40);
  assert.equal(band.report?.agendaOutOfRange, true);
  assert.equal(band.legal, false);
  assert.match(band.problems.join(" "), /CR 1\.4\.6/);
});

test("an identity inside the deck, an unknown card, and the wrong side are refused", () => {
  const runner = learnToPlayDeck("runner");
  const identity = reviewSubmittedDeck("runner", runner.identityId, [
    ...runner.cards,
    runner.identityId,
  ]);
  assert.match(identity.problems.join(" "), /CR 1\.4\.3a/);

  const unknown = reviewSubmittedDeck("runner", runner.identityId, [
    ...runner.cards.slice(0, 29),
    "not-a-card",
  ]);
  assert.match(unknown.problems.join(" "), /unknown card not-a-card/);

  const side = reviewSubmittedDeck("runner", runner.identityId, [
    ...runner.cards.slice(0, 29),
    "hedge-fund",
  ]);
  assert.match(side.problems.join(" "), /hedge-fund is not a runner card/);

  const swapped = reviewSubmittedDeck("corp", runner.identityId, learnToPlayDeck("corp").cards);
  assert.equal(swapped.report, null);
  assert.match(swapped.problems.join(" "), /runner identity/);
});

test("a legal submitted pair becomes the match", () => {
  const corp = learnToPlayDeck("corp");
  const runner = learnToPlayDeck("runner");
  const decision = matchSetupFromBody({ corp, runner }, 7);
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  const state = decision.setup();
  assert.equal(state.cards["corp-id"]?.defId, corp.identityId);
  assert.equal(state.cards["runner-id"]?.defId, runner.identityId);
  assert.equal(state.corp.hand.length + state.corp.deck.length, corp.cards.length);
  assert.match(state.log[0] ?? "", /Submitted decks/);
});

test("a body with one deck is refused as incomplete", () => {
  const decision = matchSetupFromBody({ corp: learnToPlayDeck("corp") });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.status, 400);
});

test("both learn-to-play deals pass the engine's state invariants (CR 4.1.1c, 4.1.2b)", () => {
  for (const list of ["starter", "expanded"] as const) {
    for (const seed of [1, 2, 3]) {
      const problems = checkInvariants(learnToPlaySetup(seed, list)).map((p) => `${p.code}: ${p.message}`);
      assert.deepEqual(problems, [], `${list} seed ${seed}`);
    }
  }
});

test("in-faction cards cost no influence; out-of-faction and neutral cards do (CR 1.4.5)", () => {
  const kate = "kate-mac-mccaffrey-digital-tinker"; // Shaper, 45 cards, 15 influence
  const shaper = [
    "beta-build", "burner", "careful-planning", "code-siphon", "compile",
    "deep-data-mining", "deep-dive", "dianas-hunt", "encore", "escher",
    "game-day", "harmony-ar-therapy", "illumination", "in-the-groove", "indexing",
  ];
  const inFaction = shaper.flatMap((id) => [id, id, id]);
  assert.equal(inFaction.length, 45);
  const legal = reviewSubmittedDeck("runner", kate, inFaction);
  assert.deepEqual(legal.problems, []);
  assert.equal(legal.legal, true);
  assert.equal(legal.report?.influence, 0);

  // Neutral cards are out-of-faction, so Lucky Find's printed 2 counts per copy.
  const withNeutral = [...inFaction.slice(3), "lucky-find", "lucky-find", "lucky-find"];
  const neutral = reviewSubmittedDeck("runner", kate, withNeutral);
  assert.equal(neutral.legal, true);
  assert.equal(neutral.report?.influence, 6);

  // Amped Up 3, By Any Means 5, Chain Reaction 5: two copies each is 26.
  const anarch = ["amped-up", "by-any-means", "chain-reaction"].flatMap((id) => [id, id]);
  const over = reviewSubmittedDeck("runner", kate, [...inFaction.slice(6), ...anarch]);
  assert.equal(over.legal, false);
  assert.equal(over.report?.influence, 26);
  assert.equal(over.report?.overInfluence, true);
  assert.match(over.problems.join(" "), /influence 26 exceeds 15 \(CR 1\.4\.5\)/);
});
