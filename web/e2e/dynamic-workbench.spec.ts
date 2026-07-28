import { expect, test, type Page } from "@playwright/test";

const digest = (character: string) => character.repeat(64);
let changeState: "pending" | "applied" = "pending";

test.beforeEach(async ({ page }) => {
  changeState = "pending";
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
  await expect(page.getByRole("heading", { name: "Fixture model" })).toHaveCount(1);
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
      await json(modelWorkspace);
      return;
    }
    if (url.pathname === "/api/models/model-one/generated-views") {
      await json(generatedViews);
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
      await json({ changeSets: [{ ...modelChangeSet, state: changeState }] });
      return;
    }
    if (url.pathname === "/api/models/model-one/change-sets/change-one/apply") {
      const body = request.postDataJSON();
      expect(body).toMatchObject({
        expectedChangeSetDigest: digest("4"),
        expectedWorkspaceDigest: digest("7"),
      });
      changeState = "applied";
      await json({
        schemaVersion: 1,
        commandId: body.commandId,
        operation: "apply",
        modelId: "model-one",
        changeSetId: "change-one",
        changeSetDigest: digest("4"),
        beforeWorkspaceDigest: digest("7"),
        afterWorkspaceDigest: digest("2"),
        files: [],
        committedAt: "2026-07-28T00:00:01.000Z",
        receiptDigest: digest("1"),
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
    if (url.pathname === "/api/objects/model/model-one/conversations") {
      await json({ conversations: [conversation] });
      return;
    }
    if (url.pathname === "/api/conversations/conversation-one") {
      await json(conversation);
      return;
    }
    if (url.pathname === "/api/conversations/conversation-one/messages") {
      await json({ messages: [] });
      return;
    }
    if (url.pathname === "/api/conversations/conversation-one/attachments") {
      await json({ attachments: [] });
      return;
    }
    if (url.pathname === "/api/conversations/conversation-one/documents") {
      await json({ documents: [] });
      return;
    }
    if (url.pathname === "/api/conversations/conversation-one/actions") {
      await json({ skillUses: [], actions: [] });
      return;
    }
    if (url.pathname === "/api/conversations/conversation-one/runtime") {
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
    if (url.pathname === "/api/conversations/conversation-one/runtime/events") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": fixture stream\n\n",
      });
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
