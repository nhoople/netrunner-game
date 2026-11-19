/**
 * Where each legal intent sits on the board, which group of the interface
 * offers it, and which one the primary button takes. The inventory of every
 * intent type and what it points at is in `docs/legal-intents.md`.
 *
 * Visibility. An anchor or target names a card id only when that id is not a
 * secret for the seat: not a card in a hand or a deck the seat may not see
 * (CR 10.2.2a, CR 4.1.5). A facedown installed card's id is its location and
 * is open (CR 1.21.1, CR 4.1.4), so the board can point at it without naming
 * its face. A card id the seat may not see falls back to the server it is
 * in, when the intent says which, or to no anchor.
 */
import type { GameState, Intent } from "netrunner-engine";

/** Which part of the interface offers an intent. */
export type LegalGroup = "basic" | "install" | "play" | "run" | "ability" | "window" | "choice";

/** A place on the board an intent points at. */
export type LegalAnchor =
  | { kind: "none" }
  | { kind: "card"; cardId: string }
  | { kind: "server"; serverId: string }
  /** A subroutine on a piece of ice, counted from 0 (CR 9.8). */
  | { kind: "subroutine"; cardId: string; index: number }
  /** The new remote server an install creates (CR 4.6.8b, CR 8.5.2a). */
  | { kind: "new_remote" };

export interface LegalPlacement {
  group: LegalGroup;
  /** What the player clicks first: the card or server the action belongs to. */
  anchor: LegalAnchor;
  /** Where the action lands, when it takes a second click: an install's server, a break's subroutine. */
  target?: LegalAnchor;
}

const NONE: LegalAnchor = { kind: "none" };

const GROUPS: Record<Intent["type"], LegalGroup> = {
  basic_gain_credit: "basic",
  basic_draw: "basic",
  basic_remove_tag: "basic",
  basic_purge_virus: "basic",
  basic_install: "install",
  play_event: "play",
  play_operation: "play",
  basic_run: "run",
  continue_run: "run",
  jack_out: "run",
  access_card: "run",
  steal_agenda: "run",
  trash_accessed: "run",
  finish_access: "run",
  finish_breach: "run",
  access_rfg_paying_trash_cost: "run",
  access_trash_from_grip: "run",
  access_trash_with_virus: "run",
  access_trash_free: "run",
  access_trash_paying_printed_cost_from_stealth: "run",
  access_trash_self_non_agenda_draw: "run",
  access_host_non_agenda_faceup: "run",
  access_host_agenda_on_film_critic: "run",
  basic_trash_resource: "ability",
  advance: "ability",
  score_agenda: "ability",
  rez_ice: "ability",
  rez_asset: "ability",
  use_paid_ability: "ability",
  use_identity_ability: "ability",
  break_subroutine: "ability",
  break_bioroid_subroutine: "ability",
  break_bioroid_subroutines: "ability",
  trigger_pending_trash_interrupt: "ability",
  pass_window: "window",
  keep_starting_hand: "window",
  mulligan: "window",
  discard_to_hand_size: "choice",
  choose_option: "choice",
  choose_trash_program: "choice",
  resolve_sabotage: "choice",
  boost_trace: "choice",
  spend_link: "choice",
  resolve_trace: "choice",
  psi_runner_bid: "choice",
  psi_corp_bid: "choice",
  prevent_damage: "choice",
  prevent_damage_lose_all_clicks: "choice",
  accept_damage: "choice",
  accept_tags: "choice",
  accept_end_the_run: "choice",
  accept_expose: "choice",
  accept_installed_trash: "choice",
};

/** An intent type the pinned engine added after this table: a choice with no anchor. */
function legalGroup(type: Intent["type"]): LegalGroup {
  return GROUPS[type] ?? "choice";
}

