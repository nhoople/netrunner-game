/**
 * FX-faceup: a card the Runner accesses in a remote server is not turned
 * faceup (CR audit program, fix-now session FX-faceup, 2026-11-27).
 *
 * While accessing a card the Runner may look at it, and so may the Corp
 * (CR 7.1.2). After the access the card stays visible to the Runner for the
 * rest of the breach (CR 7.3.1a). Nobody else sees it: a facedown card in
 * play is hidden information (CR 10.2.2a), and only a faceup card is open to
 * every player (CR 4.6.3). Before engine v1.147.288 the access left the card
 * faceup for the rest of the game, so the spectator's log read "Runner:
 * Access PAD Campaign" and its board, and the Runner's after the run, named
 * the card.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { instantiateCard } from "netrunner-engine";
import type { GameState, Intent } from "netrunner-engine";
import { learnToPlaySetup } from "./decks.js";
import { createMatch } from "./match.js";

const SEED = 42;
const SERVER = "remote-9";

type Match = ReturnType<typeof createMatch>;
type ServerRow = { id: string; root: Array<{ id: string; title?: string | null }> };

/** The Learn to play match with a facedown PAD Campaign and Ash 2X3ZB9CY alone in a remote. */
function matchWithRemote(): Match {
  const state: GameState = learnToPlaySetup(SEED);
  const root: string[] = [];
  for (const [defId, id] of [
    ["pad-campaign", "pad-9"],
    ["ash-2x3zb9cy", "ash-9"],
  ] as const) {
    const card = instantiateCard(defId, id, `server:${SERVER}:root` as never);
    card.rezzed = false;
    card.faceup = false;
    state.cards[id] = card;
    root.push(id);
  }
  (state.servers as Record<string, unknown>)[SERVER] = { id: SERVER, kind: "remote", root, ice: [] };
  return createMatch({ setup: () => state });
}

/** Keep both hands, then have the Corp take credits until the Runner's turn. */
async function toRunnerTurn(match: Match): Promise<void> {
  await match.submit(match.tokens.corp, "keep-corp", { type: "keep_starting_hand" });
  await match.submit(match.tokens.runner, "keep-runner", { type: "keep_starting_hand" });
  for (let i = 0; i < 20; i += 1) {
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

let stepCount = 0;

/** The seat whose turn it is to act takes the first legal intent `wanted` accepts. */
async function step(match: Match, wanted: (intent: Intent) => boolean): Promise<boolean> {
  for (const seat of ["runner", "corp"] as const) {
    const snap = match.snapshotForToken(match.tokens[seat]);
    const item = snap.legal.find((entry) => wanted(entry.intent));
    if (item) {
      stepCount += 1;
      await match.submit(match.tokens[seat], `step-${stepCount}`, item.intent);
      return true;
    }
  }
  return false;
}

/** Pass and continue until the Runner may access `cardId`. */
async function toAccessOf(match: Match, cardId: string): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    const runner = match.snapshotForToken(match.tokens.runner);
    if (runner.legal.some((entry) => entry.intent.type === "access_card" && entry.intent.cardId === cardId)) return;
    const moved = await step(match, (intent) => ["continue_run", "pass_window"].includes(intent.type));
    assert.ok(moved, `stuck before accessing ${cardId}`);
  }
  assert.fail(`no access of ${cardId}`);
}

async function access(match: Match, cardId: string): Promise<void> {
  assert.ok(await step(match, (intent) => intent.type === "access_card" && intent.cardId === cardId));
}

/** The title the viewer's board shows for a card in the remote's root. */
function rootTitle(match: Match, role: "corp" | "runner" | "spectator", id: string): string | null {
  const view = match.snapshotForRole(role).view as { servers: ServerRow[] };
  const server = view.servers.find((row) => row.id === SERVER);
  assert.ok(server, `${role} sees no ${SERVER}`);
  const card = server.root.find((entry) => entry.id === id);
  assert.ok(card, `${role} sees no ${id}`);
  return card.title ?? null;
}

function spectatorLog(match: Match): string[] {
  return match.snapshotForRole("spectator").log.map((line) => line.summary);
}

