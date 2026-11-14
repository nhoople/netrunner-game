/**
 * Why not (verification table V7).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GameState, Intent } from "netrunner-engine";
import { canonicalJson } from "./export.js";
import { createMatch, forgetMatch, type Match } from "./match.js";
import { checkScenario, scenarioSetup, type Scenario } from "./scenario.js";
import { answerWhyNot, whyNot, whyNotRequest } from "./whynot.js";

const SCENARIO: Scenario = {
  turn: "corp",
  start: "action",
  corp: {
    identity: "the-syndicate-profit-over-principle",
    credits: 2,
    clicks: 3,
    deck: ["hedge-fund", "hedge-fund", "hedge-fund"],
    hand: ["hedge-fund", "ice-wall"],
    installed: [
      { card: "tithe", server: "hq", rezzed: true },
      { card: "palisade", server: "remote-1" },
      { card: "offworld-office", server: "remote-1", advancements: 2 },
    ],
  },
  runner: {
    identity: "the-catalyst-convention-breaker",
    credits: 1,
    clicks: 4,
    deck: ["sure-gamble", "sure-gamble"],
    hand: ["sure-gamble", "jailbreak"],
    installed: [{ card: "cleaver" }],
  },
};

function scenarioMatch(): Match {
  const checked = checkScenario(SCENARIO);
  assert.ok(checked.ok);
  return createMatch({ setup: scenarioSetup(checked.scenario, 11), scenario: true });
}

function rawState(match: Match): GameState {
  return (match as unknown as { state: GameState }).state;
}

function idOf(state: GameState, defId: string, zone: string): string {
  const card = Object.values(state.cards).find((entry) => entry.defId === defId && entry.zone.startsWith(zone));
  assert.ok(card, `${defId} in ${zone}`);
  return card.id;
}

/** Every view of the match, without the timings that change on each read. */
function views(match: Match): string {
  return JSON.stringify(
    (["corp", "runner", "spectator", "log", "debug"] as const).map((role) => {
      const { timings: _timings, ...rest } = match.snapshotForRole(role);
      if (rest.debug) {
        for (const seat of ["corp", "runner"] as const) delete (rest.debug[seat] as { timings?: unknown }).timings;
      }
      return rest;
    }),
  );
}

test("a refused intent reports the engine's reason and CR citations (V7)", () => {
  const match = scenarioMatch();
  const state = rawState(match);
  const hedgeFund = idOf(state, "hedge-fund", "corp:hq");
  const report = whyNot(state, "corp", { type: "play_operation", cardId: hedgeFund });
  assert.equal(report.verdict, "refused");
  assert.equal(report.refusal?.error, "Insufficient credits to play operation.");
  assert.deepEqual(report.refusal?.cites.map((cite) => cite.number), ["5.2.6e"]);
  assert.equal(report.timing.priority, "corp");
  assert.equal(report.changes, undefined);

  const run = whyNot(state, "runner", { type: "basic_run", serverId: "hq" });
  assert.equal(run.verdict, "refused");
  assert.match(run.refusal!.error, /Only the Runner may make a run/);
  assert.deepEqual(run.refusal!.cites.map((cite) => cite.number), ["5.2.7f"]);

  const nowhere = whyNot(state, "corp", {
    type: "basic_install",
    cardId: idOf(state, "ice-wall", "corp:hq"),
    destination: { kind: "protect", serverId: "remote-9" },
  } as Intent);
  assert.equal(nowhere.refusal?.error, "Unknown server.");
  forgetMatch(match.id);
});

test("an offered intent reports what it would change, and a seat it is not offered to is told so (V7)", () => {
  const match = scenarioMatch();
  const state = rawState(match);
  const report = whyNot(state, "corp", { type: "basic_gain_credit" });
  assert.equal(report.verdict, "offered");
  assert.equal(report.refusal, undefined);
  assert.ok(report.changes?.players.some((change) => change.side === "corp" && change.field === "credits" && change.after === 3));
  assert.deepEqual(report.newProblems, []);

  // The engine acts for whoever has priority: the Runner asking for the
  // Corp's click is not listed for the Runner, and the engine takes it.
  const borrowed = whyNot(state, "runner", { type: "basic_gain_credit" });
  assert.equal(borrowed.verdict, "unlisted-accepted");
  assert.equal(borrowed.listedForOther, true);
  forgetMatch(match.id);
});

