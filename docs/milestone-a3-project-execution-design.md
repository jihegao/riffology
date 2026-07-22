# Milestone A3 project and execution design

Status: Stage 3 design draft for Issue #14. This document is subordinate to
the [Milestone A product contract](milestone-a-product-contract.md), builds on
the [Stage 1 data foundation](milestone-a1-data-foundation-design.md), and
preserves the [Stage 2 Agent and Model workspace](milestone-a2-agent-workspace-design.md)
authority. It defines Project creation, experiments, generic execution, and the
ordinary wind import. It does not define the final product shell.

## Outcome and stage boundary

Stage 3 makes a Project executable without making the wind case a product
mode. A user can create a Project from one technically executable Model, edit or
copy named experiment configurations, and start visual or batch runs through
the capabilities frozen into that Project. Direct controls continue to work
when OpenCode is unavailable. The existing reviewed wind model is installed
through the same Model contract and copied into one ordinary example Project.

Stage 3 includes:

- the public New project service over `createProjectFromModel`;
- Project-scoped Agent permissions and direct Project controls;
- directly editable and copyable experiment configurations;
- exact run configuration and sample-plan snapshots;
- generic batch and visual launch, cancellation, timeout, resource, diagnostic,
  output-index, and restart behavior;
- optional bounded, filterable domain events;
- user-authorized Playwright observation and interaction with the current
  Project's current visual run; and
- idempotent installation of the reviewed wind Model and an example Project.

Stage 3 does not include:

- the Models/Projects home, polished shared two-pane shell, dynamic document
  workspace, recovery UX, or the complete wind browser story owned by Stage 4
  / #15;
- a second non-wind acceptance Model;
- source-Model switching, a Model or experiment revision browser, immutable
  experiment revisions, activation, publishing, attestation, workflow policy,
  or recommendation gates;
- per-frame simulation state, replay manifests, replay timelines, automatic
  analysis, metric selection, optimization, or recommendations;
- removal of the legacy queue/Gate product, old workspaces, or untracked files;
- Linux support, cloud execution, multi-user authorization, or hostile-code
  containment.

Stage 4 may change presentation but must not redefine the Project copy,
experiment, run, output, event, capability, or wind-import contracts below.

## Authority and trust boundaries

SQLite remains authoritative for identity, ownership, lifecycle, experiment
content, run state, run snapshots, cancellation intent, output indexes, and
bounded event indexes. Object bytes are authoritative only when their owning
row, relative path, byte length, and SHA-256 digest agree. A Project's copied
execution description and `model_snapshot_digest` bind the exact executable
input to every later run.

Runtime processes, local ports, health probes, proxy responses, iframe DOM,
screenshots, accessibility trees, Playwright observations, logs, and Agent prose
are projections or bounded evidence. They cannot mutate Project state without a
typed, authorized command and cannot turn a failed run into a success.

The platform owns orchestration, limits, run status, output ingestion, and the
status overview. Model code owns simulation semantics and declared output
content. Passing Stage 2 technical checks or completing a run proves only the
declared technical protocol. It does not prove scientific validity,
calibration, safety, fitness for a decision, or a recommendation.

All execution uses the existing local-user macOS boundary: an application-owned
working directory, scrubbed environment, no network by default, an allowlisted
runtime executable, finite wall/CPU/process/file/output limits, and explicit
cancellation. This is not container- or VM-grade isolation from malicious code.

## Components and dependency direction

```text
HTTP / scoped Project tools / direct controls
  -> ProjectExecutionService
       -> ProductStoreV2 (authoritative records and mixed mutations)
       -> ExperimentConfigurationValidator
       -> RunPlanner (canonical frozen snapshot and deterministic samples)
       -> RunDispatcher (durable queue and recovery)
            -> BatchRunSupervisor -> RestrictedProcess
            -> VisualRunSupervisor -> RestrictedProcess + loopback proxy
       -> RunArtifactIngestor (declared outputs and bounded events)
       -> VisualAccessBroker (iframe and Playwright capabilities)

PreinstalledModelInstaller
  -> reviewed source manifest
  -> ProductStoreV2 create Model / technical check / fixed-copy Project primitive
```

