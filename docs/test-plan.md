# Delivery test plan

- Status: active
- Role: implementation record
- Scope: Milestone A acceptance gates, revision-scoped evidence, and retained legacy test history
- Source of truth: recorded commands/results for their named revisions and merged test implementation
- Last reviewed: 2026-07-25

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

At the A3-1 batch-only boundary, visual starts without
`completionConversationId` failed with HTTP `409`
`capability_not_available`. Published A3-2a2c admits eligible visual starts
through the existing Project-run route. If `completionConversationId` is
present, that field-specific gate still fails with HTTP `422`
`visual_completion_not_supported`. A3-2d2, merged through PR #44, admits declared
batch `domainEvents` only after strict NDJSON validation and atomic Store
publication; malformed or over-limit files fail the run without partial event
rows.

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
The prior A3-1c-c branch's full backend run contained 295 tests: 294 passed,
zero failed, and one optional smoke was skipped. That historical count is
superseded for A3-2a1 by the final 314-test full gate recorded below.
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

### A3-2 visual gates

A3-2a is delivered through separately reviewed gates:

- **A3-2a1 schema-v8/Store/recovery contract — merged and published in PR #28:**
  focused tests cover the
  schema-v8 migration/rollback boundary, visual health-receipt invariants,
  stable public admission rejection, and private Store process-evidence
  lifecycle. Cross-restart visual reconciliation is implemented; its focused
  fake-supervisor suite passes 29/29 without starting a real visual child or
  opening a listener. The broader focused root gate passes 62/62, the
  independent reviewer gate passes 81/81, and independent recovery review is
  PASS. Its historical full backend gate reported 314 total: 313 passed, zero
  failed, and one optional installed-OpenCode smoke skipped; web tests passed
  104/104 and the production build succeeded.
  Migration and rollback tests cover schema-v8 migration/rollback plus a
  representative schema-v7 batch sentinel and preservation of the relevant
  legacy triggers while extending schema-v6 scratch/launch/recovery evidence to
  the existing schema-v4 visual process shape. Tests must not treat its
  pre-v8 `loopback_port` or `health_at` as immutable: v8 adds the missing
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
  released/running/healthy checkpoints and exact cleanup. They also exercise
  production `GenericBatchSupervisor` parsing of an exact durable visual launch
  receipt, while coordinated health-receipt/manifest corruption fails before
  supervisor inspection or signalling. At this published A3-2a1 gate, a
  visual start without `completionConversationId` returned HTTP `409`
  `capability_not_available`; when that field was present, its earlier gate
  returned HTTP `422` `visual_completion_not_supported`. This gate runs no
  visual model, opens no listener, and claims no browser behavior.
- **A3-2a2a schema-v9/Store visual authority — merged and published through PR
  #29:** merge commit `1584e39` upgrades product-database authority to v9
  because the former
  atomic success/output triggers admitted only batch publication. The v9
  replacement binds atomic success to `runId` plus `runKind`, preserves batch
  behavior, rejects visual completion state including `NULL` disposition, and
  requires the matching visual health/launch/scratch/exit-zero/cleanup evidence.
  Store tests cover generation-fenced claim, queued cancellation with no card,
  terminal cancellation precedence, required output validation, atomic
  publication/rollback, and rejection of an extra live attempt/process. Two
  independent reviews and its publication gate are complete.
- **A3-2a2b generic single-attempt visual supervisor — merged and published
  through PR #30 at merge commit `9f23f61`:** a real
  `riff-visual-v1` child receives
  the canonical single-sample envelope through `--riff-input`, its assigned
  `--riff-output-dir`, fixed `--riff-host 127.0.0.1`, and the frozen assigned
  `--riff-port`. Tests compare the input to the planner/sample-ID preimage and
  cover early exit, startup and wall timeout, stdout/stderr limits,
  listener drift, one-shot health rejection, abort, exact process/scratch
  cleanup, and safe output discovery. A normal exit
  succeeds only when it is code zero and every required declared output
  validates. The supervisor and process safety primitives do not dispatch,
  publish a public route, broker/frame a page, or claim browser behavior.
  Its publication evidence is 379 backend tests with 378 passed, zero failed,
  and one optional installed-OpenCode smoke skipped; the 102/102 focused
  concurrency combination passed three consecutive runs; web passed 104/104
  and the production build succeeded.
