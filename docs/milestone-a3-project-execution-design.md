# Milestone A3 project execution design

Status: active Stage 3 contract for Issue #14. The first foundation slice
implemented fixed-copy Project creation and the Project workspace projection.
A3-1a adds execution contract v4, the closed canonical input-schema profile, deterministic
experiment/sample planning, configuration-and-record digest compare-and-set
with immutable historical command receipts, execution-description-v2
admission, and atomic creation/replay of a frozen `queued` run/start receipt.
A3-1b adds the public run start/read routes, durable dispatch, a real generic
batch process per sample, hard enforcement of the currently supported
server-owned limits, and atomic successful output publication. The official
generic scaffold now emits execution-description v2 and declares batch only;
existing v1 Models are not silently upgraded.

Visual starts and batch `domainEvents` are explicit current rejections.
A3-1c-a adds schema migration v5, the strict public cancel command/receipt, queued no-launch and
running abort behavior, public `cancelling` projection, and SQLite commit-order
precedence against every terminal transition. A3-1c-b adds schema migration v6,
durable pre-spawn scratch and launch evidence, exact v4
attempt/process/scratch reconciliation, and recovery-before-generation
activation. A3-1c-c adds schema migration v7, exactly-once deterministic
platform completion cards, permanent skip dispositions, and startup
reconciliation/audit of terminal pending rows.
Visual execution,
Playwright access, and ordinary wind import remain later Stage 3 slices. This
document therefore does not claim that Stage 3 is complete.

This document is subordinate to the
[Milestone A product contract](milestone-a-product-contract.md), builds on the
implemented [Stage 1 data foundation](milestone-a1-data-foundation-design.md),
and preserves the
[Stage 2 Agent and Model workspace](milestone-a2-agent-workspace-design.md)
authority. It does not define or claim the final Stage 4 shared product shell.

## Current implementation boundary

The implemented A3-1a/A3-1b/A3-1c-a/A3-1c-b/A3-1c-c boundary is intentionally narrow:

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
- schema migration v7 publishes one deterministic platform completion card, or
  one permanent skip disposition, in the terminal run transaction and audits
  or reconciles terminal pending rows before dispatcher activation; and
- Project conversations continue to use the Stage 2 conversation contract.

The product database is schema migration v7 while the current execution
contract remains v4. Version-3 experiment/run/output rows remain
readable but cannot be mutated or dispatched. `estimatedSampleCount` is retained
only as a compatibility projection; v4 authority is `sampleCount` plus the
canonical configuration and sample-plan digests. The generic scaffold is now
execution-description v2 and batch-only; v1 Models require an explicit reviewed
re-scaffold/upgrade path.

The following are not implemented by the current boundary and must not be
inferred from workspace DTOs or schema-v4 tables:

- batch domain-event ingestion or public output list/download routes;
- a scoped visual proxy, WebSocket forwarding, or Playwright capability; and
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
Visual starts fail with
`capability_not_available`, and batch descriptions that declare
`domainEvents` fail with `domain_events_not_supported`.

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
| `completion_cards` or equivalent receipt | Enforce one platform completion card per `(run_id, conversation_id)` and record `published` or a terminal skip reason. |

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
`--riff-host 127.0.0.1` and `--riff-port`. Health must succeed at the exact
declared same-origin path within the startup deadline.

WebSocket forwarding is denied unless the `webSocket` object exists. Its path
must be one exact absolute same-origin path. `subprotocols` contains zero to
eight unique tokens; a client offering an undeclared protocol is rejected, and
an empty list permits only a connection without a subprotocol. Values are frozen
with the run and must satisfy server ceilings:

- `maxFrameBytes`: 1 through 1,048,576 bytes;
- `maxConnections`: 1 through 8 concurrent connections for the attempt; and
- `idleTimeoutMs`: 1,000 through 300,000 milliseconds.

