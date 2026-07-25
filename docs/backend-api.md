# Backend API contracts

- Status: active
- Role: normative contract
- Scope: implemented Stage 2 and Stage 3 HTTP/API boundaries plus retained legacy API history
- Source of truth: merged server/Store implementation and the Riff MVP PRD
- Last reviewed: 2026-07-25

## Milestone A2 authority and current A3 execution

The current product authority is the
[`Riff MVP PRD`](product-requirements.md). The
[`Milestone A2 design`](milestone-a2-agent-workspace-design.md) refines its
implemented Agent/API boundary; the legacy Gate API retained below does not.
`ProductStoreV2` through schema migration v9, execution
contract v4, and checked object bytes are
the durable authority. Browser/API callers cannot supply ownership, workspace
paths, file digests, OpenCode session identifiers, process commands, or
technical status.

The implemented Stage 2 and Stage 3 routes are:

| Route family | Current implemented contract |
| --- | --- |
| `GET /api/providers` | Discover backend-validated OpenCode provider/model pairs; return no credentials or upstream session IDs. |
| `POST /api/models` | Accept a name and initial provider/model, then atomically create a generic Model, its first conversation, and server-owned scaffold. |
| `GET /api/models/{modelId}/workspace` | Return an allowlisted, digest-bound Model workspace projection; never an absolute path or arbitrary file API. |
| `POST /api/models/{modelId}/technical-checks` | Start or idempotently return a digest-bound thin technical check using a `commandId`. |
| `GET /api/models/{modelId}/technical-checks/{checkId}` | Read the bounded check DTO and its `pending`, `published`, or `superseded` publication state. |
| `GET/POST /api/objects/{model|project}/{id}/conversations` | List/create owner-scoped named conversations. Provider/model locks with the first accepted user message. |
| `GET /api/conversations/{conversationId}` | Return the redacted durable conversation and public session state. |
| `GET /api/conversations/{conversationId}/messages` | Return the ordered Riff-owned transcript. Each message has `messageKind: "conversation" | "platform_card"`; a platform card is a system-owned terminal run record, not an Agent turn. |
| `GET /api/conversations/{conversationId}/documents` | Return persistent temporary-document cards separately from committed owner files. |
| `POST /api/conversations/{conversationId}/attachments` | Store a bounded canonical-base64 upload under the conversation with server-derived path and digest. |
| `POST /api/conversations/{conversationId}/turns` | Run an idempotent durable turn and return live or structured read-only state, messages, skill uses, and action records. Its optional structured `visualInteractionConfirmation` is the only request-level candidate for A3-2c3 visual interaction authority; ordinary `explicitImperative` is insufficient. |
| `POST /a2/mcp?cap=...` | Internal loopback JSON-RPC endpoint for the short-lived, server-minted turn capability; not a browser tool API. |
| `POST /api/projects` | Create a server-owned fixed copy from an active technically executable Model. |
| `GET /api/projects/{projectId}/workspace` | Return the allowlisted copied execution metadata, conversations, experiments, runs, and indexed output projections. |
| `POST /api/projects/{projectId}/experiment-configs` | Validate and canonicalize `ExperimentConfigurationV1`, expand its exact plan, and persist an immutable create-command response receipt. |
| `PATCH /api/projects/{projectId}/experiment-configs/{configId}` | Require `commandId`, `expectedConfigurationDigest`, and `expectedRecordDigest`; apply both CAS guards and preserve exact historical response replay. |
| `POST /api/projects/{projectId}/runs` | Replan and freeze the named experiment, apply server-owned limits, atomically create/replay the queued run receipt, and admit its declared supported batch or visual run kind to the shared dispatcher. |
| `GET /api/projects/{projectId}/runs/{runId}` | Return the bounded run projection and, only after atomic success, its checked output-index projections. |

The implemented experiment request fields are exact:

```ts
type ExperimentConfigurationV1 = {
  schemaVersion: 1;
  runKind: "batch" | "visual";
  parameters: JsonObject;
  sampling:
    | { kind: "single"; seed?: SafeInteger }
    | { kind: "multiple-seeds"; seeds: SafeInteger[] }
    | {
        kind: "cartesian-sweep";
        axes: Array<{ pointer: JsonPointer; values: JsonValue[] }>;
        seeds?: SafeInteger[];
      };
};

type CreateExperimentConfigurationRequest = {
  commandId: string;
  name: string;
  configuration: ExperimentConfigurationV1;
};

type UpdateExperimentConfigurationRequest = {
  commandId: string;
  expectedConfigurationDigest: string;
  expectedRecordDigest: string;
  name?: string;
  configuration?: ExperimentConfigurationV1;
}; // at least one of name/configuration is required
```

Both routes return the version-4 experiment DTO with `id`, `projectId`, `name`,
canonical `configuration`, `lifecycleState`, `createdAt`, `updatedAt`,
`contractVersion: 4`, `readOnly: false`, `legacyDigest: null`,
`configurationDigest`, `recordDigest`, and exact `sampleCount`.
`estimatedSampleCount` remains in the public DTO only as an equal-valued
compatibility alias. Callers do not send `sampleCount`, expanded samples,
server-derived IDs, sample-plan digests, or timestamps.

The A3-1b public start request is exact:

```ts
type StartProjectRunRequest = {
  commandId: string;
  experimentConfigId: string;
  completionConversationId?: string;
};

type RunStartDto = {
  schemaVersion: 1;
  commandId: string;
  runId: string;
  projectId: string;
  experimentConfigId: string;
  completionConversationId: string | null;
  status: "queued";
  runKind: "batch";
  sampleCount: number;
  createdAt: string;
};
```

Accepted starts return `201` and the exact durable receipt. Reusing the same
`commandId` with the same intent returns that same receipt, including after the
run has completed; changed intent fails idempotency. The route owns
`projectId`. Callers cannot provide a Project path, execution root, snapshot or
plan digest, sample expansion, limits, process command, attempt identity, or
output metadata. Unknown fields fail with `422 unknown_field`.

The public read DTOs are allowlisted:

