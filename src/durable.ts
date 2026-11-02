/**
 * A match file is the opening deal plus the applied-intent log. A restart
 * deals that opening and replays the log. The snapshot is rebuilt from it.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupForOpening, type MatchOpening } from "./decks.js";
import {
  createMatch,
  forgetMatch,
  type ChatLine,
  type GameLogEntry,
  type Match,
} from "./match.js";

export interface DurableRecord {
  v: 1;
  id: string;
  tokens: Match["tokens"];
  opening: MatchOpening;
  log: GameLogEntry[];
  chat: ChatLine[];
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export function saveDurableMatch(dir: string, match: Match, opening: MatchOpening): void {
  if (!ID_PATTERN.test(match.id)) throw new Error("Match id cannot be stored");
  mkdirSync(dir, { recursive: true });
  const record: DurableRecord = {
    v: 1,
    id: match.id,
    tokens: match.tokens,
    opening,
    log: structuredClone(match.gameLog()) as GameLogEntry[],
    chat: match.chatRecord(),
  };
  const dest = join(dir, `${match.id}.json`);
  const tmp = join(dir, `.${match.id}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, dest);
}

/** Load every readable match file. A file that cannot be replayed is left out. */
export function loadDurableMatches(dir: string): Match[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const loaded: Match[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let record: DurableRecord | undefined;
    try {
      record = parseRecord(readFileSync(join(dir, name), "utf8"));
    } catch (err) {
      console.error(`skipped match file ${name}`, err);
      continue;
    }
    if (!record) {
      console.error(`skipped match file ${name}`);
      continue;
    }
    const opening = record.opening;
    const match = createMatch({
      id: record.id,
      tokens: record.tokens,
      setup: setupForOpening(opening),
      onRecord: (current) => saveDurableMatch(dir, current, opening),
    });
    try {
      match.resume(record.log, record.chat);
    } catch (err) {
      forgetMatch(match.id);
      console.error(`skipped match file ${name}`, err);
      continue;
    }
    loaded.push(match);
  }
  return loaded;
}

function parseRecord(raw: string): DurableRecord | undefined {
  const body = JSON.parse(raw) as unknown;
  if (!isRecord(body) || body.v !== 1) return undefined;
  if (typeof body.id !== "string" || !ID_PATTERN.test(body.id)) return undefined;
  const tokens = body.tokens;
  if (!isRecord(tokens)) return undefined;
  const names = ["corp", "runner", "spectator", "log", "debug"] as const;
  if (names.some((name) => typeof tokens[name] !== "string")) return undefined;
  const opening = parseOpening(body.opening);
  if (!opening) return undefined;
  if (!Array.isArray(body.log) || !Array.isArray(body.chat)) return undefined;
  return {
    v: 1,
    id: body.id,
    tokens: {
      corp: tokens.corp as string,
      runner: tokens.runner as string,
      spectator: tokens.spectator as string,
      log: tokens.log as string,
      debug: tokens.debug as string,
    },
    opening,
    log: body.log as GameLogEntry[],
    chat: body.chat as ChatLine[],
  };
}

function parseOpening(value: unknown): MatchOpening | undefined {
  if (!isRecord(value) || typeof value.seed !== "number") return undefined;
  if (value.preset === "starter" || value.preset === "expanded") {
    return { seed: value.seed, preset: value.preset };
  }
  const corp = deckList(value.corp);
  const runner = deckList(value.runner);
  if (!corp || !runner) return undefined;
  return { seed: value.seed, corp, runner };
}

function deckList(value: unknown): { identityId: string; cards: string[] } | undefined {
  if (!isRecord(value) || typeof value.identityId !== "string" || !Array.isArray(value.cards)) return undefined;
  if (value.cards.some((id) => typeof id !== "string")) return undefined;
  return { identityId: value.identityId, cards: value.cards as string[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
