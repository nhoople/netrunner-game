/**
 * What changed (verification table V6).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GameState } from "netrunner-engine";
import { boardChanges, boardFacts } from "./changes.js";
import { learnToPlaySetup } from "./decks.js";
import { createMatch, forgetMatch, type Match } from "./match.js";
import { checkScenario, scenarioSetup } from "./scenario.js";

type Pending = GameState["pendingAbilities"][number];

function pendingOn(state: GameState, id: string, status: Pending["status"]): Pending {
  return {
    id,
    abilityKey: "on-turn-begin",
    sourceId: state.corp.identityId,
    controller: "corp",
    mandatory: true,
    status,
    independentOfSource: false,
    windowId: null,
  };
}

function diff(before: GameState, after: GameState) {
  return boardChanges(boardFacts(before), boardFacts(after));
}

async function submitFirst(match: Match, id: string, pick: (type: string) => boolean = () => true) {
  const both = match.snapshotForToken(match.tokens.debug).debug!;
  for (const seat of ["corp", "runner"] as const) {
    const entry = both[seat].legal.find((legal) => pick(legal.intent.type));
    if (entry) return match.submit(match.tokens.debug, id, entry.intent, seat);
  }
  throw new Error("no legal intent matched");
}

test("a card that changes zone is listed as moved, with its title (V6)", () => {
  const before = learnToPlaySetup(4);
  const after = structuredClone(before);
  const id = after.corp.hand[0]!;
  after.corp.hand = after.corp.hand.filter((cardId) => cardId !== id);
  after.corp.discardPile.push(id);
  after.cards[id]!.zone = "corp:archives";
  const changes = diff(before, after);
  assert.deepEqual(changes.moved, [{ id, title: before.cards[id]!.title, from: "corp:hq", to: "corp:archives" }]);
  assert.deepEqual(changes.players, [], "the hand and discard lists are diffed through the card's zone");
});

test("ice that moves between positions on a server is listed as moved (V6)", () => {
  const before = learnToPlaySetup(4);
  const [first, second] = before.corp.hand;
  before.servers.hq!.ice = [first!, second!];
  before.cards[first!]!.zone = "server:hq:ice";
  before.cards[second!]!.zone = "server:hq:ice";
  const after = structuredClone(before);
  after.servers.hq!.ice = [second!, first!];
  const moved = diff(before, after).moved.map((move) => [move.id, move.from, move.to]);
  assert.deepEqual(moved, [
    [first, "server:hq:ice #0", "server:hq:ice #1"],
    [second, "server:hq:ice #1", "server:hq:ice #0"],
  ]);
});

test("credits, clicks, counters, and flags show before and after (V6)", () => {
  const before = learnToPlaySetup(4);
  const after = structuredClone(before);
  after.corp.credits += 3;
  after.runner.tags += 1;
  const card = after.corp.hand[0]!;
  after.cards[card]!.advancementCounters = 2;
  after.turn.successfulRunThisTurn = true;
  const changes = diff(before, after);
  assert.deepEqual(changes.players, [
    { side: "corp", field: "credits", before: before.corp.credits, after: before.corp.credits + 3 },
    { side: "runner", field: "tags", before: before.runner.tags, after: before.runner.tags + 1 },
  ]);
  assert.deepEqual(
    changes.cards.map((change) => [change.id, change.field, change.before, change.after]),
    [[card, "advancementCounters", null, 2]],
  );
  assert.deepEqual(changes.game, [{ field: "turn.successfulRunThisTurn", before: false, after: true }]);
});

test("a pending ability is new when it appears and resolved when it leaves (V6, CR 9.6.2)", () => {
  const opening = learnToPlaySetup(4);
  const waiting = structuredClone(opening);
  waiting.pendingAbilities.push(pendingOn(waiting, "pa-1", "pending"));
  const appeared = diff(opening, waiting).pending;
  assert.equal(appeared.length, 1);
  assert.equal(appeared[0]!.change, "new");
  assert.equal(appeared[0]!.before, null);
  assert.equal(appeared[0]!.ability.source, opening.cards[opening.corp.identityId]?.title);

  const gone = structuredClone(waiting);
  gone.pendingAbilities = [];
  assert.deepEqual(
    diff(waiting, gone).pending.map((entry) => [entry.change, entry.ability.id, entry.before]),
    [["resolved", "pa-1", "pending"]],
  );

  const done = structuredClone(waiting);
  done.pendingAbilities[0]!.status = "done";
  assert.deepEqual(
    diff(waiting, done).pending.map((entry) => [entry.change, entry.before]),
    [["resolved", "pending"]],
  );
  // Leaving the list after it settled is not reported twice.
  assert.deepEqual(diff(done, opening).pending, []);

  // Created and cancelled within one intent.
  const flash = structuredClone(opening);
  flash.pendingAbilities.push(pendingOn(flash, "pa-2", "cancelled"));
  assert.deepEqual(
    diff(opening, flash).pending.map((entry) => [entry.change, entry.before]),
    [["cancelled", null]],
  );
});

test("lingering effects show as new, expired, and ended (V6, CR 9.10.1)", () => {
  const opening = learnToPlaySetup(4);
  const lasting = structuredClone(opening);
  lasting.lingeringEffects.push({
    id: "le-1",
    createdBy: opening.corp.identityId,
    independent: true,
    duration: { kind: "turn", side: "corp" },
    kind: "test_effect",
  });
  const added = diff(opening, lasting).lingering;
  assert.deepEqual(added.map((entry) => [entry.change, entry.effect.kind, entry.effect.duration]), [
    ["new", "test_effect", "turn (corp)"],
  ]);
  const expired = structuredClone(lasting);
  expired.lingeringEffects[0]!.expired = true;
  assert.deepEqual(diff(lasting, expired).lingering.map((entry) => entry.change), ["expired"]);
  assert.deepEqual(diff(expired, opening).lingering.map((entry) => entry.change), ["ended"]);
});

test("the debug view shows what the last intent changed, and a seat does not (V6, CR 10.2.2a)", async () => {
  const match = createMatch({ setup: () => learnToPlaySetup(4) });
  assert.deepEqual(match.snapshotForToken(match.tokens.debug).debug!.changes, { afterSeq: null, diff: null });
  // Both keep: the Corp's turn begins with its mandatory draw (CR 5.3.2).
  await submitFirst(match, "keep-1", (type) => type === "keep_starting_hand");
  const reply = await submitFirst(match, "keep-2", (type) => type === "keep_starting_hand");
  const drew = reply.debug!.changes;
  assert.equal(drew.afterSeq, match.gameLog().length);
  assert.equal(drew.diff!.moved.length, 1);
  assert.equal(drew.diff!.moved[0]!.from, "corp:rd");
  assert.equal(drew.diff!.moved[0]!.to, "corp:hq");
  assert.ok(drew.diff!.moved[0]!.title, "the debug view names the drawn card");

  const credits = (await submitFirst(match, "gain-1", (type) => type === "basic_gain_credit")).debug!.changes.diff!;
  const corp = Object.fromEntries(credits.players.map((change) => [`${change.side}.${change.field}`, [change.before, change.after]]));
  assert.deepEqual(corp["corp.credits"], [5, 6]);
  assert.deepEqual(corp["corp.clicks"], [3, 2]);
  assert.deepEqual(credits.moved, []);

  for (const role of ["corp", "runner", "spectator", "log"] as const) {
    const snapshot = match.snapshotForRole(role);
    assert.equal(snapshot.debug, undefined, role);
    const wire = JSON.stringify(snapshot);
    // Seat views carry the engine's own filtered view; check the keys V6 adds.
    for (const key of ['"changes"', '"moved"', '"engine":']) {
      assert.equal(wire.includes(key), false, `${role} ${key}`);
    }
  }
  forgetMatch(match.id);
});

test("restoring the match from the log clears the last change (V6)", async () => {
  const match = createMatch({ setup: () => learnToPlaySetup(4) });
  await submitFirst(match, "keep-1", (type) => type === "keep_starting_hand");
  await submitFirst(match, "keep-2", (type) => type === "keep_starting_hand");
  assert.notEqual(match.snapshotForToken(match.tokens.debug).debug!.changes.diff, null);
  await match.seek(match.tokens.log, 1);
  assert.deepEqual(match.snapshotForToken(match.tokens.debug).debug!.changes, { afterSeq: null, diff: null });
  forgetMatch(match.id);
});

test("the engine-state panel lists pending abilities and the run (V6)", async () => {
  const planted = () => {
    const state = learnToPlaySetup(5);
    state.pendingAbilities.push(pendingOn(state, "pa-9", "pending"));
    return state;
  };
  const withPending = createMatch({ setup: planted });
  const panel = withPending.snapshotForToken(withPending.tokens.debug).debug!.engine;
  assert.deepEqual(
    panel.pending.map((ability) => [ability.id, ability.status, ability.controller]),
    [["pa-9", "pending", "corp"]],
  );
  assert.ok(panel.pending[0]!.source);
  assert.equal(panel.run, null);
  forgetMatch(withPending.id);

  const checked = checkScenario({
    turn: "runner",
    start: "action",
    turnNumber: 2,
    corp: { identity: "the-syndicate-profit-over-principle", credits: 5, hand: ["hedge-fund"], deck: ["hedge-fund", "ice-wall"] },
    runner: {
      identity: "the-catalyst-convention-breaker",
      credits: 5,
      clicks: 4,
      hand: ["sure-gamble"],
      deck: ["sure-gamble", "jailbreak"],
    },
  });
  if (!checked.ok) throw new Error(checked.error);
  const match = createMatch({ setup: scenarioSetup(checked.scenario, 3), scenario: true });
  const both = match.snapshotForToken(match.tokens.debug).debug!;
  const run = both.runner.legal.find(
    (legal) => legal.intent.type === "basic_run" && (legal.intent as { serverId?: string }).serverId === "hq",
  );
  assert.ok(run, "the Runner may run HQ");
  const reply = await match.submit(match.tokens.debug, "run-hq", run.intent, "runner");
  const debug = reply.debug!;
  assert.equal(debug.engine.run?.attackedServerId, "hq");
  assert.deepEqual(debug.changes.diff!.run[0], { field: "run", before: "none", after: "in progress" });
  assert.ok(debug.changes.diff!.run.some((change) => change.field === "attackedServerId" && change.after === "hq"));
  for (const change of debug.changes.diff!.run.slice(1)) {
    assert.ok(![null, false, "", 0].includes(change.after as never), `a new run lists only what it set: ${change.field}`);
  }
  forgetMatch(match.id);
});