No runtime component writes SQLite directly or places final bytes directly in
an object directory. It returns bounded observations to the execution service;
the store and `MutationCoordinator` publish authoritative records and bytes.
The legacy Mesa/Gate stores are not adapters for the new domain.

## Schema v4 and repository contract

Stage 3 adds an ordered v3-to-v4 migration to the existing ProductStoreV2
database. It follows the Stage 1 transaction, version-marker, integrity-check,
and fail-closed rules. It does not create a parallel Project database.

The migration retains the existing `projects`, `experiment_configurations`,
`runs`, `object_files`, and `output_indexes` identities and ownership rules. It
adds the minimum execution state needed below:

| Record | Stage 3 additions or rules |
| --- | --- |
| `projects` | Existing source lineage, copied execution description, snapshot rows, and aggregate digest remain immutable. Schema v4 rejects updates to `model_snapshot_digest` or `execution_description_json`, and rejects metadata/owner changes to Project snapshot file rows. |
| `experiment_configurations` | Add a canonical configuration digest. `configuration_json` remains directly editable; name and content changes update the same row using compare-and-set on its prior digest. |
| `runs` | Add `run_kind`, optional same-Project completion-card conversation, copied execution-description digest, copied model-snapshot digest, frozen-configuration digest, exact sample-plan JSON/digest, seed/metric/step-or-horizon overview, cancel-request timestamp, bounded terminal code/diagnostics, and resource overview. Existing timestamps become governed by the Stage 3 state machine. |
| `run_attempts` | One application-owned launch generation per dispatch attempt, with bounded state, claimed time, process identity token, loopback endpoint only for visual attempts, heartbeat, and terminal time. Raw commands, credentials, arbitrary environment values, and reusable access tokens are never stored. |
| `domain_events` | Optional append-only `(run_id, sequence)` records with sample index, event time when supplied, bounded type, canonical payload JSON, payload byte count, and creation time. They are diagnostic events, not frame snapshots. |
| `output_indexes` | Add frozen `sample_index` and digest-derived `sample_id` to the existing logical-name/run-owned-file binding. Publication is terminal/mixed-mutation safe and unique on `(run_id, sample_index, logical_name)`. |

Schema v4 integrity checks require:

- a run's experiment and Project to match;
- a run's optional completion-card conversation to belong to the same Project;
- run kind to be `batch` or `visual` and permitted by the Project's copied
  execution description;
- requested sample count to equal the exact frozen sample plan length;
- visual runs to contain exactly one sample;
- snapshot, configuration, execution-description, and sample-plan digests to be
  lowercase SHA-256 values over canonical JSON or the Stage 1 snapshot file
  projection;
- attempt generations to increase within one run and at most one attempt to be
  nonterminal;
- event sequences to be positive, unique, monotonic within one run, and below
  the configured run count/byte limits; and
- output files to be `run_file` rows owned by the same run.

Database triggers reject direct updates to a Project's copied execution
description or snapshot digest, and reject updates to the owner, kind, relative
path, media type, size, or SHA-256 metadata of a
`project_model_snapshot` file. Launch also verifies the rows and bytes against
the aggregate digest; a drifted copy returns `project_snapshot_corrupt` before
any process starts.

ProductStoreV2 gains typed methods to list/read Projects and their snapshot
metadata; create Projects; list/create/update/copy experiments; atomically
freeze and queue runs; claim queued work; request cancellation; publish bounded
heartbeats; finalize attempts and runs; atomically ingest outputs/events; and
list/download/trash the resulting resources. Methods receive caller intent and
expected digests, not source paths, process commands, output metadata, or
precomputed authoritative digests.

Every public mutation uses a request/idempotency key. Project creation retains
the stable Stage 1 transaction identity. Run creation maps one request key to
one run and frozen snapshot; retry after response loss returns the same run.
Cancel is idempotent. Experiment update and copy reject stale source/config
digests rather than silently applying to newer content.

## Fixed-copy Project creation

`POST /api/projects` accepts only a bounded non-empty `name` and `modelId`.
The backend mints the Project ID and timestamp. It resolves the source Model and
calls the Stage 1 `createProjectFromModel` primitive; the browser and Agent
cannot supply copied files, execution descriptions, digests, source paths, or a
different technical status.

