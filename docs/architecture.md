# Architecture contracts

## Milestone A2 authority and A3 execution architecture

The current authority is the
[`Milestone A product contract`](milestone-a-product-contract.md), the
[`Stage 1 data design`](milestone-a1-data-foundation-design.md), and the
[`Stage 2 Agent/workspace design`](milestone-a2-agent-workspace-design.md).
`ProductStoreV2` over SQLite schema migration v7, execution contract v4, and
checked object bytes is the system of
record. Conversation/OpenCode services, scoped MCP/skills, Model workspace
helpers, technical checkers, HTTP projections, DOM, and Agent prose cannot
write around that store or become authoritative state.

Stage 2 currently adds these implemented boundaries:

```text
Narrow A2 HTTP/API acceptance surface
  -> conversation / Agent session coordination
       -> ProductStoreV2 schema v3
       -> loopback OpenCode adapter + bounded Riff context
       -> per-conversation serialized turns
       -> per-turn capability-scoped MCP tools + progressive skill loading
       -> conversation attachments + temporary documents
       -> generic Model workspace
            -> restricted macOS process + digest-bound technical checker
```

A3-1a established the durable planning boundary:

```text
copied Project input schema
  -> closed canonical schema validator
  -> deterministic ExperimentConfigurationV1 sample planner
  -> configuration + record digest CAS + immutable historical command receipt
  -> Store-only execution-description-v2 admission
  -> atomic frozen queued Run + immutable start receipt
       -> copied Project / execution / configuration / sample-plan / limits digests
```

A3-1b connects that frozen record to a real, batch-only execution path:

```text
POST /api/projects/:projectId/runs
  -> replan and freeze server-owned RunLimitsV1
  -> durable dispatcher generation + one queue claim
  -> exact copied Project execution-root capability/digest verification
  -> GenericBatchSupervisor
       -> one restricted riff-batch-v1 process per sample
       -> persisted launch gate and process identity
       -> supported hard-limit enforcement and process-group cleanup
       -> closed terminal/process evidence and best-effort error unwind
       -> atomic successful object bytes + output indexes + terminal state
GET /api/projects/:projectId/runs/:runId
  -> bounded run/output projection with no paths, commands, or process identity
```

Execution-contract-v3 experiment/run/output records still migrate to deterministic
read-only v3 projections. The A3-1b dispatcher is now the runtime producer for
contract-v4 batch attempts. It admits only copied execution-description v2 batch
capability and rechecks the exact Project-owned root before launch. Successful
outputs become visible only after byte, size, media, and digest validation and
one atomic publication transaction. Database triggers require the same internal
atomic-success context for both v4 run output objects and indexes, and make
terminal run/process evidence immutable. Schema migration v5 binds the first
cancel timestamp to one exact committed `run.cancel.v1` receipt and requires
every registered process to have `cleanup_complete` before run terminalization.
Schema migration v6 adds immutable scratch leases, launch manifests/receipts,
and recovery actions so spawn intent exists before directory creation and Model
code remains behind a one-use gate until its exact process identity is durable.
Dispatcher errors can terminalize only after registered processes have durable
exit and verified cleanup evidence; otherwise
the live attempt stays fail-closed for operator repair.

