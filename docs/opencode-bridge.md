# OpenCode bridge contract

## Purpose and ownership

The bridge is a backend-only adapter between the conversation UI, a local
OpenCode server, the Mesa API, and the browser-control worker.  It creates one
OpenCode session per `projectId`, owns the server-side provider credential, and
turns agent requests into validated project actions.  It never makes OpenCode,
its credentials, or the Mesa runner reachable from the browser.

This document assumes the shared `ProjectState` contract in
`architecture.md`: that state is authoritative.  OpenCode text, its session
history, the DOM, and Playwright's observation are not authoritative state.

## Local process and model selection

At application startup the backend launches (or health-checks) one local,
loopback-only OpenCode server:

```text
opencode serve --hostname 127.0.0.1 --port <allocated-port>
```

The launch environment is assembled in memory from `.env`; it is not sent to
the browser, placed in a workspace, logged, or committed.  `OPENCODE_API_KEY`
is the demo application's secret input.  The provider adapter maps it to the
credential mechanism required by the selected OpenCode provider (for example a
provider-specific environment variable or server auth configuration).  The
adapter must fail closed if it cannot make that mapping.  It must not guess a
DeepSeek provider or model identifier from the display name "DeepSeek V4".

On startup, before accepting a chat message, the bridge shall:

1. call OpenCode health and record its version;
2. list configured providers/models from the server configuration endpoint;
3. validate that `OPENCODE_MODEL`, if set, is present and usable; model IDs use
   OpenCode's `provider_id/model_id` form;
4. otherwise select the configured default only if it belongs to the approved
   local provider allowlist; and
5. expose a redacted readiness value (`ready`, provider ID, model ID, version,
   or a safe configuration error) to the UI.

The initial implementation supports one configured DeepSeek-compatible
provider, not a hard-coded "opencode-go" model string.  The exact provider ID,
model ID, and credential variable are installation configuration and must be
confirmed against the running server's provider catalogue during setup.

The OpenCode server is started with a random local port and a random server
password; the bridge supplies the basic-auth header.  It listens only on
`127.0.0.1`, has no mDNS discovery, and is stopped when the demo shuts down.
The browser communicates with the demo backend only, so OpenCode CORS need not
allow the frontend origin.

## Session lifecycle

The bridge keeps an internal server-side linkage. It is **not** the browser's
`ProjectState.agent` projection:

```ts
type ServerAgentLink = {
  sessionId: string | null;
  modelId: string | null;
  status: "unconfigured" | "ready" | "thinking" | "waiting_for_action" | "error";
  lastError?: { code: string; message: string };
};
```

The opaque `sessionId` above is an OpenCode session ID and must never occur in
a browser snapshot, patch, command acknowledgement, or SSE event. The browser
may receive only `{ modelId, status, lastError? }`, as specified in
`ui-workflow.md`.

The backend creates an OpenCode session lazily for the first accepted message
for a project and saves the opaque session ID in its server-side project record.
Subsequent messages reuse it.  A request is rejected with `409 agent_busy` if
that project's previous prompt has not reached a terminal session status.  A
user cancel invokes the OpenCode session-abort endpoint, marks the turn
cancelled in `ProjectState`, and leaves its prior messages intact.  The UI does
not receive an OpenCode session ID as an authority token.

On restart, the bridge restores the session only after checking that it exists
on the local OpenCode server and still maps to the same project workspace.  If
not, it starts a new session and supplies a compact project summary plus the
current artifact manifest.  Deleting a local project first aborts active work,
deletes its workspace through the project service, then deletes the OpenCode
session.  No OpenCode share endpoint is used in this MVP.

Each prompt includes a generated `messageID`, the selected model, an explicit
system instruction defining the supported Mesa protocol, and only the tools in
the next section.  The bridge uses OpenCode's asynchronous prompt endpoint so
the HTTP request does not hold a browser connection open.

## Upload and attachment handoff

The browser uploads only CSV, JSON, or TXT, each no larger than 1 MiB, through
the public backend upload route defined in `backend-api.md`. The project service
verifies the browser session/project relationship, extension, MIME type, maximum
size, and generated destination; it never uses the supplied filename as a path.
It stores an immutable upload at:

```text
WORKSPACE_ROOT/projects/<projectId>/inputs/<uploadId>-<safe-name>
```

It returns and records an attachment manifest, not an arbitrary browser path:

```json
{
  "id": "upl_01...",
  "originalName": "arrivals.csv",
  "mediaType": "text/csv",
  "sizeBytes": 1240,
  "workspaceRelativePath": "inputs/upl_01-arrivals.csv",
  "sha256": "..."
}
```

For a chat turn the bridge passes the user text plus this manifest and an
instruction that files may only be inspected through `inspect_uploaded_files`.
If the deployed OpenCode version supports native file/message parts, the bridge
may additionally attach a server-resolved `file://` reference; this is an
optimization, not the contract.  It must first prove that the resolved path is
inside the project workspace.  The frontend never sends a path or a secret to
OpenCode.

## Allowed agent actions