```ts
type ProjectRunDto = {
  id: string;
  projectId: string;
  experimentConfigurationId: string;
  status: string;
  requestedSampleCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  contractVersion: 3 | 4;
  readOnly: boolean;
  legacyDigest: string | null;
  runKind: "batch" | "visual" | null;
  cancelRequestedAt: string | null;
  terminalCode: string | null;
  completionCardDisposition: string | null;
  terminalStatus: "succeeded" | "failed" | "cancelled" | "timed_out" | null;
  terminalClosureDigest: string | null;
  lifecycleDigest: string | null;
  outputs: ProjectOutputDto[];
};

type ProjectOutputDto = {
  id: string;
  runId: string;
  logicalName: string;
  outputType: string;
  contractVersion: 3 | 4;
  readOnly: boolean;
  legacyDigest: string | null;
  sampleIndex: number | null;
  sampleId: string | null;
  declaredRole: string | null;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};
```

Non-succeeded run projections return `outputs: []`. A succeeded run exposes
only atomically published indexes whose bytes, size, and SHA-256 were rechecked;
the current A3-2d1 list/download endpoint adds authenticated same-run access
without changing this A3-1b projection.

The A3-1c-a cancellation request is exact:

```ts
type CancelProjectRunRequest = { commandId: string };
```

`POST /api/projects/{projectId}/runs/{runId}/cancel` returns `200` with the
durable `RunCancelReceiptV1`:

```ts
type RunCancelReceiptV1 = {
  schemaVersion: 1;
  commandId: string;
  projectId: string;
  runId: string;
  applied: boolean;
  code:
    | "cancellation_requested"
    | "cancellation_already_requested"
    | "run_already_terminal";
  status: "cancelling" | "succeeded" | "failed" | "cancelled" | "timed_out" | "trashed";
  cancelRequestedAt: string | null;
  createdAt: string;
};
```

The first nonterminal cancellation has `applied: true`; a distinct later
command while that intent is pending has `applied: false` and
`cancellation_already_requested`. A terminal-first command has `applied: false`,
`run_already_terminal`, and the exact terminal status. Same-command retries
return the original receipt even after later terminalization. Reusing a command
for another run or intent fails with `idempotency_conflict`. While the persisted
run remains `queued` or `running`, public run DTOs project `cancelling`.
Schema migration v5 binds the first cancellation timestamp and command ID to
the exact same-run committed `run.cancel.v1` payload, intent digest, outcome,
payload digest, and timestamps; raw unbound or mismatched cancellation state is
rejected.

### A3-2d3 direct run controls (merged through PR #45)

The existing cancel request remains deliberately exact and unchanged:

```ts
type CancelProjectRunRequest = { commandId: string };
```

`POST /api/projects/{projectId}/runs/{runId}/cancel`, `.../trash`, and
`.../restore` all require the current browser
app authority: the exact app `Host` and `Origin`, same-origin Fetch Metadata
(`Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: cors`,
`Sec-Fetch-Dest: empty`), the current HttpOnly app cookie, matching CSRF token,
and exact `application/json` request framing. Browser-side bearer
`Authorization` is not an alternative. The legacy listener rejects these
direct controls. This is a browser-app admission boundary, not a multi-user
principal claim.

The two new candidate request shapes are exact:

```ts
type TrashProjectRunRequest = {
  commandId: string;
  expectedLifecycleDigest: string;
  confirmation: {
    action: "trash_run";
    projectId: string;
    runId: string;
    terminalStatus: "succeeded" | "failed" | "cancelled" | "timed_out";
    terminalClosureDigest: string;
  };
};

type RestoreProjectRunRequest = {
  commandId: string;
  expectedLifecycleDigest: string;
};
```

They produce durable, exact-replay receipts named `run.trash.v1` and
`run.restore.v1`; reuse with changed intent fails with
`idempotency_conflict`. `terminalClosureDigest` commits immutable terminal
evidence and does not change. `lifecycleDigest` commits current lifecycle
state and complete ordered trash history, so it changes on every successful
trash or restore. Trash is allowed only from a terminal v4 run and restore
returns that run only to its exact prior terminal status; both reject stale or
cross-run/project bindings.

Before the Store commit for a new trash command, the implementation revokes active
output-download streams and current visual frame/WebSocket plus
Visual-Agent/Playwright authority for the run. Restore restores durable
visibility only: it never revives an old frame/WebSocket capability, cursor,
confirmation, or download authority. These direct controls do not call or
depend on OpenCode.

Opaque OpenCode sessions and MCP capabilities stay backend-only.
Provider/OpenCode unavailability returns explicit read-only state and never a
canned Agent response. Model mutation is limited to typed current-Model tools;
Project conversations cannot mutate Model code, schemas, execution description,
or dependencies.

The Stage 2 process boundary is macOS/local-user `sandbox-exec` with a
Model-owned writable root, scrubbed environment, denied network by default,
finite time/output/process limits, and read-only access only to the fixed Python
application/framework and exact configured virtual-environment roots needed by
the backend-selected interpreter. Arbitrary home, repository, credential, and
sibling paths remain denied. It is not hostile-code containment.
`technicalStatus: "executable"` means the thin technical checks passed; it is
not a scientific-validity, calibration, trust, or recommendation field.

The run boundary accepts only a copied execution-description v2 with
`inputs.schemaProfile: "riff-json-schema-2020-12-v1"`, required smoke input,
declared outputs/cancellation, and the matching batch or visual protocol. It
revalidates the frozen plan against the copied schema. The official generic
scaffold now emits v2 with batch capability only. A3-1b publicly starts and
reads runs, dispatches a real `riff-batch-v1` process per sample, enforces the
currently supported hard limits, and atomically publishes successful outputs.

`RunLimitsV1` is server-owned. A3-1b hard-enforces sample count, concurrency,
wall time, termination grace, stdout bytes, stderr bytes, output file count,
output bytes, and scratch/Project integrity. CPU time, resident memory, and
model-spawned process-count limits are not accepted as supported limits.
Published A3-2a2c enforces `startupTimeMs` for admitted visual work. Visual
starts that supply `completionConversationId` fail with HTTP `422` and
`visual_completion_not_supported`. A3-2d2, merged through PR #44, enforces frozen
`maxEventCount` and `maxEventBytes` for declared diagnostic NDJSON; undeclared,
invalid, or over-limit event files fail before terminal success publication.

