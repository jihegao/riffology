import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ApiError } from "../../backend/src/errors.ts";
import { INPUT_SCHEMA_PROFILE } from "../../backend/src/execution-protocol-v2.ts";
import { planExperiment } from "../../backend/src/experiment-planner.ts";
import { GenericVisualSupervisor } from "../../backend/src/generic-visual-supervisor.ts";
import { UnavailableMesaAdapter } from "../../backend/src/mesa-adapter.ts";
import {
  HttpOpenCodeAdapter,
  type OpenCodeAdapter,
  type OpenCodeAssistantResponse,
  type OpenCodeConversationPort,
  type OpenCodePrompt,
  type OpenCodeReadiness,
  type OpenCodeRuntimeEvent,
} from "../../backend/src/opencode-adapter.ts";
import { BackendApp } from "../../backend/src/server.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const PROVIDER_ID = process.env.A4_6_PROVIDER_ID ?? "opencode-go";
const MODEL_ID = process.env.A4_6_MODEL_ID ?? "deepseek-v4-pro";
const QUALIFIED_MODEL_ID = `${PROVIDER_ID}/${MODEL_ID}`;
const OPENCODE_URL = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const APP_PORT = Number(process.env.A4_6_APP_PORT ?? 8896);
const BROKER_PORT = Number(process.env.A4_6_BROKER_PORT ?? 8897);
const WIND_MODEL_NAME = "Wind Turbine Maintenance";
const WIND_PROJECT_NAME = "A4-6 Wind Project";
const LIVE_MODEL_NAME = "A4-6 Live Model";
const FIRST_CONVERSATION = "A4-6 Primary";
const SECOND_CONVERSATION = "A4-6 Secondary";
const PROJECT_CONVERSATION = "A4-6 Project Conversation";
const FIRST_DOCUMENT = "A4-6 Context";
const SECOND_DOCUMENT = "A4-6 Continuity";
const ANALYSIS_DOCUMENT = "A4-6 Requested Analysis";
const FIRST_TOKEN = "A4-6-ALPHA-94731";
const SECOND_TOKEN = "A4-6-BETA-62804";

