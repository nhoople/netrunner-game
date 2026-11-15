/**
 * Visibility fuzz, hand-built scenarios (CR audit tool 1.7). Seeded Learn to
 * play and Startup matches rarely reach facedown Runner installs, facedown
 * set-aside cards, or grip reveals, so each test here builds a position
 * (verification table V3), plays chosen intents through `Match`, and runs the
 * fuzz oracle (`VisibilityWatch`) over the Corp, Runner and spectator
 * snapshots after every intent. See `visibility-fuzz.ts` for the oracle.
 *
 * What each seat may see (CR v26.03):
 * - Facedown cards in play or set aside are hidden information
 *   (CR 1.21.1, CR 10.2.2a). Their controller may look at them
 *   (CR 1.21.2a), the other player and the spectator may not.
 * - Cards set aside facedown stay facedown (CR 4.8.6, CR 4.8.7).
 * - The grip is hidden from the Corp (CR 10.2.2a) until a card reveals it.
 *   A revealed card is shown to all players (CR 1.21.3) until the ability
 *   finishes or the card moves (CR 1.21.6). The spectator sees open
 *   information only (CR 10.2.3a).
 *
 * Leaks found here live in `scenarios` in
 * `test/baselines/visibility-leaks.json`. That list only shrinks: a leak it
 * does not list fails, and so does a listed leak a scenario no longer finds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GameState } from "netrunner-engine";
import { createMatch, forgetMatch } from "./match.js";
import { checkScenario, scenarioSetup } from "./scenario.js";
import {
  playMatch,
  readBaseline,
  scenarioLeakKey,
  VisibilityWatch,
  type HiddenClass,
  type LeakExample,
  type Viewer,
} from "./visibility-fuzz.js";

function scenario(body: unknown) {
  const checked = checkScenario(body);
  if (!checked.ok) throw new Error(checked.error);
  return checked.scenario;
}

const CORP_DECK = ["hedge-fund", "hedge-fund", "hedge-fund", "hedge-fund", "hedge-fund"];
const RUNNER_DECK = ["sure-gamble", "sure-gamble", "sure-gamble", "sure-gamble", "sure-gamble"];
const SYNDICATE = "the-syndicate-profit-over-principle";
const CATALYST = "the-catalyst-convention-breaker";

function watch(setup: () => GameState, seed: number): VisibilityWatch {
  return new VisibilityWatch(createMatch({ setup, scenario: true }), "startup", seed);
}

/** Submit the legal intent whose label matches, from whichever seat lists it. */
async function pick(w: VisibilityWatch, pattern: RegExp): Promise<void> {
  for (const seat of ["corp", "runner"] as const) {
    const entry = w.snaps[seat].legal.find((item) => pattern.test(item.label));
    if (!entry) continue;
    assert.equal(await w.submit(seat, entry.intent), true, `rejected: ${entry.label}`);
    return;
  }
  const listed = (["corp", "runner"] as const).map((seat) => `${seat}: ${w.snaps[seat].legal.map((e) => e.label).join(" | ")}`);
  assert.fail(`no legal intent matches ${pattern}\n${listed.join("\n")}`);
}

function card(w: VisibilityWatch, title: string) {
  const found = Object.values(w.state.cards).filter((c) => c.title === title);
  assert.equal(found.length, 1, `one ${title}`);
  return found[0]!;
}

function titlesIn(w: VisibilityWatch, ids: readonly string[]): string[] {
  return ids.map((id) => w.state.cards[id]?.title ?? "");
}

/** Leaks the direct title checks found, by match. */
const direct = new WeakMap<VisibilityWatch, LeakExample[]>();