- **A3-2a2c dispatcher/public admission — merged and published through PR #31
  at merge commit `361b36f`:** one dispatcher
  generation owns independent batch and one-slot visual lanes. Tests cover
  exact-generation heartbeat/cancel/finalize, the fatal-error latch, stop
  join, generation-fenced cleanup of unlaunched visual scratch, and exact
  visual-success restart audit. The existing Project-run route admits visual
  work without exposing the child port or adding a parallel API. The
  real-process public vertical and DTO/error/log secrecy gate pass. The final
  backend gate reports 385 total: 384 passed, zero failed, and one
  optional installed-OpenCode smoke skipped; the focused 13/13 gate covers
  the review regressions; web passes 104/104 and the production build succeeds.

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

A3-2a2c freezes `maxActiveVisualRuns = 1` without changing the batch cap. Tests
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

The public run DTO accepts `runKind: "batch" | "visual"`. Terminal tests
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

A3-2a1 and the published A3-2a2a/A3-2a2b/A3-2a2c slices expose visual
admission only through the existing Project-run API. They expose no child
port, proxy, frame, WebSocket, Playwright authority, or real-browser acceptance
row. The HTTP `422` `visual_completion_not_supported` negative gate remains.
The remaining claims begin only in the later gates:

- **A3-2b1 network topology — merged and published through PR #33:** focused Node tests start the
  real `BackendApp` app listener plus empty broker on separate server-owned
  `::1` ports. They prove CSP-compatible exact localhost authorities, distinct
  ports, Host rejection for literal-IPv6/IPv4/missing-port/expanded-IPv6/
  other-port values, IPv4 same-port denial reservation, collision/invalid-port
  failure, handler-error
  redaction, serialized start/close, drain, and idempotent close. The existing
  visual-listener suite separately preserves the child's
  exact `127.0.0.1` boundary. This slice does not claim a frame route, proxy,
  cookie, nonce, WebSocket, or browser evidence.
  The review worktree gate reports focused network/server/listener tests
  `46/46`; the full backend gate reports 399 total with 398 passed, zero failed,
  and one optional installed-OpenCode smoke skipped. Web remains `104/104`, its
  production-entry/Vite integration gate passes `1/1`, and its production build
  succeeds. The automated integration starts the real production entrypoint on
  configured temporary app/broker ports, observes exact health success, HTTP
  `421` `platform_host_denied` for a wrong Host, HTTP `404`
  `broker_route_denied`, and a successful Vite `/api` proxy POST whose
  `changeOrigin` Host passes the exact app guard.
