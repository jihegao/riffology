import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("A4-4 renders an ordinary Model and completes one real Project batch Run", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });

  await page.goto("/");
  const csp = await page.request.get("/").then((response) =>
    response.headers()["content-security-policy"]);
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-src http://localhost:8788");
  expect(csp).toContain("object-src 'none'");
  const windModel = page.getByTestId("home-models").locator("article").filter({
    has: page.getByRole("heading", { name: "Wind Turbine Maintenance", exact: true }),
  });
  await windModel.getByRole("link", { name: "Open Model" }).click();
  await expect(page.getByTestId("model-workspace")).toBeVisible();
  await expect.poll(() => visibleExactTextCount(page, "Wind Turbine Maintenance")).toBe(1);
  await expect(page.getByText(/thin execution contract passed/u)).toBeVisible();
  await page.getByTestId("pane-workspace").getByRole("button", {
    name: /visuals\/README\.md/u,
  }).click();
  await expect(page.getByRole("heading", { name: "visuals/README.md" })).toBeVisible();
  await expect(page.getByText(/behavioral reproduction/u)).toBeVisible();

  await page.getByRole("link", { name: "Home" }).click();
  const windProject = page.getByTestId("home-projects").locator("article").filter({
    has: page.getByRole("heading", {
      name: "Wind Turbine Maintenance — Synthetic Baseline",
      exact: true,
    }),
  });
  await windProject.getByRole("link", { name: "Open Project" }).click();
  const projectWorkspace = page.getByTestId("project-workspace");
  await expect(projectWorkspace).toBeVisible();
  await expect.poll(() =>
    visibleExactTextCount(page, "Wind Turbine Maintenance — Synthetic Baseline")).toBe(1);
  await projectWorkspace.evaluate((node) => {
    node.setAttribute("data-continuity", "retained");
  });
  await page.getByTestId("pane-workspace").getByText("Technical details", { exact: true })
    .click();
  await expect(page.getByText(/immutable Model copy/u)).toBeVisible();
  await expect(page.getByText(/Deterministic preview:/u)).toBeVisible();
  const configurationField = page.getByRole("textbox", { name: "Configuration JSON" });
  const boundedBatchConfiguration = JSON.parse(await configurationField.inputValue());
  boundedBatchConfiguration.parameters.horizon_days = 120;
  boundedBatchConfiguration.parameters.warmup_days = 30;
  boundedBatchConfiguration.parameters.turbine_count = 30;
  await configurationField.fill(JSON.stringify(boundedBatchConfiguration, null, 2));
  await page.getByRole("button", { name: "Save configuration" }).press("Enter");
  await page.getByRole("button", { name: "Start batch Run" }).click();
  await expect(page.getByText("succeeded", { exact: true }).first()).toBeVisible({
    timeout: 180_000,
  });
  await expect(page.getByRole("table", { name: /Digest-checked outputs/u })).toBeVisible();
  await expect(projectWorkspace).toHaveAttribute("data-continuity", "retained");
  await expect(page.getByText(/never creates an analysis document automatically/u)).toBeVisible();

  await page.getByRole("textbox", { name: "Sample index" }).fill("0");
  await page.getByRole("button", { name: "Load diagnostic events" }).click();
  await expect(page.getByRole("table", { name: /Bounded diagnostic events/u })).toBeVisible({
    timeout: 30_000,
  });
  const eventTableRegion = page.getByRole("region", { name: /Diagnostic events scrollable table/u });
  await eventTableRegion.focus();
  await expect(eventTableRegion).toBeFocused();
  const loadMoreEvents = page.getByRole("button", { name: "Load more diagnostic events" });
  await expect(loadMoreEvents).toBeVisible();
  const eventRowsBefore = await page.getByRole("table", {
    name: /Bounded diagnostic events/u,
  }).getByRole("row").count();
  await loadMoreEvents.press("Enter");
  await expect.poll(() => page.getByRole("table", {
    name: /Bounded diagnostic events/u,
  }).getByRole("row").count()).toBeGreaterThan(eventRowsBefore);
  await page.locator(".product-downloads > div").filter({
    has: page.getByRole("button", { name: /Download summary/u }),
  }).getByRole("button", { name: "Render safely" }).click();
  await expect(page.getByRole("heading", { name: "summary", exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download summary/u }).first().click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = await readFile(path!);
  expect(bytes.byteLength).toBeGreaterThan(0);
  expect(createHash("sha256").update(bytes).digest("hex")).toMatch(/^[0-9a-f]{64}$/u);

  await page.getByRole("link", { name: "Home" }).click();
  const visualProject = page.getByTestId("home-projects").locator("article").filter({
    has: page.getByRole("heading", { name: "Generic Visual Project", exact: true }),
  });
  await visualProject.getByRole("link", { name: "Open Project" }).click();
  await expect(page.getByRole("button", { name: "Start visual Run" })).toBeEnabled();
  await page.getByRole("button", { name: "Start visual Run" }).press("Enter");
  await expect(page.getByRole("button", { name: "Open restricted visual frame" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Open restricted visual frame" }).press("Enter");
  const visualHostUrl = await page.getByTestId("visual-host-url").textContent();
  expect(visualHostUrl).toMatch(
    /^http:\/\/localhost:8787\/browser\/projects\/project_a4_visual\/runs\/run_[a-f0-9]{32}\/visual$/u,
  );
  await page.goto(visualHostUrl!);
  const visualFrame = page.getByTitle("Project visual run");
  await expect(visualFrame).toBeVisible({ timeout: 30_000 });
  await expect(visualFrame).toHaveAttribute(
    "src",
    /^http:\/\/localhost:8788\/frame\/redeem\/[A-Za-z0-9_-]{43}$/u,
  );
  await expect(page.frameLocator("iframe[title='Project visual run']").locator("body"))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.frameLocator("iframe[title='Project visual run']")
    .getByRole("heading", { name: "Generic visual fixture" })).toBeVisible();
  await page.goto("/");
  await visualProject.getByRole("link", { name: "Open Project" }).click();
  await page.getByRole("button", { name: "Cancel Run" }).press("Enter");
  await expect(page.getByText("cancelled", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  await page.setViewportSize({ width: 640, height: 900 });
  await page.getByTestId("pane-selector").getByRole("button", { name: "Workspace" }).click();
  await expect(page.getByTestId("pane-workspace")).toBeVisible();
  const fit = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
  await page.getByTestId("pane-selector").getByRole("button", { name: "Workspace" }).focus();
  await expect(page.getByTestId("pane-selector").getByRole("button", {
    name: "Workspace",
  })).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("a4-4-project-workspace.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

const visibleExactTextCount = (page: import("@playwright/test").Page, text: string) =>
  page.getByText(text, { exact: true }).evaluateAll((elements) =>
    elements.filter((element) => {
      const style = getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0;
    }).length);
