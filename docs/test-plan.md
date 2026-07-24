# Delivery test plan

## Milestone A2 accepted verification

Stage 2 verification is governed by
[`milestone-a2-agent-workspace-design.md`](milestone-a2-agent-workspace-design.md).
Implemented focused coverage includes schema v3/store recovery, durable
conversation state, bounded context and per-conversation OpenCode sessions,
scoped MCP/skills, generic Model workspace, restricted process isolation, and
digest-bound technical checks.

Run the focused backend set with:

```bash
cd backend
node --experimental-strip-types --test \
  test/product-schema.test.ts \
  test/agent-conversation-store.test.ts \
  test/product-store-v3-recovery.test.ts \
  test/agent-context.test.ts \
  test/agent-api.test.ts \
  test/agent-turn-runtime.test.ts \
  test/agent-workspace-concurrency.test.ts \
  test/opencode-conversation-runtime.test.ts \
  test/agent-mcp-permissions.test.ts \
  test/simulation-skill-catalog.test.ts \
  test/model-workspace.test.ts \
  test/model-process-isolation.test.ts \
  test/model-technical-checker.test.ts
```

Run the full component gates with:

```bash
(cd backend && npm test)
(cd web && npm test && npm run build)
```

The API integration tests cover provider/model discovery,
generic Model creation, conversation creation/listing, idempotent turns,
attachment upload, temporary-document projection, explicit read-only errors,
opaque-session/capability/path omission, scoped MCP mutation/revocation, and
technical-check start/read. Combined release acceptance uses the real browser
for live same-session multi-turn behavior and visible fail-closed state. API and
backend integration evidence covers the second independent conversation,
lost-session bounded reconstruction, restart, temporary documents/actions,
scoped Model mutation, Project mutation denial, and honest technical-status
copy until the final shared product shell is delivered by #15.

Latest local A2 acceptance refresh on 2026-07-22: the focused A2 backend
set passed 62/62 in this Linux container when run without the macOS-only
`model-process-isolation.test.ts` file. The web suite passed 104/104 and the
production build succeeded. The full backend suite was also run and is not green
in this container: it includes legacy Gate 3 framed-wind tests that currently
return incompatible/invalid framed evidence and restricted-process tests that
require the macOS `sandbox-exec` boundary. Those full-suite failures are tracked
as environment/legacy non-A2 evidence and do not expand the A2 product contract.

Prior branch evidence: the full backend suite passed, with zero failures and
one optional installed-OpenCode smoke skipped. The latest web suite has 104
passing tests and the production build succeeds. A
live technical check materialized an isolated generic Model workspace and
published `executable`; path, interface, syntax, dependency (Mesa), smoke,
resource, output, and cancellation checks passed, while visual health was
correctly skipped for `batch_only`.

Real-provider closure is green. With OpenCode `1.18.4` and
`opencode-go/deepseek-v4-pro`, the browser acceptance surface created a new
generic Model and completed two clean turns in the same OpenCode session. The
second response repeated the exact first-turn token and added the requested
second-turn token. Focused adapter/API/concurrency regression coverage passed
25/25. OpenCode now generates upstream user-message IDs; Riff records the
pre-prompt message set and accepts only the assistant parented to the new user
message. A failed prompt aborts and retires its opaque session before the next
turn rebuilds, preventing a late response from being mis-associated. Existing
explicit read-only evidence still proves that failure does not fabricate an
assistant response.

The macOS `sandbox-exec` tests prove the stated local-user process boundary,
workspace restriction, scrubbed environment, no network rule, cancellation,
and finite limits. They do not prove containment of hostile code. An executable
check result proves the thin technical contract only, not scientific validity
or trust.

Legacy Gate/queue tests remain present while the implementations coexist. #14
Project execution/wind import and #15 final-shell E2E are non-scope for A2.

## Milestone A3-1a planning and A3-1b batch execution

The first foundation slice implemented Project fixed-copy creation and its
workspace projection. A3-1a adds focused coverage in
`test/experiment-planner.test.ts`, `test/product-schema-v4.test.ts`,
`test/product-store-v4.test.ts`, `test/product-schema.test.ts`,
`test/product-store-v2.test.ts`, and `test/agent-api.test.ts`. It proves:

- a draft Model is rejected by the Project API, and a Model whose stubbed
  technical check publishes `executable` can create a Project;
