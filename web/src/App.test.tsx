import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { ProductClient } from "./product/api";
import type { HomeDto, ProjectWorkspaceDto } from "./product/types";

const project = {
  id: "project-one",
  name: "Baseline study",
  kind: "project" as const,
  lifecycleState: "active" as const,
  technicalStatus: "executable" as const,
  workspaceDigest: "a".repeat(64),
  executionLock: { state: "unlocked" as const, runId: null, sourceDigest: null },
  lastRun: null,
  recordDigest: "b".repeat(64),
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
  recentActivityAt: "2026-08-04T00:00:00.000Z",
  recentActivityKind: "resource_created",
  allowedActions: ["open"] as const,
};

const home: HomeDto = {
  schemaVersion: 1,
  generatedAt: "2026-08-04T00:00:00.000Z",
  collectionDigest: "c".repeat(64),
  projects: [project],
  templates: [],
  recentConversations: [],
  providerAvailability: { mode: "live", providerModelCount: 1 },
};

const execution: ProjectWorkspaceDto["execution"] = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "batch",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: { type: "object", additionalProperties: false, properties: {} },
    smoke: {},
  },
  outputs: [],
  batch: { entryPoint: "code/riff_entry.py", protocol: "riff-batch-v1" },
  cancellation: { signal: "SIGTERM", graceMs: 500 },
};

const workspace: ProjectWorkspaceDto = {
  owner: {
    id: project.id,
    name: project.name,
    kind: "project",
    lifecycleState: "active",
    technicalStatus: "executable",
  },
  workspaceDigest: project.workspaceDigest,
  execution,
  executionDescriptionDigest: "d".repeat(64),
  executionLock: project.executionLock,
  files: [],
  conversations: [],
  experimentConfigurations: [],
  runs: [],
};

const client = {
  recoveryStatus: vi.fn(async () => ({ state: "ready" as const, observedAt: "2026-08-04T00:00:00.000Z" })),
  home: vi.fn(async () => home),
  providers: vi.fn(async () => ({ mode: "live" as const, providerModels: [] })),
  workspace: vi.fn(async () => workspace),
} as unknown as ProductClient;

describe("Project-only workbench", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows only Projects on Home", async () => {
    history.replaceState({}, "", "/workbench/home");
    render(<App client={client} />);
    expect(await screen.findByRole("link", { name: "项目：Baseline study" })).toBeInTheDocument();
    expect(screen.queryByText("Models")).not.toBeInTheDocument();
    expect(screen.queryByText("模型")).not.toBeInTheDocument();
  });

  it("rejects the removed Model workbench route", async () => {
    history.replaceState({}, "", "/workbench/models/model-one");
    render(<App client={client} />);
    expect(await screen.findByRole("heading", { name: "没有这个工作台" })).toBeInTheDocument();
    expect(client.workspace).not.toHaveBeenCalled();
  });

  it("loads a Project workspace from the Project-only client contract", async () => {
    history.replaceState({}, "", "/workbench/projects/project-one");
    render(<App client={client} />);
    expect(await screen.findByRole("heading", { name: "Baseline study" })).toBeInTheDocument();
    expect(client.workspace).toHaveBeenCalledWith("project-one");
    expect(screen.getByLabelText("项目文件与页面查看器")).toBeInTheDocument();
  });
});
