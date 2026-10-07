import assert from "node:assert/strict";
import { test } from "node:test";
import { applyIntent, queryLegality } from "netrunner-engine";
import { learnToPlaySetup } from "./decks.js";
import { actionSource, createMatch, getMatch } from "./match.js";

function secretCardIds(match: ReturnType<typeof createMatch>, side: "corp" | "runner"): string[] {
  const hidden = match.hiddenIds(side);
  return [...hidden.hand, ...hidden.deck];
}

test("learn-to-play decks are the starter lists", () => {
  const state = learnToPlaySetup();
  assert.equal(state.corp.hand.length + state.corp.deck.length, 34);
  assert.equal(state.runner.hand.length + state.runner.deck.length, 30);
  assert.equal(state.cards["corp-id"]?.title, "The Syndicate: Profit over Principle");
  assert.equal(state.cards["runner-id"]?.title, "The Catalyst: Convention Breaker");
  assert.equal(state.config.agendaPointsToWin, 6);
});

test("a seat snapshot hides the other seat's hand and deck", () => {
  const match = createMatch({ setup: learnToPlaySetup });
  const runnerJson = JSON.stringify(match.snapshotForToken(match.tokens.runner));
  for (const id of secretCardIds(match, "corp")) {
    assert.equal(runnerJson.includes(id), false, id);
  }
  const corpJson = JSON.stringify(match.snapshotForToken(match.tokens.corp));
  for (const id of secretCardIds(match, "runner")) {
    assert.equal(corpJson.includes(id), false, id);
  }
  const corpHand = match.hiddenIds("corp").hand;
  assert.ok(corpHand.length > 0);
  assert.equal(corpJson.includes(corpHand[0]!), true);
});

test("a spectator token is read-only and hides both hands", async () => {
  const match = createMatch({ setup: learnToPlaySetup });
  const snapshot = match.snapshotForToken(match.tokens.spectator);
  assert.equal(snapshot.viewer, "spectator");
  assert.deepEqual(snapshot.legal, []);
  const json = JSON.stringify(snapshot);
  for (const id of [...secretCardIds(match, "corp"), ...secretCardIds(match, "runner")]) {
    assert.equal(json.includes(id), false, id);
  }
  const corp = match.snapshotForToken(match.tokens.corp);
  const intent = corp.legal[0]?.intent;
  assert.ok(intent);
  await assert.rejects(() => match.submit(match.tokens.spectator, "watch", intent), /Unknown seat/);
  await assert.rejects(() => match.concede(match.tokens.spectator), /Unknown seat/);
});

test("a spectator snapshot hides both hands and both decks", () => {
  const match = createMatch({ setup: learnToPlaySetup });
  const snapshot = match.snapshotForRole("spectator");
  const json = JSON.stringify(snapshot);
  for (const id of [...secretCardIds(match, "corp"), ...secretCardIds(match, "runner")]) {
    assert.equal(json.includes(id), false, id);
  }
  assert.deepEqual(snapshot.legal, []);
});

test("the other seat cannot play your action", async () => {
  const match = createMatch({ setup: learnToPlaySetup });
  const corp = match.snapshotForToken(match.tokens.corp);
  const intent = corp.legal[0]?.intent;
  assert.ok(intent);
  const before = JSON.stringify(match.result());
  await assert.rejects(
    () => match.submit(match.tokens.runner, "cross-1", intent),
    /not legal/,
  );
  assert.equal(JSON.stringify(match.result()), before);
});

test("repeating an intent id does not apply it twice", async () => {
  const match = createMatch({ setup: learnToPlaySetup });
  const corp = match.snapshotForToken(match.tokens.corp);
  const intent = corp.legal[0]!.intent;
  await match.submit(match.tokens.corp, "once", intent);
  const after = match.snapshotForToken(match.tokens.corp).view as { timingKey: string };
  await match.submit(match.tokens.corp, "once", intent);
  const again = match.snapshotForToken(match.tokens.corp).view as { timingKey: string };
  assert.equal(again.timingKey, after.timingKey);
  const applied = match.gameLog().filter((entry) => entry.ok);
  assert.equal(applied.length, 1);
});

test("a spectator sees table chat and a seat does not see spectator chat", async () => {
  const match = createMatch({ setup: learnToPlaySetup });
  await match.postChat("corp", "table", "offer a click");
  await match.postChat("spectator", "spectator", "the top of R&D is Hedge Fund");
  const corp = match.snapshotForToken(match.tokens.corp);
  assert.equal(corp.chat.some((line) => line.text === "offer a click"), true);
  assert.equal(JSON.stringify(corp.chat).includes("Hedge Fund"), false);
  const watching = match.snapshotForToken(match.tokens.spectator);
  assert.equal(watching.chat.some((line) => line.text === "offer a click"), true);
  assert.equal(watching.chat.some((line) => line.text.includes("Hedge Fund")), true);
});

