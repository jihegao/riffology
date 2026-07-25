# Milestone A3 project execution design

- Status: active
- Role: active design
- Scope: Stage 3 Project execution contract and implementation ledger for Issue #14
- Source of truth: Riff MVP PRD; merged code and PRs for implementation status
- Last reviewed: 2026-07-25

The first foundation slice implemented fixed-copy Project creation and the
Project workspace projection.
A3-1a adds execution contract v4, the closed canonical input-schema profile, deterministic
experiment/sample planning, configuration-and-record digest compare-and-set
with immutable historical command receipts, execution-description-v2
admission, and atomic creation/replay of a frozen `queued` run/start receipt.
A3-1b adds the public run start/read routes, durable dispatch, a real generic
batch process per sample, hard enforcement of the currently supported
server-owned limits, and atomic successful output publication. The official
generic scaffold now emits execution-description v2 and declares batch only;
existing v1 Models are not silently upgraded.

Visual completion and batch `domainEvents` are explicit current rejections;
published A3-2a2c admits eligible visual starts through the existing
Project-run API.
A3-1c-a adds schema migration v5, the strict public cancel command/receipt, queued no-launch and
running abort behavior, public `cancelling` projection, and SQLite commit-order
precedence against every terminal transition. A3-1c-b adds schema migration v6,
durable pre-spawn scratch and launch evidence, exact v4
attempt/process/scratch reconciliation, and recovery-before-generation
activation. A3-1c-c adds schema migration v7, exactly-once deterministic
batch platform completion cards, permanent skip dispositions, and startup
reconciliation/audit of terminal pending rows.
A3-2a1 was merged and published through PR #28: schema v8 freezes visual port/health
evidence, public visual admission remains closed with stable negative codes,
private Store primitives record the visual process-evidence lifecycle, and
cross-restart recovery reconciles exact durable visual evidence. Its focused
fake-supervisor recovery suite passes 29/29 without starting a real visual
child or opening a listener. The broader focused root gate passes 62/62, the
independent reviewer gate passes 81/81, independent recovery review is PASS,
its historical full backend gate reported 314 total with 313 passed, zero
failed, and one optional installed-OpenCode smoke skipped, and web passed
104/104 plus its production build.
A3-2a2a was merged and published through PR #29 at merge commit `1584e39`.
Schema v9 replaces the former batch-only atomic
success/output triggers with run-kind-bound authority, adds a database visual
no-completion invariant, and adds private Store authority for visual claim,
queued cancellation without a card, terminalization, and atomic success/output
publication.
A3-2a2b was merged and published through PR #30 at merge commit `9f23f61`.
Its generic single-attempt visual supervisor and launch-gate, sandbox, exact
process/listener, one-shot health, bounded output, and cleanup safety primitives
run a real `riff-visual-v1` child.
A3-2a2c was merged and published through PR #31 at merge commit `361b36f`.
One dispatcher generation owns
independent batch and one-slot visual lanes; exact-generation heartbeat,
cancellation, and finalization, a fatal-error latch, stop/join, and
generation-fenced cleanup of unlaunched visual scratch preserve the shared
lifecycle boundary. Existing Project-run admission now accepts visual work,
restart audit validates exact visual success evidence, and the real-process
public vertical plus DTO/error/log secrecy gate pass. Its publication evidence is a
final full backend gate of 385 tests with 384 passed, zero failed, and one
optional installed-OpenCode smoke skipped; the focused 13/13 gate covers the
review regressions; the real public vertical passed; web passes 104/104 and
the production build succeeds.
The A3-2b1 implementation was merged and published through PR #33 and adds the
isolated browser-network primitive and a
`BackendApp.listenBrowserNetwork()` integration path. It exact-binds a platform
app and an empty broker to distinct server-owned `::1` ports, rejects
non-canonical Host values before either handler, and serializes startup/close
so partial or stale listener pairs cannot survive. The broker exposes no frame route,
proxy, cookie, nonce, or WebSocket. The backend production entrypoint now uses
this pair; the existing Vite UI remains a separate development proxy surface,
not the future frame-capability app.
The published A3-2a2c slice exposes neither the child port nor browser access.
Visual completion remains HTTP `422` `visual_completion_not_supported`;
A3-2b2 frame bootstrap/HTTP proxy was merged and published through PR #35.
A3-2b3 WebSocket/revocation/secrecy was merged through PR #36 at `bb54b2a`;
its server-level evidence includes fixed
broker/child sockets, bounded negative admission/upstream handshakes,
attempt-global cross-route connection limits, generation/shutdown closure, and
observable/persisted sentinel scans. The focused frame/network/WebSocket
regression combination passes 32/32; the serial official backend gate reports
464 total with 463 passed, zero failed, and one optional smoke skipped. Web remains
104/104, the network-entry integration passes 1/1, and the production build
succeeds. A3-2b4 was merged and published through PR #37; its dedicated
real-browser matrix passes 5/5. A3-2c1's authority/audit and legacy-CDP-
isolation foundation was merged through PR #38. A3-2c2 adds bounded,
Project-only read observation while exposing no interaction or caller-selected
browser target. A3-2c3's one-use typed interaction was merged through PR #41
and A3-2c4's live-CDP/real-Chromium security closeout through PR #42. A3-2d1
output list/download was merged through PR #43. A3-2d2 strict diagnostic-event
ingestion, schema-v12 atomic publication, and opaque cursor reads were merged
through PR #44; A3-2d3 direct controls were merged through PR #45.
The d3 merge gate reports 552 backend total with 551 passed, zero failed,
and one optional installed-OpenCode smoke skipped; web passes 104/104,
network entry 1/1, the production build and docs check succeed, and final
independent security review reports no P0/P1 merge blocker.
The A3-2d4 closeout merged through PR #46 at merge commit `660c9a7`. It adds no new runtime contract. Its
fault-injected production API/revocation-wiring matrix proves that the pre-commit callback
invalidates an unredeemed frame nonce, a redeemed frame route, an open
WebSocket, and a minted Visual-Agent capability, and that restore cannot revive
old authority. Durable Store mutation/receipt evidence remains the published
A3-2d3 boundary. The focused backend combination passes 65/65 and the complete
dedicated broker Chromium matrix passes 6/6. The full merge gate is
553 backend total/552 passed/zero failed/one optional OpenCode smoke skipped,
web 104/104, network entry 1/1, full Chromium 15/15, successful production
build, and a 24-file docs check. Independent security review reports P0/P1=0;
cross-run over-revocation and joint issuance/trash race coverage remain
non-blocking P2 follow-ups.
The c3 merge gate reports 525 backend tests with 524 passed, zero
failed, and one optional installed-OpenCode smoke skipped; web passes 104/104,
network entry 1/1, the production build succeeds, and three independent reviews
have no P0/P1 merge blocker.
The complete Chromium suite passes 8/8. The current backend gate reports 466
total with 465 passed, zero failed, and one optional installed-OpenCode smoke
skipped; web passes 104/104, network entry 1/1, and the production build
succeeds.
A3-3 ordinary wind import is implemented on the current review branch. It uses
one immutable schema-v13 installation manifest, an ordinary technical check,
one fixed-copy Project, and one single-seed baseline Experiment; it adds no
wind-specific route, DTO, or dispatcher branch. The 14-file manifest pins
source commit `10df6f742e37c661160d331b89a76c5542c80ab8` and digest
`05775ff9d24d5dc4670544693bafff1f3615bdaa3a5db1901b2d6136eb448bf0`.
Its stable Model, Project, and baseline Experiment IDs are respectively
`preinstalled_model_0f768eee91e248ef310e26aecbc53263`,
`example_project_0f768eee91e248ef310e26aecbc53263`, and
`example_experiment_7f9ae4eb64540f876b99c0364593f3ce`.
The exact baseline yields 1,096 daily rows and 38,730 diagnostic events through
the generic contracts. A3-3 and the remaining integration slice are not Stage
3 completion evidence.
Non-blocking follow-ups remain explicit: recovery technical-check attempts
currently use the fixed manifest clock, and diagnostic parsing retains the
bounded raw buffer plus parsed object tree without a four-lane peak-memory
stress claim. Schema-v13 rollback is schema-snapshot checked, while direct raw
SQL trigger-behavior matrices remain additional hardening rather than A3-3
merge evidence.
The final A3-3 review gate is backend 570 total/569 passed/zero failed/one
optional OpenCode smoke skipped, web 104/104, network entry 1/1, Chromium
15/15, reviewed wind 38/38, a successful production build, and a 25-file docs
check. Independent correctness/security review reports P0/P1=0.

This document is subordinate to the
[Riff MVP PRD](product-requirements.md), builds on the
implemented [Stage 1 data foundation](milestone-a1-data-foundation-design.md),
and preserves the
[Stage 2 Agent and Model workspace](milestone-a2-agent-workspace-design.md)
authority. It does not define or claim the final Stage 4 shared product shell.

## Current implementation boundary

The published boundary through A3-2b4 remains implemented: A3-2b1, A3-2b2,
A3-2b3, and A3-2b4 were merged through PR #33, PR #35, PR #36, and PR #37.
The combined boundary is
intentionally narrow:

- `POST /api/projects` creates a server-owned fixed copy from an active,
  technically executable Model;
- `GET /api/projects/{projectId}/workspace` returns the copied execution
  description, copied-file metadata, conversations, experiment configurations,
  existing run records, and indexed outputs without exposing process commands or
  workspace roots;
- `POST /api/projects/{projectId}/experiment-configs` canonicalizes the copied
  Project input schema and configuration, expands the exact sample plan, and
  stores immutable create-command response receipts;
- `PATCH /api/projects/{projectId}/experiment-configs/{configId}` requires the
  last observed `expectedConfigurationDigest` and `expectedRecordDigest`,
  rejects stale configuration or metadata updates, and preserves exact
  historical update responses on command replay;
- execution contract v4 migrates v3 experiment/run/output rows to permanent read-only
  records, stores canonical digests, and constrains frozen run, command,
  receipt, and unified process-attempt identities;
- public start admission requires a copied execution-description v2,
  validates its schema profile, smoke input, output/cancellation declarations,
  requested run capability, and replans against the copied input schema;
- `POST /api/projects/{projectId}/runs` atomically creates or replays the exact
  contract-v4 `queued` run receipt with copied
  Project/execution/configuration/sample-plan/limits digests;
- the durable dispatcher claims an eligible queue generation, verifies the
  exact copied Project execution root, and starts the real generic batch
  supervisor;
- the supervisor launches one restricted `riff-batch-v1` process per sample
  behind a durable launch gate, records process identity, enforces the currently
  supported hard limits, and atomically publishes successful output bytes,
  indexes, process state, and run state;
- database triggers close queued/running/terminal run evidence, one-time process
  exit and terminal cleanup evidence, gate/state combinations, and the internal
  atomic-success context required for v4 output objects/indexes; schema
  migration v5 additionally binds first-cancel state to its exact committed
  receipt and requires every registered process to be `cleanup_complete` before
  run terminalization;
- schema migration v6 records immutable scratch leases, launch manifests,
  child-authored launch receipts, and recovery actions; startup audits success
  receipts, drains queued cancellations, and reconciles prior v4 live attempts
  before a new dispatcher generation activates;
- dispatcher heartbeat, capability, supervision, consumption, and publication
  exceptions share one best-effort unwind; only durably exited and cleaned
  processes can reach a failed terminal, otherwise the run remains
  recovery-required;
- `GET /api/projects/{projectId}/runs/{runId}` returns only the bounded run and
  checked-output projection; and
- `POST /api/projects/{projectId}/runs/{runId}/cancel` atomically creates or
  replays a strict receipt, prevents a cancelled queued run from launching,
  aborts active in-process supervision, and makes cancel-first terminalize as
  `cancelled` without successful outputs;
- schema migration v7 publishes one deterministic batch platform completion card, or
  one permanent skip disposition, in the terminal run transaction and audits
  or reconciles terminal pending rows before dispatcher activation;
- schema migration v8 covers migration/rollback with a representative v7 batch
  sentinel and the relevant legacy triggers, makes the launch-bound visual port
  immutable, and permits exactly one atomic null-to-receipt-timestamp visual
  health transition with an immutable matching receipt;
- schema migration v9 replaces the batch-only atomic-success/output triggers
  with a context bound to both run identity and run kind, preserves batch
  success/output behavior, rejects visual completion conversation/disposition/
  card state, and requires complete health/launch/scratch/exit-zero/cleanup
  evidence before visual success and output publication;
- private Store visual primitives preserve exact launch, scratch,
  run/attempt/generation/process/PID/start-token/process-group/port identity
  through registration, gate release, running, health, heartbeat, exit, and
  cleanup, without exposing those fields through the public run DTO;
- private A3-2a2a Store orchestration generation-fences visual claim, finalizes
  queued visual cancellation without a completion card, preserves
  cancellation-first terminal precedence, and atomically publishes visual
  success, required outputs, and indexes or rolls all changes back;