The official generic scaffold now emits execution-description v2 and declares
batch only. Visual starts fail with `capability_not_available`; batch
`domainEvents` fail with `domain_events_not_supported`. Same-process backend
shutdown aborts the supervisor, terminates the verified process group, cleans
owned scratch, and records `dispatcher_shutdown`. A3-1c-a cancellation
immediately aborts the matching active in-process run and uses heartbeat
observation only as a fallback. A3-1c-b startup audits recovered successes,
drains committed queued cancellations, then reconciles only durable v4 prior
attempts before activating a new dispatcher generation. It verifies PID,
start-token, and process group before signalling; removes only an exact
registered scratch lease; preserves untracked directories; and fails closed
with `dispatcher_recovery_required` on absent or contradictory evidence.
An unfinished recovery action is adopted by the next random dispatcher
generation using its stable prior-attempt identity. One in-process dispatcher
owns a `ProductStoreV2` until stop releases that guard; the Store writer lock
provides the cross-process singleton boundary. Migrated schema-v5 live process
rows have no v6 launch/scratch identity and intentionally fail recovery closed.
A3-1c-c schema v7 publishes one deterministic `platform_card` system message
in the same SQLite transaction as terminal batch state, or records
`not_requested` / `conversation_unavailable`. Startup reconciles terminal
`pending` rows after mutation recovery, then audits message/receipt/card
agreement and fails closed on drift. Agent turns cannot own platform cards;
bounded Agent context serializes only their five allowlisted fields.
Visual supervision, scoped browser/Playwright access, and wind import also
remain later Stage 3 slices.

The planned visual work is deliberately split so persistence authority lands
before public execution:

```text
A3-2a1 schema v8 / Store / recovery
  -> extend v6 scratch / launch / recovery to visual
  -> harden existing v4 visual process shape; make launch port immutable
  -> atomic one-write health_at + matching immutable receipt
  -> reject unproven pre-v8 health/live evidence
  -> public visual start still capability_not_available

A3-2a2 real visual lifecycle
  -> same canonical single-sample --riff-input as batch
  -> assigned --riff-output-dir --riff-host 127.0.0.1 --riff-port
  -> visual-only sandbox: assigned IPv4 listener only, no ::1/outbound network
  -> exact GET health + before/after listener ownership + one CAS receipt
  -> cancellation / timeout / output validation / restart cleanup
  -> maxActiveVisualRuns=1; full visual lane cannot block batch queue drain

A3-2b isolated broker / frame / WebSocket
  -> platform app + broker exact-bind ::1 on different server-owned ports
  -> one-use frame capability + exact broker Host:port/path

A3-2c scoped Playwright
  -> current Project + current healthy attempt -> bounded observation
  -> explicit one-turn, one-use typed interaction
```

Port selection closes a local probe socket before child bind and therefore has
a bounded TOCTOU window; it is not a strong reservation claim. Health cannot
commit until the platform proves the exact recorded child/process group owns a
listener on only the assigned loopback endpoint. The visual-specific sandbox
denies all outbound/direct network access, every other IPv4 listener, and every
IPv6/`::1` bind. When the host cannot express an endpoint-level bind filter,
exact OS listener ownership is a required compensation but never permission to
relax outbound denial.
Schema v4 already has visual process kind, port, `health_at`, and the
one-live-visual-process rule, but the port is currently updateable and health
does not have complete one-write/receipt atomicity. Schema v8 does not re-add
those fields: it rejects every port update and requires a single
null-to-receipt-timestamp `health_at` write plus the unique matching receipt in
one transaction for the exact running launch/port/path/identity. Health-only,
receipt-only, mismatched, or repeated evidence fails. Unproven pre-v8 visual
health/live evidence fails migration closed.

Health first
detects exact OS listener readiness, then performs one no-retry
manual-redirect exact-path GET, accepts only bounded `200`, rechecks listener
ownership after the response, and commits one same-identity CAS receipt.
Concurrent/repeated calls cannot send another request. Exact IPv4 listener
ownership is monitored while running and checked again at termination. The port
and health evidence remain backend-only and cannot become a URL/secret
projection.

The first implementation has a server-owned `maxActiveVisualRuns = 1` and an
active map keyed by `(runId, attemptId)`. A full visual lane leaves the next
visual queued while batch claims continue under their unchanged cap. The same
dispatcher generation heartbeats and finalizes each lane; a slot releases only
after terminal commit and verified cleanup. Stop aborts and joins all lanes
before Store close.

