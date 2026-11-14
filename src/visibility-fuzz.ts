/**
 * Visibility fuzz (CR audit tool 1.7, session P1-e). Test code: the server
 * does not import this file.
 *
 * Plays seeded matches through `Match`, choosing each move at random from the
 * legal intents in the seats' snapshots. After every applied intent it takes
 * the Corp, Runner and spectator snapshots exactly as a client receives them
 * (after `stripSecrets`) and walks each one as JSON for a card id or a card
 * title that viewer may not see.
 *
 * The oracle (`hiddenFrom`) is built from the raw engine state and the
 * Comprehensive Rules (pin v26.03), not from `getPublicView`,
 * `seatVisibility` or the game's `canSeeTitle`, which are what is under test.
 *
 * Hidden classes and the rule each one follows:
 * - `hand`: HQ and the grip are hidden from the other player (CR 10.2.2a).
 *   The Corp sees the grip while a card says it is revealed (CR 10.2.3b).
 * - `deck`: R&D and the stack are hidden zones, from both players
 *   (CR 4.1.5, CR 10.2.2a). An id there is hidden too, so the deck's order is.
 * - `facedown_installed`: facedown installed or hosted cards (CR 1.21.1,
 *   CR 10.2.2a). Their controller may look at them (CR 1.21.2a).
 * - `facedown_archives`: facedown cards in Archives (CR 1.21.1, CR 10.2.2a).
 * - `facedown_set_aside`: cards set aside facedown (CR 4.8.6, CR 4.8.7).
 * - `facedown_other`: any other facedown card in a public zone (CR 1.21.1,
 *   CR 4.1.4).
 *
 * Exceptions:
 * - a card a player is looking at (`lookedBy`) is open to that player only
 *   (CR 1.21.2, CR 1.21.6);
 * - the card the Runner is accessing, and the cards they accessed this breach,
 *   are open to the Runner (CR 7.3.1a);
 * - a revealed or exposed card is open to both players while it is shown
 *   (CR 1.21.3, CR 1.21.4). The engine records a reveal as titles without ids
 *   (`state.reveals`), so a title revealed by this intent is allowed for every
 *   viewer at this step only. A look (`state.looks`) is allowed the same way,
 *   for the player who looked only (CR 1.21.2).
 * - the spectator sees open information only (CR 10.2.3a): a card is open to
 *   the spectator when it is open to both players, leaving out looks, which
 *   are not shown to anyone else (CR 1.21.2). A card the Runner accesses from
 *   HQ is open to both players, so to the spectator too; one from R&D is not.
 *
 * A location stays open: the id of a facedown card in a public zone is not a
 * leak (CR 1.21.1, CR 4.1.4). Only an id in a hand or a deck is.
 *
 * Matching. A snapshot leaks a hidden card when:
 * - `id`: a string equals or contains the id of a card in a hidden hand or
 *   deck, or an object key is that id;
 * - `title` (linked): an object names a hidden card (a string field equal to
 *   its id, or the object is keyed by its id) and a string field of that same
 *   object holds the card's title; or one string holds both the id and the title;
 * - `title` (only copy): a string holds a title that only hidden cards carry
 *   for this viewer, and no copy of that title is open to the viewer before or
 *   after the intent. Such a title can only name the hidden card. A string
 *   already present at the same path in the viewer's previous snapshot is not
 *   checked again, so the log and other history are judged once, when they
 *   are written.
 * The same title on an open copy is not a leak. Titles match on word boundaries.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agendaPointBand, loadCardCatalog, type GameState } from "netrunner-engine";
import { learnToPlaySetup, mulberry32, setupForOpening } from "./decks.js";
import { createMatch, forgetMatch, MatchError, type Match, type SeatSnapshot } from "./match.js";

export type Viewer = "corp" | "runner" | "spectator";
export const VIEWERS: readonly Viewer[] = ["corp", "runner", "spectator"];

export type HiddenClass =
  | "hand"
  | "deck"
  | "facedown_installed"
  | "facedown_archives"
  | "facedown_set_aside"
  | "facedown_other";

/** The rule each hidden class follows (CR v26.03). */
export const CLASS_RULES: Record<HiddenClass, string> = {
  hand: "CR 10.2.2a",
  deck: "CR 4.1.5, CR 10.2.2a",
  facedown_installed: "CR 1.21.1, CR 10.2.2a",
  facedown_archives: "CR 1.21.1, CR 10.2.2a",
  facedown_set_aside: "CR 4.8.6, CR 4.8.7",
  facedown_other: "CR 1.21.1, CR 4.1.4",
};

