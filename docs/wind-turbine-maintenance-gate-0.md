# Wind-turbine maintenance Gate 0 contract

## Status and authority

This document is the approved target contract for the next Riff delivery slice.
Gate 0 records decisions only: the current runtime still supports
`queue-network-v1` until the later implementation gates replace it. This
document must not be cited as proof that the wind-turbine model, persistence,
generated diagrams, or browser workflow already exist.

The Phase 1 product question is:

> How many field-service crews should an onshore wind farm configure to reach
> its availability target at the lowest annual maintenance cost?

Phase 1 ends with an inspectable, executable experiment definition and one
reproducible baseline run. It does not answer the staffing question. Comparing
crew counts across multiple seeds and reporting a recommendation belongs to
Phase 2.

## Source boundary and provenance

The structural source is the local AnyLogic example:

```text
/Users/Shared/AnyLogic 8 PLE/eclipse/plugins/
  com.anylogic.examples_8.9.0.202404161223/models/Field Service/Field Service.alp
```

Source facts recorded at Gate 0:

| Field | Value |
| --- | --- |
| Source format | AnyLogic `.alp` XML |
| Package version | AnyLogic examples `8.9.0.202404161223` |
| Project-declared AnyLogic version | `8.4.0.qualifier` |
| Project format version | `8.4.5` |
| Model time unit | day |
| Experiment seed | `2` |
| Source size | `170957` bytes |
| SHA-256 | `2153fbf23348ece013f7d72bf0064e5d01ac52273bebf560520bb35047734755` |

The AnyLogic example is a generic field-service model that names wind turbines
as one possible equipment fleet. Riff will independently reproduce selected
behaviour in Python/Mesa. It will not copy AnyLogic Java, logos, images, or the
3D lorry asset into this repository. The excluded sibling assets are:

| Excluded source asset | SHA-256 |
| --- | --- |
| `3d/lorry.dae` | `6620a3301ffa458f1b32df4102cd68e5444e95ea8940c85d4edfb4288c832669` |
| `image1.png` | `6363b2c6cc7dfae92b656c3d14a69f383faa08c0e4eb54293dada6ebfee1368e` |
| `AnyLogic model logo dark.png` | `c81a7f7934755ecaa5de65441752111e442f0683a1c514713817b523b866e1bb` |

The lorry file also carries AnyLogic copyright metadata. The `.alp` and any
earlier reproduction are structural evidence only.

This is a behavioural reproduction, not a runtime import. The source provides
evidence for entities, parameters, states, transitions, and priority rules.
Results under the Riff assumptions do not prove event-by-event or numerical
equivalence with AnyLogic and do not validate a real wind farm.

## Product and claim boundary

The first user is an onshore wind-farm operations lead. The workbench uses
business terms such as crew count, failure wait, maintenance overdue,
availability, and annual cost. Python names and distribution details remain
inspectable but are not the primary interaction language.

The case uses synthetic data. The `95%` minimum availability target is a demo
constraint recorded as `user_declared_demo_target`, not an industry benchmark.
Mean and P95 failure wait, mean and P95 maintenance overdue, crew utilisation,
and operation counts are diagnostics rather than additional hard constraints.
Revenue and profit may be displayed for source traceability, but the Phase 1
decision objective is minimum annual maintenance cost subject to the
availability target.

Every draft screen, run, diagram, export, and assistant summary must disclose:

- synthetic inputs;
- one fixed seed in Phase 1;
- AnyLogic behavioural-reproduction boundary;
- no weather, component tree, spare network, or real GIS;
- no staffing recommendation or real-world decision claim.

## Mechanism mapping

| AnyLogic source | Riff target | Mapping | Gate 0 decision |
| --- | --- | --- | --- |
| `Main` | `WindTurbineMaintenanceModel` | adapted | Owns time, agents, queues, costs, metrics, and event ordering. |
| `EquipmentUnit` | `WindTurbineAgent` | renamed/direct | One agent per turbine; no component sub-agents. |
| `ServiceCrew` | `MaintenanceCrewAgent` | renamed/direct | One crew handles at most one turbine at a time. |
| `serviceRequests` | `corrective_queue` | direct | Higher-priority FIFO queue. |
| `maintenanceRequests` | `planned_queue` | direct | Lower-priority FIFO queue. |
| `Working` | `operating` | renamed/direct | Revenue/availability-producing state. |
| `Failed` | `failed_waiting` | renamed/direct | Turbine is unavailable while waiting for a crew. |
| `Repair` | `corrective_repair` | renamed/direct | Triangular service duration. |
| `Maintenance` | `planned_maintenance` | renamed/direct | Periodic work; overdue work increases failure risk. |
| `Replacement` | `major_replacement` | adapted | Rare major replacement after an unrepairable failure; not a Phase 1 policy lever. |
| Crew `Idle/DrivingToWork/Working/DrivingHome` | matching crew states | direct | Preserve dispatch, travel, work, release, and return semantics. |
| Crew `LaidOff` | configured population at run start | deferred | Crew count is frozen within one experiment run; mid-run hiring/layoff is out of scope. |
| Continuous space and `moveTo` | seeded two-dimensional wind farm | adapted | Central depot, Euclidean travel time, fixed speed; no road or GIS service. |
| Failure timeout | scheduled failure event | direct | Exponential family with maintenance-overdue and age factors. |
| Annual revenue/expense/profit | annual diagnostics | derived/adapted | Retained for traceability; not the Phase 1 optimisation objective. |