Admission and request failures use stable codes including `unknown_field`,
`invalid_request`, `resource_not_found`, `state_conflict`,
`idempotency_conflict`, `legacy_contract_read_only`,
`execution_protocol_upgrade_required`, `capability_not_declared`,
`capability_not_available`, `events_not_available`,
`project_snapshot_corrupt`, `invalid_sample_plan`, and
`sample_limit_exceeded`. Batch terminal codes include
`batch_run_succeeded`, `batch_process_failed`, `run_wall_timeout`,
`run_stdout_limit`, `run_stderr_limit`, `run_output_file_limit`,
`run_output_byte_limit`, `run_output_invalid`,
`process_cleanup_unverified`, `dispatcher_shutdown`,
`dispatcher_heartbeat_failed`, `batch_publication_failed`, and
`run_cancelled`; an unexpected
supervisor failure records `batch_supervisor_failed`.

The dispatcher shuts down in-process work through an abort signal, verified
process-group termination, owned-scratch cleanup, and a durable failure.
Heartbeat, capability, supervisor, output-consumption, and publication
exceptions use the same best-effort unwind. A run terminalizes only after every
registered process has durable exit and cleanup evidence; otherwise it stays
live and recovery-required rather than publishing a false failure/success.
On startup A3-1c-b audits recovered successes, drains committed queued
cancellations, and reconciles durable v4 prior attempts before a candidate
dispatcher generation activates. A planned scratch path must be absent; a
created lease without a durable launch receipt, PID/start-token mismatch,
ownership/inode drift, or unverified group cleanup fails closed with
`dispatcher_recovery_required` and is not deleted or signalled speculatively.
Only exact registered scratch paths are removed; the scratch root is never
scanned. A3-1c-a orders cancellation versus terminal publication by SQLite
commit order, and that precedence is preserved during recovery.
An unfinished recovery action is adopted across newly randomized dispatcher
generations by prior attempt identity. A second in-process dispatcher for the
same Store is rejected while the first owns it. Schema-v5 live process rows
without v6 scratch/launch evidence are a documented fail-closed migration
boundary and require repair rather than speculative signalling.
A3-1c-c publishes a terminal batch completion card in the same transaction as
the run disposition. Active or archived bound conversations receive one
deterministic `platform_card`; absent bindings record `not_requested`, and
missing/trashed bindings record permanent `conversation_unavailable`. The card
contains only `runId`, terminal `status`, `sampleCount`, `outputCount`, and
`outputIds`. Startup reconciles older terminal `pending` rows and fails closed
if a final disposition, receipt, message, or card digest disagrees.
Visual dispatch/admission now uses the existing Project-run resource. Output
downloads, events, browser broker/frame routes, wind migration, and final shell
routes remain later #14/#15 work. The legacy Gate API below still coexists until
separately reviewed retirement.

### A3-2 visual API/runtime gates

The A3-2a1 schema-v8, private Store evidence, and cross-restart visual
reconciliation boundary was merged and published through PR #28. A3-2a2a was
merged and published through PR #29 at merge commit `1584e39`; it supplies
schema-v9 and private Store visual authority. A3-2a2b was merged and published
through PR #30 at merge commit `9f23f61`; its generic single-attempt supervisor
starts a real child behind the durable gate and enforces the visual sandbox,
exact process/listener identity, bounded health, output, and cleanup.
A3-2a2c was merged and published through PR #31 at merge commit `361b36f`.
One shared dispatcher generation owns independent batch and one-slot visual lanes, exact-generation
heartbeat/cancel/finalize, a fatal-error latch, stop join, and
generation-fenced cleanup of unlaunched visual scratch. Existing Project-run
admission accepts visual experiments, restart audit requires exact visual
success evidence, and the real-process public vertical plus secrecy gate pass.
The final full backend gate reports 385 total with 384 passed, zero failed,
and one optional installed-OpenCode smoke skipped; the focused 13/13 gate
covers the review regressions; web passes 104/104 and the production build
succeeds. A3-2b is published; A3-2c and A3-2d remain target contracts, not
current routes or acceptance evidence:

1. **A3-2a1 schema-v8/Store/recovery:** schema v8 now extends schema-v6 scratch
   and launch evidence to the existing schema-v4 visual process shape, makes
   its launch-bound port immutable, and adds an atomic one-time `health_at`
   plus separate immutable health receipt. Private Store methods now preserve
   exact visual run/attempt/generation/process/PID/start-token/process-group/
   port/scratch identity through launch, registration, gate release, running,
   health, heartbeat, exit, and cleanup. Cross-restart reconciliation now
   validates and adopts only exact durable visual evidence before any
   inspection or signalling. At this published A3-2a1 gate, the public start
   route returned HTTP `409` `capability_not_available` for a visual experiment
   without `completionConversationId`; if that field was supplied, its earlier
   gate returned HTTP `422` `visual_completion_not_supported`.
2. **A3-2a2a schema-v9/Store authority — merged and published in PR #29:**
   schema v9 replaces the former batch-only success/output triggers with an
   atomic context bound to both `runId` and `runKind`. It rejects visual
   completion conversation/disposition/card state in migration and future
   writes. Private Store methods generation-fence visual claim, finalize queued
   cancellation without a card, preserve cancellation precedence on terminal
   failure/timeout, and publish visual success plus required outputs atomically
   only after one healthy, exit-zero, verified-cleanup process. Public admission
   remains unchanged.
3. **A3-2a2b generic single-attempt visual supervisor — merged and published
   through PR #30 at `9f23f61`:** the
   real-process supervisor and process safety primitives implement the private
   canonical input/argv, durable launch gate, visual-only sandbox, exact
   PID/start-token/process-group and listener checks, one-shot health, bounded
   output validation, and exact cleanup. They do not claim queue dispatch,
   public admission/API, broker, frame, WebSocket, or browser behavior.