The proxy counts inbound and outbound frames, closes an oversized frame with
code `1009`, closes policy violations with `1008`, denies connection number
`maxConnections + 1`, and expires idle connections and all attempt capabilities
at terminal reconciliation. It never forwards cookies, authorization headers,
compression extensions, arbitrary paths, or cross-origin redirects. Stable
admission/proxy errors include `visual_websocket_not_declared`,
`visual_websocket_protocol_denied`, and `visual_websocket_limit`.

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
`maxEventCount: 10000`, `maxEventBytes: 16000000`,
`maxSamples: 1000`, and `maxConcurrency: 4`. They are backend authority and
cannot be overridden by the public start request.

| Field | Scope, clock, aggregation, and terminal code |
| --- | --- |
| `wallTimeMs` | One run-attempt budget starting at committed dispatcher claim and ending at terminal commit. All batch samples share the remaining clock; visual startup and serving consume the same budget. Expiry terminates every verified process group with `run_wall_timeout`. |
| `startupTimeMs` | Visual-only clock from launch-gate release until the declared health probe first succeeds. It is inside `wallTimeMs`; expiry is `visual_startup_timeout`. Process durable-registration uses the separate fixed launch-gate deadline. |
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

`startupTimeMs`, `maxEventCount`, and `maxEventBytes` are frozen reserved fields
in A3-1b, not current enforcement claims: visual starts fail with
`capability_not_available`, and batch `domainEvents` fail with
`domain_events_not_supported`.

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

Its body contains `commandId`, `experimentConfigId`, and optional
`completionConversationId`; it never accepts a Project path, executable,
authoritative digest, expanded sample plan, or output location.

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
8. prove any completion conversation belongs to the same Project; and
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

Output listing returns only `id`, `runId`, sample index/ID, logical name,
declared role/type, media type, byte size, SHA-256, and created time. Download
resolves the same-run owned file, rechecks path/size/digest, emits a safe
attachment name, and applies size/range limits. It never accepts a path or media
type from the browser.

Optional batch events use bounded NDJSON records:

```json
{"type":"repair_started","occurredAt":"optional ISO-8601","payload":{}}
```

Riff assigns authoritative sequence and sample index. It rejects invalid JSON,
oversized/deep records, unbounded strings, and count/byte overflow. When the
execution description declares `payloadSchema`, the same profile validator
checks each payload; without it, Riff applies only structural limits. The
platform does not infer semantic meaning from event type names or payload
shape, guess whether content resembles replay state, or promote model-defined
events into a product schema. The declared role remains `diagnostic`.

Listing uses immutable sequence order and a server-authenticated opaque cursor
bound to run ID and normalized filters. Filters are limited to type, sample
index, and bounded occurred-time range. Cross-run, mismatched, or tampered
cursors fail closed. Responses expose `items`, `nextCursor`, and `truncated`,
never file offsets or index paths.

## Visual execution and scoped WebSocket access

A visual run has exactly one sample. The supervisor records an attempt, assigns
an unused loopback port, starts the copied entry point, and waits for bounded
health. Wildcard/non-loopback binding, cross-origin redirect, startup timeout,
or premature exit fails the run.

After health, the access broker exposes only a server-minted route scoped to
`{projectId, runId, attemptGeneration}`. The browser never receives the child
port. The proxy allows the exact healthy attempt, bounded HTTP, and only the
WebSocket path/subprotocol/limits frozen by execution-description v2. It strips
credentials and set-cookie headers, rejects arbitrary URLs, and applies a
restrictive Content Security Policy. The frame has no ambient top navigation,
popup, parent-origin, or unrestricted download capability.

Stage 3 first establishes a local browser-session capability through
`POST /api/browser-session/bootstrap` on the app origin. It sets a random
HttpOnly, SameSite=Strict cookie and returns a separate in-memory CSRF token.
This is a single-local-user browser capability, not login, identity, multi-user
authorization, or reuse of the legacy path/default-session mechanism. It is
rotated on backend restart and scoped only to the app origin.

