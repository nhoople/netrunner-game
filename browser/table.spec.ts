/**
 * The verification table, at desktop width only: the lobby, then the Corp,
 * Runner, spectator, log and debug pages of a fresh match. Each test checks the
 * page's main parts are present. It does not compare pictures.
 */
import { expect, test } from "./fixture";
import { saveView, WIDTHS } from "./screenshots";

test.use({ viewport: WIDTHS.desktop });

test("the table lobby offers to create a match", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Netrunner test table" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create learn-to-play match" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create expanded learn-to-play match" })).toBeVisible();
  await saveView(page, testInfo, "table-lobby", ["desktop"]);
});

test("the Corp table page shows the board, HQ, the mulligan choice and the log", async ({ page, match }, testInfo) => {
  await page.goto(match.table.corp);
  await expect(page.locator("#seat")).toHaveText("You are corp");
  await expect(page.locator("#board")).toContainText("R&D");
  await expect(page.locator("#hand-heading")).toHaveText("HQ");
  await expect(page.locator("#hand > li"), "5 cards in HQ").toHaveCount(5);
  await expect(page.locator("#plays-heading")).toHaveText("Starting hand");
  await expect(page.locator("#actions").getByRole("button")).not.toHaveCount(0);
  await expect(page.locator("#log")).toBeAttached();
  await expect(page.locator("#error")).toBeEmpty();
  await saveView(page, testInfo, "table-corp", ["desktop"]);
});

test("the Runner table page shows the board, the grip, the waiting note and the log", async ({
  page,
  match,
}, testInfo) => {
  await page.goto(match.table.runner);
  await expect(page.locator("#seat")).toHaveText("You are runner");
  await expect(page.locator("#board")).toContainText("R&D");
  await expect(page.locator("#hand-heading")).toHaveText("Grip");
  await expect(page.locator("#hand > li"), "5 cards in the grip").toHaveCount(5);
  await expect(page.locator("#legal-note")).toHaveText("Corp is choosing whether to keep their starting hand.");
  await expect(page.locator("#log")).toBeAttached();
  await expect(page.locator("#error")).toBeEmpty();
  await saveView(page, testInfo, "table-runner", ["desktop"]);
});

test("the spectator table page shows the board with both hands hidden", async ({ page, match }, testInfo) => {
  await page.goto(match.table.spectator);
  await expect(page.locator("#seat")).toHaveText("You are watching");
  await expect(page.locator("#board")).toContainText("R&D");
  await expect(page.locator("#hand-heading")).toHaveText("Hands");
  await expect(page.locator("#hand")).toHaveText("Hidden. HQ and the grip stay with their seats.");
  await expect(page.locator("#plays-heading")).toHaveText("Watching");
  await expect(page.locator("#concede")).toBeHidden();
  await expect(page.locator("#log")).toBeAttached();
  await expect(page.locator("#error")).toBeEmpty();
  await saveView(page, testInfo, "table-spectator", ["desktop"]);
});

test("the log page shows the match and its current step", async ({ page, match }, testInfo) => {
  await page.goto(match.table.log);
  await expect(page.getByRole("heading", { name: "Game log" })).toBeVisible();
  await expect(page.locator("#status")).toHaveText(`Match ${match.matchId}`);
  await expect(page.locator("#step")).toContainText("Corp may take a mulligan");
  await expect(page.locator("#log")).toBeAttached();
  await expect(page.locator("#error")).toBeEmpty();
  await saveView(page, testInfo, "table-log", ["desktop"]);
});

test("the debug page shows both hands, the Corp's actions and the internal board", async ({
  page,
  match,
}, testInfo) => {
  await page.goto(match.table.debug);
  await expect(page.getByRole("heading", { name: "Debug", exact: true })).toBeVisible();
  await expect(page.locator("#corp-hand > li"), "5 cards in HQ").toHaveCount(5);
  await expect(page.locator("#runner-hand > li"), "5 cards in the grip").toHaveCount(5);
  await expect(page.locator("#corp-legal").getByRole("button")).not.toHaveCount(0);
  await expect(page.locator("#board")).not.toHaveText("—");
  await expect(page.locator("#engine-state")).not.toHaveText("—");
  await expect(page.locator("#error")).toBeEmpty();
  await saveView(page, testInfo, "table-debug", ["desktop"]);
});