test("an unknown or partial intent is reported, not raised (V7)", () => {
  const match = scenarioMatch();
  const report = whyNot(rawState(match), "corp", { type: "no_such_action" } as unknown as Intent);
  assert.equal(report.verdict, "refused");
  assert.match(report.refusal!.error, /Unknown action/);
  // A missing field does not throw out of the host either.
  const partial = whyNot(rawState(match), "corp", { type: "play_operation" } as unknown as Intent);
  assert.equal(partial.verdict, "refused");
  forgetMatch(match.id);
});

test("asking why not leaves the live match, its log, and every view unchanged (V7)", async () => {
  const match = scenarioMatch();
  const state = rawState(match);
  const hedgeFund = idOf(state, "hedge-fund", "corp:hq");
  const before = { state: canonicalJson(rawState(match)), log: JSON.stringify(match.gameLog()), views: views(match) };
  const asks: Array<[("corp" | "runner"), Intent]> = [
    ["corp", { type: "play_operation", cardId: hedgeFund }],
    ["corp", { type: "basic_gain_credit" }],
    ["corp", { type: "basic_draw" }],
    ["corp", { type: "advance", cardId: idOf(state, "offworld-office", "server") }],
    ["runner", { type: "basic_run", serverId: "hq" }],
    ["runner", { type: "basic_gain_credit" }],
  ];
  for (const [seat, intent] of asks) {
    const request = whyNotRequest({ token: match.tokens.debug, seat, intent });
    assert.ok(request.ok);
    await answerWhyNot(request);
  }
  assert.equal(rawState(match), state, "the match keeps the same state object");
  assert.equal(canonicalJson(rawState(match)), before.state);
  assert.equal(JSON.stringify(match.gameLog()), before.log);
  assert.equal(views(match), before.views);
  // The match still plays from where it was.
  const reply = await match.submit(match.tokens.debug, "after-why-not", { type: "basic_gain_credit" }, "corp");
  assert.equal(reply.debug!.board.corp.credits, 3);
  forgetMatch(match.id);
});

test("only the debug token may ask why not: the reason can name a hidden card (V7, CR 10.2.2a)", () => {
  const match = scenarioMatch();
  const intent = { type: "basic_draw" };
  for (const role of ["corp", "runner", "spectator", "log"] as const) {
    const request = whyNotRequest({ token: match.tokens[role], seat: "corp", intent });
    assert.deepEqual(request, { ok: false, status: 403, error: "Ask why not from a match's debug page." }, role);
  }
  assert.equal(whyNotRequest({ seat: "corp", intent }).ok, false);
  assert.equal(whyNotRequest(null).ok, false);
  const bad = (body: Record<string, unknown>, error: RegExp) => {
    const request = whyNotRequest({ token: match.tokens.debug, seat: "corp", intent, ...body });
    assert.ok(!request.ok && request.status === 400 && error.test(request.error), JSON.stringify(body));
  };
  bad({ seat: "spectator" }, /seat must be/);
  bad({ intent: "basic_draw" }, /intent must be an object/);
  bad({ intent: [] }, /intent must be an object/);
  bad({ intent: { cardId: "x" } }, /intent needs a type/);
  forgetMatch(match.id);
});

test("an intent copied from a seat's legal list is reported as offered (V7)", async () => {
  const match = scenarioMatch();
  const corpLegal = match.snapshotForRole("debug").debug!.corp.legal;
  const install = corpLegal.find((entry) => entry.intent.type === "basic_install");
  assert.ok(install);
  const request = whyNotRequest({ token: match.tokens.debug, seat: "corp", intent: install.intent });
  assert.ok(request.ok);
  const report = await answerWhyNot(request);
  assert.equal(report.verdict, "offered");
  assert.ok(report.changes?.moved.length);
  forgetMatch(match.id);
});
