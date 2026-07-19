# UI workflow and browser contract

## Purpose and scope

This document defines the browser-visible contract for the local MVP. It covers
one session at a time and one successful workflow: attach a supported input,
ask the assistant to prepare a model, edit parameters, start a Mesa run, read
its results, and receive an assistant summary. It deliberately does not define
model correctness, arbitrary file support, or a production collaboration UI.

The backend `ProjectState` is authoritative. The browser renders that state and
sends commands; it must not infer model readiness or run completion from chat
text or from Playwright actions.

## Local shell

The application is a responsive web shell intended to be demonstrated at a
1440 x 900 desktop viewport. At that size it has two persistent landmark
regions separated by a draggable-looking but non-functional divider in the
MVP:

```
+---------------- conversation (40%) ----------------+-- workbench (60%) --+
| Riff Demo · local session                            | Mesa workbench      |
| attachment list                                      | model / parameters  |
| streamed assistant and user messages                 | run / results       |
|                                                      |                     |
| attachment button + message composer                 | persistent status   |
+------------------------------------------------------+---------------------+
```

Below 960 px, the regions become two labelled tabs (`Conversation` and
`Workbench`), preserving the same state. Desktop layout is the acceptance
target; mobile optimization is not part of the MVP.

The page has one `main` landmark. Its two children are named regions:

- `Conversation`: upload, message history, and composer.
- `Mesa workbench`: model state, parameter form, run controls, and results.

An always-visible, non-modal live-status element in the workbench announces
the current project/run phase. It must be usable without the assistant.

## User-visible workflow

| Step | Conversation behavior | Workbench behavior |
| --- | --- | --- |
| Initial | Shows an empty-state prompt and enabled attachment control. The composer is enabled when agent state is omitted (fixture mode) or is `ready`; an unavailable agent has a safe configuration message. | Shows `No model prepared`; parameter and run controls are disabled. |
| Attach | File appears immediately as `pending`; once accepted it shows name, type, size, and `ready` or an inline error. The composer remains usable only after all pending uploads settle. | Continues to show no model until a model-ready state arrives. |
| Request modelling | User sends a prompt with attachment references. Assistant stream is appended as an assistant message and exposes a busy status. | Shows `Preparing model`; stale parameter/results content is cleared when the model identity changes. |
| Model ready | Assistant message may describe readiness, but it is not the state trigger. | Shows model name/description and renders the schema-driven parameter form. |
| Configure | The user can continue chatting. | Parameter fields are editable; unsaved edits are visibly marked. `Run experiment` is enabled only when validation passes and no run is active. |
| Run | A user or agent may narrate the action in the transcript. | On start, parameters become read-only, progress/log tail are displayed, and `Cancel run` replaces the start control. |
| Agent UI verification warning | The transcript may say that a requested action completed only after the domain action is committed. | If Playwright cannot mirror/verify an agent-triggered action, show a non-blocking, user-safe warning and leave the committed model/run state visible and usable for manual continuation. |
| Complete | Assistant can receive result context and append a summary. | Shows terminal success status, metric cards, one time-series chart, and a results table. |
| Failure/cancel/timeout | Shows a plain-language message and a retry prompt; attachments and prior messages remain. | Shows a terminal error, cancellation, or timeout state and safe diagnostic text. A timeout is unsuccessful, never a partial success. Existing successful results remain labelled with their prior run ID. Parameters unlock after the run reaches a terminal state. |

The attachment list supports only the service's declared formats and size
limit. Rejection happens before the attachment can be referenced by a prompt.
The UI must never render an API key, raw environment variable, absolute host
path, or unredacted stack trace.

## Authoritative state rendered by the UI

The browser subscribes to one full state snapshot on load and ordered patches
thereafter. `revision` is monotonically increasing. A patch whose revision is
not greater than the rendered revision is ignored; a gap triggers a snapshot
reload. UI-only draft text is never written into this object until a successful
command acknowledgement.