- one shared dispatcher generation runs independent batch and one-slot visual
  lanes, preserves exact-generation heartbeat/cancel/finalize authority,
  latches fatal lane failures, and aborts and joins every active lane before
  stop returns;
- generation-fenced cleanup removes only exact unlaunched visual scratch, and
  startup audit accepts terminal visual success only when its exact health,
  exit-zero, output, and cleanup evidence remains complete;
- visual recovery validates exact launch, scratch, process, port, health, and
  cleanup evidence before inspection or signalling and preserves visual
  completion disposition as `not_requested`; and
- the A3-2b1 browser-network entrypoint exact-binds separate app and
  broker servers to literal IPv6 loopback, derives CSP-compatible exact
  localhost browser authorities
  from their actual ports, and denies Host counterexamples before application
  code; and
- the existing Project-run start route admits an eligible visual experiment
  without adding a parallel API, while a request with
  `completionConversationId` returns HTTP `422`
  `visual_completion_not_supported`; and
- Project conversations continue to use the Stage 2 conversation contract.

The product database is schema migration v13 while the current execution
contract remains v4. Version-3 experiment/run/output rows remain
readable but cannot be mutated or dispatched. `estimatedSampleCount` is retained
only as a compatibility projection; v4 authority is `sampleCount` plus the
canonical configuration and sample-plan digests. The generic scaffold is now
execution-description v2 and batch-only; v1 Models require an explicit reviewed
re-scaffold/upgrade path.

The following are not implemented by the current boundary and must not be
inferred from workspace DTOs or schema-v4 tables:

- direct Agent-independent trash/restore routes;
- a versioned wind installation manifest or example Project.

Same-process shutdown does abort verified processes, clean owned scratch, and
persist `dispatcher_shutdown`. Cross-restart recovery handles only v4 evidence
that can be proven exact. A created scratch lease without a launch receipt,
PID/start-token mismatch, ownership/inode drift, contradictory state, or a
planned path that unexpectedly exists fails closed with
`dispatcher_recovery_required`; no untracked directory is scanned or removed.
Started recovery actions are adopted across newly randomized dispatcher
generations by stable prior-attempt identity. A per-Store in-process guard plus
the Store writer lock prevents a second local dispatcher from reconciling a
healthy owner. Schema-v5 live process rows lack v6 scratch/launch evidence and
intentionally require fail-closed repair instead of speculative signalling.
Eligible visual starts without a completion conversation use the existing
Project-run route; visual starts with `completionConversationId` fail with
`visual_completion_not_supported`. A3-2d2, merged through PR #44, admits batch
`domainEvents` only as strict diagnostic NDJSON with atomic terminal
publication.

The published A3-2a1/A3-2a2a/A3-2a2b/A3-2a2c contracts
dispatcher/public admission implementation preserve this public boundary:
visual runs share the existing Project-run resource, child ports remain
private, and the `completionConversationId` negative gate remains HTTP `422`
`visual_completion_not_supported`. Browser bootstrap, broker/frame routes,
WebSocket forwarding, and Playwright authority begin only in A3-2b/A3-2c.

## Outcome and stage boundary

Completed Stage 3 makes **New project** and Project execution functional. A user
can create a Project from a technically executable Model, edit or copy named
experiment configurations, start or cancel visual and batch runs, inspect
bounded status and outputs, and ask the Agent to inspect the current Project's
outputs or current visual page within explicit Project permissions.

Stage 3 includes:

- the public New project service over the Stage 1 fixed-copy primitive;
- Project-scoped Agent permissions, conversations, and direct controls;
- directly editable and copyable experiment configurations without revision
  history;
- exact frozen run configurations and deterministic sample plans;
- generic batch and visual launch, cancellation, timeout, resource, diagnostic,
  output-index, and restart behavior;
- optional bounded, filterable diagnostic domain events;
- explicitly authorized Playwright observation and interaction with the current
  Project's current healthy visual attempt; and
- idempotent installation of the reviewed wind Model and one ordinary example
  Project.

Stage 3 does not include:

- the Models/Projects home, polished shared two-pane shell, offline recovery UX,
  or final wind browser acceptance owned by Stage 4 / #15;
- source-Model switching, user-visible Model or experiment revision chains,
  publishing, attestation, workflow policy, or recommendation gates;
- replay timelines, per-frame simulation state, automatic analysis, metric
  selection, optimization, or recommendations;
- removal of legacy Gate/queue code or untracked local workspaces;
- Linux sandbox parity, cloud execution, multi-user authorization, or
  VM/container-grade hostile-code containment.

Stage 4 may change presentation but must not redefine the Project-copy,
experiment, run, output, event, capability, or wind-import contracts below.

## Authority and trust boundaries

`ProductStoreV2` is authoritative for identity, ownership, lifecycle,
experiment content, run state, frozen snapshots, cancellation intent, output
indexes, bounded event indexes, completion-card receipts, and trash state.
Object bytes are authoritative only when their owning row, relative path, byte
length, and lowercase SHA-256 digest agree.

Runtime processes, ports, health probes, proxy responses, iframe DOM,
screenshots, accessibility trees, Playwright observations, logs, and Agent prose
are projections or bounded evidence. They cannot mutate Project state without a
typed authorized command and cannot turn a failed run into a success.

A Project owns a copied Model snapshot and copied execution description. Later
source-Model edits, checks, archive, trash, dependency rebuild, or installer
updates cannot change existing Project bytes, digests, experiments, frozen
runs, or outputs. Runtime resolution starts only from Project-owned rows and
paths; it never follows `sourceModelId` to execute source-Model bytes.

Browser/API callers never supply workspace paths, authoritative digests, process
commands, environment values, OpenCode session IDs, child ports, proxy targets,
run scratch directories, or technical status. The platform owns orchestration,
limits, status, output ingestion, and the status overview. Model code owns its
declared simulation semantics and output content.

Execution retains the local-user macOS boundary: an application-owned working
directory, scrubbed credentials, no network by default, an allowlisted runtime,
the hard limits enumerated by `RunLimitsV1`, and explicit process-group
termination. Stage 3 does not claim hard CPU, resident-memory, or child-process
count enforcement on the current macOS `sandbox-exec` host. This is defense
against accidental access, not containment of hostile code. Passing a technical
check or completing a run does not prove scientific validity, calibration,
safety, decision fitness, or a recommendation.

A3-2a2 uses a separate visual `sandbox-exec` profile rather than widening the
batch profile. It permits the recorded child/process group to bind and listen
only on its assigned `127.0.0.1:<port>` endpoint and denies every other
IPv4 listener, every IPv6/`::1` bind or listener, outbound connection, and
direct network access. If the installed
macOS `sandbox-exec` cannot express an endpoint-level bind filter, the outbound
and direct-network denial remains mandatory and exact OS listener-ownership
inspection is an additional fail-closed compensation; it does not authorize a
broader outbound rule. The supervisor rejects any listener owned by the child
or its process group other than the one assigned IPv4 endpoint. It rechecks
that closed listener set before health, throughout the running lifetime, and
before terminal signal/cleanup.

## Schema v4 and repository contract

Stage 3 runtime requires an ordered schema-v3-to-v4 migration. The migration is
transactional, validates every existing row before advancing the version, and
aborts on ownership, JSON, digest, lifecycle, or timestamp ambiguity. It does
not create a parallel Project database.

Schema v4 retains existing `projects`, `experiment_configurations`, `runs`,
`object_files`, and `output_indexes` identities and adds only the execution
state required by this contract:

| Record | Required Stage 3 rule |
| --- | --- |
| `projects` and Project snapshot files | Copied execution description, snapshot metadata, and aggregate digest are immutable. Database triggers reject owner/path/media/size/digest changes to snapshot rows. Launch rechecks rows and bytes against the aggregate digest. |
| `experiment_configurations` | Add `contract_version`, canonical configuration JSON, exact `sample_count`, configuration digest, and optional legacy digest. During migration, the current `estimated_sample_count` name may remain only as an exact compatibility alias. Updates compare-and-set the prior digest. |
| `runs` | Add `contract_version`, run kind, same-Project experiment provenance, optional completion-card conversation, copied execution-description digest, copied Project-snapshot digest, frozen configuration and digest, exact sample-plan JSON and digest, `RunLimitsV1`, cancellation intent, timestamps, bounded terminal code/diagnostics, resource overview, and completion-card disposition. |
| `run_attempts` | Store an attempt generation unique within the run, the dispatcher generation that claimed it, lease/heartbeat state, bounded state, and claim/start/terminal times. The dispatcher generation is part of every claim/heartbeat/finalize compare-and-set. |
| `process_attempts` | One unified private process table for both batch and visual children. Bind run attempt, process kind, optional batch sample index/ID, OS PID, OS-derived start token, process-group ID, launch-gate state, launch/start/health/heartbeat/exit times, loopback endpoint only for visual, exit/signal observation, and cleanup receipt/digest. PID alone is never sufficient identity. Frame/proxy capabilities, credentials, raw commands, and arbitrary environment values are never stored. |
| `output_indexes` | Bind a run-owned `run_file` to one frozen `sample_index`, digest-derived `sample_id`, and declared logical name. Enforce uniqueness on `(run_id, sample_index, logical_name)`. |
| `domain_events` | Optional append-only `(run_id, sequence)` diagnostic records with sample index, bounded type/payload, byte count, optional event time, and creation time. They are not replay frames. |
| `completion_cards` or equivalent receipt | Batch runs only: enforce one platform completion card per `(run_id, conversation_id)` and record `published` or a terminal skip reason. Visual runs do not support completion cards; they keep `completion_card_disposition = 'not_requested'` without a `run_completion_cards` receipt. |

Integrity checks require:

- a run's experiment, optional completion-card conversation, files, outputs, and
  events to belong to the route Project;
- `runKind` to be `batch` or `visual` and declared by the copied execution
  description;
- requested sample count to equal the frozen sample-plan length;
- visual runs to contain exactly one sample;
- snapshot, configuration, execution-description, sample-plan, manifest, and
  file digests to be lowercase SHA-256 over their specified canonical
  projections;
- at most one nonterminal run attempt, strictly increasing attempt generations,
  and exactly one current dispatcher generation allowed to claim, heartbeat, or
  finalize it;
- at most one nonterminal batch `process_attempt` per `(run_id, sample_index)`
  and at most one nonterminal visual `process_attempt` per run attempt; PID,
  start token, and process group must all match before signal or cleanup, and
  cleanup is complete only when its durable receipt matches the identity;
- positive unique monotonic event sequences within configured count/byte limits;
  and
- terminal states and frozen run data to be immutable.

A dispatcher mints a new random generation at startup and acquires work through
one SQLite compare-and-set that records the generation and lease. A second
dispatcher or a stale generation cannot claim the same run, renew its heartbeat,
launch a sample, publish output, or finalize status. Lease expiry permits
reconciliation, not blind relaunch: recovery first proves every recorded sample
process identity and cleanup receipt. A generation mismatch fails with
`stale_dispatcher_generation`.

All run-state mutations use one transition table and compare expected state,
attempt generation, and dispatcher generation. Unsupported edges fail with
`invalid_run_transition`; no repository helper may set an arbitrary status.
Queued, running, or cancelling runs cannot be trashed or restored. The trash
route returns `run_not_terminal`; the user must cancel and wait for a terminal
receipt first.

### Schema-v3 legacy records

The v4 migration adds a mandatory `contract_version` discriminator to every
experiment, run, and output index. In one exclusive transaction it rejects
ambiguous run status/start/finish timestamp combinations, computes each
`legacy_digest` from a documented canonical projection, writes
`contract_version = 3` plus that digest, rebuilds the output-index projection,
and verifies the resulting legacy markers and database integrity before
advancing `user_version` to 4. Any lifecycle, parse, digest, ownership, count,
or integrity failure rolls back columns, rows, tables, and version markers.

All unambiguous version-3 experiments, runs in supported lifecycle states, and
their output indexes remain read-only legacy DTOs with `contractVersion: 3`,
`readOnly: true`, and
`legacyDigest`. They cannot be edited, copied as templates, dispatched,
cancelled, retried, converted in place, trashed, restored, or attached to a new
run. Downloads may remain available only through their existing same-owner
digest checks.

Conversion is an explicit copy command, never part of startup migration. It may
create a new version-4 experiment or imported result only when a versioned
converter can deterministically validate every field against the current
Project contract; the new resource receives a new ID, v4 digest, provenance to
the legacy ID/digest, and an idempotency receipt. Otherwise conversion fails
with `legacy_contract_conversion_unsupported`. Legacy runs are historical
evidence and are never made executable or inserted into the v4 state graph.

Every public mutation uses a command/idempotency key. A retry with the same key
and canonical intent digest returns the same durable resource and receipt. The
same key with changed intent fails before mutation. Experiment update also
requires both the configuration digest and complete public record digest
observed by the caller. Stale configuration fails with `stale_configuration`;
a concurrent rename or other record change fails with `stale_record`.