- two initial Project copies of the same unchanged source have the same snapshot
  digest, and a later source-file edit does not change the already copied
  Project bytes;
- the tested Project workspace DTO lists copied snapshot metadata, an initially
  empty run/configuration projection, then the created conversation and
  experiment; the serialized fixture does not contain the tested path/session/
  capability/process marker strings;
- the closed JSON Schema 2020-12 profile, defaults without coercion, local
  acyclic references, additional-property/numeric/format rejection, normalized
  JSON Pointers, duplicate seed/value rejection, exact sample ordering/IDs,
  `seed: null`, visual-single enforcement, and frozen planner digests;
- transactional schema-v3-to-v4 migration, canonical backfill/digest checks,
  strict legacy run lifecycle rollback, permanent v3 read-only records, Project
  frozen-copy immutability, and v4 ownership/immutability constraints;
- experiment create/update command replay returns the exact historical response,
  changed intent conflicts, stale configuration or record digests fail
  compare-and-set, and restart preserves the receipts;
- a frozen run start atomically persists the `queued` run, command,
  immutable receipt, copied Project/execution/configuration/sample-plan/limits
  digests, rejects non-v2 copied execution descriptions or undeclared run
  capability, replans against the copied profiled schema, and replays the exact
  receipt across restart; and
- Project-scoped conversations remain available through the Stage 2 contract.

A3-1b adds coverage in `test/execution-protocol-v2.test.ts`,
`test/generic-batch-supervisor.test.ts`,
`test/product-store-orchestration.test.ts`, `test/agent-api.test.ts`, and
`test/server.test.ts`. Together with the v4 Store tests, it proves:

- the official generic scaffold emits execution-description v2 with batch-only
  capability and a generic scaffold can run through the real batch protocol;
- `POST /api/projects/{projectId}/runs` returns/replays the exact durable `201`
  start receipt, rejects caller-supplied authority, replans current experiment
  content, and freezes server-owned limits;
- `GET /api/projects/{projectId}/runs/{runId}` returns the bounded run DTO and
  exposes only checked, atomically published output indexes after success;
- dispatcher generations and queue claims feed a real `riff-batch-v1`
  supervisor with one restricted process per sample, a durable launch gate,
  process identity checks, bounded concurrency, and deterministic terminal
  codes;
- current hard batch limits cover sample count, concurrency, wall time,
  termination grace, stdout/stderr, output file count/bytes, and owned
  scratch/Project integrity;
- partial, failed, timed-out, over-limit, undeclared, path-unsafe, or
  digest-invalid outputs never appear as successful results; and
- dispatcher heartbeat, Project-capability, supervisor, output-consumption, and
  atomic-publication exceptions take one best-effort unwind path; verified
  exits/cleanup become a durable failed run, while unprovable cleanup remains
  live and reports `dispatcher_recovery_required`; and
- same-process shutdown sends the abort signal, terminates the verified process
  group, cleans owned scratch, and persists `dispatcher_shutdown`. Direct SQL
  tests also close run terminal evidence, process exit/cleanup immutability,
  gate/state shape, and same-transaction successful output publication.

Visual starts fail with `capability_not_available`. Batch descriptions that
declare `domainEvents` fail with `domain_events_not_supported`. These are
explicit negative gates, not visual/event implementation evidence.

Run the focused A3-1a/A3-1b/A3-1c-a/A3-1c-b/A3-1c-c checks with:

```bash
cd backend
node --experimental-strip-types --test \
  test/execution-protocol-v2.test.ts \
  test/experiment-planner.test.ts \
  test/generic-batch-supervisor.test.ts \
  test/product-schema.test.ts \
  test/product-schema-v4.test.ts \
  test/product-schema-v5.test.ts \
  test/product-schema-v6.test.ts \
  test/product-store-v4.test.ts \
  test/product-store-orchestration.test.ts \
  test/product-run-recovery.test.ts \
  test/product-store-v2-deletion.test.ts \
  test/product-store-v2.test.ts \
  test/agent-context.test.ts \
  test/agent-api.test.ts \
  test/a3-1-api-vertical.test.ts \
  test/server.test.ts
```

