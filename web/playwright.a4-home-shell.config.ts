import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.A4_WEB_PORT ?? 5173);
if (!Number.isSafeInteger(webPort) || webPort < 1 || webPort > 65_535) {
  throw new Error("A4_WEB_PORT must be an integer from 1 through 65535.");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "a4-home-shell.spec.ts",
  timeout: 45_000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bash e2e/start-a4-stack.sh",
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
