import { expect, test } from "@playwright/test";

test("Riffology Stage 4 projects a real isolated Chromium observation", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  const projectHref = await page.getByRole("link", { name: "Open Project" }).first().getAttribute("href");
  expect(projectHref).toMatch(/^\/projects\//u);
  await page.goto(`/workbench${projectHref}`);

  await expect(page.getByLabel("页面地址")).toHaveText("riff-app://projects/stage4", {
    timeout: 15_000,
  });
  await expect(page.getByLabel("受信状态")).toHaveText("受信 Riff");
  await expect(page.getByRole("button", { name: "刷新" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "前进" })).toBeDisabled();
  const observation = page.getByRole("img", { name: /受信浏览器页面观察/u });
  await expect(observation).toBeVisible();
  const generationStatus = page.getByText(/只读 Chromium 观察 · 页面 generation \d+/u);
  await expect(generationStatus).toBeVisible();
  const initialMatch = (await generationStatus.textContent())?.match(/generation (\d+)/u);
  expect(initialMatch).toBeTruthy();
  const initialGeneration = Number(initialMatch![1]);
  expect(Number.isSafeInteger(initialGeneration)).toBe(true);

  await page.getByRole("button", { name: "刷新" }).click();
  await expect(generationStatus).toContainText(`generation ${initialGeneration + 1}`);
  await expect(page.getByRole("button", { name: "后退" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /click|type/iu })).toHaveCount(0);
  expect(errors).toEqual([]);
});
