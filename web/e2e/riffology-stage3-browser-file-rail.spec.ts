import { expect, test } from "@playwright/test";

test("Riffology Stage 3 keeps one viewer and a far-right accessible file tree", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  const projectHref = await page.getByRole("link", { name: "Open Project" }).first().getAttribute("href");
  expect(projectHref).toMatch(/^\/projects\//u);
  await page.goto(`/workbench${projectHref}`);

  await expect(page.getByRole("navigation", { name: "浏览器导航" })).toBeVisible();
  await expect(page.getByLabel("页面地址")).toContainText("riff://project/");
  await expect(page.getByLabel("受信状态")).toHaveText("受信 Riff");
  await expect(page.getByText("OpenCode 1.18.11")).toBeVisible();
  await expect(page.getByRole("button", { name: "后退" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "前进" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "刷新" })).toBeDisabled();

  const rail = page.getByRole("complementary", { name: "项目文件" });
  const viewer = page.getByRole("region", { name: "项目文件与页面查看器" });
  await expect(rail).toBeVisible();
  await expect(viewer).toBeVisible();
  await expect(rail.getByText("项目结构 · 只读投影")).toBeVisible();
  const firstFile = rail.locator(".riffology-file-entry button").first();
  await expect(firstFile).toBeVisible();
  const displayedPaths = await rail.locator(".riffology-file-entry span").allTextContents();
  expect(displayedPaths.join("\n")).not.toMatch(/\/Users\/|\/private\/|\.\.|\\/u);

  const desktop = await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>(".riffology-file-rail")!.getBoundingClientRect();
    return {
      railRight: Math.round(target.right),
      viewportWidth: innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      viewerCount: document.querySelectorAll(".riffology-stage3-viewer").length,
      nestedBrowserChrome: document.querySelectorAll(".riffology-stage3-viewer .riffology-browser-navigation").length,
    };
  });
  expect(desktop.railRight).toBe(desktop.viewportWidth);
  expect(desktop.scrollWidth).toBeLessThanOrEqual(desktop.clientWidth);
  expect(desktop.viewerCount).toBe(1);
  expect(desktop.nestedBrowserChrome).toBe(0);

  const separator = page.getByRole("separator", { name: "调整文件栏宽度" });
  await separator.focus();
  await page.keyboard.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "520");
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "224");
  await page.keyboard.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "240");
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "224");

  await firstFile.click();
  await expect(viewer.locator(".riffology-viewer-header strong")).not.toBeEmpty();
  await expect(viewer.locator(".product-renderer")).toBeVisible();
  await expect(page).toHaveScreenshot("riffology-stage3-svg-aligned-stable-regions.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
    mask: [
      page.locator(".product-agent-status"),
      page.locator(".product-conversation-scroll-region"),
      viewer.locator(".product-renderer"),
    ],
  });
  await page.screenshot({ path: testInfo.outputPath("riffology-stage3-1800x1180.png") });

  await page.getByRole("button", { name: "收起文件栏" }).click();
  await expect(page.getByRole("button", { name: "文件 ↗" })).toHaveAttribute("aria-expanded", "false");
  await expect(rail).toBeHidden();
  await page.getByRole("button", { name: "文件 ↗" }).click();
  await expect(rail).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  const medium = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    railRight: Math.round(document.querySelector<HTMLElement>(".riffology-file-rail")!.getBoundingClientRect().right),
    viewportWidth: innerWidth,
  }));
  expect(medium.scrollWidth).toBeLessThanOrEqual(medium.clientWidth);
  expect(medium.railRight).toBe(medium.viewportWidth);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  const scaled = await page.evaluate(() => ({
    scale: window.visualViewport?.scale,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(scaled.scale).toBe(2);
  expect(scaled.scrollWidth).toBeLessThanOrEqual(scaled.clientWidth);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });

  await page.setViewportSize({ width: 390, height: 844 });
  const fileToggle = page.getByRole("button", { name: "文件 ↗" });
  await expect(fileToggle).toHaveAttribute("aria-expanded", "false");
  await fileToggle.click();
  const drawer = page.getByRole("dialog", { name: "项目文件" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "收起文件栏" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(fileToggle).toBeFocused();
  await expect(drawer).toBeHidden();
  const closedDrawerTabStops = await page.locator("#riffology-project-files").evaluate((element) =>
    Array.from(element.querySelectorAll<HTMLElement>("button, summary, [tabindex]"))
      .filter((candidate) => candidate.tabIndex >= 0 && candidate.offsetParent !== null).length);
  expect(closedDrawerTabStops).toBe(0);

  await fileToggle.click();
  await drawer.locator(".riffology-file-entry button").first().click();
  await expect(drawer).toBeHidden();
  await expect(viewer).toBeVisible();
  await expect(page.getByRole("button", { name: "← 返回对话" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "项目对话" })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("riffology-stage3-390x844-file-view.png") });
  await page.getByRole("button", { name: "← 返回对话" }).click();
  await expect(page.getByRole("complementary", { name: "项目对话" })).toBeVisible();

  const mobile = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(mobile.scrollWidth).toBeLessThanOrEqual(mobile.clientWidth);
  expect(mobile.scrollHeight).toBeLessThanOrEqual(mobile.clientHeight);
  await page.screenshot({ path: testInfo.outputPath("riffology-stage3-390x844.png") });
  expect(errors).toEqual([]);
});