- **A3-2b2 frame bootstrap and HTTP proxy — merged and published through PR #35:** the same-origin local
  bootstrap, isolated-broker HttpOnly one-use frame session,
  Origin/CORS rules, and exact CSP/HTTP forwarding. Platform app
  and broker exact-bind `::1` on different server-owned ports and use
  `http://localhost:<port>` browser authorities; the sockets remain exact-bound
  to IPv6 loopback `::1`, while the untrusted child remains IPv4
  `127.0.0.1:<assigned-port>`. Component and HTTP integration tests prove
  exact cookie attributes and that platform cookies are never forwarded to
  the child host.

  Bootstrap rejects missing, `null`, wrong Origin, wrong Host/port, the Vite
  origin, and wrong Fetch-Site; its app cookie is host-only with `Path=/api/`,
  and its server session, `Max-Age`, and `Expires` all use 15 minutes. Origin
  and Fetch-Site are browser-CSRF defenses, not local-client identity. Bootstrap
  and frame-session accept `POST` plus preflight `OPTIONS`, expose exact-app-only
  credentialed CORS for `POST, OPTIONS` and
  `Content-Type, X-Riff-CSRF`, and return HTTP `201`. A new bootstrap
  generation invalidates older frame capabilities. Frame-session requires exact
  cookie, CSRF, Origin, and Fetch-Site. First nonce navigation succeeds without
  Origin only at the exact broker Host/path, only once, and no later than 60
  seconds after issue. Tests redeem within 60 seconds, reject after expiry, and
  prove restart or a new browser generation invalidates the nonce immediately.
  Redemption returns HTTP `303` with a relative nonce-free `Location`.
  Expired nonce values never appear in logs, headers, DTOs, or SQLite. SQLite
  contains no cookie, frame URL, or browser capability; child-port assertions
  allow only the schema-defined private process-attempt, launch, and health
  evidence required by exact recovery.
  Post-redirect HTTP
  without Origin requires the broker cookie; HTTP with Origin requires exact
  broker Origin. Frame registry assertions cover browser-session generation,
  Project, run, attempt generation, and expiry. Tests do not treat port
  separation or Cookie `Path` as Cookie authorization. The broker cookie expires
  at `min(attempt claimedAt + frozen wallTimeMs, issue time + 15 minutes)`.
  App and broker cookies may omit `Secure` on current HTTP, but HTTPS fixtures
  require it.

  Without changing execution-description v2, the minted capability base
  forwards normalized suffixes for `GET` and `HEAD` only. Query is allowed
  while normalized path plus query is at most 4,096 bytes; request bodies are
  denied. A multi-resource HTTP integration proves relative HTML, CSS, script,
  image, and JSON references stay beneath the minted base; root-absolute
  application routes remain denied and are not rewritten. Tests prove the child receives only `Accept`, `Accept-Language`,
  `If-None-Match`, `If-Modified-Since`, and `Range`, plus exact child `Host` and
  forced `Accept-Encoding: identity`. Responses expose only `Content-Type`,
  `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`, `Last-Modified`,
  and `Cache-Control`; tests prove `Set-Cookie`, `Location`, `Refresh`,
  authentication, CORS, credentials, nonce/capability, and hop-by-hop headers
  are absent.
  Broker responses override child cache policy with `private, no-store`;
  component and HTTP tests prove rotated/revoked routes are rejected rather
  than reused; A3-2b4 adds the real-browser no-store and revocation proof.
  Secret scans cover broker-generated DTOs, routes, transport headers, errors,
  and logs. They do not claim arbitrary model-authored response bytes can hide
  a listener already known by that child; literal payload scanning is not an
  authorization boundary. A3-2b treats operator-provided active frame content
  as trusted browser code under the local deployment threat model; it does not
  claim a runtime code-review gate. Adversarial active-payload
  isolation needs a trusted data-only wrapper or browser-inaccessible transport
  and is not claimed by b2/b4 iframe sandbox tests.

  Every child `3xx` is rejected without following. Tests cover 32,768-byte
  request/response header ceilings, 8 MiB response body, 5,000 millisecond
  deadline, and eight concurrent HTTP requests per capability. They also cover
  expired dispatcher leases, stale process heartbeats, authority replacement
  during an in-flight exchange, asynchronous serialized OS inspection, and
  bounded inspection admission with a 5,000 millisecond overall deadline. Exact stable
  errors are `browser_method_denied` (`405`),
  `browser_session_denied` (`403`), `visual_frame_unavailable` (`409`),
  `visual_frame_nonce_invalid` (`404`), `visual_frame_session_denied` (`403`),
  `visual_frame_proxy_denied` (`404` or `405`),
  `visual_frame_proxy_redirect_denied` (`502`),
  `visual_frame_proxy_limit_exceeded` (`502`),
  `visual_frame_proxy_timeout` (`504`), and
  `visual_frame_proxy_failed` (`502`).

  Every broker document must emit exact CSP
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  font-src 'self'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none';
  form-action 'none'; frame-src 'none'; frame-ancestors
  http://localhost:<exact-app-port>` with no wildcard and must not emit
  `X-Frame-Options`. A3-2b4 provides the exact app-origin host page and
  real-browser evidence.
