import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "a4-6-exit.spec.ts",
  timeout: 20 * 60_000,
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
