import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertPrintedDir, printedTextFor } from "../../src/cards/printed.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("printed text loads from the cards pin's print/printed folder", () => {
  assertPrintedDir(join(root, "vendor/cards-data/print/printed"));
  assert.equal(printedTextFor("hedge-fund"), "Gain 9[credit].");
});

test("a missing printed text folder stops the host instead of showing cards blank", () => {
  // The flat layout of cards tags before v1.148.0 kept printed text here.
  assert.throws(
    () => assertPrintedDir(join(root, "vendor/cards-data/printed")),
    /No printed card text at .*Run npm run fetch-data/,
  );
});
