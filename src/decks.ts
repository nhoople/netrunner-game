/**
 * Null Signal System Gateway learn-to-play starters
 * (cards before the "STOP HERE" divider).
 *
 * Corp: https://nullsignal.games/players/learn-to-play/learn-to-play-corp/
 * Runner: https://nullsignal.games/players/learn-to-play/learn-to-play-runner/
 */
import {
  createInitialState,
  instantiateCard,
  type CardInstance,
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

function expand(side: "corp" | "runner", list: Record<string, number>): string[] {
  const ids: string[] = [];
  for (const [slug, count] of Object.entries(list)) {
    for (let n = 1; n <= count; n++) ids.push(`${side}:${slug}:${n}`);
  }
  return ids;
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
export function learnToPlaySetup(seed?: number): GameState {
  const state = createInitialState({
    agendaPointsToWin: 6,
    stopAfterFirstCycle: false,
  });
  const cards: Record<string, CardInstance> = {};
  const put = (card: CardInstance) => {
    cards[card.id] = card;
  };

  put(instantiateCard(CORP_IDENTITY, "corp-id", "corp:hq"));
  put(instantiateCard(RUNNER_IDENTITY, "runner-id", "runner:grip"));

  const corpPile = expand("corp", CORP_DECK);
  const runnerPile = expand("runner", RUNNER_DECK);
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
  state.log = [
    "Learn-to-play start. The Syndicate vs The Catalyst. First to 6 agenda points.",
  ];
  return state;
}