4. **A3-2a2c dispatcher/public admission — merged and published through PR #31
   at `361b36f`:** the one-slot
   visual scheduler continues independent batch dispatch under one shared
   generation and exact heartbeat/cancel/finalize authority. Its fatal latch,
   stop join, generation-fenced unlaunched-scratch cleanup, and exact visual
   success restart audit close dispatcher ownership. The existing
   `/api/projects/{projectId}/runs` resource accepts eligible visual
   experiments and returns the existing allowlisted run DTO; no parallel
   visual-run API is introduced.
5. **A3-2b1 browser network topology — merged and published through PR #33:**
   the isolated
   `BackendApp` entrypoint exact-binds platform app and empty broker servers to
   distinct server-owned `::1` ports, derives CSP-compatible exact
   `localhost:<port>` browser authorities, and
   rejects non-canonical Host counterexamples before invoking either handler.
   Startup and close are serialized and partial listener pairs do not admit
   requests. Route-specific Origin/Fetch-Site checks are supplied by A3-2b2.
6. **A3-2b2 frame bootstrap and HTTP proxy — merged and published through
   PR #35:** browser bootstrap, CSRF, cookies, one-time nonce redemption,
   visual frame sessions, isolated broker HTTP forwarding, and exact CSP use
   the A3-2b1 topology.
7. **A3-2b3 WebSocket, revocation, and secrecy — merged and published through
   PR #36 at `bb54b2a`:** exact path/subprotocol forwarding, fixed-child
   inspection, assembled-message/queue/connection/handshake/idle limits,
   socket-first generation/lifecycle revocation, redirect/non-`101` denial, and
   observable response/header/log/DTO/SQLite sentinel scans are implemented.
   Its publication gate reported 464 total with 463 passed, zero failed, and
   one optional smoke skipped.
   Parser-level malformed HTTP is `400/broker_request_failed`; parsed HTTP with
   malformed or duplicate WebSocket handshake structure is
   `400/visual_websocket_protocol_denied`; non-GET is
   `405/visual_websocket_protocol_denied`; missing broker authority is
   `403/visual_frame_session_denied`; offered-subprotocol/policy denial is
   `403/visual_websocket_protocol_denied`.
8. **A3-2b4 browser and security closeout — merged and published through
   PR #37:** the production exact-app host page, browser
   cookie jar/HttpOnly/SameSite behavior, nonce redirect/replay, relative
   resources, CSP/SOP/sandbox hostile embedding, native WebSocket
   Origin/cookie/subprotocol, Service Worker denial, no-store reload, and
   generation close-`1008`/reconnect denial, expiry, and backend-restart
   invalidation pass the dedicated 5/5 Chromium
   matrix; the complete Chromium suite passes 8/8. The current backend gate
   reports 466 total with 465 passed, zero failed, and one optional
   installed-OpenCode smoke skipped; web passes 104/104, network entry 1/1,
   and the production build succeeds. This is not Firefox/WebKit or
   remote/HTTPS acceptance.
9. **A3-2c Playwright — merged through PR #42:** authority/audit, bounded
   observation, one-use typed interaction, and live-CDP Chromium security
   closeout are published.
10. **A3-2d generic outputs/events/direct controls — in progress:** d1
    same-run output list/download was merged through PR #43. d2 bounded
    declared diagnostic-event ingestion and opaque cursor reads were merged
    through PR #44. Direct trash/restore and complete Agent-independent
    controls were merged through PR #45.

For A3-2a2 an accepted visual child receives the same canonical single-sample
input envelope as batch through `--riff-input`, an assigned
`--riff-output-dir`, fixed `--riff-host 127.0.0.1`, and a server-assigned
`--riff-port`. Normal exit code zero becomes success only after every required
declared output validates and publishes atomically. Health alone or exit zero
alone is insufficient.

A3-2a2 uses a visual-specific macOS sandbox profile. It allows bind/listen only
on the assigned `127.0.0.1:<port>` and denies other listeners, outbound
connections, direct network access, and every IPv6/`::1` bind. If endpoint-level
bind filtering is not available on the installed `sandbox-exec`, exact OS
ownership inspection must fail a child/process group with any listener other
than its assigned IPv4 endpoint; the profile must still deny all outbound
access. The exact listener set is checked before health, while running, and at
termination.

Visual completion cards are unsupported. If the start request names
`completionConversationId` for a visual experiment, the Project API rejects it
with HTTP `422` and stable code `visual_completion_not_supported`. An accepted
visual start records `completionConversationId: null`; its run projection
retains `completionCardDisposition: "not_requested"`, and terminalization does
not create a `run_completion_cards` receipt or transcript message. The Store
and Project API, not page state or Agent prose, remain lifecycle authority.

Schema v4 already supplied visual `process_kind`, `loopback_port`, `health_at`,
and the one-live-process index, but before v8 the port could be updated and
health lacked a complete one-write/receipt CAS. Schema v8 does not add those
fields again. The current v8 triggers reject every port update and permit
health only as one same-transaction
null-to-receipt-timestamp `health_at` update plus unique receipt for the exact
running visual process with matching launch/port/path/run/attempt/process
identity. Health-only, receipt-only, timestamp mismatch, later update, and
second receipt fail. Because pre-v8 public visual dispatch never existed, any
unproven pre-v8 visual `health_at` or live process evidence fails migration
closed instead of becoming healthy. All evidence remains private.
Schema v9 is the current product-database authority. It is required because the
prior v4 atomic-success and output-object/index triggers were batch-only. The v9
replacement binds the internal success context to both run identity and run
kind, preserves the batch contract, and permits visual success/output writes
only with the matching visual context and complete visual success evidence.
No Project workspace, run DTO, transcript, completion record, error, or
ordinary log may expose a child port or convert it into a public URL. Port
selection has a bounded local close-then-bind TOCTOU window; A3 does not claim
strong reservation. Before health commits, the supervisor must verify the
listener belongs to the exact recorded child/process group and is bound only
to its assigned loopback endpoint. OS listener readiness is detected without
HTTP; then the check runs immediately before and after one exact
manual-redirect `GET` to
`http://127.0.0.1:<assigned-port><healthPath>`. Every `3xx`, non-`200`,
oversized header/body, deadline overrun, replacement window, wildcard, or
ambiguous ownership fails closed. A same-identity compare-and-set permits only
one immutable health receipt. There is no HTTP retry; concurrent or repeated
invocations cannot send a second request. `startupTimeMs` covers readiness and
that one request.

