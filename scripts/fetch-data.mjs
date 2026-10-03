#!/usr/bin/env node
/**
 * Vendor Comprehensive Rules JSON and card definitions at the tags in data/*-pin.json.
 * Cards use the tagged GitHub archive, matching netrunner-engine's fetch.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPin(name) {
  return JSON.parse(readFileSync(join(root, "data", name), "utf8"));
}

function writePinReceipt(outDir, pin, extra) {
  writeFileSync(
    join(outDir, "PIN.json"),
    JSON.stringify(
      {
        tag: pin.tag,
        repo: pin.repo,
        fetchedAt: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    ) + "\n",
  );
}

async function fetchFile(pin, relPath, outDir) {
  const url = `${pin.rawBase}/${relPath}`;
  const dest = join(outDir, relPath.replace(/^data\//, ""));
  mkdirSync(dirname(dest), { recursive: true });
  process.stdout.write(`Fetching ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function fetchCr() {
  const pin = readPin("cr-pin.json");
  const outDir = join(root, "vendor/cr-data");
  mkdirSync(outDir, { recursive: true });
  for (const file of pin.files) {
    await fetchFile(pin, file, outDir);
  }
  writePinReceipt(outDir, pin, { rawBase: pin.rawBase, files: pin.files });
  console.log(`Pinned ${pin.tag} → ${outDir} (${pin.files.length} files)`);
}

function copyDataTree(srcDataDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(srcDataDir)) {
    const from = join(srcDataDir, name);
    const to = join(outDir, name);
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  }
}

async function fetchCards() {
  const pin = readPin("cards-pin.json");
  const outDir = join(root, "vendor/cards-data");
  const url = pin.archiveUrl;
  process.stdout.write(`Fetching archive ${url}\n`);
  const res = await fetch(url, {
    headers: { "User-Agent": "netrunner-game-fetch-cards" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "cards-data-"));
  const tgz = join(tmp, "cards.tgz");
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tgz));
    execFileSync("tar", ["-xzf", tgz, "-C", tmp], { stdio: "inherit" });
    const entries = readdirSync(tmp).filter((name) => name !== "cards.tgz");
    if (entries.length !== 1) {
      throw new Error(`Expected one top-level dir in archive, got: ${entries.join(", ")}`);
    }
    const dataDir = join(tmp, entries[0], pin.dataPrefix ?? "data");
    if (!existsSync(join(dataDir, "pool.json"))) {
      throw new Error(`Archive missing ${pin.dataPrefix ?? "data"}/pool.json`);
    }
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
    copyDataTree(dataDir, outDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const rel of pin.required ?? []) {
    if (!existsSync(join(outDir, rel))) {
      throw new Error(`Missing required path after fetch: vendor/cards-data/${rel}`);
    }
  }
  writePinReceipt(outDir, pin, {
    rawBase: pin.rawBase,
    archiveUrl: pin.archiveUrl,
    required: pin.required,
  });
  console.log(`Pinned ${pin.tag} → ${outDir}`);
}

function linkEngineVendor() {
  const engineRoot = join(root, "deps/netrunner-engine");
  if (!existsSync(join(engineRoot, "package.json"))) return;
  const engineVendor = join(engineRoot, "vendor");
  mkdirSync(engineVendor, { recursive: true });
  for (const name of ["cards-data", "cr-data"]) {
    const src = join(root, "vendor", name);
    const dest = join(engineVendor, name);
    if (!existsSync(src)) continue;
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(join("..", "..", "..", "vendor", name), dest);
  }
  console.log(`Linked engine vendor → ${engineVendor}`);
}

await fetchCr();
await fetchCards();
linkEngineVendor();