test("A4-6 continuous real-provider Product exit", async ({
  page,
  context,
}, testInfo) => {
  testInfo.annotations.push({
    type: "live-provider",
    description: QUALIFIED_MODEL_ID,
  });
  const parent = await mkdtemp(join(tmpdir(), "riff-a4-6-"));
  const openCode = new SwitchableOpenCode(new HttpOpenCodeAdapter({
    baseUrl: OPENCODE_URL,
    model: QUALIFIED_MODEL_ID,
    allowedProviders: [PROVIDER_ID],
    requestTimeoutMs: 180_000,
  }));
  const discovered = await openCode.discoverProviderModels();
  expect(
    discovered.map((candidate) => candidate.qualifiedId),
    `Live provider discovery did not include ${QUALIFIED_MODEL_ID}.`,
  ).toContain(QUALIFIED_MODEL_ID);
  const readiness = await openCode.initialize();
  expect(readiness.status).toBe("ready");
  expect(readiness.modelId).toBe(QUALIFIED_MODEL_ID);
  expect(readiness.version).toMatch(/^\d+\.\d+\.\d+/u);

  const controller = await ProductController.create(parent, openCode);
  const consoleErrors: string[] = [];
  const publicResponseBodies: string[] = [];
  const pendingResponseReads = new Set<Promise<void>>();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("response", (response) => {
    if (!response.url().includes("/api/")
      || !response.headers()["content-type"]?.includes("application/json")) return;
    const pending = response.body().then((bytes) => {
      if (bytes.byteLength <= 1_000_000) {
        publicResponseBodies.push(bytes.toString("utf8"));
      }
    }).catch(() => undefined).finally(() => pendingResponseReads.delete(pending));
    pendingResponseReads.add(pending);
  });

  let primaryConversationUrl = "";
  let projectConversationUrl = "";
  try {
    await controller.start();

    // 1. Home exposes the four generic entries through the direct Product server.
    const homeResponse = await page.goto(controller.origin);
    expect(homeResponse?.status()).toBe(200);
    expect(homeResponse?.headers()["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New Model" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New Project" })).toBeVisible();

    // 2. Wind is one ordinary installed Model, rendered by the generic workspace.
    const windModelCard = resourceCard(page, "home-models", WIND_MODEL_NAME);
    await windModelCard.getByRole("link", { name: "Open Model" }).click();
    await expect(page.getByTestId("model-workspace")).toBeVisible();
    await expect.poll(() => visibleExactTextCount(page, WIND_MODEL_NAME)).toBe(1);
    await expect(page.getByText(/thin execution contract passed/u)).toBeVisible();
    await page.getByTestId("pane-workspace").getByRole("button", {
      name: /visuals\/README\.md/u,
    }).click();
    await expect(page.getByRole("heading", { name: "visuals/README.md" })).toBeVisible();
    await expect(page.getByText(/behavioral reproduction/u)).toBeVisible();

    // 3. A real provider performs two turns and creates two durable documents.
    await goHome(page);
    await page.getByRole("button", { name: "New Model" }).click();
    const modelForm = page.locator("form").filter({ hasText: "New Model" });
    await modelForm.getByLabel("Name").fill(LIVE_MODEL_NAME);
    await modelForm.getByLabel("Provider / model").selectOption(QUALIFIED_MODEL_ID);
    await modelForm.getByRole("button", { name: "Create Model" }).click();
    await expect(page.getByTestId("shell-owner-heading")).toHaveText(LIVE_MODEL_NAME);
    await expect.poll(() => visibleExactTextCount(page, LIVE_MODEL_NAME)).toBe(1);
    primaryConversationUrl = page.url();
    await page.getByText("Manage Conversation").click();
    await page.getByLabel("Conversation name").fill(FIRST_CONVERSATION);
    await page.getByRole("button", { name: "Rename" }).click();
    await expect(page.getByRole("link", { name: FIRST_CONVERSATION })).toBeVisible();
    primaryConversationUrl = page.url();
    const ownerCard = await page.getByTestId("workspace-owner-card").elementHandle();
    expect(ownerCard).not.toBeNull();

    await page.getByLabel("File", { exact: true }).setInputFiles({
      name: "a4-6-input.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"acceptance":"A4-6"}'),
    });
    await page.getByLabel("Purpose").fill("A4-6 acceptance input");
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByText("a4-6-input.json", { exact: true }).first())
      .toBeVisible();
    await page.getByRole("group", { name: "Attach to this message" })
      .getByLabel("a4-6-input.json").check();
    await sendTurn(page, [
      `Create a temporary document now using riff_create_temporary_document.`,
      `Name it exactly "${FIRST_DOCUMENT}", use text/markdown, and include the exact token`,
      `${FIRST_TOKEN}. After the tool succeeds, reply with that exact token.`,
    ].join(" "));
    await expect(temporaryDocuments(page).getByText(FIRST_DOCUMENT, {
      exact: true,
    })).toBeVisible();
    await expect(agentActivity(page).getByText(
      "temporary_document_create",
      { exact: true },
    )).toBeVisible();
    await expect(lastAssistantMessage(page)).toContainText(FIRST_TOKEN);
    await expect(page.getByText(/locked after the first accepted message/u))
      .toBeVisible();

    await sendTurn(page, [
      `Create a second temporary document now using riff_create_temporary_document.`,
      `Name it exactly "${SECOND_DOCUMENT}", use text/markdown, and include both exact tokens`,
      `${FIRST_TOKEN} and ${SECOND_TOKEN}. After the tool succeeds, reply with both.`,
    ].join(" "));
    await expect(temporaryDocuments(page).getByText(SECOND_DOCUMENT, {
      exact: true,
    })).toBeVisible();
    await expect(lastAssistantMessage(page)).toContainText(SECOND_TOKEN);

    // 4. A second real Conversation remains independent; switching preserves
    // the first transcript, attachment, documents, and the mounted owner object.
    await createConversation(page, SECOND_CONVERSATION, QUALIFIED_MODEL_ID);
    await sendTurn(
      page,
      `Reply with the exact text "${SECOND_TOKEN} belongs to the second Conversation."`,
    );
    await expect(lastAssistantMessage(page)).toContainText(
      `${SECOND_TOKEN} belongs to the second Conversation.`,
    );
    await page.getByRole("link", { name: FIRST_CONVERSATION }).click();
    await expect(lastAssistantMessage(page)).toContainText(FIRST_TOKEN);
    await expect(temporaryDocuments(page).getByText(FIRST_DOCUMENT, {
      exact: true,
    })).toBeVisible();
    await expect(temporaryDocuments(page).getByText(SECOND_DOCUMENT, {
      exact: true,
    })).toBeVisible();
    await expect(attachments(page).getByText("a4-6-input.json", { exact: true }))
      .toBeVisible();
    expect(await ownerCard!.evaluate((node) => node.isConnected)).toBe(true);
    const currentOwnerCard = await page.getByTestId("workspace-owner-card")
      .elementHandle();
    expect(await ownerCard!.evaluate(
      (node, current) => node === current,
      currentOwnerCard,
    )).toBe(true);

    // 5. New Project explicitly selects the executable wind Model and receives
    // an immutable fixed copy.
    await goHome(page);
    await page.getByRole("button", { name: "New Project" }).click();
    const projectForm = page.locator("form").filter({ hasText: "New Project" });
    await projectForm.getByLabel("Name").fill(WIND_PROJECT_NAME);
    await projectForm.getByLabel("Executable Model").selectOption({
      label: WIND_MODEL_NAME,
    });
    await projectForm.getByRole("button", { name: "Create Project" }).click();
    await expect(page.getByTestId("shell-owner-heading")).toHaveText(
      WIND_PROJECT_NAME,
    );
    await expect.poll(() => visibleExactTextCount(page, WIND_PROJECT_NAME)).toBe(1);
    await expect(page.getByTestId("workspace-owner-card")).toContainText(
      "immutable Model copy",
    );
    await page.getByRole("button", { name: "Create configuration" }).click();
    await expect(page.getByRole("button", { name: "Start batch Run" }))
      .toBeEnabled();

    // 6. Its real Project Conversation uses only scoped Experiment tools, and
    // the dynamic right workspace refreshes without a navigation/remount.
    await createConversation(page, PROJECT_CONVERSATION, QUALIFIED_MODEL_ID);
    projectConversationUrl = page.url();
    const projectOwnerCard = await page.getByTestId("workspace-owner-card")
      .elementHandle();
    const configurationField = page.getByRole("textbox", {
      name: "Configuration JSON",
    });
    await sendTurn(page, [
      "Update the active Experiment configuration now.",
      "First call riff_list_experiment_configurations, retain every field, then call",
      "riff_update_experiment_configuration with horizon_days 120, warmup_days 30,",
      "and turbine_count 30. Report the accepted sample count after the tool succeeds.",
    ].join(" "));
    await expect(agentActivity(page).getByText(
      "experiment_configuration_update",
      { exact: true },
    )).toBeVisible();
    await expect.poll(async () => {
      const configuration = JSON.parse(await configurationField.inputValue());
      return {
        horizon: configuration.parameters.horizon_days,
        warmup: configuration.parameters.warmup_days,
        turbines: configuration.parameters.turbine_count,
      };
    }, { timeout: 180_000 }).toEqual({
      horizon: 120,
      warmup: 30,
      turbines: 30,
    });
    expect(await projectOwnerCard!.evaluate((node) => node.isConnected)).toBe(true);
    const currentProjectOwnerCard = await page.getByTestId("workspace-owner-card")
      .elementHandle();
    expect(await projectOwnerCard!.evaluate(
      (node, current) => node === current,
      currentProjectOwnerCard,
    )).toBe(true);

    // 7. A real batch Run publishes deterministic completion, outputs,
    // diagnostic events, a safe renderer, and digest-checked download bytes.
    await page.getByRole("button", { name: "Start batch Run" }).click();
    await expect(page.getByText("succeeded", { exact: true }).first())
      .toBeVisible({ timeout: 240_000 });
    await expect(page.getByRole("table", { name: /Digest-checked outputs/u }))
      .toBeVisible();
    await expect(page.getByText(/never creates an analysis document automatically/u))
      .toBeVisible();
    await expect(page.getByText(ANALYSIS_DOCUMENT, { exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Sample index" }).fill("0");
    await page.getByRole("button", { name: "Load diagnostic events" }).click();
    await expect(page.getByRole("table", { name: /Bounded diagnostic events/u }))
      .toBeVisible({ timeout: 30_000 });
    await page.locator(".product-downloads > div").filter({
      has: page.getByRole("button", { name: /Download summary/u }),
    }).getByRole("button", { name: "Render safely" }).click();
    await expect(page.getByRole("heading", { name: "summary", exact: true }))
      .toBeVisible();
    await expectDigestCheckedDownload(page);

    // 8. Only the subsequent explicit human request creates analysis.
    await sendTurn(page, [
      `Create an analysis document now using riff_create_analysis_document.`,
      `Name it exactly "${ANALYSIS_DOCUMENT}" and use text/markdown.`,
      "Use only the persisted succeeded completion card facts; do not invent metrics.",
    ].join(" "));
    await expect(temporaryDocuments(page).getByText(ANALYSIS_DOCUMENT, {
      exact: true,
    })).toBeVisible();
    await expect(agentActivity(page).getByText(
      "analysis_document_create",
      { exact: true },
    )).toBeVisible();

    // 9. A generic visual Project starts a managed process and redeems only a
    // short-lived restricted broker frame.
    await goHome(page);
    const visualProjectCard = resourceCard(
      page,
      "home-projects",
      "Generic Visual Project",
    );
    await visualProjectCard.getByRole("link", { name: "Open Project" }).click();
    await page.getByRole("button", { name: "Start visual Run" }).click();
    await expect(page.getByRole("button", {
      name: "Open restricted visual frame",
    })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", {
      name: "Open restricted visual frame",
    }).click();
    const continueToVisual = page.getByRole("link", {
      name: "Continue to restricted visual frame",
    });
    const visualHostUrl = await continueToVisual.getAttribute("href");
    expect(visualHostUrl).toMatch(
      new RegExp(`^http://localhost:${APP_PORT}/browser/projects/`
        + "project_a4_6_visual/runs/run_[a-f0-9]{32}/visual$"),
    );
    await page.goto(visualHostUrl!);
    const visualFrame = page.getByTitle("Project visual run");
    await expect(visualFrame).toHaveAttribute(
      "src",
      new RegExp(`^http://localhost:${BROKER_PORT}/frame/redeem/[A-Za-z0-9_-]{43}$`),
    );
    await expect(page.frameLocator("iframe[title='Project visual run']")
      .getByRole("heading", { name: "A4-6 generic visual fixture" }))
      .toBeVisible({ timeout: 30_000 });
    await page.goto(`${controller.origin}/projects/project_a4_6_visual`);
    await page.getByRole("button", { name: "Cancel Run" }).click();
    await expect(page.getByText("cancelled", { exact: true }).first())
      .toBeVisible({ timeout: 30_000 });

    // 10. Restarting the BackendApp on the same authority and Product root
    // restores every supported resource before accepting the next write.
    await page.goto("about:blank");
    await controller.restart();
    await page.goto(controller.origin);
    await expect(resourceCard(page, "home-models", LIVE_MODEL_NAME)).toBeVisible();
    await expect(resourceCard(page, "home-projects", WIND_PROJECT_NAME)).toBeVisible();
    await page.goto(primaryConversationUrl);
    await expect(lastAssistantMessage(page)).toContainText(FIRST_TOKEN);
    await expect(temporaryDocuments(page).getByText(FIRST_DOCUMENT, {
      exact: true,
    })).toBeVisible();
    await expect(temporaryDocuments(page).getByText(SECOND_DOCUMENT, {
      exact: true,
    })).toBeVisible();
    await expect(attachments(page).getByText("a4-6-input.json", { exact: true }))
      .toBeVisible();
    await page.goto(projectConversationUrl);
    await expect(page.getByText(ANALYSIS_DOCUMENT, { exact: true })).toBeVisible();
    await expect(page.getByText("succeeded", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => {
      const configuration = JSON.parse(await page.getByRole("textbox", {
        name: "Configuration JSON",
      }).inputValue());
      return configuration.parameters.horizon_days;
    }).toBe(120);

    // 11. Provider loss accepts the human message durably, produces no
    // fabricated assistant reply, and does not disable direct Run/output APIs.
    const assistantCount = await page.getByText(/^Assistant$/u).count();
    openCode.available = false;
    const runSelector = page.getByLabel("Run", { exact: true });
    const runOptionsBefore = await runSelector.locator("option").count();
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toBeEnabled();
    const unavailablePrompt =
      "Create another analysis document now named Provider Down Fabrication Check.";
    await composer.fill(unavailablePrompt);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(unavailablePrompt, { exact: true })).toBeVisible();
    await expect(page.getByText("Agent: read only", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Assistant$/u)).toHaveCount(assistantCount);
    await expect(page.getByText("Provider Down Fabrication Check", { exact: true }))
      .toHaveCount(0);
    await page.getByRole("button", { name: "Start batch Run" }).click();
    await expect.poll(
      () => runSelector.locator("option").count(),
      { timeout: 240_000 },
    ).toBeGreaterThan(runOptionsBefore);
    await expect(runSelector.locator("option:checked")).toContainText(
      "succeeded · batch",
      { timeout: 240_000 },
    );
    await expectDigestCheckedDownload(page);

    // 12. Desktop, narrow reflow, actual CDP 200% page scale, and keyboard-only
    // pane switching all remain operable with no console or page errors.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({
      path: testInfo.outputPath("a4-6-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 640, height: 900 });
    await page.reload();
    await expect(page.getByTestId("shell-owner-heading")).toHaveText(
      WIND_PROJECT_NAME,
    );
    await expect(page.getByTestId("shell-owner-heading")).toBeFocused();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    expect(await page.evaluate(() => visualViewport?.scale)).toBe(2);
    const paneSelector = page.getByTestId("pane-selector");

    await page.keyboard.press("Tab");
    await expect(paneSelector.getByRole("button", { name: "Conversation" }))
      .toBeFocused();
    await page.keyboard.press("Tab");
    await expect(paneSelector.getByRole("button", { name: "Workspace" }))
      .toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("pane-workspace")).toBeVisible();
    await expect(paneSelector.getByRole("button", { name: "Workspace" }))
      .toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(paneSelector.getByRole("button", { name: "Conversation" }))
      .toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("pane-conversation")).toBeVisible();
    await expect(paneSelector.getByRole("button", { name: "Conversation" }))
      .toBeFocused();
    const fit = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      scale: visualViewport?.scale,
    }));
    expect(fit.scale).toBe(2);
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
    await page.screenshot({
      path: testInfo.outputPath("a4-6-narrow-keyboard-actual-200-percent.png"),
      fullPage: true,
    });
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });

    await Promise.all([...pendingResponseReads]);
    const publicEvidence = publicResponseBodies.join("\n");
    for (const forbidden of [
      "externalSessionRef",
      "rawToolPayload",
      "OPENCODE_SERVER_PASSWORD",
      "authorization\":\"Basic",
      "\"apiKey\"",
      "/Users/",
      "/private/",
    ]) {
      expect(publicEvidence, `Public API response leaked ${forbidden}`)
        .not.toContain(forbidden);
    }
    expect(openCode.createdSessionRefs.size).toBeGreaterThan(0);
    for (const sessionRef of openCode.createdSessionRefs) {
      expect(publicEvidence, "Public API response leaked a live OpenCode session reference")
        .not.toContain(sessionRef);
    }
    expect(consoleErrors).toEqual([]);
  } finally {
    await controller.close().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});

