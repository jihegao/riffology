# Milestone A3 project execution design

Status: proposed Stage 3 contract after A2 acceptance. This document is
subordinate to the [Milestone A product contract](milestone-a-product-contract.md)
and depends on the implemented Stage 1 data foundation and Stage 2 Agent/model
workspace. It defines the Project creation, experiment, visual execution, batch
execution, output, event, and wind-import contracts needed before the final Stage
4 product shell.

## A2 acceptance baseline

A3 may begin only after the A2 boundary is accepted. The current local evidence
is:

- the focused A2 backend set passes on this branch when run without the
  macOS-only `model-process-isolation.test.ts` file in the Linux CI container;
- the web unit suite and production build pass;
- the full backend suite is not an A2-only gate in this container because it also
  runs legacy Gate 3 framed-wind tests and macOS-only restricted-process checks.
  Those failures do not expand or reduce the A2 product contract;
- the A2 product boundary remains honest: `technicalStatus: "executable"` means
  the thin technical checks passed, not scientific validity, calibration, trust,
  or recommendation quality.

Before implementation merges, release acceptance must repeat the A2 focused
backend set, web tests/build, and any available macOS restricted-process evidence
from the A2 acceptance host. If that evidence is unavailable, the PR must label
it as an environment limitation rather than silently weakening the contract.

## Outcome and stage boundary

Stage 3 makes **New project** and Project execution functional. A user can create
a Project from a technically executable Model, edit named experiment
configurations, start/cancel visual or batch runs, inspect bounded status and
outputs, and ask the Agent to inspect the current Project's outputs or visual
page within explicit Project permissions.

This stage implements:

- New project exposure through the Stage 1 fixed-copy primitive;
- Project-scoped permissions and conversations;
- editable experiment configurations without revision history;
- batch execution with status, cancellation, resource limits, logs, output-file
  indexes, and optional bounded domain events;
- visual execution with model-provided local web entry points, health checks,
  proxying, stopping, timeouts, resource limits, and restricted-frame embedding;
- direct right-pane run controls for start, cancel, download, and trash;
- Playwright visual inspection boundaries for explicitly requested Agent actions;
- import of the reviewed `wind-turbine-maintenance` model as an ordinary
  preinstalled Model plus one example Project and experiment configuration.

This stage does not implement:

- the final Models/Projects home, polished two-pane shell, offline read-only UX,
  or final wind browser acceptance owned by Stage 4;
- user-visible model versions, publishing, multi-user authorization, remote
  deployment, cloud sync, or Linux sandbox parity;
- VM/container-grade hostile-code containment;
- scientific validation, calibration, decision recommendations, automatic metric
  importance, or optimum selection;
- legacy immutable revision, workflow-policy, attestation, replay-timeline, or
  Evidence Studio product requirements except where explicitly retained as
  historical implementation details.

## Authority and trust boundaries

`ProductStoreV2` remains the only system of record for Models, Projects,
conversations, experiment configurations, run records, output indexes,
attachments, temporary documents, and trash state. Browser/API callers never
supply workspace paths, source digests, process commands, OpenCode session IDs,
proxy targets, run working directories, or technical status.

A Project owns a copied Model snapshot. Later edits to the source Model do not
change Project code, execution description, environment description, experiment
configuration defaults, existing runs, or output indexes. Trashing or archiving a
source Model does not delete Project copies or run outputs.

Stage 3 continues the Milestone A local-user boundary. Created Model code is
locally user-authorized, not adversarial. Execution runs in a separate process
with a restricted working directory, scrubbed credentials, no network by default,
finite time/output/process limits, cancellation, and only approved runtime roots.
The implementation must not claim stronger isolation than the host actually
proves.

## Schema v4 and repository contract

Stage 3 extends schema v3 to v4. The migration is transactional and aborts on any
integrity violation.

| Table | Purpose and integrity contract |
| --- | --- |
| `projects` | Durable Project identity, name, lifecycle, source Model identity, copied workspace root, copied execution description digest, current conversation pointer, and timestamps. |
| `project_model_files` | Complete copied file metadata: relative path, media type, size, digest, source Model file digest when available, and copy timestamp. No absolute paths. |
| `experiment_configs` | Editable named configuration records owned by one Project: mode, parameter values, seed list or sweep definition, execution values, sample-count estimate, lifecycle, and timestamps. |
| `runs` | One frozen execution attempt: Project ID, experiment config ID, frozen config digest, mode, state, timestamps, cancellation state, resource summary, log attachment, and terminal reason. |
| `run_outputs` | Output-file index rows with Project/run ownership, logical name, media type, relative object path, digest, size, creation time, and trash state. |
| `run_domain_events` | Optional bounded event index metadata and page cursors; raw event files remain in the object store. |
| `visual_run_sessions` | Live or terminal visual process/proxy state, health status, frame URL token, timeout, and cleanup receipt. |