Creation requires the source Model to be active and technically executable
under the execution-description protocol supported by Stage 3. In one
recoverable mixed mutation the store rechecks the Model state and complete
eligible-file set, copies code/environment/visual/adopted-reference bytes into
`objects/projects/<project-id>/model-snapshot/`, stores Project-owned snapshot
rows, copies the execution description, and publishes the aggregate digest.

A later Model edit, recheck, archive, trash, dependency rebuild, or installer
update cannot change an existing Project. Runtime resolution starts only from
Project-owned rows and paths and verifies the complete aggregate digest before
launch. It never follows `source_model_id` to execute bytes. Trashing a source
Model does not trash a Project; permanent purge remains blocked or explicitly
previewed by the Stage 1 lineage rule.

Project creation does not fabricate a conversation or require a provider
selection. A named Project conversation is created separately through the
Stage 2 conversation API when the user chooses a provider/model.

## Execution-description protocol

Stage 3 defines execution-description schema version 2. It preserves the
generic `runtime`, `runMode`, dependency file, input JSON Schema, output
declarations, cancellation policy, and optional visual declaration, and makes
the runtime interfaces explicit:

```ts
type ExecutionDescriptionV2 = {
  schemaVersion: 2;
  runtime: "python";
  runMode: "batch" | "visual" | "both";
  dependencyFile: string;
  inputs: { schema: JsonSchema; smoke: JsonObject };
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
    domainEvents?: { relativePath: string; mediaType: "application/x-ndjson" };
  };
  visual?: {
    entryPoint: string;
    protocol: "riff-visual-v1";
    healthPath: string;
    structuredInspectionPath?: string;
    webSocket: boolean;
  };
  cancellation: { signal: "SIGTERM"; graceMs: number };
};
```

For `riff-batch-v1`, Riff launches one bounded process per sample with
`--riff-input <absolute-run-scratch-file>` and
`--riff-output-dir <absolute-run-scratch-directory>`. The input file contains
only `{schemaVersion, runId, sampleIndex, sampleId, parameters, seed}`. The
`sampleId` is a digest-derived stable identity for the frozen sample. Model code must
write declared outputs below its assigned sample directory and may write the
declared NDJSON event file. It receives no object-store root or SQLite path.

For `riff-visual-v1`, Riff supplies an unused loopback port and launches the
declared entry point with `--riff-input`, `--riff-output-dir`,
`--riff-host 127.0.0.1`, and `--riff-port`. Health must become successful at the
declared same-origin path within the startup deadline. A model may expose a
read-only structured inspection path; it is optional and cannot mutate Riff
state.

The Model's `runMode` and the presence of matching `batch`/`visual` sections
must agree. Generic Model creation and technical checking move to v2 before a
Model may create a Stage 3 Project. A schema-v1 Model is never guessed into the
new protocol. Exact recognized server-owned scaffolds may be upgraded by an
idempotent manifest migration; every other v1 Model returns to `draft` with an
explicit `execution_protocol_upgrade_required` status until its owner updates
and rechecks it. Existing Project copies remain immutable and do not become
executable merely because their source Model is upgraded.

## Experiment configuration contract

An experiment configuration is a named, mutable Project record, not a revision.
Its canonical envelope is:

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

`parameters` must validate against the input JSON Schema copied into the
Project execution description. Sweep pointers are unique normalized JSON
Pointers into existing or schema-allowed parameter fields. Each value is
validated after application to a complete parameter object. Empty axes,
duplicate seeds, non-finite numbers, unsafe integers, unsupported JSON values,
unknown keys forbidden by the schema, and combinations above the configured
sample limit are rejected.

Sample count is exact, not an estimate derived by the browser:

- `single`: one sample;
- `multiple-seeds`: the number of distinct seeds;
- `cartesian-sweep`: the product of axis cardinalities multiplied by the number
  of seeds, or by one when seeds are omitted.

The backend computes and stores `estimated_sample_count` using checked safe
integer arithmetic. Visual configurations require `single` and therefore one
sample. Batch configurations permit all three forms. The browser may display
the count before save using the same shared validator, but the server result is
authoritative.