The last integrated A3-1b complete backend run was 256 passed, zero failed,
and one optional installed-OpenCode smoke skipped. A3-1c-a adds focused
schema-v5 migration/rollback, Raw SQL cancellation binding, queued no-launch,
immediate active abort, cleanup verification, cancel-first output exclusion,
terminal-first preservation, and exact HTTP replay tests. The previously recorded web suite
passed 104/104 and its production build succeeded; no new browser acceptance is
claimed by this backend batch slice.
The current A3-1c-c full backend run contains 295 tests: 294 passed, zero
failed, and one optional smoke was skipped.
The A3-1 API vertical acceptance is intentionally narrower than a browser user
flow: it starts from a production-Store executable Model fixture, then uses only
the public Project, conversation, experiment, run, cancel, and transcript APIs.
A public long-running batch run deterministically occupies the dispatcher while
the test starts and cancels a second public queued run; no private Store or
dispatcher observation decides the result. The test proves a real generic
subprocess success, checked output indexes, one platform completion card,
stable run/output/card projections after reopening the same workspace, and
queued-cancel receipt replay with zero successful outputs and one cancelled
card that remains exactly once after another reopen.

A3-1c-b adds focused schema-v6 migration/rollback, planned-before-create and
created-before-receipt fault windows, created-without-receipt fail-closed
behavior, exact scratch identity and untracked-directory preservation,
PID/start-token mismatch rejection, real leader-gone descendant cleanup,
queued cancellation recovery, cross-random-generation started-action adoption,
child-receipt-before-Store adoption, claimed/starting/running/blocked/released/
exited/cleanup-complete checkpoints, exact success process/output cardinality,
same-process dispatcher ownership, and two-generation handoff tests. A migrated
v5 live process without v6 evidence is explicitly fail-closed. Exactly-once
batch completion-card coverage now proves all four terminal statuses, all three
dispositions, deterministic IDs and payload allowlisting, SQLite
`after_sqlite_commit` recovery, pending-terminal startup reconciliation,
duplicate-output rejection, Agent-context isolation, and permanent-delete
closure. The dispatcher still fails closed with
`dispatcher_recovery_required` when evidence is absent or contradictory; that
diagnostic is the intended safety boundary, not proof of cleanup.

### Planned A3-2 visual gates

A3-2a is split into two separately merged gates:

- **A3-2a1 schema-v8/Store/recovery contract:** migration and rollback tests
  must preserve every v3-v7 batch row, trigger, completion-card receipt, and
  recovery invariant while extending schema-v6 scratch/launch/recovery evidence
  to the existing schema-v4 visual process shape. Tests must not treat its
  current `loopback_port` or `health_at` as immutable: v8 adds the missing
  triggers. Direct SQL covers a port update, `health_at`-only write,
  receipt-only insert, receipt/timestamp mismatch, second health update, second
  receipt, duplicate, cross-run, cross-attempt, wrong-port, wrong-path, and
  mutable health evidence.
  The only allowed health transition is one same-transaction null-to-receipt-
  timestamp `health_at` write plus unique receipt for the exact running visual
  process with matching launch/port/path/identity.
  Missing health evidence is invalid only after health has committed, for a
  healthy projection, or for a success path that requires health; pre-health
  planned/created/released/running recovery checkpoints legitimately have no
  health receipt.
  Migration fixtures with any pre-v8 visual `health_at` or live process evidence
  fail closed because public visual dispatch was never available and the
  evidence cannot be proven; migration never auto-adopts it as healthy.
  Recovery tests cover planned/created/receipt-before-adoption/registered/
  released/running/healthy checkpoints and exact cleanup, but the public visual
  start without completion-card input must still return
  `capability_not_available`. A request with `completionConversationId` returns
  `visual_completion_not_supported`. This gate runs no visual model and claims
  no browser behavior.
- **A3-2a2 real visual lifecycle:** a real `riff-visual-v1` child must receive
  the canonical single-sample envelope through `--riff-input`, its assigned
  `--riff-output-dir`, fixed `--riff-host 127.0.0.1`, and the frozen assigned
  `--riff-port`. Tests compare the input to the planner/sample-ID preimage and
  cover early exit, startup and wall timeout, stdout/stderr limits,
  cancellation, same-process shutdown, and restart cleanup. A normal exit
  succeeds only when it is code zero and every required declared output
  validates and publishes atomically.

