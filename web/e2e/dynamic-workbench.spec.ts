import { expect, test, type Page } from "@playwright/test";

const digest = (character: string) => character.repeat(64);
let changeState: "pending" | "applied" | "rejected" = "pending";
let changeFreshness: "fresh" | "stale" = "fresh";
let modelWorkspaceRequests = 0;
let modelWorkspaceRevision = 0;
let projectPhase: "planning" | "queued" | "running" | "succeeded" = "planning";
let projectWorkspaceRequests = 0;
let projectAdvanceToRunning = false;
let projectAdvanceToSucceeded = false;
let appliedRequests = 0;
let rejectedRequests = 0;
let lastApplyAfterWorkspaceDigest: string | undefined;
let lastWorkspaceDigestServed: string | undefined;
let releaseSlowPreview: (() => void) | undefined;
let slowPreviewWaiting = false;
let slowPreviewFulfilled = false;

test.beforeEach(async ({ page }) => {
  changeState = "pending";
  changeFreshness = "fresh";
  modelWorkspaceRequests = 0;
  modelWorkspaceRevision = 0;
  projectPhase = "planning";
  projectWorkspaceRequests = 0;
  projectAdvanceToRunning = false;
  projectAdvanceToSucceeded = false;
  appliedRequests = 0;
  rejectedRequests = 0;
  lastApplyAfterWorkspaceDigest = undefined;
  lastWorkspaceDigestServed = undefined;
  releaseSlowPreview = undefined;
  slowPreviewWaiting = false;
  slowPreviewFulfilled = false;
  await installProductFixture(page);
});

test("dynamic Model views and review rail retain the shared shell on desktop and mobile", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      browserErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });

  await page.goto("/models/model-one?conversation=conversation-one");
  await expect(page.getByTestId("model-workspace")).toBeVisible();
  await expect(page.getByTestId("shell-owner-heading")).toHaveText("Fixture model");
  await expect.poll(() => visibleExactTextCount(page, "Fixture model")).toBe(1);
  await expect(page.getByText(/captured from an earlier Model workspace/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Operational sketch" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Source trail" })).toBeVisible();

  await page.getByRole("button", { name: "Source trail" }).click();
  await expect(page.getByText("Source view content")).toBeVisible();
  const sourceOpener = page.locator(".product-generated-view-sources")
    .getByRole("button", { name: "code/model.py" });
  await sourceOpener.click();
  const close = page.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeFocused();
  await expect(page.getByRole("button", { name: /code\/model.py/u }).last())
    .toHaveAttribute("aria-pressed", "true");
  await close.click();
  await expect(sourceOpener).toBeFocused();
  await sourceOpener.click();
  await expect(close).toBeFocused();

  const separator = page.getByRole("separator", { name: "Resize review rail" });
  await expect(separator).toHaveAttribute("aria-valuenow", "360");
  await separator.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "376");
  const box = await separator.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 80);
  await page.mouse.down();
  await page.mouse.move(box!.x - 80, box!.y + 80);
  await page.mouse.up();
  await expect.poll(async () =>
    Number(await separator.getAttribute("aria-valuenow"))).toBeGreaterThan(420);

  await page.getByRole("button", { name: "Changes · 1" }).click();
  await expect(page.getByRole("button", { name: "Apply whole change set" })).toBeEnabled();
  await page.getByRole("button", { name: "Apply whole change set" }).click();
  await expect(page.getByText("Applied")).toBeVisible();
  await expect(page.getByRole("button", { name: "Changes · 0" })).toBeVisible();

  const desktopFit = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(desktopFit.scroll).toBeLessThanOrEqual(desktopFit.client);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  const zoomedFit = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    scale: window.visualViewport?.scale,
  }));
  expect(zoomedFit.scale).toBe(2);
  expect(zoomedFit.scroll).toBeLessThanOrEqual(zoomedFit.client);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });

  await page.setViewportSize({ width: 640, height: 900 });
  await page.getByTestId("pane-selector").getByRole("button", {
    name: "Workspace",
  }).click();
  const trigger = page.getByRole("button", { name: "Open file and change review" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "File and change review" });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(page.locator(".product-header")).toHaveAttribute("inert", "");
  await expect(page.locator(".product-owner-header")).toHaveAttribute("inert", "");
  await expect(page.getByTestId("pane-selector")).toHaveAttribute("inert", "");
  await expect(page.getByTestId("pane-conversation")).toHaveAttribute("inert", "");
  await expect(page.locator(".product-workbench-canvas")).toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button").last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open file and change review" })).toBeFocused();
  await expect(page.locator(".product-header")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".product-owner-header")).not.toHaveAttribute("inert", "");

  const mobileFit = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(mobileFit.scroll).toBeLessThanOrEqual(mobileFit.client);
  expect(browserErrors).toEqual([]);
});