test("every seat sees the open timing step, and a legal intent carries its citations", async () => {
  const match = createMatch({ setup: learnToPlaySetup });
  const corp = match.snapshotForToken(match.tokens.corp);
  const runner = match.snapshotForToken(match.tokens.runner);
  const watching = match.snapshotForRole("spectator");
  assert.equal(corp.timing.stepNumber, "1.6.6a");
  assert.equal(corp.timing.stepId, "rule_mulligan");
  assert.equal(corp.timing.label, "Corp may take a mulligan.");
  assert.equal(corp.timing.priority, "corp");
  assert.deepEqual(runner.timing, corp.timing);
  assert.deepEqual(watching.timing, corp.timing);
  assert.ok(
    corp.legal.every((item) => item.cites.some((cite) => cite.number === "1.6.6a" && cite.id === "rule_mulligan")),
  );

  await match.submit(match.tokens.corp, "keep", { type: "keep_starting_hand" });
  const logged = match.snapshotForToken(match.tokens.runner).log.at(-1);
  assert.match(logged?.summary ?? "", /Keep/);
  assert.ok(logged?.cites?.some((cite) => cite.number === "1.6.6a" && cite.id === "rule_mulligan"));
  const runnerJson = JSON.stringify(match.snapshotForToken(match.tokens.runner));
  for (const id of secretCardIds(match, "corp")) assert.equal(runnerJson.includes(id), false, id);
});

test("each player may mulligan once, Corp first", async () => {
  const match = createMatch({ setup: learnToPlaySetup });
  const before = match.hiddenIds("corp");
  const pile = [...before.hand, ...before.deck].sort();
  const corp = match.snapshotForToken(match.tokens.corp);
  assert.deepEqual(
    corp.legal.map((item) => item.label),
    ["Keep this hand", "Mulligan — shuffle back and draw 5"],
  );
  assert.equal(match.snapshotForToken(match.tokens.runner).legal.length, 0);
  assert.equal(match.snapshotForRole("spectator").legal.length, 0);

  await match.submit(match.tokens.corp, "corp-mulligan", { type: "mulligan" });
  const after = match.hiddenIds("corp");
  assert.equal(after.hand.length, 5);
  assert.deepEqual([...after.hand, ...after.deck].sort(), pile);
  const runnerView = JSON.stringify(match.snapshotForToken(match.tokens.runner));
  for (const id of after.hand) assert.equal(runnerView.includes(id), false, id);
  const log = JSON.stringify(match.gameLog());
  assert.match(log, /Mulligan/);
  for (const id of pile) assert.equal(log.includes(id), false, id);

  await assert.rejects(
    () => match.submit(match.tokens.corp, "corp-again", { type: "mulligan" }),
    /not legal/,
  );
  const runner = match.snapshotForToken(match.tokens.runner);
  assert.equal((runner.view as { timingKey: string }).timingKey, "opening.runnerMulligan");
  assert.equal(runner.legal.length, 2);
  await match.submit(match.tokens.runner, "runner-keep", { type: "keep_starting_hand" });
  const started = match.snapshotForToken(match.tokens.corp);
  const startedView = started.view as { timingKey: string; self: { clicks: number; hand: string[] } };
  assert.equal(startedView.timingKey, "corp.takeAction");
  assert.equal(startedView.self.clicks, 3);
  assert.equal(startedView.self.hand.length, 6);
  assert.equal(started.legal.some((item) => item.intent.type === "pass_window"), false);
  assert.deepEqual(
    started.log.map((entry) => entry.summary),
    ["Corp: Mulligan — shuffle back and draw 5", "Corp action rejected", "Runner: Keep this hand"],
  );
});

