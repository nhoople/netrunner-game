#!/usr/bin/env node
/**
 * Download System Gateway card images once.
 * The printing code on each card definition is the file name.
 * Bytes stay out of git; the web host serves public/img/cards.
 *
 * Source template: https://card-images.netrunnerdb.com/v2/large/{code}.jpg
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cardsDir = join(root, "vendor/cards-data/system-gateway");
const outDir = join(root, "public/img/cards");
const imageBase = "https://card-images.netrunnerdb.com/v2/large/";
const overridesPath = join(root, "data/printing-code-overrides.json");

function printingCodes() {
  const byCard = new Map();
  for (const name of readdirSync(cardsDir)) {
    if (!name.endsWith(".json") || name.startsWith("_")) continue;
    const card = JSON.parse(readFileSync(join(cardsDir, name), "utf8"));
    if (typeof card.id === "string" && typeof card.nrdbCode === "string" && card.nrdbCode.length > 0) {
      byCard.set(card.id, card.nrdbCode);
    }
  }
  const overrides = JSON.parse(readFileSync(overridesPath, "utf8"));
  for (const [id, code] of Object.entries(overrides)) {
    if (!byCard.has(id) && typeof code === "string" && code.length > 0) byCard.set(id, code);
  }
  return [...new Set(byCard.values())];
}

async function download(code) {
  const dest = join(outDir, `${code}.jpg`);
  if (existsSync(dest)) return "kept";
  const url = `${imageBase}${code}.jpg`;
  const res = await fetch(url);
  if (res.status === 404) {
    console.warn(`No image for ${code}`);
    return "missing";
  }
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const partial = `${dest}.partial`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
  renameSync(partial, dest);
  return "fetched";
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const codes = printingCodes();
  let fetched = 0;
  let kept = 0;
  let missing = 0;
  const queue = [...codes];
  async function worker() {
    for (;;) {
      const code = queue.shift();
      if (!code) return;
      const result = await download(code);
      if (result === "fetched") fetched += 1;
      else if (result === "kept") kept += 1;
      else missing += 1;
    }
  }
  await Promise.all(Array.from({ length: 6 }, () => worker()));
  console.log(
    `System Gateway images in ${outDir}: ${fetched} fetched, ${kept} already present, ${missing} missing, ${codes.length} codes`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
