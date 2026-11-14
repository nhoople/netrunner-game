/**
 * Why not (verification table V7).
 *
 * The debug page names a seat and an intent the table did not offer. The host
 * applies it to a copy of the live state and reports what the engine said:
 * its refusal reason and CR citations, or, when the engine takes it anyway,
 * what would change. The match, its log, and every seat view stay as they
 * were.
 *
 * An engine intent carries no seat: the engine acts for whoever the state
 * says. The seat named here is checked against the legality query only, the
 * same list the table offers that seat.
 *
 * The reason can name a hidden card, so only the debug token may ask.
 */
import { applyIntent, autoWalk, queryLegality, type GameState, type Intent } from "netrunner-engine";
import { boardChanges, boardFacts, type BoardChanges } from "./changes.js";
import { invariantReport, problemKeys, type InvariantWire } from "./inspect.js";
import {
  citeWire,
  describeIntent,
  findMatchByToken,
  sameIntent,
  settleEmptyWindows,
  timingWire,
  type Match,
  type RuleCiteWire,
  type Seat,
  type TimingWire,
} from "./match.js";

/**
 * - `offered`: the legality query lists it for this seat and the engine takes it.
 * - `refused`: not listed for this seat, and the engine refuses it.
 * - `listed-refused`: listed for this seat, but the engine refuses it, so the
 *   table leaves it out (an unpayable install, for one).
 * - `unlisted-accepted`: not listed for this seat, but the engine takes it.
 *   The legality query and `applyIntent` disagree; worth a look.
 * - `threw`: `applyIntent` threw instead of refusing.
 */
export type WhyNotVerdict = "offered" | "refused" | "listed-refused" | "unlisted-accepted" | "threw";

export interface WhyNotReport {
  seat: Seat;
  intent: Intent;
  verdict: WhyNotVerdict;
  /** The host's description of the intent, when it can make one. */
  label: string | null;
  /** The legality query lists the same intent for the other seat. */
  listedForOther: boolean;
  /** Who holds priority, and the step, on the live state (CR 9.2.4). */
  timing: TimingWire;
  /** The engine's refusal. Present for `refused`, `listed-refused`, and `threw`. */
  refusal?: { error: string; cites: RuleCiteWire[] };
  /** What would change on the copy, after the host's walk. Present when the engine takes the intent. */
  changes?: BoardChanges;
  /** `checkInvariants` problems the intent would add. */
  newProblems?: InvariantWire[];
}

/** Ask the engine about one intent on a copy of `live`. `live` is not changed. */
export function whyNot(live: GameState, seat: Seat, intent: Intent): WhyNotReport {
  const state = structuredClone(live) as GameState;
  const other: Seat = seat === "corp" ? "runner" : "corp";
  const legality = queryLegality(state);
  const listedFor = (actor: Seat) =>
    legality.legal.some((entry) => entry.actor === actor && sameIntent(entry.action, intent));
  const listed = listedFor(seat);
  const base = {
    seat,
    intent,
    label: labelFor(state, intent),
    listedForOther: listedFor(other),
    timing: timingWire(legality),
  };
  const problemsBefore = problemKeys(state);
  const factsBefore = boardFacts(state);
  let applied: ReturnType<typeof applyIntent>;
  try {
    applied = applyIntent(state, intent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, verdict: "threw", refusal: { error: message, cites: [] } };
  }
  if (!applied.ok) {
    return {
      ...base,
      verdict: listed ? "listed-refused" : "refused",
      refusal: { error: applied.error, cites: citeWire(applied.cites) },
    };
  }
  // The same walk Match.submit does after an intent applies.
  let after = applied.state;
  autoWalk(after);
  after = settleEmptyWindows(after);
  return {
    ...base,
    verdict: listed ? "offered" : "unlisted-accepted",
    changes: boardChanges(factsBefore, boardFacts(after)),
    newProblems: invariantReport(after, problemsBefore).filter((problem) => problem.isNew),
  };
}

function labelFor(state: GameState, intent: Intent): string | null {
  try {
    return describeIntent(state, intent);
  } catch {
    return null;
  }
}

export type WhyNotRequest =
  | { ok: true; match: Match; seat: Seat; intent: Intent }
  | { ok: false; status: 400 | 403; error: string };

/**
 * A why-not request from a debug page: `{ token, seat, intent }`. A seat,
 * spectator, or log token is refused: the reason can name a hidden card.
 */
export function whyNotRequest(body: unknown): WhyNotRequest {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "Send a debug token, a seat, and an intent." };
  const { token, seat, intent } = body as { token?: unknown; seat?: unknown; intent?: unknown };
  const found = typeof token === "string" ? findMatchByToken(token) : undefined;
  if (found?.role !== "debug") return { ok: false, status: 403, error: "Ask why not from a match's debug page." };
  if (seat !== "corp" && seat !== "runner") return { ok: false, status: 400, error: "seat must be corp or runner." };
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    return { ok: false, status: 400, error: "intent must be an object." };
  }
  const type = (intent as { type?: unknown }).type;
  if (typeof type !== "string" || !type) return { ok: false, status: 400, error: "intent needs a type." };
  return { ok: true, match: found.match, seat, intent: found.match.resolveRefs(intent as Intent) };
}

/** Run a checked request on a copy of the match's live state, in the match's queue. */
export function answerWhyNot(request: { match: Match; seat: Seat; intent: Intent }): Promise<WhyNotReport> {
  const { match, seat, intent } = request;
  return match.enqueue(() => whyNot(match.stateCopy(), seat, intent));
}
