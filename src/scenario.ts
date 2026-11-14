/**
 * Start a match from a position (verification table V3). Debug only: a
 * scenario is never a format-checked deck pair and never gets a product seat.
 *
 * A scenario names the identities, the cards in each zone, installed cards
 * and where they sit, rezzed or not, credits, and whose turn it is. The host
 * builds that state and hands it to `createGame` through its `setup` option.
 * The match stores the scenario as its opening, so a restart deals the same
 * position and replays the log.
 *
 * Cards placed here did not go through an install, rez, or score, so nothing
 * that triggers on those fired. Constant abilities apply as usual.
 */
import { enterStep, getCardDef, instantiateCard, seedRng, createInitialState, type GameState } from "netrunner-engine";
import { instancePile, mulberry32 } from "./decks.js";
import { findMatchByToken } from "./match.js";

export type ScenarioSlot = "ice" | "root";

export interface ScenarioInstall {
  /** Card id from the cards data, such as `ice-wall`. */
  card: string;
  /** Corp only: `hq`, `rd`, `archives`, or `remote-1` and up. */
  server?: string;
  /** Corp only: protecting the server (`ice`) or in its root (`root`). */
  slot?: ScenarioSlot;
  /** Corp only. Rezzed cards are faceup; unrezzed ones are facedown (CR 1.21.1). */
  rezzed?: boolean;
  advancements?: number;
}

export interface ScenarioSide {
  identity: string;
  credits?: number;
  /** Used when the scenario starts at `action`. Otherwise the turn grants clicks. */
  clicks?: number;
  /** Top card first. */
  deck?: string[];
  hand?: string[];
  /** Faceup in Archives or the heap. */
  discard?: string[];
  /** Corp only: facedown in Archives (CR 10.2.2a). */
  discardFacedown?: string[];
  score?: string[];
  /** Ice on one server is listed outermost first, the order the Runner approaches it (CR 6.4.1). */
  installed?: ScenarioInstall[];
  tags?: number;
  badPublicity?: number;
}

export interface Scenario {
  /** Whose turn it is. */
  turn: "corp" | "runner";
  turnNumber?: number;
  /**
   * `turn` (default) enters the start of that turn, so the engine grants
   * clicks, refills recurring credits, and the Corp draws. `action` enters
   * the action phase with the listed clicks.
   */
  start?: "turn" | "action";
  corp: ScenarioSide;
  runner: ScenarioSide;
}

export type ScenarioCheck = { ok: true; scenario: Scenario } | { ok: false; error: string };

const SERVER = /^(hq|rd|archives|remote-[1-9][0-9]?)$/;
const RUNNER_INSTALL = new Set(["program", "hardware", "resource"]);
const CORP_ROOT = new Set(["asset", "agenda", "upgrade"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown, field: string, max = 999): number | undefined | string {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    return `${field} must be a whole number from 0 to ${max}.`;
  }
  return value;
}

function cardList(value: unknown, field: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) return `${field} must be a list of card ids.`;
  return value as string[];
}

type CardType = ReturnType<typeof getCardDef>["type"];

/** The card's type, or why it cannot be used here. */
function cardType(id: string, side: "corp" | "runner", field: string): { type: CardType } | { error: string } {
  let def: ReturnType<typeof getCardDef>;
  try {
    def = getCardDef(id);
  } catch {
    return { error: `${field}: unknown card ${id}.` };
  }
  if (def.side !== side) return { error: `${field}: ${id} is not a ${side} card.` };
  return { type: def.type };
}

