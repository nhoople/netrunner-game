#!/usr/bin/env node
/**
 * Clone the engine release named in data/engine-pin.json into deps/netrunner-engine.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(root, "data/engine-pin.json"), "utf8"));
const dest = join(root, "deps/netrunner-engine");
const parent = join(root, "deps");

rmSync(dest, { recursive: true, force: true });
mkdirSync(parent, { recursive: true });

process.stdout.write(`Cloning ${pin.repo} @ ${pin.tag} → ${dest}\n`);
execFileSync(
  "git",
  [
    "clone",
    "--depth",
    "1",
    "--branch",
    pin.tag,
    pin.repo,
    dest,
  ],
  { stdio: "inherit" },
);
const engineVendor = join(dest, "vendor");
mkdirSync(engineVendor, { recursive: true });
for (const name of ["cards-data", "cr-data"]) {
  const src = join(root, "vendor", name);
  if (!existsSync(src)) continue;
  const link = join(engineVendor, name);
  if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
    rmSync(link, { recursive: true, force: true });
  }
  symlinkSync(join("..", "..", "..", "vendor", name), link);
}

console.log(`Pinned engine ${pin.tag} → ${dest}`);
