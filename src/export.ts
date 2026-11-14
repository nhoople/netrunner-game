/**
 * Export a match as an engine test fixture (verification table V5).
 *
 * The fixture holds the opening state and every engine action the host
 * applied, in order. The engine replays it with `applyAction` then
 * `autoWalk` per step, with no game code, and checks the final state and
 * the invariant failures. Failures use the playout seed fixtures' shape
 * (CR audit tool 1.3): `{ code, step, detail }`, where `step` is the 0-based
 * index of the action after which the problem first appears, and -1 means
 * the opening already had it.
 *
 * A fixture names every card, hidden or not. Only the debug page exports one.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { autoWalk, applyIntent, checkInvariants, type GameState } from "netrunner-engine";
import type { MatchOpening } from "./decks.js";
import { findMatchByToken, type Match, type TraceStep } from "./match.js";

export const FIXTURE_FORMAT = "netrunner-game-export";
export const FIXTURE_VERSION = 1;

export interface FixtureFailure {
  code: string;
  step: number;
  detail: string;
}

export interface FixtureFinal {
  /** sha256 of the final state's canonical JSON (sorted keys), without its text log. */
  stateHash: string;
  timingKey: string;
  turnNumber: number;
  activeSide: string;
  done: boolean;
  winner: string | null;
  corp: { credits: number; clicks: number; hand: number; deck: number; discard: number; score: number };
  runner: { credits: number; clicks: number; hand: number; deck: number; discard: number; score: number; installed: number };
  /** Invariant problem codes on the final state. */
  invariants: string[];
}

export interface MatchFixture {
  format: typeof FIXTURE_FORMAT;
  version: typeof FIXTURE_VERSION;
  source: {
    matchId: string;
    exportedAt: string;
    /** Release tags in the game's pin files when the fixture was written. */
    engine: string;
    cards: string;
    cr: string;
    /** How the game dealt the opening: a preset, submitted decks, or a scenario. */
    opening: MatchOpening | null;
    /** A concede or host ending after the last step. Not an engine action. */
    hostEnd: string | null;
  };
  opening: GameState;
  steps: TraceStep[];
  failures: FixtureFailure[];
  final: FixtureFinal;
}

/**
 * JSON with object keys sorted and undefined values dropped, so a state read
 * back from JSON hashes the same as the live one: the engine may set a key a
 * JSON round trip dropped, which changes key order but not the state.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort()) sorted[key] = (item as Record<string, unknown>)[key];
    return sorted;
  });
}

/** sha256 of a state's canonical JSON without its text log. The engine's loader computes the same. */
export function stateHash(state: GameState): string {
  const { log: _log, ...rest } = state;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

function finalSummary(state: GameState): FixtureFinal {
  return {
    stateHash: stateHash(state),
    timingKey: state.timingKey,
    turnNumber: state.turnNumber,
    activeSide: state.activeSide,
    done: state.done,
    winner: state.winner ?? null,
    corp: {
      credits: state.corp.credits,
      clicks: state.corp.clicks,
      hand: state.corp.hand.length,
      deck: state.corp.deck.length,
      discard: state.corp.discardPile.length,
      score: state.corp.scoreArea.length,
    },
    runner: {
      credits: state.runner.credits,
      clicks: state.runner.clicks,
      hand: state.runner.hand.length,
      deck: state.runner.deck.length,
      discard: state.runner.discardPile.length,
      score: state.runner.scoreArea.length,
      installed: state.runner.installed.length,
    },
    invariants: [...new Set(checkInvariants(state).map((problem) => problem.code))].sort(),
  };
}

/**
 * Replay a fixture's steps from its opening the way the engine's loader
 * does, and list each invariant problem at the first step it appears.
 */
export function replayFixture(opening: GameState, steps: readonly TraceStep[]): {
  state: GameState;
  failures: FixtureFailure[];
} {
  let state = structuredClone(opening) as GameState;
  const failures: FixtureFailure[] = [];
  const seen = new Set<string>();
  const note = (step: number) => {
    for (const problem of checkInvariants(state)) {
      const key = `${problem.code}:${problem.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push({ code: problem.code, step, detail: problem.message });
    }
  };
  note(-1);
  steps.forEach((step, index) => {
    const applied = applyIntent(state, step.action);
    if (!applied.ok) throw new Error(`Step ${index} (${step.action.type}) was refused: ${applied.error}`);
    state = applied.state;
    autoWalk(state);
    note(index);
  });
  return { state, failures };
}

function pinTag(name: string): string {
  try {
    const pin = JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8")) as { tag?: string };
    return pin.tag ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Build the fixture for a match. The trace is replayed once more here, and
 * the export is refused if that replay does not reach the live state.
 */
export function exportMatch(match: Match, now = new Date()): MatchFixture {
  const opening = match.opening;
  const traced = match.trace();
  const opened = JSON.parse(JSON.stringify(traced.opening)) as GameState;
  const replayed = replayFixture(opened, traced.steps);
  if (stateHash(replayed.state) !== stateHash(traced.state)) {
    throw new Error("The traced steps do not replay to the match state");
  }
  if (traced.hostEnd === null && stateHash(traced.live) !== stateHash(traced.state)) {
    throw new Error("The traced steps do not reach the live match state");
  }
  return {
    format: FIXTURE_FORMAT,
    version: FIXTURE_VERSION,
    source: {
      matchId: match.id,
      exportedAt: now.toISOString(),
      engine: pinTag("engine-pin.json"),
      cards: pinTag("cards-pin.json"),
      cr: pinTag("cr-pin.json"),
      opening,
      hostEnd: traced.hostEnd,
    },
    opening: opened,
    steps: traced.steps,
    failures: replayed.failures,
    final: finalSummary(replayed.state),
  };
}

export type ExportRequest =
  | { ok: true; match: Match }
  | { ok: false; status: 403; error: string };

/** Only a match's debug token may export it: the fixture names every hidden card. */
export function exportRequest(token: string): ExportRequest {
  const found = findMatchByToken(token);
  if (found?.role !== "debug") return { ok: false, status: 403, error: "Export a match from its debug page." };
  return { ok: true, match: found.match };
}