test("legal plays name the card and the cost", async () => {
  const match = createMatch({ setup: learnToPlaySetup });
  await match.submit(match.tokens.corp, "corp-keep", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "runner-keep", { type: "keep_starting_hand" });
  let corp = match.snapshotForToken(match.tokens.corp);
  for (let n = 0; n < 6 && !corp.legal.some((item) => item.intent.type === "basic_gain_credit"); n += 1) {
    const pass = corp.legal.find((item) => item.intent.type === "pass_window");
    assert.ok(pass, corp.legal.map((item) => item.label).join(" | "));
    await match.submit(match.tokens.corp, `pass-${n}`, pass.intent);
    corp = match.snapshotForToken(match.tokens.corp);
  }
  const labels = corp.legal.map((item) => item.label);
  assert.ok(labels.includes("Gain 1 credit — 1 click, 0¢"), labels.join(" | "));
  assert.ok(labels.includes("Draw 1 card — 1 click, 0¢"));
  const install = labels.find((label) => label.startsWith("Install "));
  assert.ok(install, labels.join(" | "));
  assert.match(install, /— 1 click, \d+¢/);
  assert.equal(labels.some((label) => /cardId=/.test(label)), false);
  const hand = (corp.view as { self: { hand: string[] } }).self.hand;
  assert.ok(hand.length > 0);
  assert.ok((corp.glossary[hand[0]!]?.cost ?? "").length > 0);
  for (const id of hand) {
    assert.ok((corp.glossary[id]?.text ?? "").length > 0, corp.glossary[id]?.title);
  }
  const gain = corp.legal.find((item) => item.intent.type === "basic_gain_credit");
  assert.ok(gain);
  assert.equal(gain.source, "basic");
  assert.ok(
    corp.legal.every((item) => item.source === "basic"),
    corp.legal.map((item) => `${item.source} ${item.label}`).join(" | "),
  );
  const clicksBefore = (corp.view as { self: { clicks: number } }).self.clicks;
  await match.submit(match.tokens.corp, "gain", gain.intent);
  const afterGain = match.snapshotForToken(match.tokens.corp);
  const afterView = afterGain.view as { timingKey: string; self: { clicks: number } };
  assert.equal(afterView.timingKey, "corp.takeAction");
  assert.equal(afterView.self.clicks, clicksBefore - 1);
  assert.equal(afterGain.legal.some((item) => item.intent.type === "pass_window"), false);
  assert.equal(afterGain.log.at(-1)?.summary, "Corp: Gain 1 credit — 1 click, 0¢");
  const runnerLog = match.snapshotForToken(match.tokens.runner).log.at(-1)?.summary;
  assert.equal(runnerLog, "Corp: Gain 1 credit — 1 click, 0¢");

  const opening = match.snapshotForToken(match.tokens.corp);
  const openingHand = (opening.view as { self: { hand: string[] } }).self.hand;
  for (const id of openingHand) {
    assert.equal(JSON.stringify(match.snapshotForToken(match.tokens.runner)).includes(id), false);
  }
});

test("a visible card carries its printing code and the other seat does not receive it", () => {
  const match = createMatch({ setup: learnToPlaySetup });
  const corp = match.snapshotForToken(match.tokens.corp);
  const hand = (corp.view as { self: { hand: string[] } }).self.hand;
  assert.ok(hand.length > 0);
  const codes = hand.map((id) => corp.glossary[id]?.code);
  for (const code of codes) assert.match(code ?? "", /^\d{5}$/);
  const hiddenFrom = (token: string) =>
    new Set(Object.values(match.snapshotForToken(token).glossary).map((card) => card.code));
  const runnerCodes = hiddenFrom(match.tokens.runner);
  const spectator = match.snapshotForRole("spectator");
  const spectatorCodes = new Set(Object.values(spectator.glossary).map((card) => card.code));
  for (const code of codes) {
    assert.equal(runnerCodes.has(code), false, code);
    assert.equal(spectatorCodes.has(code), false, code);
  }
});

test("a seat is not offered an install it cannot pay for", async () => {
  const match = createMatch({ setup: learnToPlaySetup });
  await match.submit(match.tokens.corp, "corp-keep", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "runner-keep", { type: "keep_starting_hand" });
  for (let n = 0; n < 12; n += 1) {
    const corp = match.snapshotForToken(match.tokens.corp);
    const timing = (corp.view as { timingKey: string }).timingKey;
    if (timing.startsWith("runner.")) break;
    const next = corp.legal.find(
      (item) =>
        item.intent.type === "basic_gain_credit" ||
        item.intent.type === "discard_to_hand_size" ||
        item.intent.type === "pass_window",
    );
    assert.ok(next, `${timing}: ${corp.legal.map((item) => item.label).join(" | ")}`);
    await match.submit(match.tokens.corp, `corp-${n}`, next.intent);
  }
  let runner = match.snapshotForToken(match.tokens.runner);
  assert.equal((runner.view as { timingKey: string }).timingKey, "runner.takeAction");
  for (let n = 0; n < 8; n += 1) {
    const view = runner.view as { timingKey: string; self: { credits: number; clicks: number } };
    if (view.timingKey !== "runner.takeAction" || view.self.clicks < 1) break;
    const installs = runner.legal.filter((item) => item.intent.type === "basic_install");
    for (const item of installs) {
      const cost = Number(item.label.match(/(\d+)¢/)?.[1]);
      assert.ok(cost <= view.self.credits, `${item.label} with ${view.self.credits}¢`);
    }
    const drain = installs
      .map((item) => ({ item, cost: Number(item.label.match(/(\d+)¢/)?.[1]) }))
      .filter((row) => row.cost > 0)
      .sort((a, b) => b.cost - a.cost)[0];
    if (!drain) break;
    await match.submit(match.tokens.runner, `install-${n}`, drain.item.intent);
    runner = match.snapshotForToken(match.tokens.runner);
  }
});