Repository methods use the Stage 1 expected-change transaction pattern. A lost
client response replays the durable receipt exactly when the command ID and
payload digest match; changed content fails before mutation.

## API contract

All new browser routes use `/api`; legacy `/v1` and Gate routes remain separate
until an explicit retirement audit.

| Route | Contract |
| --- | --- |
| `POST /api/projects` | Create a Project from a technically executable Model using server-owned fixed-copy materialization. Accepts name, source `modelId`, and `commandId`; rejects non-executable or stale source state. |
| `GET /api/projects/{projectId}/workspace` | Return a digest-bound Project workspace projection with copied documents, experiment configs, recent runs, output indexes, and public conversation state. No absolute paths or process details. |
| `GET/POST /api/objects/project/{projectId}/conversations` | Use the A2 conversation contract with Project-scoped tools only. |
| `POST /api/projects/{projectId}/experiment-configs` | Create a named configuration from copied defaults and supplied schema-valid values. |
| `PATCH /api/projects/{projectId}/experiment-configs/{configId}` | Atomically edit a configuration when no run command is freezing the same config. Validation recomputes sample count. |
| `POST /api/projects/{projectId}/runs` | Start a visual or batch run from a configuration. The backend freezes the exact config, copied execution description, workspace digest, and limits. |
| `GET /api/projects/{projectId}/runs/{runId}` | Read bounded run status, resource summary, cancellation state, output index summary, and terminal reason. |
| `POST /api/projects/{projectId}/runs/{runId}/cancel` | Request cancellation idempotently. Terminal runs replay their terminal cancellation outcome. |
| `GET /api/projects/{projectId}/runs/{runId}/outputs` | List bounded output-file descriptors and download handles. |
| `GET /api/projects/{projectId}/runs/{runId}/events` | Return bounded/filterable domain-event pages when the Model declared events. |
| `POST /api/projects/{projectId}/runs/{runId}/trash` | Trash a terminal run and its indexed outputs without deleting unrelated Project objects. |

Every mutation requires `commandId`, validates Project ownership from the route,
and rejects browser-supplied paths, digests, process commands, proxy URLs, or
OpenCode/MCP capabilities.

## Experiment configuration contract

Experiment configurations are directly editable records, not immutable revision
chains. A run freezes the exact values it used. Configurations may describe:

1. one parameter set and one seed;
2. one parameter set and multiple explicit seeds;
3. a finite sweep over declared input fields and seeds.

The backend validates every parameter, execution value, seed, and sweep bound
against the copied Model execution description and input schema. It computes a
sample-count estimate before persistence and rejects non-finite, unbounded, or
resource-limit-exceeding configurations. Riff displays the estimate but does not
rank metrics, optimize values, or recommend a decision.

## Run state machine

A run transitions through one of the following paths:

```text
created -> queued -> running -> succeeded
created -> queued -> running -> failed
created -> queued -> running -> timed_out
created -> queued -> cancellation_requested -> cancelled
created -> queued -> running -> cancellation_requested -> cancelled
```

A run may also fail before dispatch as `failed` with a stable validation or
admission reason. Terminal states are immutable. Restart recovery reconciles any
non-terminal run by reading durable process receipts, output manifests, and
cancellation receipts. If evidence is contradictory, recovery marks the run
`failed` with a fail-closed terminal reason and preserves raw logs for diagnosis.

## Batch execution contract

Batch runs execute the copied Model entry point with frozen inputs and limits.
The browser sees only platform-owned status fields: state, sample count, steps or
time horizon, seed count, metric count, duration, resource overview, bounded log
summary, output files, and optional event index summary.

A successful batch run publishes output descriptors only after all declared
outputs are present, within size limits, and content-addressed. Missing required
outputs fail the run. Extra outputs may be retained only when the execution
description allowed an output directory; otherwise they fail closed before
publication.

When a batch run reaches a terminal state, the system appends a completion card
to the Project conversation. Analysis documents are created only after explicit
user request through Project-scoped Agent tools.

## Visual execution contract

Visual Models declare a local web entry point, health check, and optional
structured inspection endpoint. Stage 3 starts the process in the copied Project
workspace, waits for health, proxies only the declared local endpoint, and embeds
it in a restricted frame. The browser never receives the raw target port, process
ID, working directory, environment, or proxy capability secret.