class SwitchableOpenCode implements OpenCodeAdapter, OpenCodeConversationPort {
  available = true;
  readonly delegate: HttpOpenCodeAdapter;
  readonly createdSessionRefs = new Set<string>();

  constructor(delegate: HttpOpenCodeAdapter) {
    this.delegate = delegate;
  }

  async initialize(): Promise<OpenCodeReadiness> {
    if (!this.available) return {
      status: "error",
      modelId: null,
      lastError: {
        code: "opencode_unavailable",
        message: "OpenCode is unavailable.",
      },
    };
    return this.delegate.initialize();
  }

  async discoverProviderModels() {
    this.#requireAvailable();
    return this.delegate.discoverProviderModels();
  }

  async getSession(sessionId: string): Promise<boolean> {
    this.#requireAvailable();
    return this.delegate.getSession(sessionId);
  }

  async createSession(id: string): Promise<string> {
    this.#requireAvailable();
    const sessionRef = await this.delegate.createSession(id);
    this.createdSessionRefs.add(sessionRef);
    return sessionRef;
  }

  async injectContext(
    sessionId: string,
    context: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#requireAvailable();
    return this.delegate.injectContext(sessionId, context, signal);
  }

  async promptWithModel(
    sessionId: string,
    binding: { providerId: string; modelId: string },
    prompt: OpenCodePrompt,
    signal?: AbortSignal,
  ): Promise<OpenCodeAssistantResponse> {
    this.#requireAvailable();
    return this.delegate.promptWithModel(sessionId, binding, prompt, signal);
  }