A3-2a2 sets server-owned `maxActiveVisualRuns = 1` without changing the batch
cap. The active map is keyed by exact `(runId, attemptId)`. At capacity the next
visual run remains queued while eligible batch work continues. Every lane uses
its claim dispatcher generation for heartbeat/finalize; the slot is released
only after exact terminal commit and verified process/scratch cleanup.
Dispatcher stop aborts and awaits all active lanes before returning. These
rules do not weaken cancellation precedence, timeouts, or restart cleanup.
The published A3-2a1/A3-2a2a/A3-2a2b/A3-2a2c slices expose
dispatcher-backed visual admission only through the existing Project-run API.
They expose no child port, proxy, frame, WebSocket, Playwright capability, or
positive browser claim. Supplying `completionConversationId` still fails with
HTTP `422` `visual_completion_not_supported`.

The run response continues to use the same `ProjectRunDto`, with
`runKind: "batch" | "visual"`. Stable visual pairs are
`succeeded/visual_run_succeeded`, `failed/visual_process_failed`,
`failed/visual_health_failed`, `failed/visual_listener_invalid`, and
`timed_out/visual_startup_timeout`. Visual work also uses
`timed_out/run_wall_timeout` and the existing `failed` stdout/stderr/output/
cleanup/heartbeat limit codes. Same-process shutdown is
`failed/dispatcher_shutdown`; restart reconciliation is
`failed/runtime_interrupted`; cancel-first is `cancelled/run_cancelled`.

The exact app serves
`GET|HEAD /browser/projects/{projectId}/runs/{runId}/visual`. The fixed
no-store page performs bootstrap and frame-session issue from the exact app
origin, retains CSRF and `frameUrl` only in closure memory, verifies the exact
broker origin, and embeds one
`sandbox="allow-scripts allow-same-origin"` iframe. Its nonce-based CSP allows
connections only to self, framing only from the exact broker, and ancestors
only from self. `GET` admits only a top-level browser navigation:
`Sec-Fetch-Site` must be `none` or `same-origin`, `Sec-Fetch-Mode` must be
`navigate`, and `Sec-Fetch-Dest` must be `document`. This prevents another
local same-site page from using a cross-origin top-level navigation as a
bootstrap-generation revocation primitive. `HEAD` is side-effect free and
does not bootstrap.

For A3-2b, platform app and visual broker both exact-bind IPv6 loopback `::1`
on different server-owned ports, with URLs
`http://localhost:<app-port>` and `http://localhost:<broker-port>`, while both
listeners exact-bind IPv6 loopback `::1`. Each accepts only
its configured `Host:port`; the broker also requires the exact route path.
Different ports create separate origins for DOM access while the shared host
remains same-site for `SameSite=Strict`. App and broker cookies still cross
ports and are not isolated from each other. The actual host separation is that
platform `localhost` cookies are not sent to the untrusted child at
`127.0.0.1`. While the topology is live, same-numbered IPv4 denial
reservations hold both platform ports on `127.0.0.1`, so a child-side listener
cannot take over either `localhost` authority through IPv4 resolution.

The app cookie is random, host-only, HttpOnly, SameSite=Strict, has no `Domain`,
and uses `Path=/api/`. It may omit `Secure` on current HTTP and must set it
under future HTTPS. The server-side session lifetime is 15 minutes, and cookie
`Max-Age` and `Expires` encode the same lifetime. Bootstrap rejects
missing/`null`/wrong exact app
`Origin`, wrong `Host:port`, or a `Sec-Fetch-Site` value other than
`same-origin`. A successful new bootstrap rotates the browser-session
generation and revokes older frame/WS capabilities before returning.
Frame-session requires the exact app cookie, CSRF, Origin, and Fetch-Site.
Bootstrap and frame-session support only `POST` and preflight `OPTIONS`; CORS
permits credentials only for the exact app origin, methods `POST, OPTIONS`, and
headers `Content-Type, X-Riff-CSRF`. Both successful POSTs return HTTP `201`.
The Vite origin is rejected. Origin and Fetch-Site mitigate browser CSRF and do
not authenticate arbitrary local native clients.

The first nonce-bearing broker navigation normally has no `Origin`; it requires
the exact broker Host/path, live generation/Project/run/attempt/expiry binding,
and atomic one-use nonce whose expiry is no later than 60 seconds after issue
or the attempt expiry.
Redemption within 60 seconds may succeed once; expiry, restart, or a new browser
generation invalidates it immediately. Redemption returns HTTP `303` with a
relative nonce-free `Location`. After that redirect, HTTP navigation and
subresources without `Origin` require the exact broker cookie; requests with
`Origin` additionally require the exact broker origin. WS always requires the
exact broker Origin, so missing, `null`, app, child, or another origin fails.
The in-memory registry binds the nonce/capability to browser-session generation,
Project, run, attempt generation, expiry, and the live socket set; durable audit
facts contain no secret. Revocation closes all sockets before deleting the
entry.

The broker cookie has a random independent name, is host-only, HttpOnly,
SameSite=Strict, has no `Domain`, uses the exact broker path, and expires at
`min(attempt claimedAt + frozen wallTimeMs, issue time + 15 minutes)`. It may
omit `Secure` on current HTTP and must
set it under future HTTPS. Cookie `Path`
is not a trusted authorization boundary: the app never accepts the broker
cookie and the broker ignores all other cookies. Authorization is the one-use
capability plus live binding, CSRF/Origin, exact Host/port/path, and expiry.