export interface Hidden {
  cls: HiddenClass;
  /** The id itself is secret (a hand or a deck), not just the face. */
  idHidden: boolean;
  title: string;
}

type Card = GameState["cards"][string];
type Seat = "corp" | "runner";

/**
 * Whether the Corp sees the grip: the Runner is tagged and a Corp identity or
 * installed card says the grip is revealed while they are (CR 10.2.3b). Read
 * from the card flag, ignoring blanking, so it errs toward allowing.
 */
function gripOpen(state: GameState): boolean {
  if ((state.runner.tags ?? 0) <= 0) return false;
  const flagged = (id: string) =>
    Boolean((state.cards[id] as { revealGripWhileRunnerTagged?: unknown } | undefined)?.revealGripWhileRunnerTagged);
  return flagged(state.corp.identityId) || state.runner.installed.some(flagged);
}

function seatHidden(state: GameState, seat: Seat, card: Card, grip: boolean, forSpectator = false): Hidden | null {
  if (card.type === "identity") return null;
  const title = card.title;
  // Looking (CR 1.21.2, CR 1.21.6). A look is not shown to anyone else, so
  // it never makes a card open to the spectator.
  if (card.lookedBy === seat && !forSpectator) return null;
  // Accessing, and the rest of the breach (CR 7.3.1a).
  const run = state.run as { accessingCardId?: string | null; accessedCardIds?: string[] } | null | undefined;
  if (seat === "runner" && run && (run.accessingCardId === card.id || run.accessedCardIds?.includes(card.id))) {
    return null;
  }
  // Decks: hidden from both players, ids included (CR 4.1.5, CR 10.2.2a).
  // A card in a deck is neither faceup nor facedown (CR 1.21.1a).
  if (state.corp.deck.includes(card.id) || state.runner.deck.includes(card.id)) {
    return { cls: "deck", idHidden: true, title };
  }
  // Hands (CR 10.2.2a). The flag says nothing here either (CR 1.21.1a).
  if (state.corp.hand.includes(card.id) || state.runner.hand.includes(card.id)) {
    if (card.side === seat) return null;
    if (seat === "corp" && grip && state.runner.hand.includes(card.id)) return null;
    return { cls: "hand", idHidden: true, title };
  }
  // Public zones (CR 4.1.4): faceup cards are open to all (CR 1.21.1).
  if (card.rezzed || card.faceup) return null;
  if (card.zone === "removed-from-game") return null; // CR 4.9.6
  // A player may look at facedown cards they control (CR 1.21.2a).
  if (card.side === seat) return null;
  const zone = String(card.zone);
  if (zone === "corp:archives") return { cls: "facedown_archives", idHidden: false, title };
  if (zone.endsWith(":set-aside")) return { cls: "facedown_set_aside", idHidden: false, title };
  if (zone.startsWith("server:") || zone.startsWith("hosted:") || zone === "runner:installed") {
    return { cls: "facedown_installed", idHidden: false, title };
  }
  if (zone === "corp:hq" || zone === "runner:grip" || zone === "corp:rd" || zone === "runner:stack") {
    // In a hidden zone's place but not in the player's list: taken out while
    // an ability resolves. Treat it as the zone it came from.
    return zone.endsWith("rd") || zone.endsWith("stack")
      ? { cls: "deck", idHidden: true, title }
      : { cls: "hand", idHidden: true, title };
  }
  return { cls: "facedown_other", idHidden: false, title };
}

