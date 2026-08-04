import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { ProductClient } from "./api";
import { RendererRegistry, type RendererResource } from "./RendererRegistry";
import { ReviewRail, type ReviewFile } from "./ReviewRail";
import type {
  DiagnosticEventPage,
  ExperimentConfiguration,
  ProjectRun,
  ProjectWorkspaceDto,
  WorkspaceDto,
} from "./types";

export function WorkspacePane({
  client,
  workspace,
  selectedConversationId,
  refresh,
}: Readonly<{
  client: ProductClient;
  workspace: WorkspaceDto;
  selectedConversationId?: string;
  refresh: () => Promise<void>;
}>) {
  return <ProjectWorkspace
    client={client}
    workspace={workspace}
    selectedConversationId={selectedConversationId}
    refresh={refresh}
  />;
}

function ProjectWorkspace({
  client,
  workspace,
  selectedConversationId,
  refresh,
}: Readonly<{
  client: ProductClient;
  workspace: ProjectWorkspaceDto;
  selectedConversationId?: string;
  refresh: () => Promise<void>;
}>) {
  const [selectedExperimentId, setSelectedExperimentId] = useState(
    workspace.experimentConfigurations[0]?.id ?? "",
  );
  const [selectedRunId, setSelectedRunId] = useState(workspace.runs.at(-1)?.id ?? "");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const selectedExperiment = workspace.experimentConfigurations.find(
    (item) => item.id === selectedExperimentId,
  );
  const selectedRun = workspace.runs.find((item) => item.id === selectedRunId);
  const executionLocked = workspace.executionLock.state !== "unlocked";
  const runPriority = selectedRun
    ? ["queued", "running", "cancelling"].includes(selectedRun.status)
      ? "active"
      : selectedRun.terminalStatus || selectedRun.status === "trashed"
        ? "terminal"
        : "planning"
    : "planning";
  const projectFiles = useMemo<readonly ReviewFile[]>(() => workspace.files.map((file) => ({
    key: file.fileRef,
    relativePath: file.relativePath,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  })), [workspace.files]);

  useEffect(() => {
    if (!selectedExperimentId && workspace.experimentConfigurations[0]) {
      setSelectedExperimentId(workspace.experimentConfigurations[0].id);
    }
    if (!selectedRunId && workspace.runs.at(-1)) {
      setSelectedRunId(workspace.runs.at(-1)!.id);
    }
  }, [selectedExperimentId, selectedRunId, workspace]);

  useEffect(() => {
    if (!selectedRun || !["queued", "running", "cancelling"].includes(selectedRun.status)) return;
    const timer = window.setInterval(() => void refresh(), 500);
    return () => window.clearInterval(timer);
  }, [refresh, selectedRun]);

  const act = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(undefined);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(messageOf(cause, "The Project operation failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="product-workbench-layout" data-testid="project-workspace">
      <div className="product-workbench-canvas product-dynamic-workspace">
        <section
          className={`product-workspace-card product-project-priority product-project-priority-${runPriority}`}
          data-testid="workspace-owner-card"
        >
          <span className="product-badge">
            {runPriority === "active"
              ? `${selectedRun?.status} Run`
              : runPriority === "terminal"
                ? `${selectedRun?.status} result`
                : "plan experiment"}
          </span>
          <span className={`product-badge product-badge-${workspace.owner.technicalStatus}`}>
            {workspace.owner.technicalStatus}
          </span>
          <p>
            {runPriority === "active"
              ? "The current Run is active. Direct status and cancellation controls remain available without the Agent."
              : runPriority === "terminal"
                ? "The latest selected Run is terminal. Review outputs and diagnostics before starting another Run."
                : "Create or select an Experiment configuration before starting a frozen Run."}
          </p>
          {executionLocked && <p role="status">
            Execution lock: {workspace.executionLock.state}. Code, dependencies, and the execution contract are read-only until the active execution finishes.
          </p>}
          <button type="button" className="product-secondary"
            disabled={pending || executionLocked}
            onClick={() => void act(() => client.startTechnicalCheck(workspace.owner.id, crypto.randomUUID()))}>
            Run technical check
          </button>
        </section>
        {error && <p role="alert" className="product-form-error">{error}</p>}
        {runPriority === "planning" ? (
          <>
            <ExperimentEditor
              client={client}
              workspace={workspace}
              selected={selectedExperiment}
              selectedId={selectedExperimentId}
              setSelectedId={setSelectedExperimentId}
              pending={pending}
              act={act}
            />
            <RunWorkspace
              client={client}
              workspace={workspace}
              experiment={selectedExperiment}
              selectedConversationId={selectedConversationId}
              selectedRun={selectedRun}
              selectedRunId={selectedRunId}
              setSelectedRunId={setSelectedRunId}
              pending={pending}
              act={act}
            />
          </>
        ) : (
          <>
            <RunWorkspace
              client={client}
              workspace={workspace}
              experiment={selectedExperiment}
              selectedConversationId={selectedConversationId}
              selectedRun={selectedRun}
              selectedRunId={selectedRunId}
              setSelectedRunId={setSelectedRunId}
              pending={pending}
              act={act}
            />
            <ExperimentEditor
              client={client}
              workspace={workspace}
              selected={selectedExperiment}
              selectedId={selectedExperimentId}
              setSelectedId={setSelectedExperimentId}
              pending={pending}
              act={act}
            />
          </>
        )}
        <details className="product-workspace-card product-technical-details">
          <summary>Technical details</summary>
          <p>
            This Project owns its editable code, dependencies, and execution contract.
          </p>
          <dl className="product-facts">
            <div><dt>Workspace digest</dt><dd><code>{workspace.workspaceDigest}</code></dd></div>
            <div><dt>Execution</dt><dd>{workspace.execution.runMode}</dd></div>
            <div><dt>Files</dt><dd>{workspace.files.length}</dd></div>
          </dl>
        </details>
      </div>
      {client.projectFileRenderable && (
        <ReviewRail
          ownerKey={`project:${workspace.owner.id}:${workspace.workspaceDigest}`}
          files={projectFiles}
          loadFile={(file) => client.projectFileRenderable!(workspace.owner.id, file.key)}
        />
      )}
    </div>
  );
}

function ExperimentEditor({
  client,
  workspace,
  selected,
  selectedId,
  setSelectedId,
  pending,
  act,
}: Readonly<{
  client: ProductClient;
  workspace: ProjectWorkspaceDto;
  selected?: ExperimentConfiguration;
  selectedId: string;
  setSelectedId: (id: string) => void;
  pending: boolean;
  act: (action: () => Promise<unknown>) => Promise<void>;
}>) {
  const [name, setName] = useState("Experiment");
  const [configuration, setConfiguration] = useState(() =>
    JSON.stringify(defaultConfiguration(workspace), null, 2));
  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setConfiguration(JSON.stringify(selected.configuration, null, 2));
  }, [selected]);
  const parsed = useMemo(() => parseObject(configuration), [configuration]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextConfiguration = parsed.value;
    if (!nextConfiguration) return;
    void act(async () => {
      const updated = selected?.contractVersion === 4
        ? await client.updateExperiment({
            projectId: workspace.owner.id,
            configId: selected.id,
            commandId: crypto.randomUUID(),
            expectedConfigurationDigest: selected.configurationDigest!,
            expectedRecordDigest: selected.recordDigest!,
            name: name.trim(),
            configuration: nextConfiguration,
          })
        : await client.createExperiment({
            projectId: workspace.owner.id,
            commandId: crypto.randomUUID(),
            name: name.trim(),
            configuration: nextConfiguration,
          });
      setSelectedId(updated.id);
    });
  };
  return (
    <section className="product-workspace-card" aria-labelledby="experiments-heading">
      <div className="product-section-heading">
        <div><p className="product-eyebrow">CONFIGURATION</p><h3 id="experiments-heading">Experiments</h3></div>
        <select aria-label="Experiment configuration" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
          <option value="">New configuration</option>
          {workspace.experimentConfigurations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
      <form onSubmit={submit} className="product-experiment-form">
        <label>Name<input required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>
          Configuration JSON
          <textarea rows={14} spellCheck={false} value={configuration} onChange={(event) => setConfiguration(event.target.value)} />
        </label>
        {parsed.error && <p role="alert" className="product-form-error">{parsed.error}</p>}
        <button type="submit" className="product-primary" disabled={pending || !name.trim() || !parsed.value}>
          {selected ? "Save configuration" : "Create configuration"}
        </button>
      </form>
      {selected?.samplePreview && (
        <>
          <p role="status">
            Deterministic preview: {selected.sampleCount} sample{selected.sampleCount === 1 ? "" : "s"}
            {selected.samplePreviewTruncated ? " (first 100 shown)" : ""}.
          </p>
          <RendererRegistry resource={{
            kind: "table",
            title: "Sample preview",
            caption: `Deterministic sample preview for ${selected.name}`,
            columns: ["Index", "Seed", "Parameters"],
            rows: selected.samplePreview.map((sample) => [
              sample.sampleIndex,
              sample.seed ?? "none",
              sample.parameters,
            ]),
          }} />
        </>
      )}
    </section>
  );
}

