/**
 * Larger local run of the visibility fuzz (CR audit tool 1.7).
 *
 *   npm run fuzz:visibility -- [--seeds N] [--first S] [--steps N] [--format learn_to_play|startup] [--json out.json]
 *   npm run fuzz:visibility -- --write-baseline   # rewrite test/baselines/visibility-leaks.json from the CI run
 *
 * Prints each leak key once, with the first match it was seen in, and marks
 * the ones the baseline does not list. Exits 1 when it finds a leak the
 * baseline does not list.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  BASELINE_PATH,
  CI_FUZZ,
  CLASS_RULES,
  FUZZ_FORMATS,
  baselineFrom,
  leakKey,
  readBaseline,
  runFuzz,
  type FuzzFormat,
} from "../src/visibility-fuzz.js";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const writeBaseline = process.argv.includes("--write-baseline");
const formats = writeBaseline
  ? CI_FUZZ.formats
  : arg("format")
    ? [arg("format") as FuzzFormat]
    : [...FUZZ_FORMATS];
const count = Number(arg("seeds") ?? 25);
const first = Number(arg("first") ?? 1);
const seeds = writeBaseline ? CI_FUZZ.seeds : Array.from({ length: count }, (_, i) => first + i);
const steps = writeBaseline ? CI_FUZZ.steps : Number(arg("steps") ?? 300);

const run = await runFuzz(formats, seeds, steps);

if (writeBaseline) {
  const baseline = baselineFrom(run, { seeds: CI_FUZZ.seeds, steps: CI_FUZZ.steps, formats: CI_FUZZ.formats });
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`wrote ${baseline.leaks.length} leaks to ${BASELINE_PATH}`);
}

let known = new Set<string>();
try {
  known = new Set(readBaseline().leaks.map(leakKey));
} catch {
  // no baseline yet
}
const ends = new Map<string, number>();
for (const result of run.results) ends.set(result.ended, (ends.get(result.ended) ?? 0) + 1);
const totalSteps = run.results.reduce((sum, r) => sum + r.steps, 0);
console.log(
  `${run.results.length} matches, ${totalSteps} steps, ${run.ms} ms; ended: ${[...ends].map(([k, v]) => `${k} ${v}`).join(", ")}`,
);
for (const result of run.results) {
  if (result.ended === "crash") console.log(`  crash ${result.format} seed ${result.seed} step ${result.steps}: ${result.detail}`);
}
let unknown = 0;
for (const [key, leak] of [...run.leaks].sort(([a], [b]) => a.localeCompare(b))) {
  const fresh = !known.has(key);
  if (fresh) unknown += 1;
  console.log(
    `${fresh ? "NEW " : "    "}${key}  (${CLASS_RULES[leak.cls]})  ${leak.format}#${leak.seed}@${leak.step} ${leak.card}: ${JSON.stringify(leak.value)}`,
  );
}
console.log(`${run.leaks.size} leak keys, ${unknown} not in the baseline`);

const out = arg("json");
if (out) {
  writeFileSync(
    out,
    JSON.stringify({ results: run.results.map(({ leaks, ...rest }) => ({ ...rest, leaks: leaks.length })), leaks: [...run.leaks.values()] }, null, 2),
  );
}
if (unknown > 0 && !writeBaseline) process.exitCode = 1;
