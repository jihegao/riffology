import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { HttpDemoClient } from "./api";
import { emptyProjectState, reduceProjectPatch } from "./state";
import type { AgentStatus, BrowserEvent, DemoClient, ParameterField, ProjectState, Scalar } from "./types";

type WorkbenchTab = "files" | "parameters" | "run" | "results";
type MobilePane = "conversation" | "workbench";

const tabs: Array<{ id: WorkbenchTab; label: string; panel: string }> = [
  { id: "files", label: "Files", panel: "Workbench files" },
  { id: "parameters", label: "Parameters", panel: "Workbench parameters" },
  { id: "run", label: "Run", panel: "Workbench run" },
  { id: "results", label: "Results", panel: "Workbench results" }
];

const defaultClient = new HttpDemoClient();

function resolveSessionId(): string {
  const fromQuery = new URLSearchParams(window.location.search).get("session");
  return fromQuery ?? import.meta.env.VITE_SESSION_ID ?? "local-demo";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function projectStatus(phase: ProjectState["phase"]): string {
  return ({
    idle: "No model prepared",
    uploading: "Uploading input",
    preparing_model: "Preparing model",
    model_ready: "Model ready",
    running: "Simulation running",
    succeeded: "Simulation succeeded",
    failed: "Simulation failed",
    cancelled: "Simulation cancelled",
    timed_out: "Simulation timed out"
  })[phase];
}

function isRunActive(state: ProjectState): boolean {
  return state.run?.status === "queued" || state.run?.status === "running";
}

function coerceValue(field: ParameterField, raw: string | boolean): Scalar {
  if (field.type === "boolean") return Boolean(raw);
  if (field.type === "number" || field.type === "integer") return Number(raw);
  return String(raw);
}

function validateField(field: ParameterField, value: Scalar | undefined): string | undefined {
  if (field.required && (value === "" || value === undefined || value === null)) return `${field.label} is required.`;
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${field.label} must be a number.`;
    if (field.type === "integer" && !Number.isInteger(value)) return `${field.label} must be an integer.`;
    if (field.minimum !== undefined && value < field.minimum) return `${field.label} must be at least ${field.minimum}.`;
    if (field.maximum !== undefined && value > field.maximum) return `${field.label} must be at most ${field.maximum}.`;
  }
  return undefined;
}

function statusLabel(status: AgentStatus | undefined): string | undefined {
  if (!status) return undefined;
  return ({
    unconfigured: "Assistant is not configured.",
    ready: "Assistant ready.",
    thinking: "Assistant is thinking.",
    waiting_for_action: "Assistant is preparing a workbench action.",
    error: "Assistant is unavailable."
  })[status];
}

function ResultChart({ state }: { state: ProjectState }): ReactElement | null {
  const series = state.results?.timeSeries.series;
  if (!series?.length) return null;
  const values = series[0].values;
  const max = Math.max(...values, 1);
  const points = values
    .map((value, index) => `${(index / Math.max(values.length - 1, 1)) * 280 + 10},${110 - (value / max) * 90}`)
    .join(" ");
  return (
    <figure className="chart-card">
      <svg role="img" aria-label="Simulation time series" viewBox="0 0 300 120">
        <path d="M 10 110 H 290 M 10 10 V 110" className="chart-axis" />
        <polyline points={points} className="chart-line" />
      </svg>
      <figcaption>Time series: {series[0].label} across {values.length} recorded points.</figcaption>
    </figure>
  );
}

export function App({ client = defaultClient, sessionId = resolveSessionId() }: { client?: DemoClient; sessionId?: string }) {
  const [state, setState] = useState<ProjectState>(() => emptyProjectState(sessionId));
  const [connection, setConnection] = useState<"connected" | "reconnecting" | "offline">("reconnecting");
  const [agentEvent, setAgentEvent] = useState<ProjectState["agent"]>();
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("files");
  const [mobilePane, setMobilePane] = useState<MobilePane>("conversation");
  const [composer, setComposer] = useState("");
  const [optimisticText, setOptimisticText] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, Scalar>>({});
  const [requestError, setRequestError] = useState<string>();
  const [pendingUpload, setPendingUpload] = useState<string>();
  const [pendingAction, setPendingAction] = useState<string>();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const installSnapshot = (snapshot: ProjectState) => {
    setState((current) => (snapshot.sessionId === sessionId && snapshot.revision >= current.revision ? snapshot : current));
    setOptimisticText(undefined);
    setDeltas({});
  };

  const refresh = async () => {
    try {
      installSnapshot(await client.getSnapshot(sessionId));
      setConnection("connected");
    } catch (error) {
      setConnection("offline");
      setRequestError(error instanceof Error ? error.message : "Unable to load the local demo state.");
    }
  };

  useEffect(() => {
    void refresh();
    const unsubscribe = client.subscribe(sessionId, (event: BrowserEvent) => {
      if (event.type === "project.snapshot") {
        installSnapshot(event.data);
      } else if (event.type === "project.patch") {
        setState((current) => {
          const outcome = reduceProjectPatch(current, event.data);
          if (outcome.kind === "resync") void refresh();
          if (outcome.kind === "applied") {
            setOptimisticText(undefined);
            setDeltas((currentDeltas) => {
              const next = { ...currentDeltas };
              outcome.state.conversation.forEach((message) => {
                if (message.status !== "streaming") delete next[message.id];
              });
              return next;
            });
          }
          return outcome.state;
        });
      } else if (event.type === "conversation.delta") {
        setDeltas((current) => ({ ...current, [event.data.messageId]: `${current[event.data.messageId] ?? ""}${event.data.textDelta}` }));
      } else if (event.type === "agent.status") {
        setAgentEvent(event.data);
      } else {
        setConnection(event.data.status);
      }
    });
    return unsubscribe;
    // The injected client/session form the transport identity for this app instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, sessionId]);

  useEffect(() => {
    if (state.model?.id) setDrafts(state.model.parameterValues);
  }, [state.model?.id, state.revision]);

  const agent = state.agent ?? agentEvent;
  const agentUnavailable = agent?.status === "unconfigured" || agent?.status === "error";
  const schema = state.model?.parameterSchema.fields ?? [];
  const fieldErrors = useMemo(
    () => Object.fromEntries(schema.map((field) => [field.key, validateField(field, drafts[field.key])]).filter(([, error]) => error)) as Record<string, string>,
    [drafts, schema]
  );
  const draftsDirty = JSON.stringify(drafts) !== JSON.stringify(state.model?.parameterValues ?? {});
  const runDisabled = !state.model || state.model.status !== "ready" || isRunActive(state) || Object.keys(fieldErrors).length > 0 || draftsDirty;

  const doAction = async (label: string, action: () => Promise<void>) => {
    setRequestError(undefined);
    setPendingAction(label);
    try {
      await action();
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The request could not be completed.");
    } finally {
      setPendingAction(undefined);
    }
  };

  const onUpload = async (file?: File) => {
    if (!file) return;
    setRequestError(undefined);
    setPendingUpload(file.name);
    try {
      await client.upload(sessionId, state.revision, file);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The file could not be uploaded.");
    } finally {
      setPendingUpload(undefined);
    }
  };

  const onSend = async () => {
    const text = composer.trim();
    if (!text || agentUnavailable || pendingUpload) return;
    setComposer("");
    setOptimisticText(text);
    await doAction("chat", () => client.sendChat(sessionId, state.revision, text, state.attachments.filter((item) => item.status === "ready").map((item) => item.id)));
  };

  const activateTab = (tab: WorkbenchTab) => setActiveTab(tab);
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const nextIndex = (index + offset + tabs.length) % tabs.length;
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <main className="app-shell" aria-label="Riff simulation demo">
      <header className="app-header">
        <div><span className="eyebrow">LOCAL AI SIMULATION LAB</span><h1>Riff Demo</h1></div>
        <span className={`connection connection-${connection}`}>{connection}</span>
      </header>

      <div className="mobile-pane-switch" aria-label="Mobile workspace selector">
        <button className={mobilePane === "conversation" ? "selected" : ""} onClick={() => setMobilePane("conversation")}>Conversation</button>
        <button className={mobilePane === "workbench" ? "selected" : ""} onClick={() => setMobilePane("workbench")}>Workbench</button>
      </div>

      <div className="workspace">
        <section className={`conversation-pane ${mobilePane === "conversation" ? "mobile-visible" : ""}`} aria-label="Conversation" data-testid="conversation-pane">
          <div className="pane-heading"><div><span className="eyebrow">MODELLING ASSISTANT</span><h2>Conversation</h2></div><span className="agent-state">{statusLabel(agent?.status) ?? "Local fixture mode"}</span></div>
          {agent?.lastError && <div className="inline-note" role="alert">{agent.lastError.message}</div>}

          <div className="attachment-strip">
            <label className="attach-button">Attach input file<input aria-label="Attach input file" type="file" accept=".csv,.json,.txt,text/csv,application/json,text/plain" onChange={(event) => void onUpload(event.target.files?.[0])} /></label>
            <span>CSV, JSON, or TXT · max 1 MiB</span>
          </div>
          <ul className="attachment-list" data-testid="attachment-list" aria-label="Uploaded files">
            {pendingUpload && <li className="attachment pending"><span>{pendingUpload}</span><small>pending</small></li>}
            {state.attachments.map((attachment) => (
              <li key={attachment.id} className="attachment" data-testid={`attachment-${attachment.id}`}>
                <div><strong>{attachment.displayName}</strong><span>{attachment.mediaType} · {formatSize(attachment.sizeBytes)}</span></div>
                <div className="attachment-actions"><small>{attachment.status}</small>{attachment.status === "ready" && <button aria-label={`Remove ${attachment.displayName}`} onClick={() => void doAction("remove-attachment", () => client.removeAttachment(sessionId, state.revision, attachment.id))}>Remove</button>}</div>
                {attachment.error && <p role="alert">{attachment.error.message}</p>}
              </li>
            ))}
          </ul>

          <div className="transcript" role="log" aria-label="Conversation messages" aria-live="polite">
            {state.conversation.length === 0 && !optimisticText && <p className="empty-copy">Upload a supported input, then ask the assistant to prepare the bundled queue simulation.</p>}
            {state.conversation.map((message) => <article className={`message message-${message.role}`} key={message.id}><span>{message.role}</span><p>{message.text}{deltas[message.id]}</p>{message.status === "streaming" && <i>streaming…</i>}</article>)}
            {optimisticText && <article className="message message-user optimistic"><span>user</span><p>{optimisticText}</p><i>sending…</i></article>}
          </div>

          <div className="composer">
            <label htmlFor="assistant-message">Message the modelling assistant</label>
            <textarea id="assistant-message" value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="For example: load the queue model and inspect my uploaded arrivals." />
            <div><small>{agentUnavailable ? (agent?.lastError?.message ?? "Assistant configuration is required before sending a message.") : "The assistant works from your uploaded metadata and approved Mesa tools."}</small><button onClick={() => void onSend()} disabled={!composer.trim() || Boolean(pendingUpload) || agentUnavailable || pendingAction === "chat"}>Send message</button></div>
          </div>
        </section>

        <section className={`workbench-pane ${mobilePane === "workbench" ? "mobile-visible" : ""}`} aria-label="Mesa workbench" data-testid="mesa-workbench">
          <div className="pane-heading"><div><span className="eyebrow">MESA WORKBENCH</span><h2>Experiment control</h2></div><span className={`phase phase-${state.phase}`} role="status" aria-label="Simulation status">{projectStatus(state.phase)}</span></div>
          {requestError && <div className="inline-note danger" role="alert">{requestError}</div>}
          {state.uiControl?.status === "failed" && <div className="inline-note warning" role="alert">{state.uiControl.message ?? "The visible workbench action could not be verified. Your saved simulation state is still available."}</div>}

          <div className="workbench-tabs" role="tablist" aria-label="Mesa workbench views" data-testid="workbench-tablist">
            {tabs.map((tab, index) => <button key={tab.id} ref={(node) => { tabRefs.current[index] = node; }} id={`workbench-tab-${tab.id}`} data-testid={`workbench-tab-${tab.id}`} role="tab" aria-selected={activeTab === tab.id} aria-controls={`workbench-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => activateTab(tab.id)} onKeyDown={(event) => onTabKeyDown(event, index)}>{tab.label}</button>)}
          </div>

          <section id="workbench-panel-files" role="tabpanel" aria-label="Workbench files" aria-labelledby="workbench-tab-files" data-testid="workbench-panel-files" hidden={activeTab !== "files"} className="workbench-panel">
            <h3>Files</h3>
            {state.attachments.length ? <ul className="manifest-list">{state.attachments.map((attachment) => <li key={attachment.id}><strong>{attachment.displayName}</strong><span>{attachment.mediaType} · {formatSize(attachment.sizeBytes)} · {attachment.status}</span></li>)}</ul> : <p className="empty-copy">No accepted input files yet. Add a CSV, JSON, or text file from the conversation pane.</p>}
          </section>

          <section id="workbench-panel-parameters" role="tabpanel" aria-label="Workbench parameters" aria-labelledby="workbench-tab-parameters" data-testid="workbench-panel-parameters" hidden={activeTab !== "parameters"} className="workbench-panel">
            {state.model ? <><div className="model-summary" data-testid="model-summary"><h3>{state.model.name}</h3><p>{state.model.description}</p><small>{state.model.status === "ready" ? "Ready to configure" : "Preparing model"}</small></div><form aria-label="Simulation parameters" onSubmit={(event) => { event.preventDefault(); if (state.model && !Object.keys(fieldErrors).length) void doAction("save-parameters", () => client.saveParameters(sessionId, state.revision, state.model!.id, drafts)); }}>
              {schema.map((field) => <ParameterControl key={field.key} field={field} value={drafts[field.key] ?? field.default} disabled={isRunActive(state)} error={fieldErrors[field.key]} onChange={(value) => setDrafts((current) => ({ ...current, [field.key]: value }))} />)}
              <div className="form-footer"><span>{draftsDirty ? "Unsaved parameter changes" : "Parameters saved"}</span><button type="submit" disabled={isRunActive(state) || Object.keys(fieldErrors).length > 0 || !draftsDirty || pendingAction === "save-parameters"}>Save parameters</button></div>
            </form></> : <div className="model-summary" data-testid="model-summary"><h3>No model prepared</h3><p>Ask the assistant to load the approved queue-network model.</p></div>}
          </section>

          <section id="workbench-panel-run" role="tabpanel" aria-label="Workbench run" aria-labelledby="workbench-tab-run" data-testid="workbench-panel-run" hidden={activeTab !== "run"} className="workbench-panel">
            <h3>Run experiment</h3>
            {state.run && <RunProgress state={state} />}
            {state.run && isRunActive(state) ? <button className="danger-button" onClick={() => void doAction("cancel-run", () => client.cancelRun(sessionId, state.revision, state.run!.id))} disabled={pendingAction === "cancel-run"}>Cancel run</button> : <><button onClick={() => state.model && void doAction("start-run", () => client.startRun(sessionId, state.revision, state.model!.id, drafts))} disabled={runDisabled || pendingAction === "start-run"}>Run experiment</button>{draftsDirty && <p className="hint">Save parameter changes before starting an experiment.</p>}</>}
            {state.run?.status === "timed_out" && <div className="terminal-note" role="alert">Simulation timed out. No successful result metrics are available for this run.</div>}
          </section>

          <section id="workbench-panel-results" role="tabpanel" aria-label="Workbench results" aria-labelledby="workbench-tab-results" data-testid="workbench-panel-results" hidden={activeTab !== "results"} className="workbench-panel">
            {state.results && state.run?.status === "succeeded" ? <Results state={state} /> : <><h3>Results</h3><p className="empty-copy">{state.run?.status === "timed_out" ? "This run timed out, so success results are unavailable." : "Run a successful experiment to view metrics and time series."}</p></>}
          </section>
        </section>
      </div>
    </main>
  );
}

