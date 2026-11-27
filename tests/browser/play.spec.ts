/**
 * The product client at `/play/`, at phone and desktop widths. Each test opens
 * a seat of a fresh match and checks the board's parts are on the page. It does
 * not compare pictures; the screenshots are saved for the PR.
 */
import { expect, test } from "./fixture";
import { saveView, WIDTHS, type WidthName } from "./screenshots";

for (const width of Object.keys(WIDTHS) as WidthName[]) {
  test.describe(`/play/ at ${width} width`, () => {
    test.use({ viewport: WIDTHS[width] });

    test("the Corp seat shows the servers, HQ, the mulligan buttons and the log", async ({ page, match }, testInfo) => {
      await page.goto(match.play.corp);

      await expect(page.locator(".servers .server"), "HQ, R&D and Archives").toHaveCount(3);
      await expect(page.locator(".server-name")).toHaveText(["HQ", "R&D", "Archives"]);
      await expect(page.getByRole("heading", { name: "HQ", exact: true })).toBeVisible();
      await expect(page.locator(".panel > .row .slot"), "5 cards in HQ").toHaveCount(5);
      await expect(page.locator(".felt")).toContainText("Corp may take a mulligan");
      await expect(page.getByRole("button", { name: "Keep this hand" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Game log" })).toBeVisible();
      await expect(page.locator(".log")).toBeAttached();
      await expect(page.locator(".error")).toBeEmpty();

      await saveView(page, testInfo, "play-corp", [width]);
    });

    test("the Runner seat shows the servers, the grip, the prompt and the log", async ({ page, match }, testInfo) => {
      await page.goto(match.play.runner);

      await expect(page.locator(".servers .server"), "HQ, R&D and Archives").toHaveCount(3);
      await expect(page.getByRole("heading", { name: "Grip", exact: true })).toBeVisible();
      await expect(page.locator(".panel > .row .slot"), "5 cards in the grip").toHaveCount(5);
      // The Corp decides first, so the Runner sees the prompt and no buttons yet.
      await expect(page.locator(".felt")).toContainText("Corp may take a mulligan");
      await expect(page.getByRole("heading", { name: "Legal plays" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Game log" })).toBeVisible();
      await expect(page.locator(".log")).toBeAttached();
      await expect(page.locator(".error")).toBeEmpty();

      await saveView(page, testInfo, "play-runner", [width]);
    });
  });
}
