# Product positioning and roadmap: business-aligned simulation agents

> **Superseded target notice:** the approved
> [`milestone-a-product-contract.md`](milestone-a-product-contract.md) is the
> current product authority. The Gate 0-4 roadmap below is retained as design
> history and wind-model evidence. It must not be used to remove the OpenCode
> conversation surface, require immutable user-visible revisions, or hard-code
> Wind Evidence Studio as the product.

> **Current delivery status:** Stages 1 and 2 are implemented. Stage 2 / #13 is
> the completed Agent/Model-workspace authority through
> [`milestone-a2-agent-workspace-design.md`](milestone-a2-agent-workspace-design.md).
> Schema v3/store, durable per-conversation OpenCode context, scoped MCP/skills,
> attachments/documents, generic Model workspace, restricted macOS process,
> technical checker, and the narrow provider/Model/conversation/turn/check API
> are implemented. Final acceptance completed the real-provider same-session
> two-turn browser rerun with OpenCode `1.18.4`. Legacy Gate and queue code still
> coexist. Stage 3 / #14 is in progress through
> [`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md).
> The first foundation slice landed the fixed-copy Project/workspace. A3-1a
> adds execution contract v4, canonical deterministic sample planning, experiment
> configuration/record digest CAS with immutable historical receipts,
> execution-description-v2 admission, and an atomic frozen queued-run receipt.
> A3-1b adds the public run start/read routes, durable dispatch, a real generic
> batch process per sample, hard enforcement of the currently supported
> server-owned limits, and atomic successful output publication. The official
> generic scaffold now emits execution-description v2 and declares batch only;
> v1 Models are not silently upgraded. Visual and batch `domainEvents` are
> explicit current rejections. A3-1c-a adds schema migration v5 and strict
> same-process queued/running cancellation with committed race receipts.
> Cross-restart attempt/process/scratch recovery and exactly-once completion
> cards remain later A3-1c work, followed by
> visual, Playwright, and ordinary wind slices. This is not completion evidence
> for Stage 3. #15 owns the final shared shell and browser acceptance.

> The current process claim is deliberately narrow: macOS, local user,
> `sandbox-exec`, restricted Model workspace, scrubbed environment, no network
> by default, and finite limits. It is not hostile-code containment. A
> “Technically executable” Model has passed only the thin technical contract;
> it is not scientifically validated, calibrated, trusted, or recommended.

## Gate 0 status

The wind-turbine Phase 1 direction and Gates 1-4 below are approved target
contracts, not proof that the current queue-bound runtime implements them. The
current/target cutover is explicit in the delivery phases.

## Product positioning

Riff is an AI-native simulation Agent work platform for business decisions. It
helps people turn goals, constraints, operational knowledge, data, and uncertain
assumptions into executable simulation experiments, then iterate on those
experiments through computational analysis until the question, mappings,
reviews, objections, and result interpretation are explicit and inspectable.

Riff is not primarily a Mesa code generator. Model code is one replaceable
implementation artifact inside a larger alignment loop:

```text
business request
  -> decision brief
  -> assumptions and requirements
  -> model specification
  -> scenarios and experiment plan
  -> simulation runs and computation
  -> findings and trade-offs
  -> human decision
  -> revised requirements or assumptions
```

The product's core job is to preserve structured, inspectable continuity across
that loop. A user should be able to see why a model contains a rule, which
business requirement a parameter represents, which scenario tests an assumption,
and which runs support a finding.

## Value model

Riff has three distinct layers of value. They must not be presented as equivalent
product outcomes.

1. **Safety and reproducibility are prerequisites.** A revision must run without
   endangering the host, another project, credentials, data, or service
   availability. Runs must remain attributable and reproducible.
2. **Business alignment is the core product value.** Riff must help a human and
   an Agent quickly turn an incomplete business request into a structured,
   inspectable model, scenario set, and experiment definition. Important
   assumptions and inferred requirements must be explicit rather than hidden in
   generated code or chat.
3. **Decision trust is an outcome gate.** Evidence determines whether findings
   from an exact revision are suitable for a named claim, dataset, scenario, and
   operating range. Trust is progressive and scoped; it is not a universal model
   correctness badge.

Safety protects the alignment loop. Evidence and review determine how far the
results of that loop may be used. Neither replaces the need to model the right
business question.

## Product principles

- **Business requirements precede implementation.** The Agent may propose a
  model structure, but it must first expose the decision goal, constraints,
  metrics, assumptions, missing information, and non-goals it inferred.
- **Shared structured state precedes chat memory.** Important requirements,
  mappings, scenarios, findings, issues, and attestations must exist as project
  artifacts, not only as prose in a conversation transcript.
- **Agent changes are proposals.** A material change to a requirement,
  assumption, model rule, scenario, metric, or conclusion must show its impact
  and be accepted, rejected, or revised by a human before it silently becomes
  authoritative.
- **Alignment remains traceable.** Important relationships should be navigable
  from requirement to assumption, model element, parameter or data mapping,
  scenario, metric, run, finding, and decision.
- **Iteration should feel interactive.** Riff should minimize the time between a
  business change and an updated analysis. This is near-real-time human-Agent
  iteration, not a promise that every simulation is a hard real-time system.
- **Code is replaceable; intent is durable.** Mesa is the initial execution
  substrate. Product contracts should preserve business intent, experiments,
  evidence, and lineage independently of one generated implementation.

## Core alignment artifacts

The exact schemas will evolve, but the platform should converge on revisioned,
machine-readable artifacts with explicit provenance, issues, and scoped review
records.

| Artifact | Purpose |
| --- | --- |
| Decision brief | Decision to be made, goals, constraints, non-goals, stakeholders, time horizon, and unresolved questions. |
| Requirement and assumption map | Business statements, source provenance, Agent inferences, issue/attestation references, and links to model elements. |
| Model specification | Entities, state, rules, events, inputs, outputs, units, and declared simplifications. |
| Scenario pack | Baseline, alternatives, shocks, controllable decisions, operating ranges, and comparison intent. |
| Experiment plan | Seeds, sweeps, replications, stopping rules, metrics, and computational analysis to perform. |
| Finding record | Artifact-backed observation, uncertainty, relevant scenarios, limitations, and suggested follow-up experiments. |
| Decision record | Human conclusion, accepted trade-offs, rejected alternatives, and the exact findings and evidence used. |

A future project layout may expose this separation directly:

```text
projects/<project-id>/
  alignment/
    decision-brief.json
    requirement-map.json
    decisions/
  issues/
  attestations/
  scenarios/
  experiments/
  findings/
  models/<model-id>/revisions/<revision-id>/
  runs/<run-id>/
  evidence/
```

The model revision must reference the decision-brief and requirement-map snapshots
that shaped it. Updating a material requirement or assumption may invalidate the
alignment of existing scenarios, findings, or decisions even when the code itself
does not change.

## Product success measures

The initial north-star metric is **Time to Aligned Experiment**: elapsed time
from a user's business request until a structured, executable experiment
definition satisfies the workspace's explicit endorsement-and-issue policy.
This is a workflow measure, not a correctness or trust measure.

Supporting measures include:

- percentage of important requirements mapped to model elements, scenarios, and
  metrics;
- number of unresolved critical assumptions when the workflow policy is met;
- clarification turns required before the first policy-qualified experiment;
- time from a changed business requirement to updated comparative findings;
- percentage of Agent-inferred material assumptions explicitly accepted or
  corrected by a human;
- percentage of findings that identify their revision, scenarios, runs,
  uncertainty, and limitations;
- independent replay success for evidence intended to support a decision claim.

Fast code generation or a fast first run is not sufficient if the resulting
experiment addresses the wrong business question.

## Invariants retained at every stage

- Every run identifies a server-owned `modelId` and an immutable model revision.
  Immutability supplies identity and lineage; it is not by itself a trust gate.
- Every new model revision starts as `draft_unverified`. Evidence is attached
  to the exact model revision that produced it, never to a mutable model name.
- Generated model code never runs inside the Mesa API process. Draft execution
  requires an OS/container sandbox with no ambient credentials, no unrestricted
  host filesystem, no network by default, and finite CPU, memory, output, and
  wall-clock limits.
- The platform, not model-generated text or visualization, owns run status and
  artifact identity. Requests, seeds, manifests, logs, raw series, summaries, and
  computational analyses remain auditable.
- Material business requirements and assumptions carry provenance and exact
  artifact revisions. Human attestations, Agent reviews, issue status, and
  validation evidence remain separate; the Agent must not present an inference,
  endorsement count, or absence of issues as proof of correctness.
- A finding must identify the exact model revision, scenarios, experiments, and
  artifacts that support it. Generated prose cannot silently upgrade either
  alignment or trust.
- Diagrams and interactive views support understanding and inspection.
  Machine-readable specifications plus CSV/JSON evidence remain the
  reproducibility source.
- Trust is scoped to explicit claims, scenarios, datasets, and operating ranges;
  Riff does not label a model universally correct.

## Model package contract

The Phase 1 `wind-turbine-maintenance` model is initially a reviewed bundled
case. Phase 3 extracts it behind the generic model-package contract rather than
promoting the legacy queue example:

```text
models/<model-id>/revisions/<revision-id>/
  model.py                  # runnable Mesa implementation
  model-spec.json           # entities, state, rules, events, inputs, outputs
  parameter-schema.json
  metric-schema.json
  visualization.json        # diagram and optional Solara projection metadata
  manifest.json             # hashes, runtime, dependencies, provenance
  traceability.json         # requirements/spec rules -> code -> tests -> metrics
  tests/
    datasets/
    expected/
    properties/
```

The model code exports stable entity, state, transition, rule, parameter,
metric, and event IDs into the model specification. Class/state diagrams are
generated from that export, process/swimlane views from server-owned domain
events, and business traceability views from the requirement map. A code/spec
or mapping/view drift is a failing contract test, not an unresolved cosmetic
finding.

`traceability.json` should eventually connect both directions: from business
requirements and assumptions into model rules, and from model rules through
parameters, tests, metrics, scenarios, and findings.

## Alignment review and workflow policy

Alignment artifacts have immutable revisions; human agreement is not stored as
a qualitative `confirmed` truth state. An attestation records an actor, actor
type, exact artifact revision, scope, `endorse | object | abstain` decision,
rationale, timestamp, and supersession link. Internal issues bind objections or
questions to exact revisions and retain their blocking flag, status, discussion,
and resolution.

The Phase 1 default progression policy is derived:

```text
human project-owner endorsements >= 1
AND open blocking issues == 0
```

Zero open issues means only that no unresolved objection has been recorded. An
Agent review does not count as a human endorsement. Meeting the policy permits
workflow progression but does not change model trust. Private drafts may run
before it is met; after an experiment revision meets it, a new run is required
for results associated with that reviewed experiment. Older draft results are
never upgraded in place.

## Trust lifecycle

| State | Execution and visibility | Meaning |
| --- | --- | --- |
| `draft_unverified` | Private sandbox runs | Runnable, but logic and results are not yet validated. |
| `self_tested` | Creator or team sharing | Creator-supplied tests and declared expectations pass. |
| `agent_reviewed` | Experimental publication | Automated specification, implementation, reproducibility, numerical, and adversarial checks pass. This is not independent expert review. |
| `expert_reviewed` | Reviewed publication | An identified third party reviewed assumptions, mechanisms, evidence, and claim boundaries. |
| `validated_for_claim` | Decision use within an explicit scope | The exact revision has sufficient evidence for named claims, datasets, scenarios, and operating ranges. |

A code, dependency, schema, model-spec, or material requirement-mapping change
creates a new revision or explicitly reopens alignment. Prior test suites may be
replayed automatically, but prior alignment and trust do not silently transfer.

## Validation evidence

Riff should help creators build evidence rather than merely display a pass/fail
badge. An evidence suite may contain:

- deterministic micro-cases with hand-calculated or analytical oracles;
- boundary, invalid-input, timeout, cancellation, and resource-limit cases;
- invariants and metamorphic properties such as conservation, non-negativity,
  monotonicity where justified, and consistent unit transformations;
- fixed-seed regression runs with artifact comparisons;
- multi-seed stochastic experiments reporting distributions and uncertainty;
- calibration and held-out datasets when real observations exist;
- requirement-to-specification and specification-to-code traceability checks;
- scenario coverage and decision-sensitivity analysis;
- independent reproduction records and signed human review decisions.

Failures are retained as first-class evidence. A creator can continue iterating
on a failed draft, while publication and decision-use policies may require
specific evidence classes to pass.

## Delivery phases

### Phase 0 — bounded executable demo (legacy implementation)

`queue-network-v1` proved the upload, seeded run, artifact, timeout, result,
OpenCode, and visible-browser wiring. It is not retained as a regression
fixture, fallback, or future generic package. The current code remains runnable
only until Gate 4 replaces the path and then removes all queue source, schemas,
tests, tools, prompts, documentation, E2E coverage, and precisely identified
local artifacts. Git history is retained.

### Phase 1 — wind-turbine business alignment loop

- Independently reproduce the selected AnyLogic Field Service mechanisms as the
  reviewed bundled `wind-turbine-maintenance` Mesa case.
- Add revisioned decision briefs, requirement/assumption maps, experiment
  definitions, internal issues, human attestations, and separate Agent reviews.
- Let the Agent propose business requirements without silently treating an
  inference, endorsement, or lack of objections as validation.
- Map artifact revisions to the model's parameters, rules, scenario, metrics,
  generated diagrams, run events, and evidence.
- Allow safe private draft runs before the workflow policy is met; preserve
  their unreviewed and unverified labels.

**Exit gate:** starting from an onshore wind-farm staffing description, a user
can inspect and revise the brief and assumptions, resolve a blocking issue,
record one project-owner endorsement, inspect the generated views, and execute
the reviewed 100-turbine, 3-crew, seed-2 baseline. The single-seed synthetic run
does not recommend a crew count. See
[`wind-turbine-maintenance-gate-0.md`](wind-turbine-maintenance-gate-0.md).

### Phase 2 — scenario and computational analysis loop

- Add baseline and alternative scenario packs, parameter sweeps, multi-seed
  experiments, and comparison intent.
- Produce artifact-backed comparative findings with uncertainty, limitations,
  and traceability to exact runs.
- Let the Agent recommend the next experiment and show which requirements,
  assumptions, scenarios, and prior findings would be affected by a change.
- Create a new artifact revision and reevaluate issues/attestations when a
  material result or business change invalidates the policy-qualified experiment
  definition.

**Exit gate:** a user can change a business assumption, compare alternatives, and
receive updated computational findings in one continuous human-Agent workflow.

### Phase 3 — generic model packages and lineage

- Move the reviewed wind-turbine model constants, schemas, metrics, import
  logic, and visualization metadata behind the model-package contract.
- Add model/revision records, provenance, hashes, alignment references, and
  `trustState` to project state and run manifests.
- Generate design views and traceability from `model-spec.json` and the exact
  reviewed requirement-map revision.
- Add a second structurally different reviewed model without changing the
  generic runner, backend state machine, alignment workflow, or workbench
  controls.

**Exit gate:** two different business problem structures use the same alignment,
model, experiment, and run contracts, and every finding resolves to one immutable
package revision and one policy-qualified experiment definition.

### Phase 4 — creator sandbox and draft execution

- Let users and modelling Agents create, import, fork, and revise model packages.
- Perform syntax, interface, schema, dependency, and capability admission checks.
- Run accepted drafts in disposable sandbox workers with quotas and cancellation.
- Mark all draft screens, interactive views, exports, findings, and assistant
  summaries as unverified; prevent generated prose from upgrading alignment or
  trust.

**Exit gate:** users can iterate on novel models without platform code changes,
and security tests demonstrate project, filesystem, network, secret, resource,
and artifact isolation.

### Phase 5 — Evidence Studio and self-validation

- Provide requirement/model traceability, code/spec differences, test dataset
  management, expected-result editors, invariant definitions, seed matrices,
  scenario coverage, and evidence reports in one revision-scoped workspace.
- Allow users to construct and run their own validation suites.
- Support reproducible evidence export and independent replay.

**Exit gate:** a user can explain how the model represents the reviewed business
brief, trace each important rule to implementation and tests, reproduce every
evidence run, and promote a revision to `self_tested` without administrator
intervention.

### Phase 6 — automated review

- Add separate automated roles for requirement coverage, model criticism,
  spec/code consistency, adversarial test generation, reproducibility, numerical
  review, scenario coverage, and evidence auditing.
- Record prompts, tools, model versions, findings, disagreements, and reruns.
- Keep automated review visibly distinguishable from independent human review.

**Exit gate:** every automated promotion is supported by inspectable findings and
evidence, and reviewers can distinguish alignment issues from implementation,
numerical, reproducibility, and domain-validity issues.

### Phase 7 — expert review and governed ecosystem

- Add third-party expert review requests, scoped conclusions, signatures,
  conflicts of interest, expiry, and revocation.
- Publish, search, compare, fork, and reuse model packages, decision briefs,
  scenario packs, experiment templates, and evidence suites.
- Filter by domain, mechanism, license, runtime, trust state, claim scope,
  alignment scope, and evidence freshness.
- Apply stricter publication or decision-use policies by workspace, domain, and
  risk without removing private draft experimentation.

**Exit gate:** creators can move from an incomplete business question to a
reusable, evidence-backed decision workflow, while consumers can choose models
and scenario packs based on fitness for a specific purpose rather than a
universal approval badge.

## API direction

Future browser/backend contracts should use the `/api` namespace to express the
alignment, execution, and trust lifecycle instead of widening the current
`select_and_load_model` allowlist in place. Mesa's internal backend-only
execution API keeps its separate `/v1` namespace:

```text
POST /api/projects/{projectId}/brief/revisions          create an immutable brief revision
POST /api/projects/{projectId}/alignment/revisions      create an immutable mapping revision
POST /api/projects/{projectId}/issues                   record a scoped issue
PATCH /api/projects/{projectId}/issues/{issueId}        resolve or revise an issue
POST /api/projects/{projectId}/attestations             record a scoped review decision
POST /api/projects/{projectId}/scenarios                create a scenario pack
POST /api/projects/{projectId}/experiments/revisions    define an experiment revision
POST /api/projects/{projectId}/runs                     run an exact experiment revision
GET  /api/projects/{projectId}/findings                 inspect artifact-backed findings
POST /api/models                                        create a draft model identity
POST /api/models/{modelId}/revisions                    create an immutable candidate revision
POST /api/projects/{projectId}/model                    select an accessible revision
POST /api/revisions/{revisionId}/suites                 define or import validation evidence
POST /api/revisions/{revisionId}/reviews                request agent or expert review
GET  /api/revisions/{revisionId}/evidence
```

The existing queue-bound APIs remain current implementation facts until Gates
1–4 change implementation, tests, and active contracts together. They are not
the approved future boundary and are deleted at Gate 4 rather than widened or
kept as a fallback.