## Fixed-copy Project creation

`POST /api/projects` accepts only bounded `name`, source `modelId`, and
`commandId`. The backend mints the Project ID and timestamp, resolves the source
Model, and invokes `createProjectFromModel`; the caller cannot provide copied
files, execution descriptions, digests, paths, or technical status.

Creation requires an active technically executable source Model. One recoverable
mixed mutation rechecks source state and the complete eligible file set, copies
the bytes into the Project object root, stores Project-owned rows, copies the
execution description, and publishes the aggregate digest. An incomplete
materialization rolls back or is quarantined for exact recovery.

Launch verifies the complete Project-owned projection again. A mismatch returns
`project_snapshot_corrupt` before dispatch. Trashing a source Model does not
trash a Project; permanent purge remains blocked or explicitly previewed by the
Stage 1 lineage contract.

Project creation does not fabricate a conversation or require a provider.
Project conversations are created separately through the Stage 2 API.

## Execution-description v2 protocol

Before a Stage 3 run is admitted, the copied Project must contain an accepted
execution-description schema v2:

```ts
type ExecutionDescriptionV2 = {
  schemaVersion: 2;
  runtime: "python";
  runMode: "batch" | "visual" | "both";
  dependencyFile: string;
  inputs: {
    schemaProfile: "riff-json-schema-2020-12-v1";
    schema: JsonSchema;
    smoke: JsonObject;
  };
  outputs: Array<{
    logicalName: string;
    relativePath: string;
    mediaType: string;
    required: boolean;
    role: "metric" | "table" | "document" | "data" | "diagnostic";
  }>;
  overview?: {
    stepOrHorizonPointer?: JsonPointer;
    metricNames?: string[];
  };
  batch?: {
    entryPoint: string;
    protocol: "riff-batch-v1";
    domainEvents?: {
      relativePath: string;
      mediaType: "application/x-ndjson";
      role: "diagnostic";
      payloadSchema?: {
        schemaProfile: "riff-json-schema-2020-12-v1";
        schema: JsonSchema;
      };
    };
  };
  visual?: {
    entryPoint: string;
    protocol: "riff-visual-v1";
    healthPath: string;
    structuredInspectionPath?: string;
    webSocket?: {
      path: string;
      subprotocols: string[];
      maxFrameBytes: number;
      maxConnections: number;
      idleTimeoutMs: number;
    };
  };
  cancellation: { signal: "SIGTERM"; graceMs: number };
};
```

`runMode` and matching `batch`/`visual` sections must agree. Entry points,
dependency files, outputs, health paths, inspection paths, and WebSocket paths
are normalized Project-relative or same-origin paths with no traversal, query,
fragment, wildcard host, or caller-supplied target.

### Input schema and normalization profile

`riff-json-schema-2020-12-v1` is a closed profile of JSON Schema draft 2020-12,
identified by exact `$schema` value
`https://json-schema.org/draft/2020-12/schema`. The same versioned validator
implementation and profile digest is used by Model technical check, experiment
save/update, browser preview when available, and run start. Browser validation
is advisory; the two server mutations are authoritative and must produce the
same normalized parameters or stable error.

The allowed vocabulary is:

- boolean schemas and the keywords `$schema`, `$id`, `$defs`, `$ref`, `type`,
  `properties`, `required`, `additionalProperties`, `items`, `minItems`,
  `maxItems`, `enum`, `const`, `default`, `minimum`, `maximum`,
  `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, and `maxLength`;
- types `object`, `array`, `string`, `number`, `integer`, `boolean`, and `null`,
  including an array of unique type names for nullable values; and
- local references of the form `#/$defs/...` only. References are resolved
  after RFC 6901 normalization, must remain inside the one schema document, and
  must be acyclic.

External, relative-file, network, `$dynamicRef`, recursive, anchor, unevaluated,
conditional, composition, regex, tuple, content, and custom-extension keywords
are rejected as `input_schema_unsupported`. Unknown keywords are rejected
rather than treated as annotations. `format` is not an annotation in this
profile: any `format` keyword is rejected so different libraries cannot disagree.

Every object schema must declare `additionalProperties` explicitly as `false` or
as another allowed-profile schema. Omission fails technical check. Unknown
properties are never silently stripped. `default` is allowed only on a property
schema and must itself validate. Normalization deep-copies defaults into missing
properties from outer object to inner object before `required` validation;
defaults never overwrite explicit `null` or another supplied value. The
normalized result, not the pre-default request, is stored and frozen.

There is no coercion: strings never become numbers or booleans, integral numbers
never become strings, singleton values never become arrays, and unknown fields
are not removed. JSON numbers must be finite; `integer` additionally requires a
safe integer. Canonical JSON normalizes negative zero to zero. Numeric bounds
compare the parsed finite number without rounding or unit conversion. String
length is measured in Unicode code points. `enum` uniqueness and equality use
canonical JSON. Schema, smoke input, defaults, saved parameters, every applied
sweep value, and run-start parameters all pass this one normalization/validation
pipeline.

For `riff-batch-v1`, Riff launches one bounded process per sample with
`--riff-input <absolute-run-scratch-file>` and
`--riff-output-dir <absolute-run-scratch-directory>`. The versioned input file
contains only `{schemaVersion, runId, sampleIndex, sampleId, parameters, seed}`.
`seed` is always present and is either a safe integer or `null`; omission is not
an alternate representation. Each sample writes below its own assigned
directory and receives no SQLite path or Project/object-store root.

For `riff-visual-v1`, Riff supplies an unused loopback port and adds
`--riff-input <absolute-run-scratch-file>`,
`--riff-output-dir <absolute-run-scratch-directory>`,
`--riff-host 127.0.0.1`, and `--riff-port <server-assigned-port>`. The input
file is the same canonical single-sample envelope used by batch:
`{schemaVersion, runId, sampleIndex, sampleId, parameters, seed}`. A visual run
therefore receives its one frozen sample without a second normalization,
generated seed, or page-specific parameter channel. Health must succeed at the
exact declared same-origin path within the startup deadline.

Selecting a currently unused loopback port requires closing the platform probe
socket before the child can bind, so the local host has a bounded
close-then-bind TOCTOU risk. Stage 3 does not claim strong port preallocation.
After launch the supervisor must verify that the exact recorded child/process
group owns a listener bound only to the assigned loopback endpoint; wildcard,
different-process, different-group, or otherwise ambiguous listener ownership
fails closed before health can commit. The public API, DTOs, messages, and
ordinary logs never expose the assigned port.

WebSocket forwarding is denied unless the run-frozen `webSocket` object exists.
Its path is one exact absolute same-origin path below the minted broker route.
`subprotocols` contains zero to eight unique tokens; every offered token must
be declared and unique, the child selection must also have been offered, and
an empty declaration permits only a connection without a subprotocol. Values
are frozen with the run and must satisfy server ceilings:

- `maxFrameBytes`: 1 through 1,048,576 bytes;
- `maxConnections`: 1 through 8 concurrent connections for the attempt; and
- `idleTimeoutMs`: 1,000 through 300,000 milliseconds.

The proxy bounds assembled messages, individual fragments, pending plus active
attempt-wide connections, each direction's queued backpressure bytes, child
handshake time, and idle duration. Each direction queues at most 16 messages
and at most `maxFrameBytes` of payload. It applies the exact pre-upgrade
statuses and post-upgrade close codes frozen below and in
[ADR 0003](adr/0003-websocket-forwarding-and-revocation.md). It never forwards
cookies, authorization headers, the raw browser Origin, compression extensions,
capability routes/nonces, arbitrary paths, or redirects. The fixed child
handshake instead carries a server-generated exact broker Origin.

### Official scaffold migration

New Models created from the current server-owned generic scaffold receive an
execution-description v2 Python contract with only `riff-batch-v1`, canonical
input-schema profile, smoke input, cancellation declaration, and declared
outputs. This is the A3-1b runnable generic fixture; it does not declare visual
or `domainEvents`.

Execution v1 is never guessed into v2. A reviewed migration/upgrade command is
still future work. Its target contract uses a checked-in canonical manifest
with:

```text
manifestId = "riff-python-execution-v2"
manifestVersion = 1
manifestDigest = sha256(canonical JSON of the manifest excluding manifestDigest)
```

That future manifest pins every generated file path, size, digest, execution
description, and predecessor scaffold identity/digest. Automatic upgrade is
allowed only when the Model records the exact allowlisted predecessor
`manifestId`, version, and digest and every generated byte still matches that
predecessor. Any edit, missing identity, or digest drift returns
`execution_protocol_upgrade_required`; no user-authored Model or existing
Project snapshot is rewritten. The upgrade slice must check in the manifest and
its concrete digest so tests can detect drift.

Existing schema-v1 Models created before scaffold manifest metadata was stored
have no provable predecessor identity and are never auto-upgraded, even if their
files happen to resemble a known scaffold. Their owner must explicitly create a
new v2 scaffold or re-scaffold the Model through a reviewed command that
preserves the old Model as history. Existing Project copies remain immutable and
cannot become runnable by upgrading or replacing their source Model.

## Run limits and current enforcement

Every run freezes a server-owned `RunLimitsV1`:

```ts
type RunLimitsV1 = {
  schemaVersion: 1;
  wallTimeMs: number;
  startupTimeMs: number;
  terminationGraceMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxOutputFiles: number;
  maxOutputBytes: number;
  maxEventCount: number;
  maxEventBytes: number;
  maxSamples: number;
  maxConcurrency: number;
};
```

A3-1b freezes these current server defaults: `wallTimeMs: 300000`,
`startupTimeMs: 30000`, `terminationGraceMs: 5000`,
`maxStdoutBytes: 1000000`, `maxStderrBytes: 1000000`,
`maxOutputFiles: 256`, `maxOutputBytes: 64000000`,
`maxEventCount: 50000`, `maxEventBytes: 64000000`,
`maxSamples: 1000`, and `maxConcurrency: 4`. They are backend authority and
cannot be overridden by the public start request.

| Field | Scope, clock, aggregation, and terminal code |
| --- | --- |
| `wallTimeMs` | One run-attempt budget starting at committed dispatcher claim and ending at terminal commit. All batch samples share the remaining clock; visual startup and serving consume the same budget. Expiry terminates every verified process group with `run_wall_timeout`. |
| `startupTimeMs` | Visual-only clock from launch-gate release through OS listener-readiness detection and the single declared health GET. There is no HTTP retry. It is inside `wallTimeMs`; expiry before the one health receipt is `visual_startup_timeout`. Process durable-registration uses the separate fixed launch-gate deadline. |
| `terminationGraceMs` | Per process group from committed cancel/limit intent to forced termination. Groups may count down concurrently. Failure to prove exit/cleanup is `process_cleanup_unverified`, never success. |
| `maxStdoutBytes` / `maxStderrBytes` | Atomic run-level totals across every batch sample or the one visual child, counted as platform pipes are read. First overflow commits `run_stdout_limit` or `run_stderr_limit` and terminates the run. |
| `maxOutputFiles` / `maxOutputBytes` | Run-level totals across all samples, including required and optional declared outputs, measured from descriptor metadata and verified bytes during ingestion. Overflow is `run_output_file_limit` or `run_output_byte_limit`; nothing is partially published. |
| `maxEventCount` / `maxEventBytes` | Run-level totals across all sample event streams, counted before database publication. Overflow is `run_event_count_limit` or `run_event_byte_limit`; events are not truncated into success. |
| `maxSamples` | Admission-time exact frozen-plan length. Excess fails before queueing with `sample_limit_exceeded`. |
| `maxConcurrency` | Per-run maximum platform-launched batch process groups. It is additionally bounded by a server-global dispatcher ceiling; unused capacity in one run cannot increase another run's frozen value. |

The current A3-1b batch implementation may claim hard enforcement only for:

- dispatcher admission of `maxSamples` and simultaneous platform-launched
  sample processes up to `maxConcurrency`;
- the monotonic batch `wallTimeMs` budget followed by verified process-group
  termination;
- bytes consumed from the platform-owned stdout/stderr pipes;
- output file count and total bytes verified during atomic ingestion; and
- bounded termination grace followed by a verified process-group kill and
  cleanup receipt.

In the historical A3-1b batch-only boundary, `startupTimeMs`,
`maxEventCount`, and `maxEventBytes` were frozen reserved fields and visual
starts failed with `capability_not_available`. Published A3-2a2c enforces the
visual startup budget and admits eligible visual starts. The merged A3-2d2
enforces the frozen event count/byte budgets for declared diagnostic NDJSON.

A3-2a2 adds one server-owned global visual cap,
`maxActiveVisualRuns = 1`. It is not a member of caller-controlled
`RunLimitsV1` and does not change the existing batch concurrency cap. While the
visual slot is occupied, the dispatcher leaves the next visual run queued and
continues claiming eligible batch work.

