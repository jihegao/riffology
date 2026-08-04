import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProductClient } from "./api";
import { WorkspacePane } from "./WorkspacePane";
import type { ProjectWorkspaceDto } from "./types";

const workspace = (locked = false): ProjectWorkspaceDto => ({
  owner: { id: "project-one", name: "Project", kind: "project", lifecycleState: "active", technicalStatus: "executable" },
  workspaceDigest: "a".repeat(64),
  executionDescriptionDigest: "b".repeat(64),
  executionLock: locked
    ? { state: "running", runId: "run-one", sourceDigest: "a".repeat(64) }
    : { state: "unlocked", runId: null, sourceDigest: null },
  execution: {
    schemaVersion: 2, runtime: "python", runMode: "batch",
    dependencyFile: "environment/requirements.txt",
    inputs: { schemaProfile: "riff-json-schema-2020-12-v1", schema: {}, smoke: {} },
    outputs: [], batch: { entryPoint: "code/main.py", protocol: "riff-batch-v1" },
    cancellation: { signal: "SIGTERM", graceMs: 500 },
  },
  files: [], conversations: [], experimentConfigurations: [],
  runs: locked ? [{
    id: "run-one", projectId: "project-one", experimentConfigurationId: "experiment-one",
    status: "running", requestedSampleCount: 1, createdAt: "now", updatedAt: "now",
    startedAt: "now", finishedAt: null, contractVersion: 4, readOnly: false,
    legacyDigest: null, runKind: "batch", cancelRequestedAt: null, terminalCode: null,
    completionCardDisposition: null, terminalStatus: null, terminalClosureDigest: null,
    lifecycleDigest: null, seedCount: 1, stepOrHorizon: null, durationMs: null,
    resourceOverview: null, sourceDigest: "a".repeat(64), reproducibility: "current_source", outputs: [],
  }] : [{
    id: "run-old", projectId: "project-one", experimentConfigurationId: "experiment-one",
    status: "succeeded", requestedSampleCount: 1, createdAt: "old", updatedAt: "old",
    startedAt: "old", finishedAt: "old", contractVersion: 4, readOnly: false,
    legacyDigest: null, runKind: "batch", cancelRequestedAt: null, terminalCode: null,
    completionCardDisposition: null, terminalStatus: "succeeded", terminalClosureDigest: "c".repeat(64),
    lifecycleDigest: "d".repeat(64), seedCount: 1, stepOrHorizon: null, durationMs: 1,
    resourceOverview: null, sourceDigest: "e".repeat(64), reproducibility: "source_not_retained", outputs: [],
  }],
});

const client = {
  startTechnicalCheck: vi.fn(),
  projectChangeSets: vi.fn(async () => []),
} as unknown as ProductClient;

describe("Project workspace authority", () => {
  it("disables technical checks while the execution lock is active", async () => {
    render(<WorkspacePane client={client} workspace={workspace(true)} refresh={vi.fn(async () => {})} />);
    expect(screen.getByRole("button", { name: "Run technical check" })).toBeDisabled();
    expect(screen.getByText(/Execution lock: running/u)).toBeInTheDocument();
  });

  it("marks historical Runs whose source was not retained as non-replayable", () => {
    render(<WorkspacePane client={client} workspace={workspace()} refresh={vi.fn(async () => {})} />);
    expect(screen.getByText(/Source not retained; this historical result cannot be replayed/u)).toBeInTheDocument();
  });
});