test("the runner can access the top of an unprotected R&D without learning the card first", async () => {
  const match = createMatch({ setup: learnToPlaySetup });
  await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "keep-runner", { type: "keep_starting_hand" });
  for (let i = 0; i < 8; i += 1) {
    const corp = match.snapshotForToken(match.tokens.corp);
    if (String((corp.view as { timingKey: string }).timingKey).startsWith("runner.")) break;
    const choice =
      corp.legal.find((item) => item.intent.type === "basic_gain_credit") ??
      corp.legal.find((item) => item.intent.type === "pass_window" || item.intent.type === "discard_to_hand_size") ??
      corp.legal[0];
    assert.ok(choice);
    await match.submit(match.tokens.corp, `corp-${i}`, choice.intent);
  }
  const running = match.snapshotForToken(match.tokens.runner);
  const run = running.legal.find((item) => item.intent.type === "basic_run" && item.intent.serverId === "rd");
  assert.ok(run);
  await match.submit(match.tokens.runner, "run-rd", run.intent);
  const breach = match.snapshotForToken(match.tokens.runner);
  const access = breach.legal.find((item) => item.intent.type === "access_card");
  assert.ok(access);
  assert.equal(access.label, "Access the top card of R&D");
  const hidden = secretCardIds(match, "corp");
  const before = JSON.stringify(breach);
  for (const id of hidden) assert.equal(before.includes(id), false, id);
  assert.equal(JSON.stringify(access.intent).includes("corp:"), false);
  const after = await match.submit(match.tokens.runner, "access-rd", access.intent);
  const line = after.log.at(-1);
  assert.match(line?.summary ?? "", /^Runner: Access /);
  assert.notEqual(line?.summary, "Runner: Access the top card of R&D");
  const view = after.view as { run?: { accessingCardId?: string | null } };
  const accessedId = view.run?.accessingCardId;
  const seen = accessedId ? after.glossary[accessedId] : after.access;
  assert.ok(seen?.title);
  assert.match(line?.summary ?? "", new RegExp(seen.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(match.snapshotForToken(match.tokens.spectator).access, undefined);
  const revealed = hidden.filter((id) => JSON.stringify(after).includes(id));
  assert.ok(revealed.length <= 1);
  if (revealed[0]) assert.ok(after.glossary[revealed[0]]?.title);
  for (const id of hidden) {
    if (id !== revealed[0]) assert.equal(JSON.stringify(after).includes(id), false, id);
  }
});

test("a run event names the server on each button", async () => {
  const match = createMatch({
    setup: () => {
      const state = learnToPlaySetup();
      const id =
        state.runner.deck.find((cardId) => state.cards[cardId]?.defId === "jailbreak") ??
        state.runner.hand.find((cardId) => state.cards[cardId]?.defId === "jailbreak");
      assert.ok(id);
      state.runner.deck = state.runner.deck.filter((cardId) => cardId !== id);
      if (!state.runner.hand.includes(id)) state.runner.hand.push(id);
      state.cards[id]!.zone = "runner:grip";
      return state;
    },
  });
  await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "keep-runner", { type: "keep_starting_hand" });
  for (let i = 0; i < 8; i += 1) {
    const corp = match.snapshotForToken(match.tokens.corp);
    if (String((corp.view as { timingKey: string }).timingKey).startsWith("runner.")) break;
    const choice =
      corp.legal.find((item) => item.intent.type === "basic_gain_credit") ??
      corp.legal.find((item) => item.intent.type === "pass_window" || item.intent.type === "discard_to_hand_size") ??
      corp.legal[0];
    assert.ok(choice);
    await match.submit(match.tokens.corp, `corp-${i}`, choice.intent);
  }
  const runner = match.snapshotForToken(match.tokens.runner);
  const plays = runner.legal.filter((item) => item.label.startsWith("Play Jailbreak"));
  assert.ok(plays.length >= 2, runner.legal.map((item) => item.label).join(" | "));
  assert.ok(plays.some((item) => item.label.includes("HQ")));
  assert.ok(plays.some((item) => item.label.includes("R&D")));
  for (const item of plays) {
    if (item.intent.type !== "play_event" || !item.intent.serverId) continue;
    const serverId = item.intent.serverId;
    const name = serverId === "hq" ? "HQ" : serverId === "rd" ? "R&D" : serverId;
    assert.ok(item.label.includes(name), item.label);
  }
});

