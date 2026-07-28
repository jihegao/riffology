import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProductClient } from "./api";
import type { ProjectWorkspaceDto } from "./types";
import { WorkspacePane } from "./WorkspacePane";

const execution: ProjectWorkspaceDto["execution"] = {
  schemaVersion: 2,
  runtime: "python",
  runMode: "both",
  dependencyFile: "environment/requirements.txt",
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { demand: { type: "number", default: 1 } },
    },
    smoke: { demand: 1 },
  },
  outputs: [{
    logicalName: "summary",
    relativePath: "summary.json",
    mediaType: "application/json",
    required: true,
    role: "data",
  }],
  overview: { stepOrHorizonPointer: "/demand", metricNames: ["processed"] },
  batch: { entryPoint: "code/riff_entry.py", protocol: "riff-batch-v1" },
  visual: { entryPoint: "code/visual.py", protocol: "riff-visual-v1" },
  cancellation: { signal: "SIGTERM", graceMs: 500 },
};

const workspace = (runKind: "batch" | "visual" = "batch"): ProjectWorkspaceDto => ({
  owner: { id: "project-one", name: "Fixed study", kind: "project", lifecycleState: "active" },
  sourceModelId: "model-one",
  modelSnapshotDigest: "a".repeat(64),
  execution,
  executionDescriptionDigest: "b".repeat(64),
  files: [],
  conversations: [],
  experimentConfigurations: [{
    id: "experiment-one",
    projectId: "project-one",
    name: "Two seeds",
    configuration: {
      schemaVersion: 1,
      runKind,
      parameters: { demand: 1 },
      sampling: { kind: "single", seed: 7 },
    },
    estimatedSampleCount: 1,
    lifecycleState: "active",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    contractVersion: 4,
    readOnly: false,
    legacyDigest: null,
    configurationDigest: "c".repeat(64),
    sampleCount: 1,
    recordDigest: "d".repeat(64),
    samplePreview: [{
      sampleIndex: 0,
      sampleId: "e".repeat(64),
      parameters: { demand: 1 },
      seed: 7,
    }],
    samplePreviewTruncated: false,
  }],
  runs: runKind === "batch" ? [{
    id: "run-one",
    projectId: "project-one",
    experimentConfigurationId: "experiment-one",
    status: "succeeded",
    requestedSampleCount: 1,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:01.000Z",
    startedAt: "2026-07-25T00:00:00.000Z",
    finishedAt: "2026-07-25T00:00:01.000Z",
    contractVersion: 4,
    readOnly: false,
    legacyDigest: null,
    runKind: "batch",
    cancelRequestedAt: null,
    terminalCode: "run_succeeded",
    completionCardDisposition: "not_requested",
    terminalStatus: "succeeded",
    terminalClosureDigest: "f".repeat(64),
    lifecycleDigest: "1".repeat(64),
    seedCount: 1,
    stepOrHorizon: 30,
    durationMs: 1_000,
    resourceOverview: { outputFiles: 1 },
    outputs: [{
      id: "output-one",
      runId: "run-one",
      logicalName: "summary",
      outputType: "json",
      sampleIndex: 0,
      sampleId: "e".repeat(64),
      declaredRole: "data",
      mediaType: "application/json",
      sizeBytes: 20,
      sha256: "2".repeat(64),
      createdAt: "2026-07-25T00:00:01.000Z",
    }],
  }] : [{
    id: "run-visual",
    projectId: "project-one",
    experimentConfigurationId: "experiment-one",
    status: "running",
    requestedSampleCount: 1,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:01.000Z",
    startedAt: "2026-07-25T00:00:00.000Z",
    finishedAt: null,
    contractVersion: 4,
    readOnly: false,
    legacyDigest: null,
    runKind: "visual",
    cancelRequestedAt: null,
    terminalCode: null,
    completionCardDisposition: "not_requested",
    terminalStatus: null,
    terminalClosureDigest: null,
    lifecycleDigest: "3".repeat(64),
    seedCount: 1,
    stepOrHorizon: null,
    durationMs: null,
    resourceOverview: null,
    outputs: [],
  }],
});

const client = (): ProductClient => ({
  startRun: vi.fn(async () => ({ runId: "run-new", status: "queued", runKind: "batch", sampleCount: 1 })),
  trashRun: vi.fn(async () => ({})),
  restoreRun: vi.fn(async () => ({})),
  downloadModelFile: vi.fn(async () => {}),
  diagnosticEvents: vi.fn(async () => ({
    items: [{ sequence: 0, sampleIndex: 0, type: "completed", occurredAt: null, payload: { value: 2 } }],
    nextCursor: null,
    truncated: false,
  })),
  outputDownloadHref: vi.fn(() => "/api/output/download"),
  downloadOutput: vi.fn(async () => {}),
  outputRenderable: vi.fn(async () => ({ kind: "json", title: "summary", value: { value: 2 } })),
  issueVisualFrame: vi.fn(async () => ({
    schemaVersion: 1,
    frameUrl: "http://localhost:8788/frame/redeem/opaque",
    expiresAt: "2026-07-25T00:01:00.000Z",
  })),
  visualHostUrl: vi.fn(async () =>
    "http://localhost:8787/browser/projects/project-one/runs/run-visual/visual"),
} as unknown as ProductClient);

