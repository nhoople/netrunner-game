import assert from "node:assert/strict";
import { test } from "node:test";
import { learnToPlaySetup } from "./decks.js";
import { openGolden, stepGolden } from "./golden.js";
import { createMatch } from "./match.js";

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