test("card abilities are marked separately from basic actions", () => {
  assert.equal(actionSource("basic_gain_credit"), "basic");
  assert.equal(actionSource("basic_draw"), "basic");
  assert.equal(actionSource("basic_install"), "basic");
  assert.equal(actionSource("play_event"), "basic");
  assert.equal(actionSource("play_operation"), "basic");
  assert.equal(actionSource("basic_run"), "basic");
  assert.equal(actionSource("rez_ice"), "basic");
  assert.equal(actionSource("access_card"), "basic");
  assert.equal(actionSource("use_paid_ability"), "card");
  assert.equal(actionSource("use_identity_ability"), "card");
  assert.equal(actionSource("break_subroutine"), "card");
  assert.equal(actionSource("break_bioroid_subroutine"), "card");
  assert.equal(actionSource("choose_option"), "card");
});

test("smartware starts empty and cannot pay from an empty pool", () => {
  const state = learnToPlaySetup();
  const card = Object.values(state.cards).find((item) => item.defId === "smartware-distributor");
  assert.ok(card);
  state.runner.deck = state.runner.deck.filter((id) => id !== card.id);
  state.runner.hand = state.runner.hand.filter((id) => id !== card.id);
  state.runner.hand.push(card.id);
  card.zone = "runner:grip";
  state.activeSide = "runner";
  state.timingKey = "runner.takeAction";
  state.runner.clicks = 5;
  const installed = applyIntent(state, {
    type: "basic_install",
    cardId: card.id,
    destination: { kind: "rig" },
  });
  assert.equal(installed.ok, true);
  if (!installed.ok) return;
  assert.equal(installed.state.cards[card.id]?.hostedCredits, undefined);
  const take = {
    type: "use_paid_ability" as const,
    cardId: card.id,
    abilityId: "smartware-take",
  };
  assert.equal(
    queryLegality(installed.state).legal.some(
      (entry) => entry.action.type === "use_paid_ability" && entry.action.abilityId === "smartware-take",
    ),
    false,
  );
  const emptyInstall = applyIntent(installed.state, take);
  assert.equal(emptyInstall.ok, false);
  const atTakeAction = (current: typeof installed.state) => {
    for (let n = 0; n < 4 && current.timingKey !== "runner.takeAction"; n += 1) {
      const passed = applyIntent(current, { type: "pass_window" });
      assert.equal(passed.ok, true);
      if (!passed.ok) return current;
      current = passed.state;
    }
    return current;
  };
  const readyToLoad = atTakeAction(installed.state);
  const loaded = applyIntent(readyToLoad, {
    type: "use_paid_ability",
    cardId: card.id,
    abilityId: "smartware-load",
  });
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.state.cards[card.id]?.hostedCredits, 3);
  const before = loaded.state.runner.credits;
  const paid = applyIntent(atTakeAction(loaded.state), take);
  assert.equal(paid.ok, true);
  if (!paid.ok) return;
  assert.equal(paid.state.runner.credits, before + 1);
  assert.equal(paid.state.cards[card.id]?.hostedCredits, 2);
  assert.equal(paid.state.runner.rig.includes(card.id), true);
  paid.state.cards[card.id]!.hostedCredits = 1;
  const last = applyIntent(atTakeAction(paid.state), take);
  assert.equal(last.ok, true);
  if (!last.ok) return;
  assert.equal(last.state.cards[card.id]?.hostedCredits, 0);
  assert.equal(last.state.runner.rig.includes(card.id), true);
  const back = atTakeAction(last.state);
  const offered = queryLegality(back).legal.some(
    (entry) => entry.action.type === "use_paid_ability" && entry.action.abilityId === "smartware-take",
  );
  assert.equal(offered, false);
  const empty = applyIntent(back, take);
  assert.equal(empty.ok, false);
  assert.equal(last.state.runner.rig.includes(card.id), true);
  assert.equal(last.state.runner.credits, before + 2);
});

