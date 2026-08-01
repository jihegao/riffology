import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  models: [{
    id: "model-one",
    name: "General maintenance",
    kind: "model",
    lifecycleState: "active",
    technicalStatus: "executable",
    runMode: "both",
    recordDigest: "model-digest",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    recentActivityAt: "2026-07-25T00:00:00.000Z",
    recentActivityKind: "resource_created",
    allowedActions: ["open", "rename", "archive", "trash"],
  }],
  projects: [{
    id: "project-one",
    name: "Baseline study",
    kind: "project",
    lifecycleState: "active",
    sourceModelId: "model-one",
    modelSnapshotDigest: "snapshot-digest",
    lastRun: null,
    recordDigest: "project-digest",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    recentActivityAt: "2026-07-25T00:00:00.000Z",
    recentActivityKind: "resource_created",
    allowedActions: ["open", "rename", "archive", "trash"],
  }],
  newProjectModels: [{
    id: "model-one",
    name: "General maintenance",
    technicalStatus: "executable",
    runMode: "both",
    updatedAt: "2026-07-25T00:00:00.000Z",
    recordDigest: "model-digest",
  }],
};

const providers: ProviderDiscovery = {
  mode: "live",
  providerModels: [{
    providerId: "provider",
    modelId: "model",
    qualifiedId: "provider/model",
  }],
};

const workspace: WorkspaceDto = {
  owner: {
    id: "model-one",
    name: "General maintenance",
    kind: "model",
    lifecycleState: "active",
    technicalStatus: "executable",
  },
  digest: "e".repeat(64),
  execution: {
    schemaVersion: 2,
    runtime: "python",
    runMode: "batch",
    dependencyFile: "environment/requirements.txt",
    inputs: {
      schemaProfile: "riff-json-schema-2020-12-v1",
      schema: { type: "object", additionalProperties: false, properties: {} },
      smoke: {},
    },
    outputs: [{
      logicalName: "summary",
      relativePath: "summary.json",
      mediaType: "application/json",
      required: true,
      role: "data",
    }],
    batch: { entryPoint: "code/riff_entry.py", protocol: "riff-batch-v1" },
    cancellation: { signal: "SIGTERM", graceMs: 500 },
  },
  files: [],
  conversations: [{
    id: "conversation-main",
    owner: { kind: "model", id: "model-one" },
    name: "Main",
    lifecycleState: "active",
    recordDigest: "c".repeat(64),
    provider: { providerId: "provider", modelId: "model", locked: false },
    sessionState: "none",
    updatedAt: "2026-07-25T00:00:00.000Z",
  }, {
    id: "conversation-review",
    owner: { kind: "model", id: "model-one" },
    name: "Review",
    lifecycleState: "active",
    recordDigest: "d".repeat(64),
    provider: { providerId: "provider", modelId: "model", locked: false },
    sessionState: "none",
    updatedAt: "2026-07-25T00:00:00.000Z",
  }],
};

const projectWorkspace: ProjectWorkspaceDto = {
  owner: {
    id: "project-one",
    name: "Baseline study",
    kind: "project",
    lifecycleState: "active",
  },
  sourceModelId: "model-one",
  modelSnapshotDigest: "snapshot-digest",
  execution: workspace.execution,
  executionDescriptionDigest: "execution-digest",
  files: [],
  conversations: workspace.conversations.map((conversation) => ({
    ...conversation,
    owner: { kind: "project" as const, id: "project-one" },
  })),
  experimentConfigurations: [],
  runs: [],
};