The browser then calls
`POST /api/projects/{projectId}/runs/{runId}/visual-frame-session` with that
cookie, exact app `Origin`, `Sec-Fetch-Site: same-origin`, and matching
`X-Riff-CSRF`. Agent/tool credentials cannot call either endpoint. The response
contains one `frameUrl` on a dedicated loopback visual-broker origin, with a
random single-use nonce bound in memory to the browser session, Project, run,
attempt generation, and expiry of at most 60 seconds.

First navigation atomically consumes the nonce and redirects to a nonce-free
broker path while setting a broker-origin HttpOnly, Secure when HTTPS,
SameSite=Strict, path-scoped frame cookie. The cookie expires no later than the
attempt or 15 minutes and is checked against the live attempt on every request.
The iframe may use `allow-same-origin` only because the broker is a distinct
origin; it still omits top-navigation, popup, parent-origin, and unrestricted
download permissions. Browser same-origin policy, rather than an opaque origin,
prevents parent DOM access.

Broker documents/assets emit no permissive CORS header. Fetches require the
exact visual-broker `Origin` when present plus the broker cookie. WebSocket
upgrade requires that exact Origin, declared path/subprotocol, and broker
cookie. `null`, app-origin, child-port, cross-site, and missing WebSocket origins
are rejected. Bootstrap/session POST responses permit only the exact app origin,
credentials, explicit headers/methods, and never wildcard CORS.

Raw or hashed frame nonces, `frameUrl`, and frame-session cookies are never
stored in SQLite, Agent/context DTOs, conversation messages, analytics, access
logs, completion cards, or error text. Only bounded capability-issued/redeemed/
revoked audit facts without the secret are retained. Backend restart, expiry,
redemption replay, user-session change, unhealthy attempt, or terminal state
revokes access; a fresh authenticated request is required.

Visual runs remain `running` while healthy. Explicit stop is cancellation.
Timeout/resource breaches use their matching terminal states. Normal exit after
health becomes `succeeded` only when required outputs validate. Stage 3 does not
synthesize a report from the page.

Every attempt capability and WebSocket closes on stop, unhealthy state,
terminal reconciliation, backend restart, or expiry. Stored child ports never
restore access after restart.

## Playwright inspection contract

Playwright is an internal short-lived Agent capability, not ambient browser
authority. The service derives the current Project from the durable conversation
and accepts only that Project's current healthy visual attempt. It cannot select
another Project, run, port, URL, local service, filesystem path, or product page.

Read-only observation may capture the declared structured endpoint,
accessibility tree, bounded DOM text, and screenshots. Each observation records
run/attempt identity, timestamp, kind, bounded digest/summary, and originating
turn. It is conversation context, never authoritative Project state.

Click, type, or selection requires an explicit current-turn instruction and a
one-turn capability. Navigation outside the exact proxy, upload, clipboard,
permission prompts, arbitrary script evaluation, credentials, and unrestricted
downloads are denied.

## Project Agent permission matrix

Authority derives from the durable conversation owner and tool kind, never an
Agent-provided Project or Model ID.

| Capability | Project Agent | Direct control |
| --- | --- | --- |
| Read Project/config/run/output/event summaries | Bounded current Project only | Current Project |
| Create/edit/copy experiment | Explicit imperative plus expected digest | Allow |
| Start/cancel run | Explicit imperative and declared capability | Allow |
| Observe healthy visual attempt | Bounded current run | Embedded frame |
| Interact with healthy visual attempt | Explicit current-turn one-use capability | User interacts in frame |
| Create/adopt an analysis document | Stage 2 document/action rules | Existing controls when exposed |
| Trash run/output | Deny; may suggest only | Explicit recoverable action |
| Modify copied Model/schema/dependencies/execution description/snapshot | Deny | Deny |
| Mutate frozen run/output/event/terminal status | Deny | Deny |
| Access another object, path, URL, source tree, shell, SQL, credentials, or child port | Deny | Deny |