- **A3-2b3 WebSocket, revocation, and secrecy — merged and published through
  PR #36 at `bb54b2a`:** exact path/subprotocol forwarding, fixed-child
  peer reinspection, assembled-message and per-direction queue limits,
  attempt-global pending/active connection limits across minted routes,
  bounded child handshake, idle/absolute expiry, and socket-first
  generation/lifecycle revocation are implemented. Server-level tests exercise
  the complete bootstrap/issue/redeem path, real `::1` broker to
  `127.0.0.1` child sockets, the negative pre-`101` matrix, exact
  `maxConnections + 1` denial before a third child dial, child redirect and
  non-`101` denial, and `1008` close on generation rotation and backend
  shutdown. Sentinel and SHA-256 scans cover bounded broker errors, fixed-child
  headers, the real ProductStore SQLite file, captured backend console output,
  and unrelated public DTOs. These observable/persisted scans do not claim
  arbitrary process heap bytes. Its publication
  focused frame/network/WebSocket regression combination passed `32/32`; its
  serial official backend publication gate reported 464 total with 463 passed, zero failed, and
  one optional installed-OpenCode smoke skipped. Web remains 104/104, its
  network-entry integration passes 1/1, and the production build succeeds.
  Stable pre-upgrade distinctions include parser-level
  `400/broker_request_failed`, parsed-but-malformed handshake
  `400/visual_websocket_protocol_denied`, non-GET
  `405/visual_websocket_protocol_denied`, broker authority
  `403/visual_frame_session_denied`, and offered-subprotocol/policy
  `403/visual_websocket_protocol_denied`.
- **A3-2b4 browser and security closeout — merged and published through
  PR #37:** `cd web && npm run test:e2e:a3-2b` passes 5/5
  on Playwright-managed Chromium. It proves real cookie-jar HttpOnly/SameSite delivery,
  one-use nonce redirect/replay denial, relative resources, child credential
  stripping, no-store reload, `worker-src 'none'` Service Worker denial,
  exact-app CSP embedding, hostile same-site/IPv4 embedding denial, SOP and
  sandbox denial, native WebSocket Origin/cookie/subprotocol/text/binary
  behavior, page-observed generation close `1008` followed by reconnect
  denial, nonce expiry, and route invalidation after backend restart. Raw
  fragmentation/backpressure/limit evidence remains owned by b3.
  The complete Chromium suite passes 8/8. The focused broker/frame/WebSocket
  regression passes 58/58. The current backend gate reports 466 total with 465
  passed, zero failed, and one optional installed-OpenCode smoke skipped; web
  passes 104/104, network entry 1/1, and the production build succeeds.
  This does not claim Firefox/WebKit, remote deployment, or HTTPS acceptance.