test("Conversation remains a single full-height scroll surface and switching it preserves the workspace", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto("/models/model-one?conversation=conversation-one");
  await expect(page.getByTestId("model-workspace")).toBeVisible();
  await expect(page.locator(".product-message")).toHaveCount(501);
  await expect(page.getByText("Message 500")).toBeVisible();
  await expect(page.getByTestId("conversation-composer-dock")).toBeVisible();

  const layout = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>("[data-testid='pane-conversation']")!;
    const content = document.querySelector<HTMLElement>(".product-conversation-content")!;
    const toolbar = document.querySelector<HTMLElement>("[data-testid='conversation-toolbar']")!;
    const scroll = document.querySelector<HTMLElement>("[data-testid='conversation-scroll-region']")!;
    const composer = document.querySelector<HTMLElement>("[data-testid='conversation-composer-dock']")!;
    const last = document.querySelector<HTMLElement>(".product-message:last-child")!;
    scroll.scrollTop = scroll.scrollHeight;
    const scrollBox = scroll.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    const lastBox = last.getBoundingClientRect();
    return {
      paneOverflow: getComputedStyle(pane).overflowY,
      contentOverflow: getComputedStyle(content).overflowY,
      contentContained: content.scrollHeight <= content.clientHeight,
      toolbarOverflow: getComputedStyle(toolbar).overflowY,
      scrollOverflow: getComputedStyle(scroll).overflowY,
      scrollable: scroll.scrollHeight > scroll.clientHeight,
      composerVisible: composerBox.top >= 0 && composerBox.bottom <= innerHeight,
      lastAboveComposer: lastBox.bottom <= composerBox.top,
      scrollAboveComposer: scrollBox.bottom <= composerBox.top,
    };
  });
  expect(layout).toMatchObject({
    paneOverflow: "hidden",
    contentOverflow: "visible",
    contentContained: true,
    toolbarOverflow: "visible",
    scrollOverflow: "auto",
    scrollable: true,
    composerVisible: true,
    lastAboveComposer: true,
    scrollAboveComposer: true,
  });

  const workspaceNode = page.getByTestId("model-workspace");
  await workspaceNode.evaluate((node) => { node.setAttribute("data-continuity", "kept"); });
  const requestsBeforeSwitch = modelWorkspaceRequests;
  await page.getByRole("link", { name: "Secondary" }).click();
  await expect(page).toHaveURL(/conversation=conversation-two/u);
  await expect(page.getByText("Secondary conversation message")).toBeVisible();
  await expect(workspaceNode).toHaveAttribute("data-continuity", "kept");
  expect(modelWorkspaceRequests).toBe(requestsBeforeSwitch);

  await page.getByTestId("conversation-toolbar")
    .getByRole("link", { name: "Main", exact: true }).click();
  const activityItems = page.locator(".product-conversation-records li");
  const ordinary = activityItems.filter({
    has: page.getByText("ordinary_note", { exact: true }),
  });
  await expect(ordinary).toHaveCount(1);
  await expect(ordinary.getByText("Applied", { exact: true })).toHaveCount(0);
  const direct = activityItems.filter({
    has: page.getByText("model_files_mutate", { exact: true }),
  });
  await expect(direct).toHaveCount(1);
  await expect(direct.getByText("Applied", { exact: true })).toBeVisible();
  await expect(direct).toContainText(digest("r"));
  expect(browserErrors).toEqual([]);
});