describe("dynamic Project workspace", () => {
  it("shows fixed-copy, sample, Run, output and explicit-analysis boundaries", async () => {
    const productClient = client();
    render(<WorkspacePane
      client={productClient}
      workspace={workspace()}
      selectedConversationId="conversation-one"
      refresh={vi.fn(async () => {})}
    />);
    expect(screen.getByText(/immutable Model copy/u)).toBeInTheDocument();
    expect(screen.queryByText(/switch active model/iu)).toBeNull();
    expect(screen.getByText(/Deterministic preview: 1 sample/u)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: /sample preview/u })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download summary/u })).toBeEnabled();
    expect(screen.getByText(/never creates an analysis document automatically/u)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Load diagnostic events" }));
    expect(await screen.findByRole("table", { name: /Bounded diagnostic events/u })).toBeInTheDocument();
    expect(productClient.diagnosticEvents).toHaveBeenCalledWith(
      "project-one",
      "run-one",
      {},
    );

    await userEvent.click(screen.getByRole("button", { name: "Start batch Run" }));
    expect(productClient.startRun).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-one",
      experimentConfigId: "experiment-one",
      completionConversationId: "conversation-one",
    }));
  });

  it("hands the development proxy off to the exact restricted visual host", async () => {
    const productClient = client();
    render(<WorkspacePane
      client={productClient}
      workspace={workspace("visual")}
      refresh={vi.fn(async () => {})}
    />);
    await userEvent.click(screen.getByRole("button", { name: "Open restricted visual frame" }));
    expect(await screen.findByTestId("visual-host-url")).toHaveTextContent(
      "http://localhost:8787/browser/projects/project-one/runs/run-visual/visual",
    );
    expect(screen.getByText(/development proxy cannot impersonate the trusted platform origin/u))
      .toBeVisible();
    await waitFor(() =>
      expect(productClient.visualHostUrl).toHaveBeenCalledWith("project-one", "run-visual"));
  });

  it("embeds one issued visual frame and lets the user close it", async () => {
    const productClient = client();
    render(<WorkspacePane
      client={productClient}
      workspace={workspace("visual")}
      refresh={vi.fn(async () => {})}
    />);

    await userEvent.click(screen.getByRole("button", {
      name: "Embed visual simulation",
    }));
    const frame = await screen.findByTitle("Embedded Project visual simulation");
    expect(frame).toHaveAttribute(
      "src",
      "http://localhost:8788/frame/redeem/opaque",
    );
    expect(frame).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin",
    );
    expect(productClient.issueVisualFrame).toHaveBeenCalledWith(
      "project-one",
      "run-visual",
    );

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTitle("Embedded Project visual simulation")).toBeNull();
  });

  it("keeps a trashed Run selectable so the user can restore it", async () => {
    const productClient = client();
    const base = workspace();
    const trashed: ProjectWorkspaceDto = {
      ...base,
      runs: [{
        ...base.runs[0]!,
        status: "trashed",
        lifecycleDigest: "4".repeat(64),
      }],
    };
    const refresh = vi.fn(async () => {});
    render(<WorkspacePane client={productClient} workspace={trashed} refresh={refresh} />);

    await userEvent.click(screen.getByRole("button", { name: "Restore Run" }));
    expect(productClient.restoreRun).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-one",
      run: expect.objectContaining({ id: "run-one", status: "trashed" }),
    }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("discards stale output and event responses after switching Runs", async () => {
    let resolveOutput!: (value: Awaited<ReturnType<ProductClient["outputRenderable"]>>) => void;
    let resolveEvents!: (value: Awaited<ReturnType<ProductClient["diagnosticEvents"]>>) => void;
    const productClient = client();
    vi.mocked(productClient.outputRenderable).mockReturnValue(new Promise((resolve) => {
      resolveOutput = resolve;
    }));
    vi.mocked(productClient.diagnosticEvents).mockReturnValue(new Promise((resolve) => {
      resolveEvents = resolve;
    }));
    const base = workspace();
    const runOne = base.runs[0]!;
    const runTwo = {
      ...runOne,
      id: "run-two",
      outputs: runOne.outputs.map((output) => ({ ...output, id: "output-two", runId: "run-two" })),
    };
    render(<WorkspacePane
      client={productClient}
      workspace={{ ...base, runs: [runTwo, runOne] }}
      refresh={vi.fn(async () => {})}
    />);

    await userEvent.click(screen.getByRole("button", { name: "Render safely" }));
    await userEvent.click(screen.getByRole("button", { name: "Load diagnostic events" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Run" }), "run-two");
    expect(screen.getByRole("button", { name: "Load diagnostic events" })).toBeEnabled();
    resolveOutput({ kind: "json", title: "stale Run one output", value: { stale: true } });
    resolveEvents({
      items: [{ sequence: 1, sampleIndex: 0, type: "stale", occurredAt: null, payload: {} }],
      nextCursor: null,
      truncated: false,
    });

    await waitFor(() => expect(screen.queryByRole("heading", {
      name: "stale Run one output",
    })).toBeNull());
    expect(screen.queryByRole("table", { name: /Bounded diagnostic events/u })).toBeNull();
  });

  it("discards a stale visual frame authority after switching Runs", async () => {
    let resolveFrame!: (value: string) => void;
    const productClient = client();
    vi.mocked(productClient.visualHostUrl).mockReturnValue(new Promise((resolve) => {
      resolveFrame = resolve;
    }));
    const base = workspace("visual");
    const runOne = base.runs[0]!;
    const runTwo = { ...runOne, id: "run-visual-two" };
    render(<WorkspacePane
      client={productClient}
      workspace={{ ...base, runs: [runTwo, runOne] }}
      refresh={vi.fn(async () => {})}
    />);

    await userEvent.click(screen.getByRole("button", { name: "Open restricted visual frame" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Run" }), "run-visual-two");
    resolveFrame("http://localhost:8787/browser/projects/project-one/runs/run-visual/visual");

    await waitFor(() => expect(screen.queryByTestId("visual-host-url")).toBeNull());
  });
});
