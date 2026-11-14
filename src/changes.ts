import type { GameState } from "netrunner-engine";

type Side = GameState["activeSide"];

/**
 * What changed in the internal board with one applied intent, and the engine
 * state behind the board: pending abilities (CR 9.6.2), lingering effects
 * (CR 9.10.1), and the run (CR 6). Verification table V6. Debug view only:
 * every field here can name a facedown card.
 */

export type Fact = string | number | boolean | null;
export type Facts = Record<string, Fact>;

export interface PendingWire {
  id: string;
  abilityKey: string;
  sourceId: string;
  source?: string;
  controller: Side;
  mandatory: boolean;
  status: string;
  windowId: string | null;
  /** The payload's kind, when the instance carries one. */
  payload?: string;
}

export interface LingeringWire {
  id: string;
  kind: string;
  createdBy: string;
  source?: string;
  /** The duration, e.g. "turn (runner)" or "run". */
  duration: string;
  expired: boolean;
}

/** The pending abilities, lingering effects, and run, as the debug page shows them. */
export interface EngineStateWire {
  pending: PendingWire[];
  lingering: LingeringWire[];
  /** The run's fields, flattened (`encounter.iceId`), or null when no run is in progress. */
  run: Facts | null;
}

/** A summary of a state to diff against the next one. Taken before each intent. */
export interface BoardFacts {
  cards: Record<string, { title?: string; where: string; fields: Facts }>;
  players: Record<Side, Facts>;
  game: Facts;
  pending: Record<string, PendingWire>;
  lingering: Record<string, LingeringWire>;
  run: Facts | null;
}

export interface FieldChange {
  field: string;
  before: Fact;
  after: Fact;
}

export interface BoardChanges {
  /** Cards that changed zone or place in a server. `(new)` and `(gone)` mark a card that appeared or left. */
  moved: Array<{ id: string; title?: string; from: string; to: string }>;
  /** Counters, rezzed, faceup, host, and any other card field that changed. */
  cards: Array<FieldChange & { id: string; title?: string }>;
  /** Credits, clicks, tags, and the rest of each player's numbers. */
  players: Array<FieldChange & { side: Side }>;
  /** Turn, timing step, open windows, and the game's other flags. */
  game: FieldChange[];
  run: FieldChange[];
  /**
   * `before` is the status before the intent, or null when the instance is new.
   * An instance can appear and settle within one intent: change "resolved" or
   * "cancelled" with `before` null.
   */
  pending: Array<{ change: "new" | "resolved" | "cancelled" | "status"; ability: PendingWire; before: string | null }>;
  lingering: Array<{ change: "new" | "ended" | "expired"; effect: LingeringWire }>;
}

type Card = GameState["cards"][string];
type Pending = GameState["pendingAbilities"][number];
type Lingering = GameState["lingeringEffects"][number];

