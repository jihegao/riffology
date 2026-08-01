import { defineConfig } from "@playwright/test";

const webPort = 8802;
const platformPort = 8803;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "riffology-stage2-shell.spec.ts",
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    viewport: { width: 1800, height: 1180 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: `A4_WEB_PORT=${webPort} A4_PLATFORM_PORT=${platformPort} bash e2e/start-a4-stack.sh`,
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