/** Cards `viewer` may not see, by id. The spectator sees what both players see (CR 10.2.3a). */
export function hiddenFrom(state: GameState, viewer: Viewer): Map<string, Hidden> {
  const out = new Map<string, Hidden>();
  const grip = gripOpen(state);
  for (const card of Object.values(state.cards)) {
    if (viewer === "spectator") {
      const corp = seatHidden(state, "corp", card, grip, true);
      const runner = seatHidden(state, "runner", card, grip, true);
      const hidden = corp && runner ? (corp.idHidden ? corp : runner) : (corp ?? runner);
      if (hidden) out.set(card.id, hidden);
    } else {
      const hidden = seatHidden(state, viewer, card, grip);
      if (hidden) out.set(card.id, hidden);
    }
  }
  return out;
}

/** Titles of cards open to the viewer. */
function openTitles(state: GameState, hidden: Map<string, Hidden>): Set<string> {
  const out = new Set<string>();
  for (const card of Object.values(state.cards)) if (!hidden.has(card.id)) out.add(card.title);
  return out;
}

// ---------------------------------------------------------------- walking

export interface Leak {
  viewer: Viewer;
  kind: "id" | "title";
  cls: HiddenClass;
  /** Snapshot path with array indices as `[]`, card-id keys as `{id}`, remotes as `remote-N`. */
  path: string;
}

export function leakKey(leak: Leak): string {
  return `${leak.viewer} ${leak.kind} ${leak.cls} ${leak.path}`;
}