test("arbitrary 0..N generated views do not imply fixed view names", async ({ page }) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto("/models/model-empty?conversation=conversation-empty");
  await expect(page.getByRole("heading", { name: "No generated views" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Generated view" })).toHaveCount(0);

  await page.goto("/models/model-many?conversation=conversation-many");
  await expect(page.getByRole("button", { name: "Supply constellation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Assumption ledger" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Risk topology" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Class diagram|Swimlane|Data flow/iu }))
    .toHaveCount(0);
  await page.getByRole("button", { name: "Supply constellation" }).click();
  await expect(page.getByText("Flexible projection")).toBeVisible();
  await page.getByRole("button", { name: "Assumption ledger" }).click();
  await expect(page.getByText(/"demand": "bounded"/u)).toBeVisible();
  await page.getByRole("button", { name: "Risk topology" }).click();
  await expect(page.getByText("Demand risk", { exact: true }).first()).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("review is capability-driven, suppresses late previews, resolves proposals, and rejects stale sets", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto("/models/model-one?conversation=conversation-one");
  await expect(page.getByTestId("model-workspace")).toBeVisible();

  await page.getByRole("button", { name: "code/slow.py" }).click();
  await expect.poll(() => slowPreviewWaiting).toBe(true);
  await page.getByRole("button", { name: "code/fast.py" }).click();
  await expect(page.getByText("FAST PREVIEW")).toBeVisible();
  releaseSlowPreview?.();
  await expect.poll(() => slowPreviewFulfilled).toBe(true);
  await expect(page.getByText("FAST PREVIEW")).toBeVisible();
  await expect(page.getByText("LATE SLOW PREVIEW")).toHaveCount(0);

  await page.getByRole("button", { name: "Changes · 1" }).click();
  await expect(page.getByRole("region", { name: "Diff for code/model.py" })).toBeVisible();
  await expect(page.getByText("Proposed content")).toBeVisible();
  const beforeApply = modelWorkspaceRequests;
  await page.getByRole("button", { name: "Apply whole change set" }).click();
  await expect(page.locator(".product-review-rail").getByText("Applied", { exact: true }))
    .toBeVisible();
  expect(appliedRequests).toBe(1);
  await expect.poll(() => modelWorkspaceRequests).toBeGreaterThan(beforeApply);
  await expect.poll(() => lastWorkspaceDigestServed)
    .toBe(lastApplyAfterWorkspaceDigest);
  expect(lastApplyAfterWorkspaceDigest).toBe(digest("9"));

  changeState = "pending";
  changeFreshness = "stale";
  modelWorkspaceRevision += 1;
  await page.reload();
  await page.getByRole("button", { name: "Changes · 1" }).click();
  await expect(page.getByText(/proposal is stale and cannot be applied/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply whole change set" })).toBeDisabled();
  await page.getByRole("button", { name: "Reject change set" }).click();
  await expect(page.getByText("Rejected", { exact: true })).toBeVisible();
  expect(rejectedRequests).toBe(1);
  expect(appliedRequests).toBe(1);
  expect(browserErrors).toEqual([]);
});

test("Project planning, active Run, and terminal result stay in one dynamic workspace", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto("/projects/project-one?conversation=project-conversation");
  const workspace = page.getByTestId("project-workspace");
  await expect(workspace).toBeVisible();
  await workspace.evaluate((node) => { node.setAttribute("data-continuity", "kept"); });
  await expect(page.getByText("plan experiment")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Experiments" })).toBeVisible();

  await page.getByRole("button", { name: "Start batch Run" }).click();
  await expect(page.getByText("queued Run", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel Run" })).toBeEnabled();
  projectAdvanceToRunning = true;
  await expect(page.getByText("running Run", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel Run" })).toBeEnabled();
  projectAdvanceToSucceeded = true;
  await expect(page.getByText("succeeded result")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("run_succeeded")).toBeVisible();
  await expect(page.getByRole("table", { name: /Digest-checked outputs/u })).toBeVisible();
  await expect(workspace).toHaveAttribute("data-continuity", "kept");
  expect(projectWorkspaceRequests).toBeGreaterThanOrEqual(3);
  expect(browserErrors).toEqual([]);
});

test("continuous workbench reflows at desktop, narrow width, and 200 percent without page overflow", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto("/models/model-one?conversation=conversation-two");
  await expect(page.getByTestId("model-workspace")).toBeVisible();

  for (const viewport of [{ width: 1440, height: 900 }, { width: 640, height: 900 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width < 960) {
      await page.getByTestId("pane-selector").getByRole("button", { name: "Workspace" }).click();
    }
    const fit = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
  }
  await page.setViewportSize({ width: 720, height: 450 });
  await expect(page.getByTestId("pane-selector")).toBeVisible();
  await page.getByTestId("pane-selector").getByRole("button", { name: "Workspace" }).click();
  const reflowAtTwoHundredPercentEquivalent = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    workspaceVisible: document.querySelector<HTMLElement>(
      "[data-testid='pane-workspace']",
    )?.getBoundingClientRect().width ?? 0,
  }));
  expect(reflowAtTwoHundredPercentEquivalent.scroll)
    .toBeLessThanOrEqual(reflowAtTwoHundredPercentEquivalent.client);
  expect(reflowAtTwoHundredPercentEquivalent.workspaceVisible).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale)).toBe(2);
  const zoomedFit = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    visualWidth: window.visualViewport?.width,
  }));
  expect(zoomedFit.visualWidth).toBeLessThanOrEqual(zoomedFit.client / 1.9);
  expect(zoomedFit.scroll).toBeLessThanOrEqual(zoomedFit.client);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  expect(browserErrors).toEqual([]);
});

async function installProductFixture(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (url.pathname === "/api/browser-session/bootstrap") {
      await json({
        schemaVersion: 1,
        generation: 1,
        csrfToken: "fixture-csrf",
        brokerOrigin: "http://localhost:8788",
        expiresAt: "2026-07-28T01:00:00.000Z",
      }, 201);
      return;
    }
    if (url.pathname === "/api/recovery-status") {
      await json({ state: "ready", observedAt: "2026-07-28T00:00:00.000Z" });
      return;
    }
    if (url.pathname === "/api/providers") {
      await json({
        mode: "live",
        providerModels: [{ providerId: "fixture", modelId: "agent", qualifiedId: "fixture/agent" }],
      });
      return;
    }
    if (url.pathname === "/api/agents") {
      await json({ mode: "live", agents: [{ name: "build", description: "Fixture Agent" }] });
      return;
    }
    if (url.pathname === "/api/models/model-one/workspace") {
      modelWorkspaceRequests += 1;
      const workspaceDigest = modelWorkspaceRevision === 0 ? digest("7") : digest("9");
      lastWorkspaceDigestServed = workspaceDigest;
      await json({
        ...modelWorkspace,
        digest: workspaceDigest,
      });
      return;
    }
    if (url.pathname === "/api/models/model-empty/workspace"
      || url.pathname === "/api/models/model-many/workspace") {
      const modelId = url.pathname.split("/")[3]!;
      await json({
        ...modelWorkspace,
        model: {
          ...modelWorkspace.model,
          id: modelId,
          name: modelId === "model-empty" ? "Empty projection model" : "Many projection model",
        },
        digest: digest(modelId === "model-empty" ? "e" : "f"),
      });
      return;
    }
    if (url.pathname === "/api/models/model-one/generated-views") {
      await json({
        ...generatedViews,
        currentWorkspaceDigest: modelWorkspaceRevision === 0 ? digest("7") : digest("9"),
      });
      return;
    }
    if (url.pathname === "/api/models/model-empty/generated-views") {
      await json({
        sourceWorkspaceDigest: digest("e"),
        currentWorkspaceDigest: digest("e"),
        setDigest: digest("0"),
        freshness: "fresh",
        publishedAt: "2026-07-28T00:00:00.000Z",
        views: [],
      });
      return;
    }
    if (url.pathname === "/api/models/model-many/generated-views") {
      await json({
        sourceWorkspaceDigest: digest("f"),
        currentWorkspaceDigest: digest("f"),
        setDigest: digest("d"),
        freshness: "fresh",
        publishedAt: "2026-07-28T00:00:00.000Z",
        views: [
          generatedView("many-supply", "Supply constellation", 2, "markdown"),
          generatedView("many-assumptions", "Assumption ledger", 1, "json"),
          generatedView("many-risk", "Risk topology", 3, "diagram"),
        ],
      });
      return;
    }
    if (url.pathname.startsWith("/api/models/model-many/generated-views/")
      && url.pathname.endsWith("/renderable")) {
      const id = url.pathname.split("/")[5]!;
      await json(id === "many-risk"
        ? {
            kind: "diagram",
            title: "Risk topology",
            summary: "A generic risk projection.",
            nodes: [{ id: "risk", label: "Demand risk" }],
            edges: [],
          }
        : id === "many-assumptions"
          ? { kind: "json", title: "Assumption ledger", value: { demand: "bounded" } }
          : { kind: "markdown", title: "Supply constellation", text: "Flexible projection" });
      return;
    }
    if (url.pathname === "/api/models/model-one/generated-views/view-source/renderable") {
      await json({ kind: "markdown", title: "Source trail", text: "Source view content" });
      return;
    }
    if (url.pathname === "/api/models/model-one/generated-views/view-operational/renderable") {
      await json({
        kind: "diagram",
        title: "Operational sketch",
        summary: "One optional Agent-generated projection.",
        nodes: [{ id: "input", label: "Input", sourceRefs: ["code/model.py"] }],
        edges: [],
      });
      return;
    }
    if (url.pathname === "/api/models/model-one/change-sets") {
      await json({
        changeSets: [{
          ...modelChangeSet,
          currentWorkspaceDigest: modelWorkspaceRevision === 0 ? digest("7") : digest("9"),
          freshness: changeFreshness,
          state: changeState,
        }],
      });
      return;
    }
    if (url.pathname === "/api/models/model-empty/change-sets"
      || url.pathname === "/api/models/model-many/change-sets") {
      await json({ changeSets: [] });
      return;
    }
    if (url.pathname === "/api/models/model-one/change-sets/change-one/apply") {
      const body = request.postDataJSON();
      expect(body).toMatchObject({
        expectedChangeSetDigest: digest("4"),
        expectedWorkspaceDigest: modelWorkspaceRevision === 0 ? digest("7") : digest("9"),
      });
      appliedRequests += 1;
      changeState = "applied";
      modelWorkspaceRevision += 1;
      lastApplyAfterWorkspaceDigest = digest("9");
      await json({
        schemaVersion: 1,
        commandId: body.commandId,
        operation: "apply",
        modelId: "model-one",
        changeSetId: "change-one",
        changeSetDigest: digest("4"),
        beforeWorkspaceDigest: digest("7"),
        afterWorkspaceDigest: lastApplyAfterWorkspaceDigest,
        files: [],
        committedAt: "2026-07-28T00:00:01.000Z",
        receiptDigest: digest("1"),
      });
      return;
    }
    if (url.pathname === "/api/models/model-one/change-sets/change-one/reject") {
      const body = request.postDataJSON();
      expect(body).toMatchObject({ expectedChangeSetDigest: digest("4") });
      rejectedRequests += 1;
      changeState = "rejected";
      await json({
        schemaVersion: 1,
        commandId: body.commandId,
        operation: "reject",
        modelId: "model-one",
        changeSetId: "change-one",
        changeSetDigest: digest("4"),
        beforeWorkspaceDigest: digest("9"),
        afterWorkspaceDigest: digest("9"),
        files: [],
        committedAt: "2026-07-28T00:00:02.000Z",
        receiptDigest: digest("2"),
      });
      return;
    }
    if (url.pathname === "/api/models/model-one/renderables/file-one") {
      await json({
        kind: "code",
        title: "code/model.py",
        language: "python",
        text: "print('current')",
      });
      return;
    }
    if (url.pathname === "/api/models/model-one/renderables/file-slow") {
      slowPreviewWaiting = true;
      await new Promise<void>((resolve) => { releaseSlowPreview = resolve; });
      await json({
        kind: "code",
        title: "code/slow.py",
        language: "python",
        text: "LATE SLOW PREVIEW",
      });
      slowPreviewFulfilled = true;
      return;
    }
    if (url.pathname === "/api/models/model-one/renderables/file-fast") {
      await json({
        kind: "code",
        title: "code/fast.py",
        language: "python",
        text: "FAST PREVIEW",
      });
      return;
    }
    if (url.pathname.match(/^\/api\/models\/(model-empty|model-many)\/renderables\/file-one$/u)) {
      await json({
        kind: "code",
        title: "code/model.py",
        language: "python",
        text: "print('current')",
      });
      return;
    }
    if (url.pathname === "/api/objects/model/model-one/conversations") {
      await json({ conversations: [conversation, secondaryConversation] });
      return;
    }
    if (url.pathname.startsWith("/api/objects/model/model-")
      && url.pathname.endsWith("/conversations")) {
      const modelId = url.pathname.split("/")[4]!;
      const id = modelId === "model-empty" ? "conversation-empty" : "conversation-many";
      await json({ conversations: [{
        ...conversation,
        id,
        owner: { kind: "model", id: modelId },
      }] });
      return;
    }
    if (url.pathname === "/api/objects/project/project-one/conversations") {
      await json({ conversations: [projectConversation] });
      return;
    }
    if (url.pathname === "/api/conversations/conversation-one") {
      await json(conversation);
      return;
    }
    if (url.pathname === "/api/conversations/conversation-two") {
      await json(secondaryConversation);
      return;
    }
    if (url.pathname === "/api/conversations/conversation-empty"
      || url.pathname === "/api/conversations/conversation-many") {
      const modelId = url.pathname.endsWith("empty") ? "model-empty" : "model-many";
      await json({
        ...conversation,
        id: url.pathname.split("/").at(-1),
        owner: { kind: "model", id: modelId },
      });
      return;
    }
    if (url.pathname === "/api/conversations/project-conversation") {
      await json(projectConversation);
      return;
    }
    if (url.pathname === "/api/conversations/conversation-one/messages") {
      await json({ messages: longMessages });
      return;
    }
    if (url.pathname === "/api/conversations/conversation-two/messages") {
      await json({ messages: [message("secondary-message", 1, "Secondary conversation message")] });
      return;
    }
    if (url.pathname.match(/^\/api\/conversations\/(conversation-empty|conversation-many|project-conversation)\/messages$/u)) {
      await json({ messages: [] });
      return;
    }
    if (url.pathname.match(/^\/api\/conversations\/[^/]+\/attachments$/u)) {
      await json({ attachments: [] });
      return;
    }
    if (url.pathname.match(/^\/api\/conversations\/[^/]+\/documents$/u)) {
      await json({ documents: [] });
      return;
    }
    if (url.pathname === "/api/conversations/conversation-one/actions") {
      await json({
        skillUses: [],
        actions: [{
          id: "ordinary-action",
          actionKind: "ordinary_note",
          permissionDecision: "allowed",
          state: "committed",
          errorCode: null,
        }, {
          id: "direct-action",
          actionKind: "model_files_mutate",
          permissionDecision: "allowed",
          state: "committed",
          errorCode: null,
          mutationReceipt: {
            operation: "direct_apply",
            receiptDigest: digest("r"),
            beforeWorkspaceDigest: digest("7"),
            afterWorkspaceDigest: digest("9"),
            committedAt: "2026-07-28T00:00:00.000Z",
            files: [{
              relativePath: "code/model.py",
              priorSha256: digest("8"),
              proposedSha256: digest("3"),
            }],
          },
        }],
      });
      return;
    }
    if (url.pathname.match(/^\/api\/conversations\/[^/]+\/actions$/u)) {
      await json({ skillUses: [], actions: [] });
      return;
    }
    if (url.pathname.match(/^\/api\/conversations\/[^/]+\/runtime$/u)) {
      await json({
        schemaVersion: 1,
        revision: "fixture-runtime",
        status: "idle",
        activeTurn: null,
        parts: [],
        pendingInteractions: [],
        goalVerification: null,
        agent: { selectedName: "build", locked: true },
        mcp: { state: "connected", label: "Riff tools" },
      });
      return;
    }
    if (url.pathname.match(/^\/api\/conversations\/[^/]+\/runtime\/events$/u)) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": fixture stream\n\n",
      });
      return;
    }
    if (url.pathname === "/api/projects/project-one/workspace") {
      projectWorkspaceRequests += 1;
      if (projectPhase === "queued" && projectAdvanceToRunning) projectPhase = "running";
      else if (projectPhase === "running" && projectAdvanceToSucceeded) {
        projectPhase = "succeeded";
      }
      await json(projectWorkspace(projectPhase));
      return;
    }
    if (url.pathname === "/api/projects/project-one/runs" && request.method() === "POST") {
      projectPhase = "queued";
      await json({
        runId: "run-new",
        status: "queued",
        runKind: "batch",
        sampleCount: 1,
      }, 201);
      return;
    }
    if (url.pathname === "/api/projects/project-one/files/project-file/renderable") {
      await json({ kind: "code", title: "code/model.py", language: "python", text: "project" });
      return;
    }
    await json({ error: { code: "fixture_route_missing", message: url.pathname } }, 404);
  });
}