export function legalPlacement(state: GameState, intent: Intent, secrets: ReadonlySet<string>): LegalPlacement {
  const group = legalGroup(intent.type);
  // CR 10.2.2a, CR 4.1.5: a card in a hand or deck this seat may not see is
  // never named. Its server stands in when the intent says which.
  const card = (id: string | undefined, fallback: LegalAnchor = NONE): LegalAnchor =>
    id && !secrets.has(id) && state.cards[id] ? { kind: "card", cardId: id } : fallback;
  const attacked = (): LegalAnchor =>
    state.run?.attackedServerId ? { kind: "server", serverId: state.run.attackedServerId } : NONE;
  const encounterIce = state.run?.encounter?.iceId;
  switch (intent.type) {
    case "basic_install":
      return { group, anchor: card(intent.cardId), target: destination(intent.destination, card) };
    case "play_event":
      return {
        group,
        anchor: card(intent.cardId),
        ...(intent.serverId ? { target: { kind: "server", serverId: intent.serverId } } : {}),
      };
    case "play_operation":
      return { group, anchor: card(intent.cardId) };
    case "basic_run":
      return { group, anchor: { kind: "server", serverId: intent.serverId } };
    case "continue_run":
    case "jack_out":
    case "finish_access":
    case "finish_breach":
      return { group, anchor: attacked() };
    // The card being accessed is open to the Runner (CR 7.3.1a); a card still
    // in HQ or R&D is not, so the attacked server stands in.
    case "access_card":
    case "steal_agenda":
    case "trash_accessed":
    case "access_trash_free":
    case "access_trash_with_virus":
    case "access_rfg_paying_trash_cost":
    case "access_trash_paying_printed_cost_from_stealth":
    case "access_trash_self_non_agenda_draw":
    case "access_host_non_agenda_faceup":
    case "access_host_agenda_on_film_critic":
      return { group, anchor: card(intent.cardId, attacked()) };
    case "access_trash_from_grip":
      return { group, anchor: card(state.run?.accessingCardId ?? undefined, attacked()) };
    case "basic_trash_resource":
    case "advance":
    case "score_agenda":
    case "rez_ice":
    case "rez_asset":
    case "trigger_pending_trash_interrupt":
    case "choose_trash_program":
      return { group, anchor: card(intent.cardId) };
    case "use_paid_ability":
      return {
        group,
        anchor: card(intent.cardId),
        ...(intent.serverId ? { target: { kind: "server", serverId: intent.serverId } } : {}),
      };
    case "use_identity_ability": {
      const corpHas = state.cards[state.corp.identityId]?.paidAbilities?.some((item) => item.id === intent.abilityId);
      return { group, anchor: card(corpHas ? state.corp.identityId : state.runner.identityId) };
    }
    case "break_subroutine":
      return {
        group,
        anchor: card(intent.breakerId),
        target: encounterIce ? { kind: "subroutine", cardId: encounterIce, index: intent.subIndex } : NONE,
      };
    case "break_bioroid_subroutine":
      return {
        group,
        anchor: encounterIce ? { kind: "subroutine", cardId: encounterIce, index: intent.subIndex } : NONE,
      };
    case "break_bioroid_subroutines":
      return { group, anchor: card(encounterIce) };
    case "choose_option":
      return { group, anchor: card(state.pendingChoice?.sourceId) };
    case "discard_to_hand_size":
      return { group, anchor: intent.cardIds?.length === 1 ? card(intent.cardIds[0]) : NONE };
    default:
      return { group, anchor: NONE };
  }
}

function destination(
  where: Extract<Intent, { type: "basic_install" }>["destination"],
  card: (id: string | undefined) => LegalAnchor,
): LegalAnchor {
  switch (where.kind) {
    case "new_remote":
      return { kind: "new_remote" };
    case "remote_root":
    case "protect":
      return { kind: "server", serverId: where.serverId };
    case "host_ice":
      return card(where.iceId);
    case "host_card":
    case "host_upgrade":
      return card(where.hostId);
    default:
      // The Runner's rig: no second click.
      return NONE;
  }
}

/**
 * The intent the primary button takes, by rank: keep the hand, carry on with
 * the run, pass, take what is coming, and in an action phase gain a credit.
 * Otherwise the first entry, so a seat with any legal intent has exactly one.
 */
const DEFAULT_RANK: Intent["type"][] = [
  "keep_starting_hand",
  "continue_run",
  "finish_access",
  "finish_breach",
  "pass_window",
  "accept_damage",
  "accept_tags",
  "accept_end_the_run",
  "accept_expose",
  "accept_installed_trash",
  "resolve_trace",
  "psi_runner_bid",
  "psi_corp_bid",
  "basic_gain_credit",
];

export function defaultIndex(intents: readonly Intent[]): number {
  if (intents.length === 0) return -1;
  for (const type of DEFAULT_RANK) {
    let best = -1;
    intents.forEach((intent, index) => {
      if (intent.type !== type) return;
      // A bid of nothing, when the bid is the choice (CR 10.14.6b).
      if (best < 0 || bidOf(intent) < bidOf(intents[best]!)) best = index;
    });
    if (best >= 0) return best;
  }
  return 0;
}

function bidOf(intent: Intent): number {
  return "amount" in intent && typeof intent.amount === "number" ? intent.amount : 0;
}
