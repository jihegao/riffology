import { expect, test } from "@playwright/test";

test("A4-3 Conversations persist independently and fail read-only without fabricated replies", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const responseBodies: string[] = [];
  const optionalProjection404s: string[] = [];
  const pendingResponses = new Set<Promise<void>>();
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (!response.url().includes("/api/")) return;
    if (/\/api\/conversations\/[^/]+\/runtime\/events$/u.test(
      new URL(response.url()).pathname,
    )) return;
    if (response.status() === 404
      && /\/api\/(?:agents|conversations\/[^/]+\/runtime)$/u.test(new URL(response.url()).pathname)) {
      optionalProjection404s.push(response.url());
    }
    const pending = response.text()
      .then((body) => { responseBodies.push(body); })
      .catch(() => undefined)
      .finally(() => { pendingResponses.delete(pending); });
    pendingResponses.add(pending);
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Open Model" }).first().click();
  await expect(page.getByTestId("shell-owner-heading")).not.toHaveText("Loading workspace…");
  const ownerCard = await page.getByTestId("workspace-owner-card").elementHandle();
  expect(ownerCard).not.toBeNull();

  await createConversation(page, "Analysis A");
  await page.getByLabel("Change provider / model before the first message")
    .selectOption("fixture/model-b");
  await page.getByRole("button", { name: "Update provider" }).click();
  await expect(page.getByLabel("Change provider / model before the first message"))
    .toHaveValue("fixture/model-b");
  await page.getByLabel("File", { exact: true }).setInputFiles({
    name: "samples.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"sample":"alpha"}'),
  });
  await page.getByLabel("Purpose").fill("Acceptance input");
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.locator("section").filter({
    has: page.getByRole("heading", { name: "Attachments" }),
  }).getByText("samples.json", { exact: true })).toBeVisible();
  await page.getByRole("group", { name: "Attach to this message" })
    .getByLabel("samples.json").check();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Remember alpha");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByLabel("Conversation messages")
    .getByText("Assistant (fixture/model-b) retained: Remember alpha")).toBeVisible();
  await expect(page.getByText("locked after the first accepted message", { exact: false })).toBeVisible();

  await createConversation(page, "Analysis B");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Remember beta");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByLabel("Conversation messages")
    .getByText("Assistant (fixture/model-a) retained: Remember beta")).toBeVisible();
  await createConversation(page, "Disposable C");
  await expect(page.getByRole("navigation", { name: "Conversations" })
    .getByRole("link")).toHaveCount(3);
  await page.setViewportSize({ width: 640, height: 450 });
  await page.getByTestId("pane-selector")
    .getByRole("button", { name: "Conversation" }).click();
  const compactFit = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".product-conversation-pane")!;
    const middle = document.querySelector<HTMLElement>(
      ".product-conversation-scroll-region",
    )!;
    const dock = document.querySelector<HTMLElement>(".product-composer-dock")!;
    const paneRect = pane.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    return {
      paneBottom: paneRect.bottom,
      dockBottom: dockRect.bottom,
      middleClientHeight: middle.clientHeight,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(compactFit.dockBottom).toBeLessThanOrEqual(compactFit.paneBottom + 1);
  expect(compactFit.middleClientHeight).toBeGreaterThan(0);
  expect(compactFit.scrollWidth).toBeLessThanOrEqual(compactFit.clientWidth);
  const compactMessage = page.getByRole("textbox", { name: "Message", exact: true });
  const compactSend = page.getByRole("button", { name: "Send" });
  await expect(compactMessage).toBeEnabled();
  await compactMessage.focus();
  await expect(compactMessage).toBeFocused();
  await compactMessage.fill("Short viewport draft");
  await expect(compactSend).toBeEnabled();
  await compactSend.focus();
  await expect(compactSend).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("a4-3-conversation-short-active.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("link", { name: "Analysis A" }).click();
  await expect(page.getByText("Remember alpha", { exact: true })).toBeVisible();
  await expect(page.locator("section").filter({
    has: page.getByRole("heading", { name: "Attachments" }),
  }).getByText("samples.json", { exact: true })).toBeVisible();
  expect(await ownerCard!.evaluate((node) => node.isConnected)).toBe(true);
  const currentOwnerCard = await page.getByTestId("workspace-owner-card").elementHandle();
  expect(await ownerCard!.evaluate((node, current) => node === current, currentOwnerCard)).toBe(true);

  await page.getByText("Manage Conversation").click();
  const rename = page.getByLabel("Conversation name");
  await rename.fill("Analysis Alpha");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("link", { name: "Analysis Alpha" })).toBeVisible();
  await page.getByRole("button", { name: "Archive" }).click();
  await expect.poll(() => conversationNavigationHasFocus(page)).toBe(true);
  await page.getByText(/^Archived \(1\)$/u).click();
  await expect(page.getByText("Analysis Alpha", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("link", { name: "Analysis Alpha" })).toBeVisible();

  await page.getByRole("link", { name: "Disposable C" }).click();
  await page.getByText("Manage Conversation").click();
  await page.getByRole("button", { name: "Move to trash" }).click();
  await page.getByText(/^Trash \(1\)$/u).click();
  await page.getByRole("button", { name: "Preview permanent delete" }).click();
  await expect(page.getByText("This preview is not a deletion.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Type “Disposable C” to confirm")).toBeFocused();
  const permanentDelete = page.getByRole("button", {
    name: "Permanently delete Conversation",
  });
  await expect(permanentDelete).toBeDisabled();
  await page.getByLabel("Type “Disposable C” to confirm").fill("Disposable C");
  await permanentDelete.click();
  await expect(page.getByText(/^Trash \(/u)).toHaveCount(0);
  await expect.poll(() => conversationNavigationHasFocus(page)).toBe(true);

  await page.getByRole("link", { name: "Analysis B" }).click();
  await expect(page.getByText("Remember beta", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Analysis Alpha" }).click();
  await expect(page.getByLabel("Conversation messages").getByText(
    "Assistant (fixture/model-b) retained: Remember alpha",
  )).toBeVisible();
  const assistantCount = await page.getByText(/^Assistant$/u).count();
  const messageBox = page.getByRole("textbox", { name: "Message", exact: true });
  await messageBox.fill("[fixture:provider-unavailable]");
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText("[fixture:provider-unavailable]", { exact: true })).toBeVisible();
  await expect(page.getByText("Agent: read only", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Assistant$/u)).toHaveCount(assistantCount);
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await page.getByText("Manage Conversation").click();
  await expect(page.getByRole("button", { name: "Archive" })).toBeEnabled();

  await page.setViewportSize({ width: 640, height: 900 });
  await page.getByTestId("pane-selector")
    .getByRole("button", { name: "Conversation" }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("pane-conversation")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("a4-3-conversation-narrow.png"),
    fullPage: true,
  });
  const fit = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);

  await Promise.all([...pendingResponses]);
  const publicEvidence = responseBodies.join("\n");
  for (const forbidden of [
    "fixture-session-",
    "objectFileId",
    "externalSessionRef",
    "rawToolPayload",
    "/private/",
    "/Users/",
  ]) {
    expect(publicEvidence, forbidden).not.toContain(forbidden);
  }
  let optional404ConsoleBudget = optionalProjection404s.length;
  const relevantErrors = errors.filter((message) => {
    if (optional404ConsoleBudget > 0
      && message === "Failed to load resource: the server responded with a status of 404 (Not Found)") {
      optional404ConsoleBudget -= 1;
      return false;
    }
    return true;
  });
  expect(relevantErrors).toEqual([]);
});