- **A3-2c Playwright:** current-Project/current-healthy-attempt observation,
  explicit one-turn interaction, bounded audit, and cross-Project/run/URL,
  script, upload, clipboard, and expired-capability rejection. Its internal
  c3 interaction is enabled only by the turn API's optional structured
  `visualInteractionConfirmation`; immutable messages retain only its digest
  marker, and generic `explicitImperative`, Agent text, or page content fail
  authorization. The single MCP tool is `riff_interact_current_visual({})`;
  action, locator, value, and target substitution through tool input fail.
  Its capability never reuses the user's frame URL, app cookie, broker cookie, or
  ambient legacy CDP projector. Tests bind immutable audit metadata to the
  originating conversation/turn/Project/run/attempt, prove restart/turn-end/
  replay revocation, and accept interaction locators only by accessibility
  role plus bounded accessible name or bounded label. CSS, XPath, arbitrary
  text selectors, JavaScript, popup/navigation, upload, clipboard, permission,
  credential, and unrestricted-download cases fail. Issuance binds
  conversation, immutable human turn, Project, run, attempt generation/process
  identity, capability epoch, one operation, and expiry; zero/multiple healthy
  candidates fail. Tests revalidate that tuple at action time and cover project
  selection change, attempt replacement/terminalization, action-kind/locator/
  input-or-selection-value substitution, atomic consume-before-side-effect,
  failure consumption, concurrent double-use, retry, timeout, browser crash,
  and structural inability to attach the legacy CDP profile. A3-2c4's
  review-branch matrix now proves the live-CDP negative through the published
  BackendApp turn chain. c3 uses a fresh profile and private exact-peer
  GET/HEAD bridge, which must reject peer replacement and must not carry b2
  frame/cookie/nonce/WebSocket state. Its receipt proves only a bounded
  untrusted local action dispatch, never child HTTP write or domain success.
  `drive_workbench_ui` remains absent from the
  Project/A3-2c tool schema and its server dispatch is rejected.
  Audit tests cover mint/consume/outcome/failure/crash gap, secret redaction,
  value-digest rather than raw-value retention, untrusted page-content
  non-instruction, and bounded owner/TTL/digest/deletion behavior for explicitly
  retained temporary observation documents.

  The published A3-2c1 gate is narrower: it covers durable
  conversation/turn/Project scope, exactly one healthy attempt, capability
  mint/consume/revoke/restart crash-gap behavior, opaque consumed handles,
  consume-before-revalidation, audit-write failures, double-use,
  action/locator/value substitution, run/turn/close revocation, hard
  TTL/registry bounds, production schema binding triggers, and legacy
  projector zero-call isolation without claiming a live-CDP browser test. Its
  audit canaries prove locator role/name-or-label and typed value are
  digest-only and that no observation summary/content/bytes exist in the
  table. A3-2c1 has no public tool or browser side effect. Actual
  A3-2c2 covers the four bounded structured/accessibility/DOM/screenshot
  observations, exact process/listener/connected-peer reuse, streaming
  header/body/deadline limits, global/per-conversation concurrency, in-flight
  lifecycle abort, untrusted non-instruction context, no-network
  script-disabled snapshots, and Project-only MCP schema. Typed interaction
  is the A3-2c3 implementation merged through PR #41, including schema-v11 durable
  one-confirmation/one-mint enforcement and a single absolute bridge deadline.
  The c3 merge gate reports 525 backend tests with 524 passed,
  zero failed, and one optional installed-OpenCode smoke skipped; web passes
  104/104, network entry 1/1, and the production build succeeds. Three
  independent c3 reviews report no P0/P1 merge blocker.
  The c4 merge matrix passes 6/6 in real Chromium. It covers the actual
  BackendApp/MCP/runtime/authority/interactor chain with a live-CDP endpoint,
  fresh-profile and ambient frame-secret canaries, side-effect denials, exact
  empty-input dispatch, real persistence-byte and bounded audit/MCP/error/child
  scans, and legacy-tool zero-dispatch. Two independent final reviews reported
  no P0/P1 blocker before PR #42 merged.
  The merged c1 gate reports backend 500 total/499 passed/zero
  failed/one optional installed-OpenCode smoke skipped, web 104/104, network
  entry 1/1, a successful production build, and independent security review
  with no P0/P1/P2 finding. The current combined c2 gate reports
  511 backend tests with 510 passed, zero failed, and one optional
  installed-OpenCode smoke skipped; web passes 104/104, network entry 1/1, and
  the production build succeeds. Independent c2 security review reports no
  P0/P1 merge blocker. The preceding c2 result is not c3 or c4 evidence.
- **A3-2d outputs/events/direct controls:** d1 output list/download was merged
  through PR #43 and rechecks same-run ownership, safe name, path, size,
  digest, MIME, range, and limits. The merged d2 boundary proves declared
  diagnostic NDJSON ingestion is atomic and enforces schema,
  structure, depth, string, count, and byte bounds; pagination uses tamper-
  evident opaque cursors bound to run and normalized filters. The merged d3
  boundary proves direct cancel/download/trash/restore with OpenCode unavailable,
  including cross-owner, cross-run, nonterminal, stale, tampered, and restart
  rejection. List/download/event reads require the current single-user app session,
  exact Host/Fetch Metadata, and Project/run/output ownership tuple and emit
  private no-store responses; mutations additionally require
  exact Origin and CSRF. IDs are not bearer credentials. Commands
  bind idempotency; cancel retains its exact `{commandId}` body, while
  trash/restore compare `expectedLifecycleDigest` and trash binds exact
  terminal-closure confirmation. Download tests use one no-follow open descriptor, verify the
  complete digest before any bytes, emit attachment/nosniff/no-store policy,
  support only one normalized range, and bound concurrency/rate.
  Current d2 cursor tests cover Project/run/contract/event-set/lifecycle-generation/direction/
  limit/all-filter binding, bounded parse, constant-time MAC, expiry/key epoch,
  restart stability, deterministic invalidation, owner-only key permissions,
  and missing/corrupt key fail-closed behavior. The current implementation
  creates the final key path with `O_EXCL`; atomic publication and concurrent
  first-start convergence, along with backup/export exclusion, remain review
  gaps and are not current claims. Event reads are bounded by the frozen
  64 MB/50,000-event limits, but a dedicated read rate/concurrency gate remains
  a P2 follow-up. Strict NDJSON tests cover UTF-8/LF, duplicate
  keys, depth/count/string limits, time/type/schema rules, and atomic event-set
  publication. Diagnostic-event prompt-injection cases prove URL-, instruction-,
  and tool-call-shaped content remains safely rendered, separately bounded
  untrusted context and cannot authorize an action. Project trash invalidates
  event reads/cursors and restore does not revive an old cursor. The merged d3
  boundary covers all four terminal statuses, nonterminal/stale/
  changed-intent rejection, exact receipt replay across restart, browser
  mutation admission, trashed output fencing, and a real paused-download race
  in which trash closes the dedicated output socket before Store commit.
  It also proves direct run trash/restore invalidates old event cursors. The
  PR #45 merge gate is 552 backend total/551 passed/zero failed/one optional
  OpenCode smoke skipped, web 104/104, network entry 1/1, successful build,
  and 24-file docs check. Final independent security review reports no P0/P1.
  A3-2d4 merged through PR #46 and covers the combined route-level
  frame-nonce/redeemed-frame/open-WebSocket/Visual-Agent revocation matrix.
  A focused Node route test and a real Chromium flow fault-inject the lifecycle
  service while calling the production trash/restore API and revocation wiring.
  They prove trash invalidates a still-unredeemed nonce, denies the redeemed
  route, closes the open socket with code `1008`, records `run_revoked` for the
  Visual-Agent capability, and that restore revives none of the old authority.
  Durable Store mutation/receipt evidence remains owned by the published d3
  tests. The focused backend combination passes 65/65 and the complete
  dedicated broker Chromium matrix passes 6/6. The full merge gate is
  553 backend total/552 passed/zero failed/one optional OpenCode smoke skipped,
  web 104/104, network entry 1/1, full Chromium 15/15, successful production
  build, and a 24-file docs check. Independent security review reports
  P0/P1=0; cross-run over-revocation and joint issuance/trash race coverage
  remain non-blocking P2 follow-ups.
  The legacy `/events` route remains separate from generic
  `/diagnostic-events` and is excluded from this evidence.