/** Snapshot paths (normalized as the oracle does) whose string mentions `title`. */
function titlePaths(state: GameState, value: unknown, title: string, path = ""): Array<{ path: string; value: string }> {
  if (typeof value === "string") return value.includes(title) ? [{ path, value }] : [];
  if (Array.isArray(value)) return value.flatMap((item) => titlePaths(state, item, title, `${path}[]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const part = state.cards[key] || key.startsWith("ref_") ? "{id}" : /^remote-\d+$/.test(key) ? "remote-N" : key;
    return titlePaths(state, item, title, path ? `${path}.${part}` : part);
  });
}

/**
 * A direct check beside the oracle: the title appears nowhere in these
 * viewers' snapshots. The oracle trusts the engine's zones; this check
 * follows the card text, so it also catches a card the engine put in the
 * wrong zone. A hit is recorded as a leak and settled against the baseline.
 */
function absentFrom(w: VisibilityWatch, title: string, viewers: readonly Viewer[], cls: HiddenClass): void {
  const found = direct.get(w) ?? [];
  direct.set(w, found);
  for (const viewer of viewers) {
    for (const hit of titlePaths(w.state, w.snaps[viewer], title)) {
      found.push({ viewer, kind: "title", cls, path: hit.path, format: w.format, seed: w.seed, step: w.steps - 1, card: title, value: hit.value.slice(0, 160) });
    }
  }
}

/** Compare a scenario's leaks with its baseline entries. */
function settle(name: string, leaks: readonly LeakExample[]): void {
  const recorded = new Set((readBaseline().scenarios ?? []).filter((e) => e.scenario === name).map((e) => scenarioLeakKey(name, e)));
  const found = new Map(leaks.map((leak) => [scenarioLeakKey(name, leak), leak]));
  const added = [...found.keys()]
    .filter((key) => !recorded.has(key))
    .map((key) => `${key} (step ${found.get(key)!.step} ${found.get(key)!.card}: ${JSON.stringify(found.get(key)!.value)})`);
  const gone = [...recorded].filter((key) => !found.has(key));
  assert.deepEqual(added, [], "new visibility leaks");
  assert.deepEqual(gone, [], "fixed leaks still in test/baselines/visibility-leaks.json scenarios: remove them");
}

async function finish(name: string, w: VisibilityWatch): Promise<void> {
  forgetMatch(w.match.id);
  settle(name, [...w.leaks, ...(direct.get(w) ?? [])]);
}

// ------------------------------------------------- facedown Runner installs

test("Apex installs a grip card facedown: hidden from the Corp and the spectator (CR 1.21.1, CR 1.21.2a)", async () => {
  const name = "apex-facedown-install";
  const w = watch(
    scenarioSetup(
      scenario({
        turn: "runner",
        start: "turn",
        turnNumber: 2,
        corp: { identity: SYNDICATE, hand: ["hedge-fund"], deck: CORP_DECK },
        runner: {
          identity: "apex-invasive-predator",
          credits: 5,
          hand: ["sure-gamble", "jailbreak", "cleaver"],
          deck: RUNNER_DECK,
        },
      }),
      31,
    ),
    31,
  );
  // The Runner's own choice names the card: the Runner may see it (CR 1.21.2a).
  await pick(w, /Apex.*Install 1 card from grip facedown/);
  await pick(w, /Install Jailbreak facedown/);
  const jailbreak = card(w, "Jailbreak");
  assert.equal(jailbreak.zone, "runner:installed");
  assert.equal(jailbreak.faceup, false);
  absentFrom(w, "Jailbreak", ["corp", "spectator"], "facedown_installed"); // CR 1.21.1, CR 10.2.2a
  assert.ok(JSON.stringify(w.snaps.runner).includes("Jailbreak"), "the Runner may look at it (CR 1.21.2a)");
  // The turn-begin ability resolves once; the turn goes on to the action phase (CR 9.6.6).
  assert.ok(!w.snaps.runner.legal.some((e) => /Apex/.test(e.label)), "Apex is not offered again");
  assert.notEqual(w.state.timingKey, "runner.turnBegins");
  await finish(name, w);
});

test("facedown installed Runner cards stay hidden through a played-out match (CR 1.21.1, CR 10.2.2a)", async () => {
  const name = "facedown-runner-installs-played";
  const base = scenarioSetup(
    scenario({
      turn: "runner",
      start: "action",
      turnNumber: 2,
      corp: {
        identity: SYNDICATE,
        credits: 8,
        hand: ["hedge-fund", "ice-wall", "offworld-office"],
        deck: [...CORP_DECK, "ice-wall", "tithe", "palisade", ...CORP_DECK],
        installed: [{ card: "ice-wall", server: "hq", rezzed: true }],
      },
      runner: {
        identity: CATALYST,
        clicks: 4,
        credits: 6,
        hand: ["sure-gamble", "jailbreak"],
        deck: [...RUNNER_DECK, "jailbreak", ...RUNNER_DECK],
        installed: [{ card: "cleaver" }, { card: "docklands-pass" }],
      },
    }),
    37,
  );
  // As if Apex or Reboot installed them facedown: the scenario places
  // Runner cards faceup, so turn these two over.
  const setup = () => {
    const state = base();
    for (const id of state.runner.installed) state.cards[id]!.faceup = false;
    return state;
  };
  // Seat driver only: `scenario.test.ts` already runs a scenario through the debug driver.
  const result = await playMatch("startup", 37, 60, "seat", setup);
  assert.notEqual(result.ended, "crash", result.detail ?? "");
  assert.ok(result.steps > 10, `${result.steps} steps`);
  settle(name, result.leaks);
});

test("Read-Write Share hosts a grip card facedown, then shuffles it into the stack (Startup; CR 1.21.1, CR 1.21.2a)", async () => {
  const name = "read-write-share-facedown-host";
  const w = watch(
    scenarioSetup(
      scenario({
        turn: "runner",
        start: "action",
        turnNumber: 2,
        corp: { identity: SYNDICATE, hand: ["hedge-fund"], deck: CORP_DECK },
        runner: {
          identity: CATALYST,
          clicks: 4,
          credits: 5,
          hand: ["read-write-share", "jailbreak", "cleaver"],
          deck: RUNNER_DECK,
        },
      }),
      41,
    ),
    41,
  );
  await pick(w, /Install Read-Write Share/);
  await pick(w, /Read-Write Share: Host Jailbreak facedown/);
  const jailbreak = card(w, "Jailbreak");
  assert.equal(jailbreak.faceup, false);
  assert.match(String(jailbreak.zone), /^hosted:/);
  absentFrom(w, "Jailbreak", ["corp", "spectator"], "facedown_installed"); // CR 1.21.1, CR 10.2.2a
  await pick(w, /Read-Write Share: \[trash\]/);
  // [trash] sets the hosted card aside as the cost is paid, then shuffles it
  // into the stack (CR 9.5.5, card text).
  assert.equal(card(w, "Jailbreak").zone, "runner:stack");
  absentFrom(w, "Jailbreak", ["corp", "spectator"], "deck"); // CR 4.1.5, CR 10.2.2a
  await finish(name, w);
});

test("Bookmark hosts grip cards facedown and returns them (CR 1.21.1, CR 1.21.2a)", async () => {
  const name = "bookmark-facedown-host";
  const w = watch(
    scenarioSetup(
      scenario({
        turn: "runner",
        start: "action",
        turnNumber: 2,
        corp: { identity: SYNDICATE, hand: ["hedge-fund"], deck: CORP_DECK },
        runner: {
          identity: CATALYST,
          clicks: 4,
          credits: 5,
          hand: ["sure-gamble", "jailbreak", "cleaver"],
          deck: RUNNER_DECK,
          installed: [{ card: "bookmark" }],
        },
      }),
      43,
    ),
    43,
  );
  await pick(w, /Bookmark: \[click\]: Host up to 3/);
  await pick(w, /Host Jailbreak facedown/);
  await pick(w, /Host Cleaver facedown/);
  await pick(w, /Done hosting/);
  for (const title of ["Jailbreak", "Cleaver"]) {
    assert.equal(card(w, title).faceup, false);
    absentFrom(w, title, ["corp", "spectator"], "facedown_installed"); // CR 1.21.1, CR 10.2.2a
  }
  await pick(w, /^Pass/);
  await pick(w, /Bookmark: \[click\]: Add all hosted/);
  for (const title of ["Jailbreak", "Cleaver"]) {
    assert.equal(card(w, title).zone, "runner:grip");
    absentFrom(w, title, ["corp", "spectator"], "hand"); // CR 10.2.2a
  }
  await finish(name, w);
});

// ------------------------------------------------- facedown set-aside cards

test("Ayla's facedown set-aside cards stay hidden, also when one moves to the grip (CR 4.8.6, CR 4.8.7)", async () => {
  const name = "ayla-facedown-set-aside";
  const base = scenarioSetup(
    scenario({
      turn: "runner",
      start: "action",
      turnNumber: 2,
      corp: { identity: SYNDICATE, hand: ["hedge-fund"], deck: CORP_DECK },
      runner: {
        identity: "ayla-bios-rahim-simulant-specialist",
        clicks: 4,
        credits: 5,
        hand: ["sure-gamble"],
        deck: ["jailbreak", "cleaver", "creative-commission", "vrcation", ...RUNNER_DECK],
      },
    }),
    47,
  );
  // Ayla sets aside before the starting hand (startIdentitySetup); a
  // scenario skips the opening, so set the top four aside facedown here.
  const setup = () => {
    const state = base();
    const aside = state.runner.deck.splice(0, 4);
    state.runner.setAside = aside;
    for (const id of aside) {
      state.cards[id]!.zone = "runner:set-aside";
      state.cards[id]!.faceup = false;
    }
    return state;
  };
  const w = watch(setup, 47);
  const titles = ["Jailbreak", "Cleaver", "Creative Commission", "VRcation"];
  for (const title of titles) absentFrom(w, title, ["corp", "spectator"], "facedown_set_aside"); // CR 4.8.6
  assert.ok(JSON.stringify(w.snaps.runner).includes("Cleaver"), "Ayla's Runner may look at them (CR 1.21.2)");
  await pick(w, /Ayla.*Add 1 card from set-aside to grip/);
  await pick(w, /Ayla.*Add Cleaver to grip/);
  assert.equal(card(w, "Cleaver").zone, "runner:grip");
  for (const title of titles) absentFrom(w, title, ["corp", "spectator"], "facedown_set_aside"); // CR 4.8.6, CR 10.2.2a
  await finish(name, w);
});

// ------------------------------------------------- grip reveals

test("Touch-ups reveals the grip to both players at that step only (Startup; CR 1.21.3, CR 1.21.6)", async () => {
  const name = "touch-ups-grip-reveal";
  const w = watch(
    scenarioSetup(
      scenario({
        turn: "corp",
        start: "action",
        turnNumber: 3,
        corp: {
          identity: SYNDICATE,
          clicks: 3,
          credits: 12,
          hand: ["touch-ups", "hedge-fund"],
          deck: CORP_DECK,
          installed: [{ card: "offworld-office", server: "remote-1" }],
        },
        runner: { identity: CATALYST, credits: 0, hand: ["sure-gamble", "jailbreak", "cleaver"], deck: RUNNER_DECK },
      }),
      53,
    ),
    53,
  );
  await pick(w, /Play Touch-ups/);
  await pick(w, /Touch-ups: Choose event/);
  assert.ok(
    (w.state.reveals ?? []).some((event) => event.cards.some((c) => c.title === "Cleaver")),
    "the whole grip is revealed (CR 1.21.3)",
  );
  // The Corp chooses up to 2 revealed cards of that type (card text; CR 1.15.2).
  assert.ok(w.snaps.corp.legal.some((e) => /Touch-ups: Sure Gamble/.test(e.label)), "the Corp picks");
  assert.ok(!w.snaps.runner.legal.some((e) => /Touch-ups: Sure Gamble/.test(e.label)), "the Runner does not pick");
  await pick(w, /Touch-ups: Sure Gamble/);
  await pick(w, /Touch-ups: Done/);
  assert.ok(!titlesIn(w, w.state.runner.hand).includes("Sure Gamble"), "Sure Gamble left the grip");
  // After the ability, the grip is hidden again (CR 1.21.6); the oracle checks
  // every new string from here on.
  await pick(w, /Gain 1 credit/);
  await finish(name, w);
});

test("Invasion of Privacy reveals the grip (CR 1.21.3, CR 1.21.6)", async () => {
  const name = "invasion-of-privacy-grip-reveal";
  const w = watch(
    scenarioSetup(
      scenario({
        turn: "corp",
        start: "action",
        turnNumber: 3,
        corp: { identity: SYNDICATE, clicks: 3, credits: 12, hand: ["invasion-of-privacy", "hedge-fund"], deck: CORP_DECK },
        runner: { identity: CATALYST, credits: 0, hand: ["sure-gamble", "jailbreak", "cleaver"], deck: RUNNER_DECK },
      }),
      59,
    ),
    59,
  );
  await pick(w, /Play Invasion of Privacy/);
  // The Corp may trash a revealed event: its option is usable (CR 1.21.3).
  await pick(w, /Invasion of Privacy: Trash Sure Gamble/);
  assert.ok(titlesIn(w, w.state.runner.discardPile).includes("Sure Gamble"), "Sure Gamble is in the heap");
  if (w.snaps.corp.legal.some((e) => /Invasion of Privacy: Done/.test(e.label))) {
    await pick(w, /Invasion of Privacy: Done/);
  }
  await pick(w, /Gain 1 credit/);
  absentFrom(w, "Cleaver", ["corp", "spectator"], "hand"); // the reveal ended with the ability (CR 1.21.6)
  await finish(name, w);
});

test("Harishchandra Ent. plays the grip revealed only while the Runner is tagged (CR 1.21.3, CR 10.2.2a)", async () => {
  const name = "harishchandra-tagged-grip";
  const w = watch(
    scenarioSetup(
      scenario({
        turn: "runner",
        start: "action",
        turnNumber: 2,
        corp: { identity: "harishchandra-ent-where-youre-the-star", hand: ["hedge-fund"], deck: CORP_DECK },
        runner: {
          identity: CATALYST,
          clicks: 4,
          credits: 5,
          tags: 1,
          hand: ["sure-gamble", "jailbreak", "cleaver"],
          deck: RUNNER_DECK,
        },
      }),
      61,
    ),
    61,
  );
  // While tagged, the Corp may see the grip (CR 1.21.3), a card drawn into it
  // included. The spectator sees it too: both players can (CR 10.2.3a).
  await pick(w, /Draw 1 card/);
  await pick(w, /Play Sure Gamble/);
  await pick(w, /Gain 1 credit/);
  await finish(name, w);
});

test.todo(
  "Harishchandra Ent.: the Corp's snapshot shows the revealed grip while the Runner is tagged (CR 1.21.3). " +
    "The engine's view lists it in `opponent.revealedHand`, but the game strips the ids to null.",
);

test("Harishchandra Ent.: after the Runner removes the tag, the grip is hidden again (CR 5.2.7g, CR 10.2.2a)", async () => {
  const name = "harishchandra-remove-tag";
  const w = watch(
    scenarioSetup(
      scenario({
        turn: "runner",
        start: "action",
        turnNumber: 2,
        corp: { identity: "harishchandra-ent-where-youre-the-star", hand: ["hedge-fund"], deck: CORP_DECK },
        runner: {
          identity: CATALYST,
          clicks: 4,
          credits: 5,
          tags: 1,
          hand: ["sure-gamble", "jailbreak", "cleaver"],
          deck: RUNNER_DECK,
        },
      }),
      67,
    ),
    67,
  );
  // Removing a tag is a Runner basic action (CR 5.2.7g).
  await pick(w, /Remove 1 tag/);
  assert.equal(w.state.runner.tags, 0);
  // Untagged, the grip is hidden from the Corp again (CR 10.2.2a); the oracle
  // checks every snapshot from here on, a newly drawn card included.
  await pick(w, /Draw 1 card/);
  absentFrom(w, "Cleaver", ["corp", "spectator"], "hand");
  await finish(name, w);
});
