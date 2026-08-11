import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { ProductClient } from "./product/api";
import type {
  ConversationBundle,
  HomeDto,
  ProjectWorkspaceDto,
  ProviderDiscovery,
  WorkspaceDto,
} from "./product/types";

const home: HomeDto = {
  schemaVersion: 1,
  generatedAt: "2026-07-25T00:00:00.000Z",
  collectionDigest: "home-digest",
  providerAvailability: { mode: "live", providerModelCount: 1 },
  projects: [{
    id: "project-one",
    name: "Baseline study",
    kind: "project",
    lifecycleState: "active",
    workspaceDigest: "e".repeat(64),
    executionLock: { state: "unlocked", runId: null, sourceDigest: null },
    lastRun: null,
    recordDigest: "project-digest",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    recentActivityAt: "2026-07-25T00:00:00.000Z",
    recentActivityKind: "resource_created",
    allowedActions: ["open", "rename", "archive", "trash"],
  }],
  templates: [{
    id: "template-one", name: "Maintenance template", version: "1.0.0",
    description: "Seed Project", runMode: "both",
    updatedAt: "2026-07-25T00:00:00.000Z", templateDigest: "f".repeat(64),
  }],
  recentConversations: [{
    id: "conversation-main",
    owner: { kind: "project", id: "project-one", name: "Baseline study" },
    name: "Main",
    updatedAt: "2026-07-25T00:00:00.000Z",
  }],
};

const providers: ProviderDiscovery = {
  mode: "live",
  providerModels: [{ providerId: "provider", modelId: "model", qualifiedId: "provider/model" }],
};

const workspace: WorkspaceDto = {
  owner: {
    id: "project-one", name: "Baseline study", kind: "project",
    lifecycleState: "active",
  },
  workspaceDigest: "e".repeat(64),
  executionLock: { state: "unlocked", runId: null, sourceDigest: null },
  execution: {
    schemaVersion: 2, runtime: "python", runMode: "batch",
    dependencyFile: "environment/requirements.txt",
    inputs: {
      schemaProfile: "riff-json-schema-2020-12-v1",
      schema: { type: "object", additionalProperties: false, properties: {} },
      smoke: {},
    },
    outputs: [{
      logicalName: "summary", relativePath: "summary.json",
      mediaType: "application/json", required: true, role: "data",
    }],
    batch: { entryPoint: "code/riff_entry.py", protocol: "riff-batch-v1" },
    cancellation: { signal: "SIGTERM", graceMs: 500 },
  },
  executionDescriptionDigest: "execution-digest",
  files: [],
  conversations: [{
    id: "conversation-main", owner: { kind: "project", id: "project-one" },
    name: "Main", lifecycleState: "active", recordDigest: "c".repeat(64),
    provider: { providerId: "provider", modelId: "model", locked: false },
    sessionState: "none", updatedAt: "2026-07-25T00:00:00.000Z",
  }, {
    id: "conversation-review", owner: { kind: "project", id: "project-one" },
    name: "Review", lifecycleState: "active", recordDigest: "d".repeat(64),
    provider: { providerId: "provider", modelId: "model", locked: false },
    sessionState: "none", updatedAt: "2026-07-25T00:00:00.000Z",
  }],
  experimentConfigurations: [],
  runs: [],
};

const projectWorkspace: ProjectWorkspaceDto = workspace;

const client = (): ProductClient => ({
  recoveryStatus: vi.fn(async () => ({
    state: "ready" as const,
    observedAt: "2026-07-25T00:00:00.000Z",
  })),
  home: vi.fn(async () => home),
  providers: vi.fn(async () => providers),
  createWorkspaceBinding: vi.fn(async () => { throw new Error("unused"); }),
  workspaceBinding: vi.fn(async () => { throw new Error("unused"); }),
  updateWorkspaceBinding: vi.fn(async () => { throw new Error("unused"); }),
  sendWorkspaceBootstrapTurn: vi.fn(async () => { throw new Error("unused"); }),
  createProject: vi.fn(async () => ({
    project: { id: "created-project", name: "Created", lifecycleState: "active" as const },
    conversation: workspace.conversations[0],
  })),
  workspace: vi.fn(async () => projectWorkspace),
  projectFileRenderable: vi.fn(async () => ({
    kind: "json" as const,
    title: "fixture",
    value: {},
  })),
  projectFileWorkbenchRenderable: vi.fn(async () => ({
    kind: "json" as const,
    title: "fixture",
    value: {},
  })),
  createExperiment: vi.fn(async () => { throw new Error("unused"); }),
  updateExperiment: vi.fn(async () => { throw new Error("unused"); }),
  startRun: vi.fn(async () => { throw new Error("unused"); }),
  run: vi.fn(async () => { throw new Error("unused"); }),
  cancelRun: vi.fn(async () => ({})),
  trashRun: vi.fn(async () => ({})),
  restoreRun: vi.fn(async () => ({})),
  diagnosticEvents: vi.fn(async () => ({
    items: [],
    nextCursor: null,
    truncated: false,
  })),
  outputRenderable: vi.fn(async () => ({
    kind: "json" as const,
    title: "fixture output",
    value: {},
  })),
  outputDownloadHref: vi.fn(() => "/download"),
  downloadOutput: vi.fn(async () => {}),
  issueVisualFrame: vi.fn(async () => ({
    schemaVersion: 1 as const,
    frameUrl: "http://localhost:8788/frame/redeem/fixture",
    expiresAt: "2026-07-25T00:01:00.000Z",
  })),
  visualHostUrl: vi.fn(async () =>
    "http://localhost:8787/browser/projects/project-one/runs/run-one/visual"),
  conversations: vi.fn(async (_kind, _id, lifecycle = "active") =>
    lifecycle === "active" ? workspace.conversations : []),
  createConversation: vi.fn(async () => workspace.conversations[0]),
  conversationBundle: vi.fn(async (conversationId) => ({
    conversation: workspace.conversations.find(
      (conversation) => conversation.id === conversationId,
    ) ?? workspace.conversations[0],
    messages: [],
    attachments: [],
    documents: [],
    skillUses: [],
    actions: [],
  })),
  changeConversationProvider: vi.fn(async () => ({})),
  uploadConversationAttachment: vi.fn(async () => {
    throw new Error("unused");
  }),
  sendTurn: vi.fn(async () => {
    throw new Error("unused");
  }),
  renameConversation: vi.fn(async () => {
    throw new Error("unused");
  }),
  transitionConversation: vi.fn(async () => {
    throw new Error("unused");
  }),
  previewConversationPermanentDelete: vi.fn(async () => {
    throw new Error("unused");
  }),
  permanentlyDeleteConversation: vi.fn(async () => {
    throw new Error("unused");
  }),
});