A3-3 installer tests pin the execution-v2 adapter plus all 14 manifest entries,
IDs, version, exact bytes, and concrete digests. They cover idempotent replay,
fixed-copy isolation, five interruption/restart windows, the real ordinary
technical checker, and a production-startup generic Project run. The exact
seed-2 baseline is byte-identical across two runs, produces 1,096 daily KPI
rows and 38,730 bounded diagnostic events, and remains readable after backend
restart. Schema-v13 tests cover migration, rollback, and immutable installation
authority. Same-ID/different-manifest conflicts fail closed. These are A3-3
backend acceptance facts, not by themselves final browser evidence or a scientific
calibration/equivalence claim.
The final A3-3 gate is backend 570 total/569 passed/zero failed/one optional
OpenCode smoke skipped, web 104/104, network entry 1/1, Chromium 15/15,
reviewed wind 38/38, a successful production build, and a 25-file docs check.
Independent review reports P0/P1=0.

Mocks cover fault branches only. A3-1b batch acceptance uses a real generic
subprocess and visual acceptance uses a real local visual process. Final
Stage 3 Integration adds `web/e2e/a3-product-integration.spec.ts` behind the
isolated `playwright.a3-product.config.ts`; `cd web && npm run test:e2e:a3`
passes 1/1 in real Chromium.
In one browser context it creates a fixed-copy Project, creates an Experiment,
edits its actual parameters to 3 turbines, 1 crew, a four-day horizon and no
warm-up, then completes that exact ordinary wind batch and verifies two path-free indexed
outputs, reads two opaque-cursor event pages, verifies attachment headers and
digest through the guarded same-origin fetch, saves those bytes through a
browser download, then restarts the backend on the same app/broker ports. It bootstraps new
process-local browser authority after restart and proves durable Project,
Experiment, Run, event, and output reads with zero console errors. This closes
the narrow Stage 3 browser gate, not the Stage 4 shared-shell or full MVP E2E.
At that revision it did not claim uniform browser admission for
create/edit/start. A4-1 now implements that Host/Origin/Fetch/CSRF contract;
the Stage 3 scenario remains evidence only for its named revision.

## Stage 4 design and future acceptance