function isFact(value: unknown): value is Fact {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * One fact per field. Primitives as they are, arrays of primitives joined,
 * other arrays by length, and nested objects flattened `depth` more levels
 * (past that, an object reads as its `kind` or `type`, or "set").
 */
function flatten(source: object, skip: ReadonlySet<string>, depth: number, prefix = "", out: Facts = {}): Facts {
  for (const [key, value] of Object.entries(source)) {
    if (skip.has(key) || value === undefined || typeof value === "function") continue;
    const name = `${prefix}${key}`;
    if (isFact(value)) out[name] = value;
    else if (Array.isArray(value)) {
      out[name] = value.every(isFact) ? value.join(", ") : value.length;
    } else if (typeof value === "object" && depth > 0) {
      flatten(value as object, new Set(), depth - 1, `${name}.`, out);
    } else if (typeof value === "object") {
      const tag = (value as { kind?: unknown; type?: unknown }).kind ?? (value as { type?: unknown }).type;
      out[name] = typeof tag === "string" ? tag : "set";
    }
  }
  return out;
}

/** The id never changes and the zone is diffed as `where`. Effect IR fields read as "set" and stay put. */
const CARD_SKIP = new Set(["id", "zone"]);

/** Zones are diffed through each card's `zone`, so the id lists are left out here. */
const PLAYER_SKIP = new Set([
  "deck",
  "hand",
  "discardPile",
  "scoreArea",
  "installed",
  "playArea",
  "setAside",
  "corpSetAside",
  "additionalIdentities",
]);

/** Shown elsewhere (cards, players, the run, the panel) or bookkeeping that moves every step. */
const GAME_SKIP = new Set([
  "cards",
  "servers",
  "corp",
  "runner",
  "run",
  "pendingAbilities",
  "lingeringEffects",
  "log",
  "config",
  "checkpoints",
  "previousCheckpointSnapshot",
  "timing",
  "reveals",
  "looks",
  "revealSeq",
  "lookSeq",
  "rngState",
  "idSeq",
  "setAsideGroupSeq",
  "activeOrder",
  "removedFromGame",
]);

/** Where a card is: its zone, and its place in the ice when it is ice (index 0 is outermost). */
function whereIs(state: GameState): Map<string, string> {
  const where = new Map<string, string>();
  for (const server of Object.values(state.servers)) {
    server.ice.forEach((id, index) => where.set(id, `server:${server.id}:ice #${index}`));
  }
  for (const [id, card] of Object.entries(state.cards)) {
    if (!where.has(id)) where.set(id, card.zone);
  }
  return where;
}

function title(state: GameState, id: string): string | undefined {
  return state.cards[id]?.title;
}

function pendingWire(state: GameState, ability: Pending): PendingWire {
  const source = title(state, ability.sourceId);
  return {
    id: ability.id,
    abilityKey: ability.abilityKey,
    sourceId: ability.sourceId,
    ...(source ? { source } : {}),
    controller: ability.controller,
    mandatory: ability.mandatory,
    status: ability.status,
    windowId: ability.windowId,
    ...(ability.payload ? { payload: ability.payload.kind } : {}),
  };
}

function lingeringWire(state: GameState, effect: Lingering): LingeringWire {
  const source = title(state, effect.createdBy);
  const { kind, ...rest } = effect.duration as { kind: string } & Record<string, unknown>;
  const extra = Object.values(rest).filter(isFact);
  return {
    id: effect.id,
    kind: effect.kind,
    createdBy: effect.createdBy,
    ...(source ? { source } : {}),
    duration: extra.length ? `${kind} (${extra.join(", ")})` : kind,
    expired: effect.expired === true,
  };
}

/** The run's fields, with each card id read as "Title (id)". */
function runFacts(state: GameState): Facts | null {
  if (!state.run) return null;
  const facts = flatten(state.run, new Set(), 1);
  for (const [field, value] of Object.entries(facts)) {
    if (typeof value !== "string" || !value) continue;
    facts[field] = value
      .split(", ")
      .map((id) => (state.cards[id] ? `${state.cards[id]!.title} (${id})` : id))
      .join(", ");
  }
  return facts;
}

/** A field a new run starts with and that says nothing yet. */
function isBlank(value: Fact): boolean {
  return value === null || value === false || value === "" || value === 0;
}

/** Pending abilities, lingering effects, and the run, for the debug page's engine-state panel. */
export function engineState(state: GameState): EngineStateWire {
  return {
    pending: state.pendingAbilities.map((ability) => pendingWire(state, ability)),
    lingering: state.lingeringEffects.map((effect) => lingeringWire(state, effect)),
    run: runFacts(state),
  };
}

export function boardFacts(state: GameState): BoardFacts {
  const where = whereIs(state);
  const cards: BoardFacts["cards"] = {};
  for (const [id, card] of Object.entries(state.cards) as Array<[string, Card]>) {
    cards[id] = { title: card.title, where: where.get(id) ?? card.zone, fields: flatten(card, CARD_SKIP, 0) };
  }
  const byId = <T extends { id: string }>(items: T[]) => Object.fromEntries(items.map((item) => [item.id, item]));
  const panel = engineState(state);
  return {
    cards,
    players: {
      corp: flatten(state.corp, PLAYER_SKIP, 0),
      runner: flatten(state.runner, PLAYER_SKIP, 0),
    },
    game: flatten(state, GAME_SKIP, 1),
    pending: byId(panel.pending),
    lingering: byId(panel.lingering),
    run: panel.run,
  };
}

function diffFacts(before: Facts, after: Facts): FieldChange[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: FieldChange[] = [];
  for (const field of fields) {
    const was = before[field] ?? null;
    const now = after[field] ?? null;
    if (was !== now) out.push({ field, before: was, after: now });
  }
  return out;
}

const SETTLED = new Set(["done", "cancelled"]);

/** What changed between two summaries of the board. */
export function boardChanges(before: BoardFacts, after: BoardFacts): BoardChanges {
  const changes: BoardChanges = { moved: [], cards: [], players: [], game: [], run: [], pending: [], lingering: [] };
  for (const id of new Set([...Object.keys(before.cards), ...Object.keys(after.cards)])) {
    const was = before.cards[id];
    const now = after.cards[id];
    const name = now?.title ?? was?.title;
    const titled = name ? { title: name } : {};
    if (was?.where !== now?.where) {
      changes.moved.push({ id, ...titled, from: was?.where ?? "(new)", to: now?.where ?? "(gone)" });
    }
    if (was && now) {
      for (const change of diffFacts(was.fields, now.fields)) changes.cards.push({ id, ...titled, ...change });
    }
  }
  for (const side of ["corp", "runner"] as const) {
    for (const change of diffFacts(before.players[side], after.players[side])) changes.players.push({ side, ...change });
  }
  changes.game = diffFacts(before.game, after.game);
  if ((before.run === null) !== (after.run === null)) {
    changes.run.push({ field: "run", before: before.run ? "in progress" : "none", after: after.run ? "in progress" : "none" });
  }
  // A run that began lists only the fields it set; a run that ended lists none.
  if (after.run) {
    const fields = diffFacts(before.run ?? {}, after.run);
    changes.run.push(...(before.run ? fields : fields.filter((change) => !isBlank(change.after))));
  }
  for (const [id, now] of Object.entries(after.pending)) {
    const was = before.pending[id] ?? null;
    if (was?.status === now.status) continue;
    const change = now.status === "done" ? "resolved" : now.status === "cancelled" ? "cancelled" : was ? "status" : "new";
    changes.pending.push({ change, ability: now, before: was?.status ?? null });
  }
  for (const [id, was] of Object.entries(before.pending)) {
    // Gone from the list: the instance resolved (CR 9.6.2), unless it had already settled.
    if (!after.pending[id] && !SETTLED.has(was.status)) {
      changes.pending.push({ change: "resolved", ability: was, before: was.status });
    }
  }
  for (const [id, now] of Object.entries(after.lingering)) {
    const was = before.lingering[id];
    if (!was) changes.lingering.push({ change: "new", effect: now });
    else if (!was.expired && now.expired) changes.lingering.push({ change: "expired", effect: now });
  }
  for (const [id, was] of Object.entries(before.lingering)) {
    if (!after.lingering[id]) changes.lingering.push({ change: "ended", effect: was });
  }
  return changes;
}