Cross-limit precedence is deterministic by the first committed terminal receipt,
not by which observer logged first. Output bytes beyond a limit are never
published or silently truncated. Bounded diagnostic tails may be retained
separately and are marked truncated.

`cpuTimeMs`, `memoryBytes`, `maxProcesses`, and similar fields are not members of
`RunLimitsV1`. The current host cannot prove hard CPU, resident-memory, or
model-spawned child-process counts. The A3-1b public request has no caller-limit
fields, and the exact execution-v2 parser rejects extra description fields;
future APIs must use `unsupported_run_limit` if they introduce an explicit
request for one of these unsupported limits. Telemetry may report best-effort
CPU or memory observations as `advisory`, but admission, success, and trust
claims cannot depend on them. `sandbox-exec` filesystem/network policy is an
access boundary, not a resource-limit implementation.

## Experiment configuration contract

The existing experiment endpoints remain:

```text
POST  /api/projects/{projectId}/experiment-configs
PATCH /api/projects/{projectId}/experiment-configs/{configId}
```

Before run launch, their `configuration` value must use this canonical envelope:

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
```

`parameters` validates against the copied input JSON Schema. Pointers use RFC
6901 canonical escaping, resolve to existing or schema-allowed parameter fields,
and are normalized before comparison. The root pointer, duplicate normalized
pointers, and any parent/child overlap such as `/a` with `/a/b` are rejected
with `overlapping_sweep_pointer`.

Seeds must be unique safe integers. Axis values must be non-empty, finite JSON,
schema-valid after application, and unique by canonical-JSON equality; `1` and
`1.0` therefore collide. Duplicate seed or value errors are
`duplicate_sample_seed` and `duplicate_sweep_value`. Empty axes, unsafe
integers, unsupported JSON, forbidden keys, and sample-limit overflow fail
before persistence.

Sample count is exact:

- `single`: one; omitted `seed` expands to `seed: null`;
- `multiple-seeds`: the number of distinct seeds;
- `cartesian-sweep`: the checked product of axis cardinalities multiplied by
  the distinct seed count, or one `seed: null` branch when seeds are omitted.

The server stores and returns `sampleCount`. If schema migration temporarily
retains `estimated_sample_count` or the current `estimatedSampleCount` DTO, it
must be documented as an exact compatibility alias and equal `sampleCount`.
Visual configurations require `single` and exactly one sample.

Edit updates the same row using compare-and-set on the caller-observed digest.
Copy, when exposed, creates a new ID/name with identical canonical content at
the source digest. Existing runs never change after edit, copy, rename, archive,
restore, trash, or source-Model mutation.

## Run snapshot and planning

The target start route retains the current API naming:

```text
POST /api/projects/{projectId}/runs
```

Its body contains `commandId`, `experimentConfigId`, and the batch-only optional
`completionConversationId`; it never accepts a Project path, executable,
authoritative digest, expanded sample plan, or output location. A visual start
that supplies `completionConversationId` is rejected with
`visual_completion_not_supported`.

Starting a run is one atomic store operation:

1. verify active same-Project experiment and Project;
2. verify Project snapshot rows/bytes and copied execution-description v2;
3. revalidate configuration against copied schema and declared run capability;
4. expand samples in axis declaration order, then value declaration order, then
   seed order, using explicit `seed: null` for every branch with no seed;
5. construct one canonical
   `samplePayload = {schemaVersion: 1, parameters, seed}` and assign zero-based
   `sampleIndex` plus
   `sampleId = sha256(canonical JSON of samplePayload)`;
6. reject duplicate `sampleId` values;
7. freeze configuration, exact sample plan, limits, Project snapshot digest,
   execution-description digest, and their canonical digests;
8. for batch only, prove any completion conversation belongs to the same
   Project; visual freezes no completion conversation; and
9. insert one `queued` run and its idempotency receipt before notifying the
   dispatcher.

The batch input embeds the exact normalized `parameters` and `seed` from
`samplePayload` byte-for-byte in canonical-JSON meaning; it cannot omit `seed`,
replace `null` with a generated value, or re-normalize parameters differently.
`runId`, `sampleIndex`, and the resulting `sampleId` are added outside the
sample-ID preimage. Run planning, input-file writing, retry, and restart all
recompute through the same canonical serializer.

The experiment ID remains provenance only. Execution never rereads mutable
experiment content. The public overview derives only from frozen or measured
state: status, sample/seed/declared-metric counts, declared step or horizon,
timestamps/duration, bounded resource use, diagnostics, and indexed outputs.
Missing optional declarations display as `not declared`; Riff does not infer
domain meaning from names or contents.

## Run state machine and cancellation precedence

Persisted states are:

```text
queued -> running -> succeeded
       |           -> failed
       |           -> timed_out
       `-----------> cancelled
queued -----------------> cancelled
terminal ---------------> trashed -> restored to exact terminal state
```

Public Stage 3 start creates a contract-version-4 `queued` run. Every
contract-version-3 run is outside this graph regardless of stored status.
`configured` is therefore not a v4 state. Legacy rows follow the read-only
contract above; mutation routes return `legacy_contract_read_only`.

`cancellation_requested` and `cancelling` are not persisted run states. A
cancellation command atomically stores
`cancel_requested_at` and its receipt while the run remains `queued` or
`running`; DTOs project `cancelling`.

Cancellation-versus-terminal races are ordered only by authoritative SQLite
commit order:

- if the cancellation receipt commits first, the dispatcher must not launch an
  unclaimed run and any later zero/nonzero process exit finalizes `cancelled`;
  ordinary outputs are not published as successful results;
- if a terminal transition commits first, that terminal state is immutable and
  a later cancel returns HTTP success with the same state, `applied: false`, and
  code `run_already_terminal`; and
- a retry of either command returns its original receipt. Wall-clock timestamps,
  process-exit observation order, or HTTP response order never reverse the
  committed winner.

The dispatcher sends the declared signal only to the exact recorded process
group, waits the frozen grace period, and then kills only that group if needed.
Enforceable `RunLimitsV1` wall/startup, output, event, stdout/stderr,
concurrency, file-count, or termination violations fail closed with stable
terminal codes. Unsupported CPU, memory, or child-process limit requests are
rejected before queueing, not presented as hard enforcement. Partial scratch
bytes are diagnostics, never ordinary successful outputs.

There is no retry transition on the same run. A user starts a new immutable run
from the saved configuration.

## Batch execution and atomic outputs

The dispatcher claims a queued batch run using compare-and-set, records an
attempt plus dispatcher generation, and executes the frozen plan at bounded
concurrency. Before each launch it inserts a batch `process_attempt` row, allocates an
exact application-owned scratch directory, starts a new process group, and then
records PID plus the OS-derived process-start token. A signal, wait, or cleanup
must match PID, start token, process group, run attempt, sample index, and
dispatcher generation; PID reuse or partial identity fails closed and is
reconciled manually rather than killing an unverified process.

Batch and visual launch use the same platform-owned launch-gate helper. The
helper starts as the new process-group leader but blocks model entry on a
one-use inherited gate descriptor. The parent obtains PID/start token/process
group, commits the `process_attempt` with run/dispatcher generations, then
rechecks that exact OS identity before releasing the gate. If persistence,
identity recheck, or release does not complete within the fixed five-second
registration deadline, the helper exits without invoking model code and records
`process_registration_timeout`. No model code, port bind, or output write may
occur before durable registration.

The child environment is constructed from an allowlist rather than inherited
and contains only the approved runtime path, fixed locale/encoding, assigned
scratch/temp paths, and protocol fields. Home, shell startup, proxy, cloud,
GitHub, OpenCode, API-key/token, credential-helper, SSH, package-registry, and
unrelated application variables are absent. Commands, environments, capability
values, raw secrets, absolute roots, PIDs, and start tokens never enter public
DTOs, completion cards, domain events, or ordinary logs. Diagnostics apply
key-name and registered-secret redaction before bounded persistence, but
redaction is defense in depth rather than permission to pass secrets to the
child.

Every executable, dependency, input, output, and scratch path is derived from
server-owned IDs and normalized relative metadata. Resolution rejects absolute
paths, empty/dot/dot-dot segments, NUL/control characters, alternate separators,
symlink or special-file ancestors, and any real path outside the exact
Project/run root. File creation/ingestion uses no-follow opens where supported,
then requires regular files with `nlink == 1`. Before and after copy it rechecks
the open descriptor's device, inode, link count, owner, type, size, and digest;
any change fails the ingestion. Repeated device/inode identity across owners,
runs, or sample directories is rejected even when relative paths differ, so an
external hardlink or cross-sample inode alias cannot publish twice or bridge an
ownership boundary. The platform never scans an untracked workspace or
caller-supplied directory.

Success requires every sample to exit successfully and every required declared
output to validate. The ingestor rejects symlinks, special files, path escapes,
undeclared files outside the diagnostic policy, media mismatch, digest drift,
duplicate logical names within a sample, duplicate sample identity, and all
count/byte/file limits.

Validated bytes, run-owned file rows, output indexes, optional events, resource
overview, terminal diagnostics, and `succeeded` publish through one recoverable
mixed mutation. Restart cannot expose `succeeded` with missing final bytes or
indexes. Failed, timed-out, or cancelled runs publish no ordinary result as if
complete.

### Completion card exactly once

The optional completion conversation is frozen at run creation after proving
same-Project ownership. The service never guesses the most recent conversation.
For a terminal batch run, it creates at most one platform-authored card with:

```text
cardId = "run_completion_" +
  first32(sha256(canonical JSON of {runId, conversationId}))
```

A unique `(run_id, conversation_id)` constraint and terminal publication receipt
make retries and restart exactly once. The terminal transaction either inserts
that card and records `published`, replays the existing identical card, or
records the terminal skip reason `conversation_unavailable` when the bound
conversation is missing or trashed. A skipped card is never later redirected or
guessed after restore.

The card contains only run ID, terminal status, counts, and output-index links.
It is a platform record, not an assistant message, analysis, or recommendation.
If no conversation was bound, run completion remains fully visible through
Project APIs and records `not_requested`.

## Outputs, downloads, and bounded domain events

This section is the A3-2d contract. A3-2d1 output list/download was merged
through PR #43. A3-2d2 was merged through PR #44 and implements declared
diagnostic-event ingestion and opaque cursor reads. The complete
Agent-independent A3-2d3 direct-control surface was merged through PR #45.
Legacy wind/Gate event and download routes are not A3-2d evidence.

Output listing returns only `id`, `runId`, sample index/ID, logical name,
declared role/type, media type, byte size, SHA-256, and created time. Download
resolves the same-run owned file, rechecks path/size/digest, emits a safe
attachment name, and applies size/range limits. It never accepts a path or media
type from the browser.

List/download/event reads require the exact current single-user app session and
Host, same-origin Fetch Metadata, and current Project/run/output ownership
tuple; this is not a multi-user principal claim, and an ID is never a bearer
credential. List and event-read responses are private,
`no-store`. Mutation routes additionally require exact Origin, CSRF, JSON
non-simple content type, command ID, and current browser-app admission. Cancel
retains its published exact `{commandId}` body. A3-2d3 adds an
`expectedLifecycleDigest` only to trash/restore, and trash requires explicit
confirmation bound to `terminalClosureDigest`. Command retry is idempotent;
changed intent fails.

Download opens the allowlisted output with no symlink following, verifies
same-run manifest identity and succeeded/not-trashed state, and uses that one
open file descriptor for `fstat`, complete SHA-256 verification, rewind, and
streaming. Identity and size are rechecked after hashing and before response
headers. The child cannot select response headers. Responses are attachment-
only with a server-safe name, `X-Content-Type-Options: nosniff`, a safe
allowlisted content type, no-store policy, and response/concurrency/rate
limits. Only one normalized byte range is accepted; malformed or unsatisfiable
ranges return deterministic `416`. The complete digest is verified before the
first response byte, including for a range request.

Optional batch events use bounded NDJSON records:

```json
{"type":"repair_started","occurredAt":"optional exact YYYY-MM-DDTHH:mm:ss.sssZ","payload":{}}
```

Riff assigns authoritative sequence and sample index. It rejects invalid JSON,
oversized/deep records, unbounded strings, and count/byte overflow. When the
execution description declares `payloadSchema`, the same profile validator
checks each payload; without it, Riff applies only structural limits. The
platform does not infer semantic meaning from event type names or payload
shape, guess whether content resembles replay state, or promote model-defined
events into a product schema. The declared role remains `diagnostic`.
Event type, payload, URL-shaped text, instruction-shaped text, and
tool-call-shaped text are untrusted model output. The UI renders them only as
safe text or structured values. Any Agent context uses a separate bounded
diagnostic section; event content cannot authorize a tool, widen scope, select
a target, or become a user instruction.

Listing uses immutable sequence order and a server-authenticated opaque cursor
bound to run ID and normalized filters. Filters are limited to type, sample
index, and bounded occurred-time range. Cross-run, mismatched, or tampered
cursors fail closed. Responses expose `items`, `nextCursor`, and `truncated`,
never file offsets or index paths.

