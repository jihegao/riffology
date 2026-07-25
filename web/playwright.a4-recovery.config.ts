import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "a4-5-recovery-cutover.spec.ts",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:8792",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bash e2e/start-a4-5-stack.sh",
    url: "http://localhost:8792",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