function RunWorkspace({
  client,
  workspace,
  experiment,
  selectedConversationId,
  selectedRun,
  selectedRunId,
  setSelectedRunId,
  pending,
  act,
}: Readonly<{
  client: ProductClient;
  workspace: ProjectWorkspaceDto;
  experiment?: ExperimentConfiguration;
  selectedConversationId?: string;
  selectedRun?: ProjectRun;
  selectedRunId: string;
  setSelectedRunId: (id: string) => void;
  pending: boolean;
  act: (action: () => Promise<unknown>) => Promise<void>;
}>) {
  const [events, setEvents] = useState<DiagnosticEventPage>();
  const [eventType, setEventType] = useState("");
  const [eventSample, setEventSample] = useState("");
  const [eventsPending, setEventsPending] = useState(false);
  const [renderedOutput, setRenderedOutput] = useState<RendererResource>();
  const [visualHostUrl, setVisualHostUrl] = useState<string>();
  const [visualFrameUrl, setVisualFrameUrl] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const requestEpoch = useRef(0);
  const selectedRunIdRef = useRef(selectedRunId);
  selectedRunIdRef.current = selectedRunId;
  useEffect(() => () => { requestEpoch.current += 1; }, []);
  const currentRequest = (epoch: number, runId: string): boolean =>
    requestEpoch.current === epoch && selectedRunIdRef.current === runId;
  const start = () => {
    if (!experiment) return;
    void act(async () => {
      const result = await client.startRun({
        projectId: workspace.owner.id,
        commandId: crypto.randomUUID(),
        experimentConfigId: experiment.id,
        ...(experiment.configuration.runKind === "batch" && selectedConversationId
          ? { completionConversationId: selectedConversationId }
          : {}),
      });
      setSelectedRunId(result.runId);
    });
  };
  const terminal = selectedRun?.terminalStatus !== null && selectedRun?.terminalStatus !== undefined;
  return (
    <section className="product-workspace-card" aria-labelledby="runs-heading">
      <div className="product-section-heading">
        <div><p className="product-eyebrow">PLATFORM EXECUTION</p><h3 id="runs-heading">Runs</h3></div>
        <div>
          <button type="button" className="product-primary" disabled={pending || !experiment || experiment.readOnly
            || workspace.executionLock.state !== "unlocked"} onClick={start}>
            Start {String(experiment?.configuration.runKind ?? "batch")} Run
          </button>
        </div>
      </div>
      <p>
        Runs freeze the accepted configuration, sample plan, Project execution identity,
        and platform limits. Results are not automatically analyzed or recommended.
      </p>
      {detailError && <p role="alert" className="product-form-error">{detailError}</p>}
      <select aria-label="Run" value={selectedRunId} onChange={(event) => {
        requestEpoch.current += 1;
        setSelectedRunId(event.target.value);
        setEvents(undefined);
        setEventsPending(false);
        setRenderedOutput(undefined);
        setVisualHostUrl(undefined);
        setVisualFrameUrl(undefined);
        setDetailError(undefined);
      }}>
        <option value="">Select a Run</option>
        {[...workspace.runs].reverse().map((run) => (
          <option key={run.id} value={run.id}>{run.status} · {run.runKind} · {run.id.slice(0, 16)}</option>
        ))}
      </select>
      {selectedRun && (
        <div className="product-run-detail">
          <dl className="product-facts">
            <div><dt>Status</dt><dd>{selectedRun.status}</dd></div>
            <div><dt>Samples</dt><dd>{selectedRun.requestedSampleCount}</dd></div>
            <div><dt>Steps / horizon</dt><dd>{selectedRun.stepOrHorizon ?? "not declared"}</dd></div>
            <div><dt>Seeds</dt><dd>{selectedRun.seedCount}</dd></div>
            <div><dt>Metrics</dt><dd>{workspace.execution.overview?.metricNames?.length ?? 0}</dd></div>
            <div><dt>Duration</dt><dd>{selectedRun.durationMs === null ? "pending" : `${selectedRun.durationMs} ms`}</dd></div>
            <div><dt>Outputs</dt><dd>{selectedRun.outputs.length}</dd></div>
            {terminal && (
              <>
                <div><dt>Terminal status</dt><dd>{selectedRun.terminalStatus ?? selectedRun.status}</dd></div>
                <div><dt>Terminal code</dt><dd><code>{selectedRun.terminalCode ?? "not provided"}</code></dd></div>
              </>
            )}
          </dl>
          {selectedRun.reproducibility === "source_not_retained" && <p role="status" className="product-form-note">
            Source not retained; this historical result cannot be replayed.
          </p>}
          {selectedRun.resourceOverview && (
            <RendererRegistry resource={{
              kind: "json",
              title: "Resource overview",
              value: selectedRun.resourceOverview,
            }} />
          )}
          {["queued", "running", "cancelling"].includes(selectedRun.status) && (
            <button type="button" className="product-danger" disabled={pending} onClick={() =>
              void act(() => client.cancelRun(workspace.owner.id, selectedRun.id, crypto.randomUUID()))}>
              Cancel Run
            </button>
          )}
          {terminal && selectedRun.status !== "trashed" && (
            <button type="button" className="product-danger" disabled={pending} onClick={() =>
              void act(() => client.trashRun({ projectId: workspace.owner.id, run: selectedRun, commandId: crypto.randomUUID() }))}>
              Trash Run
            </button>
          )}
          {selectedRun.status === "trashed" && (
            <button type="button" className="product-secondary" disabled={pending} onClick={() =>
              void act(() => client.restoreRun({ projectId: workspace.owner.id, run: selectedRun, commandId: crypto.randomUUID() }))}>
              Restore Run
            </button>
          )}
          {terminal
            && selectedRun.runKind === "batch"
            && selectedRun.outputs.length > 0 && (
            <>
              <RendererRegistry resource={{
                kind: "table",
                title: "Published outputs",
                caption: `Digest-checked outputs for Run ${selectedRun.id}`,
                columns: ["Output", "Sample", "Role", "Media type", "Bytes", "SHA-256", "Download"],
                rows: selectedRun.outputs.map((output) => [
                  output.logicalName,
                  output.sampleIndex,
                  output.declaredRole,
                  output.mediaType,
                  output.sizeBytes,
                  output.sha256,
                  "Use the download link below",
                ]),
              }} />
              <div className="product-downloads">
                {selectedRun.outputs.map((output) => (
                  <div key={output.id}>
                    <button type="button" className="product-link-button" onClick={() =>
                      void client.downloadOutput(workspace.owner.id, selectedRun.id, output.id)
                        .catch((cause) => setDetailError(messageOf(cause, "The output could not be downloaded.")))}>
                      Download {output.logicalName} · sample {output.sampleIndex}
                    </button>
                    {" · "}
                    <button type="button" className="product-link-button" onClick={() => {
                      const epoch = requestEpoch.current;
                      const runId = selectedRun.id;
                      void client.outputRenderable(workspace.owner.id, runId, output.id)
                        .then((resource) => {
                          if (currentRequest(epoch, runId)) setRenderedOutput(resource);
                        })
                        .catch((cause) => {
                          if (currentRequest(epoch, runId)) {
                            setDetailError(messageOf(cause, "The output could not be rendered."));
                          }
                        });
                    }}>
                      Render safely
                    </button>
                  </div>
                ))}
              </div>
              {renderedOutput && <RendererRegistry resource={renderedOutput} />}
              <div className="product-event-filters" aria-label="Diagnostic event filters">
                <label>
                  Event type
                  <input value={eventType} onChange={(event) => setEventType(event.target.value)} />
                </label>
                <label>
                  Sample index
                  <input
                    inputMode="numeric"
                    value={eventSample}
                    onChange={(event) => setEventSample(event.target.value)}
                  />
                </label>
                <button type="button" className="product-secondary" disabled={eventsPending} onClick={() => {
                  const sampleIndex = eventSample === "" ? undefined : Number(eventSample);
                  if (sampleIndex !== undefined && (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0)) {
                    setDetailError("Sample index must be a non-negative integer.");
                    return;
                  }
                  setDetailError(undefined);
                  setEventsPending(true);
                  const epoch = requestEpoch.current;
                  const runId = selectedRun.id;
                  void client.diagnosticEvents(workspace.owner.id, runId, {
                    ...(eventType ? { type: eventType } : {}),
                    ...(sampleIndex === undefined ? {} : { sampleIndex }),
                  })
                    .then((page) => {
                      if (currentRequest(epoch, runId)) setEvents(page);
                    })
                    .catch((cause) => {
                      if (currentRequest(epoch, runId)) {
                        setDetailError(messageOf(cause, "Diagnostic events could not be loaded."));
                      }
                    })
                    .finally(() => {
                      if (currentRequest(epoch, runId)) setEventsPending(false);
                    });
                }}>
                  {eventsPending ? "Loading diagnostic events…" : "Load diagnostic events"}
                </button>
              </div>
              {events && <RendererRegistry resource={{
                kind: "table",
                title: "Diagnostic events",
                caption: `Bounded diagnostic events for Run ${selectedRun.id}`,
                columns: ["Sequence", "Sample", "Type", "Occurred at", "Payload"],
                rows: events.items.map((event) => [
                  event.sequence,
                  event.sampleIndex,
                  event.type,
                  event.occurredAt ?? "model time only",
                  event.payload,
                ]),
              }} />}
              {events?.nextCursor && (
                <button type="button" className="product-secondary" disabled={eventsPending} onClick={() => {
                  setEventsPending(true);
                  const epoch = requestEpoch.current;
                  const runId = selectedRun.id;
                  void client.diagnosticEvents(workspace.owner.id, runId, {
                    cursor: events.nextCursor ?? undefined,
                    ...(eventType ? { type: eventType } : {}),
                    ...(eventSample === "" ? {} : { sampleIndex: Number(eventSample) }),
                  }).then((page) => {
                    if (currentRequest(epoch, runId)) {
                      setEvents({
                        ...page,
                        items: [...events.items, ...page.items],
                      });
                    }
                  }).catch((cause) => {
                    if (currentRequest(epoch, runId)) {
                      setDetailError(messageOf(cause, "More diagnostic events could not be loaded."));
                    }
                  }).finally(() => {
                    if (currentRequest(epoch, runId)) setEventsPending(false);
                  });
                }}>
                  Load more diagnostic events
                </button>
              )}
              <p>To analyze outputs, ask in the selected Conversation. Riff never creates an analysis document automatically.</p>
            </>
          )}
          {terminal
            && selectedRun.runKind === "batch"
            && selectedRun.outputs.length === 0
            && typeof client.diagnosticEvents === "function" && (
            <>
              <p className="product-empty" role="status">
                This terminal Run published no outputs. Diagnostic events may still explain
                its terminal state.
              </p>
              <div className="product-event-filters" aria-label="Diagnostic event filters">
                <label>
                  Event type
                  <input value={eventType} onChange={(event) => setEventType(event.target.value)} />
                </label>
                <label>
                  Sample index
                  <input
                    inputMode="numeric"
                    value={eventSample}
                    onChange={(event) => setEventSample(event.target.value)}
                  />
                </label>
                <button type="button" className="product-secondary" disabled={eventsPending} onClick={() => {
                  const sampleIndex = eventSample === "" ? undefined : Number(eventSample);
                  if (sampleIndex !== undefined && (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0)) {
                    setDetailError("Sample index must be a non-negative integer.");
                    return;
                  }
                  setDetailError(undefined);
                  setEventsPending(true);
                  const epoch = requestEpoch.current;
                  const runId = selectedRun.id;
                  void client.diagnosticEvents(workspace.owner.id, runId, {
                    ...(eventType ? { type: eventType } : {}),
                    ...(sampleIndex === undefined ? {} : { sampleIndex }),
                  }).then((page) => {
                    if (currentRequest(epoch, runId)) setEvents(page);
                  }).catch((cause) => {
                    if (currentRequest(epoch, runId)) {
                      setDetailError(messageOf(cause, "Diagnostic events could not be loaded."));
                    }
                  }).finally(() => {
                    if (currentRequest(epoch, runId)) setEventsPending(false);
                  });
                }}>
                  {eventsPending ? "Loading diagnostic events…" : "Load diagnostic events"}
                </button>
              </div>
              {events && <RendererRegistry resource={{
                kind: "table",
                title: "Diagnostic events",
                caption: `Bounded diagnostic events for Run ${selectedRun.id}`,
                columns: ["Sequence", "Sample", "Type", "Occurred at", "Payload"],
                rows: events.items.map((event) => [
                  event.sequence,
                  event.sampleIndex,
                  event.type,
                  event.occurredAt ?? "model time only",
                  event.payload,
                ]),
              }} />}
              <p>To analyze a failed or interrupted Run, ask in the selected Conversation. Riff never creates an analysis document automatically.</p>
            </>
          )}
          {selectedRun.runKind === "visual" && ["running", "cancelling"].includes(selectedRun.status) && (
            <>
              <button type="button" className="product-primary" onClick={() =>
                {
                  const epoch = requestEpoch.current;
                  const runId = selectedRun.id;
                  setDetailError(undefined);
                  setVisualFrameUrl(undefined);
                  void client.issueVisualFrame(workspace.owner.id, runId)
                    .then((issued) => {
                      if (currentRequest(epoch, runId)) {
                        setVisualFrameUrl(issued.frameUrl);
                      }
                    })
                    .catch((cause) => {
                      if (currentRequest(epoch, runId)) {
                        setDetailError(messageOf(
                          cause,
                          "The embedded visual simulation is unavailable.",
                        ));
                      }
                    });
                }}>
                Embed visual simulation
              </button>
              <button type="button" className="product-secondary" onClick={() =>
                {
                  const epoch = requestEpoch.current;
                  const runId = selectedRun.id;
                  setDetailError(undefined);
                  void (async () => {
                    for (let attempt = 0; attempt < 20; attempt += 1) {
                      try {
                        const url = await client.visualHostUrl(workspace.owner.id, runId);
                        if (currentRequest(epoch, runId)) setVisualHostUrl(url);
                        return;
                      } catch (cause) {
                        if (!currentRequest(epoch, runId)) return;
                        const code = cause && typeof cause === "object"
                          ? (cause as { code?: unknown }).code
                          : undefined;
                        if (code !== "visual_frame_unavailable" || attempt === 19) {
                          setDetailError(messageOf(cause, "The restricted visual frame is unavailable."));
                          return;
                        }
                        await new Promise((resolve) => window.setTimeout(resolve, 100));
                      }
                    }
                  })();
                }}>
                Open restricted visual frame
              </button>
              {visualFrameUrl && (
                <div className="product-embedded-visual">
                  <div>
                    <strong>Embedded visual simulation</strong>
                    <button
                      type="button"
                      className="product-link-button"
                      onClick={() => setVisualFrameUrl(undefined)}
                    >
                      Close
                    </button>
                  </div>
                  <iframe
                    className="product-visual-frame"
                    title="Embedded Project visual simulation"
                    src={visualFrameUrl}
                    sandbox="allow-scripts allow-same-origin"
                    referrerPolicy="no-referrer"
                  />
                </div>
              )}
              {visualHostUrl && (
                window.location.origin === new URL(visualHostUrl).origin
                  ? (
                    <a
                      className="product-primary"
                      href={visualHostUrl}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      Continue to restricted visual frame
                    </a>
                    )
                  : (
                    <div role="status" className="product-notice">
                      <p>
                        The development proxy cannot impersonate the trusted platform origin.
                        Open this exact local platform URL as a direct browser navigation.
                      </p>
                      <code data-testid="visual-host-url">{visualHostUrl}</code>
                    </div>
                    )
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

const defaultConfiguration = (workspace: ProjectWorkspaceDto): Record<string, unknown> => ({
  schemaVersion: 1,
  runKind: workspace.execution.runMode === "visual" ? "visual" : "batch",
  parameters: workspace.execution.inputs.smoke,
  sampling: { kind: "single", seed: 1 },
});

const parseObject = (value: string): Readonly<{
  value?: Record<string, unknown>;
  error?: string;
}> => {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Configuration must be one JSON object." };
    }
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: "Configuration JSON is invalid." };
  }
};

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;
