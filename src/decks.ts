/**
 * Null Signal System Gateway learn-to-play starters
 * (cards before the "STOP HERE" divider).
 *
 * Corp: https://nullsignal.games/players/learn-to-play/learn-to-play-corp/
 * Runner: https://nullsignal.games/players/learn-to-play/learn-to-play-runner/
 */
import {
  createInitialState,
  deckbuildingReport,
  instantiateCard,
  loadCardCatalog,
  type CardInstance,
  type DeckbuildingReport,
  type GameState,
} from "netrunner-engine";

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

function flat(list: Record<string, number>): string[] {
  const ids: string[] = [];
  for (const [slug, count] of Object.entries(list)) {
    for (let n = 0; n < count; n++) ids.push(slug);
  }
  return ids;
}

export function learnToPlayDeck(side: "corp" | "runner"): { identityId: string; cards: string[] } {
  if (side === "corp") return { identityId: CORP_IDENTITY, cards: flat(CORP_DECK) };
  return { identityId: RUNNER_IDENTITY, cards: flat(RUNNER_DECK) };
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
      influence: card.influence,
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

export type MatchSetup =
  | { ok: true; setup: () => GameState }
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
  if (!isRecord(body) || (!("corp" in body) && !("runner" in body))) {
    return { ok: true, setup: () => learnToPlaySetup(seed) };
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
  return {
    ok: true,
    setup: () =>
      dealSetup(
        corp.identityId,
        corp.cards,
        runner.identityId,
        runner.cards,
        seed,
        "Submitted decks. First to 6 agenda points.",
      ),
  };
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

function shuffle(ids: string[], random: () => number = Math.random): void {
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = ids[i]!;
    ids[i] = ids[j]!;
    ids[j] = swap;
  }
}

export function learnToPlayCardIds(): string[] {
  return [
    CORP_IDENTITY,
    RUNNER_IDENTITY,
    ...Object.keys(CORP_DECK),
    ...Object.keys(RUNNER_DECK),
  ];
}

function slugOf(instanceId: string): string {
  const parts = instanceId.split(":");
  return parts[1] ?? instanceId;
}

/**
 * Full game using the learn-to-play decks. Shuffled, 5-card opening hands,
 * first player Corp, win at 6 agenda points.
 */
function instancePile(side: "corp" | "runner", defIds: readonly string[]): string[] {
  const counts = new Map<string, number>();
  return defIds.map((slug) => {
    const n = (counts.get(slug) ?? 0) + 1;
    counts.set(slug, n);
    return `${side}:${slug}:${n}`;
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

  const corpPile = instancePile("corp", corpCards);
  const runnerPile = instancePile("runner", runnerCards);
  // Tests pass a seed so opening hands are deterministic; live matches
  // (server.ts) omit it and keep a true random shuffle.
  const random = seed === undefined ? Math.random : mulberry32(seed);
  shuffle(corpPile, random);
  shuffle(runnerPile, random);

  for (const id of corpPile) put(instantiateCard(slugOf(id), id, "corp:rd"));
  for (const id of runnerPile) put(instantiateCard(slugOf(id), id, "runner:stack"));

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

export function learnToPlaySetup(seed?: number): GameState {
  const corp = learnToPlayDeck("corp");
  const runner = learnToPlayDeck("runner");
  return dealSetup(
    corp.identityId,
    corp.cards,
    runner.identityId,
    runner.cards,
    seed,
    "Learn-to-play start. The Syndicate vs The Catalyst. First to 6 agenda points.",
  );
}