`riff-visual-v1` adds no execution-description field for frame HTTP. Beneath
the minted nonce-free capability base, only `GET` and `HEAD` with a normalized
same-origin suffix are forwarded. Query is allowed when normalized path plus
query is at most 4,096 bytes; request bodies are denied. Visual applications
must use relative document, CSS, script, and fetch references beneath the
capability base. Root-absolute application routes are not rewritten and remain
denied by the broker. Child request headers
are limited to `Accept`, `Accept-Language`, `If-None-Match`,
`If-Modified-Since`, and `Range`, with exact child `Host` and
`Accept-Encoding: identity`. Child response headers are limited to
`Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`,
`Last-Modified`, and `Cache-Control`. `Set-Cookie`, `Location`, `Refresh`,
authentication, CORS, credentials, nonce/capability, and hop-by-hop headers are
removed.
The broker replaces child `Cache-Control` with `private, no-store`; a cached
nonce-free route must never bypass generation, cookie, Store, or listener
admission after rotation or revocation.

Every child `3xx` is rejected without following. Request and response headers
are each bounded to 32,768 bytes, response body to 8 MiB, the child exchange to
5,000 milliseconds, and concurrent HTTP requests to eight per capability.
Current Store generation, unexpired dispatcher lease, matching process
heartbeat, and exact OS listener ownership are checked before and after each
exchange. OS inspection is asynchronous, serialized, globally bounded, and has
a 5,000 millisecond queue-plus-inspection deadline.
Stable errors are `browser_method_denied` (`405`),
`browser_session_denied` (`403`), `visual_frame_unavailable` (`409`),
`visual_frame_nonce_invalid` (`404`), `visual_frame_session_denied` (`403`),
`visual_frame_proxy_denied` (`404` or `405`),
`visual_frame_proxy_redirect_denied` (`502`),
`visual_frame_proxy_limit_exceeded` (`502`),
`visual_frame_proxy_timeout` (`504`), and
`visual_frame_proxy_failed` (`502`).

Real-browser evidence proves the iframe sends the cookie, JavaScript cannot
read it, and cross-origin DOM access fails. Every broker document replaces
child framing policy with CSP
`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none';
form-action 'none'; frame-src 'none'; frame-ancestors
http://localhost:<exact-app-port>`, with no wildcard, and sends no
`X-Frame-Options`. Only the exact app may embed it. App,
broker, and child headers/logs are scanned for all cookie, nonce, including
expired nonce values, capability, URL, and child-port secrets; those values are
also absent from public DTOs. SQLite contains no browser nonce, cookie, frame
URL, or capability. It retains child ports only in the schema-defined private
process-attempt, launch, and health evidence required for exact recovery; that
evidence cannot restore browser access after restart.
The scan covers broker-generated metadata and transport headers/logs, not
arbitrary model-authored response bytes: the child already knows its own
listener, and a literal payload scan is not an authorization control. Active
frame HTML/JavaScript is an operator-provided, trusted-browser-code input to
A3-2b; this is a local deployment assumption, not a runtime review assertion. An
arbitrary adversarial active payload requires a future trusted data-only wrapper
or browser-inaccessible transport and is not enabled by this contract.
A3-2c is subsequent and never reuses a user frame URL or cookie. It does not
reuse the ambient legacy `RIFF_CDP_URL` projector. Its internal capability is
derived from the durable conversation and originating turn, is one-turn and
one-use for interaction, and resolves the current Project/current healthy
attempt on the server. Observation metadata is a dedicated immutable bounded
audit fact; large observation bytes are ephemeral or an explicitly retained
temporary document. Typed interaction accepts only accessibility role plus
bounded accessible name, or a bounded label—not CSS, XPath, arbitrary text
selectors, JavaScript, or caller-supplied URLs.

A3-2c1, merged through PR #38, implements only the backend-private authority
and audit foundation. It derives scope from the
durable conversation and originating turn, requires exactly one current healthy
Project visual attempt, consumes before revalidation or side effect, and
revokes on turn release, dispatcher run revocation, backend close, expiry, and
restart. Its append-only audit stores bound IDs, finite lifecycle/operation/
action/locator kinds, and SHA-256 commitments for process identity, capability
epoch/reference, locator role/name-or-label, and typed value. It stores no
capability, browser URL/port/cookie/nonce, locator text, typed value,
observation summary/content, DOM, or screenshot bytes. A3-2c1 adds no HTTP
route, Playwright runner, or OpenCode observation/interaction tool; those remain
A3-2c2+ work.

A3-2c2 exposes one Project-only MCP tool:
`riff_observe_current_visual({kind})`, where `kind` is exactly `structured`,
`accessibility`, `dom_text`, or `screenshot`. The caller cannot supply or
override the Project, run, attempt, URL, host, port, path, cookie, nonce,
capability, selector, script, or browser profile. The server internally
mint-consumes one observation grant, re-resolves the sole healthy target,
checks its exact listener and connected peer before sending an exact bounded
GET, and revalidates the complete authority tuple before returning. Text/JSON
and PNG DTOs are schema-versioned and explicitly untrusted; screenshot bytes
are emitted as bounded MCP image content. Root HTML is rendered with scripts
disabled and all subsequent HTTP/WebSocket traffic denied. No observation
content or bytes enter the append-only audit.

### A3-2c3 typed interaction (merged through PR #41)

This branch implements an internal MCP candidate, not a browser or public HTTP
route.
Only a durable human turn with an accepted optional structured
`visualInteractionConfirmation` may expose
`riff_interact_current_visual({})`; its input is exactly the empty object.
The immutable user message retains only a digest marker for that confirmation,
not a reusable confirmation value. A generic `explicitImperative`, Agent text,
DOM text, or observation cannot authorize this tool. The server matches the
process-local normalized operation to that immutable user-message digest
marker, then binds it into the private capability; it never derives the action
from tool input. The schema-v11 audit uniqueness gate admits only one
interaction mint for that turn and action commitment, so restart or concurrent
replay cannot reuse the human confirmation.