A4-0 is documentation only and is governed by
[`milestone-a4-shared-product-shell-design.md`](milestone-a4-shared-product-shell-design.md).
Its gate is complete document linkage, a PRD-ID-to-API-to-UI-to-test matrix
whose implementation rows all remain `pending`, and independent Product,
Architecture, and Security review with P0=0/P1=0. It does not add or satisfy a
runtime/browser test.

A4-1 adds focused contract, owner-scope, failure, idempotency, restart,
secrecy, lifecycle/deletion, schema-v14, exact-file-identity, and
authority-issuance-fence evidence. A4-2 adds the responsive Home/router/
shared-shell foundation and its focused browser evidence. A4-3 adds persistent
Conversation, provider-lock, safe-card, lifecycle/deletion, and honest
read-only evidence. A4-4 through A4-5 must add renderer, Agent, Run, recovery, and exact
legacy-manifest evidence in their owning slices. A4-6
alone owns one continuous real-Chromium exit scenario covering Home/four
entries, creation and opening of a functional generic New Model workspace,
ordinary wind Model, real multi-turn provider use, a second persistent
Conversation, fixed-copy Project, Conversation-led Experiment edit, real batch
outputs/events/download, user-requested analysis, restricted visual frame,
backend restart, provider-unavailable read-only behavior, 1440x900, narrow
viewport, keyboard, 200% zoom, and zero unexpected console errors. None of
those Stage 4 acceptance rows is complete on A4-0 or A4-1.

A4-1 deletion negatives include Model, Project, and Conversation targets with
in-flight turns/checks/Runs/processes plus active download/frame/WebSocket/tool
authority. Preview and commit must block without implicit cancellation; after
typed terminalization/revocation, a concurrent issuance or activity drift still
fails before the first delete byte.

A4-4 renderer negatives enforce the exact A4 byte/node/depth/row/line/mark
limits and the non-weakening CSP. Oversized or deeply nested persisted content,
unsafe URLs, active attachments, and content-derived CSP sources must not create
unbounded parsing/DOM work, remote loads, or script execution.

### A4-0 design-gate evidence

The 2026-07-25 A4-0 documentation-only gate records:

- PRD traceability: all 69 active PRD IDs occur in the A4 matrix; every
  implementation status remains `pending`;
- independent Product, Architecture, and Security final review:
  P0=0/P1=0/P2=0 for each;
- backend: 570 total, 569 passed, zero failed, one optional installed-OpenCode
  smoke skipped;
- web: 104/104 component tests and network entry 1/1;
- production web build: passed;
- retained Chromium: 15/15;
- isolated A3 Product Chromium regression: 1/1;
- Mesa service: 121/121;
- docs: 26 Markdown files and `git diff --check` passed; and
- Issue #15 remained OPEN with every browser/cleanup exit checkbox unchecked.

Sandbox-only attempts that could not use `ps` process identity or bind `::1`
were not accepted as gate results; the recorded backend and network/browser
results are the successful local runs with those required OS capabilities.
These regressions prove the design change did not alter existing behavior; they
do not satisfy any Stage 4 implementation or MVP exit row.

### A4-1 Product API evidence

The 2026-07-25 A4-1 slice implements backend contracts only. Focused tests
cover closed Home/collection DTOs, uniform browser admission, lifecycle
receipt replay, preview/confirm delete, token consumption and generation
rotation, exact indexed-byte closure, symlink/hardlink/unindexed/drift
negatives, fixed-copy preservation, restart replay, and the resource authority
deletion fence. Historical Agent/Project/run/frame/WebSocket tests were moved
through the same real browser session contract rather than receiving a bypass.

The visible entry remains the legacy/Evidence switch. No Home, router, shared
shell, Conversation pane, renderer, startup cutover, cleanup, full Chromium
exit matrix, Issue closure, or MVP claim is evidence of A4-1. All 69
traceability rows therefore remain `pending` until their full listed owners
merge and A4-6 verifies them continuously.

The complete A4-1 branch gate records backend 583 total / 582 passed / zero
failed / one optional installed-OpenCode smoke skipped; web 104/104 plus
network-entry 1/1; production web build passed; 27 Markdown files and
`git diff --check` passed. These counts are branch evidence, not post-merge or
A4-6 browser evidence. Independent Product/correctness, Architecture, and
Security final reviews each report P0=0/P1=0/P2=0 for the current A4-1 diff.

### A4-2 Home and shared-shell evidence