describe("Stage 4 Product entry", () => {
  // Historical Product tests exercise the explicit test-only rollback. The
  // shipped default is covered below and never exposes a UI affordance.
  beforeEach(() => {
    (globalThis as { __RIFFOLOGY_TEST_LEGACY_FALLBACK__?: boolean })
      .__RIFFOLOGY_TEST_LEGACY_FALLBACK__ = true;
  });

  afterEach(() => {
    history.replaceState({}, "", "/");
    sessionStorage.clear();
    (globalThis as { __RIFFOLOGY_TEST_LEGACY_FALLBACK__?: boolean })
      .__RIFFOLOGY_TEST_LEGACY_FALLBACK__ = false;
  });

  it("renders only the Project collection and Project creation entry", async () => {
    render(<App client={client()} />);

    expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Models" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Model" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Project" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Open Project" })).toHaveAttribute("href", "/projects/project-one");
    expect(screen.queryByText("Wind Evidence Studio")).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy queue / OpenCode")).not.toBeInTheDocument();
  });

  it("uses one shared shell and keeps the right owner DOM mounted across Conversation changes", async () => {
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    render(<App client={productClient} />);

    await waitFor(() => expect(screen.getByTestId("shell-owner-heading"))
      .toHaveTextContent("Baseline study"));
    expect(screen.getAllByRole("heading", { name: "Baseline study" })).toHaveLength(1);
    expect(screen.queryByText("PERSISTENT CONTEXT")).not.toBeInTheDocument();
    expect(screen.queryByText("CURRENT OBJECT")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Workspace$/u }))
      .not.toBeInTheDocument();
    const toolbar = screen.getByTestId("conversation-toolbar");
    const scrollRegion = screen.getByTestId("conversation-scroll-region");
    const composerDock = await screen.findByTestId("conversation-composer-dock");
    expect(toolbar).toBeInTheDocument();
    expect(scrollRegion).toHaveAccessibleName("Conversation activity");
    expect(scrollRegion.compareDocumentPosition(composerDock)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const ownerCard = screen.getByTestId("workspace-owner-card");
    expect(ownerCard).not.toHaveTextContent("Baseline study");
    screen.getByRole("link", { name: "Review" }).click();

    expect(window.location.pathname).toBe("/projects/project-one");
    expect(window.location.search).toBe("?conversation=conversation-review");
    expect(screen.getByTestId("workspace-owner-card")).toBe(ownerCard);
    expect(productClient.workspace).toHaveBeenCalledTimes(1);
  });

  it("keeps focus on the pane selector control activated by the user", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    render(<App client={client()} />);

    await screen.findByTestId("workspace-owner-card");
    const workspaceControl = screen.getByRole("button", { name: "Workspace" });
    workspaceControl.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(workspaceControl).toHaveFocus());
    expect(workspaceControl).toHaveAttribute("aria-pressed", "true");

    const conversationControl = screen.getByRole("button", { name: "Conversation" });
    conversationControl.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(conversationControl).toHaveFocus());
    expect(conversationControl).toHaveAttribute("aria-pressed", "true");
  });

  it("refreshes the right workspace after a committed Project file write without remounting it", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    productClient.sendTurn = vi.fn(async () => ({
      mode: "live" as const,
      turn: {
        requestKey: "owner-mutation",
        state: "complete" as const,
        userMessageId: "message-user",
        assistantMessageId: "message-assistant",
        skillUses: [],
        actions: [{
          id: "action-mutate",
          actionKind: "project_files_write",
          permissionDecision: "allowed" as const,
          state: "committed" as const,
          errorCode: null,
        }],
        goalVerification: null,
        failure: null,
      },
      messages: [],
    }));
    render(<App client={productClient} />);

    const ownerCard = await screen.findByTestId("workspace-owner-card");
    await user.type(await screen.findByRole("textbox", { name: "Message" }), "Update it now.");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(productClient.workspace).toHaveBeenCalledTimes(2));

    expect(screen.getByTestId("workspace-owner-card")).toBe(ownerCard);
  });

  it("reloads a Project after a committed Agent run start so Run polling can begin", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    const workspaceMock = vi.mocked(productClient.workspace);
    productClient.sendTurn = vi.fn(async () => ({
      mode: "live" as const,
      turn: {
        requestKey: "run-start", state: "complete" as const,
        userMessageId: "message-user", assistantMessageId: "message-assistant",
        skillUses: [],
        actions: [{ id: "action-run", actionKind: "run_start",
          permissionDecision: "allowed" as const, state: "committed" as const,
          errorCode: null }],
        goalVerification: null, failure: null,
      },
      messages: [],
    }));
    render(<App client={productClient} />);

    await user.type(await screen.findByRole("textbox", { name: "Message" }), "Start one Run.");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(workspaceMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("keeps polling an active Project Run after a transient workspace read failure", async () => {
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    const queued = { ...projectWorkspace,
      runs: [{ id: "run-poll", status: "queued", outputs: [] }] } as any;
    const succeeded = { ...queued, runs: [{ id: "run-poll", status: "succeeded",
      outputs: [{ id: "output-poll", logicalName: "poll.json", sampleIndex: 0,
        mediaType: "application/json", sizeBytes: 10 }] }] } as any;
    const workspaceMock = vi.fn()
      .mockResolvedValueOnce(queued)
      .mockRejectedValueOnce(new Error("transient poll failure"))
      .mockResolvedValue(succeeded);
    productClient.workspace = workspaceMock;
    render(<App client={productClient} />);

    expect(await screen.findByRole("button", { name: /^poll\.json-0/u }, { timeout: 3_000 }))
      .toBeInTheDocument();
    expect(workspaceMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("does not report a nonexistent Conversation as busy", async () => {
    history.replaceState({}, "", "/projects/project-one");
    const productClient = client();
    productClient.workspace = vi.fn(async () => ({
      ...workspace,
      conversations: [],
    }));
    productClient.conversations = vi.fn(async () => []);
    render(<App client={productClient} />);

    expect(await screen.findByText("No active Conversations yet."))
      .toBeInTheDocument();
    await waitFor(() => expect(productClient.providers).toHaveBeenCalled());
    expect(screen.getByText("Agent: connecting")).toBeInTheDocument();
    expect(screen.queryByText("Agent: busy")).not.toBeInTheDocument();
  });

  it("creates a blank Project with the discovered provider/model", async () => {
    const user = userEvent.setup();
    const productClient = client();
    render(<App client={productClient} />);

    await user.click(await screen.findByRole("button", { name: "New Project" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "New project");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(productClient.createProject).toHaveBeenCalledWith({
      commandId: expect.any(String),
      name: "New project",
      provider: { providerId: "provider", modelId: "model" },
      source: { kind: "blank" },
    });
    expect(window.location.pathname).toBe("/projects/created-project");
    expect(window.location.search).toBe("?conversation=conversation-main");
  });

  it("offers blank, immutable template, and validated import Project sources", async () => {
    const user = userEvent.setup();
    render(<App client={client()} />);

    await user.click(await screen.findByRole("button", { name: "New Project" }));
    const source = screen.getByRole("combobox", { name: "Source" });
    expect(source).toHaveTextContent("Blank Project");
    expect(source).toHaveTextContent("Project template");
    expect(source).toHaveTextContent("Import archive");
    await user.selectOptions(source, "template");
    expect(screen.getByRole("combobox", { name: "Template" })).toHaveValue("template-one@1.0.0");
    await user.selectOptions(source, "import");
    expect(screen.getByLabelText("Project archive")).toHaveAttribute("type", "file");
  });

  it("honestly disables Project creation when the provider is unavailable", async () => {
    const user = userEvent.setup();
    const readOnlyHome: HomeDto = {
      ...home,
      projects: [],
      providerAvailability: { mode: "read_only", reason: "opencode_unavailable" },
    };
    const productClient = client();
    productClient.home = vi.fn(async () => readOnlyHome);
    render(<App client={productClient} />);

    await user.click(await screen.findByRole("button", { name: "New Project" }));
    expect(screen.getByRole("button", { name: "Create Project" })).toBeDisabled();
    expect(productClient.providers).not.toHaveBeenCalled();
  });

  it("does not let a deprecated mode query replace a Product owner route", async () => {
    history.replaceState({}, "", "/projects/project-one?mode=evidence");
    render(<App client={client()} />);

    await waitFor(() => expect(screen.getByTestId("shell-owner-heading"))
      .toHaveTextContent("Baseline study"));
    expect(screen.queryByText("Wind-turbine maintenance")).not.toBeInTheDocument();
  });

  it("keeps deprecated root mode queries on Product Home", async () => {
    history.replaceState({}, "", "/?mode=legacy");
    render(<App client={client()} />);

    expect(await screen.findByRole("heading", { name: "Build from a conversation." }))
      .toBeInTheDocument();
    expect(screen.queryByText("Legacy queue / OpenCode")).not.toBeInTheDocument();
    expect(screen.queryByText("Wind Evidence Studio")).not.toBeInTheDocument();
  });

  it("renders one global recovery-required state without loading an owner", async () => {
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    productClient.recoveryStatus = vi.fn(async () => ({
      state: "recovery_required" as const,
      code: "product_recovery_failed",
      observedAt: "2026-07-25T00:00:00.000Z",
      retryable: false,
    }));
    render(<App client={productClient} />);

    expect(await screen.findByRole("heading", {
      name: "Riffology is not accepting workspace changes yet.",
    })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Projects, Conversations, Runs, and visual access remain unavailable.",
    );
    expect(screen.getByText("2026-07-25T00:00:00.000Z")).toBeInTheDocument();
    expect(screen.queryByTestId("shell-owner-heading")).not.toBeInTheDocument();
    expect(productClient.workspace).not.toHaveBeenCalled();
    expect(productClient.home).not.toHaveBeenCalled();
  });

  it("renders durable Conversation cards and keeps provider/lifecycle controls direct", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    const richBundle: ConversationBundle = {
      conversation: workspace.conversations[0],
      messages: [{
        id: "message-user",
        ordinal: 0,
        role: "user",
        status: "complete",
        messageKind: "conversation",
        text: "Inspect the input.",
        createdAt: "2026-07-25T00:00:01.000Z",
        updatedAt: "2026-07-25T00:00:01.000Z",
      }],
      attachments: [{
        id: "attachment-one",
        originalName: "input.json",
        purpose: "experiment input",
        mediaType: "application/json",
        sizeBytes: 12,
        sha256: "a".repeat(64),
        createdAt: "2026-07-25T00:00:00.000Z",
      }],
      documents: [{
        id: "document-one",
        sourceMessageId: "message-user",
        name: "Working note",
        documentState: "draft",
        mediaType: "text/markdown",
        lifecycleState: "active",
        createdAt: "2026-07-25T00:00:02.000Z",
        updatedAt: "2026-07-25T00:00:02.000Z",
      }],
      skillUses: [{
        id: "skill-one",
        skillId: "generic-model-edit",
        skillVersion: "1",
        routingMode: "explicit",
        loadState: "loaded",
      }],
      actions: [{
        id: "action-one",
        actionKind: "temporary_document_create",
        permissionDecision: "allowed",
        state: "committed",
        errorCode: null,
      }],
    };
    productClient.conversationBundle = vi.fn(async () => richBundle);
    render(<App client={productClient} />);

    expect(await screen.findByText("Inspect the input.")).toBeInTheDocument();
    expect(screen.getAllByText("input.json")).toHaveLength(2);
    expect(screen.getByText("Working note")).toBeInTheDocument();
    expect(screen.getByText("Skill: generic-model-edit")).toBeInTheDocument();
    expect(screen.getByText("temporary_document_create")).toBeInTheDocument();
    expect(screen.queryByText("objectFileId")).not.toBeInTheDocument();
    expect(screen.queryByText("Applied")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Update provider" }));
    expect(productClient.changeConversationProvider).toHaveBeenCalledWith({
      commandId: expect.any(String),
      conversationId: "conversation-main",
      expectedRecordDigest: "c".repeat(64),
      providerId: "provider",
      modelId: "model",
    });

    await user.click(screen.getByText("Manage Conversation"));
    const name = screen.getByRole("textbox", { name: "Conversation name" });
    await user.clear(name);
    await user.type(name, "Renamed thread");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(productClient.renameConversation).toHaveBeenCalledWith({
      commandId: expect.any(String),
      conversationId: "conversation-main",
      expectedRecordDigest: "c".repeat(64),
      name: "Renamed thread",
    });
  });

  it("shows Applied only for a committed sanitized direct mutation receipt", async () => {
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    productClient.conversationBundle = vi.fn(async () => ({
      conversation: workspace.conversations[0],
      messages: [],
      attachments: [],
      documents: [],
      skillUses: [],
      actions: [{
        id: "action-direct-apply",
        actionKind: "model_files_mutate",
        permissionDecision: "allowed" as const,
        state: "committed" as const,
        errorCode: null,
        mutationReceipt: {
          operation: "direct_apply" as const,
          receiptDigest: "9".repeat(64),
          beforeWorkspaceDigest: "8".repeat(64),
          afterWorkspaceDigest: "7".repeat(64),
          committedAt: "2026-07-28T00:00:00.000Z",
          files: [{
            relativePath: "code/model.py",
            priorSha256: "6".repeat(64),
            proposedSha256: "5".repeat(64),
          }],
        },
      }],
    }));
    render(<App client={productClient} />);

    const applied = (await screen.findByText("Applied")).closest("[role='status']")!;
    expect(applied).toHaveTextContent("Applied");
    expect(applied).toHaveTextContent("9".repeat(64));
    expect(applied).toHaveTextContent("1 file committed");
    expect(applied).not.toHaveTextContent("itemId");
    expect(applied).not.toHaveTextContent("objectFileId");
  });

  it("shows the committed Project file receipt as 文件已保存", async () => {
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    productClient.conversationBundle = vi.fn(async () => ({
      conversation: workspace.conversations[0],
      messages: [],
      attachments: [],
      documents: [],
      skillUses: [],
      actions: [{
        id: "action-project-write",
        actionKind: "project_files_write",
        permissionDecision: "allowed" as const,
        state: "committed" as const,
        errorCode: null,
        mutationReceipt: {
          state: "committed" as const,
          receiptDigest: "4".repeat(64),
          beforeWorkspaceDigest: "3".repeat(64),
          afterWorkspaceDigest: "2".repeat(64),
          committedAt: "2026-08-11T00:00:00.000Z",
          files: [{
            relativePath: "notes/result.md",
            priorSha256: null,
            afterSha256: "1".repeat(64),
          }],
        },
      }],
    }));
    render(<App client={productClient} />);

    const saved = (await screen.findByText("文件已保存")).closest("[role='status']")!;
    expect(saved).toHaveTextContent("4".repeat(64));
    expect(saved).toHaveTextContent("1 file committed");
  });

  it("shows connecting then durable read-only without fabricating an assistant reply", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    const initialBundle: ConversationBundle = {
      conversation: workspace.conversations[0],
      messages: [],
      attachments: [],
      documents: [],
      skillUses: [],
      actions: [],
    };
    const readOnlyBundle: ConversationBundle = {
      ...initialBundle,
      conversation: {
        ...workspace.conversations[0],
        provider: { ...workspace.conversations[0].provider, locked: true },
        sessionState: "read_only",
      },
      messages: [{
        id: "message-accepted",
        ordinal: 0,
        role: "user",
        status: "complete",
        messageKind: "conversation",
        text: "Create a note.",
        createdAt: "2026-07-25T00:00:01.000Z",
        updatedAt: "2026-07-25T00:00:01.000Z",
      }],
    };
    productClient.conversationBundle = vi.fn()
      .mockResolvedValueOnce(initialBundle)
      .mockResolvedValue(readOnlyBundle);
    productClient.sendTurn = vi.fn(async () => ({
      mode: "read_only" as const,
      reason: "opencode_unavailable",
      turn: {
        requestKey: "request-one",
        state: "read_only" as const,
        userMessageId: "message-accepted",
        assistantMessageId: null,
        skillUses: [],
        actions: [],
        goalVerification: null,
        failure: { code: "opencode_unavailable", retryable: true },
      },
      messages: readOnlyBundle.messages,
    }));
    render(<App client={productClient} />);

    const message = await screen.findByRole("textbox", { name: "Message" });
    await user.type(message, "Create a note.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Create a note.")).toBeInTheDocument();
    expect(screen.getByText("Agent: read only")).toBeInTheDocument();
    expect(screen.queryByText("Assistant")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(productClient.sendTurn).toHaveBeenCalledWith({
      requestKey: expect.any(String),
      conversationId: "conversation-main",
      text: "Create a note.",
      attachmentIds: [],
    });
  });

  it("does not let a late turn result overwrite a newly selected Conversation", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    let resolveTurn!: (value: Awaited<ReturnType<ProductClient["sendTurn"]>>) => void;
    const pendingTurn = new Promise<Awaited<ReturnType<ProductClient["sendTurn"]>>>(
      (resolve) => { resolveTurn = resolve; },
    );
    let mainFailed = false;
    const bundleFor = (conversationId: string): ConversationBundle => ({
      conversation: {
        ...(workspace.conversations.find((item) => item.id === conversationId)
          ?? workspace.conversations[0]),
        ...(conversationId === "conversation-main" && mainFailed
          ? { sessionState: "read_only" as const }
          : {}),
      },
      messages: conversationId === "conversation-review"
        ? [{
          id: "message-review",
          ordinal: 0,
          role: "user",
          status: "complete",
          messageKind: "conversation",
          text: "Beta remains selected.",
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:00.000Z",
        }]
        : mainFailed
          ? [{
            id: "message-main",
            ordinal: 0,
            role: "user",
            status: "complete",
            messageKind: "conversation",
            text: "Alpha failed late.",
            createdAt: "2026-07-25T00:00:00.000Z",
            updatedAt: "2026-07-25T00:00:00.000Z",
          }]
          : [],
      attachments: [],
      documents: [],
      skillUses: [],
      actions: [],
    });
    productClient.conversationBundle = vi.fn(async (conversationId) =>
      bundleFor(conversationId));
    productClient.sendTurn = vi.fn(() => pendingTurn);
    render(<App client={productClient} />);

    const ownerCard = await screen.findByTestId("workspace-owner-card");
    const message = await screen.findByRole("textbox", { name: "Message" });
    await user.type(message, "Start slow Alpha turn.");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(screen.getByRole("link", { name: "Review" }));
    expect(await screen.findByText("Beta remains selected.")).toBeInTheDocument();

    mainFailed = true;
    resolveTurn({
      mode: "read_only",
      reason: "opencode_unavailable",
      turn: {
        requestKey: "late-alpha",
        state: "failed",
        userMessageId: "message-main",
        assistantMessageId: null,
        skillUses: [],
        actions: [],
        goalVerification: null,
        failure: { code: "opencode_unavailable", retryable: true },
      },
      messages: bundleFor("conversation-main").messages,
    });
    await waitFor(() =>
      expect(productClient.conversationBundle).toHaveBeenCalledTimes(3));

    expect(screen.getByText("Beta remains selected.")).toBeInTheDocument();
    expect(screen.queryByText("Alpha failed late.")).not.toBeInTheDocument();
    expect(screen.getByText("Agent: idle")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.getByTestId("workspace-owner-card")).toBe(ownerCard);
  });

  it("projects sanitized waiting-for-user activity and submits typed permission and multi-question responses", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    productClient.agents = vi.fn(async () => ({
      mode: "live" as const,
      agents: [{ name: "planner", label: "Planner", description: "Plans scoped work." }],
    }));
    productClient.conversationRuntime = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: "runtime-digest-4",
      status: "waiting_for_user" as const,
      activeTurn: {
        requestKey: "turn-public-one",
        canStop: true,
        canRetry: false,
      },
      parts: [{
        id: "part-tool",
        kind: "tool_call" as const,
        state: "complete" as const,
        title: "Inspect workspace",
        summary: "Read the current Model structure.",
      }, {
        id: "part-result",
        kind: "tool_result" as const,
        state: "complete" as const,
        title: "Workspace inspected",
        summary: "Three declared files are available.",
      }, {
        id: "part-error",
        kind: "error" as const,
        state: "failed" as const,
        title: "A bounded step failed",
        summary: "Retry is available after confirmation.",
      }],
      pendingInteractions: [{
        id: "permission-public-one",
        kind: "permission" as const,
        title: "Allow Model update",
        prompt: "Allow this scoped change for this turn only?",
        decisions: ["allow_once", "reject"] as const,
      }, {
        id: "question-public-one",
        kind: "question" as const,
        title: "Choose output details",
        questions: [{
          prompt: "Which views should be enabled?",
          multiple: true,
          custom: false,
          choices: [
            { value: "chart", label: "Chart" },
            { value: "table", label: "Table" },
          ],
        }, {
          prompt: "Add a short note",
          multiple: false,
          custom: true,
          choices: [],
        }],
      }],
      goalVerification: null,
      agent: { selectedName: "planner", locked: true },
      mcp: { state: "connected" as const, label: "Scoped Model tools" },
      rawPayload: "secret-capability-must-not-render",
    } as any));
    productClient.subscribeConversationRuntime = vi.fn(async () => () => {});
    productClient.respondConversationInteraction = vi.fn(async () => ({}));
    productClient.stopConversation = vi.fn(async () => ({}));
    render(<App client={productClient} />);

    expect(await screen.findByText("Agent: waiting for user")).toBeInTheDocument();
    expect(screen.getByText("Inspect workspace")).toBeInTheDocument();
    expect(screen.getByText("Workspace inspected")).toBeInTheDocument();
    expect(screen.getByText("A bounded step failed")).toBeInTheDocument();
    expect(screen.getByText("MCP: Scoped Model tools")).toBeInTheDocument();
    expect(screen.queryByText("secret-capability-must-not-render")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Agent for this turn" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Answer 2" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Allow once & Resume" }));
    expect(productClient.respondConversationInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-main",
        interactionId: "permission-public-one",
        kind: "permission",
        decision: "allow_once",
      }),
    );

    await user.click(screen.getByRole("checkbox", { name: "Chart" }));
    await user.click(screen.getByRole("checkbox", { name: "Table" }));
    await user.type(screen.getByRole("textbox", { name: "Answer 2" }), "Keep labels concise.");
    await user.click(screen.getByRole("button", { name: "Send answers & Resume" }));
    expect(productClient.respondConversationInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-main",
        interactionId: "question-public-one",
        kind: "question",
        response: { answers: [["chart", "table"], ["Keep labels concise."]] },
      }),
    );
  });

  it("shows an SSE waiting state while the original send request remains pending", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    let project!: (value: any) => void;
    productClient.conversationRuntime = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: "runtime-stale-failed",
      status: "failed" as const,
      activeTurn: { requestKey: "previous-turn", canStop: false, canRetry: true },
      parts: [],
      pendingInteractions: [],
      goalVerification: null,
      agent: { selectedName: null, locked: false },
      mcp: { state: "disconnected" as const, label: "Riff tools" },
    }));
    productClient.subscribeConversationRuntime = vi.fn(async (_id, onProjection) => {
      project = onProjection;
      return () => {};
    });
    productClient.sendTurn = vi.fn(() => new Promise<never>(() => {}));
    render(<App client={productClient} />);

    await user.type(await screen.findByRole("textbox", { name: "Message" }), "Need approval.");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Agent: busy")).toBeInTheDocument();

    project({
      schemaVersion: 1,
      revision: "runtime-waiting",
      status: "waiting_for_user",
      activeTurn: { requestKey: "turn-pending", canStop: true, canRetry: false },
      parts: [],
      pendingInteractions: [{
        id: "permission-pending",
        kind: "permission",
        title: "Allow scoped work",
        prompt: "Allow this once?",
        decisions: ["allow_once", "reject"],
      }],
      agent: { selectedName: null, locked: true },
      mcp: { state: "connected", label: "Riff tools" },
    });

    expect(await screen.findByText("Agent: waiting for user")).toBeInTheDocument();
    expect(screen.getByText("Allow scoped work")).toBeInTheDocument();
  });

  it("restores a bounded terminal goal result and keeps follow-up messaging available", async () => {
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    productClient.conversationRuntime = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: "runtime-goal-needs-input",
      status: "waiting_for_user" as const,
      activeTurn: null,
      parts: [],
      pendingInteractions: [],
      goalVerification: {
        disposition: "needs_user_input" as const,
        reasonCode: "visual_model_goal_unverified",
        receiptDigest: "a".repeat(64),
        evidence: {
          openCodeTerminal: "idle" as const,
          intentKind: "project_visual" as const,
          actionCount: 1,
          terminalActionCount: 1,
          committedActionCount: 1,
          affectedResourceCount: 2,
          ownerStateVerified: false,
          partialEffect: false,
        },
      },
      agent: { selectedName: null, locked: false },
      mcp: { state: "disconnected" as const, label: "Riff tools" },
    }));
    productClient.subscribeConversationRuntime = vi.fn(async () => () => {});
    render(<App client={productClient} />);

    expect(await screen.findByText("Needs your input")).toBeInTheDocument();
    expect(screen.getByText(/durable evidence cannot prove/u)).toBeInTheDocument();
    expect(screen.getByText(/1 committed of 1 recorded actions/u)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.queryByText("visual_model_goal_unverified")).not.toBeInTheDocument();
    expect(screen.queryByText("a".repeat(64))).not.toBeInTheDocument();
  });

  it("labels durable response delivery without claiming workspace satisfaction", async () => {
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    productClient.conversationRuntime = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: "runtime-response-delivered",
      status: "idle" as const,
      activeTurn: null,
      parts: [],
      pendingInteractions: [],
      goalVerification: {
        disposition: "completed" as const,
        reasonCode: "durable_response_delivered",
        receiptDigest: "b".repeat(64),
        evidence: {
          openCodeTerminal: "idle" as const,
          intentKind: "response_delivery" as const,
          actionCount: 0,
          terminalActionCount: 0,
          committedActionCount: 0,
          affectedResourceCount: 0,
          ownerStateVerified: false,
          partialEffect: false,
        },
      },
      agent: { selectedName: null, locked: false },
      mcp: { state: "disconnected" as const, label: "Riff tools" },
    }));
    productClient.subscribeConversationRuntime = vi.fn(async () => () => {});
    render(<App client={productClient} />);

    expect(await screen.findByText("Response delivered")).toBeInTheDocument();
    expect(screen.getByText(/assistant response was durably recorded/u)).toBeInTheDocument();
    expect(screen.getByText(/No workspace outcome is claimed/u)).toBeInTheDocument();
    expect(screen.queryByText("Goal verified")).not.toBeInTheDocument();
    expect(screen.queryByText(/durable workspace satisfies/u)).not.toBeInTheDocument();
  });

  it("uses exact active-turn Stop and terminal Retry contracts while replacing full runtime snapshots", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    let project!: (value: any) => void;
    productClient.conversationRuntime = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: "runtime-digest-1",
      status: "busy" as const,
      activeTurn: { requestKey: "turn-old", canStop: true, canRetry: false },
      parts: [{
        id: "streaming-text",
        kind: "text" as const,
        state: "streaming" as const,
        title: "Assistant response",
        summary: "Inspecting the Model.",
      }],
      pendingInteractions: [],
      goalVerification: null,
      agent: { selectedName: null, locked: true },
      mcp: { state: "connected" as const, label: "Scoped Model tools" },
    }));
    productClient.subscribeConversationRuntime = vi.fn(async (_id, onProjection) => {
      project = onProjection;
      return () => {};
    });
    productClient.stopConversation = vi.fn(async () => ({}));
    productClient.retryConversation = vi.fn(async () => ({}));
    render(<App client={productClient} />);

    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(productClient.stopConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-main",
      requestKey: "turn-old",
    }));

    project({
      schemaVersion: 1,
      revision: "runtime-digest-2",
      status: "failed",
      activeTurn: { requestKey: "turn-old", canStop: false, canRetry: true },
      parts: [{
        id: "terminal-error",
        kind: "error",
        state: "failed",
        title: "Provider turn failed",
        summary: "The turn can be retried.",
      }],
      pendingInteractions: [],
      goalVerification: null,
      agent: { selectedName: null, locked: false },
      mcp: { state: "disconnected", label: "Scoped tools released" },
    });
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(productClient.retryConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-main",
      oldRequestKey: "turn-old",
      newRequestKey: expect.any(String),
    }));
  });

  it("keeps a permission card actionable while the retry request remains pending", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/projects/project-one?conversation=conversation-main");
    const productClient = client();
    let project!: (value: any) => void;
    productClient.conversationRuntime = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: "runtime-retryable",
      status: "failed" as const,
      activeTurn: { requestKey: "turn-old", canStop: false, canRetry: true },
      parts: [],
      pendingInteractions: [],
      goalVerification: null,
      agent: { selectedName: null, locked: false },
      mcp: { state: "disconnected" as const, label: "Riff tools" },
    }));
    productClient.subscribeConversationRuntime = vi.fn(async (_id, onProjection) => {
      project = onProjection;
      return () => {};
    });
    productClient.retryConversation = vi.fn(() => new Promise<never>(() => {}));
    productClient.respondConversationInteraction = vi.fn(async () => ({}));
    render(<App client={productClient} />);

    await user.click(await screen.findByRole("button", { name: "Retry" }));
    project({
      schemaVersion: 1,
      revision: "runtime-retry-waiting",
      status: "waiting_for_user",
      activeTurn: { requestKey: "turn-new", canStop: true, canRetry: false },
      parts: [],
      pendingInteractions: [{
        id: "permission-after-retry",
        kind: "permission",
        title: "Allow scoped Model update",
        prompt: "Apply one Model file operation?",
        decisions: ["allow_once", "reject"],
      }],
      goalVerification: null,
      agent: { selectedName: null, locked: true },
      mcp: { state: "connected", label: "Riff tools" },
    });

    const permission = await screen.findByRole("button", { name: "Allow once & Resume" });
    expect(permission).toBeEnabled();
    await user.click(permission);
    expect(productClient.respondConversationInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-main",
        requestKey: "turn-new",
        interactionId: "permission-after-retry",
        kind: "permission",
        decision: "allow_once",
      }),
    );
  });

  it("keeps the Riffology Stage 2 workbench on a non-default route", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    render(<App client={client()} />);

    expect(await screen.findByRole("banner")).toHaveTextContent("Riffology");
    expect(screen.queryByRole("navigation", { name: "项目工作区" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开项目与会话" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "＋ 新会话" })).toBeEnabled();
    expect(screen.getByRole("complementary", { name: "项目对话" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "项目文件与页面查看器" })).toBeInTheDocument();
    expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
    expect(screen.queryByText("Share")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开项目与会话" }));
    expect(await screen.findByRole("region", { name: "项目与会话" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "项目：Baseline study" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "会话：Main · Baseline study" })).toHaveAttribute(
      "href", "/workbench/projects/project-one?conversation=conversation-main",
    );
  });

  it("shows the Stage 3 file rail and renders only a bounded Project file projection", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    productClient.workspace = vi.fn(async () => ({
      owner: { id: "project-one", name: "Baseline study", kind: "project" as const,
        lifecycleState: "active" as const },
      workspaceDigest: "snapshot-digest", executionLock: { state: "unlocked" as const, runId: null, sourceDigest: null },
      execution: workspace.execution,
      executionDescriptionDigest: "execution-digest",
      files: [
        { fileRef: "snapshot-file", relativePath: "analysis/overview.md", mediaType: "text/markdown", sizeBytes: 19, sha256: "f".repeat(64), createdAt: "2026-07-25T00:00:00.000Z", readOnly: true as const },
        { fileRef: "html-file", relativePath: "visuals/replay.html", mediaType: "text/html", sizeBytes: 41, sha256: "e".repeat(64), createdAt: "2026-07-25T00:00:00.000Z", readOnly: true as const },
        { fileRef: "invalid-absolute", relativePath: "/Users/example/secret.md", mediaType: "text/markdown", sizeBytes: 1, sha256: "d".repeat(64), createdAt: "2026-07-25T00:00:00.000Z", readOnly: true as const },
        { fileRef: "invalid-parent", relativePath: "../secret.json", mediaType: "application/json", sizeBytes: 1, sha256: "c".repeat(64), createdAt: "2026-07-25T00:00:00.000Z", readOnly: true as const },
      ],
      conversations: workspace.conversations.map((item) => ({ ...item, owner: { kind: "project" as const, id: "project-one" } })),
      experimentConfigurations: [],
      runs: [{
        id: "run-succeeded", projectId: "project-one",
        experimentConfigurationId: "experiment-one", status: "succeeded" as const,
        requestedSampleCount: 1, createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:02.000Z",
        startedAt: "2026-07-25T00:00:01.000Z",
        finishedAt: "2026-07-25T00:00:02.000Z",
        contractVersion: 4 as const, readOnly: false, legacyDigest: null,
        runKind: "batch" as const, cancelRequestedAt: null, terminalCode: null,
        completionCardDisposition: "published", terminalStatus: "succeeded" as const,
        terminalClosureDigest: "1".repeat(64), lifecycleDigest: "2".repeat(64),
        seedCount: 1, stepOrHorizon: 1, durationMs: 1_000,
        resourceOverview: { samples: 1 },
        sourceDigest: "snapshot-digest",
        reproducibility: "current_source" as const,
        outputs: [{
          id: "output-summary", runId: "run-succeeded", logicalName: "summary.json",
          outputType: "declared", contractVersion: 4 as const, readOnly: false,
          legacyDigest: null, sampleIndex: 0, sampleId: "sample-0",
          declaredRole: "data", mediaType: "application/json", sizeBytes: 18,
          sha256: "3".repeat(64), createdAt: "2026-07-25T00:00:02.000Z",
        }],
      }],
    }));
    productClient.projectFileWorkbenchRenderable = vi.fn(async () => ({
      kind: "markdown" as const, title: "analysis/overview.md", text: "# Snapshot overview",
    }));
    render(<App client={productClient} />);

    expect(await screen.findByRole("navigation", { name: "浏览器导航" })).toBeInTheDocument();
    expect(screen.getByLabelText("页面地址")).toHaveTextContent("riff://project/project-one");
    expect(screen.getByText("OpenCode 1.18.11")).toBeInTheDocument();
    expect(screen.getByText("analysis")).toBeInTheDocument();
    expect(screen.getByText("visuals")).toBeInTheDocument();
    expect(screen.queryByText(/Users|secret/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^overview\.md/u }));
    expect(await screen.findByRole("heading", { name: "Snapshot overview" })).toBeInTheDocument();
    expect(productClient.projectFileWorkbenchRenderable).toHaveBeenCalledWith("project-one", "snapshot-file");
    await user.click(screen.getByRole("button", { name: /^summary\.json-0/u }));
    expect(await screen.findByRole("heading", { name: "fixture output" })).toBeInTheDocument();
    expect(productClient.outputRenderable).toHaveBeenCalledWith(
      "project-one", "run-succeeded", "output-summary",
    );
    await user.click(screen.getByRole("button", { name: "收起文件栏" }));
    expect(screen.getByRole("button", { name: "文件 ↗" })).toHaveAttribute("aria-expanded", "false");
  });

  it("projects the Stage 4 Browser Broker state into the global header and central viewer", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    const opened = {
      schemaVersion: 1 as const,
      conversationGeneration: 4,
      pageGeneration: 8,
      projectedUrl: "riff-app://projects/project-one?conversation=conversation-main",
      trustState: "trusted_riff" as const,
      controlMode: "observer" as const,
      remainingBudget: null,
      recoveryState: "ready" as const,
      canGoBack: true,
      canReload: true,
      expiresAt: "2026-07-25T00:15:00.000Z",
    };
    productClient.browserState = vi.fn(async () => opened);
    productClient.browserOpen = vi.fn(async () => opened);
    productClient.browserScreenshot = vi.fn(async (_conversationId, state) => ({
      schemaVersion: 1 as const,
      pageGeneration: state.pageGeneration,
      contentType: "image/png" as const,
      pngBase64: "iVBORw0KGgo=",
    }));
    productClient.browserBack = vi.fn(async () => ({
      ...opened,
      pageGeneration: 9,
      projectedUrl: "riff-app://projects/project-one/history",
      canGoBack: false,
    }));
    productClient.browserReload = vi.fn(async () => ({ ...opened, pageGeneration: 10 }));
    render(<App client={productClient} />);

    await waitFor(() => expect(screen.getByLabelText("页面地址"))
      .toHaveTextContent("riff-app://projects/project-one?conversation=conversation-main"));
    expect(screen.getByLabelText("受信状态")).toHaveTextContent("受信 Riff");
    expect(await screen.findByRole("img", { name: "Baseline study 的受信浏览器页面观察" }))
      .toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    expect(productClient.browserState).toHaveBeenCalledWith("conversation-main");
    expect(productClient.browserOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /click|type/iu })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "后退" }));
    expect(productClient.browserBack).toHaveBeenCalledWith("conversation-main", opened);
    await waitFor(() => expect(screen.getByLabelText("页面地址"))
      .toHaveTextContent("riff-app://projects/project-one/history"));
    await user.click(screen.getByRole("button", { name: "刷新" }));
    expect(productClient.browserReload).toHaveBeenCalled();
  });

  it("lists the scoped services below files and opens a live Solara frame instead of a screenshot", async () => {
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    const visual = {
      schemaVersion: 1 as const,
      conversationGeneration: 6,
      pageGeneration: 18,
      projectedUrl: "riff-visual://solara/",
      trustState: "trusted_riff" as const,
      controlMode: "observer" as const,
      remainingBudget: null,
      recoveryState: "ready" as const,
      canGoBack: false,
      canReload: true,
      expiresAt: "2026-07-25T00:15:00.000Z",
    };
    productClient.browserState = vi.fn(async () => visual);
    productClient.browserOpen = vi.fn(async () => visual);
    productClient.browserScreenshot = vi.fn(async () => ({
      schemaVersion: 1 as const,
      pageGeneration: visual.pageGeneration,
      contentType: "image/png" as const,
      pngBase64: "iVBORw0KGgo=",
    }));
    productClient.browserServiceFrame = vi.fn(async () => ({
      schemaVersion: 1 as const,
      frameUrl: `/browser/visual-service/${"a".repeat(43)}`,
      expiresAt: "2026-07-25T00:01:00.000Z",
    }));
    productClient.conversationRuntime = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: "service-runtime",
      status: "idle" as const,
      activeTurn: null,
      parts: [],
      pendingInteractions: [],
      goalVerification: null,
      agent: { selectedName: null, locked: false },
      mcp: { state: "connected" as const, label: "Riff Project MCP" },
    }));

    render(<App client={productClient} />);

    expect(await screen.findByText("运行服务")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Solara 可视化仿真.*运行中/u })).toBeEnabled();
    expect(await screen.findByText("Riff Project MCP")).toBeInTheDocument();
    const frame = await screen.findByTitle("可视化仿真服务");
    expect(frame).toHaveAttribute("src", `/browser/visual-service/${"a".repeat(43)}`);
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(productClient.browserServiceFrame).toHaveBeenCalledWith("conversation-main", visual);
    expect(screen.queryByRole("img", { name: "General maintenance 的受信浏览器页面观察" }))
      .not.toBeInTheDocument();
  });

  it("automatically opens a running Project visual service through the existing Run frame authority", async () => {
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    const visualRun: ProjectWorkspaceDto["runs"][number] = {
      id: "run-visual-live", projectId: "project-one",
      experimentConfigurationId: "experiment-visual", status: "running",
      requestedSampleCount: 1, createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:01.000Z", startedAt: "2026-07-25T00:00:01.000Z",
      finishedAt: null, contractVersion: 4, readOnly: false, legacyDigest: null,
      runKind: "visual", cancelRequestedAt: null, terminalCode: null,
      completionCardDisposition: null, terminalStatus: null, terminalClosureDigest: null,
      lifecycleDigest: "4".repeat(64), seedCount: 1, stepOrHorizon: 10,
      durationMs: null, resourceOverview: null, outputs: [],
      sourceDigest: "5".repeat(64),
      reproducibility: "current_source",
    };
    productClient.workspace = vi.fn(async () => ({ ...projectWorkspace, runs: [visualRun] }));
    productClient.issueVisualFrame = vi.fn(async () => ({
      schemaVersion: 1 as const,
      frameUrl: `http://localhost:8788/frame/redeem/${"b".repeat(43)}`,
      expiresAt: "2026-07-25T00:01:00.000Z",
    }));

    render(<App client={productClient} />);

    expect(await screen.findByRole("button", { name: /可视化 Run.*运行中/u })).toBeEnabled();
    const frame = await screen.findByTitle("可视化仿真服务");
    expect(frame).toHaveAttribute("src", `http://localhost:8788/frame/redeem/${"b".repeat(43)}`);
    expect(productClient.issueVisualFrame).toHaveBeenCalledWith("project-one", "run-visual-live");
  });

  it("polls Browser Agent control and exposes only the header Agent menu controls", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    const observer = {
      schemaVersion: 1 as const,
      conversationGeneration: 4,
      pageGeneration: 20,
      projectedUrl: "riff-app://projects/project-one?conversation=conversation-main",
      trustState: "trusted_riff" as const,
      controlMode: "observer" as const,
      remainingBudget: null,
      recoveryState: "ready" as const,
      canGoBack: true,
      canReload: true,
      expiresAt: "2026-07-25T00:15:00.000Z",
    };
    const agent = { ...observer, controlMode: "agent" as const, remainingBudget: 7 };
    let current: any = observer;
    let reads = 0;
    productClient.browserState = vi.fn(async () => {
      reads += 1;
      if (reads === 2 && current.controlMode === "observer") current = agent;
      return current;
    });
    productClient.browserOpen = vi.fn(async () => observer);
    productClient.browserScreenshot = vi.fn(async (_conversationId, state) => ({
      schemaVersion: 1 as const,
      pageGeneration: state.pageGeneration,
      contentType: "image/png" as const,
      pngBase64: "iVBORw0KGgo=",
    }));
    productClient.conversationRuntime = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: "runtime-menu",
      status: "busy" as const,
      activeTurn: { requestKey: "turn-menu-exact", canStop: true, canRetry: false },
      parts: [],
      pendingInteractions: [],
      goalVerification: null,
      agent: { selectedName: null, locked: true },
      mcp: { state: "connected" as const, label: "Riff tools" },
    }));
    productClient.stopConversation = vi.fn(async () => ({}));
    productClient.browserTakeover = vi.fn(async () => {
      current = { ...observer, pageGeneration: 21, controlMode: "human" as const };
      return current;
    });
    productClient.browserReturn = vi.fn(async () => {
      current = { ...observer, pageGeneration: 22 };
      return current;
    });
    render(<App client={productClient} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Agent 状态：控制中" }))
      .toBeInTheDocument(), { timeout: 2_500 });
    expect(screen.getByRole("button", { name: "后退" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    expect(screen.queryByRole("region", { name: /控制/u })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Agent 状态：控制中" }));
    expect(screen.getByText("剩余动作 7")).toBeInTheDocument();
    const pause = screen.getByRole("menuitem", { name: "暂停当前轮次" });
    await waitFor(() => expect(pause).toBeEnabled());
    await user.click(pause);
    expect(productClient.stopConversation).toHaveBeenCalledWith({
      conversationId: "conversation-main",
      requestKey: "turn-menu-exact",
    });

    await user.click(screen.getByRole("button", { name: "Agent 状态：控制中" }));
    await user.click(screen.getByRole("menuitem", { name: "人工接管浏览器" }));
    expect(productClient.browserTakeover).toHaveBeenCalledWith("conversation-main", agent);
    await waitFor(() => expect(screen.getByRole("button", { name: "Agent 状态：人工" }))
      .toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Agent 状态：人工" }));
    await user.click(screen.getByRole("menuitem", { name: "交还为观察模式" }));
    expect(productClient.browserReturn).toHaveBeenCalledWith(
      "conversation-main",
      expect.objectContaining({ controlMode: "human", pageGeneration: 21 }),
    );
  });

  it("renews an expired Browser Broker observation only through explicit alias open", async () => {
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    const expired = {
      schemaVersion: 1 as const,
      conversationGeneration: 4,
      pageGeneration: 700,
      projectedUrl: "riff-app://projects/project-one",
      trustState: "none" as const,
      controlMode: "observer" as const,
      remainingBudget: null,
      recoveryState: "expired" as const,
      canGoBack: false,
      canReload: false,
      expiresAt: "2026-07-25T00:15:00.000Z",
    };
    const renewed = {
      ...expired,
      pageGeneration: 701,
      trustState: "trusted_riff" as const,
      recoveryState: "ready" as const,
      canReload: true,
      expiresAt: "2026-07-25T00:30:00.000Z",
    };
    productClient.browserState = vi.fn(async () => expired);
    productClient.browserOpen = vi.fn(async () => renewed);
    productClient.browserScreenshot = vi.fn(async (_conversationId, state) => ({
      schemaVersion: 1 as const,
      pageGeneration: state.pageGeneration,
      contentType: "image/png" as const,
      pngBase64: "iVBORw0KGgo=",
    }));
    render(<App client={productClient} />);

    await waitFor(() => expect(productClient.browserOpen)
      .toHaveBeenCalledWith("conversation-main", "riff-app"));
    expect(productClient.browserScreenshot).toHaveBeenCalledWith("conversation-main", renewed);
    expect(screen.getByLabelText("页面地址")).toHaveTextContent("riff-app://projects/project-one");
  });

  it("creates a Project and first Conversation directly from the workbench", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/workbench/new");
    const productClient = client();
    render(<App client={productClient} />);

    const name = await screen.findByRole("textbox", { name: "项目名称" });
    await user.clear(name);
    await user.type(name, "维修队列验收");
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }),
      JSON.stringify(["provider", "model"]));
    await user.click(screen.getByRole("button", { name: "创建项目" }));

    expect(productClient.createProject).toHaveBeenCalledWith({
      commandId: expect.any(String),
      name: "维修队列验收",
      provider: { providerId: "provider", modelId: "model" },
      source: { kind: "blank" },
    });
    expect(window.location.pathname).toBe("/workbench/projects/created-project");
    expect(window.location.search).toBe("?conversation=conversation-main");
  });

  it("fails the workbench composer and new-session action closed when Provider is read-only", async () => {
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    productClient.providers = vi.fn(async () => ({
      mode: "read_only" as const,
      reason: "opencode_unavailable" as const,
      providerModels: [] as const,
    }));
    productClient.conversationBundle = vi.fn(async () => ({
      conversation: { ...workspace.conversations[0], sessionState: "read_only" as const },
      messages: [{
        id: "message-existing",
        ordinal: 1,
        role: "assistant" as const,
        status: "complete" as const,
        messageKind: "conversation" as const,
        text: "Existing durable history",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
      }],
      attachments: [], documents: [], skillUses: [], actions: [],
    }));
    render(<App client={productClient} />);

    expect(await screen.findByText("Existing durable history")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "＋ 新会话" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.getAllByText(/provider is unavailable/u).length).toBeGreaterThan(0);
  });

  it("clears ready owner and browser projections when Riff enters recovery-required", async () => {
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    let recoveryRequired = false;
    productClient.recoveryStatus = vi.fn(async () => recoveryRequired ? {
      state: "recovery_required" as const,
      code: "product_recovery_failed",
      observedAt: "2026-07-25T00:00:03.000Z",
      retryable: false,
    } : {
      state: "ready" as const,
      observedAt: "2026-07-25T00:00:00.000Z",
    });
    render(<App client={productClient} />);

    expect(await screen.findByRole("button", { name: "打开项目与会话" }))
      .toBeInTheDocument();
    recoveryRequired = true;
    window.dispatchEvent(new Event("riff:workbench-navigation"));

    expect(await screen.findByRole("heading", { name: "工作台需要恢复" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "项目：Baseline study" }))
      .not.toBeInTheDocument();
    expect(screen.queryByLabelText("页面地址")).toHaveTextContent("riff://unavailable");
    expect(screen.queryByLabelText("受信状态")).toHaveTextContent("未连接");
    expect(screen.queryByRole("img", { name: /受信浏览器页面观察/u }))
      .not.toBeInTheDocument();
  });

  it("discards an in-flight Browser screenshot after recovery revokes authority", async () => {
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    let recoveryRequired = false;
    productClient.recoveryStatus = vi.fn(async () => recoveryRequired ? {
      state: "recovery_required" as const,
      code: "product_recovery_failed",
      observedAt: "2026-07-25T00:00:03.000Z",
      retryable: false,
    } : {
      state: "ready" as const,
      observedAt: "2026-07-25T00:00:00.000Z",
    });
    const browser = {
      schemaVersion: 1 as const,
      conversationGeneration: 4,
      pageGeneration: 8,
      projectedUrl: "riff-app://projects/project-one?conversation=conversation-main",
      trustState: "trusted_riff" as const,
      controlMode: "observer" as const,
      remainingBudget: null,
      recoveryState: "ready" as const,
      canGoBack: false,
      canReload: true,
      expiresAt: "2026-07-25T00:15:00.000Z",
    };
    productClient.browserState = vi.fn(async () => browser);
    let resolveScreenshot!: (value: {
      schemaVersion: 1;
      pageGeneration: number;
      contentType: "image/png";
      pngBase64: string;
    }) => void;
    productClient.browserScreenshot = vi.fn(() => new Promise<{
      schemaVersion: 1;
      pageGeneration: number;
      contentType: "image/png";
      pngBase64: string;
    }>((resolve) => {
      resolveScreenshot = resolve;
    }));
    render(<App client={productClient} />);

    await waitFor(() => expect(productClient.browserScreenshot).toHaveBeenCalledTimes(1));
    recoveryRequired = true;
    window.dispatchEvent(new Event("riff:workbench-navigation"));
    expect(await screen.findByRole("heading", { name: "工作台需要恢复" }))
      .toBeInTheDocument();
    resolveScreenshot({
      schemaVersion: 1,
      pageGeneration: browser.pageGeneration,
      contentType: "image/png",
      pngBase64: "iVBORw0KGgo=",
    });

    await waitFor(() => expect(screen.queryByRole("img", { name: /受信浏览器页面观察/u }))
      .not.toBeInTheDocument());
    expect(screen.getByLabelText("页面地址")).toHaveTextContent("riff://unavailable");
    expect(screen.getByLabelText("受信状态")).toHaveTextContent("未连接");
  });

  it("does not let an older ready load repopulate the rail after recovery-required", async () => {
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    let recoveryReads = 0;
    productClient.recoveryStatus = vi.fn(async () => ++recoveryReads === 1 ? {
      state: "ready" as const, observedAt: "2026-07-25T00:00:00.000Z",
    } : {
      state: "recovery_required" as const, code: "product_recovery_failed",
      observedAt: "2026-07-25T00:00:01.000Z", retryable: false,
    });
    let resolveHome!: (value: Awaited<ReturnType<ProductClient["home"]>>) => void;
    productClient.home = vi.fn(() => new Promise<Awaited<ReturnType<ProductClient["home"]>>>(
      (resolve) => { resolveHome = resolve; },
    ));
    render(<App client={productClient} />);
    await waitFor(() => expect(productClient.home).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("riff:workbench-navigation"));
    expect(await screen.findByRole("heading", { name: "工作台需要恢复" }))
      .toBeInTheDocument();
    resolveHome(home);
    await waitFor(() => expect(screen.getByRole("heading", { name: "工作台需要恢复" }))
      .toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "项目与会话" })).not.toBeInTheDocument();
  });

  it("restarts Browser observation after an owner reload in the same Conversation", async () => {
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    let projectedUrl = "riff-app://projects/project-one/before";
    productClient.browserState = vi.fn(async () => ({
      schemaVersion: 1 as const,
      conversationGeneration: 4,
      pageGeneration: projectedUrl.endsWith("before") ? 8 : 9,
      projectedUrl,
      trustState: "trusted_riff" as const,
      controlMode: "observer" as const,
      remainingBudget: null,
      recoveryState: "ready" as const,
      canGoBack: false,
      canReload: true,
      expiresAt: "2026-07-25T00:15:00.000Z",
    }));
    render(<App client={productClient} />);

    await waitFor(() => expect(screen.getByLabelText("页面地址"))
      .toHaveTextContent("riff-app://projects/project-one/before"));
    projectedUrl = "riff-app://projects/project-one/after";
    window.dispatchEvent(new Event("riff:workbench-navigation"));

    await waitFor(() => expect(screen.getByLabelText("页面地址"))
      .toHaveTextContent("riff-app://projects/project-one/after"));
    expect(productClient.browserState).toHaveBeenCalledTimes(2);
  });

  it("never projects Project A while a same-kind Project B workspace load is pending", async () => {
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    productClient.home = vi.fn(async () => ({
      ...home,
      projects: [...home.projects, {
        ...home.projects[0]!, id: "project-two", name: "Second study",
      }],
    }));
    let resolveSecond!: (value: typeof projectWorkspace) => void;
    productClient.workspace = vi.fn(async (id) => {
      if (id !== "project-two") return projectWorkspace;
      return new Promise<typeof projectWorkspace>((resolve) => { resolveSecond = resolve; });
    });
    render(<App client={productClient} />);
    expect(await screen.findByRole("complementary", { name: "项目对话" }))
      .toBeInTheDocument();

    history.pushState({}, "", "/workbench/projects/project-two");
    window.dispatchEvent(new Event("riff:workbench-navigation"));
    await waitFor(() => expect(productClient.workspace).toHaveBeenCalledWith(
      "project-two",
    ));
    expect(screen.queryByRole("complementary", { name: "项目对话" }))
      .not.toBeInTheDocument();
    expect(screen.queryByText("Baseline study / Project Conversation"))
      .not.toBeInTheDocument();
    expect(screen.getByText("新项目 / Agent 引导")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agent 状态：未接管" }))
      .toBeInTheDocument();
    expect(screen.getByLabelText("页面地址")).not.toHaveTextContent("project-one");

    resolveSecond({
      ...projectWorkspace,
      owner: { ...projectWorkspace.owner, id: "project-two", name: "Second study" },
      conversations: projectWorkspace.conversations.map((conversation) => ({
        ...conversation,
        id: "conversation-second",
        owner: { kind: "project" as const, id: "project-two" },
      })),
    });
    expect(await screen.findByText("Second study / Project Conversation"))
      .toBeInTheDocument();
  });

  it("rejects the removed Model workbench route without loading a workspace", async () => {
    history.replaceState({}, "", "/workbench/models/model-one");
    const productClient = client();
    render(<App client={productClient} />);

    expect(await screen.findByRole("heading", { name: "没有这个工作台" })).toBeInTheDocument();
    expect(productClient.workspace).not.toHaveBeenCalled();
  });

  it("uses Riffology as the default entry and keeps the legacy surface behind a local configuration switch", async () => {
    (globalThis as { __RIFFOLOGY_TEST_LEGACY_FALLBACK__?: boolean })
      .__RIFFOLOGY_TEST_LEGACY_FALLBACK__ = false;
    history.replaceState({}, "", "/");
    const defaultEntry = render(<App client={client()} />);

    expect(await screen.findByRole("banner")).toHaveTextContent("Riffology");
    expect(screen.getByRole("button", { name: "打开项目与会话" })).toBeInTheDocument();
    expect(window.location.pathname).toMatch(/^\/workbench\/new\//u);
    expect(screen.queryByRole("button", { name: "New Model" })).not.toBeInTheDocument();

    defaultEntry.unmount();
    history.replaceState({}, "", "/?mode=legacy");
    const legacyModeQuery = render(<App client={client()} />);
    expect(await screen.findByRole("banner")).toHaveTextContent("Riffology");
    expect(screen.queryByText("Legacy queue / OpenCode")).not.toBeInTheDocument();

    legacyModeQuery.unmount();
    history.replaceState({}, "", "/?mode=evidence");
    render(<App client={client()} />);
    expect(await screen.findByRole("banner")).toHaveTextContent("Riffology");

    (globalThis as { __RIFFOLOGY_TEST_LEGACY_FALLBACK__?: boolean })
      .__RIFFOLOGY_TEST_LEGACY_FALLBACK__ = true;
    history.replaceState({}, "", "/");
    render(<App client={client()} />);
    expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
  });
});