The platform app and broker both exact-bind IPv6 loopback `::1` on different
server-owned ports and expose `http://[::1]:<port>` URLs. The port split gives
same-origin-policy DOM isolation while the shared host remains same-site for
`SameSite=Strict`. Their cookies still cross ports and are not isolated from
each other; the real host boundary is that platform `::1` cookies are not sent
to the untrusted visual child on `127.0.0.1`.

The app cookie is host-only, HttpOnly, and `Path=/api/`. Bootstrap requires
exact app Host/Origin and `Sec-Fetch-Site: same-origin`; a new generation
revokes older frame/WS capabilities. Frame-session additionally requires the
exact cookie and CSRF. First nonce navigation normally has no Origin and uses
exact broker Host/path plus atomic nonce consumption within at most 60 seconds;
expiry, restart, or generation rotation invalidates it immediately. Later
broker HTTP requires the exact named cookie/live attempt, and exact broker
Origin when one is present; WS always requires the exact broker Origin. The
broker cookie expires at `min(attempt expiry, 15 minutes)`. Both cookies may
omit `Secure` on current HTTP and must set it under future HTTPS. Every broker
document permits framing only through CSP
`frame-ancestors http://[::1]:<exact-app-port>`; wildcard ancestors and
`X-Frame-Options: SAMEORIGIN` are forbidden. The capability registry
binds browser-session generation, Project, run, attempt generation, expiry, and
socket set. Revocation closes sockets before deleting state. Cookie `Path` is
not authority, and A3-2c does not reuse user frame secrets.

Visual completion cards are intentionally absent. A visual start that supplies
`completionConversationId` fails with `visual_completion_not_supported`;
accepted visual runs keep the disposition `not_requested` and terminalize
without a completion-card receipt or message. Success requires exact child exit
code zero plus atomic validation of every required declared output. A3-2a1 and
A3-2a2 have no proxy/frame/WebSocket/Playwright or browser evidence claim.
The target run DTO supports both run kinds. Visual terminal codes are
`visual_run_succeeded`, `visual_process_failed`, `visual_health_failed`,
`visual_listener_invalid`, and `visual_startup_timeout`; same-process shutdown,
restart, and cancel-first remain respectively `failed/dispatcher_shutdown`,
`failed/runtime_interrupted`, and `cancelled/run_cancelled`.

One conversation owns one provider/model lock and at most one nonterminal
backend-only external session generation. Its turns are serialized; the scoped
OpenCode MCP registration is additionally serialized because that registry is
process-global. Each turn receives a server-minted owner/conversation/turn/
generation capability that is revoked and unbound at completion. Lost sessions
rebuild from bounded Riff-owned context; provider failure is explicit read-only.
Tool execution rechecks the running turn and latest available session
generation. Proposal-only turns may create draft temporary documents but cannot
perform any other durable mutation or lifecycle transition. All direct Model
changes use typed owner-scoped tools and Stage 1 database/filesystem recovery.
Project conversations cannot change copied Model code, schema, or dependencies.
OpenCode prompt-tool policy denies `*` by default and enables only the exact
scoped MCP name for that turn, so unrelated built-ins or ambient MCP servers do
not become authority.

The restricted runner supplies a capability-resolved writable Model directory,
fixed executable/arguments, scrubbed environment, no network rule,
cancellation, finite time/output limits, and only fixed read-only Python
runtime/virtual-environment roots through macOS `sandbox-exec`. Arbitrary home
and sibling paths stay outside the profile. This local-user boundary does not
claim VM/container isolation from malicious code. Technical
executability is digest-bound evidence that a thin interface runs; it is not
scientific validity, calibration, trust, or decision suitability.

Legacy Gate/wind and queue components still coexist and are retired only by an
explicit later audit. A3-1c-c is not completion evidence for Stage 3. #14 still
owns the remaining visual and wind work; #15 owns
the final Models/Projects home and shared two-pane browser shell.

---

# Legacy wind-turbine alignment architecture target

## Status