The 2026-07-25 A4-2 branch changes the visible default Vite entry without
claiming startup cutover. Component tests cover separate Home collections,
all four entry types, closed DTO ordering, Model creation intent, honest
provider/executable-Model disabled states, route parse/rejection, browser
bootstrap/CSRF reuse, public errors, and right-workspace DOM identity across
Conversation selection. The full Web component suite currently passes
112/112; the focused Product component/client/router subset passes 10/10; and
network entry passes 1/1.

`cd web && npm run test:e2e:a4-2` runs one isolated real Chromium scenario
against a temporary ProductStoreV2 plus the ordinary preinstalled wind
Model/Project. It verifies the real bootstrap/cookie/CSRF path through Vite,
Home and four entry types, provider-unavailable honesty, the same shell for a
Model and Project, a missing Conversation error without right-pane remount,
desktop dual landmarks, narrow keyboard pane switching, equivalent 200%
layout with no horizontal overflow, three reviewed screenshots, and zero
unexpected console errors. The dedicated scenario passes 1/1. The
Visual-Agent browser security matrix, updated to use the same real Product
browser admission rather than a raw bypass, passes 6/6.

The deprecated Evidence/Legacy query paths remain regression-only until A4-5.
Their retained full Chromium matrix must pass on the current branch before
A4-2 merges; its current-branch rerun passes 15/15. The backend full suite
passes 583 total / 582 passed / zero failed / one optional installed-OpenCode
smoke skipped. Production build, 27-document governance check, and
`git diff --check` pass. Final independent Product/architecture review reports
P0=0/P1=0/P2=1, Accessibility/interaction reports P0=0/P1=0/P2=0, and
Test/documentation consistency reports P0=0/P1=0/P2=0. The sole P2 is the
explicitly documented equivalent-200%-layout limitation; actual browser zoom
remains owned by A4-6.

No A4-3 Conversation messages/actions, A4-4 renderer/execution, A4-5
cutover/retirement, A4-6 continuous browser exit, Issue closure, or complete
MVP claim is A4-2 evidence. All 69 final traceability rows remain `pending`.

### A4-3 persistent Conversation evidence

The A4-3 focused backend matrix covers schema-v15 migration/rollback,
provider-binding replay and changed-intent rejection, lifecycle-filtered
owner collections, cross-owner exclusion, attachment name/media/owner
negatives, safe document/activity projection, provider lock, durable
read-only no-fabrication, and restart projection. Component/client tests cover
right-pane DOM identity, safe durable cards, read-only composition behavior,
CSRF on POST and PATCH, and public error handling.

`cd web && npm run test:e2e:a4-3` runs one isolated deterministic Chromium
scenario against a temporary ProductStoreV2 and ordinary preinstalled wind
Model. It creates two provider-backed Conversations plus a disposable deletion
target, changes and locks a provider, uploads and reuses an attachment,
switches Conversations without right-pane remount, renames/archive/restores,
executes preview/confirm permanent deletion, verifies a provider failure
persists no assistant reply, exercises narrow keyboard state, scans browser
responses for upstream session/absolute-path/raw-payload leakage, and requires
zero console errors. This deterministic scenario is not the A4-6 real-provider
acceptance.

The complete A4-3 branch gate records backend 586 total / 585 passed / zero
failed / one optional installed-OpenCode smoke skipped; Web component/client
116/116; network entry 1/1; dedicated A4-3 Chromium 1/1; retained A4-2
Chromium 1/1; retained full Chromium 15/15; and the independent Visual-Agent
Chromium security matrix 6/6. Production build, the 27-document governance
check, and `git diff --check` pass. Final independent Product/architecture/
security, Accessibility/interaction, and Test/documentation reviews each
report P0=0/P1=0/P2=0 after fixes and re-review.

A4-4 through A4-6, actual 200% browser zoom, the continuous exit matrix,
Issue closure, and complete-MVP claims remain pending. All 69 final trace rows
remain `pending`.

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

The implementation and deterministic gates do not depend on provider quota.
For the live smoke only, if the approved `opencode-go` quota is exhausted
before the run starts, the operator may select the exact catalog entry for
`opencode` `deepseek-v4-flash-free` and start a new acceptance conversation.
Riff never silently falls back, and it never changes provider/model inside a
conversation after the first accepted user turn.

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
