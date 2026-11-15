/**
 * Links to card images on Null Signal Games' image host. Clients load and
 * cache them from there (the host sends a week-long cache header); this
 * server never stores or serves the image bytes.
 *
 * The address follows netrunnerdb-api-server's printing `images` field:
 * `{base}/{size}/{code}.jpg` for the front, and `{base}/{size}/{code}-{n}.jpg`
 * for extra face n of a double-sided card, counted from 0.
 */
export const CARD_IMAGE_BASE = "https://card-images.netrunnerdb.com/v2";

export type CardImageSize = "tiny" | "small" | "medium" | "large";

/**
 * The image link for a printing. `face` 0 is the front; face k (k >= 1) is the
 * k-th back face, stored front first as in the engine's `identityFaces`.
 */
export function cardImageUrl(code: string, face = 0, size: CardImageSize = "large"): string {
  const suffix = face > 0 ? `-${face - 1}` : "";
  return `${CARD_IMAGE_BASE}/${size}/${encodeURIComponent(code)}${suffix}.jpg`;
}