The macOS real-process gate uses a visual-only `sandbox-exec` profile.
Counterexamples attempt to listen on another loopback port, connect to another
local service, connect to an external address, and bind IPv6 loopback `::1`.
Only bind/listen on the assigned `127.0.0.1:<assigned-port>` may survive; all outbound,
direct network, other IPv4 listener, and `::1` bind attempts must remain denied.
If endpoint-level bind filtering is unavailable, tests show exact OS listener
ownership detects and fails a child/process group with any extra listener while
the sandbox still denies every outbound attempt. The listener set is checked
before health, while running, and during termination. That compensation cannot
be reported as sandbox endpoint isolation.

A3-2a2 freezes `maxActiveVisualRuns = 1` without changing the batch cap. Tests
run one long-lived healthy visual, queue a second visual, and queue a real batch
run. The second visual must remain queued, the batch must claim and finish, and
the active map must contain only the exact first `(runId, attemptId)`. Every
lane heartbeats/finalizes with its claim generation. The visual slot is released
only after terminal commit and verified process/scratch cleanup. Dispatcher
stop must abort and await every active lane before returning.

The assigned-port tests acknowledge the local close-then-bind TOCTOU window.
They prove the platform detects and fails closed on wildcard binding, listener
ownership by another PID/process group, port replacement, and ambiguous
ownership before health commits; they do not claim strong port reservation.
Public DTO/transcript/error/log scans must find neither child ports nor derived
public URLs.

Health tests first detect exact OS listener readiness without HTTP, then issue
one exact manual-redirect `GET` to
`http://127.0.0.1:<assigned-port><healthPath>`. They reject every `3xx`, non-`200`,
oversized header/body, deadline overrun, wrong path, and listener mismatch.
Exact child/process-group listener ownership is checked both immediately before
the request and after the complete bounded response. Replacement in either
window fails with `visual_listener_invalid`; concurrent or repeated probes
cannot send another HTTP request or create another same-identity health
receipt. Startup time includes readiness plus that one request and has no HTTP
retry.

The target public run DTO accepts `runKind: "batch" | "visual"`. Terminal tests
freeze `succeeded/visual_run_succeeded`, `failed/visual_process_failed`,
`failed/visual_health_failed`, `failed/visual_listener_invalid`, and
`timed_out/visual_startup_timeout`, plus `timed_out/run_wall_timeout` and shared
`failed` stdout/stderr/output/cleanup/heartbeat codes. They specifically prove
same-process shutdown is
`failed/dispatcher_shutdown`, restart recovery is
`failed/runtime_interrupted`, and cancel-first is
`cancelled/run_cancelled`.

Visual completion is a negative contract. A public visual start containing
`completionConversationId` must return HTTP `422`
`visual_completion_not_supported`. Accepted visual runs retain
`completionCardDisposition: "not_requested"` through success, failure,
timeout, cancellation, and restart, with no `run_completion_cards` row and no
platform message. Project run reads remain authoritative.

A3-2a1 and A3-2a2 have no proxy, frame, WebSocket, Playwright, or real-browser
acceptance row. Those claims begin only in the later gates:

- **A3-2b broker/frame/WebSocket:** exact WebSocket path/subprotocol
  enforcement, frame-size, connection-count, and idle-time limits, plus the
  same-origin local bootstrap, isolated-broker HttpOnly one-use frame session,
  Origin/CORS rules, and parent DOM isolation in a real browser. Platform app
  and broker exact-bind `::1` on different server-owned ports and use
  `http://[::1]:<port>` URLs; the untrusted child remains IPv4
  `127.0.0.1:<assigned-port>`. Tests prove app/broker cookies cross ports but
  are not sent to the child host. The iframe demonstrably sends the
  `SameSite=Strict` broker cookie, JavaScript cannot read the HttpOnly cookie,
  and the different port origin cannot access the parent DOM.

  Bootstrap rejects missing, `null`, wrong Origin, wrong Host/port, and wrong
  Fetch-Site; its app cookie is host-only with `Path=/api/`. A new bootstrap
  generation first revokes old frames and WS. Frame-session requires exact
  cookie, CSRF, Origin, and Fetch-Site. First nonce navigation succeeds without
  Origin only at the exact broker Host/path, only once, and no later than 60
  seconds after issue. Tests redeem within 60 seconds, reject after expiry, and
  prove restart or a new browser generation invalidates the nonce immediately.
  Expired nonce values never appear in logs, headers, DTOs, or SQLite.
  Post-redirect HTTP
  without Origin requires the broker cookie; HTTP with Origin requires exact
  broker Origin. WS requires exact broker Origin and rejects missing, `null`,
  app, child, and foreign values. Registry assertions cover browser-session
  generation, Project, run, attempt generation, expiry, and socket set;
  revocation closes sockets before removal. Three-party app/broker/child
  headers and logs pass secret scans. Tests do not treat port separation or
  Cookie `Path` as Cookie authorization. The broker cookie expires at
  `min(attempt expiry, 15 minutes)`. App and broker cookies may omit `Secure` on
  current HTTP, but HTTPS fixtures require it.

  Every broker document must emit exact CSP
  `frame-ancestors http://[::1]:<exact-app-port>` with no wildcard and must not
  emit `X-Frame-Options: SAMEORIGIN`. A real browser proves the exact app can
  embed the frame while another `::1` port, a different app, the IPv4 child,
  and a foreign top-level page cannot.