NDJSON is strict UTF-8 with LF-delimited records; empty lines, duplicate JSON
keys, invalid Unicode, unsafe numbers, external schema references, and
noncanonical object/array depth, key count, item count, string length, event
type vocabulary, or UTC `occurredAt` range fail before terminal publication.
Ingestion and the immutable terminal event-set digest/count commit atomically.
Each read revalidates at most the frozen 64 MB/50,000-event set; a dedicated
event-read rate/concurrency gate remains a P2 follow-up and is not claimed by
the d2 candidate.

The cursor is bounded, versioned, expiry-bearing, and MACed with a private
restart-stable installation key using constant-time verification. Its payload
binds route Project ID, run ID, execution contract/schema version, immutable
event-set digest, terminal/trash generation, direction, page limit, and every
normalized filter. Cursor parsing is byte-bounded before decoding. Explicit
key-epoch rotation, expiry, trash, or tuple mismatch invalidates it; ordinary
backend restart does not. The current implementation creates the installation
key directly at its final path with `O_EXCL` and owner-only filesystem
permissions. Atomic publication and concurrent first-start convergence remain
review gaps and are not current claims. The key is excluded from SQLite, public
DTOs, logs, errors, and child-process environments; ordinary backup/export
exclusion remains unverified and is not claimed. A missing or corrupt key after
initialization fails startup and cursor verification closed until an explicit
operator rotation; the service never silently regenerates it.

Cancel is the existing A3-1c-a authority. A3-2d adds no parallel cancel route;
it proves that cancel and the new download/trash/restore controls remain
available without OpenCode. Trash atomically revokes Playwright capabilities,
event cursors, confirmation tokens, active downloads, and dereference
authority for completion links before committing the recoverable state.
Restore returns only the original immutable terminal outputs/events and never
revives an old capability, cursor, confirmation, or download.

For the merged A3-2d3 boundary, all direct run controls
(`POST .../cancel`, `.../trash`, `.../restore`) admit only the current browser
app: exact app `Host` and `Origin`, `Sec-Fetch-Site: same-origin`,
`Sec-Fetch-Mode: cors`, `Sec-Fetch-Dest: empty`, current HttpOnly app cookie,
matching CSRF token, and exact `application/json` framing are required. A
browser `Authorization` header is not an alternative, and the legacy listener
rejects these controls. This is an exact local browser authority boundary, not
a multi-user principal claim.

```ts
type CancelProjectRunRequest = { commandId: string };

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

The implementation persists exact-replay `run.trash.v1` and `run.restore.v1`
receipts. A `terminalClosureDigest` binds immutable terminal evidence and never
changes; `lifecycleDigest` binds current status plus full ordered trash history
and changes on each successful trash/restore. Only terminal v4 runs can be
trashed, and restore returns exactly to the prior terminal status. The
pre-commit revocation covers active output downloads plus current visual
frame/WebSocket and Visual-Agent/Playwright authority; restore restores durable
visibility only and never recreates an old capability, cursor, or download
authority.

## Visual execution and scoped WebSocket access

A visual run has exactly one sample. The supervisor records an attempt, assigns
an unused loopback port, starts the copied entry point, and waits for bounded
health. Wildcard/non-loopback binding, cross-origin redirect, startup timeout,
or premature exit fails the run.

Schema v4 already had the `process_kind`, visual `loopback_port`, `health_at`
shape, and one-live-visual-process index, but that was not complete visual
evidence: `loopback_port` could be updated, and `health_at` lacked a complete
null-to-timestamp single-write/receipt-same-transaction CAS and immutability
rule. Schema v8 does not add those columns again. The implemented migration
extends schema-v6 scratch and launch evidence to visual work and adds triggers
that:

- reject every update of the launch-bound `loopback_port`;
- allow `health_at` to change only once from null to the receipt timestamp for
  the exact visual process in `running`, with matching launch, port, declared
  health path, run/attempt/process identity, and unique health receipt in the
  same transaction; and
- reject every later health update, a `health_at`-only write, a receipt-only
  insert, timestamp mismatch, or second receipt.

The separate immutable health receipt stores no capability, cookie, nonce,
public URL, response body, or other secret. Because public visual dispatch did
not exist before v8, migration cannot infer that a pre-v8 `health_at` or live
visual process is legitimate. Any such unproven health/live evidence fails
migration closed and is never adopted as healthy. Private Store primitives
write the same exact-identity process checkpoints while public visual dispatch
remains closed. Cross-restart recovery now validates those exact checkpoints
before any inspection or signalling; focused tests use a fake supervisor and
start no real visual child or listener. Published A3-2a2b adds the real generic
single-attempt supervisor and process-safety primitives. Published A3-2a2c
integrates that supervisor with the dispatcher and existing Project-run
admission after its scheduling, terminalization, restart-audit, real-process
vertical, and secrecy gates pass.

The visual dispatcher has `maxActiveVisualRuns = 1` and keeps an active
map keyed by exact `(runId, attemptId)`. It does not claim a second queued visual
run while that map occupies the slot, but continues claiming eligible batch
work under the unchanged batch cap. Every lane heartbeat and finalization uses
the same dispatcher generation that claimed the attempt. The visual slot is
released only after exact terminal commit plus verified process and scratch
cleanup. Dispatcher stop aborts every active lane and awaits all lane promises
before it returns or permits Store close. A shared fatal-error latch prevents a
failed lane from being forgotten while its peers unwind. Generation-fenced
unlaunched-scratch cleanup removes only the exact claimed visual manifest. A
healthy visual therefore cannot head-of-line block the batch queue, and
fairness never authorizes duplicate supervision or blind relaunch.

Listener readiness is detected from the exact OS-owned IPv4 listener without
sending HTTP. Once ready, health sends exactly one `GET` to
`http://127.0.0.1:<assigned-port><declared-healthPath>` using manual redirect
handling. Every `3xx`, every status other than `200`, an oversized header or
body, and deadline expiry fail closed. The probe never follows a redirect or
changes method, host, port, or path, and it has no retry. A concurrent or
repeated health invocation cannot send another request or insert another
receipt. Immediately before the request and again
after the complete bounded response, the supervisor proves that the listener
still belongs to the exact recorded child/process group and that no other
listener exists for that identity. Only one same-identity compare-and-set may
insert the immutable health receipt. Listener replacement between either
ownership check and receipt commit produces `visual_listener_invalid`, never a
healthy attempt. The same exact-IPv4/no-other-listener invariant is monitored
while healthy and checked again before termination and cleanup.

After health, the access broker exposes only a server-minted route scoped to
`{projectId, runId, attemptGeneration}`. Backend and broker metadata never
serialize the child port to the browser. Model-authored response bytes are not
treated as a port-confidentiality boundary because the child already knows its
own listener. Active frame HTML/JavaScript is operator-provided, trusted browser
code under the local deployment threat model, not runtime-reviewed content;
arbitrary adversarial active payload requires a trusted
data-only wrapper or browser-inaccessible transport and is outside this
surface. The proxy allows the exact healthy attempt, bounded HTTP, and only the
WebSocket path/subprotocol/limits frozen by execution-description v2. It strips
credentials and set-cookie headers, rejects arbitrary URLs, and applies a
restrictive Content Security Policy. The frame has no ambient top navigation,
popup, parent-origin, or unrestricted download capability.
Visual applications are capability-base compatible and use relative document,
CSS, script, and fetch references; root-absolute application routes are not
rewritten or authorized.

The exact app serves
`GET|HEAD /browser/projects/{projectId}/runs/{runId}/visual`. The fixed
no-store document retains its bootstrap CSRF and broker frame URL only in
closure memory. `GET` admits only a top-level navigation with
`Sec-Fetch-Site: none|same-origin`, `Sec-Fetch-Mode: navigate`, and
`Sec-Fetch-Dest: document`; a hostile local same-site page therefore cannot
use cross-origin top-level navigation to rotate the browser generation.
`HEAD` is side-effect free and does not bootstrap.

Stage 3 first establishes a local browser-session capability through
`POST /api/browser-session/bootstrap` on the platform app origin
`http://localhost:<app-port>`. Both platform app and broker bind exact IPv6
loopback `::1`, on different server-owned ports, and reject any other listener
address or `Host:port`. The bootstrap sets a random host-only HttpOnly,
SameSite=Strict cookie with no `Domain`, `Path=/api/`, and returns a separate
in-memory CSRF token. On current HTTP the cookie may omit `Secure`; under
future HTTPS it must set `Secure`. The server-side browser session lifetime is
15 minutes, and cookie `Max-Age` and `Expires` encode that same lifetime.
This is a single-local-user browser capability, not login, identity, multi-user
authorization, or reuse of the legacy path/default-session mechanism. It is
rotated on backend restart. The endpoint rejects a missing, `null`, or wrong
exact app `Origin`, a wrong app `Host:port`, or any
`Sec-Fetch-Site` other than `same-origin`. A successful new bootstrap increments
the browser-session generation and revokes every older frame/WS capability
before returning HTTP `201`. These Origin and Fetch-Site checks mitigate browser
CSRF; they do not authenticate an arbitrary local native client. The Vite
development origin is not the exact app origin and is rejected.

The browser then calls
`POST /api/projects/{projectId}/runs/{runId}/visual-frame-session` with that
exact app cookie, matching `X-Riff-CSRF`, exact app `Origin`, and
`Sec-Fetch-Site: same-origin`. A wrong value in any field fails. Agent/tool
credentials cannot call either endpoint. Bootstrap and frame-session support
only `POST` and preflight `OPTIONS`; CORS permits only the exact app origin with
credentials, methods `POST, OPTIONS`, and headers
`Content-Type, X-Riff-CSRF`. Both successful POSTs return HTTP `201`. The
response contains one `frameUrl`
on `http://localhost:<broker-port>` with a random single-use nonce. The in-memory
registry binds it to
`{browserSessionGeneration, projectId, runId, attemptGeneration, expiry}` with
expiry no later than 60 seconds after issuance or the attempt expiry, whichever
comes first, and owns the capability's live socket set.

The app and broker are different origins because their server-owned ports
differ, but remain same-site on host `localhost`, so `SameSite=Strict` can be
sent in the iframe. Platform cookies are not isolated from each other by port
and `Path` is not a trusted security boundary. The real host isolation is
between the platform `localhost` cookies and the untrusted visual child at
`127.0.0.1`. Same-numbered IPv4 denial reservations hold the app and broker
ports on `127.0.0.1` for the topology lifetime, preventing a child-side
listener from taking over either `localhost` authority through IPv4 resolution;
platform cookies are never sent to the child.

The first nonce-bearing iframe navigation normally has no `Origin`. It is
authorized only by exact broker `Host:port`, exact nonce path, atomic one-use
nonce consumption, live registry binding, and expiry. It returns HTTP `303`
with a relative nonce-free `Location` while setting a broker HttpOnly,
SameSite=Strict,
host-only cookie with no `Domain`, a random broker-only name independent of the
app cookie, and the exact broker path. The cookie expires at
`min(attempt claimedAt + frozen wallTimeMs, issue time + 15 minutes)`. On
current HTTP it may omit `Secure`;
under future HTTPS it must set `Secure`. After redirect, every request requires
that exact named cookie plus the live attempt/registry binding. The app never
interprets or accepts the broker cookie; the broker ignores every other cookie.
The iframe may use `allow-same-origin` only because the broker is a distinct
origin; it still omits top-navigation, popup, parent-origin, and unrestricted
download permissions. Browser same-origin policy, rather than an opaque origin,
prevents parent DOM access.

`riff-visual-v1` keeps its current execution-description v2 schema. Frame HTTP
is a server-owned surface rather than a new declaration: beneath the
nonce-free minted capability base, only `GET` and `HEAD` are forwarded to the
same normalized suffix on the exact healthy child. Query is allowed, but the
complete normalized path plus query is at most 4,096 bytes, and no request body
is accepted. The child request forwards only `Accept`, `Accept-Language`,
`If-None-Match`, `If-Modified-Since`, and `Range`; the broker sets exact child
`Host` and `Accept-Encoding: identity`. The child response exposes only
`Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`,
`Last-Modified`, and `Cache-Control`. Cookies, authorization/proxy
authorization, `Set-Cookie`, `Location`, `Refresh`, authentication challenge,
CORS, capability/nonce, and hop-by-hop headers are never forwarded.

The proxy follows no redirect and rejects every child `3xx`. Request and
response headers are each limited to 32,768 bytes, response bodies to 8 MiB,
the complete child exchange to 5,000 milliseconds, and one capability to eight
concurrent HTTP requests. Stable results are `browser_method_denied` (`405`),
`browser_session_denied` (`403`), `visual_frame_unavailable` (`409`),
`visual_frame_nonce_invalid` (`404`), `visual_frame_session_denied` (`403`),
`visual_frame_proxy_denied` (`404` or `405`),
`visual_frame_proxy_redirect_denied` (`502`),
`visual_frame_proxy_limit_exceeded` (`502`),
`visual_frame_proxy_timeout` (`504`), and
`visual_frame_proxy_failed` (`502`).

