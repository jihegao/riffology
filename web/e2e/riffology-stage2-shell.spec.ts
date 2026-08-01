import { expect, test } from "@playwright/test";

test("Riffology Stage 2 shell keeps project and conversation actions distinct", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  const projectHref = await page.getByRole("link", { name: "Open Project" }).first()
    .getAttribute("href");
  expect(projectHref).toMatch(/^\/projects\//u);
  await page.goto(`/workbench${projectHref}`);

  await expect(page.getByRole("banner")).toContainText("Riffology");
  await expect(page.getByRole("button", { name: "新项目" })).toBeVisible();
  await expect(page.getByRole("button", { name: "＋ 新会话" })).toBeDisabled();
  await expect(page.getByRole("complementary", { name: "项目对话" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "浏览器导航" })).toBeVisible();
  await expect(page.getByLabel("页面地址")).toContainText("riff://project/");
  await expect(page.getByText("OpenCode 1.18.11")).toBeVisible();
  await expect(page.getByRole("region", { name: "项目文件与页面查看器" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "项目文件" })).toBeVisible();
  await expect(page.getByText("No active Conversations yet.")).toBeVisible();
  await expect(page.getByText(/从最右侧文件栏选择/u)).toBeVisible();
  await expect(page.getByText("Terminal", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Share", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Tunnel", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Git", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/provider secret/u)).toHaveCount(0);
  await expect(page.getByText(/edit file|upload file/u)).toHaveCount(0);
  const forbiddenFocusable = await page.locator(
    "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
  ).evaluateAll((elements) => elements.filter((element) =>
    /terminal|share|tunnel|provider secret|edit file|upload file|\bgit\b/iu.test(
      `${element.textContent ?? ""} ${element.getAttribute("aria-label") ?? ""}`,
    )).length);
  expect(forbiddenFocusable).toBe(0);

  const desktop = await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>(".riffology-project-rail")!;
    const chat = document.querySelector<HTMLElement>(".riffology-chat-pane")!;
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      railWidth: Math.round(rail.getBoundingClientRect().width),
      chatWidth: Math.round(chat.getBoundingClientRect().width),
      chatBottom: Math.round(chat.getBoundingClientRect().bottom),
      viewportHeight: window.innerHeight,
    };
  });
  expect(desktop.scrollWidth).toBeLessThanOrEqual(desktop.clientWidth);
  expect(desktop.railWidth).toBe(74);
  expect(desktop.chatWidth).toBe(472);
  expect(desktop.chatBottom).toBeLessThanOrEqual(desktop.viewportHeight);
  const fileRail = await page.locator(".riffology-file-rail").boundingBox();
  expect(fileRail?.width).toBe(224);
  await page.screenshot({ path: testInfo.outputPath("riffology-stage2-1800x1180.png") });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  const scaled = await page.evaluate(() => ({
    scale: window.visualViewport?.scale,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    railVisible: document.querySelector<HTMLElement>(".riffology-project-rail")!
      .getBoundingClientRect().width > 0,
    chatVisible: document.querySelector<HTMLElement>(".riffology-chat-pane")!
      .getBoundingClientRect().width > 0,
  }));
  expect(scaled.scale).toBe(2);
  expect(scaled.scrollWidth).toBeLessThanOrEqual(scaled.clientWidth);
  expect(scaled.railVisible).toBe(true);
  expect(scaled.chatVisible).toBe(true);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });

  await page.getByRole("button", { name: "新项目" }).click();
  await expect(page).toHaveURL(/\/workbench\/new\/[a-f0-9-]+$/u);
  await page.getByRole("textbox", { name: "项目目标" }).fill("比较维修队列资源配置");
  await page.getByRole("button", { name: "保存引导草稿" }).click();
  await expect(page.getByRole("log", { name: "Agent 项目引导" })
    .getByText("比较维修队列资源配置", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "项目目标" }))
    .toHaveValue("比较维修队列资源配置");
  await expect(page.getByText(/不是 Riff Model \/ Project 权威数据/u)).toBeVisible();
  const firstUnboundUrl = page.url();
  await page.getByRole("button", { name: "新项目" }).click();
  await expect(page).not.toHaveURL(firstUnboundUrl);
  await expect(page.getByRole("textbox", { name: "项目目标" })).toHaveValue("");
  await page.goBack();
  await expect(page).toHaveURL(firstUnboundUrl);
  await expect(page.getByRole("textbox", { name: "项目目标" }))
    .toHaveValue("比较维修队列资源配置");

  // Reflow at the effective CSS viewport complements the real page-scale check above.
  await page.setViewportSize({ width: 720, height: 450 });
  const reflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    chatBottom: Math.round(document.querySelector<HTMLElement>(
      ".riffology-chat-pane",
    )!.getBoundingClientRect().bottom),
    viewportHeight: window.innerHeight,
  }));
  expect(reflow.scrollWidth).toBeLessThanOrEqual(reflow.clientWidth);
  expect(reflow.chatBottom).toBeLessThanOrEqual(reflow.viewportHeight);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("complementary", { name: "新项目引导" })).toBeVisible();
  await expect(page.getByRole("region", { name: "未绑定项目状态" })).toBeHidden();
  const mobile = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
    composerBottom: Math.round(document.querySelector<HTMLElement>(
      ".riffology-unbound-composer",
    )!.getBoundingClientRect().bottom),
  }));
  expect(mobile.scrollWidth).toBeLessThanOrEqual(mobile.clientWidth);
  expect(mobile.scrollHeight).toBeLessThanOrEqual(mobile.clientHeight);
  expect(mobile.composerBottom).toBeLessThanOrEqual(mobile.clientHeight);
  await page.screenshot({ path: testInfo.outputPath("riffology-stage2-390x844.png") });

  expect(errors).toEqual([]);
});