const conversation = {
  id: "conversation-one",
  owner: { kind: "model", id: "model-one" },
  name: "Main",
  lifecycleState: "active",
  recordDigest: digest("c"),
  provider: { providerId: "fixture", modelId: "agent", locked: false },
  sessionState: "none",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

const execution = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: { type: "object", additionalProperties: false, properties: {} },
    smoke: {},
  },
  outputs: [],
  batch: { entryPoint: "code/model.py", protocol: "riff-batch-v1" },
  cancellation: { signal: "SIGTERM", graceMs: 500 },
};

const modelWorkspace = {
  model: {
    id: "model-one",
    name: "Fixture model",
    technicalStatus: "executable",
  },
  digest: digest("7"),
  execution,
  files: [{
    id: "file-one",
    relativePath: "code/model.py",
    mediaType: "text/x-python",
    sizeBytes: 18,
    sha256: digest("8"),
  }, {
    id: "file-slow",
    relativePath: "code/slow.py",
    mediaType: "text/x-python",
    sizeBytes: 20,
    sha256: digest("5"),
  }, {
    id: "file-fast",
    relativePath: "code/fast.py",
    mediaType: "text/x-python",
    sizeBytes: 20,
    sha256: digest("6"),
  }],
};

const generatedViews = {
  sourceWorkspaceDigest: digest("6"),
  currentWorkspaceDigest: digest("7"),
  setDigest: digest("5"),
  freshness: "stale",
  publishedAt: "2026-07-28T00:00:00.000Z",
  views: [{
    id: "view-source",
    title: "Source trail",
    position: 2,
    rendererKind: "markdown",
    mediaType: "text/markdown",
    payloadDigest: digest("a"),
    sourceFileRefs: ["code/model.py"],
  }, {
    id: "view-operational",
    title: "Operational sketch",
    position: 1,
    rendererKind: "diagram",
    mediaType: "application/vnd.riff.diagram+json",
    payloadDigest: digest("b"),
    sourceFileRefs: ["code/model.py"],
  }],
};

