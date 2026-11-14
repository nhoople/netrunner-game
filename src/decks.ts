/**
 * Null Signal System Gateway learn-to-play lists.
 * Starter cards are before the "STOP HERE" divider. The expanded list adds the booster cards after it.
 *
 * Corp: https://nullsignal.games/players/learn-to-play/learn-to-play-corp/
 * Runner: https://nullsignal.games/players/learn-to-play/learn-to-play-runner/
 */
import {
  createInitialState,
  deckbuildingReport,
  instantiateCard,
  loadCardCatalog,
  seedRng,
  type CardInstance,
  type DeckbuildingReport,
  type GameState,
} from "netrunner-engine";
import { scenarioSetup, type Scenario } from "./scenario.js";

const CORP_IDENTITY = "the-syndicate-profit-over-principle";
const RUNNER_IDENTITY = "the-catalyst-convention-breaker";

/** Quantities from the Corp learn-to-play starter list. 34 cards. */
const CORP_DECK: Record<string, number> = {
  "offworld-office": 3,
  "send-a-message": 2,
  "superconducting-hub": 2,
  "nico-campaign": 2,
  "urtica-cipher": 2,
  "regolith-mining-license": 2,
  "bran-1-0": 2,
  diviner: 2,
  karuna: 2,
  palisade: 3,
  tithe: 2,
  whitespace: 2,
  "seamless-launch": 2,
  "government-subsidy": 2,
  "hedge-fund": 3,
  "manegarm-skunkworks": 1,
};

/** Booster cards after the Corp "STOP HERE" divider. 10 cards. */
const CORP_BOOSTER: Record<string, number> = {
  "orbital-superiority": 2,
  funhouse: 2,
  "public-trail": 2,
  "predictive-planogram": 2,
  retribution: 1,
  "amaze-amusements": 1,
};

/** Quantities from the Runner learn-to-play starter list. 30 cards. */
const RUNNER_DECK: Record<string, number> = {
  "tread-lightly": 2,
  "creative-commission": 2,
  vrcation: 2,
  overclock: 2,
  jailbreak: 3,
  "sure-gamble": 3,
  "docklands-pass": 1,
  pennyshaver: 1,
  cleaver: 2,
  carmen: 2,
  unity: 2,
  mayfly: 2,
  "red-team": 1,
  "telework-contract": 2,
  "smartware-distributor": 2,
  "verbal-plasticity": 1,
};

/** Booster cards after the Runner "STOP HERE" divider. 10 cards. */
const RUNNER_BOOSTER: Record<string, number> = {
  "wildcat-strike": 2,
  "mutual-favor": 2,
  "dzmz-optimizer": 2,
  leech: 2,
  conduit: 2,
};

export type LearnToPlayList = "starter" | "expanded";

function merged(base: Record<string, number>, extra: Record<string, number>): Record<string, number> {
  const out = { ...base };
  for (const [id, count] of Object.entries(extra)) out[id] = (out[id] ?? 0) + count;
  return out;
}

function flat(list: Record<string, number>): string[] {
  const ids: string[] = [];
  for (const [slug, count] of Object.entries(list)) {
    for (let n = 0; n < count; n++) ids.push(slug);
  }
  return ids;
}

export function learnToPlayDeck(
  side: "corp" | "runner",
  list: LearnToPlayList = "starter",
): { identityId: string; cards: string[] } {
  const corp = list === "expanded" ? merged(CORP_DECK, CORP_BOOSTER) : CORP_DECK;
  const runner = list === "expanded" ? merged(RUNNER_DECK, RUNNER_BOOSTER) : RUNNER_DECK;
  if (side === "corp") return { identityId: CORP_IDENTITY, cards: flat(corp) };
  return { identityId: RUNNER_IDENTITY, cards: flat(runner) };
}

/** A card the catalog loaded. Declaration fields are already written onto it. */
type CatalogCard = {
  id: string;
  type: string;
  side: "corp" | "runner";
  faction?: string;
  influence?: number;
  agendaPoints?: number;
  deckLimit?: number;
  deckLimitOne?: boolean;
  minimumDeckSize?: number;
  influenceLimit?: number;
  zeroInfluenceIfIceInDeckLte?: number;
  zeroInfluenceIfCardsInDeckGte?: number;
  zeroInfluenceIfAssetsInDeckGte?: number;
  zeroInfluenceIfNonAllianceFactionCardsGte?: { threshold?: number };
  zeroInfluenceIfCardCopiesGte?: { cardId?: string; threshold?: number };
};

