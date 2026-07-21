import { expect, test } from "@playwright/test";

const attachOwner = async (page: import("@playwright/test").Page) => { await page.goto("/"); await page.getByLabel(/E2E Owner/).check(); await page.getByRole("button", { name: "Attach selected actor" }).click(); await expect(page.getByRole("main", { name: "Wind-turbine maintenance Evidence Studio" })).toBeVisible(); };
const discardIfStale = async (page: import("@playwright/test").Page) => { const button = page.getByRole("button", { name: "Discard and load current" }); await button.waitFor({ state: "visible", timeout: 2_000 }).catch(() => undefined); if (await button.isVisible().catch(() => false)) await button.click(); };

test("live backend requires explicit actor attachment and preserves legacy entry", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Playwright Wind Evidence" })).toBeVisible();
  await expect(page.getByText("No actor is selected silently.")).toBeVisible();
  await page.getByLabel(/E2E Owner/).check();
  await page.getByRole("button", { name: "Attach selected actor" }).click();
  await expect(page.getByRole("main", { name: "Wind-turbine maintenance Evidence Studio" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Brief" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Model" }).click(); await expect(page.locator('[data-testid="model-transition-edge"]')).toHaveCount(16); await expect(page.locator('[data-testid="process-transition"]')).toHaveCount(16);
  await page.getByRole("tab", { name: "Model" }).press("End");
  await expect(page.getByRole("tab", { name: "Evidence" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Legacy queue / OpenCode" })).toHaveAttribute("href", "?mode=legacy");
  await page.getByRole("link", { name: "Legacy queue / OpenCode" }).click();
  await expect(page.getByRole("main", { name: "Riff simulation demo" })).toBeVisible();
});

test("narrow layout exposes an explicit one-pane selector", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto("/");
  await page.getByLabel(/E2E Owner/).check();
  await page.getByRole("button", { name: "Attach selected actor" }).click();
  await expect(page.getByRole("button", { name: "Conversation / alignment" })).toBeVisible();
  await page.getByRole("button", { name: "Conversation / alignment" }).click();
  await expect(page.getByRole("complementary", { name: "Alignment and revision context" })).toBeVisible();
});

test("real framed project supports revision, review, 202 run, verified paged evidence, reload, and 390px 200% semantics", async ({ page }) => {
  test.setTimeout(120_000); await attachOwner(page);
  await page.getByRole("tab", { name: "Run" }).click(); const runResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/projects\/[^/]+\/runs$/.test(new URL(response.url()).pathname)); await page.getByRole("button", { name: "Start private draft run" }).click(); expect((await runResponse).status()).toBe(202); await expect(page.getByText(/terminal · succeeded/)).toBeVisible({ timeout: 30_000 }); await discardIfStale(page);
  await page.getByRole("tab", { name: "Experiment" }).click(); await expect(page.getByRole("heading", { name: "Experiment revision" })).toBeVisible(); await expect(page.locator('[data-testid^="parameter-"]')).toHaveCount(29);
  const crewCount = page.locator('[data-testid="parameter-crew_count"] input'); await crewCount.fill("4"); const revisionBeforeEdit = await page.locator(".revision").textContent(); await page.getByRole("button", { name: "Save as new revision" }).click(); await expect(page.locator(".revision")).not.toHaveText(revisionBeforeEdit ?? ""); await discardIfStale(page);
  await page.getByRole("button", { name: "Reset all" }).click(); await expect(page.getByRole("dialog", { name: "Reset preview" })).toBeVisible(); const revisionBeforeReset = await page.locator(".revision").textContent(); await page.getByRole("button", { name: "Confirm reset as new revision" }).click(); await expect(page.getByRole("dialog", { name: "Reset preview" })).toBeHidden(); await expect(page.locator(".revision")).not.toHaveText(revisionBeforeReset ?? ""); await discardIfStale(page);
  const resetExperimentRevision = await page.getByRole("tabpanel").locator(".identity-row").filter({ hasText:"Revision" }).locator("code").getAttribute("title"); expect(resetExperimentRevision).toMatch(/^er_[0-9a-f]{64}$/);
  await page.getByRole("tab", { name: "Issues & review" }).click(); await page.getByLabel("Title").fill("E2E evidence review"); await page.getByLabel("Body").fill("Exercise exact issue and attestation projections."); await page.getByRole("button", { name: "Open issue" }).click(); await page.getByRole("button", { name: "Load authoritative issue detail & history" }).click(); await expect(page.getByText("E2E evidence review", { exact: true })).toBeVisible(); await discardIfStale(page);
  await page.getByLabel("Rationale").fill("Reviewed for workflow progression only."); await page.getByRole("button", { name: "Record attestation" }).click(); await expect(page.getByText("Reviewed for workflow progression only.")).toBeVisible(); await expect(page.getByText("effective head").first()).toBeVisible(); await discardIfStale(page);
  await page.getByRole("tab", { name: "Run" }).click(); const editedRunResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/projects\/[^/]+\/runs$/.test(new URL(response.url()).pathname)); await page.getByRole("button", { name: "Start private draft run" }).click(); expect((await editedRunResponse).status()).toBe(202); await expect(page.getByText(/terminal · succeeded/)).toHaveCount(2, { timeout: 45_000 }); await discardIfStale(page); await expect(page.locator(".run-card").first().locator(".identity-row").filter({ hasText:"Experiment" }).locator("code")).toHaveAttribute("title",resetExperimentRevision!); await page.locator(".run-card").first().getByRole("button", { name: "Select" }).click();
  await expect(page.getByRole("heading", { name: /^Evidence/, level: 2 })).toBeVisible(); await expect(page.getByText("wind-kpi-equal-index-floor-v1").first()).toBeVisible({ timeout: 30_000 }); await expect(page.getByRole("table", { name: /Complete paged daily KPI rows/ })).toBeVisible(); await expect(page.getByRole("table", { name: /Complete paged selected-run event projection/ })).toBeVisible(); await expect(page.getByText(/Loaded \d+\/\d+ exact replay frames/)).toBeVisible(); await expect(page.getByText("Exact daily metrics embedded", { exact: false })).toBeVisible(); await expect(page.getByRole("heading", { name:"Exact evidence downloads" }).locator("..").getByRole("link")).toHaveCount(8);
  await page.reload(); await expect(page.getByText("No actor is selected silently.")).toBeVisible(); await page.getByLabel(/E2E Owner/).check(); await page.getByRole("button", { name: "Attach selected actor" }).click(); await page.getByRole("tab", { name: "Evidence" }).click(); await expect(page.getByText("wind-kpi-equal-index-floor-v1").first()).toBeVisible({ timeout: 20_000 });
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => { document.documentElement.style.zoom = "2"; }); await expect(page.getByRole("button", { name: "Workbench" })).toBeVisible(); await expect(page.getByRole("tab", { name: "Evidence" })).toHaveAccessibleName("Evidence"); await expect(page.getByRole("table", { name: /Complete paged daily KPI rows/ })).toBeVisible();
});