- **A3-2c Playwright:** current-Project/current-healthy-attempt observation,
  explicit one-turn interaction, bounded audit, and cross-Project/run/URL,
  script, upload, clipboard, and expired-capability rejection. Its internal
  capability never reuses the user's frame URL, app cookie, or broker cookie.

Installer tests in A3-3 must pin and verify the execution-v2 scaffold and wind
manifest IDs, versions, and concrete digests, including same-ID conflicts and
mandatory re-scaffolding for unproven v1 Models.

Mocks cover fault branches only. A3-1b batch acceptance uses a real generic
subprocess. Visual acceptance still requires a real local visual process, and
final Stage 3 acceptance still requires the narrow browser Project/run flow.
The current green backend evidence does not complete Stage 3.

---

# Legacy wind-turbine delivery test plan

## Status

Gate 1 now has executable model, bundle, API, worker-evidence, verifier, and
full-baseline tests. Gates 2-4 remain target acceptance only. Gate 1 exercises
the wind path directly through Mesa; it does not claim backend or browser wind
integration.

## Gate 0 document checks

- Source path, size, SHA-256, plugin/internal format versions, exclusions, and
  claim boundary match the local AnyLogic source.
- Links resolve and all target docs carry a Gate 0 status boundary.
- Source defaults and Riff synthetic defaults are separate.
- Terminology scan finds no qualitative human-approval truth state.
- `queue-network-v1` remains labelled current legacy implementation only, with
  complete Gate 4 retirement specified.

## Gate 1 model and evidence

The three-turbine deterministic micro-case is the hand-checkable oracle for
event order, queue selection, travel, state duration, availability, overdue
maintenance, crew occupancy, and cost.

Unit/property tests cover:

- five mutually exclusive turbine states and crew state exclusivity;
- turbine and crew count conservation;
- one active work order per turbine/type and one turbine per crew;
- corrective priority and FIFO within both queues;
- failure superseding pending planned maintenance;
- corrective completion continuing overdue maintenance on the same crew;
- failure time sampled on entry to operating, not daily hazard recomputation;
- probability-driven major replacement, age replacement disabled, and reset of
  maintenance/age clocks after replacement;
- non-negative finite times, waits, costs, counts, and metric denominators;
- simultaneous failure/maintenance due and completion/new-request deterministic
  tie-breaks;
- request triggers, completions, arrivals/returns, then centralized dispatch,
  with phase-local descending sequence, corrective-first FIFO, and stable crew
  IDs;
- exact event-interval KPI integration and warm-up exclusion;
- origin-event wait cohorts, right-censored outstanding work, and nearest-rank
  P95;
- post-time-zero plus post-boundary daily rows, including the 1096-row baseline;
- same model/experiment/seed canonical event digest stability.

Contract tests fail when code IDs, `model-spec.json`, parameter/metric schema,
source transition dispositions, traceability, visualization metadata, or
derived-view digests drift. Run request, metadata, events, metrics, summary,
replay, and views must share one exact identity set.

API and verifier tests also require admission-time bundle re-verification and
experiment content-ID recomputation; rejection of symlink ancestors at the
models, experiments, runs, and artifact layers; no public child success before
parent verification and atomic promotion; an exact eight-file success set;
exact event field/type/vocabulary/phase validation; and exact 53-column metric
schema validation even when an attacker consistently reseals downstream
digests. Annualized revenue, maintenance expense, and profit must recompute
from final measurement-window metrics.

