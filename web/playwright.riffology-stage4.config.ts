import { defineConfig } from "@playwright/test";

const webPort = 8808;
const platformPort = 8809;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "riffology-stage4-browser-observation.spec.ts",
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    viewport: { width: 1800, height: 1180 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: `RIFF_E2E_STAGE4_BROWSER=1 A4_WEB_PORT=${webPort} A4_PLATFORM_PORT=${platformPort} bash e2e/start-a4-stack.sh`,
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
