# Demo backend public API contract

## Scope and identifiers

This is the only browser-facing API for the local demo. The browser never calls
OpenCode or Mesa directly. The backend maps a browser-safe `sessionId` to its
server-side project record, Mesa project ID, and (when configured) opaque
OpenCode session ID. The last of those is never present in this API's JSON,
headers, URLs, logs, snapshots, or SSE events.

`sessionId` is a server-generated URL-safe local browser-session identifier. It
is not a filesystem path, authentication credential, Mesa revision, run ID, or
OpenCode session ID. The local shell establishes it before rendering; session
creation is outside the MVP workflow contract below.

All state objects and event names follow `ui-workflow.md`. The backend must not
invent parallel public event names for OpenCode or Mesa internals.

## Command envelope and acknowledgements

Every browser mutation uses this envelope. The backend checks that `sessionId`
matches the route, the local browser session, and the current project record;
it rejects a stale `baseRevision` rather than applying it to a changed model or
run.

```ts
type UiCommand<T> = {
  commandId: string;       // client UUID for idempotent retry
  sessionId: string;
  baseRevision: number;
  payload: T;
};

type CommandAccepted = { accepted: true; commandId: string };
type CommandRejected = {
  accepted: false;
  commandId?: string;
  error: { code: string; message: string; details?: Record<string, unknown> };
};
```

An accepted command is not a state update. The browser renders the following
`project.snapshot` or ordered `project.patch`; this prevents a command response
from racing an agent, Mesa, or another page update. Repeating the same
`commandId` returns the original acknowledgement and does not create a second
upload, prompt, parameter save, or run.

`422` denotes a schema/validation failure, `409` a stale revision or incompatible
current state, `413` an oversized upload, and `429` a local rate limit. Errors
are user-safe and must not include keys, absolute paths, raw tool input, or a
stack trace.

## Browser routes

| Method and route | Body | Adapter responsibility | Success |
| --- | --- | --- | --- |
| `GET /api/sessions/{sessionId}/snapshot` | — | Returns the canonical browser-safe `ProjectState` at its current revision. | `200 ProjectState` |
| `GET /api/sessions/{sessionId}/events` | SSE | Opens the canonical SSE stream below; authenticates the local browser session and sends a snapshot first. | `200 text/event-stream` |
| `POST /api/sessions/{sessionId}/uploads` | multipart `envelope` plus one `file` | Validates and persists an allowed attachment, then updates `ProjectState.attachments`. | `202 CommandAccepted` |
| `POST /api/sessions/{sessionId}/chat` | `UiCommand<{text: string; attachmentIds: string[]}>` | Creates/reuses the server-side OpenCode session, submits a bounded prompt, and maps its events/actions into state. | `202 CommandAccepted` |
| `PUT /api/sessions/{sessionId}/parameters` | `UiCommand<{modelId: string; values: Record<string, string \| number \| boolean>}>` | Validates against the active Mesa schema and saves canonical parameter values in backend state. It does not call an undocumented Mesa parameter endpoint. | `202 CommandAccepted` |
| `POST /api/sessions/{sessionId}/runs` | `UiCommand<{modelId: string; parameters?: Record<string, string \| number \| boolean>; steps?: number; seeds?: number[]}>` | Validates the active model/state, constructs the Mesa run request from trusted state, and starts one run. | `202 CommandAccepted` |
| `POST /api/sessions/{sessionId}/runs/{runId}/cancel` | `UiCommand<Record<string, never>>` | Checks that `runId` belongs to the current project and forwards cancellation to Mesa. | `202 CommandAccepted` |

For upload, `envelope` is a UTF-8 JSON `UiCommand<{clientFileName: string}>`
multipart field; the file bytes are the separate `file` part. The server derives
the effective name and media type and does not trust either client-supplied
value. CSV (`text/csv`), JSON (`application/json`), and plain text (`text/plain`)
are the only supported uploads. Each file is at most 1 MiB. A successful upload
is stored under the common Mesa workspace layout:

```text
WORKSPACE_ROOT/projects/<project-id>/inputs/<upload-id>-<safe-original-name>
```

The browser receives attachment metadata only; it never receives a workspace
path. The OpenCode bridge receives the corresponding manifest as described in
`opencode-bridge.md`.

## Backend-to-Mesa adapter rules

The backend is the only Mesa client. It maps a server-side project record to the
Mesa `project_id`; this ID is never supplied by a browser command.

- **Model load:** only an approved bridge action can call
  `PUT /v1/projects/{project_id}/model` with `{"model_id":"queue-network-v1"}`.
  The returned active revision and schema are copied into canonical state.
- **Parameter save:** the backend retrieves/uses the active model schema,
  validates the complete values, and stores the canonical values. It does not
  forward a parameter patch to Mesa, because Mesa has no such API.
- **Start run:** the backend rejects a non-active `modelId` and never accepts a
  browser-supplied model revision. It injects the active Mesa `model_revision`,
  merges saved canonical parameter values with schema defaults, validates
  optional `steps`/`seeds`, and creates the documented Mesa request before
  calling `POST /v1/projects/{project_id}/runs`. If a client includes
  `parameters`, they must exactly match the saved canonical values or the command
  is rejected; the client values are not forwarded as an authority.
- **Cancel/status/results:** the backend verifies project ownership before using
  Mesa cancellation/status/results endpoints, maps terminal Mesa status into the
  canonical `ProjectState`, and never serves a successful result for a
  non-`succeeded` run.

Mesa `timed_out` maps to external `run.status: "timed_out"` and
`ProjectPhase: "timed_out"`. It remains distinct from `failed`, is terminal, and
has no success results. A later valid parameter save/run is permitted after the
terminal update.

## Canonical SSE stream

`GET .../events` first sends `project.snapshot`. Thereafter it can emit only
these named event types:

| Event | Data | Meaning |
| --- | --- | --- |
| `project.snapshot` | full browser-safe `ProjectState` | Initial connection or resynchronization baseline. |
| `project.patch` | `{sessionId, revision, operations}` | Monotonic authoritative state change. Model load, parameters, run progress, terminal failure, timeout, and results all use this event. |
| `conversation.delta` | `{messageId, textDelta}` | Redacted assistant text while that existing message is streaming. Completion is represented by a final patch. |
| `agent.status` | public `{modelId, status, lastError?}` projection | Non-authoritative activity/readiness notification; the next state patch remains authoritative. |
| `connection.status` | `{status: "connected" \| "reconnecting" \| "offline"}` | Transport information only; it does not change project phase. |

The backend never relay-forwards raw OpenCode SSE, raw Mesa logs, raw error
objects, or tool events. On source reconnect, duplicate, reorder, or unknown
event, it refetches/reconciles server state and emits a fresh snapshot rather
than exposing source-specific events. The browser ignores old revisions and
resynchronizes on a gap, as specified by `ui-workflow.md`.

## Release and test requirements

Public-route integration tests must cover accepted/rejected envelopes,
idempotent command retries, 1 MiB/format upload rejection, stale revision
rejection, active-model/default injection into Mesa run requests, cancellation
ownership, and `timed_out` as an unsuccessful terminal state.

Release requires the live OpenCode gate in `opencode-bridge.md`: real local
health/provider/model discovery plus one bounded chat and one bounded approved
tool call. Fake agents are allowed only for unit fixtures and cannot replace the
live API/Playwright end-to-end evidence.