const modelChangeSet = {
  id: "change-one",
  baseWorkspaceDigest: digest("6"),
  currentWorkspaceDigest: digest("7"),
  changeSetDigest: digest("4"),
  freshness: "fresh",
  state: "pending",
  createdAt: "2026-07-28T00:00:00.000Z",
  resolvedAt: null,
  files: [{
    itemId: "item-one",
    kind: "modify",
    relativePath: "code/model.py",
    mediaType: "text/x-python",
    priorSha256: digest("8"),
    proposedSha256: digest("3"),
    proposedText: "print('proposed')",
  }],
};

const secondaryConversation = {
  ...conversation,
  id: "conversation-two",
  name: "Secondary",
  recordDigest: digest("d"),
};

const projectConversation = {
  ...conversation,
  id: "project-conversation",
  owner: { kind: "project", id: "project-one" },
  name: "Project discussion",
  recordDigest: digest("p"),
};

const message = (id: string, ordinal: number, text: string) => ({
  id,
  ordinal,
  role: ordinal % 2 === 0 ? "assistant" : "user",
  status: "complete",
  messageKind: "conversation",
  text,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
});

const longMessages = Array.from({ length: 501 }, (_, index) =>
  message(`message-${index}`, index, `Message ${index}`));

const generatedView = (
  id: string,
  title: string,
  position: number,
  rendererKind: string,
) => ({
  id,
  title,
  position,
  rendererKind,
  mediaType: rendererKind === "diagram"
    ? "application/vnd.riff.diagram+json"
    : rendererKind === "json"
      ? "application/json"
      : "text/markdown",
  payloadDigest: digest(String(position)),
  sourceFileRefs: [],
});

