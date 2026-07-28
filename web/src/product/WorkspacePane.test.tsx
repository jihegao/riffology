import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProductClient } from "./api";
import type { RendererResource } from "./RendererRegistry";
import type {
  GeneratedViewSet,
  ModelChangeSet,
  ModelMutationReceipt,
  ModelWorkspaceDto,
  ProjectWorkspaceDto,
} from "./types";
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

const modelWorkspace = (): ModelWorkspaceDto => ({
  owner: {
    id: "model-one",
    name: "Dynamic model",
    kind: "model",
    lifecycleState: "active",
    technicalStatus: "executable",
  },
  digest: "7".repeat(64),
  execution,
  files: [{
    id: "file-one",
    relativePath: "code/model.py",
    mediaType: "text/x-python",
    sizeBytes: 18,
    sha256: "8".repeat(64),
  }],
  conversations: [],
});

const generatedSet = (
  titles: readonly string[],
  freshness: "fresh" | "stale" = "fresh",
): GeneratedViewSet => ({
  sourceWorkspaceDigest: freshness === "fresh" ? "7".repeat(64) : "6".repeat(64),
  currentWorkspaceDigest: "7".repeat(64),
  setDigest: `${titles.length}`.repeat(64),
  freshness,
  publishedAt: "2026-07-28T00:00:00.000Z",
  views: titles.map((title, index) => ({
    id: `view-${index}`,
    title,
    position: titles.length - index,
    rendererKind: "markdown",
    mediaType: "text/markdown",
    payloadDigest: `${index + 1}`.repeat(64),
    sourceFileRefs: index === 0 ? ["code/model.py"] : [],
  })),
});

const modelClient = (
  views: GeneratedViewSet | null,
  changes: readonly ModelChangeSet[] = [],
): ProductClient => ({
  generatedViews: vi.fn(async () => views),
  generatedViewRenderable: vi.fn(async (_modelId, viewId) => ({
    kind: "markdown" as const,
    title: `Rendered ${viewId}`,
    text: `Content for ${viewId}`,
  })),
  modelChangeSets: vi.fn(async () => changes),
  modelRenderable: vi.fn(async () => ({
    kind: "code" as const,
    title: "code/model.py",
    language: "python",
    text: "print('current')",
  })),
  startTechnicalCheck: vi.fn(async () => {
    throw new Error("unused");
  }),
  downloadModelFile: vi.fn(async () => {}),
} as unknown as ProductClient);