Edit changes the existing row and has no revision history. Copy creates a new
row with a new ID/name and identical configuration at the source digest the
caller observed. Existing runs retain their snapshots after either operation.
Rename, archive, restore, trash, and permanent-delete preview follow the Stage
1 lifecycle; a run is a blocker for purging its source experiment rather than a
child silently deleted with it.

## Run snapshot and planning

Starting a run is one atomic store operation. It:

1. verifies the Project and experiment are active and same-owner;
2. verifies the Project snapshot rows/bytes against
   `model_snapshot_digest` and validates the copied v2 execution description;
3. revalidates the configuration against the copied input schema and declared
   capability;
4. expands samples deterministically in axis declaration order, value order,
   then seed order, assigning zero-based sample indexes and digest-derived
   sample identities;
5. freezes the exact configuration, exact expanded sample plan, Project
   snapshot digest, execution-description digest, and all canonical digests;
6. binds the optional completion-card conversation after proving it belongs to
   the same Project, then inserts one `queued` run and its idempotency receipt;
   and
7. notifies the dispatcher only after commit.

The frozen run does not reference mutable experiment content for execution.
The experiment ID remains provenance only. A later experiment edit, Project
rename, source-Model change, or installer update cannot change the plan.

The platform overview derives only from frozen or measured state: status,
sample count, seed count, declared metric count, declared step/time-horizon
value when mapped, timestamps/duration, bounded resource use, diagnostics, and
output files. Missing optional declarations display as `not declared`; Riff
does not infer domain meaning from field names or output contents.

## Common run lifecycle

Persisted run states remain:

```text
configured -> queued -> running -> succeeded
                       |          -> failed
                       |          -> timed_out
                       `----------> cancelled