The agent receives a dedicated `simulation-workbench` tool surface (implemented
as a bridge/MCP adapter or equivalent OpenCode tool registration).  Direct
OpenCode `bash`, arbitrary file write/read, network, shell, and generic browser
tools are disabled.  Every tool input is JSON-schema validated; every action is
scoped to the active `projectId` by the bridge, never by a model-provided ID.

| Tool/action | Input and effect | Preconditions / result |
| --- | --- | --- |
| `inspect_uploaded_files` | optional allowlisted upload IDs; returns bounded text/metadata previews | only current project uploads; binary and oversize content is not returned |
| `select_and_load_model` | allowlisted `modelId` only | calls `PUT /v1/projects/{projectId}/model` with `{"model_id":"queue-network-v1"}`; the Mesa service materializes the immutable bundled revision and returns its schema |
| `set_parameters` | parameter key/value patch | validates against active schema and atomically patches `ProjectState` |
| `run_experiment` | optional documented `steps` and `seeds` overrides | requires an active Mesa revision and valid state parameters; bridge builds the documented run request and calls `POST /v1/projects/{projectId}/runs` |
| `get_run_status` | optional active run ID | returns backend run state and bounded log tail |
| `read_run_results` | terminal run ID | returns `summary.json` and bounded series/manifest, never arbitrary files |
| `drive_workbench_ui` | one allowlisted UI intent: `open_tab`, `set_parameter`, `start_run`, `open_results` | backend action succeeds first; Playwright mirrors and reports observation |

`select_and_load_model` is deliberately bundled-model-bound.  In the MVP it
accepts only `queue-network-v1`; it does not submit a model plan, schema, Python
source, filesystem path, or uploaded file to Mesa.  The Mesa service itself
copies that reviewed asset into an immutable project revision.  Any later
"generate Python" phase needs a separate sandbox, a new Mesa API, and a review
gate.

The assistant can explain, ask for missing supported inputs, and call the tools
above.  It cannot claim a model was loaded, a parameter changed, or a run
finished based on its own text: the bridge adds that statement only after the
corresponding backend result.  Tool failures become a structured chat event and
do not mutate the state optimistically.

## Event forwarding and browser protocol

The bridge owns one OpenCode SSE connection to `/event` and filters events by
the server-side OpenCode session ID. It maps OpenCode and Mesa changes into the
canonical browser SSE vocabulary defined in `ui-workflow.md` and
`backend-api.md` only: `project.snapshot`, `project.patch`,
`conversation.delta`, `agent.status`, and `connection.status`. There are no
alternative public `assistant.*`, `agent.tool`, `project.updated`, `run.updated`,
or raw-error event names. Model/run changes are represented by ordered
`project.patch` operations; assistant completion is represented by the final
message patch, not a separate completion event.

The mapping must tolerate reconnects, duplicated source events, unknown event
types, and a server version whose event payload changes.  It deduplicates by
source event/message/part ID where available and refetches the canonical session
or project state after reconnect.  It never relay-forwards raw OpenCode events:
they can contain paths, prompts, tool arguments, or credentials. The response
to a completed prompt is reconciled with session state before its terminal
conversation/project patch is published.

The browser reconnects to the demo SSE endpoint with a monotonically increasing
`ProjectState.revision`; on a revision gap it fetches the public session
snapshot route in `backend-api.md`.
This same stream carries Mesa updates, so the UI remains correct if the agent,
Playwright, or an individual network connection disappears.

Timeouts are terminally mapped rather than left as a spinner. A Mesa
`timed_out` status is represented in a `project.patch` with both the external
run status and `ProjectPhase` set to `timed_out`, plus the safe user-facing
reason "Simulation timed out". It is distinct from `failed`, terminal, and
unsuccessful. The Results pane must not render success metrics or call the
successful-results endpoint; it may offer the metadata and bounded log available
through the service. An OpenCode prompt timeout aborts that agent session,
publishes `agent.status: error` and a terminal conversation/project patch, and
leaves the last committed model/run state unchanged. In both cases a later user
action may start a new valid turn or run.

## Playwright is a projection, not a controller of state

For the local demonstration, Playwright attaches over CDP to the *same visible
right-hand workbench page* that the user is viewing.  A separate hidden browser
is not accepted as proof of user-visible completion.  The controller is limited
to stable `data-testid` locators and these intents:

```text
open_tab(files|parameters|run|results)
set_parameter(key, value)
start_run()
open_results(runId)
```

For every agent-triggered UI intent, the bridge performs this ordering:

1. validate and commit the domain action through the project/Mesa API;
2. publish the revised `ProjectState` to the page;
3. ask Playwright to enact or verify the equivalent visible UI action; and
4. record its observation separately (`uiControl: verified | failed`).

Normal human clicks follow the same domain API, then update state and render;
they do not communicate with OpenCode or Playwright.  A Playwright timeout or
selector failure never rolls back a completed model load, parameter patch, or
run.  It produces a visible control-warning and the user can continue manually.
Conversely, a DOM value is never treated as evidence that a run exists: run
status and result data are always read from the Mesa API/artifacts.

