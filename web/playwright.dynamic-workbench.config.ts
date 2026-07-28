import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "dynamic-workbench.spec.ts",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5273",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5273",
    url: "http://127.0.0.1:5273",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
