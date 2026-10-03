/**
 * Printing codes already stored on the vendored card definitions.
 * The code is the NetrunnerDB / Null Signal printing id (Sure Gamble is 30030).
 * The image file is a static asset; this map only names it.
 * data/printing-code-overrides.json fills a definition that omitted nrdbCode.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cardsDir = fileURLToPath(new URL("../vendor/cards-data", import.meta.url));
const overridesPath = fileURLToPath(new URL("../data/printing-code-overrides.json", import.meta.url));

function loadPrintingCodes(): Map<string, string> {
  const codes = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".json") || entry.name.startsWith("_") || entry.name === "PIN.json") continue;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed == null || typeof parsed !== "object") continue;
      const card = parsed as { id?: unknown; nrdbCode?: unknown };
      if (typeof card.id === "string" && typeof card.nrdbCode === "string" && card.nrdbCode.length > 0) {
        codes.set(card.id, card.nrdbCode);
      }
    }
  };
  walk(cardsDir);
  const overrides = JSON.parse(readFileSync(overridesPath, "utf8")) as Record<string, unknown>;
  for (const [id, code] of Object.entries(overrides)) {
    if (!codes.has(id) && typeof code === "string" && code.length > 0) codes.set(id, code);
  }
  return codes;
}

const printingCodes = loadPrintingCodes();

export function printingCodeFor(defId: string | undefined): string | undefined {
  if (!defId) return undefined;
  return printingCodes.get(defId);
}