Only one browser-control command is allowed per project at a time.  It carries
the expected project revision and run/model IDs, and is discarded if state has
advanced.  The controller may not upload files, navigate away from the local
workbench origin, execute page JavaScript, accept downloads, or handle browser
permission prompts.

## Threat boundaries and safeguards

| Boundary | Risk | Required control |
| --- | --- | --- |
| Browser to demo backend | forged project, upload, or action | project-scoped server session; server-derived project ID; schema/size/type checks; CSRF/origin policy appropriate to the local app |
| Demo backend to OpenCode | key/host exposure or unrestricted execution | loopback-only server, random server password, backend proxy only, direct dangerous tools disabled, per-project workspace policy |
| OpenCode to files | path traversal or reading unrelated files | attachment IDs and resolved paths only; canonical containment check; read previews with byte/row limits |
| OpenCode to Mesa | arbitrary code execution or forged run result | one approved bundled `model_id`; Mesa materializes the reviewed asset and is the sole writer of run state |
| Playwright to UI | navigation/DOM injection or false success | fixed local origin, allowlisted intents/locators, expected revisions, backend result is the evidence |
| Logs/events to browser | secret, private path, or raw model output leakage | typed redaction boundary; no raw OpenCode SSE, env, headers, or workspace absolute paths |

The bridge must redact `Authorization`, API-key-like strings, OpenCode server
credentials, absolute workspace paths, and internal error stacks from UI events
and persisted chat transcript.  It must rate-limit prompt submissions and
uploads, enforce prompt/run timeouts, and expose a local shutdown that aborts
both session and Mesa work.  These are operational safeguards, not scientific
model validation.

## Required tests

1. **Startup/model discovery:** mock provider lists with an approved model, a
   missing configured model, and an unapproved default; verify no prompt is sent
   unless readiness is `ready` and no secret appears in output.
2. **Session lifecycle:** first prompt creates one session; a follow-up reuses
   it; busy prompt rejects concurrently; abort changes status; restart handles a
   stale session by creating a clean one with a project summary.
3. **Upload handoff:** valid CSV gets an immutable manifest; `../`, MIME/size
   mismatch, unknown attachment ID, and outside-workspace file references fail
   without calling OpenCode.
4. **Tool policy:** assert the agent receives no direct bash/network/arbitrary
   file/browser capability; reject an unknown tool and a tool that targets a
   different project; prove each approved tool has schema validation.
5. **State truth:** `select_and_load_model` calls only the documented Mesa `PUT`
   endpoint, and successful `set_parameters` and `run_experiment` update
   the backend before UI verification; simulate Playwright failure and verify
   the run remains queryable and the UI reports a non-terminal control warning.
6. **SSE:** replay duplicate/unknown/reordered OpenCode events and a reconnect;
   verify typed, redacted frontend events and canonical state recovery. Replay a
   Mesa `timed_out` update and assert a terminal UI failure with no success
   result fetch.
7. **Visible E2E:** with the live configured OpenCode provider/model, upload CSV
   in the left pane, select/load `queue-network-v1`, use the agent UI intent to show Parameters,
   set a value, run Mesa, show Results, and confirm the assistant summarises the
   artifact-backed metrics on the same visible page Playwright controls.

## Implementation assumptions to confirm at the integration gate

- The selected local OpenCode distribution exposes its current OpenAPI server,
  provider-list endpoint, asynchronous prompt endpoint, session abort endpoint,
  and SSE endpoint; the adapter will use the server's `/doc` contract rather
  than copy endpoint shapes from this document.
- The configured DeepSeek-compatible model supports the tool-calling quality
  needed for the restricted workbench surface. Fake agents are permitted only as
  isolated unit-test fixtures; they are not an E2E or release-gate substitute.
- The application can launch Chrome/Chromium with remote debugging and attach
  Playwright to the visible local workbench tab.  If this is unavailable, the
  UI-control demonstration is explicitly disabled; it is not silently replaced
  with a hidden browser.
- Mesa service exposes bundled model materialization through `PUT .../model`,
  its schema/parameter projections, run status, cancellation, artifact manifest,
  and result endpoints as described by `mesa-service.md`; it has no arbitrary
  model-plan endpoint or parameter-patch endpoint.

## Release gate: live OpenCode proof

Before a build is accepted, the integration owner must run against the locally
configured OpenCode process and the configured provider credential (not a fake
agent):

1. live health/version and provider/model discovery, with the selected approved
   model recorded without secrets;
2. one bounded chat turn using a disposable project; and
3. one bounded approved tool call (for example `select_and_load_model` with
   `queue-network-v1`) whose resulting backend snapshot/patch proves the action
   was materialized by Mesa.

The test must set hard prompt/tool timeouts, redact recorded output, clean up
the disposable project, and fail the release gate on discovery, chat, tool-call,
or redaction failure. A fake agent can test adapter branches but cannot satisfy
this gate.

## References

OpenCode's server exposes a headless local HTTP API, session APIs, provider
catalogue endpoints, asynchronous prompting, and SSE events; the installation's
OpenAPI document is the implementation authority.  See the
[OpenCode Server documentation](https://opencode.ai/docs/server/) and
[model configuration documentation](https://opencode.ai/docs/models).