The c3 candidate runner uses a fresh backend-only browser profile and a private
GET/HEAD bridge that verifies the exact listener and connected peer for every
child connection. It does not reuse the A3-2b frame URL, broker/app cookie,
nonce, WebSocket route, or the legacy `RIFF_CDP_URL` projector. It admits one
local typed click/type/select interaction only, atomically consumes its
one-use capability before the side effect, and returns a bounded, explicitly
untrusted dispatched receipt. It does not proxy child HTTP writes or establish
domain success. Navigation, popups, uploads/downloads, clipboard, permission
or credential prompts, Service Workers, WebSockets, and unlisted network
traffic fail closed.

### A3-2c4 browser/security closeout (merged through PR #42)

The c4 review branch starts a real live-CDP Chromium alongside the published
`BackendApp -> AgentTurnRuntime -> VisualAgentAuthority -> VisualAgentInteractor`
turn chain. The scoped interaction reaches only its fresh browser and private
child bridge: the configured CDP proxy receives zero post-reset connections,
the legacy page and its cookie/storage/frame canaries remain unchanged, and
`drive_workbench_ui` stays absent and undispatchable. Separate real-Chromium
cases cover POST, popup, navigation, dialog, WebSocket, Service Worker, form,
upload, download, clipboard, permission, credential challenge, response
`Set-Cookie`, and non-empty MCP input. The merge matrix passes 6/6.

Its canary scan covers the public turn DTO, real MCP list/results/errors,
authority audit-fact boundary, real SQLite/WAL/SHM bytes, child requests, and
explicit Error fields. It excludes model-authored child response bytes from
the persistence claim: those bytes are untrusted input, not a secret boundary.
Two independent final reviews reported no P0/P1 blocker before PR #42 merged.

A3-2d follows the existing committed output index. A3-2d1 was merged through
PR #43 and implements same-run list/download with path/size/digest
revalidation. The merged A3-2d2 boundary adds declared diagnostic NDJSON
ingestion with strict UTF-8/LF, structural/schema/count/byte limits, schema-v12
atomic event-set publication, and authenticated opaque cursors bound to the
Project/run/contract/event-set/lifecycle digest, persistent trash history,
normalized filters, and
limit. Direct trash/restore acceptance was merged through PR #45. Cancel already
exists. Legacy wind/Gate event and download endpoints are not A3-2d evidence.
A3-3 diagnostic-event acceptance is unblocked by the published A3-2d2 boundary.

The current A3-2d2 route is:

```text
GET /api/projects/:projectId/runs/:runId/diagnostic-events
  ?cursor=<opaque>
  &limit=<1..100>
  &type=<exact-type>
  &sampleIndex=<non-negative-integer>
  &occurredAfter=<exact-UTC-instant>
  &occurredBefore=<exact-UTC-instant>
```

Every query key is optional and may occur once; default `limit` is `50`.
Pagination is forward immutable-sequence order. Success is exact JSON
`{items,nextCursor,truncated}` where each item contains only `sequence`,
`sampleIndex`, `type`, nullable `occurredAt`, and structured `payload`.
Responses are `private, no-store` with `nosniff`. Cursor/filter/limit
substitution, cross-Project/run use, expiry, key epoch change, event-set drift,
and Project lifecycle or trash-history change fail closed. `events_not_available`
is `409`, invalid query/cursor is `422`, and byte/row integrity drift is the
generic `500 event_integrity_failed`; paths, SQLite identities, cursor keys,
and expected digests are not returned.

A3-2d list/download/event reads require the exact current single-user app
session and Host, same-origin Fetch Metadata, and the exact
Project/run/output ownership tuple; they emit private no-store responses. This
is local Product tuple authorization, not a multi-user principal claim. The d1
browser client must use same-origin `fetch` (`cors`/`empty` Fetch Metadata);
top-level or anchor navigation is not accepted by this route. Direct
cancel/trash/restore routes additionally require exact Origin, CSRF, JSON
non-simple content type, and command idempotency. Cancel retains its published
`{commandId}` body; trash and restore additionally compare the exact
`expectedLifecycleDigest`, and trash binds explicit terminal confirmation to
`terminalClosureDigest`.
Project/run/output IDs are not bearer credentials. Output download is
attachment-only and verifies the complete digest before sending bytes from the
same no-follow open descriptor. Diagnostic event content is untrusted model
output and cannot become a user instruction or tool authority. Event cursors
are bounded MACed values bound to Project/run/contract/event-set/lifecycle
generation/direction/limit/all normalized filters and remain valid across
ordinary restart until expiry or key-epoch rotation. The current implementation
creates its restart-stable installation key directly at the final path with
`O_EXCL` and owner-only permissions. Atomic publication and concurrent
first-start convergence remain review gaps and are not current claims. The key
is absent from SQLite, DTOs, errors, logs, and child environments; ordinary
backup/export exclusion also remains unverified and is not claimed. Missing or
corrupt key state fails closed rather than silently regenerating once event
sets exist. Run trash denies event reads and changes the lifecycle binding, so
restore does not revive an old cursor. The A3-2d3 implementation also
revokes active downloads before its Store commit. Its full backend/web/network/
build/docs gates pass and final independent security review has no P0/P1
finding.

---

# Legacy durable project and backend API target

## Status

This Gate 0 contract describes the former Gate 2 target. It is retained as
implementation history and may still describe coexisting legacy queue/wind
code. It is not the current Milestone A2 API authority.

The backend is the only browser-facing authority. It owns durable project
identity, project snapshots, business artifacts, issue/attestation records,
experiment revisions, command idempotency, OpenCode adaptation, and Mesa
orchestration. The browser never supplies workspace paths, Mesa project IDs, or
OpenCode session IDs.

## Identity and mutation envelope

`projectId` is durable. `sessionId` is a temporary browser/OpenCode control
connection. Reopening a project or restarting the backend preserves project and
revision identities.

Every browser mutation includes:

```ts
type ProjectCommand<T> = {
  commandId: string;
  projectId: string;
  sessionId: string;
  baseSnapshotRevision: number;
  payload: T;
};
```

`commandId` is idempotent. A stale `baseSnapshotRevision` returns `409`; schema
failure returns `422`; unknown or cross-project identities return `404`; unsafe
payload size returns `413`/`429`. Accepted commands publish later authoritative
snapshot/patch events. A `202` acknowledgement is not itself state.