Corrective work is always selected before planned maintenance. FIFO ordering is
used inside each queue. A failure request supersedes an outstanding planned
maintenance request for the same turbine. A crew that finishes corrective work
continues directly into overdue planned maintenance for that turbine when
required; otherwise it takes the next request when one exists and returns to the
central depot only when both queues are empty. Each turbine may have at most one
active work order of a given type. Weather access, vessels, helicopters, spares,
skills, multiple farms, predictive-maintenance algorithms, and alternative
dispatch policies are explicitly deferred.

The source has five turbine states and twelve transitions, plus four active crew
states, `LaidOff`, and nine crew transitions. Gate 1 must disposition every
source transition in `model-spec.json`; a renamed or combined transition must
retain its source reference and rationale rather than disappearing silently.

Failure time is sampled once on every entry into `Working`, using the
maintenance-overdue and age factors as they stand at that moment. It is not a
hazard that is recalculated every day. A daily hazard implementation would be a
deliberate semantic rewrite and is not the approved Gate 1 baseline.

The exact source expression to preserve is:

```text
overdue_factor = max(1, (now - TimeLastMaintenance) / MaintenancePeriod)
age_factor = max(1, (now - TimeLastReplacement) / (3 * MaintenancePeriod))
failure_delay = exponential(NormalFailureRate * overdue_factor * age_factor)
```

At initialization, `TimeLastMaintenance` is uniform over one prior maintenance
period and `TimeLastReplacement` is `0`. Gate 1 must test these initial
conditions and record any necessary random-distribution API adaptation without
changing the source rate semantics.

The proactive AnyLogic `ReplaceOldEquipment` policy is off. A configurable
probability may still route an unrepairable failure to `major_replacement`.
Replacement probability, duration, and cost are synthetic assumptions, not a
second decision variable.

## Source defaults and Riff defaults

The source values remain a reference fixture and must not be relabelled as wind
industry data:

| Source parameter | AnyLogic default |
| --- | ---: |
| Equipment population | `100` |
| `ServiceCapacity` | `3` crews |
| `DailyRevenuePerUnit` | `400` |
| `ServiceCrewCostPerDay` | `1000` |
| `ReplacementCost` | `10000` |
| `RepairCost` | `1000` |
| `MaintenanceCost` | `600` |
| `MaintenancePeriod` | `90` days |
| `NormalFailureRate` | `0.03` per day |
| Repair duration | triangular `(2.5, 5, 12.5)` hours |
| Maintenance duration | triangular `(1.5, 3, 4.5)` hours |
| Replacement duration | triangular `(6, 12, 18)` hours |
| `ProbabilityReplacementNeeded` | `0.1` |
| `ReplaceOldEquipment` | `false` |
| `MtcePeriodsToReplace` | `5` |
| Initial last-maintenance offset | uniform `(-90, 0)` days |
| Crew speed | `0.00057` metres/second |
| Source statistics sampling | every 20 minutes |
| Source simultaneous-event rule | LIFO |
| Source run configuration horizon | `18250` days; experiment has no stop condition |
| Source abstract canvas | `610 x 510`; 100 canvas units represent 10 metres |
| Source depot | `(280, 230)` with a `30 x 30` area |
| Source initial layout | environment-random equipment locations and crew points within the depot |

Gate 1 must add a separate versioned preset named
`wind-turbine-maintenance-demo-v1`. Its required fixed defaults are 100
turbines, 3 crews, a 95% demo availability target, 1095 simulated days, a
365-day warm-up, and seed 2. Other numeric values must be explicitly labelled
as synthetic and may begin from, but must not silently inherit, the source
fixture.

All exposed numeric and boolean parameter values are editable and can be reset
to the active model revision's defaults. The UI must display default, current,
and changed values. Changing values creates an experiment revision. Changing a
parameter's meaning, unit, valid range, distribution family, state rule, or
metric formula creates a model revision.

Distribution families are fixed within a model revision:

- exponential failure timing with overdue-maintenance and age factors;
- triangular corrective-repair time;
- triangular planned-maintenance time;
- triangular major-replacement time.