Every broker document response emits CSP
`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none';
form-action 'none'; frame-src 'none'; frame-ancestors
http://localhost:<exact-app-port>` with no wildcard or alternate app origin. It
must not emit any `X-Frame-Options`, which could block the authorized
cross-port frame. Broker documents/assets emit no permissive CORS header.
Fetches require the
broker cookie and live binding. When an HTTP `Origin` header is present it must
equal the exact broker origin; a normal navigation or subresource request
without `Origin` is allowed only with the cookie. WebSocket upgrade always uses
the exact minted URL
`ws://localhost:<broker-port>/frame/c/<route-id><declared-absolute-path>` and
requires exact broker `Host`, exact broker `Origin`, the exact declared path
with no query or encoded alias, an offered subset of unique declared
subprotocols, broker cookie, and live registry binding. Missing, duplicate,
`null`, app-origin, child-origin, or any other WebSocket origin is rejected
before child dial. The child leg is fixed to the recorded
`127.0.0.1:<port><declared-path>`, follows no redirect, selects only a protocol
both offered and declared, negotiates no compression extension, and receives
no raw browser Origin, cookie, authorization, nonce, route, or arbitrary
header. Its fixed handshake receives a server-generated exact broker Origin.
Bootstrap/session POST responses permit
only the exact app origin, credentials, explicit headers/methods, and never
wildcard CORS.

Raw or hashed frame nonces, `frameUrl`, and frame-session cookies are never
stored in SQLite, Agent/context DTOs, conversation messages, analytics, access
logs, completion cards, or error text. Only bounded capability-issued/redeemed/
revoked audit facts without the secret are retained. App, broker, and child
request/response headers plus logs are scanned for all three parties' cookie,
nonce, including expired nonce values, capability, URL, and child-port secrets;
the same values are absent from public DTOs. SQLite contains no browser nonce,
cookie, frame URL, or capability; it retains child ports only in the
schema-defined private process-attempt, launch, and health evidence required
for exact recovery. The authorized bootstrap/frame-session/redeem fields that
necessarily carry their own transient value are explicit scan allowlist
entries, not a false claim that the secret is globally absent. That evidence
cannot restore browser access. Backend restart, expiry, redemption replay,
browser-session generation change, unhealthy attempt, or terminal state
revokes access. Dispatcher cancellation, unhealthy observation, visual
terminalization, recovery, and stop call the idempotent
`revokeVisualAccess(runId)` hook before the corresponding state commit or
process abort. The hook remains callable for later attempts of the same run ID;
the dispatcher never permanently memoizes a revoked run. Revocation starts
closing every pending and registered socket before removing registry authority;
a fresh bootstrap/session request is required.

`maxConnections` counts pending and active sockets for the exact attempt across
all minted routes. The 5,000 millisecond pending child handshake is part of the
bound. `maxFrameBytes` limits each assembled text or binary message and every
fragment in both directions. Per direction, queued backpressure payload is
also capped at `maxFrameBytes`; the source pauses while it drains and overflow
is additionally capped at 16 queued messages; exceeding either ceiling closes
both legs with `1013`. Valid data or control activity resets the idle deadline.
Malformed RFC framing closes `1002`, invalid assembled UTF-8 `1007`, assembled
message overflow `1009`, queued-byte/backpressure overflow `1013`, idle timeout
or absolute capability expiry `1001`, generation/lifecycle revocation and
other application policy loss `1008`, and unexpected post-upgrade upstream
failure `1011`. Pre-upgrade WebSocket results
are frozen as `400/broker_request_failed` for parser-level malformed HTTP,
`400/visual_websocket_protocol_denied` for parsed HTTP with malformed or
duplicate Upgrade/Connection/version/key handshake structure,
`405/visual_websocket_protocol_denied` for a non-GET attempt,
`404/visual_websocket_not_declared`,
`403/visual_frame_session_denied` for missing or invalid broker authority,
`403/visual_websocket_protocol_denied` for offered-subprotocol or declared
WebSocket policy denial,
`429/visual_websocket_limit`,
`502/visual_websocket_upstream_failed`, and
`504/visual_websocket_timeout`; exact topology Host and broker-session failures
retain their existing b1/b2 status and code.

Visual runs remain `running` while healthy. Explicit stop is cancellation.
Timeout/resource breaches use their matching terminal states. Normal exit after
health can become `succeeded` only when the exact recorded child exits with code
zero and every required declared output validates and publishes atomically.
Exit zero alone, a healthy page, or partial/optional output presence is never
success. Stage 3 does not synthesize a report from the page.

Visual completion cards are not part of the product contract. Public visual
start rejects any supplied `completionConversationId` with
`visual_completion_not_supported`. Accepted visual runs freeze a null
completion conversation, retain `completion_card_disposition =
'not_requested'`, and terminalize without inserting a
`run_completion_cards` receipt or conversation message. The Project run API
and Store remain authoritative for visual lifecycle and outputs.

A3-2a2 exposes `runKind: "batch" | "visual"` in the same Project run DTO and
freezes these visual status/code pairs:
`succeeded/visual_run_succeeded`, `failed/visual_process_failed`,
`failed/visual_health_failed`, `failed/visual_listener_invalid`, and
`timed_out/visual_startup_timeout`. Visual work also uses
`timed_out/run_wall_timeout` and the existing `failed` stdout/stderr/output
limit, cleanup, and dispatcher-heartbeat codes. Same-process backend shutdown
produces `failed/dispatcher_shutdown`; cross-restart recovery produces
`failed/runtime_interrupted`; and cancel-first produces
`cancelled/run_cancelled`. Page state, health text, or exit observation cannot
select another status or code.

Every attempt capability and WebSocket closes on stop, unhealthy state,
terminal reconciliation, backend restart, or expiry. Stored child ports never
restore access after restart.

## Playwright inspection contract

Playwright is an internal short-lived Agent capability, not ambient browser
authority. The service derives the current Project from the durable conversation
and accepts only that Project's current healthy visual attempt. It cannot select
another Project, run, port, URL, local service, filesystem path, or product page.
It does not reuse or receive a user's frame URL, nonce, app cookie, or broker
cookie; A3-2c mints a separate internal one-turn capability only after A3-2b is
complete.

The existing `RIFF_CDP_URL`/`PlaywrightCdpProjector` path is legacy UI
projection and is not reusable as A3-2c authority: it can discover an ambient
localhost page and is not bound to the durable conversation, originating turn,
current Project, current run, or current healthy attempt.

A3-2c1, merged through PR #38, stops at authority and audit. It
derives the durable conversation/turn/current-Project scope, requires exactly
one current healthy visual attempt, binds one process-local capability to the
full scope/target/operation tuple and process epoch, returns only an opaque
consumed handle, consumes before revalidation, and revokes on turn release,
dispatcher run revocation, backend close, expiry, and restart. The append-only
audit retains bound IDs, finite lifecycle/operation/action/locator kinds, and
SHA-256 commitments only. It does not retain capability/browser secrets,
locator role/name-or-label, typed value, observation summary/content, DOM, or
screenshot bytes. There is no Playwright runner/transport and no OpenCode
observe/interact tool in A3-2c1 alone. A3-2c2 adds the read-only runner and
`riff_observe_current_visual`; A3-2c3's one-use typed interaction was merged
through PR #41. A3-2c4 supplied the live-CDP isolation evidence and merged
through PR #42.

The c2 runner resolves the sole healthy target internally and carries the full
process identity only across private backend boundaries. Before each exact root
or declared structured-path GET it rechecks the OS listener, then rechecks the
connected peer and reuses that same inspected socket. Network reads have a
fixed total deadline plus header, streaming-body, JSON, text, DOM-node, viewport,
pixel, and screenshot limits; each Playwright step has its own bounded timeout.
Root HTML becomes a fresh JavaScript-disabled snapshot; all
subsequent HTTP and WebSocket requests are denied. Results are schema-versioned
untrusted data, never an instruction, and never persisted in audit content.
Global and per-conversation concurrency is bounded; turn, session, Project,
run, process, expiry, or shutdown drift aborts in-flight observation.

The new runner is structurally separate: its capability issuer, browser
context/profile, page registry, and transport cannot call or attach to the
legacy projector/CDP session even when `RIFF_CDP_URL` is configured. Issuance
derives exactly one healthy attempt; zero or multiple candidates fail closed.
The capability binds
`{conversationId, immutableUserTurnId, projectId, runId, attemptGeneration,
processIdentity, capabilityEpoch, oneAllowedOperation, expiry}`. For an
interaction, `oneAllowedOperation` is a complete normalized action commitment:
action kind, normalized role/name-or-label locator, and a digest commitment of
the bounded input or selection value. Immediately before observation or
interaction, the server re-resolves and compares every field in the complete
tuple and action commitment. Action, locator, or value substitution fails
closed. Project selection change, attempt replacement, unhealthy or terminal
state, turn end, capability epoch rotation, backend restart, or expiry revokes
it.

Read-only observation may capture the declared structured endpoint,
accessibility tree, bounded DOM text, and screenshots. Each observation records
run/attempt identity, timestamp, kind, bounded digest/summary, and originating
turn in a dedicated immutable audit fact. Large observation bytes are not
stored in the audit row; they remain ephemeral or use an explicitly retained
bounded temporary document. The audit is conversation context, never
authoritative Project state.

The complete A3-2c target audit covers mint, atomic consume,
observation/action outcome, bounded failure, and detected crash-gap
reconciliation. A3-2c1 currently records only capability lifecycle,
revocation/failure, and crash-gap facts; observation/action outcomes start with
the runner. Audit stores the bound tuple, finite operation/action/locator kinds,
and digest commitments, never raw locator text, input/selection value,
capability, input secret, observation summary/content, credential-bearing DOM,
or screenshot bytes. Any future retained temporary document remains a c2+
contract and must be owner/turn bound with explicit TTL, media type,
byte/dimension limits, digest, deletion, and restart behavior.
Page content is untrusted observation data and never becomes an instruction;
only the persisted human turn can authorize interaction.

Click, type, or selection requires the optional structured
`visualInteractionConfirmation` accepted on the immutable current human turn,
not a generic `explicitImperative`, Agent text, DOM text, or browser capability.
The immutable message retains only a digest marker; the c3 candidate MCP tool is
`riff_interact_current_visual({})`, so no action, locator, value, target, or
transport is caller supplied. It has a one-turn, one-use capability. Interaction locators use only typed
accessibility role plus bounded accessible name, or a bounded label; CSS,
XPath, text-as-selector, arbitrary JavaScript, and model-supplied URLs are not
accepted. Navigation outside the exact proxy, popup, upload, clipboard,
permission prompts, credentials, and unrestricted downloads are denied.
`drive_workbench_ui` is absent from the Project/A3-2c OpenCode tool schemas and
server dispatch allowlists; dispatch rejects it even when `RIFF_CDP_URL` is
configured and the legacy projector is live. The legacy projector remains only
a platform-internal fixed mirror intent after the matching domain commit.

Capability consumption is an atomic consume-before-side-effect transition.
Success, locator mismatch, policy denial, browser error, timeout, and bounded
failure all consume it; concurrent/retried use admits at most one attempt.
The append-only schema-v11 audit permits only one interaction mint for the
immutable turn and complete action commitment, so process concurrency and
backend restart cannot mint another capability from the same confirmation.
Locator strings are valid UTF-8, NFC-normalized, case-sensitive exact matches
with fixed byte limits; regex, glob, substring matching, and index/`nth`
fallback are forbidden. Click roles are allowlisted to non-navigation controls;
type/select roles and input values have separate role, type, and byte limits.
The locator is re-resolved at action time and must match exactly one visible,
enabled element; zero or multiple matches fail closed. c3 creates a fresh
backend-only profile and can reach the child solely through a private
exact-listener/connected-peer GET/HEAD bridge. It never reuses the A3-2b frame
URL, app/broker cookies, nonce, WebSocket route, or legacy CDP. Its one local
typed interaction returns only a bounded untrusted dispatched receipt; it
neither proxies child HTTP writes nor proves a domain outcome. Navigation,
popup, upload/download, clipboard, permission/credential prompt, Service
Worker, WebSocket, and unlisted network traffic are denied. A3-2c4 supplied the
real-Chromium/live-CDP negative matrix, secret scans, independent review, and
final documentation/security closure. Its merge matrix passes 6/6 through the
published BackendApp turn chain and scans public/MCP/audit/persistence/error/
child evidence.

## Project Agent permission matrix

Authority derives from the durable conversation owner and tool kind, never an
Agent-provided Project or Model ID.