const projectWorkspace = (
  phase: "planning" | "queued" | "running" | "succeeded",
) => ({
  project: {
    id: "project-one",
    name: "Continuous study",
    lifecycleState: "active",
    sourceModelId: "model-one",
    modelSnapshotDigest: digest("a"),
  },
  execution,
  executionDescriptionDigest: digest("b"),
  files: [{
    fileRef: "project-file",
    relativePath: "code/model.py",
    mediaType: "text/x-python",
    sizeBytes: 18,
    sha256: digest("8"),
    createdAt: "2026-07-28T00:00:00.000Z",
    readOnly: true,
  }],
  conversations: [projectConversation],
  experimentConfigurations: [{
    id: "experiment-one",
    projectId: "project-one",
    name: "Deterministic run",
    configuration: {
      schemaVersion: 1,
      runKind: "batch",
      parameters: {},
      sampling: { kind: "single", seed: 7 },
    },
    estimatedSampleCount: 1,
    lifecycleState: "active",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    contractVersion: 4,
    readOnly: false,
    legacyDigest: null,
    configurationDigest: digest("c"),
    sampleCount: 1,
    recordDigest: digest("d"),
    samplePreview: [{
      sampleIndex: 0,
      sampleId: digest("e"),
      parameters: {},
      seed: 7,
    }],
    samplePreviewTruncated: false,
  }],
  runs: phase === "planning" ? [] : [{
    id: "run-new",
    projectId: "project-one",
    experimentConfigurationId: "experiment-one",
    status: phase,
    requestedSampleCount: 1,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:01.000Z",
    startedAt: phase === "queued" ? null : "2026-07-28T00:00:00.500Z",
    finishedAt: phase === "succeeded" ? "2026-07-28T00:00:01.000Z" : null,
    contractVersion: 4,
    readOnly: false,
    legacyDigest: null,
    runKind: "batch",
    cancelRequestedAt: null,
    terminalCode: phase === "succeeded" ? "run_succeeded" : null,
    completionCardDisposition: "not_requested",
    terminalStatus: phase === "succeeded" ? "succeeded" : null,
    terminalClosureDigest: phase === "succeeded" ? digest("f") : null,
    lifecycleDigest: digest("1"),
    seedCount: 1,
    stepOrHorizon: 30,
    durationMs: phase === "succeeded" ? 500 : null,
    resourceOverview: phase === "succeeded" ? { outputFiles: 1 } : null,
    outputs: phase === "succeeded" ? [{
      id: "output-one",
      runId: "run-new",
      logicalName: "summary",
      outputType: "json",
      sampleIndex: 0,
      sampleId: digest("e"),
      declaredRole: "data",
      mediaType: "application/json",
      sizeBytes: 20,
      sha256: digest("2"),
      createdAt: "2026-07-28T00:00:01.000Z",
    }] : [],
  }],
});

const visibleExactTextCount = (page: Page, text: string) =>
  page.getByText(text, { exact: true }).evaluateAll((elements) =>
    elements.filter((element) => {
      const style = getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0;
    }).length);

const watchBrowserErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  return errors;
};