Visual runs do not produce a system result report. They may produce declared
output files or bounded events if the Model contract declares them. Stopping,
timeout, browser disconnect, backend restart, and explicit cancellation all
follow the same cleanup receipt contract: the process group is stopped or marked
unreachable, the proxy token is revoked, and the run is terminally reconciled.

## Playwright inspection contract

Playwright inspection is an Agent action, not ambient browser authority. It may
inspect only the current Project's active visual run after explicit user
instruction. Allowed observations are the embedded page, accessibility tree,
DOM-derived public state, screenshots, and the Model's structured inspection
endpoint when declared. Observations are timestamped conversation context and are
not authoritative Project state.

Playwright interaction with the visualization requires an explicit user command
for that action. The conversation records the command, tool use, target run,
observed URL/frame identity, and resulting screenshot or textual observation.

## Wind import contract

Stage 3 imports the reviewed `wind-turbine-maintenance` Mesa model as an
ordinary preinstalled Model. The imported Model has the same generic technical
status and execution-description rules as user-created Models. A separate wind
example Project copies that Model and starts with one example experiment
configuration.

The example Project contains no fabricated conversation, analysis,
recommendation, calibration claim, or staffing guidance. Legacy Evidence Studio
components, hard-coded wind UI tabs, immutable revision workflows, replay
timelines, and attestation/trust labels are not new Milestone A requirements.
They may remain in tracked code only until explicit retirement.

## Recovery and cleanup

Restart recovery must prove:

- Project creation either completes with a copied workspace and database row or
  rolls back/quarantines incomplete materialization;
- experiment edits are all-or-none and never rewrite frozen run inputs;
- run start lost-response retries replay the same run ID and frozen digest;
- cancellation lost-response retries replay the same cancellation receipt;
- visual proxy tokens are revoked for terminal or orphaned runs;
- output indexes never point outside the owning Project object root;
- trash previews list exact Project/run/output closures before deletion.

## Verification and acceptance matrix

| Contract | Required evidence |
| --- | --- |
| A2 remains accepted | Focused A2 backend set, web tests/build, and available macOS isolation evidence pass or are explicitly marked unavailable. |
| New project fixed copy | API/store tests prove a technically executable Model can create a Project, source edits cannot affect the copy, and non-executable/stale sources fail. |
| Project permissions | Agent/API tests deny Project tools from mutating source Model files, schemas, dependencies, or execution descriptions. |
| Experiment validation | Unit/API tests cover single seed, multi-seed, finite sweep, invalid values, unbounded sample counts, and lost-response idempotency. |
| Batch execution | Runner/API tests cover success, missing outputs, extra output policy, logs, limits, cancellation, timeout, restart reconciliation, and completion cards. |
| Visual execution | Integration/browser tests cover health, proxy secrecy, restricted frame, stop, timeout, cancellation, restart cleanup, and unavailable health. |
| Output/event indexes | Store/API tests prove ownership, digest, pagination, filters, size bounds, trash, and restart recovery. |
| Playwright boundary | Tool tests prove explicit-user-action gating, current-Project-only access, observation recording, and denial without active visual run. |
| Wind import | Migration tests prove the reviewed wind Model imports as ordinary preinstalled content and one example Project has no fabricated analysis or recommendation claims. |
| Honest trust copy | API/browser tests forbid scientific-validity, calibration, trust, recommendation, or optimum labels for technical execution and example outputs. |

Focused store, API, runner, Agent-tool, browser, and wind-import tests are
required. The backend and web suites must pass with legacy/non-scope failures
removed from the Stage 3 gate or explicitly tracked as environment/legacy
limitations. Final acceptance requires one real browser flow that creates a
Project, edits an experiment, starts and cancels or completes a run, downloads an
output descriptor, and survives backend restart.

## Documentation synchronization checklist

The Stage 3 implementation PR must update documentation in the same change as
behavior:

- this design with implemented status and evidence;
- `docs/README.md` with Stage 3 status;
- `backend-api.md` with actual Project, experiment, run, output, event, visual,
  and Playwright DTOs/errors;
- `architecture.md` with Project execution process/proxy boundaries;
- `opencode-bridge.md` with Project-scoped Agent tool changes;
- `ui-workflow.md` with the minimal Stage 3 acceptance surface and Stage 4 shell
  reservation;
- `test-plan.md` with focused/full/browser/wind-import evidence;
- `milestone-a-product-contract.md` only if the product contract itself changes.