test("the runner does not learn the name of an unrezzed Corp install", async () => {
  const match = createMatch({ setup: learnToPlaySetup });
  await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "keep-runner", { type: "keep_starting_hand" });
  let corp = match.snapshotForToken(match.tokens.corp);
  for (let n = 0; n < 6 && !corp.legal.some((item) => item.intent.type === "basic_install"); n += 1) {
    const pass = corp.legal.find((item) => item.intent.type === "pass_window");
    assert.ok(pass);
    await match.submit(match.tokens.corp, `pass-${n}`, pass.intent);
    corp = match.snapshotForToken(match.tokens.corp);
  }
  const install = corp.legal.find(
    (item) => item.intent.type === "basic_install" && item.intent.destination.kind === "new_remote",
  );
  assert.ok(install);
  const title = install.label.replace(/^Install /, "").replace(/ (?:in|protecting|hosted) .*/, "");
  assert.ok(title.length > 0);
  await match.submit(match.tokens.corp, "install", install.intent);
  const corpLine = match.snapshotForToken(match.tokens.corp).log.at(-1)?.summary ?? "";
  const runnerLine = match.snapshotForToken(match.tokens.runner).log.at(-1)?.summary ?? "";
  const spectatorLine = match.snapshotForRole("spectator").log.at(-1)?.summary ?? "";
  assert.match(corpLine, new RegExp(`Corp: Install ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} in a new remote`));
  assert.equal(runnerLine.includes(title), false);
  assert.match(runnerLine, /^Corp: Install a card in a new remote/);
  assert.equal(spectatorLine, runnerLine);
  assert.equal(JSON.stringify(match.snapshotForToken(match.tokens.runner)).includes(title), false);
});

test("archives offers only the latest card, faceup or facedown", () => {
  const faceupOnTop = learnToPlaySetup();
  const facedownId = faceupOnTop.corp.hand[0];
  const faceupId = faceupOnTop.corp.deck[0];
  assert.ok(facedownId && faceupId);
  const bury = (id: string, faceup: boolean) => {
    faceupOnTop.corp.hand = faceupOnTop.corp.hand.filter((cardId) => cardId !== id);
    faceupOnTop.corp.deck = faceupOnTop.corp.deck.filter((cardId) => cardId !== id);
    faceupOnTop.corp.discard.push(id);
    faceupOnTop.cards[id]!.zone = "corp:archives";
    faceupOnTop.cards[id]!.faceup = faceup;
    faceupOnTop.cards[id]!.rezzed = false;
  };
  bury(facedownId, false);
  bury(faceupId, true);
  const shown = createMatch({ setup: () => faceupOnTop });
  const runner = shown.snapshotForToken(shown.tokens.runner);
  const corp = shown.snapshotForToken(shown.tokens.corp);
  const watching = shown.snapshotForRole("spectator");
  const runnerTop = (runner.view as { opponent: { discardTop: { faceup: boolean; id?: string } } }).opponent.discardTop;
  const corpTop = (corp.view as { self: { discardTop: { faceup: boolean; id?: string } } }).self.discardTop;
  const spectatorTop = (watching.view as { corp: { discardTop: { faceup: boolean; id?: string } } }).corp.discardTop;
  assert.deepEqual(runnerTop, { faceup: true, id: faceupId });
  assert.deepEqual(corpTop, { faceup: true, id: faceupId });
  assert.deepEqual(spectatorTop, { faceup: true, id: faceupId });
  assert.equal(runner.glossary[faceupId]?.title, faceupOnTop.cards[faceupId]?.title);
  assert.equal(JSON.stringify(runner).includes(facedownId), false);

  const facedownOnTop = learnToPlaySetup();
  const older = facedownOnTop.corp.deck[0];
  const newer = facedownOnTop.corp.hand[0];
  assert.ok(older && newer);
  const stack = (id: string, faceup: boolean) => {
    facedownOnTop.corp.hand = facedownOnTop.corp.hand.filter((cardId) => cardId !== id);
    facedownOnTop.corp.deck = facedownOnTop.corp.deck.filter((cardId) => cardId !== id);
    facedownOnTop.corp.discard.push(id);
    facedownOnTop.cards[id]!.zone = "corp:archives";
    facedownOnTop.cards[id]!.faceup = faceup;
    facedownOnTop.cards[id]!.rezzed = false;
  };
  stack(older, true);
  stack(newer, false);
  const hidden = createMatch({ setup: () => facedownOnTop });
  const hiddenRunner = hidden.snapshotForToken(hidden.tokens.runner);
  const hiddenCorp = hidden.snapshotForToken(hidden.tokens.corp);
  assert.deepEqual(
    (hiddenRunner.view as { opponent: { discardTop: unknown } }).opponent.discardTop,
    { faceup: false },
  );
  assert.deepEqual(
    (hiddenCorp.view as { self: { discardTop: unknown } }).self.discardTop,
    { faceup: false },
  );
  assert.equal(JSON.stringify(hiddenRunner).includes(newer), false);
  assert.equal(JSON.stringify(hidden.snapshotForRole("spectator")).includes(newer), false);
});

