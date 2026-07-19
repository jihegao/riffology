#!/usr/bin/env node
/**
 * Live OpenCode acceptance harness.
 *
 * Requires the browser app, backend, Mesa service, MCP bridge, and a configured
 * real OpenCode provider. It intentionally refuses RIFF_SKIP_OPENCODE mode.
 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { chromium } = require("playwright");
const baseUrl = process.env.RIFF_DEMO_URL ?? "http://127.0.0.1:5173";
const backendUrl = process.env.RIFF_BACKEND_URL ?? "http://127.0.0.1:8787";
const timeout = Number(process.env.RIFF_LIVE_TIMEOUT_MS ?? 60_000);
const screenshotPath = resolve("test-results", "riff-live-e2e.png");
let stage = "bootstrap";

const reportFailure = (error) => {
  console.error(JSON.stringify({
    outcome: "failed",
    stage,
    error: error instanceof Error ? error.message : String(error),
  }));
};
const markStage = (name) => {
  stage = name;
  console.log(JSON.stringify({ outcome: "running", stage }));
};

const assertAcceptedChat = async (response, label) => {
  if (response.status() !== 202) throw new Error(`${label} chat was not accepted (HTTP ${response.status()}).`);
};

try {
await mkdir(resolve("test-results"), { recursive: true });
markStage("bootstrap-session");
const bootstrapResponse = await fetch(`${backendUrl}/api/sessions`, { method: "POST" });
const bootstrap = await bootstrapResponse.json().catch(() => ({}));
if (!bootstrapResponse.ok || typeof bootstrap.sessionId !== "string" || !bootstrap.sessionId) {
  throw new Error(`Live OpenCode acceptance could not bootstrap a server session (HTTP ${bootstrapResponse.status}).`);
}
const sessionId = bootstrap.sessionId;
const chatPath = `/api/sessions/${encodeURIComponent(sessionId)}/chat`;
const chatResponse = (page) => page.waitForResponse(
  (response) => response.request().method() === "POST" && new URL(response.url()).pathname === chatPath,
  { timeout },
);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

try {
  markStage("open-browser");
  await page.goto(`${baseUrl}?session=${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("main", { name: "Riff simulation demo" }).waitFor({ timeout });

  const initialState = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/snapshot`);
    return response.json();
  }, sessionId);
  if (initialState.sessionId !== sessionId) throw new Error("Live OpenCode acceptance did not receive its bootstrapped browser session.");
  if (initialState.agent?.modelId === "dev/deterministic") {
    throw new Error("Live OpenCode acceptance requires RIFF_SKIP_OPENCODE=false; deterministic development mode is active.");
  }
  if (initialState.agent?.status !== "ready" || !initialState.agent?.modelId) {
    throw new Error("Live OpenCode acceptance requires a ready configured provider/model before chat can begin.");
  }

  await page.getByLabel("Attach input file").setInputFiles({
    name: "arrivals.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("tick,arrivals\n0,6\n1,7\n"),
  });
  await page.getByTestId("attachment-list").getByText("arrivals.csv").waitFor({ timeout });

  const loadPrompt = "Load the approved queue-network-v1 model from my uploaded CSV, then show its parameters.";
  markStage("load-model-via-opencode");
  const loadChat = chatResponse(page);
  await page.getByLabel("Message the modelling assistant").fill(loadPrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await assertAcceptedChat(await loadChat, "Model-load");

  await page.getByRole("tab", { name: "Parameters" }).click();
  await page.getByTestId("model-summary").getByRole("heading", { name: "Service queue" }).waitFor({ timeout });
  const arrivalRate = page.getByTestId("parameter-input-arrival_rate");
  await arrivalRate.fill("8");
  await page.getByRole("button", { name: "Save parameters" }).click();
  await page.getByText("Parameters saved").waitFor({ timeout });

  await page.getByRole("tab", { name: "Run" }).click();
  markStage("run-mesa-experiment");
  await page.getByRole("button", { name: "Run experiment" }).click();
  await page.getByRole("status", { name: "Simulation status" }).filter({ hasText: /succeeded/i }).waitFor({ timeout });
  await page.getByRole("tab", { name: "Results" }).click();
  await page.getByRole("region", { name: "Simulation results" }).waitFor({ timeout });
  await page.getByRole("list", { name: "Result metrics" }).waitFor({ timeout });
  await page.getByRole("img", { name: "Simulation time series" }).waitFor({ timeout });
  await page.getByRole("table", { name: "Simulation result table" }).waitFor({ timeout });

  const assistantMessages = page.locator(".message-assistant");
  const assistantCountBeforeSummary = await assistantMessages.count();
  const summaryPrompt = "请基于刚才的仿真结果，用中文总结队列长度、完成任务数和平均等待时间三个指标。";
  markStage("summarize-results-via-opencode");
  const summaryChat = chatResponse(page);
  await page.getByLabel("Message the modelling assistant").fill(summaryPrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await assertAcceptedChat(await summaryChat, "Result-summary");

  await page.waitForFunction(
    (count) => document.querySelectorAll(".message-assistant").length > count,
    assistantCountBeforeSummary,
    { timeout },
  );
  const summaryText = await assistantMessages.last().innerText();
  if (!/(queue|队列)/i.test(summaryText) || !/(completed|完成)/i.test(summaryText) || !/(wait|等待)/i.test(summaryText)) {
    throw new Error("Live assistant summary did not include queue, completed, and wait metrics.");
  }

  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    conversation: document.querySelector('[data-testid="conversation-pane"]')?.getBoundingClientRect().toJSON(),
    workbench: document.querySelector('[data-testid="mesa-workbench"]')?.getBoundingClientRect().toJSON(),
  }));
  if (viewport.scrollWidth > viewport.width || viewport.scrollHeight > viewport.height) throw new Error("Live desktop shell overflows the 1440x900 viewport.");
  if (!viewport.conversation || !viewport.workbench || viewport.conversation.bottom > viewport.height || viewport.workbench.bottom > viewport.height) {
    throw new Error("Live desktop shell does not fit both panes in the viewport.");
  }
  await page.screenshot({ path: screenshotPath, fullPage: false });
  stage = "completed";
  console.log(JSON.stringify({ outcome: "passed", screenshotPath, viewport }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
} catch (error) {
  reportFailure(error);
  process.exitCode = 1;
}
