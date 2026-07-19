#!/usr/bin/env node
/**
 * Local visible-browser smoke for the bounded Riff demonstration.
 *
 * Run after scripts/start-local-demo.sh (or equivalent) has started Mesa,
 * backend, and Vite. This uses the deterministic development agent only when
 * RIFF_SKIP_OPENCODE=true; it cannot prove the live OpenCode release gate.
 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { chromium } = require("playwright");
const baseUrl = process.env.RIFF_DEMO_URL ?? "http://127.0.0.1:5173";
const screenshotPath = resolve("test-results", "riff-local-e2e.png");

await mkdir(resolve("test-results"), { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("main", { name: "Riff simulation demo" }).waitFor();
  await page.getByLabel("Attach input file").setInputFiles({
    name: "arrivals.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("tick,arrivals\n0,6\n1,7\n"),
  });
  await page.getByTestId("attachment-list").getByText("arrivals.csv").last().waitFor();
  await page.getByLabel("Message the modelling assistant").fill("Load the queue model from my uploaded file.");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("tab", { name: "Parameters" }).click();
  await page.getByTestId("model-summary").getByRole("heading", { name: "Service queue" }).waitFor({ timeout: 10_000 });
  const arrivalRate = page.getByTestId("parameter-input-arrival_rate");
  await arrivalRate.fill("8");
  await page.getByRole("button", { name: "Save parameters" }).click();
  await page.getByText("Parameters saved").waitFor();

  await page.getByRole("tab", { name: "Run" }).click();
  await page.getByRole("button", { name: "Run experiment" }).click();
  // The UI's visible status is "Simulation succeeded"; assert the named live
  // region and success meaning, not a stale exact child-text implementation.
  await page.getByRole("status", { name: "Simulation status" }).filter({ hasText: /succeeded/i }).waitFor({ timeout: 15_000 });
  await page.getByRole("tab", { name: "Results" }).click();
  await page.getByRole("region", { name: "Simulation results" }).waitFor();
  await page.getByRole("list", { name: "Result metrics" }).waitFor();
  await page.getByRole("img", { name: "Simulation time series" }).waitFor();
  await page.getByRole("table", { name: "Simulation result table" }).waitFor();

  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    conversation: document.querySelector('[data-testid="conversation-pane"]')?.getBoundingClientRect().toJSON(),
    workbench: document.querySelector('[data-testid="mesa-workbench"]')?.getBoundingClientRect().toJSON(),
  }));
  if (viewport.scrollWidth > viewport.width) throw new Error("desktop layout has horizontal overflow");
  if (!viewport.conversation || !viewport.workbench || viewport.conversation.bottom > viewport.height || viewport.workbench.bottom > viewport.height) {
    throw new Error("desktop shell does not fit both panes in the viewport");
  }
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(JSON.stringify({ outcome: "passed", baseUrl, screenshotPath, viewport }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
