/**
 * Confirms this repo can see the engine, the pinned card pool, and the pinned rules index.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInitialState, describeState } from "netrunner-engine";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

interface PinFile {
  tag: string;
}

interface CrIndex {
  metadata?: { version?: string };
  numbers: Record<string, string>;
}

interface CardFile {
  title: string;
}

interface PoolFile {
  corpusOrder: string[];
  waves: Record<string, { status?: string; cards?: string[] }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const enginePin = readJson<PinFile>(join(root, "data/engine-pin.json"));
const crPin = readJson<PinFile>(join(root, "vendor/cr-data/PIN.json"));
const cardsPin = readJson<PinFile>(join(root, "vendor/cards-data/PIN.json"));
const index = readJson<CrIndex>(join(root, "vendor/cr-data/index.json"));
const pool = readJson<PoolFile>(join(root, "vendor/cards-data/pool.json"));

const cardCount = Object.values(pool.waves).reduce(
  (sum, wave) => sum + (wave.status === "supported" ? (wave.cards?.length ?? 0) : 0),
  0,
);
const sample = readJson<CardFile>(
  join(root, "vendor/cards-data/system-gateway/marjanah.json"),
);
const state = createInitialState();

console.log(`engine pin ${enginePin.tag}`);
console.log(`rules ${crPin.tag} version ${index.metadata?.version ?? "unknown"}`);
console.log(`rule 1.2.1 → ${index.numbers["1.2.1"]}`);
console.log(`cards ${cardsPin.tag} corpus ${pool.corpusOrder.join(" → ")} (${cardCount} supported)`);
console.log(`sample card ${sample.title}`);
console.log(describeState(state));