function checkSide(value: unknown, side: "corp" | "runner"): ScenarioSide | string {
  if (!isRecord(value)) return `${side} must be an object.`;
  if (typeof value.identity !== "string") return `${side}.identity must be a card id.`;
  const identity = cardType(value.identity, side, `${side}.identity`);
  if ("error" in identity) return identity.error;
  if (identity.type !== "identity") return `${side}.identity: ${value.identity} is not an identity.`;
  const out: ScenarioSide = { identity: value.identity };
  for (const field of ["credits", "clicks", "tags", "badPublicity"] as const) {
    const n = count(value[field], `${side}.${field}`);
    if (typeof n === "string") return n;
    if (n !== undefined) out[field] = n;
  }
  if (side === "runner" && out.badPublicity !== undefined) return "runner.badPublicity is a Corp field.";
  if (side === "corp" && out.tags !== undefined) return "corp.tags is a Runner field.";
  for (const field of ["deck", "hand", "discard", "discardFacedown", "score"] as const) {
    const list = cardList(value[field], `${side}.${field}`);
    if (typeof list === "string") return list;
    if (field === "discardFacedown" && side === "runner" && list.length) return "runner.discardFacedown is a Corp field.";
    for (const id of list) {
      const checked = cardType(id, side, `${side}.${field}`);
      if ("error" in checked) return checked.error;
      const type = checked.type;
      if (type === "identity") return `${side}.${field}: ${id} is an identity.`;
      if (field === "score" && type !== "agenda") return `${side}.score: ${id} is not an agenda.`;
    }
    if (value[field] !== undefined) out[field] = list;
  }
  if (out.score?.length && side === "runner") {
    // The Runner's score area holds stolen Corp agendas, so those ids are Corp cards.
    return "runner.score is not supported yet; steal the agenda in play instead.";
  }
  if (value.installed !== undefined) {
    if (!Array.isArray(value.installed)) return `${side}.installed must be a list.`;
    const installed: ScenarioInstall[] = [];
    for (const [index, raw] of value.installed.entries()) {
      const field = `${side}.installed[${index}]`;
      if (!isRecord(raw) || typeof raw.card !== "string") return `${field} needs a card id.`;
      const checked = cardType(raw.card, side, field);
      if ("error" in checked) return checked.error;
      const type = checked.type;
      const install: ScenarioInstall = { card: raw.card };
      if (side === "runner") {
        if (!RUNNER_INSTALL.has(type)) return `${field}: a ${type} is not installed.`;
        if (raw.server !== undefined || raw.slot !== undefined || raw.rezzed !== undefined || raw.advancements !== undefined) {
          return `${field}: server, slot, rezzed, and advancements are Corp fields.`;
        }
        installed.push(install);
        continue;
      }
      if (typeof raw.server !== "string" || !SERVER.test(raw.server)) {
        return `${field}.server must be hq, rd, archives, or remote-N.`;
      }
      const slot = raw.slot ?? (type === "ice" ? "ice" : "root");
      if (slot !== "ice" && slot !== "root") return `${field}.slot must be ice or root.`;
      if (slot === "ice" && type !== "ice") return `${field}: only ice protects a server.`;
      if (slot === "root" && !CORP_ROOT.has(type)) return `${field}: a ${type} is not installed in a root.`;
      if (slot === "root" && !raw.server.startsWith("remote-") && type !== "upgrade") {
        return `${field}: only an upgrade goes in a central server's root (CR 3.6.1).`;
      }
      if (raw.rezzed !== undefined && typeof raw.rezzed !== "boolean") return `${field}.rezzed must be true or false.`;
      if (raw.rezzed && type === "agenda") return `${field}: an agenda is not rezzed.`;
      const advancements = count(raw.advancements, `${field}.advancements`);
      if (typeof advancements === "string") return advancements;
      install.server = raw.server;
      install.slot = slot;
      if (raw.rezzed) install.rezzed = true;
      if (advancements) install.advancements = advancements;
      installed.push(install);
    }
    const roots = new Map<string, number>();
    for (const install of installed) {
      if (install.slot !== "root" || !install.server?.startsWith("remote-")) continue;
      const type = getCardDef(install.card).type;
      if (type === "upgrade") continue;
      roots.set(install.server, (roots.get(install.server) ?? 0) + 1);
    }
    for (const [server, n] of roots) {
      if (n > 1) return `${side}.installed: ${server} holds more than one agenda or asset (CR 4.6.6e).`;
    }
    out.installed = installed;
  }
  return out;
}

/** Check a scenario body. Card ids must exist at the cards pin and belong to the right side. */
export function checkScenario(body: unknown): ScenarioCheck {
  if (!isRecord(body)) return { ok: false, error: "A scenario must be an object." };
  if (body.turn !== "corp" && body.turn !== "runner") return { ok: false, error: "turn must be corp or runner." };
  const turnNumber = count(body.turnNumber, "turnNumber", 500);
  if (typeof turnNumber === "string") return { ok: false, error: turnNumber };
  if (turnNumber === 0) return { ok: false, error: "turnNumber starts at 1." };
  if (body.start !== undefined && body.start !== "turn" && body.start !== "action") {
    return { ok: false, error: "start must be turn or action." };
  }
  const corp = checkSide(body.corp, "corp");
  if (typeof corp === "string") return { ok: false, error: corp };
  const runner = checkSide(body.runner, "runner");
  if (typeof runner === "string") return { ok: false, error: runner };
  return {
    ok: true,
    scenario: {
      turn: body.turn,
      ...(turnNumber !== undefined ? { turnNumber } : {}),
      ...(body.start ? { start: body.start } : {}),
      corp,
      runner,
    },
  };
}

/**
 * Build the scenario's state. One seed decides the card ids and the random
 * stream, so the same scenario and seed give the same match.
 */
