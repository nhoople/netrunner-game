import assert from "node:assert/strict";
import { test } from "node:test";
import { applyIntent, instantiateCard, queryLegality } from "netrunner-engine";
import type { GameState, Intent, ZoneId } from "netrunner-engine";
import { learnToPlaySetup } from "./decks.js";

// Deterministic opening hands for every learn-to-play scenario (#34).
const SEED = 42;
const seededSetup = () => learnToPlaySetup(SEED);
import { actionSource, createMatch, describeIntent, getMatch } from "./match.js";

function secretCardIds(match: ReturnType<typeof createMatch>, side: "corp" | "runner"): string[] {
  const hidden = match.hiddenIds(side);
  return [...hidden.hand, ...hidden.deck];
}

test("learn-to-play decks are the starter lists", () => {
  const state = learnToPlaySetup(SEED);
  assert.equal(state.corp.hand.length + state.corp.deck.length, 34);
  assert.equal(state.runner.hand.length + state.runner.deck.length, 30);
  assert.equal(state.cards["corp-id"]?.title, "The Syndicate: Profit over Principle");
  assert.equal(state.cards["runner-id"]?.title, "The Catalyst: Convention Breaker");
  assert.equal(state.config.agendaPointsToWin, 6);
});

test("a seat snapshot hides the other seat's hand and deck", () => {
  const match = createMatch({ setup: seededSetup });
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
  const match = createMatch({ setup: seededSetup });
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

test("facedown set-aside groups stay distinct per effect (CR 4.8.7)", () => {
  let groupA = "";
  let groupB = "";
  const match = createMatch({
    setup: () => {
      const state = learnToPlaySetup(SEED);
      const a = state.runner.hand[0]!;
      const b = state.runner.hand[1]!;
      const c = state.runner.hand[2]!;
      state.runner.hand = state.runner.hand.filter((id) => id !== a && id !== b && id !== c);
      for (const id of [a, b, c]) {
        state.cards[id]!.zone = "runner:set-aside";
        state.cards[id]!.faceup = false;
      }
      groupA = "set-aside-group-1";
      groupB = "set-aside-group-2";
      state.cards[a]!.setAsideGroupId = groupA;
      state.cards[b]!.setAsideGroupId = groupA;
      state.cards[c]!.setAsideGroupId = groupB;
      state.runner.setAside = [a, b, c];
      return state;
    },
  });
  for (const role of ["corp", "runner", "spectator"] as const) {
    const view = match.snapshotForRole(role).view as {
      setAside: Array<{ id: string; groupId?: string | null; title: string | null }>;
    };
    const byGroup = new Map<string, string[]>();
    for (const card of view.setAside) {
      assert.ok(card.groupId, "facedown group id open");
      if (role !== "runner") assert.equal(card.title, null);
      const list = byGroup.get(card.groupId!) ?? [];
      list.push(card.id);
      byGroup.set(card.groupId!, list);
    }
    assert.equal(byGroup.size, 2);
    assert.equal(byGroup.get(groupA)?.length, 2);
    assert.equal(byGroup.get(groupB)?.length, 1);
  }
});

test("play area, set-aside, BP fund, and hosted cards are open on seat views (CR 4.6 / 4.8 / 10.6.2)", () => {
  let playAreaOpId = "";
  let setAsideId = "";
  const match = createMatch({
    setup: () => {
      const state = learnToPlaySetup(SEED);
      state.badPublicityFund = 2;

      playAreaOpId = state.corp.hand[0]!;
      state.corp.hand = state.corp.hand.filter((id) => id !== playAreaOpId);
      const op = state.cards[playAreaOpId]!;
      op.zone = "corp:play-area";
      op.faceup = true;
      state.corp.playArea = [playAreaOpId];

      const iceId = "hq-ice-host";
      state.cards[iceId] = {
        ...state.cards[state.corp.identityId]!,
        id: iceId,
        title: "Ice Wall",
        type: "ice",
        zone: "server:hq:ice",
        faceup: true,
        rezzed: true,
        hostedCardIds: ["hosted-on-ice"],
        hostedCredits: 0,
      };
      state.servers.hq!.ice = [iceId];
      state.cards["hosted-on-ice"] = {
        ...state.cards[state.runner.identityId]!,
        id: "hosted-on-ice",
        title: "Daemon Hosted",
        type: "program",
        zone: "hosted:hq-ice-host",
        faceup: true,
        side: "runner",
        hostId: iceId,
        hostedCardIds: [],
      };

      setAsideId = state.runner.hand[0]!;
      state.runner.hand = state.runner.hand.filter((id) => id !== setAsideId);
      const aside = state.cards[setAsideId]!;
      aside.zone = "runner:set-aside";
      aside.faceup = true;
      state.runner.setAside = [setAsideId];
      return state;
    },
  });

  for (const role of ["corp", "runner", "spectator"] as const) {
    const view = match.snapshotForRole(role).view as {
      badPublicityFund: number;
      setAside: Array<{ id: string; title: string | null }>;
      self?: { playArea: Array<{ id: string; title: string | null }> };
      opponent?: { playArea: Array<{ id: string; title: string | null }> };
      corp?: { playArea: Array<{ id: string; title: string | null }> };
      servers: Array<{
        id: string;
        ice: Array<{ id: string; hostedCards?: Array<{ id: string; title: string | null }> }>;
      }>;
    };
    assert.equal(view.badPublicityFund, 2);
    const aside = view.setAside.find((c) => c.id === setAsideId);
    assert.ok(aside, "set-aside location open");
    assert.ok(aside!.title, "faceup set-aside title open");
    assert.equal((aside as { groupId?: string | null }).groupId, undefined);

    const playArea =
      role === "spectator"
        ? view.corp?.playArea
        : role === "corp"
          ? view.self?.playArea
          : view.opponent?.playArea;
    assert.ok(playArea?.some((c) => c.id === playAreaOpId && c.title != null), "lingering play area open");

    const hqIce = view.servers.find((s) => s.id === "hq")?.ice[0];
    assert.equal(hqIce?.id, "hq-ice-host");
    assert.ok(hqIce?.hostedCards?.some((h) => h.id === "hosted-on-ice" && h.title === "Daemon Hosted"));
  }
});

test("removed-from-game cards are open on every view (CR 4.9.6)", () => {
  const empty = createMatch({ setup: seededSetup });
  for (const role of ["corp", "runner", "spectator"] as const) {
    const view = empty.snapshotForRole(role).view as { removedFromGame: unknown[] };
    assert.deepEqual(view.removedFromGame, []);
  }

  const match = createMatch({
    setup: () => {
      const state = learnToPlaySetup(SEED);
      const runnerId = state.runner.hand[0]!;
      const corpId = state.corp.hand[0]!;
      state.runner.hand = state.runner.hand.filter((id) => id !== runnerId);
      state.corp.hand = state.corp.hand.filter((id) => id !== corpId);
      state.cards[runnerId]!.zone = "removed-from-game";
      state.cards[runnerId]!.faceup = true;
      state.cards[corpId]!.zone = "removed-from-game";
      state.cards[corpId]!.faceup = false;
      state.removedFromGame = [runnerId, corpId];
      return state;
    },
  });
  const views = (["corp", "runner", "spectator"] as const).map(
    (role) => match.snapshotForRole(role).view as {
      removedFromGame: Array<{
        id: string;
        title: string;
        code?: string;
        side: string;
        faceup?: boolean;
      }>;
    },
  );
  assert.deepEqual(views[1]!.removedFromGame, views[0]!.removedFromGame);
  assert.deepEqual(views[2]!.removedFromGame, views[0]!.removedFromGame);
  const pile = views[0]!.removedFromGame;
  assert.equal(pile.length, 2);
  assert.equal(pile[0]!.side, "runner");
  assert.equal(pile[1]!.side, "corp");
  assert.equal(pile[1]!.faceup, undefined);
  for (const card of pile) {
    assert.ok(card.title.length > 0);
    assert.match(card.code ?? "", /^\d{5}$/);
  }
  const watching = match.snapshotForRole("spectator");
  for (const card of pile) {
    assert.equal(watching.glossary[card.id]?.title, card.title);
    assert.equal(watching.glossary[card.id]?.code, card.code);
  }
});

test("a spectator snapshot hides both hands and both decks", () => {
  const match = createMatch({ setup: seededSetup });
  const snapshot = match.snapshotForRole("spectator");
  const json = JSON.stringify(snapshot);
  for (const id of [...secretCardIds(match, "corp"), ...secretCardIds(match, "runner")]) {
    assert.equal(json.includes(id), false, id);
  }
  assert.deepEqual(snapshot.legal, []);
});

test("the other seat cannot play your action", async () => {
  const match = createMatch({ setup: seededSetup });
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
  const match = createMatch({ setup: seededSetup });
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
  const match = createMatch({ setup: seededSetup });
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
  const match = createMatch({ setup: seededSetup });
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
  const match = createMatch({ setup: seededSetup });
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

test("choosing a log entry restores that position", async () => {
  const match = createMatch({ setup: seededSetup });
  await match.submit(match.tokens.corp, "corp-keep", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "runner-keep", { type: "keep_starting_hand" });
  let corp = match.snapshotForToken(match.tokens.corp);
  for (let n = 0; n < 6 && !corp.legal.some((item) => item.intent.type === "basic_gain_credit"); n += 1) {
    const pass = corp.legal.find((item) => item.intent.type === "pass_window");
    assert.ok(pass);
    await match.submit(match.tokens.corp, `pass-${n}`, pass.intent);
    corp = match.snapshotForToken(match.tokens.corp);
  }
  const atStart = corp;
  const startSeq = atStart.log.at(-1)!.seq;
  const startView = atStart.view as { timingKey: string; self: { clicks: number; credits: number; hand: string[] } };
  const gain = atStart.legal.find((item) => item.intent.type === "basic_gain_credit");
  assert.ok(gain);
  await match.submit(match.tokens.corp, "gain", gain.intent);
  const after = match.snapshotForToken(match.tokens.corp);
  assert.equal(after.log.length, startSeq + 1);
  assert.equal(
    (after.view as { self: { clicks: number } }).self.clicks,
    startView.self.clicks - 1,
  );

  await assert.rejects(() => match.seek(match.tokens.runner, startSeq), /log page/);
  const restored = await match.seek(match.tokens.log, startSeq);
  assert.equal(restored.viewer, "log");
  assert.equal(restored.legal.length, 0);
  const logJson = JSON.stringify(restored);
  for (const id of startView.self.hand) assert.equal(logJson.includes(id), false, id);
  const corpAgain = match.snapshotForToken(match.tokens.corp);
  const restoredView = corpAgain.view as { timingKey: string; self: { clicks: number; credits: number; hand: string[] } };
  assert.equal(restoredView.timingKey, startView.timingKey);
  assert.equal(restoredView.self.clicks, startView.self.clicks);
  assert.equal(restoredView.self.credits, startView.self.credits);
  assert.deepEqual(restoredView.self.hand, startView.self.hand);
  assert.equal(restored.log.length, startSeq);
  assert.equal(restored.log.at(-1)?.summary, atStart.log.at(-1)?.summary);
  const watching = match.snapshotForRole("spectator");
  assert.equal((watching.view as { timingKey: string }).timingKey, startView.timingKey);
  assert.equal(watching.log.length, startSeq);
  const runnerJson = JSON.stringify(match.snapshotForToken(match.tokens.runner));
  for (const id of startView.self.hand) assert.equal(runnerJson.includes(id), false, id);

  const again = await match.seek(match.tokens.log, startSeq);
  assert.equal(again.log.length, startSeq);
  await assert.rejects(() => match.seek(match.tokens.log, startSeq + 5), /Unknown log position/);

  const replay = match.snapshotForToken(match.tokens.corp).legal.find((item) => item.intent.type === "basic_gain_credit");
  assert.ok(replay);
  await match.submit(match.tokens.corp, "gain", replay.intent);
  assert.equal(match.snapshotForToken(match.tokens.corp).log.at(-1)?.summary, "Corp: Gain 1 credit — 1 click");

  await match.concede(match.tokens.corp);
  assert.equal(match.snapshotForToken(match.tokens.runner).result.done, true);
  const resumed = await match.seek(match.tokens.log, startSeq);
  assert.equal(resumed.result.done, false);
  assert.equal(resumed.result.winner, null);
});

test("legal plays name the card and the cost", async () => {
  const match = createMatch({ setup: seededSetup });
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
  assert.ok(labels.includes("Gain 1 credit — 1 click"), labels.join(" | "));
  assert.ok(labels.includes("Draw 1 card — 1 click"));
  const install = labels.find((label) => label.startsWith("Install "));
  assert.ok(install, labels.join(" | "));
  assert.match(install, /— 1 click(?:, \d+¢)?/);
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
  assert.equal(afterGain.log.at(-1)?.summary, "Corp: Gain 1 credit — 1 click");
  const runnerLog = match.snapshotForToken(match.tokens.runner).log.at(-1)?.summary;
  assert.equal(runnerLog, "Corp: Gain 1 credit — 1 click");

  const opening = match.snapshotForToken(match.tokens.corp);
  const openingHand = (opening.view as { self: { hand: string[] } }).self.hand;
  for (const id of openingHand) {
    assert.equal(JSON.stringify(match.snapshotForToken(match.tokens.runner)).includes(id), false);
  }
});

test("a visible card carries its printing code and the other seat does not receive it", () => {
  const match = createMatch({ setup: seededSetup });
  const corp = match.snapshotForToken(match.tokens.corp);
  const hand = (corp.view as { self: { hand: string[] } }).self.hand;
  assert.ok(hand.length > 0);
  const codes = hand.map((id) => corp.glossary[id]?.code);
  for (const code of codes) assert.match(code ?? "", /^\d{5}$/);
  for (const id of hand) {
    assert.equal((corp.glossary[id]?.cost ?? "").includes("install"), false, corp.glossary[id]?.title);
  }
  const runner = match.snapshotForToken(match.tokens.runner);
  const grip = (runner.view as { self: { hand: string[] } }).self.hand;
  assert.ok(grip.some((id) => (runner.glossary[id]?.cost ?? "").includes("install")));
  const hiddenFrom = (token: string) =>
    new Set(Object.values(match.snapshotForToken(token).glossary).map((card) => card.code));
  const runnerCodes = hiddenFrom(match.tokens.runner);
  const spectator = match.snapshotForRole("spectator");
  const spectatorCodes = new Set(Object.values(spectator.glossary).map((card) => card.code));
  for (const code of codes) {
    assert.ok(code);
    assert.equal(runnerCodes.has(code), false, code);
    assert.equal(spectatorCodes.has(code), false, code);
  }
});

test("a seat is not offered an install it cannot pay for", async () => {
  const match = createMatch({ setup: seededSetup });
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
        item.intent.type === "choose_option" ||
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
  const match = createMatch({ setup: seededSetup });
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
  // A server with no ice still has a Movement Phase: the Runner may jack
  // out before approaching the server (CR 6.9.1f, 6.9.4c).
  const moving = match.snapshotForToken(match.tokens.runner);
  assert.ok(moving.legal.some((item) => item.intent.type === "jack_out"));
  const onward = moving.legal.find((item) => item.intent.type === "continue_run");
  assert.ok(onward, moving.legal.map((item) => item.label).join(" | "));
  await match.submit(match.tokens.runner, "continue-rd", onward.intent);
  const breach = match.snapshotForToken(match.tokens.runner);
  const access = breach.legal.find((item) => item.intent.type === "access_card");
  assert.ok(access);
  assert.equal(access.label, "Access the top card of R&D");
  const hidden = secretCardIds(match, "corp");
  const before = JSON.stringify(breach);
  for (const id of hidden) assert.equal(before.includes(id), false, id);
  for (const id of hidden) assert.equal(JSON.stringify(access.intent).includes(id), false);
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
      const state = learnToPlaySetup(SEED);
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
  const state = learnToPlaySetup(SEED);
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
    destination: { kind: "installed" },
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
  assert.equal(
    queryLegality(installed.state).legal.some(
      (entry) => entry.action.type === "use_paid_ability" && entry.action.abilityId === "smartware-load",
    ),
    false,
  );
  const atTakeAction = (current: typeof installed.state) => {
    assert.equal(current.timingKey, "runner.actionPaw");
    const passed = applyIntent(current, { type: "pass_window" });
    assert.equal(passed.ok, true);
    if (!passed.ok) return current;
    assert.equal(passed.state.timingKey, "runner.takeAction");
    return passed.state;
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
  assert.equal(paid.state.runner.installed.includes(card.id), true);
  paid.state.cards[card.id]!.hostedCredits = 1;
  const last = applyIntent(atTakeAction(paid.state), take);
  assert.equal(last.ok, true);
  if (!last.ok) return;
  assert.equal(last.state.cards[card.id]?.hostedCredits, 0);
  assert.equal(last.state.runner.installed.includes(card.id), true);
  const back = atTakeAction(last.state);
  const offered = queryLegality(back).legal.some(
    (entry) => entry.action.type === "use_paid_ability" && entry.action.abilityId === "smartware-take",
  );
  assert.equal(offered, false);
  const empty = applyIntent(back, take);
  assert.equal(empty.ok, false);
  assert.equal(last.state.runner.installed.includes(card.id), true);
  assert.equal(last.state.runner.credits, before + 2);
});

test("the runner does not learn the name of an unrezzed Corp install", async () => {
  const match = createMatch({ setup: seededSetup });
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

/** A deal whose opening Corp hand holds an asset. */
function setupWithCorpAsset(): () => ReturnType<typeof learnToPlaySetup> {
  for (let seed = 1; seed < 200; seed += 1) {
    const dealt = learnToPlaySetup(seed);
    if (dealt.corp.hand.some((id) => dealt.cards[id]?.type === "asset")) {
      return () => learnToPlaySetup(seed);
    }
  }
  throw new Error("No seed deals the Corp an asset");
}

test("declining to rez an installed asset is not written to the log", async () => {
  const match = createMatch({ setup: setupWithCorpAsset() });
  await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "keep-runner", { type: "keep_starting_hand" });
  let corp = match.snapshotForToken(match.tokens.corp);
  for (let n = 0; n < 6 && !corp.legal.some((item) => item.intent.type === "basic_install"); n += 1) {
    const pass = corp.legal.find((item) => item.intent.type === "pass_window");
    assert.ok(pass);
    await match.submit(match.tokens.corp, `pass-${n}`, pass.intent);
    corp = match.snapshotForToken(match.tokens.corp);
  }
  const install = corp.legal.find((item) => {
    if (item.intent.type !== "basic_install" || item.intent.destination.kind !== "new_remote") return false;
    return corp.glossary[item.intent.cardId]?.type === "asset";
  });
  assert.ok(install);
  await match.submit(match.tokens.corp, "install", install.intent);
  const installed = match.snapshotForToken(match.tokens.corp);
  const installSeq = installed.log.at(-1)!.seq;
  assert.match(installed.log.at(-1)?.summary ?? "", /Install /);
  const decline = installed.legal.find((item) => item.intent.type === "pass_window");
  assert.ok(decline);
  await match.submit(match.tokens.corp, "decline-rez", decline.intent);
  for (const token of [match.tokens.corp, match.tokens.runner, match.tokens.log]) {
    const shown = match.snapshotForToken(token);
    assert.equal(shown.log.some((entry) => /Pass/.test(entry.summary)), false);
    assert.equal(shown.log.at(-1)?.seq, installSeq);
    assert.ok(shown.logPosition > installSeq);
  }
  assert.match(JSON.stringify(match.gameLog()), /Pass/);
  const rewound = await match.seek(match.tokens.log, installSeq);
  assert.equal(rewound.logPosition, installSeq);
  const again = match.snapshotForToken(match.tokens.corp);
  assert.ok(again.legal.some((item) => item.intent.type === "pass_window"));
  assert.ok(again.legal.some((item) => item.intent.type === "rez_asset"));
});

test("archives offers only the latest card, faceup or facedown", () => {
  const faceupOnTop = learnToPlaySetup(SEED);
  const facedownId = faceupOnTop.corp.hand[0];
  const faceupId = faceupOnTop.corp.deck[0];
  assert.ok(facedownId && faceupId);
  const bury = (id: string, faceup: boolean) => {
    faceupOnTop.corp.hand = faceupOnTop.corp.hand.filter((cardId) => cardId !== id);
    faceupOnTop.corp.deck = faceupOnTop.corp.deck.filter((cardId) => cardId !== id);
    faceupOnTop.corp.discardPile.push(id);
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
  const runnerTop = (runner.view as { opponent: { discardPileTop: { faceup: boolean; id?: string } } }).opponent.discardPileTop;
  const corpTop = (corp.view as { self: { discardPileTop: { faceup: boolean; id?: string } } }).self.discardPileTop;
  const spectatorTop = (watching.view as { corp: { discardPileTop: { faceup: boolean; id?: string } } }).corp.discardPileTop;
  assert.deepEqual(runnerTop, { faceup: true, id: faceupId });
  assert.deepEqual(corpTop, { faceup: true, id: faceupId });
  assert.deepEqual(spectatorTop, { faceup: true, id: faceupId });
  assert.equal(runner.glossary[faceupId]?.title, faceupOnTop.cards[faceupId]?.title);
  assert.equal(JSON.stringify(runner).includes(facedownId), false);

  const facedownOnTop = learnToPlaySetup(SEED);
  const older = facedownOnTop.corp.deck[0];
  const newer = facedownOnTop.corp.hand[0];
  assert.ok(older && newer);
  const stack = (id: string, faceup: boolean) => {
    facedownOnTop.corp.hand = facedownOnTop.corp.hand.filter((cardId) => cardId !== id);
    facedownOnTop.corp.deck = facedownOnTop.corp.deck.filter((cardId) => cardId !== id);
    facedownOnTop.corp.discardPile.push(id);
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
    (hiddenRunner.view as { opponent: { discardPileTop: unknown } }).opponent.discardPileTop,
    { faceup: false },
  );
  assert.deepEqual(
    (hiddenCorp.view as { self: { discardPileTop: unknown } }).self.discardPileTop,
    { faceup: false },
  );
  assert.equal(JSON.stringify(hiddenRunner).includes(newer), false);
  assert.equal(JSON.stringify(hidden.snapshotForRole("spectator")).includes(newer), false);
});

test("the heap offers only the latest card, and a faceup card is visible", () => {
  const state = learnToPlaySetup(SEED);
  const older = state.runner.deck[0];
  const newer = state.runner.hand[0];
  assert.ok(older && newer);
  const bury = (id: string) => {
    state.runner.hand = state.runner.hand.filter((cardId) => cardId !== id);
    state.runner.deck = state.runner.deck.filter((cardId) => cardId !== id);
    state.runner.discardPile.push(id);
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
  assert.deepEqual((runner.view as { self: { discardPileTop: unknown } }).self.discardPileTop, expected);
  assert.deepEqual((corp.view as { opponent: { discardPileTop: unknown } }).opponent.discardPileTop, expected);
  assert.deepEqual((watching.view as { runner: { discardPileTop: unknown } }).runner.discardPileTop, expected);
  assert.equal(corp.glossary[newer]?.title, state.cards[newer]?.title);
  assert.equal(corp.glossary[older]?.title, state.cards[older]?.title);
});

test("concede ends the game and the match stays available", async () => {
  const match = createMatch({ setup: seededSetup });
  await match.concede(match.tokens.corp);
  const result = match.result();
  assert.equal(result.done, true);
  assert.equal(result.winner, "runner");
  assert.equal(result.hostEnd, "concede");
  assert.equal(getMatch(match.id), match);
  await assert.rejects(() => match.submit(match.tokens.runner, "late", { type: "pass_window" }), /over/);
});

test("an advanced facedown card shows its advancement counters to every seat", () => {
  const state = learnToPlaySetup(SEED);
  const agenda = Object.values(state.cards).find((card) => card.defId === "offworld-office");
  assert.ok(agenda);
  state.corp.deck = state.corp.deck.filter((id) => id !== agenda.id);
  state.corp.hand = state.corp.hand.filter((id) => id !== agenda.id);
  agenda.zone = "server:remote-1:root";
  agenda.rezzed = false;
  agenda.faceup = false;
  agenda.advancementCounters = 1;
  state.servers["remote-1"] = { id: "remote-1", kind: "remote", ice: [], root: [agenda.id] };

  const match = createMatch({ setup: () => state });
  const installed = (snap: ReturnType<typeof match.snapshotForToken>) => {
    const servers = (snap.view as { servers: { root?: { title: string | null; advancementCounters?: number | null }[] }[] }).servers;
    return servers.find((server) => (server as { id?: string }).id === "remote-1")?.root?.[0]
      ?? servers.flatMap((server) => server.root ?? []).find((card) => (card.advancementCounters ?? 0) > 0);
  };
  const corpCard = installed(match.snapshotForToken(match.tokens.corp));
  const watching = installed(match.snapshotForRole("spectator"));
  assert.equal(corpCard?.advancementCounters, 1);
  assert.equal(corpCard?.title, "Offworld Office");
  assert.equal(watching?.advancementCounters, 1);
  assert.equal(watching?.title ?? null, null);
});

test("hosted credits show on the card for every seat", () => {
  const state = learnToPlaySetup(SEED);
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
  program.zone = "runner:installed";
  program.faceup = true;
  program.hostedCredits = 3;
  state.runner.installed = [program.id];

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

  const installedHosted = (entries: unknown) => {
    const list = entries as Array<string | { id?: string; hosted?: number; title?: string }>;
    const found = list.find((entry) => (typeof entry === "string" ? entry === program.id : entry.id === program.id || entry.title === "Smartware Distributor"));
    return typeof found === "string" ? corp.glossary[found]?.hosted : found?.hosted;
  };
  assert.equal(installedHosted((corp.view as { opponent: { installed: unknown } }).opponent.installed), 3);
  assert.equal(installedHosted((runner.view as { self: { installed: unknown } }).self.installed), 3);
  assert.equal(installedHosted((watching.view as { runner: { installed: unknown } }).runner.installed), 3);
  const watchingInstalled = (watching.view as { runner: { installed: { title?: string; type?: string; code?: string }[] } }).runner.installed[0];
  assert.equal(watchingInstalled?.title, "Smartware Distributor");
  assert.equal(watchingInstalled?.type, "resource");
  assert.match(watchingInstalled?.code ?? "", /^\d{5}$/);
});

test("every seat sees both identity cards", () => {
  const match = createMatch({ setup: seededSetup });
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

test("a flipped identity shows its faceup face name (CR 3.1.1a)", () => {
  const state = learnToPlaySetup(SEED);
  const corpIdentity = state.cards[state.corp.identityId];
  assert.ok(corpIdentity);
  // The pinned engine predates identityFaces in the data; inject the faces
  // the current cards data stores, then flip the identity.
  (corpIdentity as { identityFaces?: Array<{ title: string }> }).identityFaces = [
    { title: corpIdentity.title },
    { title: "Earth Station: Ascending to Orbit" },
  ];
  corpIdentity.identityFlipped = true;

  const match = createMatch({ setup: () => state });
  const watching = match.snapshotForRole("spectator");
  const corpView = (watching.view as { corp: { identity: string | null } }).corp;
  assert.equal(corpView.identity, "Earth Station: Ascending to Orbit");
  assert.equal(watching.glossary[state.corp.identityId]?.title, "Earth Station: Ascending to Orbit");

  corpIdentity.identityFlipped = false;
  const unflipped = createMatch({ setup: () => state }).snapshotForRole("spectator");
  assert.equal(
    (unflipped.view as { corp: { identity: string | null } }).corp.identity,
    corpIdentity.title,
  );
});

test("a spectator sees the face of a rezzed card", () => {
  const state = learnToPlaySetup(SEED);
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
  assert.equal((card as { id?: string } | undefined)?.id, shown.id);
});

test("the Corp can see which ice an installed Runner card has chosen", () => {
  const state = learnToPlaySetup(SEED);
  const program = Object.values(state.cards).find((card) => card.defId === "smartware-distributor");
  const ice = Object.values(state.cards).find((card) => card.type === "ice");
  assert.ok(program);
  assert.ok(ice);
  state.runner.deck = state.runner.deck.filter((id) => id !== program.id);
  state.runner.hand = state.runner.hand.filter((id) => id !== program.id);
  program.zone = "runner:installed";
  program.faceup = true;
  program.chosenIceId = ice.id;
  ice.rezzed = true;
  ice.faceup = true;
  ice.zone = "server:hq:ice";
  state.corp.deck = state.corp.deck.filter((id) => id !== ice.id);
  state.corp.hand = state.corp.hand.filter((id) => id !== ice.id);
  state.servers.hq.ice = [...new Set([...state.servers.hq.ice, ice.id])];
  state.runner.installed = [program.id];

  const match = createMatch({ setup: () => state });
  const chosen = (entries: unknown) => {
    const list = entries as Array<string | { id?: string; chosenIceId?: string }>;
    const found = list.find((entry) => (typeof entry === "string" ? entry === program.id : entry.id === program.id));
    return typeof found === "string" ? undefined : found?.chosenIceId;
  };
  const corp = match.snapshotForToken(match.tokens.corp);
  const watching = match.snapshotForRole("spectator");
  assert.equal(chosen((corp.view as { opponent: { installed: unknown } }).opponent.installed), ice.id);
  assert.equal(chosen((watching.view as { runner: { installed: unknown } }).runner.installed), ice.id);
});

test("describeIntent uses Pass for pass_window and finish_access", () => {
  const state = learnToPlaySetup(SEED);
  assert.equal(describeIntent(state, { type: "pass_window" }), "Pass");
  assert.equal(describeIntent(state, { type: "finish_access" }), "Pass (mid-access)");
});

test("a card id says nothing about the card", async () => {
  const dealt = learnToPlaySetup(SEED);
  const slugs = new Set(
    Object.values(dealt.cards).flatMap((card) => (card.defId ? [card.defId] : [])),
  );
  for (const card of Object.values(dealt.cards)) {
    if (card.type === "identity") continue;
    assert.match(card.id, /^[cr]_[0-9a-z]{6}$/);
    for (const slug of slugs) assert.equal(card.id.includes(slug), false, card.id);
  }
  // Two copies of one card cannot be told apart by id, and the ids do not
  // follow the order of the deck list.
  const again = learnToPlaySetup(SEED + 1);
  const firstIds = Object.keys(dealt.cards).filter((id) => id.startsWith("c_")).sort();
  const otherIds = Object.keys(again.cards).filter((id) => id.startsWith("c_")).sort();
  assert.notDeepEqual(firstIds, otherIds);
  // The same seed deals the same ids, so a stored log replays.
  assert.deepEqual(Object.keys(learnToPlaySetup(SEED).cards).sort(), Object.keys(dealt.cards).sort());

  const match = createMatch({ setup: setupWithCorpAsset() });
  await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "keep-runner", { type: "keep_starting_hand" });
  const corp = match.snapshotForToken(match.tokens.corp);
  const install = corp.legal.find(
    (item) =>
      item.intent.type === "basic_install" &&
      item.intent.destination.kind === "new_remote" &&
      corp.glossary[item.intent.cardId]?.type === "asset",
  );
  assert.ok(install);
  assert.ok(install.intent.type === "basic_install");
  const installedId = install.intent.cardId;
  const slug = corp.glossary[installedId]?.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  assert.ok(slug);
  await match.submit(match.tokens.corp, "install", install.intent);
  const runner = JSON.stringify(match.snapshotForToken(match.tokens.runner));
  // The Runner sees that a card is there, by an id that does not name it.
  assert.equal(runner.includes(installedId), true);
  assert.equal(runner.includes(slug), false, slug);
});

test("no seat receives the random stream or the id counter", async () => {
  const match = createMatch({ setup: seededSetup });
  await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
  for (const role of ["corp", "runner", "spectator", "log"] as const) {
    const wire = JSON.stringify(match.snapshotForRole(role));
    for (const key of ["rngState", "idSeq", "activeOrder"]) {
      assert.equal(wire.includes(key), false, `${role} ${key}`);
    }
  }
});

test("a Corp over its hand size picks the discard, and the Runner does not learn it", async () => {
  const match = createMatch({ setup: seededSetup });
  await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "keep-runner", { type: "keep_starting_hand" });
  let corp = match.snapshotForToken(match.tokens.corp);
  let picked: { id: string; title: string } | undefined;
  for (let n = 0; n < 12; n += 1) {
    corp = match.snapshotForToken(match.tokens.corp);
    if (String((corp.view as { timingKey: string }).timingKey).startsWith("runner.")) break;
    const options = corp.legal.filter((item) => item.intent.type === "choose_option");
    if (options.length > 0) {
      // Six cards in HQ and a hand size of five: every card is offered.
      assert.equal(options.length, 6);
      const pick = options.at(-2)!;
      assert.ok(pick.intent.type === "choose_option");
      const id = pick.intent.optionId.replace(/^choose-card:/, "");
      picked = { id, title: corp.glossary[id]!.title };
      await match.submit(match.tokens.corp, `corp-${n}`, pick.intent);
      continue;
    }
    const next =
      corp.legal.find((item) => item.intent.type === "basic_gain_credit") ??
      corp.legal.find((item) => item.intent.type === "discard_to_hand_size") ??
      corp.legal.find((item) => item.intent.type === "pass_window");
    assert.ok(next, corp.legal.map((item) => item.label).join(" | "));
    await match.submit(match.tokens.corp, `corp-${n}`, next.intent);
  }
  assert.ok(picked, "the Corp was asked which card to discard");
  const after = match.snapshotForToken(match.tokens.corp);
  const corpView = after.view as { self: { hand: string[] } };
  assert.equal(corpView.self.hand.length, 5);
  assert.equal(corpView.self.hand.includes(picked.id), false);
  // The Corp's own record names the card.
  assert.ok(after.log.some((entry) => entry.summary.includes(picked!.title)));

  // The discard came from HQ, so it is facedown in Archives (CR 4.4.6b).
  // The Runner's hand may hold a card of the same name, so check the log
  // and the Archives the Runner is sent rather than the whole snapshot.
  const runner = match.snapshotForToken(match.tokens.runner);
  const runnerView = runner.view as {
    opponent: { discardPileCount: number; discardPileFaceup?: string[] };
  };
  assert.equal(runnerView.opponent.discardPileCount, 1);
  assert.deepEqual(runnerView.opponent.discardPileFaceup ?? [], []);
  assert.equal(runner.glossary[picked.id]?.title, undefined);
  for (const entry of runner.log) {
    if (entry.seat !== "corp") continue;
    assert.equal(entry.summary.includes(picked.title), false, entry.summary);
  }
  assert.ok(runner.log.some((entry) => entry.summary === "Corp: Choose a hidden card"));
  for (const role of ["spectator", "log"] as const) {
    const shown = match.snapshotForRole(role);
    assert.equal(shown.log.some((entry) => entry.summary.includes(picked!.title)), false, role);
  }
});

/** The seeded deal, both hands kept, with the Corp about to take an action. */
function atCorpTakeAction(): GameState {
  let state = learnToPlaySetup(SEED);
  const step = (intent: Intent) => {
    const applied = applyIntent(state, intent);
    assert.ok(applied.ok, applied.ok ? "" : applied.error);
    state = applied.state;
  };
  step({ type: "keep_starting_hand" });
  step({ type: "keep_starting_hand" });
  for (let n = 0; n < 8 && state.timingKey !== "corp.takeAction"; n += 1) step({ type: "pass_window" });
  assert.equal(state.timingKey, "corp.takeAction");
  return state;
}

/** The match's own board, which names every card. Only the debug view carries it. */
function boardOf(match: ReturnType<typeof createMatch>) {
  const board = match.snapshotForRole("debug").debug?.board;
  assert.ok(board);
  return board;
}

function cardOn(match: ReturnType<typeof createMatch>, id: string) {
  const board = boardOf(match);
  const piles = [
    board.corp.hand,
    board.corp.deck,
    board.corp.discard,
    ...board.servers.flatMap((server) => [server.ice, server.root]),
  ];
  const card = piles.flat().find((entry) => entry.id === id);
  assert.ok(card, id);
  return card;
}

test("a revealed card is written to every reader's log, and stays hidden on the board (CR 1.21.3)", async () => {
  const state = learnToPlaySetup(SEED);
  const atlas = instantiateCard("project-atlas", "atlas-1", "corp:score");
  atlas.faceup = true;
  atlas.agendaCounters = 1;
  state.cards["atlas-1"] = atlas;
  state.corp.scoreArea.push("atlas-1");
  const match = createMatch({ setup: () => state });
  await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "keep-runner", { type: "keep_starting_hand" });

  // The search is a paid ability, so the Corp's first window stays open for it.
  let corp = match.snapshotForToken(match.tokens.corp);
  const search = corp.legal.find(
    (item) => item.intent.type === "use_paid_ability" && item.intent.cardId === "atlas-1",
  );
  assert.ok(search, corp.legal.map((item) => item.label).join(" | "));
  await match.submit(match.tokens.corp, "search", search.intent);
  corp = match.snapshotForToken(match.tokens.corp);
  const pick = corp.legal.find((item) => item.intent.type === "choose_option");
  assert.ok(pick && pick.intent.type === "choose_option");
  const id = pick.intent.optionId.replace(/^choose-card:/, "");
  const title = cardOn(match, id).title;
  await match.submit(match.tokens.corp, "pick", pick.intent);

  const line = `Project Atlas reveals ${title}`;
  for (const role of ["corp", "runner", "spectator", "log"] as const) {
    const shown = match.snapshotForRole(role);
    assert.ok(shown.log.at(-1)?.summary.endsWith(line), `${role}: ${shown.log.at(-1)?.summary}`);
  }
  // The card went to HQ. The Runner read its name once and cannot follow it there.
  const runner = match.snapshotForToken(match.tokens.runner);
  assert.equal(JSON.stringify(runner).includes(id), false);
  assert.equal(runner.glossary[id], undefined);
  assert.equal(cardOn(match, id).zone, "corp:hq");
  assert.equal(cardOn(match, id).faceup, false);
});

test("a Corp install says what it trashes, and the Runner is not told a facedown card's name (CR 8.5.6, 8.5.7)", async () => {
  const state = atCorpTakeAction();
  const place = (defId: string, id: string, zone: ZoneId) => {
    const card = instantiateCard(defId, id, zone);
    state.cards[id] = card;
    return card;
  };
  place("ice-wall", "hq-ice", "server:hq:ice");
  state.servers.hq.ice = ["hq-ice"];
  const oldAsset = place("pad-campaign", "old-asset", "server:remote-1:root");
  oldAsset.rezzed = true;
  oldAsset.faceup = true;
  state.servers["remote-1"] = { id: "remote-1", kind: "remote", ice: [], root: ["old-asset"] };
  state.nextRemoteNumber = 2;
  state.corp.installed.push("hq-ice", "old-asset");
  place("enigma", "new-ice", "corp:hq");
  place("pad-campaign", "new-asset", "corp:hq");
  state.corp.hand.push("new-ice", "new-asset");
  state.corp.credits = 5;
  const match = createMatch({ setup: () => state });

  let corp = match.snapshotForToken(match.tokens.corp);
  const trashFirst = corp.legal.find(
    (item) =>
      item.intent.type === "basic_install" &&
      item.intent.cardId === "new-ice" &&
      item.intent.destination.kind === "protect" &&
      item.intent.destination.serverId === "hq" &&
      item.intent.trashFirst === true,
  );
  assert.ok(trashFirst, corp.legal.map((item) => item.label).join(" | "));
  assert.match(trashFirst.label, /^Install Enigma protecting HQ, trashing cards there first/);
  const replace = corp.legal.find(
    (item) =>
      item.intent.type === "basic_install" &&
      item.intent.cardId === "new-asset" &&
      item.intent.destination.kind === "remote_root",
  );
  assert.ok(replace);
  assert.match(replace.label, /^Install PAD Campaign in remote 1, trashing the card it replaces/);

  // Trash the unrezzed ice first; the new ice then costs nothing (CR 8.5.6b).
  await match.submit(match.tokens.corp, "install-ice", trashFirst.intent);
  for (let n = 0; n < 3; n += 1) {
    corp = match.snapshotForToken(match.tokens.corp);
    const options = corp.legal.filter((item) => item.intent.type === "choose_option");
    if (options.length === 0) break;
    const next =
      options.find((item) => item.intent.type === "choose_option" && item.intent.optionId === "cost-card:hq-ice") ??
      options.find((item) => item.intent.type === "choose_option" && item.intent.optionId === "cost-card-done");
    assert.ok(next, options.map((item) => item.label).join(" | "));
    await match.submit(match.tokens.corp, `trash-${n}`, next.intent);
  }
  const board = boardOf(match);
  assert.deepEqual(
    board.servers.find((server) => server.id === "hq")?.ice.map((card) => card.id),
    ["new-ice"],
  );
  assert.equal(cardOn(match, "hq-ice").zone, "corp:archives");
  assert.equal(cardOn(match, "hq-ice").faceup, false);
  assert.equal(board.corp.credits, 5);

  let runner = match.snapshotForToken(match.tokens.runner);
  const corpLines = () => runner.log.filter((entry) => entry.seat === "corp").map((entry) => entry.summary);
  assert.ok(corpLines().some((line) => line.startsWith("Corp: Install a card protecting HQ, trashing cards there first")));
  for (const line of corpLines()) {
    assert.equal(/Ice Wall|Enigma/.test(line), false, line);
  }
  const runnerView = runner.view as { opponent: { discardPileFaceup?: string[] } };
  assert.equal((runnerView.opponent.discardPileFaceup ?? []).includes("Ice Wall"), false);

  // The rezzed asset is replaced; both players can see it go (CR 8.5.6a).
  corp = match.snapshotForToken(match.tokens.corp);
  const replaceNow = corp.legal.find(
    (item) =>
      item.intent.type === "basic_install" &&
      item.intent.cardId === "new-asset" &&
      item.intent.destination.kind === "remote_root" &&
      !item.intent.trashFirst,
  );
  assert.ok(replaceNow);
  await match.submit(match.tokens.corp, "install-asset", replaceNow.intent);
  assert.deepEqual(
    boardOf(match).servers.find((server) => server.id === "remote-1")?.root.map((card) => card.id),
    ["new-asset"],
  );
  assert.equal(cardOn(match, "old-asset").zone, "corp:archives");
  assert.equal(cardOn(match, "old-asset").faceup, true);
  runner = match.snapshotForToken(match.tokens.runner);
  assert.ok(
    corpLines().some((line) => line.startsWith("Corp: Install a card in remote 1, trashing the card it replaces")),
    corpLines().join(" | "),
  );
});

test("describeIntent names the two ways to finish a sabotage (CR 10.12.2)", () => {
  const state = learnToPlaySetup(SEED);
  assert.equal(
    describeIntent(state, { type: "resolve_sabotage", hqCardIds: [] }),
    "Sabotage: trash from the top of R&D",
  );
  assert.equal(
    describeIntent(state, { type: "resolve_sabotage", hqCardIds: ["x"] }),
    "Sabotage: trash the chosen HQ cards",
  );
});

/** Keep both hands, then have the Corp take credits until the Runner's turn. */
async function toRunnerTurn(match: ReturnType<typeof createMatch>): Promise<void> {
  await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "keep-runner", { type: "keep_starting_hand" });
  for (let i = 0; i < 8; i += 1) {
    const corp = match.snapshotForToken(match.tokens.corp);
    if (String((corp.view as { timingKey: string }).timingKey).startsWith("runner.")) return;
    const choice =
      corp.legal.find((item) => item.intent.type === "basic_gain_credit") ??
      corp.legal.find((item) => item.intent.type === "pass_window" || item.intent.type === "discard_to_hand_size") ??
      corp.legal[0];
    assert.ok(choice);
    await match.submit(match.tokens.corp, `corp-${i}`, choice.intent);
  }
  assert.fail("the Runner's turn did not start");
}

/** Board cards with the names the match itself knows. */
function named(cards: ReadonlyArray<{ id: string; title?: string }>): Array<{ id: string; title: string }> {
  return cards.map((card) => {
    assert.ok(card.title, card.id);
    return { id: card.id, title: card.title };
  });
}

/** A match whose R&D has this card on top once the Corp has drawn for the turn. */
function matchWithRdTop(defId: string) {
  const state = learnToPlaySetup(SEED);
  state.cards["top-1"] = instantiateCard(defId, "top-1", "corp:rd");
  state.corp.deck.splice(1, 0, "top-1");
  return createMatch({ setup: () => state });
}

async function accessTopOfRd(match: ReturnType<typeof createMatch>) {
  await toRunnerTurn(match);
  assert.equal(boardOf(match).corp.deck[0]?.id, "top-1");
  const step = async (name: string, wanted: (intent: Intent) => boolean) => {
    const runner = match.snapshotForToken(match.tokens.runner);
    const item = runner.legal.find((entry) => wanted(entry.intent));
    assert.ok(item, `${name}: ${runner.legal.map((entry) => entry.label).join(" | ")}`);
    return match.submit(match.tokens.runner, name, item.intent);
  };
  await step("run-rd", (intent) => intent.type === "basic_run" && intent.serverId === "rd");
  await step("continue-rd", (intent) => intent.type === "continue_run");
  return step("access-rd", (intent) => intent.type === "access_card");
}

test("the Corp is not shown a card the Runner accesses from R&D (CR 7.1.2)", async () => {
  const match = matchWithRdTop("hedge-fund");
  const runner = await accessTopOfRd(match);
  // The access is over: the card has no trash cost and stays in R&D.
  assert.equal(cardOn(match, "top-1").zone, "corp:rd");
  assert.equal(runner.access?.title, "Hedge Fund");
  assert.equal(runner.log.at(-1)?.summary, "Runner: Access Hedge Fund");
  for (const role of ["corp", "spectator", "log"] as const) {
    const shown = match.snapshotForRole(role);
    assert.equal(shown.access, undefined, role);
    assert.equal(shown.log.at(-1)?.summary, "Runner: Access the top card of R&D", role);
    assert.equal(shown.glossary["top-1"], undefined, role);
  }
});

test("the Corp is not shown a card the Runner is still accessing from R&D (CR 7.1.2)", async () => {
  const match = matchWithRdTop("pad-campaign");
  const runner = await accessTopOfRd(match);
  // The Runner has yet to decide whether to pay the trash cost.
  assert.equal((runner.view as { run?: { accessingCardId?: string } }).run?.accessingCardId, "top-1");
  assert.equal(runner.glossary["top-1"]?.title, "PAD Campaign");
  assert.equal(runner.log.at(-1)?.summary, "Runner: Access PAD Campaign");
  for (const role of ["corp", "spectator", "log"] as const) {
    const shown = match.snapshotForRole(role);
    assert.equal(shown.glossary["top-1"], undefined, role);
    assert.equal(shown.log.at(-1)?.summary, "Runner: Access the top card of R&D", role);
    assert.equal(JSON.stringify(shown.log).includes("PAD Campaign"), false, role);
  }
});

test("only the Corp reads the cards it looks at in R&D (CR 1.21.2, 1.21.6)", async () => {
  const state = learnToPlaySetup(SEED);
  state.cards["precog-1"] = instantiateCard("precognition", "precog-1", "corp:hq");
  state.corp.hand.push("precog-1");
  const match = createMatch({ setup: () => state });
  await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "keep-runner", { type: "keep_starting_hand" });
  let corp = match.snapshotForToken(match.tokens.corp);
  const play = corp.legal.find(
    (item) => item.intent.type === "play_operation" && item.intent.cardId === "precog-1",
  );
  assert.ok(play, corp.legal.map((item) => item.label).join(" | "));
  const top = named(boardOf(match).corp.deck.slice(0, 5));
  assert.equal(top.length, 5);
  corp = await match.submit(match.tokens.corp, "precognition", play.intent);

  // The Corp reads the five cards, in its choices and in its own log line.
  const line = corp.log.at(-1)?.summary ?? "";
  assert.match(line, / — Precognition looks at /);
  for (const card of top) {
    assert.ok(line.includes(card.title), `${card.title}: ${line}`);
    assert.equal(corp.glossary[card.id]?.title, card.title);
  }
  assert.ok(corp.legal.some((item) => item.intent.type === "choose_option"));

  // Nobody else reads them: not in the log, the choice, or the glossary.
  const elsewhere = new Set(
    [...boardOf(match).corp.hand, ...boardOf(match).corp.discard].map((card) => card.title),
  );
  for (const role of ["runner", "spectator", "log"] as const) {
    const shown = match.snapshotForRole(role);
    const text = JSON.stringify(shown);
    assert.equal(text.includes("looks at"), false, role);
    for (const card of top) {
      assert.equal(text.includes(`"${card.id}"`), false, `${role} ${card.id}`);
      assert.equal(shown.glossary[card.id], undefined, `${role} ${card.id}`);
      if (!elsewhere.has(card.title)) assert.equal(text.includes(card.title), false, `${role} ${card.title}`);
    }
  }

  // The look ends with the ability (CR 1.21.6).
  for (let i = 0; i < 6; i += 1) {
    const pick = corp.legal.find((item) => item.intent.type === "choose_option");
    if (!pick) break;
    corp = await match.submit(match.tokens.corp, `arrange-${i}`, pick.intent);
  }
  assert.equal(corp.legal.some((item) => item.intent.type === "choose_option"), false);
  for (const card of top) assert.equal(corp.glossary[card.id], undefined, card.id);
  for (const card of boardOf(match).corp.deck) assert.equal(card.faceup, false, card.id);
});

test("only the Corp reads the cards Accelerated Diagnostics offers to play, and it may play none (CR 1.21.2, 8.6.3)", async () => {
  const state = learnToPlaySetup(SEED);
  state.cards["ad-1"] = instantiateCard("accelerated-diagnostics", "ad-1", "corp:hq");
  state.corp.hand.push("ad-1");
  // The first card is the Corp's mandatory draw.
  const planted = [
    ["hedge-fund", "ad-draw"],
    ["beanstalk-royalties", "ad-top-1"],
    ["green-level-clearance", "ad-top-2"],
    ["project-atlas", "ad-top-3"],
  ] as const;
  for (const [defId, id] of [...planted].reverse()) {
    state.cards[id] = instantiateCard(defId, id, "corp:rd");
    state.corp.deck.unshift(id);
  }
  const match = createMatch({ setup: () => state });
  await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "keep-runner", { type: "keep_starting_hand" });
  let corp = match.snapshotForToken(match.tokens.corp);
  const play = corp.legal.find(
    (item) => item.intent.type === "play_operation" && item.intent.cardId === "ad-1",
  );
  assert.ok(play, corp.legal.map((item) => item.label).join(" | "));
  const top = named(boardOf(match).corp.deck.slice(0, 3));
  assert.deepEqual(top.map((card) => card.id), ["ad-top-1", "ad-top-2", "ad-top-3"]);
  const archivesBefore = boardOf(match).corp.discard.length;
  corp = await match.submit(match.tokens.corp, "diagnostics", play.intent);

  // The Corp is offered each operation by name, and may play none.
  const picks = corp.legal.filter((item) => item.intent.type === "choose_option");
  const optionIds = picks.map((item) => (item.intent.type === "choose_option" ? item.intent.optionId : ""));
  assert.deepEqual(
    [...optionIds].sort(),
    ["play-looked:ad-top-1", "play-looked:ad-top-2", "play-looked:none"],
    picks.map((item) => item.label).join(" | "),
  );
  assert.ok(picks.some((item) => item.label.includes("Beanstalk Royalties")));
  assert.ok(picks.some((item) => item.label.includes("Green Level Clearance")));

  // Nobody else reads the three cards.
  const elsewhere = new Set(
    [...boardOf(match).corp.hand, ...boardOf(match).corp.discard].map((card) => card.title),
  );
  for (const role of ["runner", "spectator", "log"] as const) {
    const shown = match.snapshotForRole(role);
    const text = JSON.stringify(shown);
    assert.equal(text.includes("looks at"), false, role);
    for (const card of top) {
      assert.equal(text.includes(`"${card.id}"`), false, `${role} ${card.id}`);
      assert.equal(shown.glossary[card.id], undefined, `${role} ${card.id}`);
      if (!elsewhere.has(card.title)) assert.equal(text.includes(card.title), false, `${role} ${card.title}`);
    }
  }

  // Playing none trashes all three, facedown: the Runner never saw them (CR 4.4.6b).
  const none = picks.find(
    (item) => item.intent.type === "choose_option" && item.intent.optionId === "play-looked:none",
  );
  assert.ok(none);
  corp = await match.submit(match.tokens.corp, "play-none", none.intent);
  const discard = boardOf(match).corp.discard;
  assert.equal(discard.length, archivesBefore + 4);
  for (const card of top) {
    const trashed = discard.find((item) => item.id === card.id);
    assert.ok(trashed, card.id);
    assert.equal(trashed.faceup, false, card.id);
  }
  const runner = JSON.stringify(match.snapshotForRole("runner"));
  for (const card of top) {
    if (!elsewhere.has(card.title)) assert.equal(runner.includes(card.title), false, card.title);
  }
});

test("the Corp does not read the cards the Runner searches the stack for (CR 8.7.1, 1.21.3)", async () => {
  const state = learnToPlaySetup(SEED);
  state.cards["favor-1"] = instantiateCard("mutual-favor", "favor-1", "runner:grip");
  state.runner.hand.push("favor-1");
  const match = createMatch({ setup: () => state });
  await toRunnerTurn(match);
  let runner = match.snapshotForToken(match.tokens.runner);
  const play = runner.legal.find(
    (item) => item.intent.type === "play_event" && item.label.startsWith("Play Mutual Favor"),
  );
  assert.ok(play, runner.legal.map((item) => item.label).join(" | "));
  runner = await match.submit(match.tokens.runner, "favor", play.intent);
  const picks = runner.legal.filter((item) => item.intent.type === "choose_option");
  assert.ok(picks.length > 0, runner.legal.map((item) => item.label).join(" | "));
  const stack = named(boardOf(match).runner.deck);
  const breakers = stack.filter((card) => picks.some((item) => item.label.includes(card.title)));
  assert.ok(breakers.length > 0);

  // The Runner is looking at the cards on offer.
  for (const card of breakers) assert.equal(runner.glossary[card.id]?.title, card.title, card.id);

  // The Corp sees that a choice is open, and nothing about the stack.
  for (const role of ["corp", "spectator", "log"] as const) {
    const shown = match.snapshotForRole(role);
    const text = JSON.stringify(shown);
    for (const card of stack) {
      assert.equal(text.includes(`"${card.id}"`), false, `${role} ${card.id}`);
      assert.equal(shown.glossary[card.id], undefined, `${role} ${card.id}`);
    }
    for (const card of breakers) assert.equal(text.includes(card.title), false, `${role} ${card.title}`);
  }

  // Taking a card reveals it, and then every reader's log names it (CR 1.21.3).
  const pick = picks.find((item) => breakers.some((card) => item.label.includes(card.title)));
  assert.ok(pick);
  const found = breakers.find((card) => pick.label.includes(card.title))!;
  await match.submit(match.tokens.runner, "take", pick.intent);
  for (const role of ["corp", "runner", "spectator", "log"] as const) {
    const shown = match.snapshotForRole(role);
    assert.ok(
      shown.log.some((entry) => entry.summary.includes(`Mutual Favor reveals ${found.title}`)),
      `${role}: ${shown.log.at(-1)?.summary}`,
    );
  }
});

test("only the Runner reads the cards Keyhole looks at in R&D (CR 1.21.2)", async () => {
  const state = learnToPlaySetup(SEED);
  const keyhole = instantiateCard("keyhole", "keyhole-1", "runner:installed");
  keyhole.faceup = true;
  state.cards["keyhole-1"] = keyhole;
  state.runner.installed.push("keyhole-1");
  const match = createMatch({ setup: () => state });
  await toRunnerTurn(match);
  const top = named(boardOf(match).corp.deck.slice(0, 3));
  let runner = match.snapshotForToken(match.tokens.runner);
  const use = runner.legal.find((item) => "cardId" in item.intent && item.intent.cardId === "keyhole-1");
  assert.ok(use, runner.legal.map((item) => item.label).join(" | "));
  runner = await match.submit(match.tokens.runner, "keyhole", use.intent);
  for (let i = 0; i < 6 && !runner.legal.some((item) => item.intent.type === "choose_option"); i += 1) {
    const onward =
      runner.legal.find((item) => item.intent.type === "continue_run") ??
      runner.legal.find((item) => item.intent.type === "pass_window");
    assert.ok(onward, runner.legal.map((item) => item.label).join(" | "));
    runner = await match.submit(match.tokens.runner, `onward-${i}`, onward.intent);
  }
  const picks = runner.legal.filter((item) => item.intent.type === "choose_option");
  assert.equal(picks.length, 3, runner.legal.map((item) => item.label).join(" | "));
  for (const card of top) assert.ok(picks.some((item) => item.label.includes(card.title)), card.title);
  assert.ok(runner.log.some((entry) => entry.summary.includes(" — Keyhole looks at ")));

  const elsewhere = new Set(
    [...boardOf(match).corp.hand, ...boardOf(match).corp.discard].map((card) => card.title),
  );
  for (const role of ["corp", "spectator", "log"] as const) {
    const shown = match.snapshotForRole(role);
    const text = JSON.stringify(shown);
    assert.equal(text.includes("looks at"), false, role);
    for (const card of top) {
      assert.equal(shown.glossary[card.id], undefined, `${role} ${card.id}`);
      // The Corp knows its own HQ. A name it reads there is not a leak.
      if (role !== "corp" || !elsewhere.has(card.title)) {
        assert.equal(text.includes(card.title), false, `${role} ${card.title}`);
      }
    }
  }
});

test("Project Yagi-Uda offers the Corp only legal swaps, and the Runner does not read the HQ cards (CR 8.8.2, 1.21.2)", async () => {
  const state = learnToPlaySetup(SEED);
  const yagi = instantiateCard("project-yagi-uda", "yagi-1", "corp:score");
  yagi.agendaCounters = 1;
  state.cards["yagi-1"] = yagi;
  state.corp.scoreArea.push("yagi-1");
  const wall = instantiateCard("ice-wall", "yagi-wall", "server:hq:ice");
  wall.rezzed = true;
  wall.faceup = true;
  state.cards["yagi-wall"] = wall;
  state.servers.hq.ice.unshift("yagi-wall");
  for (const [defId, id] of [
    ["hostile-takeover", "yagi-agenda"],
    ["enigma", "yagi-hq-ice"],
  ] as const) {
    state.cards[id] = instantiateCard(defId, id, "corp:hq");
    state.corp.hand.push(id);
  }
  const match = createMatch({ setup: () => state });
  await toRunnerTurn(match);
  let runner = match.snapshotForToken(match.tokens.runner);
  const run = runner.legal.find((item) => item.intent.type === "basic_run" && item.intent.serverId === "hq");
  assert.ok(run, runner.legal.map((item) => item.label).join(" | "));
  await match.submit(match.tokens.runner, "run-hq", run.intent);

  // Pass windows until the Corp may use Yagi-Uda during the run.
  let use: (typeof runner.legal)[number] | undefined;
  for (let i = 0; i < 10 && !use; i += 1) {
    const corp = match.snapshotForToken(match.tokens.corp);
    use = corp.legal.find(
      (item) => item.intent.type === "use_paid_ability" && item.intent.cardId === "yagi-1",
    );
    if (use) break;
    const seat = corp.legal.some((item) => item.intent.type === "pass_window") ? "corp" : "runner";
    const snap = match.snapshotForToken(match.tokens[seat]);
    const next = snap.legal.find((item) => item.intent.type === "pass_window" || item.intent.type === "continue_run");
    assert.ok(next, `${seat}: ${snap.legal.map((item) => item.label).join(" | ")}`);
    await match.submit(match.tokens[seat], `${seat}-${i}`, next.intent);
  }
  assert.ok(use, "the Corp was never offered Project Yagi-Uda");
  const corp = await match.submit(match.tokens.corp, "yagi", use.intent);

  // Ice for ice only: the agenda is never offered for an ice position or a root.
  const picks = corp.legal.filter((item) => item.intent.type === "choose_option");
  const optionIds = picks.map((item) => (item.intent.type === "choose_option" ? item.intent.optionId : ""));
  assert.ok(optionIds.includes("yagi:yagi-hq-ice:yagi-wall"), optionIds.join(" | "));
  assert.equal(optionIds.some((id) => id.startsWith("yagi:yagi-agenda:")), false, optionIds.join(" | "));
  const ice = new Set(
    boardOf(match).corp.hand.filter((card) => card.type === "ice").map((card) => card.id),
  );
  for (const id of optionIds) assert.ok(ice.has(id.split(":")[1] ?? ""), id);

  // The Runner does not read which HQ cards the Corp may swap in.
  runner = match.snapshotForRole("runner");
  const text = JSON.stringify(runner);
  for (const id of ["yagi-agenda", "yagi-hq-ice"]) assert.equal(text.includes(`"${id}"`), false, id);
});

test("Midori's swap trashes the trojan on the swapped-out ice, and every seat sees it in the heap (CR 8.8.4b)", async () => {
  const state = learnToPlaySetup(SEED);
  const midori = instantiateCard("midori", "mid-1", "server:hq:root");
  midori.rezzed = true;
  midori.faceup = true;
  state.cards["mid-1"] = midori;
  state.servers.hq.root.push("mid-1");
  // Enigma (strength 2) survives Parasite's first virus counter at turn start.
  const wall = instantiateCard("enigma", "mid-wall", "server:hq:ice");
  wall.rezzed = true;
  wall.faceup = true;
  state.cards["mid-wall"] = wall;
  state.servers.hq.ice.unshift("mid-wall");
  const parasite = instantiateCard("parasite", "mid-par", "runner:installed");
  parasite.hostId = "mid-wall";
  state.cards["mid-par"] = parasite;
  state.runner.installed.push("mid-par");
  state.cards["mid-new"] = instantiateCard("ice-wall", "mid-new", "corp:hq");
  state.corp.hand.push("mid-new");
  const match = createMatch({ setup: () => state });
  await toRunnerTurn(match);
  const runner = match.snapshotForToken(match.tokens.runner);
  const run = runner.legal.find((item) => item.intent.type === "basic_run" && item.intent.serverId === "hq");
  assert.ok(run, runner.legal.map((item) => item.label).join(" | "));
  await match.submit(match.tokens.runner, "run-hq", run.intent);

  // Pass windows until Midori offers the Corp the swap.
  let pick: (typeof runner.legal)[number] | undefined;
  for (let i = 0; i < 10 && !pick; i += 1) {
    const corp = match.snapshotForToken(match.tokens.corp);
    pick = corp.legal.find(
      (item) => item.intent.type === "choose_option" && item.intent.optionId === "mid-new",
    );
    if (pick) break;
    const seat = corp.legal.some((item) => item.intent.type === "pass_window") ? "corp" : "runner";
    const snap = match.snapshotForToken(match.tokens[seat]);
    const next = snap.legal.find((item) => item.intent.type === "pass_window" || item.intent.type === "continue_run");
    assert.ok(next, `${seat}: ${snap.legal.map((item) => item.label).join(" | ")}`);
    await match.submit(match.tokens[seat], `${seat}-${i}`, next.intent);
  }
  assert.ok(pick, "Midori never offered the swap");
  await match.submit(match.tokens.corp, "midori", pick.intent);

  const board = boardOf(match);
  const hq = board.servers.find((server) => server.id === "hq");
  assert.equal(hq?.ice[0]?.id, "mid-new");
  assert.ok(board.corp.hand.some((card) => card.id === "mid-wall"));
  // Parasite left play with its host, and both seats see it in the heap.
  const heaped = board.runner.discard.find((card) => card.id === "mid-par");
  assert.equal(heaped?.zone, "runner:heap");
  for (const role of ["runner", "corp"] as const) {
    const text = JSON.stringify(match.snapshotForRole(role));
    assert.ok(text.includes('"mid-par"'), role);
  }
});
