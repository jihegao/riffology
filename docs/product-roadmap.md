# Product roadmap: open model creation and progressive trust

## Product thesis

Riff should become a simulation-model creation and validation platform, not a
catalog that permits execution only after a model has already been proven.
Users and modelling agents must be able to create, run, inspect, and revise new
Mesa models before enough evidence exists to call those models trustworthy.

The platform therefore separates two decisions:

1. **Execution admission:** can this revision run without endangering the host,
   another project, credentials, or service availability?
2. **Model trust:** what evidence supports this revision's logic, calculations,
   reproducibility, domain fit, and stated claims?

Execution admission is a mandatory pre-run safety gate. Model trust is a
progressive, claim-scoped process that starts after a draft can run. Passing a
semantic or scientific review is not a prerequisite for private draft runs.

## Invariants retained at every stage

- Every run identifies a server-owned `modelId` and an immutable model
  revision. Immutability supplies identity and lineage; it is not a trust gate.
- Every new revision starts as `draft_unverified`. Evidence is attached to the
  exact revision that produced it, never to a mutable model name.
- Generated model code never runs inside the Mesa API process. Draft execution
  requires an OS/container sandbox with no ambient credentials, no unrestricted
  host filesystem, no network by default, and finite CPU, memory, output, and
  wall-clock limits.
- The platform, not model-generated text or visualization, owns run status and
  artifact identity. Requests, seeds, manifests, logs, raw series, and summaries
  remain auditable.
- Diagrams and Solara views support understanding and inspection. Machine-readable
  specifications plus CSV/JSON test evidence remain the reproducibility source.
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
  traceability.json         # specification rule -> code -> tests -> metrics
  tests/
    datasets/
    expected/
    properties/
```

The model specification is the preferred source for generating class, process,
swimlane, and data-flow diagrams. When a model begins as code, Riff derives a
specification and diagrams, then records unresolved differences as evidence
findings rather than presenting the diagrams as authoritative.

## Trust lifecycle

| State | Execution and visibility | Meaning |
| --- | --- | --- |
| `draft_unverified` | Private sandbox runs | Runnable, but logic and results are not yet validated. |
| `self_tested` | Creator or team sharing | Creator-supplied tests and declared expectations pass. |
| `agent_reviewed` | Experimental publication | Automated specification, implementation, reproducibility, and adversarial checks pass. This is not independent expert review. |
| `expert_reviewed` | Reviewed catalog publication | An identified third party reviewed assumptions, mechanisms, evidence, and claim boundaries. |
| `validated_for_claim` | Decision use within an explicit scope | The exact revision has sufficient evidence for named claims, datasets, and operating ranges. |

A code, dependency, schema, or model-spec change creates a new revision and
returns it to `draft_unverified`. Prior test suites may be replayed automatically,
but prior trust does not silently transfer.

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
- specification-to-code traceability checks and diagram consistency findings;
- independent reproduction records and signed human review decisions.

Failures are retained as first-class evidence. A creator can continue iterating
on a failed draft, while publication and trust promotion policies may require
specific evidence classes to pass.

## Delivery phases

### Phase 0 — bounded trustworthy demo (current)

Keep `queue-network-v1` as the implemented end-to-end fixture. Preserve the
current upload, parameter, seeded run, artifact, timeout, result, OpenCode, and
visible-browser acceptance contracts. This phase proves platform wiring and
reproducibility, not domain validity or general model creation.

### Phase 1 — generic model packages and lineage

- Move queue model constants, schemas, metrics, import logic, and visualization
  metadata behind the model-package contract.
- Add model/revision records, provenance, hashes, and `trustState` to project
  state and run manifests.
- Generate design views and traceability from `model-spec.json`.
- Add a second structurally different reviewed model without changing the
  generic runner, backend state machine, or workbench controls.

**Exit gate:** two different model structures run through the same platform
contracts, and every result resolves to one immutable package revision.

### Phase 2 — creator sandbox and draft execution

- Let users and modelling agents create, import, fork, and revise model packages.
- Perform syntax, interface, schema, dependency, and capability admission checks.
- Run accepted drafts in disposable sandbox workers with quotas and cancellation.
- Mark all draft screens, Solara pages, exports, and assistant summaries as
  unverified; prevent generated prose from upgrading trust.

**Exit gate:** users can iterate on novel models without platform code changes,
and security tests demonstrate project, filesystem, network, secret, resource,
and artifact isolation.

### Phase 3 — Evidence Studio and self-validation

- Provide model-design views, code/spec differences, test dataset management,
  expected-result editors, invariant definitions, seed matrices, and evidence
  reports in one revision-scoped workspace.
- Allow users to construct and run their own validation suites.
- Support reproducible evidence export and independent replay.

**Exit gate:** a user can explain a model through diagrams, trace each important
rule to implementation and tests, reproduce every evidence run, and promote a
revision to `self_tested` without administrator intervention.

### Phase 4 — agent and expert review

- Add separate automated roles for model criticism, spec/code consistency,
  adversarial test generation, reproducibility, numerical review, and evidence
  auditing.
- Record prompts, tools, model versions, findings, disagreements, and reruns.
- Add third-party expert review requests, scoped conclusions, signatures,
  conflicts of interest, expiry, and revocation.

**Exit gate:** automated review is visibly distinguishable from independent
human review, and every promotion is supported by inspectable evidence.

### Phase 5 — governed model catalog and ecosystem

- Publish, search, compare, fork, and reuse model packages and scenario packs.
- Filter by domain, mechanism, license, runtime, trust state, claim scope, and
  evidence freshness.
- Apply stricter publication or decision-use policies by workspace, domain, and
  risk without removing private draft experimentation.

**Exit gate:** creators can move from an unverified idea to a reusable model
with transparent evidence, while consumers can choose models based on fitness
for purpose rather than a universal approval badge.

## API direction

Future contracts should express the lifecycle instead of widening the current
`select_and_load_model` allowlist in place:

```text
POST /v1/models                         create a draft model identity
POST /v1/models/{modelId}/revisions     create an immutable candidate revision
POST /v1/projects/{projectId}/model     select an accessible revision
POST /v1/projects/{projectId}/runs      run it under sandbox policy
POST /v1/revisions/{revisionId}/suites  define or import validation evidence
POST /v1/revisions/{revisionId}/reviews request agent or expert review
GET  /v1/revisions/{revisionId}/evidence
```

The existing MVP APIs and `queue-network-v1` restrictions remain authoritative
until each phase changes the implementation, tests, and active contracts
together.