## Mesa time and run contract

The target is a Mesa 3 hybrid event model, not a coarse daily state machine.
Model time is measured in days and may be fractional for hour-scale travel and
work. Failure, maintenance-due, arrival, repair-completion, and
replacement-completion events are scheduled in time order. One public
`step()` advances one natural day and processes all events through that day.

The source resolves simultaneous events with LIFO selection. Gate 1 must either
preserve that with a stable decreasing sequence key or record an intentional
business-priority rewrite in the source map. Python object identity, heap
accidents, and agent iteration order are not valid tie-breakers. Tests cover a
failure and maintenance due at the same instant, and work completion concurrent
with a newly queued request.

The Phase 1 baseline is:

- 100 turbines and 3 crews;
- 1095 days total;
- first 365 days retained in logs but excluded from reported KPI aggregates;
- fixed seed 2;
- one daily metric row plus an authoritative domain-event log.

A separate three-turbine deterministic micro-case uses the same implementation
and supplies hand-checkable state, queue, time, and cost oracles. Phase 1 does
not run a crew-count sweep or report stochastic uncertainty from a single seed.

The current 500-step queue-model limit is not the target contract. Gate 1 must
raise the bounded model maximum for the 1095-day run while retaining finite
time, memory, output, log, cancellation, and worker limits. Performance is not
a strict release metric. If rendering becomes expensive, the browser may reduce
playback frames or receive aggregated daily state; the worker must not silently
drop domain events used by metrics or audit.

## Generated model and evidence views

All diagrams are projections of machine-readable artifacts:

1. Entity/state diagrams come from stable IDs exported by the model code to
   `model-spec.json`.
2. Process/swimlane and replay views come from server-owned domain events.
3. Business traceability diagrams come from requirement/assumption mappings to
   model rules, parameters, experiment revisions, runs, and metrics.

The required event vocabulary includes at least:

```text
failure_occurred
maintenance_due
request_queued
crew_dispatched
crew_arrived
repair_started
repair_completed
maintenance_started
maintenance_completed
replacement_started
replacement_completed
crew_returned
```

Gate 1 must make model-code/spec drift a failing test. The browser and generated
prose cannot create or upgrade model state. Raw JSON/JSONL and CSV artifacts,
not the rendered diagram, remain the reproduction source.

The target model revision bundle is:

```text
models/wind-turbine-maintenance/revisions/<model-revision>/
  manifest.json
  model.py
  model-spec.json
  parameter-schema.json
  metric-schema.json
  visualization.json
  traceability.json
  provenance.json
  defaults/
    source-field-service-reference.json
    wind-turbine-maintenance-demo-v1.json
  tests/
```

A successful run must retain at least:

```text
runs/<run-id>/
  request.json
  metadata.json
  daily-kpis.csv
  domain-events.jsonl
  summary.json
  run.log
```

Every file and browser projection resolves to the same model revision,
experiment revision, seed, and run ID.

## Alignment, issues, attestations, and trust

Riff must not encode human agreement as a qualitative `confirmed` truth state.
Review is quantitative and scoped:

- an immutable attestation records actor, actor type, artifact revision, scope,
  decision, rationale, timestamp, and any superseded attestation;
- `endorse`, `object`, and `abstain` are review decisions, not trust levels;
- internal issues bind to exact artifact revisions and record severity,
  `blocking`, status, discussion, assignee, and resolution;
- zero open issues means no recorded objection, not that anyone endorsed the
  artifact and not that the artifact is valid;
- Agent reviews are displayed separately and never count as human endorsements.

The default workspace progression policy is derived, not stored as model truth:

```text
human project-owner endorsements >= 1
AND open blocking issues == 0
```

Meeting this policy only permits the workflow to advance. It does not change
`trustState`, validate the model, or make a decision claim. Local actor IDs,
names, and roles are declared but unauthenticated in Phase 1; the UI must say so.
One human actor contributes at most one effective endorsement to one artifact
revision, while superseded records remain auditable.

Safe private draft runs are allowed before the progression policy is met. They
remain `workflow_policy_unmet` and `draft_unverified`. After the experiment
revision meets the policy, a new run is required for any result presented as
the endorsed experiment's result; an older draft run is not upgraded in place.

The target local project layout is:

```text
projects/<project-id>/
  alignment/
    decision-brief/revisions/
    requirement-map/revisions/
  issues/
  attestations/
  experiments/revisions/
  models/wind-turbine-maintenance/revisions/
  runs/
```

Gate 2 uses atomic JSON snapshots plus immutable or append-only revision,
attestation, issue, and event records. Database, authenticated multi-user
identity, remote sync, and concurrent editing are deferred.

## Target API direction

Exact schemas are a Gate 2 deliverable, but browser-facing route semantics must
follow this `/api` boundary rather than reintroduce `alignment/confirm`. Mesa's
backend-only execution routes retain their separate `/v1` namespace:

```text
POST /api/projects/{projectId}/brief/revisions
POST /api/projects/{projectId}/alignment/revisions
POST /api/projects/{projectId}/issues
PATCH /api/projects/{projectId}/issues/{issueId}
POST /api/projects/{projectId}/attestations
POST /api/projects/{projectId}/experiments/revisions
POST /api/projects/{projectId}/runs
GET  /api/projects/{projectId}/runs/{runId}/events
```

The backend remains the sole authority. OpenCode proposes typed mutations; a
human may also edit the structured workbench directly. Agent text, DOM state,
Playwright observations, generated diagrams, and assistant summaries are not
authoritative project state.

## Browser exit story

The Phase 1 visible exit gate is one complete real-OpenCode story:

1. An operations lead describes the staffing decision in natural language.
2. The Agent proposes a decision brief, assumptions, and model mapping.
3. The user edits a parameter, observes its diff, and verifies reset-to-default.
4. A blocking internal issue prevents the progression policy from being met.
5. The issue is closed and one project-owner human endorsement is recorded.
6. Entity/state, process/swimlane, and business-traceability views render from
   the documented artifacts.
7. The user runs the 100-turbine, 3-crew, seed-2, three-year baseline.
8. The two-dimensional view shows turbines, depot, crews, queues, and KPIs.
9. Results, events, diagrams, and summary resolve to identical revisions and
   run identity.
10. The page discloses the single seed, synthetic data, behavioural
    reproduction, and no-recommendation boundary.

Deterministic fixtures remain suitable for component tests, but the final gate
requires the configured local OpenCode provider/model. An unavailable provider
fails closed; it is not replaced with a canned Agent response.

## Delivery gates and dependencies

| Gate | Issue | Scope | Exit condition |
| --- | --- | --- | --- |
| Gate 0 | [#2](https://github.com/jihegao/riffology/issues/2) | This source mapping, product boundary, roadmap, issues, and contracts | Documents agree; no implementation is claimed. |
| Gate 1 | [#3](https://github.com/jihegao/riffology/issues/3) | Mesa behavioural reproduction, demo defaults, deterministic micro-case, fixed-seed baseline, spec export, events, and evidence | Model invariants, source mapping, reproducibility, and artifact identity tests pass. |
| Gate 2 | [#4](https://github.com/jihegao/riffology/issues/4) | Persistent revisions, experiment drafts, internal issues, attestations, actor projections, and draft-run policy | Restart recovery and policy-derivation contract tests pass. |
| Gate 3 | [#5](https://github.com/jihegao/riffology/issues/5) | Two-pane alignment workbench, parameter reset/diff, generated diagrams, and two-dimensional run view | Component and browser tests prove views use authoritative artifacts. |
| Gate 4 | [#6](https://github.com/jihegao/riffology/issues/6) | Real OpenCode flow, visible E2E, documentation cutover, and legacy removal | The complete browser story passes; `queue-network-v1` is absent from the current product tree and its identified local artifacts are removed. |

Implementation may use bounded model, backend, frontend, and independent-review
subagents. The main controller owns scope, interfaces, integration, and gate
acceptance. A later gate may not be reported complete while an earlier gate is
open.

## `queue-network-v1` retirement contract

`queue-network-v1` is not retained as a regression fixture or promoted into the
future generic model-package catalogue. Gate 4 removes it from source, schemas,
tests, tools, prompts, documentation, local/demo E2E, and the current product
tree. Git history is not rewritten.

Gate 0 found existing ignored workspace files whose manifests or summaries
identify `queue-network-v1`; no files are deleted in this documentation-only
gate. Gate 4 must first audit exact manifests, then remove only model revisions,
runs, or project directories whose identity is unambiguously
`queue-network-v1`. It must not infer identity from a directory name or remove
unrelated/ambiguous workspaces. The deletion report must list the resolved
targets and state that they are no longer recoverable from the workspace.

## Gate 0 exit checklist

- [x] Product question, Phase 1 non-goal, and Phase 2 handoff recorded.
- [x] AnyLogic source path, version, hash, mechanism mapping, and source-asset
      boundary recorded.
- [x] Synthetic-data, behavioural-reproduction, single-seed, and
      no-recommendation claims recorded.
- [x] Mesa hybrid-time, artifact, generated-view, revision, issue,
      attestation, persistence, and draft-run targets recorded.
- [x] Gate 0 through Gate 4 scopes and dependencies recorded.
- [x] Complete current-tree retirement and precise workspace-cleanup policy for
      `queue-network-v1` recorded without performing the deletion.
- [x] Independent review finds no unresolved blocking contract conflict.
- [ ] Gate 0 checks pass and its draft pull request links the delivery issues.