```ts
type ProjectPhase =
  | "idle" | "uploading" | "preparing_model" | "model_ready"
  | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

type ProjectState = {
  sessionId: string;
  revision: number;
  phase: ProjectPhase;
  // Omitted by deterministic/Mesa-only fixtures. The backend owns the opaque
  // OpenCode session ID; it is intentionally not exposed here.
  agent?: {
    modelId: string | null;
    status: "unconfigured" | "ready" | "thinking" | "waiting_for_action" | "error";
    lastError?: { code: string; message: string };
  };
  // Observation of a Playwright projection only; it is not a domain result.
  uiControl?: {
    intent: "open_tab" | "set_parameter" | "start_run" | "open_results";
    status: "verifying" | "verified" | "failed";
    expectedRevision: number;
    message?: string;
  };
  attachments: Array<{
    id: string;
    displayName: string;
    mediaType: string;
    sizeBytes: number;
    status: "pending" | "ready" | "rejected";
    error?: { code: string; message: string };
  }>;
  conversation: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    text: string;
    attachmentIds?: string[];
    status: "streaming" | "complete" | "failed";
    createdAt: string;
  }>;
  model: null | {
    id: string;
    name: string;
    description: string;
    status: "preparing" | "ready" | "failed";
    parameterSchema: ParameterSchema;
    parameterValues: Record<string, string | number | boolean>;
    error?: { code: string; message: string };
  };
  run: null | {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
    progress: { completedSteps: number; totalSteps: number | null };
    logTail: string[];
    error?: { code: string; message: string };
    startedAt?: string;
    finishedAt?: string;
  };
  results: null | {
    runId: string;
    summary: Array<{ key: string; label: string; value: number | string; unit?: string }>;
    timeSeries: { xKey: string; xLabel: string; series: Array<{ key: string; label: string; values: number[] }> };
    table: { columns: Array<{ key: string; label: string }>; rows: Array<Record<string, string | number>> };
  };
};

type ParameterSchema = {
  fields: Array<{
    key: string;
    label: string;
    type: "number" | "integer" | "boolean" | "string";
    default: string | number | boolean;
    minimum?: number;
    maximum?: number;
    step?: number;
    description?: string;
    required: boolean;
  }>;
};
```

`results.runId` must equal the run ID named in its heading. A running state
must not overwrite results from a completed earlier run; if those are shown,
they are explicitly labelled as previous results.

`agent` is the browser-safe readiness projection of the bridge's `AgentLink`:
it exposes a configured model ID and status only. The OpenCode session ID stays
in the server-side project record and is never required by, or exposed to, the
browser. When present, `unconfigured` and `error` disable message submission
and render `lastError.message` only after the bridge has redacted it;
`thinking` and `waiting_for_action` render non-authoritative activity feedback.
Agent readiness does not change `ProjectPhase`, model readiness, or any Mesa
run state.

`uiControl` is optional and records only a browser-control observation after an
agent-triggered, already-committed domain action. A `failed` observation renders
a non-modal safe warning (using the existing recoverable-error alert contract),
does not alter `ProjectPhase`, `run`, parameters, or results, and never rolls
back a server-confirmed action. Its text must not include a selector, DOM dump,
host path, or raw Playwright error. A later human action can continue from the
authoritative project state.

## UI command and canonical event contract

All client commands include `sessionId` and `baseRevision`. The service returns
an acknowledgement (`accepted: true`) or a typed rejection. An accepted command
does not itself change rendered state; the following state event does.

The browser communicates only with public demo-backend routes. It never calls
the Mesa `/v1/...` API, worker/artifact paths, OpenCode, or Playwright directly.
Route paths and HTTP request schemas are documented separately; the logical
commands below are the UI contract.

| Browser command | Required payload beyond envelope | UI outcome |
| --- | --- | --- |
| `attachment.upload` | file binary and client filename | Render pending attachment, then wait for state. |
| `attachment.remove` | `attachmentId` | Remove only after acknowledgement/state update. |
| `conversation.send` | `text`, `attachmentIds` | Append the user message optimistically with sending status; disable duplicate send until acknowledged. |
| `model.parameters.save` | `modelId`, complete `values` | Keep field drafts on reject and show field error; replace with canonical state on success. |
| `run.start` | `modelId`, `parameters` | Disable edits/start after accepted; await run state. |
| `run.cancel` | `runId` | Show cancelling feedback; await terminal state. |

The complete browser event-name allowlist is:

- `project.snapshot` — full `ProjectState` on first connection or resync.
- `project.patch` — `{ sessionId, revision, operations }`, applied in revision
  order.
- `conversation.delta` — `{ messageId, textDelta }`; only valid while the
  corresponding assistant message is `streaming`.
- `agent.status` — optional bridge activity notification with the public
  `ProjectState.agent.status` value. It may update a transient activity
  indicator, but the next project snapshot/patch remains the authoritative
  readiness value.
- `connection.status` — transport state only (`connected`, `reconnecting`,
  `offline`); it cannot change project phase.

No bridge-internal event name (for example `assistant.delta`,
`project.updated`, or `run.updated`) reaches the browser. The backend maps
those sources into the canonical events above, with project/run/UI-control
changes carried by ordered `project.snapshot` or `project.patch` state.