queued --------------------------------> cancelled
terminal ------------------------------> trashed -> restored to exact terminal state
```

Stage 3 creates runs directly as `queued`; `configured` remains readable for
Stage 1 compatibility but is not emitted by the public start route. There is no
retry transition on the same run. A user starts a new run from the same saved
configuration, producing a new immutable snapshot.

A cancellation command atomically sets `cancel_requested_at`. While stored
status remains `queued` or `running`, the DTO projects `cancelling`. The
dispatcher prevents an unclaimed queued run from launching, or sends the
declared signal to the exact process group, waits the bounded grace period, and
then kills only that recorded group if needed. Final state becomes `cancelled`
with bounded diagnostics. Repeated cancellation returns the same state.

Timeout, output, event, log, process, memory, CPU, or file-count violations fail
closed with a stable terminal code. Partial scratch bytes are diagnostics, not
outputs. They are either discarded by exact application-owned paths or ingested
only under explicitly declared diagnostic limits; required-output absence can
never produce `succeeded`.

The Agent may start or cancel a run only from an explicit imperative and the
same Project conversation. Direct start/cancel/download/trash controls do not
depend on an Agent session. No Agent may autonomously trash results; it may only
suggest cleanup.

## Batch execution lifecycle

The dispatcher claims a queued batch run using compare-and-set and records a
new attempt generation before launch. It executes the frozen sample plan with a
configured bounded concurrency. Each sample receives its own scratch directory
and process boundary. Sample identity, seed, resource result, exit status, and
bounded diagnostics are collected without exposing commands or paths publicly.

Batch success requires every requested sample to finish successfully and every
required declared output to validate. The ingestor rejects symlinks, special
files, path escapes, undeclared files unless classified under a bounded
diagnostic policy, media-type mismatch, digest drift during ingestion, duplicate
logical names within one sample, and any count/byte limit breach. The output
index records the frozen sample index and sample ID, so the same declared
logical name can appear once per sample without filename conventions or
model-generated qualification.

Validated output bytes, run-owned `object_files`, `output_indexes`, optional
events, resource overview, terminal diagnostics, and the `succeeded` transition
publish through one recoverable mixed mutation. Thus restart cannot expose a
successful run with missing indexes or final files. A failed, timed-out, or
cancelled run publishes no ordinary result as if it were complete.

On terminal batch completion the conversation service adds a platform-authored
completion card to the exact same-Project conversation frozen on the run, when
one was supplied and remains non-trashed. Agent starts bind their current
conversation; direct controls may bind the Project conversation currently open
in the UI or omit it. The card contains the run ID, status, counts, and output-
index links only; it is not an assistant message, analysis, or recommendation.
If no conversation was bound, run completion remains fully visible through
Project APIs. The service never guesses from "most recent" activity.

## Visual execution lifecycle

A visual run always has one sample. The visual supervisor allocates an unused
loopback port, records an attempt, starts the declared process, and waits for
bounded health. The child must bind only to `127.0.0.1`; wildcard or non-loopback
binding, redirect outside the run proxy, health timeout, or premature exit
fails the run.

After health succeeds, the access broker exposes only a server-minted route
scoped to `{projectId, runId, attemptGeneration}`. The browser never receives
the child port. The proxy allows the exact healthy attempt, bounded HTTP and
only the WebSocket traffic explicitly declared by the visual protocol, strips credentials and
set-cookie headers, rejects cross-origin redirects and arbitrary URL fetching,
and applies a restrictive Content Security Policy. The frame is sandboxed
without ambient top-navigation, popups, downloads outside the run download
route, or access to the parent origin. Any capability expires when that exact
attempt stops or becomes unhealthy.

Visual runs remain `running` while the page is available. Explicit stop is
implemented as cancellation; timeout and resource violations use their matching
terminal states. Normal model exit after successful health becomes `succeeded`
only when all required declared outputs validate; otherwise it is `failed`.
Stage 3 does not synthesize a result report from the page.

### Playwright boundary

Playwright access is an internal, short-lived capability, not a generic browser
endpoint. The service derives the current Project from the durable conversation
and accepts only the Project's current healthy visual attempt. It cannot select
another Project, run, port, URL, local service, filesystem path, or product page.

Read-only observation may capture the embedded page's structured inspection
endpoint, accessibility tree, bounded DOM text, and screenshots. Each
observation records run/attempt identity, timestamp, observation kind, bounded
digest/summary, and originating turn. It is context, never authoritative state.

Clicks, typing, selection, or other interaction require an explicit user
instruction in the current turn. The scoped action record stores the normalized
intent and bounded result. Navigation outside the exact run proxy, file upload,
clipboard access, permission prompts, downloads, arbitrary script evaluation,
and credential access are denied. Observation never implies interaction
permission, and an interaction capability is revoked after the one turn.

## Outputs, downloads, and bounded domain events

Output listing is platform-owned and returns only allowlisted metadata:
`id`, `runId`, logical name, declared role/type, media type, byte size, SHA-256,
and created time. Download resolves the row and same-run owned file, rechecks
path/size/digest, sets a safe attachment name, and streams with size and range
limits. It never accepts a path or arbitrary media type from the browser.

Domain events are optional. A batch Model may emit canonical NDJSON records:

```json
{"type":"repair_started","occurredAt":"optional ISO-8601","payload":{}}
```

Riff assigns the authoritative run sequence and sample index during ingestion.
It rejects per-frame/state-snapshot event types or payloads declared as replay,
oversized records, excessive nesting, invalid JSON, unbounded strings, and total
count/byte overflow. Event payloads are model-defined diagnostic data and are
not trusted commands or product schemas.

Listing uses immutable keyset order `(sequence)` with a server-authenticated
opaque cursor bound to run ID and the normalized filters. Filters are limited
to event type, sample index, and bounded occurred-time range. Cursor mismatch,
tampering, or using a cursor against another run fails closed. Responses expose
`items`, `nextCursor`, and `truncated`; they do not expose filesystem offsets or
raw index paths.

## Project Agent permission matrix

Stage 3 extends the Stage 2 owner-scoped tools. Authority is derived from the
durable conversation owner and the tool kind, never an Agent-provided Project
or Model ID.

| Capability | Project Agent | Direct control |
| --- | --- | --- |
| Read Project summary/documents/configurations/run overviews | Allow current Project, bounded | Allow current Project |
| Read bounded indexed outputs/events for requested analysis | Allow current Project/run | Allow current Project/run |
| Create/edit/copy/rename/archive/restore experiment | Allow only explicit imperative and expected digest | Allow |
| Start a saved configuration | Allow only explicit imperative and supported declared capability | Allow |
| Cancel a current run | Allow only explicit imperative | Allow |
| Observe current healthy visual run | Allow bounded current-run context | Allow through embedded frame |
| Interact with current healthy visual run | Allow only explicit current-turn instruction and one-turn capability | User interacts directly in frame |
| Create/adopt analysis or other Project document | Stage 2 document/action rules apply | Existing document controls when exposed later |
| Trash run/output or perform cleanup | Deny; may suggest only | Allow explicit recoverable trash |
| Modify copied Model code, input/output schema, execution description, dependencies, or visual assets | Deny | Deny |
| Change source Model, snapshot digest/files, run frozen snapshot, output/event records, or terminal status | Deny | Deny |
| Access another object, arbitrary path/URL, product source, shell, SQL, credentials, or child port | Deny | Deny |

Analysis begins only after the user asks. The Agent may read bounded output/event
content and create a temporary or adopted analysis document, but the run itself
does not automatically choose metrics, interpret results, rank scenarios, or
recommend a decision.

## HTTP API boundary

Stage 3 adds backend-owned routes with allowlisted DTOs:

```text
GET    /api/models?technicalStatus=executable
POST   /api/projects
GET    /api/projects/:projectId
GET    /api/projects/:projectId/snapshot