  async prompt(
    sessionId: string,
    prompt: OpenCodePrompt,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#requireAvailable();
    return this.delegate.prompt(sessionId, prompt, signal);
  }

  async abort(sessionId: string): Promise<void> {
    return this.delegate.abort(sessionId);
  }

  async bindProject(projectId: string, mcpUrl: string): Promise<void> {
    this.#requireAvailable();
    return this.delegate.bindProject(projectId, mcpUrl);
  }

  async bindScopedMcp(scopeId: string, mcpUrl: string): Promise<void> {
    this.#requireAvailable();
    return this.delegate.bindScopedMcp(scopeId, mcpUrl);
  }

  async unbindScopedMcp(scopeId: string): Promise<void> {
    return this.delegate.unbindScopedMcp(scopeId);
  }

  async subscribeEvents(
    listener: (event: OpenCodeRuntimeEvent) => void,
  ): Promise<() => void> {
    this.#requireAvailable();
    return this.delegate.subscribeEvents(listener);
  }

  #requireAvailable(): void {
    if (!this.available) {
      throw new ApiError(
        503,
        "opencode_unavailable",
        "The local OpenCode server is not reachable.",
      );
    }
  }
}

class ProductController {
  readonly parent: string;
  readonly openCode: SwitchableOpenCode;
  readonly productRoot: string;
  readonly visualSupervisor: GenericVisualSupervisor;
  app?: BackendApp;
  origin = `http://localhost:${APP_PORT}`;

