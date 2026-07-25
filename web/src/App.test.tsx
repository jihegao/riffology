import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { ProductClient } from "./product/api";
import type { HomeDto, ProviderDiscovery, WorkspaceDto } from "./product/types";

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
  conversations: [{
    id: "conversation-main",
    name: "Main",
    lifecycleState: "active",
    provider: { providerId: "provider", modelId: "model", locked: false },
    sessionState: "none",
    updatedAt: "2026-07-25T00:00:00.000Z",
  }, {
    id: "conversation-review",
    name: "Review",
    lifecycleState: "active",
    provider: { providerId: "provider", modelId: "model", locked: false },
    sessionState: "none",
    updatedAt: "2026-07-25T00:00:00.000Z",
  }],
};

const client = (): ProductClient => ({
  home: vi.fn(async () => home),
  providers: vi.fn(async () => providers),
  createModel: vi.fn(async () => ({
    model: { id: "created-model", name: "Created", lifecycleState: "active" as const },
    conversation: workspace.conversations[0],
  })),
  createProject: vi.fn(async () => ({
    project: { id: "created-project", name: "Created", lifecycleState: "active" as const },
  })),
  workspace: vi.fn(async () => workspace),
});

describe("Stage 4 Product entry", () => {
  afterEach(() => history.replaceState({}, "", "/"));

  it("renders separate Model and Project collections with all four entry types", async () => {
    render(<App client={client()} />);

    expect(await screen.findByRole("heading", { name: "Models" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Model" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Project" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Model" })).toHaveAttribute("href", "/models/model-one");
    expect(screen.getByRole("link", { name: "Open Project" })).toHaveAttribute("href", "/projects/project-one");
    expect(screen.queryByText("Wind Evidence Studio")).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy queue / OpenCode")).not.toBeInTheDocument();
  });

  it("uses one shared shell and keeps the right owner DOM mounted across Conversation changes", async () => {
    history.replaceState({}, "", "/models/model-one?conversation=conversation-main");
    const productClient = client();
    render(<App client={productClient} />);

    expect(await screen.findByTestId("shell-owner-heading")).toHaveTextContent("General maintenance");
    const ownerCard = screen.getByTestId("workspace-owner-card");
    screen.getByRole("link", { name: "Review" }).click();

    expect(window.location.pathname).toBe("/models/model-one");
    expect(window.location.search).toBe("?conversation=conversation-review");
    expect(screen.getByTestId("workspace-owner-card")).toBe(ownerCard);
    expect(productClient.workspace).toHaveBeenCalledTimes(1);
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

    expect(await screen.findByTestId("shell-owner-heading")).toHaveTextContent("General maintenance");
    expect(screen.queryByText("Wind-turbine maintenance")).not.toBeInTheDocument();
  });
});
