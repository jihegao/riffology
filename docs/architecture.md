# Wind-turbine alignment architecture target

## Status

This is the approved Gate 0 target, not an implementation claim. The current
checkout still runs the in-memory, queue-bound Phase 0 path. Gates 1-4 replace
that path before Gate 4 removes it.

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