Analysis begins only after the user asks. Run completion never automatically
chooses metrics, interprets results, ranks scenarios, or recommends a decision.

## HTTP API target

Existing names remain canonical; implementation must not introduce a parallel
`/experiments` resource. A3-1b implements the two run routes marked current;
the remaining run-control/output/event/visual routes stay target-only:

```text
POST   /api/projects
GET    /api/projects/:projectId/workspace

POST   /api/projects/:projectId/experiment-configs
PATCH  /api/projects/:projectId/experiment-configs/:configId

POST   /api/projects/:projectId/runs                 # current A3-1b
GET    /api/projects/:projectId/runs/:runId          # current A3-1b
POST   /api/projects/:projectId/runs/:runId/cancel   # current A3-1c-a
POST   /api/projects/:projectId/runs/:runId/trash    # target
POST   /api/projects/:projectId/runs/:runId/restore  # target

POST   /api/browser-session/bootstrap                              # target
GET    /api/projects/:projectId/runs/:runId/outputs                # target
GET    /api/projects/:projectId/runs/:runId/outputs/:outputId/download
GET    /api/projects/:projectId/runs/:runId/events                 # target
POST   /api/projects/:projectId/runs/:runId/visual-frame-session   # target
GET|WS /api/projects/:projectId/runs/:runId/visual/<server-scoped-path>
```

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
`capability_not_available`, `domain_events_not_supported`,
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
   recovery. A3-1c-c implements exactly-once terminal completion cards and
   startup reconciliation.
5. **Visual runtime — pending:** real local visual process, health, scoped proxy/frame and
   WebSocket limits, cancellation, recovery, and Playwright audit.
6. **Wind import — pending:** versioned manifest, normal technical check, example Project
   and experiment, baseline equivalence, and non-claim labels.
7. **Integration — pending:** focused/full suites, independent contract/security review,
   narrow Stage 3 browser evidence, documentation sync, PR merge, Issue #14
   closure, and local `main` synchronization.

No slice may use a healthy port, fixture-only run, mock Agent, file presence, or
the historical wind-specific UI as proof of the full contract. Stage 4 / #15
does not begin until Stage 3 is merged and accepted.

## Verification and acceptance matrix

The final integrated A3-1b full backend run passed 256 tests with zero failures
and one optional installed-OpenCode smoke skipped. Current A3-1c-c focused
work has a full backend result of 295 tests: 294 passed, zero failed, and one
optional smoke skipped. Its focused
evidence covers schema-v6 migration/rollback, the foundation/schema/experiment
rows, the batch portion of exact input freezing, v3 read-only behavior, public
start/read, real generic batch launch/claim/process identity, supported hard
batch limits, atomic successful outputs, negative visual/event admission, and
same-process shutdown cleanup, A3-1c-a cancellation precedence/receipts, and
A3-1c-b restart windows including missing evidence, recovery replay,
generation handoff, and leader-gone descendant cleanup, plus A3-1c-c
completion-card status/disposition, fault, restart, schema, context, and
deletion-closure tests. It does not cover the later visual, Playwright, wind,
download, event, and browser rows.

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
| Exactly-once card | Fault injection before/after terminal commit proves one deterministic card or one durable skip receipt, never a guessed or duplicate message. |
| Outputs/events | Ownership, sample identity, digest revalidation, atomic ingestion, opaque cursor binding, pagination, filters, limits, trash, and cross-run/tamper failures. |
| Visual frame capability | A real browser proves isolated broker origin, local bootstrap cookie/CSRF gating, exact fetch/WS Origin and CORS rules, one-use URL, nonce-free redirect, HttpOnly broker cookie, attempt/session/expiry binding, parent DOM isolation, replay/restart revocation, and absence from persistence/DTOs/logs. |
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