## Browser-safe project projection

The canonical projection contains bounded data and references:

```ts
type ProjectState = {
  projectId: string;
  snapshotRevision: number;
  phase: string;
  actors: DeclaredLocalActor[];
  attachments: Attachment[];
  conversation: Message[];
  current: {
    decisionBriefRevisionId?: string;
    alignmentMapRevisionId?: string;
    modelRevisionId?: string;
    experimentRevisionId?: string;
    runId?: string;
  };
  model?: ModelProjection;
  experiment?: ExperimentProjection;
  workflow: WorkflowProjection;
  issues: IssueSummary[];
  attestations: AttestationSummary[];
  run?: RunSummary;
  artifacts: ArtifactReference[];
};
```

Full domain events, raw model files, complete histories, absolute paths, provider
credentials, and stack traces are excluded. SSE sends a snapshot first and then
ordered RFC-6902-style patches. Gaps trigger snapshot reload.

## Immutable business and experiment revisions

The API distinguishes snapshot, brief, alignment, model, experiment, and run
identities exactly as defined in [`architecture.md`](architecture.md). Creating
an experiment revision normalizes all values, stores the selected defaults
preset, default/current diff, horizon, warm-up, seed, and bound upstream
revisions. Reset is an explicit mutation that copies active defaults into a new
draft; it never erases history.

The run route accepts only an `experimentRevisionId`. It does not accept an
execution label, arbitrary parameters, steps, or seed overrides. The backend
records a complete identity and policy snapshot, then derives
`workflow_policy_met | workflow_policy_unmet`; callers cannot choose or
promote that label.

## Issues and attestations

An issue binds to exact subjects and revisions:

```ts
type Issue = {
  issueId: string;
  subjectRevisionIds: string[];
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  blocking: boolean;
  status: "open" | "resolved" | "closed";
  reporterActorId: string;
  assigneeActorId?: string;
  createdAt: string;
  resolution?: { actorId: string; reason: string; at: string };
};
```

Comments and state changes are append-only events with an atomic current
snapshot. Closing requires a reason. `openBlockingIssueCount === 0` means only
that no recorded blocking objection remains.

```ts
type Attestation = {
  attestationId: string;
  actorId: string;
  actorType: "human" | "agent";
  declaredRole: string;
  subjectRevisionIds: string[];
  scope: string;
  decision: "endorse" | "object" | "abstain";
  rationale: string;
  createdAt: string;
  supersedesAttestationId?: string;
};
```

Records are immutable; later decisions supersede rather than edit. One human
actor contributes at most one effective endorsement to a given revision.
Declared local identity is explicitly unauthenticated in Phase 1. Agent review
is stored and displayed separately and never counts toward human policy.
`object` should reference an issue.

## Derived workflow policy

Alignment-map and experiment revisions are independent review subjects. The
default policy for each is:

```text
human project_owner endorsements >= 1
AND open blocking issues == 0
```

The projection exposes counts, named subjects, and `policySatisfied`. It never
calls the artifact trusted, correct, valid, or confirmed. Safe
policy-unmet private drafts are admitted while the policy is false. A later
attestation does not mutate or relabel an existing run; a policy-qualified
experiment requires a new run for correspondingly labelled results.

## Target routes

All mutation bodies use `ProjectCommand` except binary upload transfer.

| Method and route | Purpose |
| --- | --- |
| `GET /api/projects/{projectId}/snapshot` | Current browser-safe state. |
| `GET /api/projects/{projectId}/events` | Snapshot plus ordered patches. |
| `POST /api/projects/{projectId}/sessions` | Attach a temporary local session to a durable project. |
| `POST /api/projects/{projectId}/uploads` | Validate and persist CSV/JSON/TXT input. |
| `POST /api/projects/{projectId}/chat` | Submit bounded context to configured OpenCode. |
| `POST /api/projects/{projectId}/brief/revisions` | Create an immutable decision-brief revision. |
| `POST /api/projects/{projectId}/alignment/revisions` | Create an immutable requirement/mapping revision. |
| `POST /api/projects/{projectId}/issues` | Open a scoped issue. |
| `POST /api/projects/{projectId}/issues/{issueId}/comments` | Append discussion. |
| `PATCH /api/projects/{projectId}/issues/{issueId}` | Resolve/close/reopen with reason. |
| `POST /api/projects/{projectId}/attestations` | Add a scoped immutable review decision. |
| `POST /api/projects/{projectId}/experiments/revisions` | Save normalized parameter values or reset result. |
| `POST /api/projects/{projectId}/runs` | Execute one immutable experiment revision. |
| `POST /api/projects/{projectId}/runs/{runId}/cancel` | Cancel only a run owned by this project. |
| `GET /api/projects/{projectId}/runs/{runId}/events` | Page browser-safe domain events. |
| `GET /api/projects/{projectId}/artifacts/{artifactId}` | Fetch a declared project-owned artifact. |

## Persistence and safety

The layout and single-writer rules are defined in
[`architecture.md`](architecture.md). Backend snapshots use temporary files and
atomic rename. Revisions and attestations are immutable. Issue history is
append-only. Startup validates manifests, rejects traversal/symlinks and
quarantines incomplete temporary writes without inventing success.

Uploads remain bounded to declared CSV/JSON/TXT size and media types. Provider
keys, raw tool input, absolute paths, control characters, and unbounded logs are
redacted from public errors and state. The service fails closed when its live
provider/model configuration is unavailable.

## Gate 2 acceptance

- Restart recovers project identity, current revision pointers, issues,
  attestations, experiment revisions, and run references.
- Stale writes and idempotent retries behave deterministically.
- Parameter edit and reset create immutable, correctly diffed experiment
  revisions.
- Policy counts are revision-scoped; Agent records never satisfy the human
  count; zero issues is not rendered as trust.
- Unendorsed, policy-unmet private drafts run and retain that label.
- Every run/event/artifact reference resolves to the same project, model,
  experiment, brief, and alignment identities.