const client = (): ProductClient => ({
  recoveryStatus: vi.fn(async () => ({
    state: "ready" as const,
    observedAt: "2026-07-25T00:00:00.000Z",
  })),
  home: vi.fn(async () => home),
  providers: vi.fn(async () => providers),
  createModel: vi.fn(async () => ({
    model: { id: "created-model", name: "Created", lifecycleState: "active" as const },
    conversation: workspace.conversations[0],
  })),
  createProject: vi.fn(async () => ({
    project: { id: "created-project", name: "Created", lifecycleState: "active" as const },
  })),
  workspace: vi.fn(async (ownerKind) => ownerKind === "project" ? projectWorkspace : workspace),
  startTechnicalCheck: vi.fn(async () => ({
    id: "check-one",
    modelId: "model-one",
    state: "passed" as const,
    publication: "published" as const,
    capturedWorkspaceDigest: "a".repeat(64),
    executionDescriptionDigest: "b".repeat(64),
    aggregate: "executable" as const,
    checks: [],
    startedAt: "2026-07-25T00:00:00.000Z",
    finishedAt: "2026-07-25T00:00:01.000Z",
    claim: "technical_execution_only" as const,
  })),
  modelRenderable: vi.fn(async () => ({
    kind: "json" as const,
    title: "fixture",
    value: {},
  })),
  downloadModelFile: vi.fn(async () => {}),
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
  afterEach(() => {
    history.replaceState({}, "", "/");
    sessionStorage.clear();
  });

  it("renders separate Model and Project collections with all four entry types", async () => {
    render(<App client={client()} />);

    expect(await screen.findByRole("heading", { name: "Models" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Model" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Project" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Open Model" })).toHaveAttribute("href", "/models/model-one");
    expect(await screen.findByRole("link", { name: "Open Project" })).toHaveAttribute("href", "/projects/project-one");
    expect(screen.queryByText("Wind Evidence Studio")).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy queue / OpenCode")).not.toBeInTheDocument();
  });

  it("uses one shared shell and keeps the right owner DOM mounted across Conversation changes", async () => {
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
    const productClient = client();
    render(<App client={productClient} />);

    await waitFor(() => expect(screen.getByTestId("shell-owner-heading"))
      .toHaveTextContent("General maintenance"));
    expect(screen.getAllByRole("heading", { name: "General maintenance" })).toHaveLength(1);
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
    expect(ownerCard).not.toHaveTextContent("General maintenance");
    screen.getByRole("link", { name: "Review" }).click();

    expect(window.location.pathname).toBe("/models/model-one");
    expect(window.location.search).toBe("?conversation=conversation-review");
    expect(screen.getByTestId("workspace-owner-card")).toBe(ownerCard);
    expect(productClient.workspace).toHaveBeenCalledTimes(1);
  });

  it("keeps focus on the pane selector control activated by the user", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
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

  it("refreshes the right workspace after a committed Agent owner mutation without remounting it", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
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
          actionKind: "model_files_mutate",
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

  it("does not report a nonexistent Conversation as busy", async () => {
    history.replaceState({}, "", "/models/model-one");
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

  it("creates a Model from only its name and discovered provider/model", async () => {
    const user = userEvent.setup();
    const productClient = client();
    render(<App client={productClient} />);

    await user.click(await screen.findByRole("button", { name: "New Model" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "New reusable model");
    await user.click(screen.getByRole("button", { name: "Create Model" }));

    expect(productClient.createModel).toHaveBeenCalledWith({
      commandId: expect.any(String),
      name: "New reusable model",
      providerId: "provider",
      modelId: "model",
    });
    expect(window.location.pathname).toBe("/models/created-model");
    expect(window.location.search).toBe("?conversation=conversation-main");
  });

  it("honestly disables creation when provider or executable Model inputs are unavailable", async () => {
    const user = userEvent.setup();
    const readOnlyHome: HomeDto = {
      ...home,
      models: [],
      projects: [],
      newProjectModels: [],
      providerAvailability: { mode: "read_only", reason: "opencode_unavailable" },
    };
    const productClient = client();
    productClient.home = vi.fn(async () => readOnlyHome);
    render(<App client={productClient} />);

    await user.click(await screen.findByRole("button", { name: "New Model" }));
    expect(screen.getByText("OpenCode is unavailable", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Model" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "New Project" }));
    expect(screen.getByText("Create or prepare an executable Model", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Project" })).toBeDisabled();
    expect(productClient.providers).not.toHaveBeenCalled();
  });

  it("does not let a deprecated mode query replace a Product owner route", async () => {
    history.replaceState({}, "", "/models/model-one?mode=evidence");
    render(<App client={client()} />);

    await waitFor(() => expect(screen.getByTestId("shell-owner-heading"))
      .toHaveTextContent("General maintenance"));
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
      "Models, Projects, Conversations, Runs, and visual access remain unavailable.",
    );
    expect(screen.getByText("2026-07-25T00:00:00.000Z")).toBeInTheDocument();
    expect(screen.queryByTestId("shell-owner-heading")).not.toBeInTheDocument();
    expect(productClient.workspace).not.toHaveBeenCalled();
    expect(productClient.home).not.toHaveBeenCalled();
  });

  it("renders durable Conversation cards and keeps provider/lifecycle controls direct", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
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
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
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

  it("shows connecting then durable read-only without fabricating an assistant reply", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
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
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
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
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
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
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
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
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
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
          intentKind: "model_visual" as const,
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
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
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
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
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

  it("keeps the Riffology Stage 2 workbench on a non-default route", async () => {
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    render(<App client={client()} />);

    expect(await screen.findByRole("banner")).toHaveTextContent("Riffology");
    expect(screen.getByRole("navigation", { name: "项目工作区" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新项目" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "＋ 新会话" })).toBeEnabled();
    expect(screen.getByRole("complementary", { name: "项目对话" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "项目文件与页面查看器" })).toBeInTheDocument();
    expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
    expect(screen.queryByText("Share")).not.toBeInTheDocument();
  });

  it("shows the Stage 3 file rail and renders only a bounded Project file projection", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/workbench/projects/project-one?conversation=conversation-main");
    const productClient = client();
    productClient.workspace = vi.fn(async () => ({
      owner: { id: "project-one", name: "Baseline study", kind: "project" as const, lifecycleState: "active" as const },
      sourceModelId: "model-one", modelSnapshotDigest: "snapshot-digest", execution: workspace.execution,
      executionDescriptionDigest: "execution-digest",
      files: [
        { fileRef: "snapshot-file", relativePath: "analysis/overview.md", mediaType: "text/markdown", sizeBytes: 19, sha256: "f".repeat(64), createdAt: "2026-07-25T00:00:00.000Z", readOnly: true as const },
        { fileRef: "html-file", relativePath: "visuals/replay.html", mediaType: "text/html", sizeBytes: 41, sha256: "e".repeat(64), createdAt: "2026-07-25T00:00:00.000Z", readOnly: true as const },
        { fileRef: "invalid-absolute", relativePath: "/Users/example/secret.md", mediaType: "text/markdown", sizeBytes: 1, sha256: "d".repeat(64), createdAt: "2026-07-25T00:00:00.000Z", readOnly: true as const },
        { fileRef: "invalid-parent", relativePath: "../secret.json", mediaType: "application/json", sizeBytes: 1, sha256: "c".repeat(64), createdAt: "2026-07-25T00:00:00.000Z", readOnly: true as const },
      ],
      conversations: workspace.conversations.map((item) => ({ ...item, owner: { kind: "project" as const, id: "project-one" } })),
      experimentConfigurations: [], runs: [],
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

  it("restores an explicit non-authoritative new-project draft after refresh", async () => {
    const user = userEvent.setup();
    history.replaceState({}, "", "/workbench/new");
    const { unmount } = render(<App client={client()} />);

    const draft = await screen.findByRole("textbox", { name: "项目目标" });
    await user.type(draft, "比较两种维修队列配置");
    await user.click(screen.getByRole("button", { name: "保存引导草稿" }));
    expect(screen.getAllByText("比较两种维修队列配置")).toHaveLength(2);
    expect(screen.getByText(/不是 Riff Model \/ Project 权威数据/u)).toBeInTheDocument();

    unmount();
    render(<App client={client()} />);
    expect(await screen.findByDisplayValue("比较两种维修队列配置")).toBeInTheDocument();
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
});