test("the heap offers only the latest card, and a faceup card is visible", () => {
  const state = learnToPlaySetup();
  const older = state.runner.deck[0];
  const newer = state.runner.hand[0];
  assert.ok(older && newer);
  const bury = (id: string) => {
    state.runner.hand = state.runner.hand.filter((cardId) => cardId !== id);
    state.runner.deck = state.runner.deck.filter((cardId) => cardId !== id);
    state.runner.discard.push(id);
    state.cards[id]!.zone = "runner:heap";
    state.cards[id]!.faceup = true;
  };
  bury(older);
  bury(newer);
  const match = createMatch({ setup: () => state });
  const expected = { faceup: true, id: newer };
  const runner = match.snapshotForToken(match.tokens.runner);
  const corp = match.snapshotForToken(match.tokens.corp);
  const watching = match.snapshotForRole("spectator");
  assert.deepEqual((runner.view as { self: { discardTop: unknown } }).self.discardTop, expected);
  assert.deepEqual((corp.view as { opponent: { discardTop: unknown } }).opponent.discardTop, expected);
  assert.deepEqual((watching.view as { runner: { discardTop: unknown } }).runner.discardTop, expected);
  assert.equal(corp.glossary[newer]?.title, state.cards[newer]?.title);
  assert.equal(corp.glossary[older]?.title, state.cards[older]?.title);
});

test("concede ends the game and the match stays available", async () => {
  const match = createMatch({ setup: learnToPlaySetup });
  await match.concede(match.tokens.corp);
  const result = match.result();
  assert.equal(result.done, true);
  assert.equal(result.winner, "runner");
  assert.equal(result.hostEnd, "concede");
  assert.equal(getMatch(match.id), match);
  await assert.rejects(() => match.submit(match.tokens.runner, "late", { type: "pass_window" }), /over/);
});

test("an advanced facedown card shows its advancement counters to every seat", () => {
  const state = learnToPlaySetup();
  const agenda = Object.values(state.cards).find((card) => card.defId === "offworld-office");
  assert.ok(agenda);
  state.corp.deck = state.corp.deck.filter((id) => id !== agenda.id);
  state.corp.hand = state.corp.hand.filter((id) => id !== agenda.id);
  agenda.zone = "server:remote-1:root";
  agenda.rezzed = false;
  agenda.faceup = false;
  agenda.advancementTokens = 1;
  state.servers["remote-1"] = { id: "remote-1", kind: "remote", ice: [], root: [agenda.id] };

  const match = createMatch({ setup: () => state });
  const installed = (snap: ReturnType<typeof match.snapshotForToken>) => {
    const servers = (snap.view as { servers: { root?: { title: string | null; advancementTokens?: number | null }[] }[] }).servers;
    return servers.find((server) => (server as { id?: string }).id === "remote-1")?.root?.[0]
      ?? servers.flatMap((server) => server.root ?? []).find((card) => (card.advancementTokens ?? 0) > 0);
  };
  const corpCard = installed(match.snapshotForToken(match.tokens.corp));
  const watching = installed(match.snapshotForRole("spectator"));
  assert.equal(corpCard?.advancementTokens, 1);
  assert.equal(corpCard?.title, "Offworld Office");
  assert.equal(watching?.advancementTokens, 1);
  assert.equal(watching?.title ?? null, null);
});