| Capability | Project Agent | Direct control |
| --- | --- | --- |
| Read Project/config/run/output/event summaries | Bounded current Project only | Current Project |
| Create/edit/copy experiment | Explicit imperative plus expected digest | Allow |
| Start/cancel run | Explicit imperative and declared capability | Allow |
| Observe healthy visual attempt | Bounded current run | Embedded frame |
| Interact with healthy visual attempt | Immutable human-turn structured `visualInteractionConfirmation`; one-use capability and empty-input `riff_interact_current_visual` | Human uses the b2 frame; Agent uses a separate private bridge/fresh profile |
| Create/adopt an analysis document | Stage 2 document/action rules | Existing controls when exposed |
| Trash run and its owned output set | Deny; may suggest only | Explicit recoverable action |
| Modify copied Model/schema/dependencies/execution description/snapshot | Deny | Deny |
| Mutate frozen run/output/event/terminal status | Deny | Deny |
| Access another object, path, URL, source tree, shell, SQL, credentials, or child port | Deny | Deny |

Analysis begins only after the user asks. Run completion never automatically
chooses metrics, interprets results, ranks scenarios, or recommends a decision.

## HTTP API target

Existing names remain canonical; implementation must not introduce a parallel
`/experiments` resource. Current comments identify the merged authority;
A3-2d owns only the output/event/direct-control routes still marked target:

```text
POST   /api/projects                                            # current foundation
GET    /api/projects/:projectId/workspace                       # current foundation

POST   /api/projects/:projectId/experiment-configs              # current A3-1a
PATCH  /api/projects/:projectId/experiment-configs/:configId    # current A3-1a

POST   /api/projects/:projectId/runs                 # current A3-1b
GET    /api/projects/:projectId/runs/:runId          # current A3-1b
POST   /api/projects/:projectId/runs/:runId/cancel   # current A3-1c-a
POST   /api/projects/:projectId/runs/:runId/trash    # target A3-2d
POST   /api/projects/:projectId/runs/:runId/restore  # target A3-2d

GET|HEAD /browser/projects/:projectId/runs/:runId/visual           # current A3-2b4
POST   /api/browser-session/bootstrap                              # current A3-2b2
POST   /api/projects/:projectId/runs/:runId/visual-frame-session   # current A3-2b2
GET|HEAD /frame/c/:routeId/<declared-relative-path>                # current A3-2b2
WS     /frame/c/:routeId/<declared-websocket-path>                 # current A3-2b3

GET    /api/projects/:projectId/runs/:runId/outputs                # current A3-2d1
GET|HEAD /api/projects/:projectId/runs/:runId/outputs/:outputId/download # current A3-2d1
GET    /api/projects/:projectId/runs/:runId/diagnostic-events      # current A3-2d2
POST   /api/projects/:projectId/runs/:runId/cancel                 # current A3-2d3 browser admission
POST   /api/projects/:projectId/runs/:runId/trash                  # current A3-2d3
POST   /api/projects/:projectId/runs/:runId/restore                # current A3-2d3
```

The legacy Gate runtime currently occupies the same textual
`/api/projects/:projectId/runs/:runId/events` path for its own object model;
the generic diagnostic stream therefore uses the unambiguous
`/diagnostic-events` suffix.
A3-2d must route current ProductV2 Project/run identities to the ProductV2
handler before any legacy fallback and must return a current-surface
not-found/ownership error rather than silently reading legacy artifacts.
Legacy rows, files, cursors, and projections cannot satisfy the A3-2d route.

The exact current start request is `{commandId, experimentConfigId,
completionConversationId?}`. It returns `201` with
`{schemaVersion: 1, commandId, runId, projectId, experimentConfigId,
completionConversationId: string|null, status: "queued", runKind,
sampleCount, createdAt}`. Same-command replay returns this exact receipt even
after completion. Unknown fields, including caller-supplied limits or paths,
fail with `422 unknown_field`.

The current read response is the exact `ProjectRunDto` documented in
[`backend-api.md`](backend-api.md): identity/ownership, status/timestamps,
contract/read-only fields, `runKind`, cancel/terminal/card dispositions, and
`outputs`. Each output contains only identity, logical/type/role/sample fields,
contract/read-only fields, media type, size, SHA-256, and creation time.
Non-succeeded runs return `outputs: []`.

Create/update/start and later cancel/trash/restore require command or
expected-state keys as appropriate. All nested IDs are checked against the route
Project. Public DTOs omit attempts, commands, environment, paths, child ports,
raw logs, proxy/Playwright capabilities, and OpenCode internals.

Current admission/request codes include `unknown_field`, `invalid_request`,
`resource_not_found`, `state_conflict`, `idempotency_conflict`,
`legacy_contract_read_only`, `execution_protocol_upgrade_required`,
`project_snapshot_corrupt`, `capability_not_declared`,
`capability_not_available`, `events_not_available`,
`invalid_sample_plan`, and `sample_limit_exceeded`. Current batch terminal
codes are `batch_run_succeeded`, `batch_process_failed`,
`run_wall_timeout`, `run_stdout_limit`, `run_stderr_limit`,
`run_output_file_limit`, `run_output_byte_limit`, `run_output_invalid`,
`process_cleanup_unverified`, `dispatcher_shutdown`,
`dispatcher_heartbeat_failed`, `batch_publication_failed`, and the internal
`batch_supervisor_failed`. Cancellation, visual, WebSocket, and event-specific
codes elsewhere in this document remain target contracts until their slices
land.

## Wind Model and example Project manifest

The reviewed `wind-turbine-maintenance` content is installed as ordinary data
through this canonical identity:

```text
manifestId = "preinstalled.wind-turbine-maintenance"
manifestVersion = 1
manifestDigest = sha256(canonical JSON of the manifest excluding manifestDigest)
modelId = manifestStableId("preinstalled_model", {manifestId, manifestVersion})
projectId = manifestStableId("example_project", {manifestId, manifestVersion})
experimentConfigId =
  manifestStableId(
    "example_experiment",
    {manifestId, manifestVersion, name: "baseline"}
  )
```

`manifestStableId(prefix, value)` is installer-specific and means
`prefix + "_" + first32(sha256(canonical JSON of value))`. The checked-in
manifest pins every source path, media type, byte size, file SHA-256, execution
description, dependency input, source commit, baseline configuration, and
explicit non-claim. Its concrete digest is committed next to the implementation
and asserted by tests.

Installation is idempotent by the stable IDs, manifest version, and digest. A
matching installation is verified and returned. An existing same-ID object with
different manifest digest or bytes fails with `preinstalled_manifest_conflict`;
it is never overwritten. A future manifest version produces new stable IDs and
must not mutate Projects copied from an earlier version.

The installer runs the ordinary technical checker, creates the Project through
`createProjectFromModel`, and creates one named synthetic single-seed baseline
experiment. No API type, UI route, Project, run, event, or output schema gains a
wind-specific field or conditional.

The example contains no fabricated conversation, Agent message, analysis,
endorsement, optimum, recommendation, calibration claim, staffing guidance, or
real-wind-farm validity claim. Closed PR #11 remains candidate runtime evidence,
not a product cutover or authority to remove generic Model/Project/OpenCode
capabilities.

## Failure, restart, and cleanup

Current A3-1b same-process shutdown aborts active supervision, terminates the
verified process group, removes only the owned scratch path, and records the run
failed with `dispatcher_shutdown`. A3-1c-b now runs the following
cross-restart reconciliation after Stage 1/2 mutation/action recovery and
before dispatch:

- every contract-version-3 experiment/run/output remains read-only and outside
  dispatch, mutation, template, cleanup, and trash graphs regardless of status;
- uncancelled `queued` runs are claimable again;
- cancelled-intent `queued` runs become `cancelled` without launch;
- `starting` or `running` attempts are never assumed alive after restart;
  each batch or visual process PID/start-token/process-group identity is verified before
  termination, cleanup receipts are persisted, attempts become interrupted, and
  runs finalize `runtime_interrupted`, or `cancelled` when the cancellation
  receipt committed first;
- visual capabilities are revoked rather than restored from child ports;
- committed ingestion receipts roll forward and verify every byte/index/status;
  uncommitted manifests roll back without exposing partial success; and
- scratch directories are deleted only when exact application-owned
  run/attempt identities are terminal and their paths pass ownership checks.

The launch order is durable manifest, exact scratch creation/registration,
detached child spawn, child-authored fsynced receipt, Store process registration,
then one-use gate release. Crashes before directory creation close only an
absent planned path. A created directory without a receipt cannot exclude spawn
and therefore fails closed. A durable receipt not yet adopted by the Store may
be adopted and reconciled. Recovery actions are replayable while `started`,
including after the next process mints a different candidate generation, and a
second dispatcher generation cannot activate until all prior v4 live attempts
are terminal with verified cleanup.

Untracked, legacy, Model, Project, and `.riff-workspace` directories are never
scanned as disposable scratch. Contradictory receipts, ownership drift, future
schema versions, digest mismatch, invalid JSON, partial timestamps, or ambiguous
attempts fail startup closed with repairable diagnostics.

Trash preview lists the exact Project/run/output closure before deletion.
Output indexes never resolve outside the owning Project/run object root.

## Implementation slices and review gates

1. **Foundation — implemented before A3-1a:** fixed-copy Project API/workspace
   projection. This is not run evidence.
2. **A3-1a frozen planning — implemented:** execution contract v4,
   public experiment create/update with configuration/record digest CAS and
   exact replay, canonical schema validator and sample planner, execution-v2
   admission, and an atomic frozen queued-run receipt.
3. **A3-1b generic batch runtime — implemented:** execution-v2 batch-only
   scaffold, public start/read, durable dispatcher, real generic batch
   subprocesses, currently supported hard limits, same-process shutdown
   cleanup, and atomic successful output publication. Visual and
   `domainEvents` are explicit rejections.
4. **A3-1c batch lifecycle — implemented through A3-1c-c:** A3-1c-a implements public user
   cancellation with committed race receipts and same-process queued/running
   enforcement. A3-1c-b implements v4 cross-restart attempt/process/scratch
   recovery. A3-1c-c implements exactly-once terminal batch completion cards and
   startup reconciliation.
5. **A3-2a1 visual runtime contract — merged and published in PR #28:**
   schema v8 migration and rollback, loopback-port immutability, atomic one-time
   `health_at` plus health receipt, fail-closed pre-v8 visual evidence, stable
   public rejection, and private exact-identity Store process checkpoints are
   implemented.
   Cross-restart visual reconciliation is implemented and its focused
   fake-supervisor suite passes 29/29 without a real child or listener.
   Production `GenericBatchSupervisor` reads the exact durable visual launch
   receipt, and coordinated health-receipt/manifest corruption fails before
   process inspection or signalling. Focused root 62/62, independent reviewer
   81/81, independent recovery review, full backend, and web/build gates pass.
   At this published A3-2a1 gate, public visual starts rejected
   with `capability_not_available`, or
   `visual_completion_not_supported` when a completion conversation was
   supplied; this slice has no real-process or browser acceptance claim.
6. **A3-2a2a schema-v9/Store visual authority — merged and published in PR
   #29:** merge commit `1584e39` binds atomic success/output publication to
   `runId` plus `runKind`, preserves batch semantics, closes visual completion
   state in the database, and adds private claim, queued-cancel, terminal, and
   atomic success/output Store authority.
7. **A3-2a2b generic single-attempt visual supervisor — merged and published
   through PR #30:** merge commit `9f23f61`; a real `riff-visual-v1` child proves the canonical
   single-sample input,
   assigned output directory/loopback endpoint, visual-only sandbox, exact
   process and listener ownership before/after bounded health, one-shot health,
   stable failure codes, output validation, and exact process/scratch cleanup.
   Its publication gate reported 378 passed/0 failed/1 optional skip out of
   379; the focused concurrency combination passed 102/102 three consecutive
   times; web was 104/104 and its production build succeeded. This slice has no dispatcher,
   public admission/API, broker, frame, WebSocket, Playwright, or browser claim.
   Public visual remains HTTP `409` `capability_not_available`, and the
   completion negative gate is unchanged.
8. **A3-2a2c dispatcher and public admission — merged and published through
   PR #31 at merge commit `361b36f`:** one shared generation owns independent
   batch and one-slot visual lanes, with exact heartbeat/cancel/finalize identity, a fatal-error latch,
   stop join, and generation-fenced unlaunched-scratch cleanup. Startup audits
   exact visual success evidence. The existing Project-run route now admits
   eligible visual work; a real-process public vertical and child-port secrecy
   gate pass. The final full backend gate reports 384 passed/0 failed/1
   optional skip out of 385; the focused 13/13 gate covers the review
   regressions; web is 104/104 and its production build succeeds. Visual
   completion remains HTTP `422`
   `visual_completion_not_supported`.
9. **A3-2b1 network topology — merged and published through PR #33:** the backend
   production entrypoint exact-binds the platform technical origin and an empty
   broker to separate IPv6-loopback ports, enforces exact Host, serializes
   start/close, and preserves the child IPv4-only listener boundary.
10. **A3-2b2 frame bootstrap and HTTP proxy — merged and published through
    PR #35:** scoped broker/frame capability, exact broker
   path, browser-session generation, bootstrap/CSRF/nonce/cookie/Origin rules,
   HTTP forwarding, and exact CSP.
