import { expect, test } from "@playwright/test";

test("A4-2 Home and shared shell remain truthful, responsive, and state-stable", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New Model" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New Project" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#product-main")).toBeFocused();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("a4-2-home-desktop.png") });
  await expect(page.getByText("OpenCode is unavailable", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "New Model" }).click();
  await expect(page.getByText("OpenCode is unavailable", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Model" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel" }).click();

  const modelLink = page.getByRole("link", { name: "Open Model" }).first();
  await expect(modelLink).toBeVisible();
  await modelLink.click();
  await expect(page.getByTestId("shell-owner-heading")).not.toHaveText("Loading workspace…");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("pane-conversation")).toBeVisible();
  await expect(page.getByTestId("pane-workspace")).toBeVisible();
  await expect(page.getByTestId("workspace-owner-card")).toContainText(
    "Technically executable",
  );
  const ownerCard = await page.getByTestId("workspace-owner-card").elementHandle();
  expect(ownerCard).not.toBeNull();
  await page.evaluate(() => {
    history.pushState({}, "", `${location.pathname}?conversation=not-yet-created`);
    window.dispatchEvent(new Event("riff:product-navigation"));
  });
  await expect(page.getByRole("alert")).toContainText("does not belong to this workspace");
  expect(await ownerCard!.evaluate((node) => node.isConnected)).toBe(true);
  const currentOwnerCard = await page.getByTestId("workspace-owner-card").elementHandle();
  expect(currentOwnerCard).not.toBeNull();
  expect(await ownerCard!.evaluate((node, current) => node === current, currentOwnerCard)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("a4-2-model-shell-desktop.png") });

  await page.getByRole("link", { name: "Home" }).click();
  await page.getByRole("link", { name: "Open Project" }).first().click();
  await expect(page).toHaveURL(/\/projects\/[^/?]+$/u);
  await expect(page.getByTestId("shell-owner-heading")).not.toHaveText("Loading workspace…");
  await expect(page.getByTestId("pane-conversation")).toBeVisible();
  await expect(page.getByTestId("pane-workspace")).toBeVisible();
  await expect(page.getByTestId("workspace-owner-card")).toContainText("fixed copy");

  await page.getByRole("heading", { name: "Workspace", exact: true }).focus();
  await page.setViewportSize({ width: 640, height: 900 });
  const selector = page.getByTestId("pane-selector");
  await expect(selector).toBeVisible();
  await expect(selector.getByRole("button", { name: "Conversation" })).toBeFocused();
  await expect(page.getByTestId("pane-conversation")).toBeVisible();
  await expect(page.getByTestId("pane-workspace")).toBeHidden();
  await page.getByRole("button", { name: "Workspace" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("pane-conversation")).toBeHidden();
  await expect(page.getByTestId("pane-workspace")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Workspace", exact: true })).toBeFocused();
  await selector.getByRole("button", { name: "Conversation" }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("pane-conversation")).toBeVisible();
  await expect(page.getByTestId("pane-workspace")).toBeHidden();
  await page.getByRole("button", { name: "Workspace" }).click();

  await page.setViewportSize({ width: 720, height: 450 });
  await expect(selector).toBeVisible();
  const fit = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowing: Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((element) => ({
        name: element.tagName.toLowerCase(),
        className: element.className,
        right: Math.round(element.getBoundingClientRect().right),
        width: Math.round(element.getBoundingClientRect().width),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      .filter((element) => element.right > document.documentElement.clientWidth + 1
        || element.scrollWidth > element.clientWidth + 1)
      .slice(0, 8),
  }));
  expect(fit.scrollWidth, JSON.stringify(fit)).toBeLessThanOrEqual(fit.clientWidth);

  await page.screenshot({ path: testInfo.outputPath("a4-2-home-shell.png"), fullPage: true });
  expect(errors).toEqual([]);
});
