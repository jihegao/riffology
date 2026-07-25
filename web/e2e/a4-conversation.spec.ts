import { expect, test } from "@playwright/test";

test("A4-3 Conversations persist independently and fail read-only without fabricated replies", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const responseBodies: string[] = [];
  const pendingResponses = new Set<Promise<void>>();
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (!response.url().includes("/api/")) return;
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
  await expect(page.getByText("Assistant (fixture/model-b) retained: Remember alpha")).toBeVisible();
  await expect(page.getByText("locked after the first accepted message", { exact: false })).toBeVisible();

  await createConversation(page, "Analysis B");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Remember beta");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Assistant (fixture/model-a) retained: Remember beta")).toBeVisible();
  await createConversation(page, "Disposable C");

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
  await expect(page.getByText(
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
  expect(errors).toEqual([]);
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