export function scenarioSetup(scenario: Scenario, seed: number): () => GameState {
  return () => {
    const random = mulberry32(seed);
    const state = createInitialState({ agendaPointsToWin: 6, stopAfterFirstCycle: false });
    state.cards = {};
    for (const server of Object.values(state.servers)) {
      server.ice = [];
      server.root = [];
    }
    const remoteNumbers: number[] = [];
    for (const side of ["corp", "runner"] as const) {
      const spec = scenario[side];
      const player = state[side];
      const identityId = `${side}-id`;
      state.cards[identityId] = instantiateCard(spec.identity, identityId, side === "corp" ? "corp:hq" : "runner:grip");
      player.identityId = identityId;

      const listed = [
        ...(spec.deck ?? []),
        ...(spec.hand ?? []),
        ...(spec.discard ?? []),
        ...(spec.discardFacedown ?? []),
        ...(spec.score ?? []),
        ...(spec.installed ?? []).map((install) => install.card),
      ];
      const dealt = instancePile(side, listed, random);
      let next = 0;
      const place = (slugs: readonly string[] | undefined, zone: GameState["cards"][string]["zone"]) =>
        (slugs ?? []).map((slug) => {
          const id = dealt[next++]!.id;
          state.cards[id] = instantiateCard(slug, id, zone);
          return id;
        });

      player.deck = place(spec.deck, side === "corp" ? "corp:rd" : "runner:stack");
      player.hand = place(spec.hand, side === "corp" ? "corp:hq" : "runner:grip");
      const discardZone = side === "corp" ? "corp:archives" : "runner:heap";
      const faceup = place(spec.discard, discardZone);
      for (const id of faceup) state.cards[id]!.faceup = true;
      const facedown = place(spec.discardFacedown, discardZone);
      for (const id of facedown) state.cards[id]!.faceup = false;
      player.discardPile = [...faceup, ...facedown];
      player.scoreArea = place(spec.score, side === "corp" ? "corp:score" : "runner:score");
      for (const id of player.scoreArea) state.cards[id]!.faceup = true;
      player.installed = [];
      player.playArea = [];

      for (const install of spec.installed ?? []) {
        const id = dealt[next++]!.id;
        if (side === "runner") {
          const card = instantiateCard(install.card, id, "runner:installed");
          card.faceup = true;
          state.cards[id] = card;
          player.installed.push(id);
          continue;
        }
        const serverId = install.server! as keyof GameState["servers"];
        if (!state.servers[serverId]) {
          state.servers[serverId] = { id: serverId, kind: "remote", ice: [], root: [] };
        }
        if (serverId.startsWith("remote-")) remoteNumbers.push(Number(serverId.slice("remote-".length)));
        const slot = install.slot ?? "root";
        const card = instantiateCard(install.card, id, `server:${serverId}:${slot}`);
        card.rezzed = install.rezzed === true;
        card.faceup = install.rezzed === true;
        if (install.advancements) card.advancementCounters = install.advancements;
        state.cards[id] = card;
        state.servers[serverId]![slot].push(id);
      }

      player.credits = spec.credits ?? 5;
      player.clicks = 0;
      player.tags = side === "runner" ? (spec.tags ?? 0) : 0;
    }
    state.corp.badPublicity = scenario.corp.badPublicity ?? 0;
    state.runner.link = state.cards["runner-id"]?.link ?? 0;
    state.nextRemoteNumber = Math.max(0, ...remoteNumbers) + 1;
    seedRng(state, Math.floor(random() * 4294967296));

    state.turnNumber = scenario.turnNumber ?? 1;
    state.activeSide = scenario.turn;
    if (scenario.start === "action") {
      const clicks = scenario[scenario.turn].clicks ?? (scenario.turn === "corp" ? 3 : 4);
      state[scenario.turn].clicks = clicks;
      enterStep(state, `${scenario.turn}.takeAction`);
    } else {
      enterStep(state, `${scenario.turn}.gainClicks`);
    }
    state.done = false;
    state.winner = null;
    state.winReason = null;
    state.log = [`Scenario start. ${scenario.turn === "corp" ? "Corp" : "Runner"} turn ${state.turnNumber}.`];
    return state;
  };
}

export type ScenarioRequest =
  | { ok: true; scenario: Scenario; seed: number }
  | { ok: false; status: 400 | 403; error: string };

/**
 * A scenario request from a debug page. It must carry the debug token of a
 * live match: a seat, spectator, or log token is refused, and so is a request
 * with no token. Nothing here checks a deck format.
 */
export function scenarioRequest(body: unknown, seed: number): ScenarioRequest {
  if (!isRecord(body)) return { ok: false, status: 400, error: "Send a debug token and a scenario." };
  const token = typeof body.debugToken === "string" ? body.debugToken : "";
  if (findMatchByToken(token)?.role !== "debug") {
    return { ok: false, status: 403, error: "A scenario starts only from a match's debug page." };
  }
  const checked = checkScenario(body.scenario);
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };
  const chosen = count(body.seed, "seed", 4294967295);
  if (typeof chosen === "string") return { ok: false, status: 400, error: chosen };
  return { ok: true, scenario: checked.scenario, seed: chosen ?? seed };
}