const NEUTRAL_FACTIONS = new Set(["neutral-corp", "neutral-runner"]);

/**
 * Only out-of-faction cards cost influence. Neutral cards are out-of-faction
 * too, so a neutral card's printed influence still counts (CR 1.4.5).
 */
function inFactionWith(identity: CatalogCard, card: CatalogCard): boolean {
  if (!card.faction || NEUTRAL_FACTIONS.has(card.faction)) return false;
  return card.faction === identity.faction;
}

export interface DeckReview {
  legal: boolean;
  /** Null when the identity itself cannot be read. */
  report: DeckbuildingReport | null;
  problems: string[];
}

/**
 * Deck construction for one seat (CR 1.4.2). The identity is outside the deck
 * (CR 1.4.3a). Size, influence, and agenda points are the engine report
 * (CR 1.4.3, CR 1.4.5, CR 1.4.6). Those limits do not apply once the game
 * has started (CR 3.1.2). Format bans are not part of this check.
 */
export function reviewSubmittedDeck(
  side: "corp" | "runner",
  identityId: string,
  cards: readonly string[],
): DeckReview {
  const catalog = loadCardCatalog();
  const identity = catalog.get(identityId) as CatalogCard | undefined;
  if (!identity) {
    return { legal: false, report: null, problems: [`unknown identity ${identityId}`] };
  }
  if (identity.type !== "identity") {
    return { legal: false, report: null, problems: [`${identityId} is not an identity`] };
  }
  if (identity.side !== side) {
    return {
      legal: false,
      report: null,
      problems: [`${identityId} is a ${identity.side} identity`],
    };
  }

  const problems: string[] = [];
  const entries = [];
  for (const id of cards) {
    const card = catalog.get(id) as CatalogCard | undefined;
    if (!card) {
      problems.push(`unknown card ${id}`);
      continue;
    }
    if (card.type === "identity") {
      problems.push(`${id} is an identity and is outside the deck (CR 1.4.3a)`);
      continue;
    }
    if (card.side !== side) {
      problems.push(`${id} is not a ${side} card`);
      continue;
    }
    const copiesOf = card.zeroInfluenceIfCardCopiesGte;
    entries.push({
      defId: card.id,
      influence: inFactionWith(identity, card) ? 0 : card.influence,
      faction: card.faction,
      type: card.type,
      agendaPoints: card.agendaPoints,
      deckLimit: card.deckLimit,
      deckLimitOne: card.deckLimitOne === true ? true : undefined,
      zeroInfluenceIfIceInDeckLte: card.zeroInfluenceIfIceInDeckLte,
      zeroInfluenceIfCardsInDeckGte: card.zeroInfluenceIfCardsInDeckGte,
      zeroInfluenceIfAssetsInDeckGte: card.zeroInfluenceIfAssetsInDeckGte,
      zeroInfluenceIfNonAllianceFactionCardsGte:
        card.zeroInfluenceIfNonAllianceFactionCardsGte?.threshold,
      zeroInfluenceIfCardCopiesGte:
        copiesOf?.cardId === card.id ? copiesOf.threshold : undefined,
    });
  }

  const report = deckbuildingReport(entries, {
    side,
    faction: identity.faction,
    minimumDeckSize: identity.minimumDeckSize,
    influenceLimit: identity.influenceLimit,
  });
  if (report.overLimit.length > 0) {
    problems.push(`over deck limit: ${report.overLimit.join(", ")}`);
  }
  if (report.underMinimum) {
    problems.push(
      `deck has ${report.deckSize} cards; minimum is ${identity.minimumDeckSize} (CR 1.4.3)`,
    );
  }
  if (report.overInfluence) {
    problems.push(
      `influence ${report.influence} exceeds ${identity.influenceLimit} (CR 1.4.5)`,
    );
  }
  if (report.agendaOutOfRange) {
    problems.push(
      `agenda points ${report.agendaPoints}; this deck needs ${report.agendaMin}–${report.agendaMax} (CR 1.4.6)`,
    );
  }
  return { legal: problems.length === 0, report, problems };
}