Parametrized TOCTOU tests mutate `model.py` or `request.json` after parent
admission but before `Popen`. The worker must independently reject both through
its captured bundle, out-of-band request digest, admitted revision IDs, and
canonical experiment projection. Public status must never expose child
`succeeded`; results and success artifacts remain unavailable, and the final
failure directory contains only request, metadata, and log diagnostics.

The fixed baseline executes 100 turbines, 3 crews, 1095 days, 365 warm-up, seed
2 within finite worker limits. It proves reproducibility and artifact integrity,
not AnyLogic numerical equivalence, calibration, uncertainty, or staffing merit.

Gate 1 commands are:

```bash
uv sync --project mesa_service --extra test --frozen
uv run --project mesa_service pytest -q
uv run --project mesa_service python -m mesa_service.run_baseline \
  --preset wind-turbine-maintenance-demo-v1 \
  --output-dir outputs/gate1-wind-baseline
uv run --project mesa_service python -m mesa_service.verify_run \
  outputs/gate1-wind-baseline
```

The baseline test runs the full experiment twice. It requires different run IDs
but identical model/experiment/runtime identities, semantic event digest, KPI
semantic digest, and summary semantic digest. It also checks all 100 turbines,
3 crews, 1095 days, 365 warm-up days, seed 2, 1096 rows, complete events, finite
values, and persistent non-claim labels. Limits fail rather than reduce scope or
truncate events.

## Gate 2 project state

Backend contract tests cover:

- durable project reopening and process-restart recovery;
- atomic snapshot writes and recovery from incomplete temporary writes;
- distinct snapshot/brief/alignment/model/experiment/run identities;
- immutable parameter-edit and reset experiment revisions with correct diff;
- stale-revision rejection and idempotent command retry;
- revision-scoped issues, append-only discussion/resolution, and required close
  reason;
- immutable/superseding attestations and one effective human endorsement per
  actor/revision;
- Agent reviews excluded from the human count;
- zero issues rendered as no recorded objection, not correctness;
- private draft admission while policy is unmet and no later in-place upgrade;
- bounded snapshot/SSE projections and paged event/artifact access;
- traversal, symlink, cross-project ID, extra-key, non-finite, and redaction
  failures closed.

## Gate 3 UI and generated views

Component and browser tests verify:

- two-pane desktop and accessible narrow layout;
- schema-driven parameter default/current/diff/reset flow;
- separate alignment and experiment review cards;
- blocking issue open/resolve and human endorsement count effects;
- safe draft run remains available while policy is false;
- entity/state view from model spec, swimlane/replay from events, and
  traceability from requirement mapping;
- 2D depot/turbine/crew/queue/KPI projection for 100 turbines;
- accessible tables/text for every chart and diagram;
- persistent synthetic/single-seed/behavioural/no-recommendation labels;
- real backend state, not DOM or assistant text, controls readiness and success.

## Gate 4 live integration

The release E2E uses the configured local OpenCode provider/model, not fixture
mode. It performs the complete story: natural-language brief; typed proposal;
parameter edit and reset; blocking issue; resolution plus project-owner
endorsement; generated views; 100/3/seed-2 baseline; identity-consistent results
and non-claim labels. Provider/model health is checked first and unavailable
configuration fails closed.

Deterministic fixtures remain component-test tools only. A screenshot without
domain-state assertions is insufficient. The test checks persisted project and
run artifacts after the browser flow and after a backend restart.

## Queue retirement audit

After replacement E2E passes, Gate 4 scans tracked source, schemas, prompts,
tools, tests, docs, builds, and browser fixtures for queue model IDs, class
names, parameter names, and metric fingerprints; expected current-tree hits are
zero.

Ignored workspace deletion is manifest driven:

1. stop only exact verified target service PIDs;
2. build the old model-revision set from manifests whose `model_id` is exactly
   `queue-network-v1`;
3. remove only those revision directories;
4. remove run directories only when `request.model_revision` is in that set;
5. remove active pointers that name a removed revision;
6. preserve project roots, inputs, ambiguous/unknown artifacts, and unrelated
   work;
7. report exact removed targets and verify active/manifest/request hits are
   zero.

This deletion is irreversible in the local workspace; Git history remains.

## Independent review

Each gate receives an independent contract/diff review. Blocking findings are
resolved before closure. Review checks for scope creep, identity drift,
non-reproducible randomness, evidence loss, unsafe provider fallback,
qualitative approval/trust conflation, and unsupported claims.