11. **A3-2b3 WebSocket, revocation, and secrecy — merged and published through
   PR #36 at `bb54b2a`:** exact
   minted broker URL/path/subprotocol enforcement, assembled-message,
   connection/handshake/idle/backpressure limits, socket-first generation and
   lifecycle revocation through `revokeVisualAccess(runId)`, stable
   pre-upgrade status/codes and RFC close codes, and allowlist-aware
   three-party observable/persisted secret scans.
12. **A3-2b4 browser and security closeout — merged and published through
   PR #37:** real-browser negative
   isolation matrix covers the browser cookie jar, HttpOnly, browser-generated
   WebSocket Origin/cookie delivery, iframe-relative WebSocket, CSP/sandbox/
   hostile embedding, Service Worker denial, no-store revocation, and
   page-observed live revocation/reconnect denial. The dedicated matrix passes
   5/5 and the complete Chromium suite passes 8/8. The current backend gate
   reports 466 total with 465 passed, zero failed, and one optional
   installed-OpenCode smoke skipped; web passes 104/104, network entry 1/1,
   and the production build succeeds. This is a Chromium-only claim.
13. **A3-2c Playwright authority — in progress:** c1's backend-private
   scope/capability/audit/revocation and legacy-CDP isolation was merged through
   PR #38. c2 adds the bounded Project-only read-observation tool and keeps
   process/browser authority private. c3's one-use typed interaction was merged
   through PR #41. c4 live-CDP/real-Chromium security and docs closeout was
   merged through PR #42.
14. **A3-2d generic outputs/events/direct controls — merged through d3:**
   d1's exact
   same-run output list/download with byte/digest revalidation was merged
   through PR #43. D2's bounded declared diagnostic-event ingestion,
   schema-v12 atomic publication, and opaque run/filter-bound cursors were
   merged through PR #44. Agent-independent cancel/download/trash/restore
   acceptance was merged through PR #45. Cancel is
   already current and download was merged in d1; d3 adds trash/restore routes
   and proves the complete direct-control set without OpenCode.
15. **A3-2d4 cross-authority revocation — merged through PR #46:** one
   fault-injected production API/revocation-wiring flow revokes an unredeemed
   nonce, redeemed frame, open WebSocket, and Visual-Agent capability; restore
   cannot revive them. Focused backend passes 65/65 and dedicated broker
   Chromium passes 6/6.
16. **A3-3 wind import — implemented on the current review branch:** schema-v13
   immutable versioned manifest, ordinary technical check, fixed-copy example
   Project and single-seed Experiment, exact deterministic baseline evidence,
   and explicit non-claim labels. The installation uses ordinary platform
   contracts and has no wind-specific route, DTO, or dispatcher branch.
17. **Integration — pending:** complete the Stage 3 browser flow, cross-slice
   verification and narrow browser evidence, then PR merge, Issue #14 closure,
   and local `main` synchronization.

No slice may use a healthy port, fixture-only run, mock Agent, file presence, or
the historical wind-specific UI as proof of the full contract. Stage 4 / #15
does not begin until Stage 3 is merged and accepted.

## Verification and acceptance matrix

The final integrated A3-1b full backend run passed 256 tests with zero failures
and one optional installed-OpenCode smoke skipped. The historical A3-1c-c
branch had a full backend result of 295 tests: 294 passed, zero failed, and one
optional smoke skipped. Its focused
evidence covers schema-v6 migration/rollback, the foundation/schema/experiment
rows, the batch portion of exact input freezing, v3 read-only behavior, public
start/read, real generic batch launch/claim/process identity, supported hard
batch limits, atomic successful outputs, negative visual/event admission, and
same-process shutdown cleanup, A3-1c-a cancellation precedence/receipts, and
A3-1c-b restart windows including missing evidence, recovery replay,
generation handoff, and leader-gone descendant cleanup, plus A3-1c-c
completion-card status/disposition, fault, restart, schema, context, and
deletion-closure tests.

The published A3-2a1 gate reported 314 backend tests: 313 passed, zero failed, and
one optional installed-OpenCode smoke skipped. Focused root tests pass 62/62,
the independent reviewer set passes 81/81, independent recovery review is
PASS, web tests pass 104/104, and the production build succeeds. Recovery
evidence includes production `GenericBatchSupervisor` durable visual-receipt
parsing and coordinated corruption that fails before process inspection or
signalling. No real visual child or listener is started, and later visual,
Playwright, wind, download, event, and browser rows remain unclaimed.

A3-2a2a is published through PR #29 at merge commit `1584e39`. A3-2a2b is
published through PR #30 at merge commit `9f23f61`. A3-2a2c is published
through PR #31 at merge commit `361b36f` and integrates
the supervisor into one shared-generation dispatcher with independent
batch/visual lanes, exact heartbeat/cancel/finalize authority, fatal latch,
stop join, generation-fenced unlaunched-scratch cleanup, and exact visual
success restart audit. The existing Project-run route admits visual work, and
the real-process public vertical plus port/secret scans pass. Its final full
backend gate reports 385 tests with 384 passed, zero failed, and one
optional installed-OpenCode smoke skipped; the focused 13/13 gate covers the
review regressions; web is 104/104 and the production build succeeds. Visual
completion remains HTTP `422`
`visual_completion_not_supported`; A3-2b broker/frame/WebSocket/browser,
A3-2c Playwright and A3-2d1 through A3-2d4 are published. A3-3 wind import is
implemented on the current review branch; final Stage 3 integration remains
pending.

The matrix below remains the complete Stage 3 exit target; a row is not marked
implemented merely because part of it is exercised by A3-1b:

| Contract | Required evidence |
| --- | --- |
| Current foundation | Store/API tests prove Project fixed-copy creation, source-edit isolation, workspace secrecy, bounded experiment persistence, command replay, and changed-intent rejection. |
| Project immutability | Database trigger and launch tests reject execution-description/snapshot-row mutation, source-path following, missing bytes, and digest drift. |
| One schema validator | Technical check, save, and run-start fixtures prove the same profile/digest, defaults, local refs, additional-properties, numeric, format rejection, no-coercion, and stable errors; unsupported dialect keywords fail. |
| Canonical experiments | Tests cover single, multiple-seed, and Cartesian forms; exact counts; `seed: null`; duplicate seeds/values; overlapping pointers; safe integers; stale digest; copy/edit/restart. |
| Run freezes exact input | Edit experiment and source Model after queueing; configuration/sample-plan/snapshot/execution digests and sample order remain identical through restart, and input `parameters`/`seed` equal the sample-ID preimage. |
| Cancellation precedence | Controlled transaction races prove cancel-first becomes cancelled, terminal-first remains terminal, retries replay receipts, and wall-clock order is irrelevant. |
| Legacy v3 boundary | Migration rollback tests cover invalid JSON/ownership/count; every old experiment/run/output status projects read-only v3 DTOs; all mutations fail; only a deterministic explicit copy creates a new v4 ID/digest. |
| Dispatcher/process identity | Two live dispatchers plus restart/lease/PID-reuse tests prove one claim generation, unified batch/visual process attempts, and a launch gate that persists and rechecks PID/start-token/process-group before model code runs. |
| Batch runtime | A real generic subprocess proves success and bounded concurrency; tests cover partial-sample failure, missing/extra/path/symlink/media/digest/size failures, hard `RunLimitsV1`, unsupported CPU/memory/process limits, and restart. |
| Path and secret safety | Counterexamples cover absolute/traversal/control/separator/symlink/special paths, external hardlinks, cross-owner/cross-sample inode aliases, `nlink` or device/inode replacement before/after copy, untracked roots, inherited secret/proxy/home variables, secret-shaped output, and omission of commands/environment/process identity from DTOs/logs. |
| State and trash safety | Property/table tests reject every illegal transition, stale dispatcher generation, every mutation/dispatch of all-status v3 records, and trash/restore of every nonterminal or cancelling v4 run. |
| Exactly-once batch card | Fault injection before/after a batch terminal commit proves one deterministic card or one durable skip receipt, never a guessed or duplicate message. Visual terminalization has no card receipt. |
| Outputs/events | Ownership, sample identity, digest revalidation, atomic ingestion, opaque cursor binding, pagination, filters, limits, trash, and cross-run/tamper failures. |
| Visual runtime contract | Schema-v8 migration/rollback and restart tests extend schema-v6 scratch/launch/recovery to the existing schema-v4 visual process shape, make its launch-bound port immutable, and require one atomic null-to-timestamp `health_at` plus matching immutable receipt. Schema v9 replaces batch-only success/output triggers with run-kind-bound atomic authority, rejects visual completion state, and requires exact healthy exit-zero cleanup evidence for private visual success/output publication. A3-2a2b adds the private generic single-attempt supervisor and process-safety primitives; A3-2a2c adds shared-generation dispatch and existing-Project-run visual admission. Port update, health-only, receipt-only, timestamp mismatch, second write/receipt, unproven pre-v8 visual health/live evidence, wrong run-kind context, extra live attempt/process, and partial output publication fail closed. Visual completion still returns 422. |
| Visual lifecycle | A real child receives the canonical single-sample `--riff-input`, assigned `--riff-output-dir`, fixed loopback host and assigned port. A visual-only sandbox denies other listeners and all outbound/direct network access; exact listener ownership surrounds one bounded manual-redirect health GET and one CAS receipt. The one-slot visual cap leaves a second visual queued while batch finishes, and stop joins every lane. Stable success/failure/timeout/cancel/restart codes are exact. Exit zero succeeds only after required outputs validate. Visual completion input is rejected and no completion-card receipt/message is created. |
| Visual frame capability | A real browser proves platform app/broker exact-bind `::1` on different server-owned ports while the child remains `127.0.0.1`; platform cookies cross app/broker ports but never reach the child. Evidence includes actual SameSite=Strict broker-cookie delivery, JavaScript denial from HttpOnly, cross-origin parent-DOM denial, exact bootstrap/frame-session Origin/Host/Fetch-Site/CSRF rules, ≤60-second no-Origin one-use nonce navigation and invalidation, post-redirect HTTP and strict WS Origin rules, exact-app-only CSP `frame-ancestors` with no blocking SAMEORIGIN header, generation/Project/run/attempt/expiry/socket binding, socket-first revocation, and three-party secret scans. Port and Cookie Path are not treated as Cookie authority. |
| Visual/WebSocket | Real process proves loopback health, hidden port, CSP/frame restrictions, exact path/subprotocol, frame/connection/idle limits, redirect denial, stop/timeout/restart, and capability revocation. |
| Playwright authority | Current-run observation is bounded/audited; interaction requires an explicit turn; cross-Project/run/URL, script, upload, clipboard, and expired-capability cases fail. |
| Direct controls | With OpenCode unavailable, saved configurations/runs remain readable and direct start/cancel/download/trash/restore work without canned Agent output. |
| Scaffold and wind manifests | Fixtures pin concrete execution-v2/wind IDs and digests; unproven v1 Models require re-scaffold; wind reinstall is idempotent, same-ID conflict fails, and the fixed-copy synthetic baseline retains explicit non-claims. |
| Trust copy | DTO/browser copy forbids scientific validity, calibration, automatic analysis, optimum, staffing recommendation, endorsement, or decision-trust claims. |

Focused store, schema, validator, planner, API, permission, supervisor, ingestion,
proxy, Playwright, installer, Mesa-baseline, and web tests are required. Mocks
cover fault branches only. Batch acceptance requires a real generic subprocess;
visual acceptance requires a real local visual process. Final Stage 3 acceptance
requires a browser flow that creates a Project, edits an experiment, starts and
cancels or completes a run, downloads an indexed output, and survives backend
restart. It does not claim the final Stage 4 shared-shell story.

## Documentation synchronization checklist

Each implementation slice updates, in the same change as behavior:

- this design and `docs/README.md` with implemented status and deviations;
- `backend-api.md` with actual routes, DTO allowlists, idempotency, stable
  errors, and secrecy rules;
- `architecture.md` with ProductStoreV2, dispatcher, supervisors, ingestor, and
  visual-access boundaries;
- `opencode-bridge.md` with Project tool and Playwright permissions;
- `ui-workflow.md` with only the narrow Stage 3 acceptance surface and the
  Stage 4 reservation;
- `test-plan.md` with focused/full/fault/process/API/browser evidence while
  keeping mock and live claims separate;
- `mesa-service.md` and wind records with the generic execution protocol,
  manifest source, baseline, and synthetic/non-claim boundary; and
- root `README.md` and `product-roadmap.md` with exact completion and remaining
  #15 scope.

Documentation must not imply that Projects follow source Models, Project Agents
may edit copied Model content, raw output bytes are authoritative without
indexes/digests, batch runs provide replay or automatic analysis, visual DOM is
durable state, PR #11's wind-only cutover is current authority, or Stage 4 has
already shipped.