export interface DeckList {
  identityId: string;
  cards: string[];
}

/** Enough to deal the same opening again. The applied intents are the rest of the match. */
export type MatchOpening =
  | { seed: number; preset: LearnToPlayList }
  | { seed: number; corp: DeckList; runner: DeckList }
  /** A position built on the debug page (verification table V3). Never format-checked. */
  | { seed: number; scenario: Scenario };

export type MatchSetup =
  | { ok: true; setup: () => GameState; opening?: MatchOpening }
  | {
      ok: false;
      status: 400 | 422;
      error: string;
      corp?: DeckReview;
      runner?: DeckReview;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deckBody(value: unknown): { identityId: string; cards: string[] } | null {
  if (!isRecord(value)) return null;
  if (typeof value.identityId !== "string") return null;
  if (!Array.isArray(value.cards) || value.cards.some((id) => typeof id !== "string")) return null;
  return { identityId: value.identityId, cards: value.cards };
}

/**
 * No submitted decks starts the learn-to-play match. A submitted pair is
 * checked before the match exists (CR 3.1.2).
 */
export function matchSetupFromBody(body: unknown, seed?: number): MatchSetup {
  if (isRecord(body) && "scenario" in body) {
    return {
      ok: false,
      status: 400,
      error: "A scenario starts from a match's debug page, not here.",
    };
  }
  if (isRecord(body) && body.preset !== undefined) {
    if ("corp" in body || "runner" in body) {
      return {
        ok: false,
        status: 400,
        error: "A preset match does not take submitted decks.",
      };
    }
    const preset = body.preset;
    if (preset === "starter" || preset === "expanded") {
      return opened(() => learnToPlaySetup(seed, preset), seed, { preset });
    }
    return { ok: false, status: 400, error: "Unknown learn-to-play list." };
  }
  if (!isRecord(body) || (!("corp" in body) && !("runner" in body))) {
    return opened(() => learnToPlaySetup(seed), seed, { preset: "starter" });
  }
  const corp = deckBody(body.corp);
  const runner = deckBody(body.runner);
  if (!corp || !runner) {
    return {
      ok: false,
      status: 400,
      error: "A submitted match needs a Corp deck and a Runner deck.",
    };
  }
  const corpReview = reviewSubmittedDeck("corp", corp.identityId, corp.cards);
  const runnerReview = reviewSubmittedDeck("runner", runner.identityId, runner.cards);
  if (!corpReview.legal || !runnerReview.legal) {
    return {
      ok: false,
      status: 422,
      error: "Deck is not legal (CR 1.4).",
      corp: corpReview,
      runner: runnerReview,
    };
  }
  return opened(
    () =>
      dealSetup(
        corp.identityId,
        corp.cards,
        runner.identityId,
        runner.cards,
        seed,
        "Submitted decks. First to 6 agenda points.",
      ),
    seed,
    { corp, runner },
  );
}

function opened(
  setup: () => GameState,
  seed: number | undefined,
  opening: { preset: LearnToPlayList } | { corp: DeckList; runner: DeckList },
): MatchSetup {
  if (seed === undefined) return { ok: true, setup };
  return { ok: true, setup, opening: { seed, ...opening } };
}

/** Deal the opening a stored match recorded. */
export function setupForOpening(opening: MatchOpening): () => GameState {
  if ("preset" in opening) return () => learnToPlaySetup(opening.seed, opening.preset);
  if ("scenario" in opening) return scenarioSetup(opening.scenario, opening.seed);
  return () =>
    dealSetup(
      opening.corp.identityId,
      opening.corp.cards,
      opening.runner.identityId,
      opening.runner.cards,
      opening.seed,
      "Submitted decks. First to 6 agenda points.",
    );
}

/** Deterministic PRNG (mulberry32) for seeded test shuffles. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number = Math.random): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = items[i]!;
    items[i] = items[j]!;
    items[j] = swap;
  }
}

export function learnToPlayCardIds(): string[] {
  return [
    CORP_IDENTITY,
    RUNNER_IDENTITY,
    ...Object.keys(CORP_DECK),
    ...Object.keys(CORP_BOOSTER),
    ...Object.keys(RUNNER_DECK),
    ...Object.keys(RUNNER_BOOSTER),
  ];
}

interface DealtCard {
  id: string;
  slug: string;
}

/**
 * One instance per listed card. The id says which side owns the card and
 * nothing else: an id built from the card's name, or from its place in the
 * list, would tell the other seat what a facedown card is (CR 1.21.1).
 */
export function instancePile(
  side: "corp" | "runner",
  defIds: readonly string[],
  random: () => number,
): DealtCard[] {
  const used = new Set<string>();
  return defIds.map((slug) => {
    let id = "";
    do {
      const part = Math.floor(random() * 36 ** 6)
        .toString(36)
        .padStart(6, "0");
      id = `${side === "corp" ? "c" : "r"}_${part}`;
    } while (used.has(id));
    used.add(id);
    return { id, slug };
  });
}

function dealSetup(
  corpIdentity: string,
  corpCards: readonly string[],
  runnerIdentity: string,
  runnerCards: readonly string[],
  seed: number | undefined,
  logLine: string,
): GameState {
  const state = createInitialState({
    agendaPointsToWin: 6,
    stopAfterFirstCycle: false,
  });
  const cards: Record<string, CardInstance> = {};
  const put = (card: CardInstance) => {
    cards[card.id] = card;
  };

  put(instantiateCard(corpIdentity, "corp-id", "corp:hq"));
  put(instantiateCard(runnerIdentity, "runner-id", "runner:grip"));

  // One seed decides the card ids, the opening shuffle, and every later
  // shuffle and random pick, so the opening and its applied intents replay
  // to the same match. Without a seed the match is still random.
  const random = seed === undefined ? Math.random : mulberry32(seed);
  const corpDealt = instancePile("corp", corpCards, random);
  const runnerDealt = instancePile("runner", runnerCards, random);
  shuffle(corpDealt, random);
  shuffle(runnerDealt, random);
  seedRng(state, Math.floor(random() * 4294967296));

  for (const card of corpDealt) put(instantiateCard(card.slug, card.id, "corp:rd"));
  for (const card of runnerDealt) put(instantiateCard(card.slug, card.id, "runner:stack"));
  const corpPile = corpDealt.map((card) => card.id);
  const runnerPile = runnerDealt.map((card) => card.id);

  const corpHand = corpPile.splice(0, 5);
  const runnerHand = runnerPile.splice(0, 5);
  for (const id of corpHand) cards[id]!.zone = "corp:hq";
  for (const id of runnerHand) cards[id]!.zone = "runner:grip";

  state.cards = cards;
  state.corp.identityId = "corp-id";
  state.corp.deck = corpPile;
  state.corp.hand = corpHand;
  state.corp.discardPile = [];
  state.corp.scoreArea = [];
  state.corp.installed = [];
  state.corp.credits = 5;
  state.corp.clicks = 0;
  state.corp.tags = 0;
  state.runner.identityId = "runner-id";
  state.runner.deck = runnerPile;
  state.runner.hand = runnerHand;
  state.runner.discardPile = [];
  state.runner.scoreArea = [];
  state.runner.installed = [];
  state.runner.credits = 5;
  state.runner.clicks = 0;
  state.runner.tags = 0;
  state.runner.link = cards["runner-id"]?.link ?? 0;
  for (const server of Object.values(state.servers)) {
    server.ice = [];
    server.root = [];
  }
  state.done = false;
  state.winner = null;
  state.winReason = null;
  state.log = [logLine];
  return state;
}

/**
 * Full game using the learn-to-play decks. Shuffled, 5-card opening hands,
 * first player Corp, win at 6 agenda points.
 */
export function learnToPlaySetup(seed?: number, list: LearnToPlayList = "starter"): GameState {
  const corp = learnToPlayDeck("corp", list);
  const runner = learnToPlayDeck("runner", list);
  const logLine =
    list === "expanded"
      ? "Expanded learn-to-play start. The Syndicate vs The Catalyst, with the booster cards. First to 6 agenda points."
      : "Learn-to-play start. The Syndicate vs The Catalyst. First to 6 agenda points.";
  return dealSetup(corp.identityId, corp.cards, runner.identityId, runner.cards, seed, logLine);
}