This is the former approved Gate 0 target, retained as implementation history.
Parts of the in-memory queue/wind path still coexist, but it no longer governs
the Milestone A2 implementation or authorizes removal.

## Objective and boundaries

Riff will support one local, durable project in which an operations lead and an
Agent can shape an onshore wind-turbine maintenance experiment, inspect its
mapping to a reviewed Mesa model, record issues and human attestations, execute
safe drafts, and inspect artifact-backed results.

The browser never receives provider credentials and never calls OpenCode or
Mesa directly. The backend owns project state and policy derivation. Mesa owns
model bundles and immutable run artifacts. OpenCode proposes typed changes; chat
text, DOM state, Playwright, diagrams, and generated prose are projections only.

Phase 1 excludes arbitrary model creation, remote deployment, authenticated
multi-user editing, a database, real wind-farm calibration, scientific
validation, and staffing recommendations.

## Identities and revision graph

The word `revision` is never overloaded:

| Identity | Meaning |
| --- | --- |
| `snapshotRevision` | Mutable project-snapshot concurrency sequence. |
| `decisionBriefRevisionId` | Immutable business question, constraint, assumption, source, and non-goal revision. |
| `alignmentMapRevisionId` | Immutable mapping from business artifacts to model rules, parameters, and metrics. |
| `modelRevisionId` | Immutable code/spec/schema/defaults/traceability bundle. |
| `experimentRevisionId` | Immutable complete parameter values, preset, horizon, warm-up, seed, and bound upstream revisions. |
| `runId` | One execution bound to all preceding identities and content digests. |

Parameter value changes create an experiment revision. Rule, meaning, unit,
range/schema, distribution family, state transition, or metric-formula changes
create a model revision. A run accepts an experiment revision, not free
unversioned parameter overrides.

## Durable local layout and ownership

```text
WORKSPACE_ROOT/projects/<project-id>/
  project.json                                  # backend atomic snapshot
  inputs/                                       # backend
  alignment/decision-brief/revisions/           # backend, immutable
  alignment/requirement-map/revisions/          # backend, immutable
  issues/                                       # backend append events + current snapshot
  attestations/                                 # backend, immutable/superseding
  experiments/revisions/                        # backend, immutable
  models/wind-turbine-maintenance/revisions/    # Mesa/model package
  runs/                                         # Mesa execution artifacts
```

Each file family has one writer. Atomic temporary-file promotion protects
mutable snapshots; immutable IDs are content-bound. A browser `sessionId` is a
temporary control connection and never creates or substitutes for a durable
`projectId`. Restart recovery restores current pointers and does not mint fake
model revisions.

Large event streams and replay artifacts remain paged files. `ProjectState`
contains bounded summaries, counts, identities, and artifact references rather
than complete event logs.

## Workflow and trust separation

Two independent review subjects are required: the alignment-map revision and
the experiment revision. The default progression policy for each is at least
one human `project_owner` endorsement and zero open blocking issues. One action
may cover both only by naming both revisions explicitly.

This policy is a computed workflow fact. Zero issues means no recorded
objection; it does not imply endorsement or correctness. Agent reviews do not
count as human endorsements. Safe private drafts may run while the policy is
unmet, and their results are never promoted in place after later review.

Scientific trust remains separate, progressive, claim-scoped, and evidence
backed. Gate 0 creates no new scientific evidence.

## Generated-view data flow

```text
model code -> model-spec.json -> entity/state diagram
domain-events.jsonl           -> swimlane/replay/2D projection
requirement map + spec + experiment revision -> traceability diagram
```

Every derived view records its input digest and generator version. Contract
tests fail on code/spec, mapping/view, or revision/run identity drift.

## Delivery dependency

Gate 1 implements the model and evidence; Gate 2 implements durable project
state; Gate 3 implements the two-pane workbench and generated views; Gate 4
proves the real OpenCode browser story and removes the queue path. A later gate
cannot close while an earlier dependency remains open.