describe("dynamic Model workspace", () => {
  it.each([
    { titles: [] as string[], expected: "No generated views" },
    { titles: ["Agent-selected map"], expected: "Agent-selected map" },
    {
      titles: ["Source trail", "Queue topology", "Operational sketch"],
      expected: "Operational sketch",
    },
  ])("supports $titles.length generated views without a fixed view schema", async ({
    titles,
    expected,
  }) => {
    const productClient = modelClient(generatedSet(titles));
    render(<WorkspacePane
      client={productClient}
      workspace={modelWorkspace()}
      refresh={vi.fn(async () => {})}
    />);

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("model-spec.json")).toBeNull();
    if (titles.length > 1) {
      const buttons = screen.getAllByRole("button", {
        name: /Source trail|Queue topology|Operational sketch/u,
      });
      expect(buttons.map((button) => button.textContent)).toEqual([
        "Operational sketch",
        "Queue topology",
        "Source trail",
      ]);
    }
  });

  it("shows stale projections read-only and discards a late renderable after view selection", async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise<unknown>((resolve) => { resolveFirst = resolve; });
    const productClient = modelClient(generatedSet(["Old projection", "Current projection"], "stale"));
    productClient.generatedViewRenderable = vi.fn(async (
      _modelId,
      viewId,
    ): Promise<RendererResource> =>
      viewId === "view-1"
        ? { kind: "markdown", title: "Current projection", text: "Current wins." }
        : first as Promise<RendererResource>);
    render(<WorkspacePane
      client={productClient}
      workspace={modelWorkspace()}
      refresh={vi.fn(async () => {})}
    />);

    expect(await screen.findByText(/captured from an earlier Model workspace/u))
      .toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Current projection" }));
    expect(await screen.findByText("Current wins.")).toBeInTheDocument();
    resolveFirst({ kind: "markdown", title: "Late", text: "Late must not win." });
    await Promise.resolve();
    expect(screen.queryByText("Late must not win.")).toBeNull();
  });

  it("clears old fresh/apply state on digest change and settles capabilities independently", async () => {
    const oldChange: ModelChangeSet = {
      id: "old-change",
      baseWorkspaceDigest: "6".repeat(64),
      currentWorkspaceDigest: "7".repeat(64),
      changeSetDigest: "4".repeat(64),
      freshness: "fresh",
      state: "pending",
      createdAt: "2026-07-28T00:00:00.000Z",
      resolvedAt: null,
      files: [{
        itemId: "old-item",
        kind: "modify",
        relativePath: "code/model.py",
        mediaType: "text/x-python",
        priorSha256: "8".repeat(64),
        proposedSha256: "3".repeat(64),
        proposedText: "print('old proposal')",
      }],
    };
    let resolveViews!: (value: GeneratedViewSet | null) => void;
    let rejectChanges!: (cause: Error) => void;
    const productClient = modelClient(generatedSet(["Old fresh projection"]), [oldChange]);
    productClient.generatedViews = vi.fn()
      .mockResolvedValueOnce(generatedSet(["Old fresh projection"]))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveViews = resolve; }));
    productClient.modelChangeSets = vi.fn()
      .mockResolvedValueOnce([oldChange])
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectChanges = reject;
      }));
    const rendered = render(<WorkspacePane
      client={productClient}
      workspace={modelWorkspace()}
      refresh={vi.fn(async () => {})}
    />);

    expect(await screen.findByText("Old fresh projection")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Changes · 1" })).toBeInTheDocument();
    rendered.rerender(<WorkspacePane
      client={productClient}
      workspace={{ ...modelWorkspace(), digest: "9".repeat(64) }}
      refresh={vi.fn(async () => {})}
    />);

    expect(screen.queryByText("Old fresh projection")).toBeNull();
    expect(screen.queryByRole("button", { name: "Changes · 1" })).toBeNull();
    expect(screen.getByText("Loading generated views…")).toBeInTheDocument();
    await act(async () => resolveViews(null));
    expect(await screen.findByText("No generated views")).toBeInTheDocument();
    expect(screen.queryByText("Change review unavailable")).toBeNull();
    await act(async () => rejectChanges(new Error("Change service unavailable.")));
    expect(await screen.findByText("Change review unavailable")).toBeInTheDocument();
    expect(screen.getByText("Change service unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply whole change set" })).toBeNull();
  });

  it("opens a source file and applies only a fresh whole change set with digest guards", async () => {
    const change: ModelChangeSet = {
      id: "change-one",
      baseWorkspaceDigest: "5".repeat(64),
      currentWorkspaceDigest: "7".repeat(64),
      changeSetDigest: "4".repeat(64),
      freshness: "fresh",
      state: "pending",
      createdAt: "2026-07-28T00:00:00.000Z",
      resolvedAt: null,
      files: [{
        itemId: "item-one",
        kind: "modify",
        relativePath: "code/model.py",
        mediaType: "text/x-python",
        priorSha256: "8".repeat(64),
        proposedSha256: "3".repeat(64),
        proposedText: "print('proposed')",
      }],
    };
    const productClient = modelClient(generatedSet(["Agent projection"]), [change]);
    const mutationReceipt: ModelMutationReceipt = {
      schemaVersion: 1,
      commandId: "command-one",
      operation: "apply",
      modelId: "model-one",
      changeSetId: "change-one",
      changeSetDigest: "4".repeat(64),
      beforeWorkspaceDigest: "7".repeat(64),
      afterWorkspaceDigest: "2".repeat(64),
      files: [],
      committedAt: "2026-07-28T00:00:01.000Z",
      receiptDigest: "1".repeat(64),
    };
    productClient.applyModelChangeSet = vi.fn(async () => mutationReceipt);
    const refresh = vi.fn(async () => {});
    render(<WorkspacePane
      client={productClient}
      workspace={modelWorkspace()}
      refresh={refresh}
    />);

    const sourceOpener = (await screen.findAllByRole("button", {
      name: "code/model.py",
    }))[0]!;
    await userEvent.click(sourceOpener);
    expect((await screen.findAllByRole("button", { name: /code\/model.py/u })).at(-1))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /^Close$/u }));
    await waitFor(() => expect(sourceOpener).toHaveFocus());
    await userEvent.click(sourceOpener);
    await userEvent.click(screen.getByRole("button", { name: "Changes · 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Apply whole change set" }));

    await waitFor(() => expect(productClient.applyModelChangeSet).toHaveBeenCalledWith({
      modelId: "model-one",
      changeSetId: "change-one",
      commandId: expect.any(String),
      expectedChangeSetDigest: "4".repeat(64),
      expectedWorkspaceDigest: "7".repeat(64),
    }));
    expect(refresh).toHaveBeenCalled();
    expect(await screen.findByText("Applied")).toBeInTheDocument();
  });
});

describe("dynamic Project workspace", () => {
  it("prioritizes configuration in a Project with no Experiment and keeps Run start disabled", () => {
    const empty: ProjectWorkspaceDto = {
      ...workspace(),
      experimentConfigurations: [],
      runs: [],
    };
    render(<WorkspacePane
      client={client()}
      workspace={empty}
      refresh={vi.fn(async () => {})}
    />);

    expect(screen.getByText("plan experiment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start batch Run" })).toBeDisabled();
    const experimentHeading = screen.getByRole("heading", { name: "Experiments" });
    const runHeading = screen.getByRole("heading", { name: "Runs" });
    expect(experimentHeading.compareDocumentPosition(runHeading)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    { kind: "active" as const, value: workspace("visual"), badge: "running Run" },
    { kind: "terminal" as const, value: workspace(), badge: "succeeded result" },
  ])("puts direct Run controls and results first in the $kind state", ({ value, badge }) => {
    render(<WorkspacePane
      client={client()}
      workspace={value}
      refresh={vi.fn(async () => {})}
    />);

    expect(screen.getByText(badge)).toBeInTheDocument();
    const runHeading = screen.getByRole("heading", { name: "Runs" });
    const experimentHeading = screen.getByRole("heading", { name: "Experiments" });
    expect(runHeading.compareDocumentPosition(experimentHeading)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows failed terminal evidence and exposes diagnostics even without outputs", async () => {
    const base = workspace();
    const failed: ProjectWorkspaceDto = {
      ...base,
      runs: [{
        ...base.runs[0]!,
        status: "failed",
        terminalStatus: "failed",
        terminalCode: "run_process_failed",
        outputs: [],
        resourceOverview: null,
      }],
    };
    const productClient = client();
    render(<WorkspacePane
      client={productClient}
      workspace={failed}
      refresh={vi.fn(async () => {})}
    />);

    expect(screen.getByText("run_process_failed")).toBeInTheDocument();
    expect(screen.getByText(/published no outputs/u)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: /Published outputs/u })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Load diagnostic events" }));
    expect(await screen.findByRole("table", { name: /Bounded diagnostic events/u }))
      .toBeInTheDocument();
    expect(productClient.diagnosticEvents).toHaveBeenCalledWith(
      "project-one",
      "run-one",
      {},
    );
  });

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
