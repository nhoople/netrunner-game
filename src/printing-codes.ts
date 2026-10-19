/**
 * Default printing for a title. The code is the Null Signal / NetrunnerDB
 * printing id (Sure Gamble's Gateway printing is 30030). The image file uses
 * that code as its name. When a title has several printings, the default is
 * the one from the latest pack in pool.json corpusOrder.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cardsDir = fileURLToPath(new URL("../vendor/cards-data", import.meta.url));

interface PrintingFile {
  code: string;
  cardId: string;
  pack: string;
}

function loadDefaultCodes(): Map<string, string> {
  const pool = JSON.parse(readFileSync(join(cardsDir, "pool.json"), "utf8")) as {
    corpusOrder: string[];
  };
  const order = new Map(pool.corpusOrder.map((pack, index) => [pack, index]));
  const best = new Map<string, { code: string; rank: number }>();
  for (const name of readdirSync(join(cardsDir, "printings"))) {
    if (!name.endsWith(".json")) continue;
    const printing = JSON.parse(readFileSync(join(cardsDir, "printings", name), "utf8")) as PrintingFile;
    const rank = order.get(printing.pack);
    if (rank == null || !printing.cardId || !printing.code) continue;
    const current = best.get(printing.cardId);
    if (!current || rank > current.rank) {
      best.set(printing.cardId, { code: printing.code, rank });
    }
  }
  return new Map([...best].map(([id, entry]) => [id, entry.code]));
}

const printingCodes = loadDefaultCodes();

export function printingCodeFor(defId: string | undefined): string | undefined {
  if (!defId) return undefined;
  return printingCodes.get(defId);
}
