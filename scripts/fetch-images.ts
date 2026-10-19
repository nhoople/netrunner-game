/**
 * Download learn-to-play card images once.
 * The printing code is the file name. Bytes stay out of git.
 *
 * Source template: https://card-images.netrunnerdb.com/v2/large/{code}.jpg
 */
import { createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { learnToPlayCardIds } from "../src/decks.ts";
import { printingCodeFor } from "../src/printing-codes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public/img/cards");
const imageBase = "https://card-images.netrunnerdb.com/v2/large/";

function printingCodes(): string[] {
  const codes = new Set<string>();
  for (const id of learnToPlayCardIds()) {
    const code = printingCodeFor(id);
    if (!code) throw new Error(`No printing for learn-to-play card ${id}`);
    codes.add(code);
  }
  return [...codes];
}

async function download(code: string): Promise<"kept" | "fetched" | "missing"> {
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

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const codes = printingCodes();
  let fetched = 0;
  let kept = 0;
  let missing = 0;
  const queue = [...codes];
  async function worker(): Promise<void> {
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
    `Learn-to-play images in ${outDir}: ${fetched} fetched, ${kept} already present, ${missing} missing, ${codes.length} codes`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
