# Architecture contracts

## Milestone A2 authority and A3 foundation architecture

The current authority is the
[`Milestone A product contract`](milestone-a-product-contract.md), the
[`Stage 1 data design`](milestone-a1-data-foundation-design.md), and the
[`Stage 2 Agent/workspace design`](milestone-a2-agent-workspace-design.md).
`ProductStoreV2` over SQLite schema v4 and checked object bytes is the system of
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

A3-1a extends only the durable planning boundary:

```text
copied Project input schema
  -> closed canonical schema validator
  -> deterministic ExperimentConfigurationV1 sample planner
  -> configuration + record digest CAS + immutable historical command receipt
  -> Store-only execution-description-v2 admission
  -> atomic frozen queued Run + immutable start receipt
       -> copied Project / execution / configuration / sample-plan / limits digests
```

Schema-v3 experiment/run/output records migrate to deterministic read-only v3
projections. Schema-v4 commands, receipts, run/process-attempt identities,
ownership, and canonical digests are database constrained, but the attempt
tables have no runtime producer in A3-1a. The frozen `queued` run is an admission
record only: no dispatcher, supervisor, model process, output ingestor,
completion card, or public start route is implemented by A3-1a. The generic
Stage 2 scaffold remains execution-description v1 and therefore requires an
explicit later re-scaffold/upgrade before this Store-only v2 admission can pass.

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
