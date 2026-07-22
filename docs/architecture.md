# Architecture contracts

## Milestone A2 current architecture

The current authority is the
[`Milestone A product contract`](milestone-a-product-contract.md), the
[`Stage 1 data design`](milestone-a1-data-foundation-design.md), and the
[`Stage 2 Agent/workspace design`](milestone-a2-agent-workspace-design.md).
`ProductStoreV2` over SQLite schema v3 and checked object bytes is the system of
record. Conversation/OpenCode services, scoped MCP/skills, Model workspace
helpers, technical checkers, HTTP projections, DOM, and Agent prose cannot
write around that store or become authoritative state.

Stage 2 currently adds these implemented boundaries:

```text
API integration (in progress)
  -> conversation / Agent session coordination
       -> ProductStoreV2 schema v3
       -> loopback OpenCode adapter + bounded Riff context
       -> scoped MCP tools + progressive simulation-skill loading
       -> generic Model workspace
            -> restricted macOS process + digest-bound technical checker
```

One conversation owns one provider/model lock and at most one nonterminal
backend-only external session generation. Lost sessions rebuild from bounded
Riff-owned context; provider failure is explicit read-only. All direct Model
changes use typed owner-scoped tools and Stage 1 database/filesystem recovery.
Project conversations cannot change copied Model code, schema, or dependencies.

The restricted runner supplies a capability-resolved Model directory, fixed
executable/arguments, scrubbed environment, no network rule, cancellation, and
finite time/output limits through macOS `sandbox-exec`. This local-user boundary
does not claim VM/container isolation from malicious code. Technical
executability is digest-bound evidence that a thin interface runs; it is not
scientific validity, calibration, trust, or decision suitability.

Legacy Gate/wind and queue components still coexist and are retired only by an
explicit later audit. #14 owns Project execution and wind migration; #15 owns
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
