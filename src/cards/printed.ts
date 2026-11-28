/**
 * Printed card text from the cards pin (`vendor/cards-data/print/printed`). The
 * table shows it beside the Effect IR so a reader can compare the two; card
 * text wins on a direct contradiction (CR 1.2.1).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const printedDir = fileURLToPath(new URL("../../vendor/cards-data/print/printed", import.meta.url));

/**
 * Throws when the printed text folder is missing: that means a wrong path or
 * an unfetched pin, not cards without text, so the table must not start blank.
 */
export function assertPrintedDir(dir: string): void {
  if (!existsSync(dir)) {
    throw new Error(`No printed card text at ${dir}. Run npm run fetch-data.`);
  }
}

assertPrintedDir(printedDir);

interface PrintedFile {
  cardId: string;
  text?: string;
}

const cache = new Map<string, string | null>();

/** The printed text for a card definition, or undefined when the pin has none. */
export function printedTextFor(defId: string | undefined): string | undefined {
  if (!defId || !/^[a-z0-9-]+$/.test(defId)) return undefined;
  const cached = cache.get(defId);
  if (cached !== undefined) return cached ?? undefined;
  let text: string | null = null;
  try {
    const file = JSON.parse(readFileSync(join(printedDir, `${defId}.json`), "utf8")) as PrintedFile;
    if (file.cardId === defId && typeof file.text === "string") text = file.text;
  } catch {
    text = null;
  }
  cache.set(defId, text);
  return text ?? undefined;
}