test("hosted credits show on the card for every seat", () => {
  const state = learnToPlaySetup();
  const hidden = Object.values(state.cards).find((card) => card.defId === "nico-campaign");
  const program = Object.values(state.cards).find((card) => card.defId === "smartware-distributor");
  assert.ok(hidden);
  assert.ok(program);
  for (const card of [hidden, program]) {
    state.corp.deck = state.corp.deck.filter((id) => id !== card.id);
    state.corp.hand = state.corp.hand.filter((id) => id !== card.id);
    state.runner.deck = state.runner.deck.filter((id) => id !== card.id);
    state.runner.hand = state.runner.hand.filter((id) => id !== card.id);
  }
  hidden.zone = "server:remote-1:root";
  hidden.rezzed = false;
  hidden.faceup = false;
  hidden.hostedCredits = 9;
  state.servers["remote-1"] = { id: "remote-1", kind: "remote", ice: [], root: [hidden.id] };
  program.zone = "runner:rig";
  program.faceup = true;
  program.hostedCredits = 3;
  state.runner.rig = [program.id];

  const match = createMatch({ setup: () => state });
  const corp = match.snapshotForToken(match.tokens.corp);
  const runner = match.snapshotForToken(match.tokens.runner);
  const watching = match.snapshotForRole("spectator");
  const root = (snap: ReturnType<typeof match.snapshotForToken>) =>
    (snap.view as { servers: { id: string; root?: { title: string | null; hosted?: number }[] }[] }).servers
      .find((server) => server.id === "remote-1")?.root?.[0];
  assert.equal(root(corp)?.hosted, 9);
  assert.equal(root(corp)?.title, "Nico Campaign");
  assert.equal(root(runner)?.hosted, 9);
  assert.equal(root(runner)?.title, null);
  assert.equal(root(watching)?.hosted, 9);
  assert.equal(root(watching)?.title ?? null, null);
  assert.equal((root(watching) as { code?: string; type?: string } | undefined)?.code, undefined);
  assert.equal((root(watching) as { type?: string } | undefined)?.type, undefined);
  assert.equal(JSON.stringify(runner).includes("Nico Campaign"), false);
  assert.equal(JSON.stringify(watching).includes("Nico Campaign"), false);

  const rigHosted = (entries: unknown) => {
    const list = entries as Array<string | { id?: string; hosted?: number; title?: string }>;
    const found = list.find((entry) => (typeof entry === "string" ? entry === program.id : entry.id === program.id || entry.title === "Smartware Distributor"));
    return typeof found === "string" ? corp.glossary[found]?.hosted : found?.hosted;
  };
  assert.equal(rigHosted((corp.view as { opponent: { rig: unknown } }).opponent.rig), 3);
  assert.equal(rigHosted((runner.view as { self: { rig: unknown } }).self.rig), 3);
  assert.equal(rigHosted((watching.view as { runner: { rig: unknown } }).runner.rig), 3);
  const watchingRig = (watching.view as { runner: { rig: { title?: string; type?: string; code?: string }[] } }).runner.rig[0];
  assert.equal(watchingRig?.title, "Smartware Distributor");
  assert.equal(watchingRig?.type, "resource");
  assert.match(watchingRig?.code ?? "", /^\d{5}$/);
});

test("every seat sees both identity cards", () => {
  const match = createMatch({ setup: learnToPlaySetup });
  const corp = match.snapshotForToken(match.tokens.corp);
  const runner = match.snapshotForToken(match.tokens.runner);
  const watching = match.snapshotForRole("spectator");
  const identityId = (snap: ReturnType<typeof match.snapshotForToken>, side: "corp" | "runner") => {
    if (snap.viewer === "spectator") {
      return (snap.view as { corp: { identityId: string }; runner: { identityId: string } })[side].identityId;
    }
    const view = snap.view as { self: { identityId: string }; opponent: { identityId: string } };
    return (snap.viewer === side ? view.self : view.opponent).identityId;
  };
  for (const snap of [corp, runner, watching]) {
    for (const side of ["corp", "runner"] as const) {
      const card = snap.glossary[identityId(snap, side)];
      assert.equal(card?.type, "identity");
      assert.match(card?.code ?? "", /^\d{5}$/);
      assert.ok(card?.title);
    }
  }
  assert.equal(identityId(watching, "corp") === identityId(corp, "corp"), true);
  assert.equal(identityId(watching, "runner") === identityId(runner, "runner"), true);
});

test("a spectator sees the face of a rezzed card", () => {
  const state = learnToPlaySetup();
  const shown = Object.values(state.cards).find((card) => card.defId === "nico-campaign");
  assert.ok(shown);
  state.corp.deck = state.corp.deck.filter((id) => id !== shown.id);
  state.corp.hand = state.corp.hand.filter((id) => id !== shown.id);
  shown.zone = "server:remote-1:root";
  shown.rezzed = true;
  shown.faceup = true;
  shown.hostedCredits = 9;
  state.servers["remote-1"] = { id: "remote-1", kind: "remote", ice: [], root: [shown.id] };

  const watching = createMatch({ setup: () => state }).snapshotForRole("spectator");
  const card = (watching.view as {
    servers: { id: string; root?: { title: string | null; type?: string; rezzed?: boolean; code?: string; hosted?: number }[] }[];
  }).servers.find((server) => server.id === "remote-1")?.root?.[0];
  assert.equal(card?.title, "Nico Campaign");
  assert.equal(card?.type, "asset");
  assert.equal(card?.rezzed, true);
  assert.equal(card?.hosted, 9);
  assert.match(card?.code ?? "", /^\d{5}$/);
  assert.equal((card as { id?: string } | undefined)?.id, undefined);
});