function ParameterControl({ field, value, disabled, error, onChange }: { field: ParameterField; value: Scalar; disabled: boolean; error?: string; onChange: (value: Scalar) => void }) {
  const id = `parameter-${field.key}`;
  return <div className="parameter-field"><label htmlFor={id}>{field.label}</label>{field.description && <small>{field.description}</small>}{field.type === "boolean" ? <input id={id} data-testid={`parameter-input-${field.key}`} type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /> : <input id={id} data-testid={`parameter-input-${field.key}`} type={field.type === "string" ? "text" : "number"} value={String(value)} min={field.minimum} max={field.maximum} step={field.step ?? (field.type === "integer" ? 1 : "any")} disabled={disabled} aria-invalid={Boolean(error)} onChange={(event) => onChange(coerceValue(field, event.target.value))} />}{error && <p className="field-error" role="alert">{error}</p>}</div>;
}

function RunProgress({ state }: { state: ProjectState }) {
  const run = state.run!;
  const total = run.progress.totalSteps;
  return <div className="run-card"><p><strong>Run {run.id}</strong><span>{run.status}</span></p>{total ? <progress aria-label="Simulation progress" value={run.progress.completedSteps} max={total}>{run.progress.completedSteps}/{total}</progress> : <p role="status">Simulation progress: {run.progress.completedSteps} steps</p>}{run.logTail.length > 0 && <pre aria-label="Simulation log tail">{run.logTail.join("\n")}</pre>}{run.error && <p className="field-error">{run.error.message}</p>}</div>;
}

function Results({ state }: { state: ProjectState }) {
  const results = state.results!;
  return <section aria-label="Simulation results" data-testid={`results-run-${results.runId}`}><h3>Results · {results.runId}</h3><ul aria-label="Result metrics" className="metric-list">{results.summary.map((metric) => <li key={metric.key}><span>{metric.label}</span><strong>{metric.value}{metric.unit ? ` ${metric.unit}` : ""}</strong></li>)}</ul><ResultChart state={state} /><table aria-label="Simulation result table"><thead><tr>{results.table.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{results.table.rows.map((row, index) => <tr key={index}>{results.table.columns.map((column) => <td key={column.key}>{row[column.key]}</td>)}</tr>)}</tbody></table></section>;
}
