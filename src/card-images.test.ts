import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_IMAGE_BASE, cardImageUrl } from "./card-images.js";

test("a card image links to NSG's host, not this server", () => {
  assert.equal(CARD_IMAGE_BASE, "https://card-images.netrunnerdb.com/v2");
  assert.equal(cardImageUrl("30030"), "https://card-images.netrunnerdb.com/v2/large/30030.jpg");
  assert.equal(cardImageUrl("30030", 0, "small"), "https://card-images.netrunnerdb.com/v2/small/30030.jpg");
});

test("a back face uses the host's 0-based extra-face suffix", () => {
  // Faces are stored front first: face 1 is the first back face, image -0.
  assert.equal(cardImageUrl("08012", 1), "https://card-images.netrunnerdb.com/v2/large/08012-0.jpg");
  assert.equal(cardImageUrl("08012", 3), "https://card-images.netrunnerdb.com/v2/large/08012-2.jpg");
});
