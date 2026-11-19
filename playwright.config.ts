import { defineConfig, devices } from "@playwright/test";

// Browser smoke tests. Servers and matches come from browser/fixture.ts.
export default defineConfig({
  testDir: "browser",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