test("PR3 projects sanitized native Agent activity and structured waiting-user controls", async ({
  page,
}, testInfo) => {
  const submitted: Array<{ url: string; body: unknown }> = [];
  const chartChoice = `choice_${"a".repeat(32)}`;
  const tableChoice = `choice_${"b".repeat(32)}`;
  const publicResponseBodies: Promise<string>[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!/\/api\/conversations\/[^/]+\/turns\/[^/]+\/(?:resume|stop|retry)$/u
      .test(path)) return;
    submitted.push({
      url: path,
      body: request.postDataJSON(),
    });
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path === "/api/agents"
      || /\/api\/conversations\/[^/]+\/runtime$/u.test(path)) {
      publicResponseBodies.push(response.text());
    }
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Open Model" }).first().click();
  await createConversation(page, "Native Agent controls");
  await page.getByLabel("Agent for this turn").selectOption("planner");
  await page.getByRole("textbox", { name: "Message", exact: true })
    .fill("[fixture:native-controls]");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Agent: waiting for user")).toBeVisible();
  await expect(page.getByText("Riff inspect workspace")).toBeVisible();
  await expect(page.getByText("Workspace inspected")).toBeVisible();
  await expect(page.getByText("MCP: Riff tools")).toBeVisible();
  await expect(page.getByLabel("Agent for this turn")).toBeDisabled();
  await page.getByRole("region", { name: "Agent runtime controls" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("pr3-native-agent-controls-desktop.png"),
    fullPage: false,
  });

  await page.getByRole("button", { name: "Allow once & Resume" }).click();
  await page.getByRole("checkbox", { name: "Chart" }).check();
  await page.getByRole("checkbox", { name: "Table" }).check();
  await page.getByRole("textbox", { name: "Answer 2" }).fill("Keep labels concise.");
  await page.getByRole("button", { name: "Send answers & Resume" }).click();
  await expect(page.getByLabel("Conversation messages").getByText(
    "Native controls completed through the real Product API.",
  )).toBeVisible();

  await page.getByRole("textbox", { name: "Message", exact: true })
    .fill("[fixture:stop-and-retry]");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Agent: busy")).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Agent: failed")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Conversation messages").getByText(
    "Retry completed through the durable original intent.",
  )).toBeVisible();

  await expect.poll(() => submitted.length).toBe(4);
  expect(submitted[0].body).toMatchObject({
    interactionId: "permission_public_model_update",
    kind: "permission",
    decision: "once",
  });
  expect(submitted[1].body).toMatchObject({
    interactionId: "question_public_output_details",
    kind: "question",
    answers: [[chartChoice, tableChoice], ["Keep labels concise."]],
  });
  expect(submitted[2].url).toMatch(/\/stop$/u);
  expect(submitted[3].url).toMatch(/\/retry$/u);
  expect(submitted[3].body).toMatchObject({ requestKey: expect.any(String) });
  expect(JSON.stringify(submitted)).not.toContain("sessionID");
  expect(JSON.stringify(submitted)).not.toContain("capability");
  const publicEvidence = (await Promise.all(publicResponseBodies)).join("\n");
  for (const forbidden of [
    "fixture-session-",
    "externalSessionRef",
    "sessionID",
    "capability",
    "/Users/",
    "/private/",
  ]) {
    expect(publicEvidence, forbidden).not.toContain(forbidden);
  }

  await page.setViewportSize({ width: 640, height: 900 });
  await page.getByTestId("pane-selector").getByRole("button", { name: "Conversation" }).click();
  await expect(page.getByTestId("pane-conversation")).toBeVisible();
  const fit = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
  await page.screenshot({
    path: testInfo.outputPath("pr3-native-agent-controls-narrow.png"),
    fullPage: false,
  });
});

const createConversation = async (
  page: import("@playwright/test").Page,
  name: string,
): Promise<void> => {
  await page.getByRole("button", { name: "New Conversation" }).click();
  await page.locator("form").filter({ hasText: "New Conversation" })
    .getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
};

const conversationNavigationHasFocus = async (
  page: import("@playwright/test").Page,
): Promise<boolean> => page.evaluate(() => {
  const active = document.activeElement;
  return Boolean(active?.matches(
    ".product-conversation-list a, .product-new-conversation",
  ));
});