GET    /api/projects/:projectId/experiments
POST   /api/projects/:projectId/experiments
PATCH  /api/projects/:projectId/experiments/:experimentId
POST   /api/projects/:projectId/experiments/:experimentId/copies

GET    /api/projects/:projectId/runs
POST   /api/projects/:projectId/experiments/:experimentId/runs
GET    /api/projects/:projectId/runs/:runId
POST   /api/projects/:projectId/runs/:runId/cancel
POST   /api/projects/:projectId/runs/:runId/trash
POST   /api/projects/:projectId/runs/:runId/restore

GET    /api/projects/:projectId/runs/:runId/outputs
GET    /api/projects/:projectId/runs/:runId/outputs/:outputId/download
GET    /api/projects/:projectId/runs/:runId/events?cursor=&limit=&type=&sample=

GET|WS /api/projects/:projectId/runs/:runId/visual/<server-scoped-path>
```

Create/update/start/cancel/copy/trash/restore routes require an idempotency or
expected-state key as appropriate. All nested IDs are checked against the route
Project even when globally unique. Bodies, JSON depth, names, lists, samples,
logs, output downloads, and event pages are bounded. Errors use stable codes
such as `model_not_executable`, `execution_protocol_upgrade_required`,
`capability_not_declared`, `stale_configuration`, `invalid_sample_plan`,
`sample_limit_exceeded`, `run_not_cancellable`, `run_timeout`,
`run_resource_limit`, `run_output_invalid`, and `visual_unavailable`.

The visual proxy is a projection route, not a public arbitrary reverse proxy.
The browser cannot mint its capability or supply a target URL. Internal worker,
attempt, process, scratch-path, child-port, raw-log, and Playwright capability
records are omitted from public DTOs.

## Wind Model and example Project import

The reviewed `wind-turbine-maintenance` code, declared schemas, defaults,
traceability, synthetic source mapping, visual assets, and relevant tests are
copied into a Model installation manifest. The manifest pins every source path,
media type, byte size, SHA-256, execution description, dependency input, source
commit, and explicit non-claims. Installation uses generic Model/store methods;
no Project, experiment, run, output, event, API DTO, or UI type gains a wind
field or a conditional on the wind Model ID.

The installer is idempotent by manifest version and content digest. It creates
or verifies one ordinary preinstalled Model, runs the normal technical checker,
then uses `createProjectFromModel` to create one ordinary example Project. The
example receives one named batch experiment using the reviewed synthetic,
single-seed baseline. It contains no fabricated conversation, Agent message,
analysis document, endorsement, optimum, recommendation, or claim of real-wind-
farm calibration.

If an installed object with the same stable ID and matching manifest exists,
the installer verifies and returns it. A same-ID content mismatch fails closed;
it is never overwritten. A future manifest version may install a new Model ID
or require an explicit migration, but must not mutate Projects already copied
from an older installation.

Closed PR #11 is evidence and a source of candidate runtime fixes, not a product
cutover to inherit. Stage 3 re-evaluates narrowly applicable changes such as
bounded supervisor startup/shutdown, health timing, signal handling, relative
local-stack configuration, and wind worker reliability against this generic
contract. It does not inherit PR #11's retirement of generic Model, Project,
OpenCode, Agent, or shared-shell capabilities; its retirement auditor and
wind-only product routing remain outside Stage 3.

## Failure, migration, and restart recovery

Startup completes Stage 1/2 mixed-mutation and action recovery before run
dispatch begins, then performs schema-v4 checks and reconciles execution state:

- `configured` runs remain inert and readable;
- `queued` runs without cancellation intent are safely claimable again;
- `queued` runs with cancellation intent become `cancelled` without launch;
- an attempt left `starting` or `running` cannot be assumed alive after backend
  restart; the supervisor terminates only an exactly verified recorded process
  identity when still present, marks the attempt interrupted, and finalizes the
  run `failed` with `runtime_interrupted`;
- an interrupted run with prior cancellation intent becomes `cancelled`, not
  failed, after exact process cleanup;
- a visual proxy/capability is never restored from a stored child port; the run
  is reconciled terminal and a new run is required;
- a committed output-ingestion receipt rolls forward and verifies all final
  bytes/indexes/status; an uncommitted manifest rolls back, leaving no partial
  successful run; and
- stale scratch directories are removed only when their application-owned run
  and attempt identities are terminal and their exact paths pass ownership
  checks. Untracked or legacy workspace directories are never scanned as
  disposable run scratch.

Schema migration validates all existing experiment/run JSON before advancing.
Invalid rows, future schema versions, ownership drift, digest mismatch, partial
timestamps, ambiguous attempts, or file corruption fail startup closed with a
repairable diagnostic; they are not silently normalized.

Execution-description v1 migration follows the explicit policy above: only an
exact recognized server-owned scaffold is eligible for automatic upgrade.
User-authored Models and existing Project snapshots are not rewritten. Legacy
Gate/queue data remains separate and readable by its existing code until the
authorized Stage 4 cleanup; it is not bulk-imported into ProductStoreV2.

## Implementation slices and review gates

Implementation proceeds in reviewable slices:

1. **Design and schema v4:** migration, integrity constraints, typed records,
   canonical experiment validator, and run planner; no process launch.
2. **Project/experiment API:** expose the fixed-copy primitive, Project DTOs,
   direct edit/copy, scoped Agent tools, and counterexample permissions.
3. **Batch runtime:** durable queue, sample execution, cancellation/limits,
   atomic outputs/events, overview, recovery, and completion cards.
4. **Visual runtime:** health, scoped proxy/frame, cancellation/limits, and
   Playwright observation/interaction audit.
5. **Wind import:** manifest, normal technical check, example Project and
   configuration, baseline equivalence, and non-claim labels.
6. **Integration and documentation:** focused/full suites, independent contract
   and security review, API/browser evidence appropriate to Stage 3, and sync of
   active documentation.

No slice may introduce a wind-specific product type or use a healthy port,
fixture-only run, mock Agent, or file presence as proof of the complete
contract. Stage 4 does not begin until Stage 3 design, implementation, tests,
independent review, draft PR, final review, merge, Issue #14 closure, and local
`main` synchronization are complete.

## Verification and acceptance matrix

| Contract | Required evidence |
| --- | --- |
| Project is one fixed Model copy | API/store test creates from only name/model, records the complete copied file set and execution description, then proves later source edits/checks/trash cannot change Project bytes or digests. |
| Runtime never follows source Model | Delete/rename/edit counterexamples plus launch inspection prove every resolved executable path belongs to the Project snapshot. |
| Project Agent cannot mutate Model content | Scoped-tool/API tests deny code, input/output schema, dependencies, execution description, visuals, snapshot, source Model, and cross-owner access. |
| Experiment edit/copy is direct and safe | Create/edit/copy/CAS/restart tests prove no revision browser, exact sample count, schema validation, stale rejection, lifecycle, and run blockers. |
| Run freezes exact input | Edit the experiment and source Model after queueing; the run retains identical frozen configuration/sample plan/snapshot/execution digests through restart. |
| Batch forms are correct | Single, multiple-seed, and Cartesian-sweep tests prove deterministic ordering/counts, seeds, safe-integer limits, invalid axes, cancellation, timeout, and partial-sample failure. |
| Capabilities are enforced | `visual`, `batch`, and `both` Models accept only declared routes; missing/mismatched sections and visual sweeps fail closed. |
| Outputs are authoritative and restart-safe | Required/optional outputs, duplicate/path/symlink/media/size failures, digest drift, atomic ingestion fault points, download revalidation, and output indexes are tested. |
| Events are bounded diagnostics | Valid filtered keyset pages pass; cross-run/tampered cursors, invalid JSON, oversized/deep payloads, total limits, and replay/frame-shaped events fail. |
| Visual isolation is scoped | Real local visual process proves loopback binding, health, restricted iframe/proxy, WebSocket scope, stop, timeout, resource limits, cross-origin redirect denial, and capability revocation. |
| Playwright follows user authority | Current-run observation is bounded/audited; interaction requires an explicit turn; cross-Project/run/URL, arbitrary script, upload, clipboard, and expired-capability counterexamples fail. |
| Direct controls survive Agent outage | With OpenCode unavailable, saved configurations and runs remain readable and direct start/cancel/download/trash/restore work without canned Agent output. |
| Recovery is deterministic | Restart/fault injection covers queued claims, interrupted batch/visual attempts, cancellation races, output transaction boundaries, exact cleanup, and preservation of unrelated untracked files. |
| Wind is ordinary data | Installer is idempotent, generic APIs/types contain no wind identifiers, example Project is a fixed copy, and the reviewed synthetic single-seed baseline executes with explicit non-claims. |
| Trust labels remain narrow | DTO/browser copy says technical execution only and forbids calibration, real-farm validity, automatic analysis, optimum, staffing recommendation, endorsement, or scientific-trust claims. |

Focused ProductStoreV2, schema, validator, planner, permission, supervisor,
ingestion, proxy, Playwright-boundary, installer, Mesa baseline, API, and web
tests are required. Full backend, web, and relevant Mesa suites must pass. A
real batch subprocess and a real local visual process are required; mocks prove
fault branches only. Browser review in Stage 3 may use a narrow Project/run
acceptance surface and does not claim the final Stage 4 shared-shell story.

## Documentation synchronization checklist

The Stage 3 implementation PR must update, in the same change as behavior:

- this design and [`docs/README.md`](README.md) with implemented status and any
  approved deviations;
- [`backend-api.md`](backend-api.md) with actual Project/experiment/run/output/
  event/proxy routes, DTO allowlists, idempotency, error, and secrecy rules;
- [`architecture.md`](architecture.md) with ProductStoreV2, dispatcher,
  supervisors, artifact ingestor, and visual-access boundaries;
- [`opencode-bridge.md`](opencode-bridge.md) with the extended Project tool and
  Playwright capability matrix;
- [`ui-workflow.md`](ui-workflow.md) with only the narrow Stage 3 acceptance
  surface and the final-shell reservation for #15;
- [`test-plan.md`](test-plan.md) with focused, full-suite, fault-injection,
  process, API, and browser evidence, keeping mock and live claims separate;
- [`mesa-service.md`](mesa-service.md) and the wind records with the generic
  execution protocol, manifest source, baseline, and synthetic/non-claim
  boundary; and
- root [`README.md`](../README.md) and
  [`product-roadmap.md`](product-roadmap.md) with #14 completion, remaining #15
  scope, supported platform, and exact run/trust limitations.

Documentation must remove or label stale statements that imply Projects follow
source Models, Project Agents may edit copied model content, output files are
authoritative without indexes/digests, batch runs provide replay or automatic
analysis, visual DOM is durable state, PR #11's wind-only cutover is current
authority, or Stage 4 has already shipped.
