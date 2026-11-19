/**
 * Open-information stops for the host's automatic passing.
 *
 * As host policy, not a rule, the host passes for a seat whose only legal
 * option is Pass. The seat could only pass there (CR 9.2.4b, 9.2.7f), so the
 * game state is unchanged; only the timing shows. Some of the engine's legal plays depend on facedown or hidden
 * cards: approach-ice `rez_ice` only when the Corp can pay (CR 9.2.7e),
 * `rez_asset` only for an asset or upgrade it can pay for (CR 9.2.7c), and
 * `score_agenda` only for an agenda that meets its requirement (CR 9.2.7d).
 * If the host paused only when such a play existed, the pause would tell the
 * other player a rez cost, a card type, or that an agenda can be scored, which
 * that player may not learn (CR 10.2.2a, 10.2.2b).
 *
 * `openStop` answers "could this seat have a play here?" from what the other
 * player can see: zones, which cards are rezzed or facedown, the run position,
 * and the timing step. Never from a facedown card's identity, cost, or
 * counters requirement. When it returns a stop, the seat gets priority even if
 * its only legal play turns out to be Pass, so the window looks the same to
 * the opponent whatever the hidden cards are.
 *
 * Each stop has a `reason`, so later work (per-seat stops: a seat choosing in
 * advance to pass, CR 9.2.4b, 9.2.7f) can let a seat turn a kind of stop off
 * for itself. If it does, its own pauses may then tell the opponent what it
 * holds; that is the seat's choice, not the host's.
 *
 * No stop for abilities used from HQ or Archives (CR 9.1.8b): at the cards
 * pin every such ability costs a click first, so it is an action (CR 5.2.1),
 * never offered in a priority window. A future one would name a hidden card,
 * and the coverage test in `match.test.ts` would fail.
 */
import type { GameState } from "netrunner-engine";

type OpenStopReason =
  /** (R) or (S) window, with an unrezzed card in a server root (CR 9.2.7c, 9.2.7d). */
  | "facedown_root"
  /** Approach-ice window on unrezzed ice (CR 9.2.7e). */
  | "approached_ice"
  /** (R) window during a run, with unrezzed ice on the attacked server (Rime; CR 1.2.1, 9.1.8c). */
  | "attacked_server_ice"
  /**
   * Approach-server step, with unrezzed ice anywhere (Formicary; CR 6.9.4g,
   * 9.1.8c). 6.9.4g is not a paid ability window; the engine opens this step
   * only when a Formicary-class ice is installed (an engine follow-up).
   */
  | "approach_server_ice";

export interface OpenStop {
  reason: OpenStopReason;
  /** The rule the stop follows, for the log and for U2's stop settings. */
  cite: string;
}

/**
 * Windows marked (R): the Corp may rez an asset or upgrade (CR 9.2.7c). The
 * steps with (S) (CR 9.2.7d), `corp.actionPaw` and `corp.drawPaw`, are among
 * them. This mirrors the engine pin's own list; a step the engine adds there
 * and this list misses is caught by the coverage test in `match.test.ts`.
 */
const REZ_OR_SCORE_WINDOWS = new Set([
  "corp.actionPaw",
  "corp.drawPaw",
  "corp.discardPaw",
  "runner.actionPaw",
  "runner.startPaw",
  "runner.discardPaw",
  "run.approachPaw",
  "run.initiatePaw",
  "run.afterMovePaw",
]);

/** A card the other player sees facedown: installed and neither rezzed nor faceup (CR 1.21.1, 10.2.2a). */
function facedown(state: GameState, id: string): boolean {
  const card = state.cards[id];
  return Boolean(card && !card.rezzed && !card.faceup);
}

/**
 * Whether `seat` must get priority in the open window even if it has nothing
 * to play, judged only on information the other player has (CR 10.2.2a).
 * Null when the window may pass by itself whenever Pass is the only option.
 *
 * Only the Corp has such stops at the engine pin: the engine offers the
 * Runner no option in a priority window drawn from the grip, the stack, or a
 * facedown card, so every Runner option there is judged on open cards. The
 * coverage test checks both seats.
 */
export function openStop(state: GameState, seat: "corp" | "runner"): OpenStop | null {
  if (seat !== "corp") return null;
  const key = String(state.timingKey);
  const servers = Object.values(state.servers);
  const run = state.run;

  if (key === "run.approachPaw" && run && run.position !== null && !run.positionVacated) {
    const iceId = state.servers[run.attackedServerId]?.ice[run.position];
    if (iceId && facedown(state, iceId)) return { reason: "approached_ice", cite: "9.2.7e" };
  }

  if (REZ_OR_SCORE_WINDOWS.has(key)) {
    if (servers.some((server) => server.root.some((id) => facedown(state, id)))) {
      return { reason: "facedown_root", cite: "9.2.7c, 9.2.7d" };
    }
    if (run && state.servers[run.attackedServerId]?.ice.some((id) => facedown(state, id))) {
      return { reason: "attacked_server_ice", cite: "9.1.8c" };
    }
  }

  if (
    key === "run.approachServerPaw" &&
    run &&
    servers.some((server) => server.ice.some((id) => facedown(state, id)))
  ) {
    return { reason: "approach_server_ice", cite: "9.1.8c" };
  }

  return null;
}
