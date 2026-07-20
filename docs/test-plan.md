# Wind-turbine delivery test plan

## Status

This Gate 0 plan defines acceptance for Gates 1-4. It does not claim those tests
or features exist in the current queue-bound implementation.

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
- exact event-interval KPI integration and warm-up exclusion;
- same model/experiment/seed canonical event digest stability.

Contract tests fail when code IDs, `model-spec.json`, parameter/metric schema,
source transition dispositions, traceability, visualization metadata, or
derived-view digests drift. Run request, metadata, events, metrics, summary,
replay, and views must share one exact identity set.

The fixed baseline executes 100 turbines, 3 crews, 1095 days, 365 warm-up, seed
2 within finite worker limits. It proves reproducibility and artifact integrity,
not AnyLogic numerical equivalence, calibration, uncertainty, or staffing merit.

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