For this MVP, SSE is sufficient for the event stream. Reconnection must obtain
a snapshot before accepting new state-dependent controls.

## Stable semantic selectors for Playwright

The visible UI must expose these accessible names and test IDs. Playwright
tests should prefer `getByRole` / `getByLabel`; `data-testid` is reserved for
elements without a stable semantic role or for scoped assertions.

| Surface | Required locator contract |
| --- | --- |
| App shell | `getByRole('main', { name: 'Riff simulation demo' })` |
| Conversation | `getByRole('region', { name: 'Conversation' })`, `data-testid='conversation-pane'` |
| Attachment control | `getByLabel('Attach input file')` (file input), `data-testid='attachment-list'` |
| Attachment item | `data-testid='attachment-<id>'`; contains file name and status text |
| Message transcript | `getByRole('log', { name: 'Conversation messages' })` |
| Composer | `getByLabel('Message the modelling assistant')` |
| Send | `getByRole('button', { name: 'Send message' })` |
| Workbench | `getByRole('region', { name: 'Mesa workbench' })`, `data-testid='mesa-workbench'` |
| Project status | `getByRole('status', { name: 'Simulation status' })` |
| Model card | `data-testid='model-summary'` with model name as heading |
| Parameters | `getByRole('form', { name: 'Simulation parameters' })`; every schema field has label equal to `field.label` |
| Save parameters | `getByRole('button', { name: 'Save parameters' })` |
| Start run | `getByRole('button', { name: 'Run experiment' })` |
| Cancel run | `getByRole('button', { name: 'Cancel run' })` |
| Progress | `getByRole('progressbar', { name: 'Simulation progress' })` when total steps are known; otherwise status text |
| Results | `getByRole('region', { name: 'Simulation results' })`, `data-testid='results-run-<runId>'` |
| Metrics | `getByRole('list', { name: 'Result metrics' })` |
| Chart | `getByRole('img', { name: 'Simulation time series' })` with adjacent accessible data summary |
| Table | `getByRole('table', { name: 'Simulation result table' })` |
| Recoverable errors | `getByRole('alert')` with a user-safe message |

## UI-specific acceptance tests

The shared test plan owns the complete E2E requirement. The UI suite must add
these deterministic cases using a fake event stream or fixed Mesa fixture;
one separate E2E test uses the real service.

1. Empty session renders both named regions, an enabled attachment control,
   `No model prepared`, and a disabled `Run experiment` control.
2. Uploading a supported fixture renders a pending attachment then its ready
   name/type/size; an unsupported fixture renders an alert and cannot be sent
   with a message.
3. Sending a message with a ready attachment produces one user transcript item;
   streamed assistant deltas append to exactly one assistant item and expose
   busy status without duplicating text after a snapshot.
4. A `model_ready` state renders fields entirely from `parameterSchema`, with
   defaults and min/max validation. Invalid local values prevent save/run and
   identify the offending field.
5. Saving valid parameters updates the canonical displayed values only after
   the acknowledged revision. A rejected save retains drafts and renders an
   alert without erasing the prior canonical state.
6. Starting a run locks parameter controls, exposes run status/progress, and
   makes `Cancel run` available. A terminal success unlocks configuration and
   hides cancellation.
7. Success renders metric list, chart accessible label/data summary, and result
   table all labelled with the same run ID. Starting a second run retains prior
   results until new results arrive and labels them as previous.
8. Failed, cancelled, and `timed_out` states render safe error text, unlock
   controls, keep the transcript/attachments, and do not display a fabricated
   success result. A timeout identifies the run as timed out without exposing a
   worker PID, raw log, stack trace, or host path.
9. Out-of-order or duplicate state patches do not regress the displayed phase;
   a revision gap triggers snapshot resynchronization and disables dependent
   controls until complete.
10. At 1440 x 900 both regions and the workbench status are visible without
    horizontal page scrolling. Capture a visual screenshot for review.
11. With a public agent state, `unconfigured`/`error` keep the attachment
    control available but disable message send with a safe explanation;
    `ready` enables it. The UI never receives or requires an OpenCode session
    identifier.
12. A `uiControl.status: "failed"` state shows a safe non-blocking warning
    while retaining the already-committed parameters/run/results. The test
    proves a subsequent manual run/result interaction remains available.

## Interface assumptions requiring reconciliation

1. The app owner must select the final frontend stack and event endpoint; the
   semantic selector and state contracts are stack-independent.