test("Riffology Stage 3 renders the admitted file matrix and fails closed", async ({ page }) => {
  await page.goto("/");
  const projectHref = await page.getByRole("link", { name: "Open Project" }).first().getAttribute("href");
  expect(projectHref).toMatch(/^\/projects\//u);

  const fixtureFiles = [
    ["fixture-html", "visuals/preview.html", "text/html"],
    ["fixture-md", "analysis/summary.md", "text/markdown"],
    ["fixture-json", "outputs/metrics.json", "application/json"],
    ["fixture-csv", "outputs/queue.csv", "text/csv"],
    ["fixture-unknown", "docs/manual.pdf", "application/pdf"],
    ["fixture-malicious", "visuals/active.html", "text/html"],
    ["fixture-oversized", "analysis/oversized.json", "application/json"],
  ] as const;
  await page.goto(`/workbench${projectHref}`);
  await expect(page.getByRole("region", { name: "项目文件与页面查看器" })).toBeVisible();
  const projectId = projectHref!.slice("/projects/".length);
  const body = await page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: "same-origin" });
    return response.json();
  }, `/api/projects/${projectId}/workspace`) as { files: unknown[] };
  expect(Array.isArray(body.files)).toBe(true);
  body.files.push(...fixtureFiles.map(([fileRef, relativePath, mediaType], index) => ({
      fileRef,
      relativePath,
      mediaType,
      sizeBytes: index + 20,
      sha256: String(index + 1).repeat(64),
      createdAt: "2026-08-02T00:00:00.000Z",
      readOnly: true,
  })));
  await page.route("**/api/projects/*/workspace", async (route) => {
    await route.fulfill({ status: 200, json: body });
  });
  await page.route("**/api/projects/*/files/*/workbench-renderable", async (route) => {
    const fileRef = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
    const resources: Record<string, unknown> = {
      "fixture-html": { kind: "safe_html", title: "visuals/preview.html", html: "<style>h1{color:#245f50}</style><h1>Safe HTML preview</h1>" },
      "fixture-md": { kind: "markdown", title: "analysis/summary.md", text: "# Markdown preview" },
      "fixture-json": { kind: "json", title: "outputs/metrics.json", value: { result: 42 } },
      "fixture-csv": { kind: "table", title: "outputs/queue.csv", caption: "Queue data", columns: ["hour", "waiting"], rows: [["18", "17"]] },
      "fixture-unknown": { kind: "attachment", title: "docs/manual.pdf", mediaType: "application/pdf", sizeBytes: 24, sha256: "5".repeat(64), reason: "unsupported_media" },
    };
    if (fileRef === "fixture-malicious") {
      await route.fulfill({ status: 422, json: { error: { code: "renderer_invalid", message: "HTML contains active content." } } });
      return;
    }
    if (fileRef === "fixture-oversized") {
      await route.fulfill({ status: 422, json: { error: { code: "renderer_limit_exceeded", message: "JSON exceeds the renderer node limit." } } });
      return;
    }
    const resource = resources[fileRef];
    if (!resource) {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, json: resource });
  });

  await page.reload();
  const viewer = page.getByRole("region", { name: "项目文件与页面查看器" });
  const open = async (name: RegExp) => page.getByRole("button", { name }).click();

  await open(/^preview\.html/u);
  const htmlFrame = viewer.locator("iframe");
  await expect(htmlFrame).toHaveAttribute("sandbox", "");
  await expect(htmlFrame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(htmlFrame).toHaveAttribute("srcdoc", /default-src 'none'/u);
  await expect(htmlFrame.contentFrame().getByRole("heading", { name: "Safe HTML preview" })).toBeVisible();

  await open(/^summary\.md/u);
  await expect(viewer.getByRole("heading", { name: "Markdown preview" })).toBeVisible();
  await open(/^metrics\.json/u);
  await expect(viewer).toContainText('"result": 42');
  await open(/^queue\.csv/u);
  await expect(viewer.getByRole("table", { name: "Queue data" })).toBeVisible();
  await open(/^manual\.pdf/u);
  await expect(viewer).toContainText("unsupported_media");
  await open(/^active\.html/u);
  await expect(viewer).toContainText("HTML contains active content.");
  await open(/^oversized\.json/u);
  await expect(viewer).toContainText("JSON exceeds the renderer node limit.");
});