export interface LeakExample extends Leak {
  format: FuzzFormat;
  seed: number;
  step: number;
  card: string;
  value: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const titlePatterns = new Map<string, RegExp>();
function titlePattern(title: string): RegExp {
  let re = titlePatterns.get(title);
  if (!re) {
    re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(title)}($|[^\\p{L}\\p{N}])`, "u");
    titlePatterns.set(title, re);
  }
  return re;
}

function mentions(text: string, title: string): boolean {
  return text.includes(title) && titlePattern(title).test(text);
}

interface CheckContext {
  viewer: Viewer;
  state: GameState;
  hidden: Map<string, Hidden>;
  /** Hidden id → for `id` checks. */
  secretIds: Map<string, Hidden>;
  /** Title → hidden cards that carry it, when no copy is open now or before. */
  onlyHidden: Map<string, Hidden>;
  /** Titles revealed by this intent (CR 1.21.3). */
  revealed: Set<string>;
  /** `path\0value` pairs from the previous snapshot. */
  previous: Set<string>;
  seen: Set<string>;
  found: Array<Leak & { card: string; value: string }>;
}

function normalizeKey(key: string, state: GameState): string {
  if (state.cards[key] || key.startsWith("ref_")) return "{id}";
  if (/^remote-\d+$/.test(key)) return "remote-N";
  return key;
}

function report(ctx: CheckContext, kind: Leak["kind"], hidden: Hidden, path: string, value: string): void {
  ctx.found.push({ viewer: ctx.viewer, kind, cls: hidden.cls, path, card: hidden.title, value: value.slice(0, 160) });
}

function walk(ctx: CheckContext, value: unknown, path: string, keyedBy: string | null): void {
  if (typeof value === "string") {
    checkString(ctx, value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(ctx, item, `${path}[]`, null);
    return;
  }
  if (!value || typeof value !== "object") return;
  const entries = Object.entries(value as Record<string, unknown>);
  // Linked title: the object names a hidden card and holds its title.
  const named = new Set<string>();
  if (keyedBy) named.add(keyedBy);
  for (const [, item] of entries) {
    if (typeof item === "string" && ctx.hidden.has(item)) named.add(item);
  }
  for (const id of named) {
    const hidden = ctx.hidden.get(id)!;
    if (ctx.revealed.has(hidden.title)) continue;
    for (const [key, item] of entries) {
      if (typeof item === "string" && item !== id && mentions(item, hidden.title)) {
        report(ctx, "title", hidden, `${path}.${normalizeKey(key, ctx.state)}`, item);
      }
    }
  }
  for (const [key, item] of entries) {
    const childPath = path ? `${path}.${normalizeKey(key, ctx.state)}` : normalizeKey(key, ctx.state);
    const secret = ctx.secretIds.get(key);
    if (secret) report(ctx, "id", secret, childPath, key);
    walk(ctx, item, childPath, ctx.hidden.has(key) ? key : null);
  }
}

function checkString(ctx: CheckContext, text: string, path: string): void {
  const pair = `${path}\0${text}`;
  ctx.seen.add(pair);
  for (const [id, hidden] of ctx.secretIds) {
    if (text.includes(id)) report(ctx, "id", hidden, path, text);
  }
  // One string holding a hidden card's id and title (the id may be a
  // facedown card's open location).
  for (const [id, hidden] of ctx.hidden) {
    if (hidden.idHidden || !text.includes(id) || text === id) continue;
    if (!ctx.revealed.has(hidden.title) && mentions(text, hidden.title)) report(ctx, "title", hidden, path, text);
  }
  if (ctx.previous.has(pair)) return;
  for (const [title, hidden] of ctx.onlyHidden) {
    if (mentions(text, title)) report(ctx, "title", hidden, path, text);
  }
}

/**
 * Leaks in one viewer's snapshot. `before` is the hidden map from the state
 * before the intent, so a title open on either side of the intent is not a
 * leak. Returns the `path\0value` set for the next call's `previous`.
 */
export function checkSnapshot(
  viewer: Viewer,
  state: GameState,
  snapshot: SeatSnapshot,
  before: { hidden: Map<string, Hidden>; open: Set<string> } | null,
  revealed: Set<string>,
  previous: Set<string>,
): { leaks: Array<Leak & { card: string; value: string }>; seen: Set<string>; hidden: Map<string, Hidden>; open: Set<string> } {
  const hidden = hiddenFrom(state, viewer);
  const open = openTitles(state, hidden);
  const secretIds = new Map<string, Hidden>();
  for (const [id, h] of hidden) if (h.idHidden) secretIds.set(id, h);
  const onlyHidden = new Map<string, Hidden>();
  for (const h of hidden.values()) {
    if (open.has(h.title) || before?.open.has(h.title) || revealed.has(h.title)) continue;
    onlyHidden.set(h.title, h);
  }
  const ctx: CheckContext = {
    viewer,
    state,
    hidden,
    secretIds,
    onlyHidden,
    revealed,
    previous,
    seen: new Set(),
    found: [],
  };
  walk(ctx, snapshot, "", null);
  return { leaks: ctx.found, seen: ctx.seen, hidden, open };
}

// ---------------------------------------------------------------- decks

export const FUZZ_FORMATS = ["learn_to_play", "startup"] as const;
export type FuzzFormat = (typeof FUZZ_FORMATS)[number];

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CARDS = join(ROOT, "vendor/cards-data");

function readCards<T>(rel: string): T {
  return JSON.parse(readFileSync(join(CARDS, rel), "utf8")) as T;
}

interface DefLike {
  id: string;
  type: string;
  side: Seat;
  faction?: string;
  agendaPoints?: number;
  deckLimit?: number;
  deckLimitOne?: boolean;
  minimumDeckSize?: number;
}

/** Gateway starter identities play only their own lists (CR 1.4.1a). */
const STARTER_IDENTITIES = new Set(["the-syndicate-profit-over-principle", "the-catalyst-convention-breaker"]);
const NEUTRAL = new Set(["neutral-corp", "neutral-runner"]);

let startupCards: DefLike[] | null = null;
let startupMaxThrees = Infinity;

/** The current Startup pool, less its bans (CR 1.4.8). */
function startupPool(): DefLike[] {
  if (startupCards) return startupCards;
  const format = readCards<{ snapshots: { cardPoolId: string; restrictionId?: string }[] }>("formats/startup.json");
  const snapshot = format.snapshots.at(-1)!;
  const cardPool = readCards<{ waves: string[] }>(`card-pools/${snapshot.cardPoolId}.json`);
  const pool = readCards<{ waves: Record<string, { cards: string[] }> }>("pool.json");
  const restriction = snapshot.restrictionId
    ? readCards<{ banned?: string[]; max3PointAgendas?: number }>(`restrictions/${snapshot.restrictionId}.json`)
    : {};
  startupMaxThrees = restriction.max3PointAgendas ?? Infinity;
  const banned = new Set(restriction.banned ?? []);
  const catalog = loadCardCatalog();
  const out: DefLike[] = [];
  for (const wave of cardPool.waves) {
    for (const id of pool.waves[wave]?.cards ?? []) {
      const def = catalog.get(id) as DefLike | undefined;
      if (def && !banned.has(id)) out.push(def);
    }
  }
  startupCards = out;
  return out;
}

/**
 * A random Startup deck: identity, then in-faction and neutral cards only (no
 * influence spent), agendas first to the agenda band (CR 1.4.6), at the
 * identity's minimum size (CR 1.4.3), within copy limits (CR 1.4.7) and the
 * format's 3-point agenda cap (CR 1.4.8). Legal by construction: the game's
 * `reviewSubmittedDeck` charges influence for in-faction cards, so it is not
 * used here.
 */
export function startupDeck(side: Seat, random: () => number): { identityId: string; cards: string[] } {
  const defs = startupPool().filter((def) => def.side === side);
  const identities = defs.filter((def) => def.type === "identity" && !STARTER_IDENTITIES.has(def.id));
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  for (let attempt = 0; attempt < 100; attempt++) {
    const identity = pick(identities);
    const size = identity.minimumDeckSize ?? (side === "corp" ? 45 : 40);
    const usable = defs.filter(
      (def) => def.type !== "identity" && (def.faction === identity.faction || NEUTRAL.has(def.faction ?? "")),
    );
    const counts = new Map<string, number>();
    const cards: string[] = [];
    let threes = 0;
    const add = (def: DefLike): boolean => {
      const have = counts.get(def.id) ?? 0;
      if (have >= (def.deckLimitOne ? 1 : (def.deckLimit ?? 3))) return false;
      if (def.agendaPoints === 3 && threes >= startupMaxThrees) return false;
      counts.set(def.id, have + 1);
      if (def.agendaPoints === 3) threes += 1;
      cards.push(def.id);
      return true;
    };
    if (side === "corp") {
      const band = agendaPointBand(size);
      if (!band) continue;
      const agendas = usable.filter((def) => def.type === "agenda");
      let points = 0;
      for (let tries = 0; tries < 300 && points < band.min; tries++) {
        const def = pick(agendas);
        if (points + (def.agendaPoints ?? 0) > band.max) continue;
        if (add(def)) points += def.agendaPoints ?? 0;
      }
      if (points < band.min) continue;
    }
    const others = usable.filter((def) => def.type !== "agenda");
    for (let tries = 0; tries < 3000 && cards.length < size; tries++) add(pick(others));
    if (cards.length < size) continue;
    return { identityId: identity.id, cards };
  }
  throw new Error(`could not build a Startup ${side} deck`);
}

export function setupFor(format: FuzzFormat, seed: number): () => GameState {
  if (format === "learn_to_play") return () => learnToPlaySetup(seed, "starter");
  const random = mulberry32(seed ^ 0x5eed);
  const corp = startupDeck("corp", random);
  const runner = startupDeck("runner", random);
  return setupForOpening({ seed, corp, runner });
}

// ---------------------------------------------------------------- playing

export interface PlayResult {
  format: FuzzFormat;
  seed: number;
  steps: number;
  rejected: number;
  ended: "done" | "budget" | "no_legal_action" | "crash";
  detail?: string;
  leaks: LeakExample[];
}

/** The engine state behind the snapshots. Test-only reach into a private field. */
function rawState(match: Match): GameState {
  return (match as unknown as { state: GameState }).state;
}

/** The acting seat's snapshot is the one `submit` sent it; the others are built now. */
function snapshots(match: Match, acted?: { seat: Seat; snapshot: SeatSnapshot }): Record<Viewer, SeatSnapshot> {
  return {
    corp: acted?.seat === "corp" ? acted.snapshot : match.snapshotForRole("corp"),
    runner: acted?.seat === "runner" ? acted.snapshot : match.snapshotForRole("runner"),
    spectator: match.snapshotForRole("spectator"),
  };
}

/** A card id the seat's intent named, through the match's ref tokens. Test-only reach. */
function intentCardIds(match: Match, intent: unknown): string[] {
  const refs = (match as unknown as { secretRefs: Map<string, string> }).secretRefs;
  const state = rawState(match);
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      const id = refs.get(value) ?? value;
      if (state.cards[id]) out.push(id);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(intent);
  return out;
}

function runAccess(state: GameState): string[] {
  const run = state.run as { accessingCardId?: string | null; accessedCardIds?: string[] } | null | undefined;
  if (!run) return [];
  return [...(run.accessedCardIds ?? []), ...(run.accessingCardId ? [run.accessingCardId] : [])];
}

/**
 * Who submits the intents. `seat` plays through each seat's own link. `debug`
 * plays both seats from the debug page's snapshot and token (verification
 * table V1); the seat links are still checked after every step.
 */
export type FuzzDriver = "seat" | "debug";

/**
 * One seeded match. Each step picks a seat with legal intents, then one of
 * that seat's intents, from the snapshots that seat was sent.
 */
export async function playMatch(
  format: FuzzFormat,
  seed: number,
  maxSteps: number,
  driver: FuzzDriver = "seat",
  /** Another opening, such as a scenario position. `format` then only labels the result. */
  setup?: () => GameState,
): Promise<PlayResult> {
  const match = createMatch({ setup: setup ?? setupFor(format, seed) });
  const random = mulberry32((seed * 0x9e3779b1) ^ 0x1e7);
  const leaks: LeakExample[] = [];
  const firstByKey = new Set<string>();
  const previous: Record<Viewer, Set<string>> = { corp: new Set(), runner: new Set(), spectator: new Set() };
  let before: Record<Viewer, { hidden: Map<string, Hidden>; open: Set<string> } | null> = {
    corp: null,
    runner: null,
    spectator: null,
  };
  let rejected = 0;
  let steps = 0;
  let ended: PlayResult["ended"] = "budget";
  let detail: string | undefined;

  const check = (
    step: number,
    allowed: Record<Viewer, Set<string>>,
    acted?: { seat: Seat; snapshot: SeatSnapshot },
  ): Record<Viewer, SeatSnapshot> => {
    const state = rawState(match);
    const snaps = snapshots(match, acted);
    const next = { ...before };
    for (const viewer of VIEWERS) {
      const result = checkSnapshot(viewer, state, snaps[viewer], before[viewer], allowed[viewer], previous[viewer]);
      previous[viewer] = result.seen;
      next[viewer] = { hidden: result.hidden, open: result.open };
      for (const leak of result.leaks) {
        const key = `${leakKey(leak)}`;
        if (firstByKey.has(key)) continue;
        firstByKey.add(key);
        leaks.push({ ...leak, format, seed, step });
      }
    }
    before = next;
    return snaps;
  };

  try {
    const none = () => ({ corp: new Set<string>(), runner: new Set<string>(), spectator: new Set<string>() });
    let snaps = check(-1, none());
    for (; steps < maxSteps; steps++) {
      if (match.result().done) {
        ended = "done";
        break;
      }
      const lists =
        driver === "debug"
          ? match.snapshotForRole("debug").debug!
          : { corp: snaps.corp, runner: snaps.runner };
      const options = [
        ...lists.corp.legal.map((entry) => ({ seat: "corp" as const, entry })),
        ...lists.runner.legal.map((entry) => ({ seat: "runner" as const, entry })),
      ];
      if (options.length === 0) {
        ended = "no_legal_action";
        break;
      }
      const choice = options[Math.floor(random() * options.length)]!;
      const pre = rawState(match);
      const revealSeq = pre.revealSeq ?? 0;
      const lookSeq = pre.lookSeq ?? 0;
      // Cards the Runner accessed during this intent stay open to them for
      // the breach (CR 7.3.1a); the run may end within the same intent.
      const accessed = [
        ...runAccess(pre),
        ...(choice.entry.intent.type === "access_card" ? intentCardIds(match, choice.entry.intent) : []),
      ];
      let acted: { seat: Seat; snapshot: SeatSnapshot } | undefined;
      try {
        if (driver === "debug") {
          await match.submit(match.tokens.debug, `fuzz-${steps}`, choice.entry.intent, choice.seat);
        } else {
          const snapshot = await match.submit(match.tokens[choice.seat], `fuzz-${steps}`, choice.entry.intent);
          acted = { seat: choice.seat, snapshot };
        }
      } catch (error) {
        if (!(error instanceof MatchError)) throw error;
        rejected += 1;
      }
      const state = rawState(match);
      const allowed = none();
      for (const event of state.reveals ?? []) {
        if (event.seq <= revealSeq) continue;
        // A reveal shows the card to all players (CR 1.21.3).
        for (const card of event.cards) for (const viewer of VIEWERS) allowed[viewer].add(card.title);
      }
      for (const event of state.looks ?? []) {
        if (event.seq <= lookSeq) continue;
        // A look shows the card to the player looking only (CR 1.21.2).
        for (const card of event.cards) allowed[event.by].add(card.title);
      }
      for (const id of [...accessed, ...runAccess(state)]) {
        const title = state.cards[id]?.title;
        if (title) allowed.runner.add(title);
      }
      snaps = check(steps, allowed, acted);
    }
  } catch (error) {
    ended = "crash";
    detail = error instanceof Error ? `${error.message}` : String(error);
  } finally {
    forgetMatch(match.id);
  }
  return { format, seed, steps, rejected, ended, ...(detail ? { detail } : {}), leaks };
}

export interface FuzzRun {
  results: PlayResult[];
  /** First example of each leak key, in the order found. */
  leaks: Map<string, LeakExample>;
  ms: number;
}

export async function runFuzz(
  formats: readonly FuzzFormat[],
  seeds: readonly number[],
  maxSteps: number,
): Promise<FuzzRun> {
  const started = performance.now();
  const results: PlayResult[] = [];
  const leaks = new Map<string, LeakExample>();
  for (const format of formats) {
    for (const seed of seeds) {
      const result = await playMatch(format, seed, maxSteps);
      results.push(result);
      for (const leak of result.leaks) {
        const key = leakKey(leak);
        if (!leaks.has(key)) leaks.set(key, leak);
      }
    }
  }
  return { results, leaks, ms: Math.round(performance.now() - started) };
}

// ---------------------------------------------------------------- baseline

export const BASELINE_PATH = join(ROOT, "test/baselines/visibility-leaks.json");

export interface BaselineEntry extends Leak {
  rule: string;
  /** First place this leak was seen, for people. Not compared. */
  example: { format: FuzzFormat; seed: number; step: number; card: string; value: string };
}

export interface Baseline {
  /** The CI run the baseline was recorded with. */
  seeds: number[];
  steps: number;
  formats: FuzzFormat[];
  leaks: BaselineEntry[];
}

export function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

export function baselineFrom(run: FuzzRun, config: { seeds: number[]; steps: number; formats: FuzzFormat[] }): Baseline {
  const leaks = [...run.leaks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, leak]) => ({
      viewer: leak.viewer,
      kind: leak.kind,
      cls: leak.cls,
      path: leak.path,
      rule: CLASS_RULES[leak.cls],
      example: { format: leak.format, seed: leak.seed, step: leak.step, card: leak.card, value: leak.value },
    }));
  return { ...config, leaks };
}

/**
 * The CI run: fixed seeds and steps, sized to the test budget (about 25 s,
 * run beside the other test files). Seed 9 reaches a Startup R&D access by
 * step 13 and seed 6 a Learn to play one by step 33. Most of the cost is the
 * game's `playable` trial-applying each legal intent for every seat snapshot.
 */
export const CI_FUZZ = {
  formats: [...FUZZ_FORMATS] as FuzzFormat[],
  seeds: [6, 9],
  steps: 80,
};