  private constructor(
    parent: string,
    openCode: SwitchableOpenCode,
    visualSupervisor: GenericVisualSupervisor,
  ) {
    this.parent = parent;
    this.openCode = openCode;
    this.productRoot = join(parent, "product");
    this.visualSupervisor = visualSupervisor;
  }

  static async create(
    parent: string,
    openCode: SwitchableOpenCode,
  ): Promise<ProductController> {
    const visualScratchRoot = join(parent, "visual-scratch");
    await mkdir(visualScratchRoot, { recursive: true, mode: 0o700 });
    return new ProductController(parent, openCode, new GenericVisualSupervisor({
      pythonExecutable: "/usr/bin/python3",
      scratchRoot: visualScratchRoot,
    }));
  }

  async start(): Promise<void> {
    if (this.app) throw new Error("A4-6 Product controller is already started.");
    const app = new BackendApp({
      mesa: new UnavailableMesaAdapter(),
      openCode: this.openCode,
      a2OpenCode: this.openCode,
      a2ProductRoot: this.productRoot,
      a3PythonExecutable: resolve(
        REPOSITORY_ROOT,
        "mesa_service/.venv/bin/python",
      ),
      a3VisualSupervisor: this.visualSupervisor,
      a3InstallPreinstalledWind: true,
      a3PreinstalledWindRepositoryRoot: REPOSITORY_ROOT,
      workspaceRoot: join(this.parent, "legacy-unused"),
      repositoryRoot: REPOSITORY_ROOT,
      staticWebRoot: join(REPOSITORY_ROOT, "web", "dist"),
      productOnly: true,
      recoveryOnlyOnFailure: false,
    });
    await app.initialize();
    seedVisualFixture(app);
    const network = await app.listenBrowserNetwork(APP_PORT, BROKER_PORT);
    this.origin = network.app.origin;
    this.app = app;
  }

