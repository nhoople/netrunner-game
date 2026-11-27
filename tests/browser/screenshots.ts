/**
 * The one screenshot helper for browser tests (dev tooling plan, shared pieces).
 *
 * `saveView` saves a named view at each width it is given, as
 * `test-results/screenshots/<view>-<width>.png`, and attaches each picture to
 * the test's report. CI uploads `test-results/` as an artifact, and PRs link
 * these pictures as proof. Nothing compares them.
 */
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

/** The widths views are checked and saved at. */
export const WIDTHS = {
  phone: { width: 375, height: 812 },
  desktop: { width: 1280, height: 900 },
} as const;

export type WidthName = keyof typeof WIDTHS;

/** Waits until every image on the page has loaded or failed, up to a few seconds. */
async function imagesSettled(page: Page): Promise<void> {
  await page
    .waitForFunction(() => Array.from(document.images).every((image) => image.complete), undefined, {
      timeout: 5_000,
    })
    .catch(() => undefined);
}

export async function saveView(
  page: Page,
  testInfo: TestInfo,
  view: string,
  widths: readonly WidthName[],
): Promise<void> {
  for (const width of widths) {
    await page.setViewportSize(WIDTHS[width]);
    await imagesSettled(page);
    const path = join(testInfo.project.outputDir, "screenshots", `${view}-${width}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`${view}-${width}`, { path, contentType: "image/png" });
  }
}
