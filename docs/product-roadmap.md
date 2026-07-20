# Product positioning and roadmap: business-aligned simulation agents

## Product positioning

Riff is an AI-native simulation Agent work platform for business decisions. It
helps people turn goals, constraints, operational knowledge, data, and uncertain
assumptions into executable simulation experiments, then iterate on those
experiments through computational analysis until the human and the Agent agree on
what question is being tested and what the results mean.

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
   an Agent quickly turn an incomplete business request into a confirmed model,
   scenario set, and experiment definition. Important assumptions and inferred
   requirements must be explicit rather than hidden in generated code or chat.
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
  mappings, scenarios, findings, and approvals must exist as project artifacts,
  not only as prose in a conversation transcript.
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
machine-readable artifacts with explicit provenance and human confirmation.

| Artifact | Purpose |
| --- | --- |
| Decision brief | Decision to be made, goals, constraints, non-goals, stakeholders, time horizon, and unresolved questions. |
| Requirement and assumption map | Business statements, source provenance, Agent inferences, confirmation state, and links to model elements. |
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

The initial north-star metric is **Time to Aligned Experiment**: elapsed time from
a user's business request to human confirmation of a structured, executable
experiment definition.

Supporting measures include:

- percentage of important requirements mapped to model elements, scenarios, and
  metrics;
- number of unresolved critical assumptions at experiment confirmation;
- clarification turns required before the first confirmed experiment;
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
- Every new revision starts as `draft_unverified`. Evidence is attached to the
  exact revision that produced it, never to a mutable model name.
- Generated model code never runs inside the Mesa API process. Draft execution
  requires an OS/container sandbox with no ambient credentials, no unrestricted
  host filesystem, no network by default, and finite CPU, memory, output, and
  wall-clock limits.
- The platform, not model-generated text or visualization, owns run status and
  artifact identity. Requests, seeds, manifests, logs, raw series, summaries, and
  computational analyses remain auditable.
- Material business requirements and assumptions carry provenance and a
  confirmation state. The Agent must not present an inferred requirement as a
  user-approved fact.
- A finding must identify the exact model revision, scenarios, experiments, and
  artifacts that support it. Generated prose cannot silently upgrade either
  alignment or trust.
- Diagrams and interactive views support understanding and inspection.
  Machine-readable specifications plus CSV/JSON evidence remain the
  reproducibility source.
- Trust is scoped to explicit claims, scenarios, datasets, and operating ranges;
  Riff does not label a model universally correct.

## Model package contract

The current bundled queue example becomes the first instance of a generic model
package rather than a permanent special case:

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

The model specification is the preferred source for generating class, process,
swimlane, and data-flow diagrams. When a model begins as code, Riff derives a
specification and diagrams, then records unresolved differences as findings
rather than presenting the diagrams as authoritative.

`traceability.json` should eventually connect both directions: from business
requirements and assumptions into model rules, and from model rules through
parameters, tests, metrics, scenarios, and findings.

## Alignment lifecycle

Alignment state is separate from model trust. A safe, runnable revision may still
be misaligned with the user's intended decision.

| State | Meaning |
| --- | --- |
| `captured` | Initial business request and source material have been recorded. |
| `clarifying` | Critical goals, constraints, data mappings, or assumptions remain unresolved. |
| `proposed` | The Agent has proposed a model and experiment interpretation for review. |
| `confirmed` | A human has accepted the decision brief and experiment definition for the current scope. |
| `reopened` | A requirement, assumption, result, or decision change requires renewed alignment. |

Confirmation is scoped to the current brief, model revision, and experiment plan.
It is not proof that the model is scientifically valid or that its findings are
suitable for a consequential decision.

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

### Phase 0 — bounded executable demo (current)

Keep `queue-network-v1` as the implemented end-to-end fixture. Preserve the
current upload, parameter, seeded run, artifact, timeout, result, OpenCode, and
visible-browser acceptance contracts. This phase proves platform wiring and
reproducibility, not business alignment, domain validity, or general model
creation.

### Phase 1 — business alignment loop

- Add a revisioned decision brief containing the decision goal, constraints,
  metrics, assumptions, non-goals, source provenance, and unresolved questions.
- Let the Agent extract and propose business requirements from conversation and
  uploaded material without silently marking inferences as confirmed.
- Map confirmed requirements and assumptions to the bundled model's parameters,
  rules, scenarios, and metrics.
- Show proposed changes and their impact before applying them to authoritative
  project state.

**Exit gate:** starting from a business description, a user can review and confirm
an inspectable experiment definition and explain how its parameters, scenarios,
and metrics correspond to the intended decision.

### Phase 2 — scenario and computational analysis loop

- Add baseline and alternative scenario packs, parameter sweeps, multi-seed
  experiments, and comparison intent.
- Produce artifact-backed comparative findings with uncertainty, limitations,
  and traceability to exact runs.
- Let the Agent recommend the next experiment and show which requirements,
  assumptions, scenarios, and prior findings would be affected by a change.
- Reopen alignment when a material result or business change invalidates the
  confirmed experiment definition.

**Exit gate:** a user can change a business assumption, compare alternatives, and
receive updated computational findings in one continuous human-Agent workflow.

### Phase 3 — generic model packages and lineage

- Move queue model constants, schemas, metrics, import logic, and visualization
  metadata behind the model-package contract.
- Add model/revision records, provenance, hashes, alignment references, and
  `trustState` to project state and run manifests.
- Generate design views and traceability from `model-spec.json` and the confirmed
  requirement map.
- Add a second structurally different reviewed model without changing the
  generic runner, backend state machine, alignment workflow, or workbench
  controls.

**Exit gate:** two different business problem structures use the same alignment,
model, experiment, and run contracts, and every finding resolves to one immutable
package revision and one confirmed experiment definition.

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

**Exit gate:** a user can explain how the model represents the confirmed business
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

Future contracts should express the alignment, execution, and trust lifecycle
instead of widening the current `select_and_load_model` allowlist in place:

```text
POST /v1/projects/{projectId}/brief                  create or revise a decision brief
POST /v1/projects/{projectId}/alignment/proposals    propose requirement or mapping changes
POST /v1/projects/{projectId}/alignment/confirm      confirm an experiment definition
POST /v1/projects/{projectId}/scenarios              create a scenario pack
POST /v1/projects/{projectId}/experiments            define and execute an experiment plan
GET  /v1/projects/{projectId}/findings               inspect artifact-backed findings
POST /v1/models                                      create a draft model identity
POST /v1/models/{modelId}/revisions                  create an immutable candidate revision
POST /v1/projects/{projectId}/model                  select an accessible revision
POST /v1/projects/{projectId}/runs                   run it under sandbox policy
POST /v1/revisions/{revisionId}/suites               define or import validation evidence
POST /v1/revisions/{revisionId}/reviews              request agent or expert review
GET  /v1/revisions/{revisionId}/evidence
```

The existing MVP APIs and `queue-network-v1` restrictions remain authoritative
until each phase changes the implementation, tests, and active contracts
together.