  async restart(): Promise<void> {
    await this.close();
    await this.start();
  }

  async close(): Promise<void> {
    const app = this.app;
    this.app = undefined;
    if (app) await app.close();
  }
}

const seedVisualFixture = (app: BackendApp): void => {
  const store = app.productStore!;
  if (store.listModels({
    includeArchived: true,
    includeTrashed: true,
  }).some((model) => model.id === "model_a4_6_visual")) return;
  const createdAt = "2026-07-25T00:00:00.000Z";
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["mode"],
    properties: { mode: { type: "string", enum: ["linger"] } },
  } as const;
  const execution = {
    schemaVersion: 2,
    runtime: "python",
    runMode: "visual",
    dependencyFile: "environment/requirements.txt",
    inputs: {
      schemaProfile: INPUT_SCHEMA_PROFILE,
      schema,
      smoke: { mode: "linger" },
    },
    outputs: [{
      logicalName: "summary",
      relativePath: "summary.json",
      mediaType: "application/json",
      required: true,
      role: "data",
    }],
    visual: {
      entryPoint: "code/model.py",
      protocol: "riff-visual-v1",
      healthPath: "/health",
    },
    cancellation: { signal: "SIGTERM", graceMs: 100 },
  } as const;
  const source = Buffer.from(`
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser()
parser.add_argument("--riff-input", required=True)
parser.add_argument("--riff-output-dir", required=True)
parser.add_argument("--riff-host", required=True)
parser.add_argument("--riff-port", required=True, type=int)
args = parser.parse_args()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"status": "healthy"}).encode("utf-8")
            content_type = "application/json"
        elif self.path == "/":
            body = b"<!doctype html><html><body><h1>A4-6 generic visual fixture</h1></body></html>"
            content_type = "text/html; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        pass

ThreadingHTTPServer((args.riff_host, args.riff_port), Handler).serve_forever()
`);
  store.createModel({
    id: "model_a4_6_visual",
    name: "Generic Visual Process",
    technicalStatus: "executable",
    runMode: "visual",
    executionDescription: execution,
    createdAt,
    files: [{
      id: "file_a4_6_visual_model",
      kind: "model_code",
      relativePath: "model.py",
      mediaType: "text/x-python",
      bytes: source,
    }, {
      id: "file_a4_6_visual_environment",
      kind: "model_environment",
      relativePath: "requirements.txt",
      mediaType: "text/plain",
      bytes: Buffer.from(""),
    }],
  });
  store.createProjectFromModel({
    projectId: "project_a4_6_visual",
    projectName: "Generic Visual Project",
    sourceModelId: "model_a4_6_visual",
    createdAt,
  });
  store.createExperimentV4({
    commandId: "command_a4_6_visual_experiment",
    id: "experiment_a4_6_visual",
    projectId: "project_a4_6_visual",
    name: "Healthy visual process",
    plan: planExperiment({
      configuration: {
        schemaVersion: 1,
        runKind: "visual",
        parameters: { mode: "linger" },
        sampling: { kind: "single", seed: 2 },
      },
      inputSchema: schema,
      maxSamples: 1,
    }),
    createdAt,
  });
};

