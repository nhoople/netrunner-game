import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createInitialState } from "netrunner-engine";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

interface PinFile {
  tag: string;
}

interface CrIndex {
  numbers: Record<string, string>;
}

interface PoolFile {
  waves: Record<string, { status?: string; cards?: string[] }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

test("fetched engine and data tags match the declared pins", () => {
  const enginePin = readJson<PinFile>(join(root, "data/engine-pin.json"));
  const cardsPin = readJson<PinFile>(join(root, "data/cards-pin.json"));
  const crPin = readJson<PinFile>(join(root, "data/cr-pin.json"));
  const cardsReceipt = readJson<PinFile>(join(root, "vendor/cards-data/PIN.json"));
  const crReceipt = readJson<PinFile>(join(root, "vendor/cr-data/PIN.json"));
  const engineCards = readJson<PinFile>(join(root, "deps/netrunner-engine/data/cards-pin.json"));
  const engineCr = readJson<PinFile>(join(root, "deps/netrunner-engine/data/cr-pin.json"));

  assert.equal(cardsReceipt.tag, cardsPin.tag);
  assert.equal(crReceipt.tag, crPin.tag);
  assert.equal(engineCards.tag, cardsPin.tag);
  assert.equal(engineCr.tag, crPin.tag);

  const checkedOut = execFileSync(
    "git",
    ["-C", join(root, "deps/netrunner-engine"), "describe", "--tags", "--exact-match", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(checkedOut, enginePin.tag);
});

test("pinned rules index and card pool load", () => {
  const index = readJson<CrIndex>(join(root, "vendor/cr-data/index.json"));
  assert.equal(typeof index.numbers["1.2.1"], "string");
  assert.ok(index.numbers["1.2.1"]!.length > 0);

  const pool = readJson<PoolFile>(join(root, "vendor/cards-data/pool.json"));
  const supported = Object.values(pool.waves).reduce(
    (sum, wave) => sum + (wave.status === "supported" ? (wave.cards?.length ?? 0) : 0),
    0,
  );
  assert.ok(supported > 0);

  const state = createInitialState();
  assert.equal(typeof state, "object");
  assert.ok(state);
});