async function runAndAccessPad(): Promise<Match> {
  const match = matchWithRemote();
  await toRunnerTurn(match);
  const isRun = (intent: Intent) => intent.type === "basic_run" && intent.serverId === SERVER;
  for (let i = 0; i < 10; i += 1) {
    if (match.snapshotForToken(match.tokens.runner).legal.some((entry) => isRun(entry.intent))) break;
    assert.ok(await step(match, (intent) => intent.type === "pass_window"), "stuck before the run");
  }
  assert.ok(await step(match, isRun));
  await toAccessOf(match, "pad-9");
  await access(match, "pad-9");
  return match;
}

test("the spectator's log and board do not name a PAD Campaign the Runner accesses in a remote server (CR 7.1.2, 10.2.2a)", async () => {
  const match = await runAndAccessPad();
  assert.equal(spectatorLog(match).at(-1), "Runner: Access a card in remote 9");
  assert.equal(rootTitle(match, "spectator", "pad-9"), null);
  for (const role of ["spectator", "log"] as const) {
    assert.equal(JSON.stringify(match.snapshotForRole(role)).includes("PAD Campaign"), false, role);
  }
});

test("the Corp's log names the card the Runner accesses in its remote server, which it may look at (CR 7.1.2)", async () => {
  const match = await runAndAccessPad();
  const corp = match.snapshotForToken(match.tokens.corp);
  assert.equal(corp.log.at(-1)?.summary, "Runner: Access PAD Campaign");
  assert.equal(match.snapshotForRole("log").log.at(-1)?.summary, "Runner: Access a card in remote 9");
});

test("while accessing PAD Campaign the Runner's card text and trash button name it (CR 7.1.2)", async () => {
  const match = await runAndAccessPad();
  const runner = match.snapshotForToken(match.tokens.runner);
  assert.equal(runner.glossary["pad-9"]?.title, "PAD Campaign");
  const trash = runner.legal.find((entry) => entry.intent.type === "trash_accessed");
  assert.ok(trash, runner.legal.map((entry) => entry.label).join(" | "));
  assert.match(trash.label, /^Trash PAD Campaign/);
});

test("the Runner sees the accessed PAD Campaign for the rest of the breach, and the spectator still does not (CR 7.3.1a)", async () => {
  const match = await runAndAccessPad();
  const runner = match.snapshotForToken(match.tokens.runner);
  assert.equal(runner.log.at(-1)?.summary, "Runner: Access PAD Campaign");
  assert.equal(rootTitle(match, "runner", "pad-9"), "PAD Campaign");
  // Leave PAD Campaign in place; Ash is still to be accessed.
  assert.ok(await step(match, (intent) => intent.type === "finish_access"));
  await toAccessOf(match, "ash-9");
  assert.equal(rootTitle(match, "runner", "pad-9"), "PAD Campaign");
  assert.equal(match.snapshotForToken(match.tokens.runner).glossary["pad-9"]?.title, "PAD Campaign");
  assert.equal(rootTitle(match, "runner", "ash-9"), null);
  assert.equal(rootTitle(match, "spectator", "pad-9"), null);
  assert.equal(JSON.stringify(match.snapshotForRole("spectator")).includes("PAD Campaign"), false);
});

test("after the run no seat but the Corp names the accessed remote cards (CR 7.3.1a, 10.2.2a, 1.21.2a)", async () => {
  const match = await runAndAccessPad();
  assert.ok(await step(match, (intent) => intent.type === "finish_access"));
  await toAccessOf(match, "ash-9");
  await access(match, "ash-9");
  for (let i = 0; i < 20; i += 1) {
    const view = match.snapshotForRole("debug").view as { run?: unknown };
    if (!view.run) break;
    assert.ok(
      await step(match, (intent) => ["finish_access", "finish_breach", "pass_window"].includes(intent.type)),
      "stuck before the run ended",
    );
  }
  assert.equal((match.snapshotForRole("debug").view as { run?: unknown }).run ?? null, null);
  for (const role of ["runner", "spectator"] as const) {
    assert.equal(rootTitle(match, role, "pad-9"), null, role);
    assert.equal(rootTitle(match, role, "ash-9"), null, role);
  }
  assert.equal(match.snapshotForToken(match.tokens.runner).glossary["pad-9"], undefined);
  assert.equal(rootTitle(match, "corp", "pad-9"), "PAD Campaign");
  assert.equal(rootTitle(match, "corp", "ash-9"), "Ash 2X3ZB9CY");
  assert.equal(JSON.stringify(match.snapshotForRole("spectator")).includes("PAD Campaign"), false);
  assert.equal(JSON.stringify(match.snapshotForRole("spectator")).includes("Ash 2X3ZB9CY"), false);
});