const goHome = async (page: Page): Promise<void> => {
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
};

const resourceCard = (
  page: Page,
  testId: "home-models" | "home-projects",
  heading: string,
) => page.getByTestId(testId).locator("article").filter({
  has: page.getByRole("heading", { name: heading, exact: true }),
});

const visibleExactTextCount = (page: Page, text: string) =>
  page.getByText(text, { exact: true }).evaluateAll((elements) =>
    elements.filter((element) => {
      const style = getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0;
    }).length);

const createConversation = async (
  page: Page,
  name: string,
  qualifiedModelId: string,
): Promise<void> => {
  await page.getByRole("button", { name: "New Conversation" }).click();
  const form = page.locator("form").filter({ hasText: "New Conversation" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Provider / model").selectOption(qualifiedModelId);
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("link", { name })).toHaveAttribute(
    "aria-current",
    "page",
  );
};

const sendTurn = async (
  page: Page,
  text: string,
): Promise<void> => {
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Connecting…" })).toBeVisible();
  await expect(page.getByText("Agent: live", { exact: true }))
    .toBeVisible({ timeout: 180_000 });
  await expect(composer).toBeEnabled();
};

const temporaryDocuments = (page: Page) => page.locator("section").filter({
  has: page.getByRole("heading", { name: "Temporary documents" }),
});

const agentActivity = (page: Page) => page.locator("section").filter({
  has: page.getByRole("heading", { name: "Agent activity" }),
});

const attachments = (page: Page) => page.locator("section").filter({
  has: page.getByRole("heading", { name: "Attachments" }),
});

const lastAssistantMessage = (page: Page) => page.getByRole("list", {
  name: "Conversation messages",
}).locator("li").filter({
  has: page.getByText("Assistant", { exact: true }),
}).last();

const expectDigestCheckedDownload = async (page: Page): Promise<void> => {
  const outputTable = page.getByRole("table", {
    name: /Digest-checked outputs/u,
  });
  const summaryRow = outputTable.getByRole("row").filter({
    has: page.getByText("summary", { exact: true }),
  }).first();
  const cells = summaryRow.locator("th, td");
  const expectedSize = Number(await cells.nth(4).innerText());
  const expectedDigest = (await cells.nth(5).innerText()).trim();
  expect(expectedSize).toBeGreaterThan(0);
  expect(expectedDigest).toMatch(/^[0-9a-f]{64}$/u);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download summary/u }).first().click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = await readFile(path!);
  expect(bytes.byteLength).toBe(expectedSize);
  expect(createHash("sha256").update(bytes).digest("hex"))
    .toBe(expectedDigest);
};
