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

function shuffle(ids: string[]): void {
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = ids[i]!;
    ids[i] = ids[j]!;
    ids[j] = swap;
  }
}

function slugOf(instanceId: string): string {
  const parts = instanceId.split(":");
  return parts[1] ?? instanceId;
}

/**
 * Full game using the learn-to-play decks. Shuffled, 5-card opening hands,
 * first player Corp, win at 6 agenda points.
 */
export function learnToPlaySetup(): GameState {
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
  shuffle(corpPile);
  shuffle(runnerPile);

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
  state.corp.discard = [];
  state.corp.score = [];
  state.corp.rig = [];
  state.corp.credits = 5;
  state.corp.clicks = 0;
  state.corp.tags = 0;
  state.runner.identityId = "runner-id";
  state.runner.deck = runnerPile;
  state.runner.hand = runnerHand;
  state.runner.discard = [];
  state.runner.score = [];
  state.runner.rig = [];
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
