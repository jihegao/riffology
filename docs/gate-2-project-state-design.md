# Gate 2 durable project-state design

## Status and authority

This document is the implementation contract for issue #4. It refines the
Gate 0 architecture and backend targets and binds them to the immutable wind
model and artifact contracts delivered by Gate 1. It does not claim that Gate
2 is implemented, reviewed, or accepted.

The backend is the sole authority for durable project state, business
revisions, issues, attestations, workflow-policy calculation, command
idempotency, and browser-safe projections. Mesa remains the authority for
verified model bundles and run artifacts. Browser state, chat text, Agent
prose, generated views, and test-driver observations are projections only.

## Bounded scope

Gate 2 implements:

- server-minted durable project identity, distinct from temporary browser or
  OpenCode session identity;
- one local durable workspace with an exclusive backend writer, atomic current
  snapshots, an append-only project event log, and restart recovery;
- immutable decision-brief, alignment-map, and experiment revisions;
- exact binding of project, brief, alignment, model, experiment, run, event,
  and artifact identities;
- revision-scoped internal issues with append-only discussion and resolution
  events;
- immutable human and Agent attestations that are changed only by explicit
  superseding records;
- a derived, revision-scoped workflow policy with quantitative evidence only;
- safe `private_draft` execution whether or not workflow policy is met, with
  the admission-time policy facts frozen into each run;
- schema-driven experiment edit and reset-to-default operations;
- bounded, allowlisted project projections and deterministic failure behavior;
- compatibility with the Gate 1 wind model bundle and its content-addressed
  default experiment without mutating either.

Gate 2 does not implement authenticated identity, authorization between local
users, remote or multi-user collaboration, a database, distributed writers,
arbitrary model upload or code execution, scientific validation, calibration,
uncertainty analysis, staffing recommendations, generated browser views, or
the final removal of the legacy queue path. Gate 3 owns the workbench and
generated views. Gate 4 owns the live OpenCode browser story and complete queue
cutover.

## Vocabulary and invariants

The following identities are never interchangeable:

| Identity | Form | Meaning |
| --- | --- | --- |
| project | `project_` + 32 lowercase hex | Server-minted durable workspace identity. |
| session | `session_` + 32 lowercase hex | Ephemeral control connection; not restored after restart. |
| actor | `actor_` + 32 lowercase hex | Durable declared local identity. |
| snapshot | non-negative integer | Per-project committed concurrency sequence. |
| decision brief | `dbr_` + 64 lowercase hex | SHA-256 content identity of one immutable revision envelope. |
| alignment map | `amr_` + 64 lowercase hex | SHA-256 content identity of one immutable revision envelope. |
| model | `mr_` + 64 lowercase hex | Existing Gate 1 reviewed bundle identity. |
| experiment | `er_` + 64 lowercase hex | SHA-256 content identity of one immutable experiment envelope. |
| issue | `issue_` + 32 lowercase hex | Server-minted issue identity. |
| issue event | `issue_event_` + 32 lowercase hex | Server-minted immutable issue-history event identity. |
| attestation | `att_` + 32 lowercase hex | Server-minted immutable review record identity. |
| attestation batch | `attb_` + 32 lowercase hex | One atomic command covering one or more exact subjects. |
| run | `run_` + 32 lowercase hex | One Mesa execution identity. |
| command | UUID string | Workspace-global client idempotency key, content-bound to exactly one project; reuse against another project conflicts. |

All IDs are opaque outside their documented family. Every route validates the
entire ID before path construction. A valid ID from a different project is
reported exactly like an unknown ID.

Gate 1 bytes remain governed by the delivered Python
`canonical_json_version`; no Gate 2 change may reserialize, rename, or recompute
a Gate 1 model, experiment, request, artifact, or semantic digest.

All new Gate 2 records use `riff-canonical-json-v2`, a shared Node/Python
implementation of RFC 8785 JSON Canonicalization Scheme. It emits UTF-8 with
recursively sorted keys using UTF-16 code-unit order, preserves array order,
adds no insignificant whitespace, preserves Unicode code points without NFC or
NFD normalization, rejects lone surrogates, and escapes only quotation mark,
reverse solidus, and required JSON control characters. Numbers are finite IEEE
754 binary64 values or safe integers in `[-9007199254740991,
9007199254740991]`; ECMAScript/JCS number serialization is normative, `-0`
serializes as `0`, integral `1.0` serializes as `1`, and exponent casing,
signs, and thresholds follow JCS. Parsers reject duplicate keys, NaN, and
infinities before canonicalization.

Shared golden fixtures, consumed byte-for-byte by Node and Python tests, cover
integer/float equivalence, positive and negative zero, exponent boundaries,
subnormal/large values, UTF-16 key ordering, composed versus decomposed Unicode
(which intentionally remain distinct), quote/reverse-solidus/control escaping,
and non-ASCII UTF-8. Each fixture declares input tokens, expected canonical
hex bytes, and SHA-256. Either implementation differing by one byte fails Gate
2 acceptance.

A Gate 2 content-addressed revision ID is its prefix plus SHA-256 of the v2
canonical revision envelope with the top-level ID field omitted. The stored ID
and bytes must recompute exactly on every read. Unknown fields fail schema
validation; they are not silently dropped before hashing.

Revision envelopes include creation provenance, parent identity, and operation
kind. Therefore an explicit reset creates an auditable new experiment revision
even when its resulting parameter values equal an earlier revision. An
idempotent retry of the same command returns the already-created revision and
does not create another envelope.

## Durable directory layout and writers

```text
WORKSPACE_ROOT/
  .backend-writer.lock
  workspace.json
  workspace-create-events/
    00000000000000000000.json
  workspace-command-index/
    <sha256-of-command-id>.json
  projects/
    <project-id>/
      project.json
      project-events/
        00000000000000000000.json
        00000000000000000001.json
      command-receipts/
        <sha256-of-command-id>.json
      actors/
        <actor-id>.json
      inputs/
      alignment/
        decision-brief/revisions/<dbr-id>/revision.json
        requirement-map/revisions/<amr-id>/revision.json
      issues/
        <issue-id>/
          issue.json
          events/00000000000000000000.json
      attestations/
        <attestation-id>.json
      experiments/
        revisions/<er-id>/experiment.json
      models/
        wind-turbine-maintenance/
          active.json
          revisions/<mr-id>/...
      run-intents/
        <run-id>/
          intent.json
          admission.json
          policy-snapshot.json
          cancel-tombstone.json
      run-reconciliation/
        <run-id>.lease
      run-terminal-evidence/
        <run-id>/<local-terminal-evidence-digest>.json
      mesa-run-receipts/
        <downstream-idempotency-key>.json
      mesa-run-lifecycle/
        <run-id>/events/<zero-padded-sequence>.json
      mesa-run-locks/
        <run-id>.lock
      runs/
        <run-id>/...
      .pending/
      quarantine/
```

The backend owns `project.json`, `project-events`, command receipts, actors,
inputs, brief/alignment revisions, issues, attestations, experiment revisions,
run intents, cancel tombstones, reconciliation leases, and
`run-terminal-evidence`. Mesa owns model materialization,
`models/.../active.json`,
`mesa-run-receipts`, `mesa-run-lifecycle`, `mesa-run-locks`, and run
directories. The backend may read verified Mesa records but never rewrites
them. Mesa may read a backend-owned experiment revision but never modifies it.

Both services use the same configured `WORKSPACE_ROOT`. They reject symlinks in
the root, project path, every traversed ancestor, and every referenced file.
All resolved paths must remain beneath the expected project directory. File
names are derived only from validated IDs or a fixed artifact allowlist.

Exactly one backend process holds an OS-level exclusive lock on
`.backend-writer.lock` for its lifetime. A second writer fails startup rather
than serving mutations. Within that process, a per-project FIFO mutex
serializes commands. Mesa retains its Gate 1 single-owner rules for model and
run families. Read requests may run concurrently against immutable files or a
captured committed snapshot.

`workspace.json`, `workspace-create-events`, and `workspace-command-index` are
backend-owned. The workspace create-event log is authoritative for which
project directories exist. `workspace.json` and both command indexes are
rebuildable caches. Command IDs are unique across the workspace, not merely
within a project; this prevents the same create or mutation command from being
replayed against a second project.

## Immutable revision schemas

All timestamps are server-generated UTC RFC 3339 strings with millisecond
precision. Timestamps are audit facts, not concurrency tokens. Actor and parent
references must already exist in the same project.

### Declared local actor

```ts
type DeclaredLocalActor = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  actor_id: string;
  actor_type: "human" | "agent";
  display_name: string;
  declared_role: "project_owner" | "reviewer" | "operator" | "assistant";
  identity_assurance: "declared_unauthenticated_local";
  created_at: string;
};
```

Actor type and role come from the durable session attachment, not from an
attestation payload. Backend Agent/MCP adapters are permanently attached to an
`agent` actor and cannot select an actor ID, type, or role. Direct local clients
can declare a human identity, but Gate 2 deliberately does not authenticate
that declaration; every projection containing actors or attestations exposes
`declared_unauthenticated_local`.

### Decision-brief revision

```ts
type DecisionBriefRevision = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  decision_brief_revision_id: string;
  project_id: string;
  parent_decision_brief_revision_id: string | null;
  operation: "create" | "revise";
  question: string;
  decision_owner: string;
  objective: string;
  constraints: Array<{ id: string; statement: string; source: SourceRef }>;
  assumptions: Array<{ id: string; statement: string; source: SourceRef }>;
  non_goals: string[];
  sources: SourceRef[];
  created_by_actor_id: string;
  created_at: string;
};

type SourceRef = {
  source_id: string;
  kind: "user_declared" | "bundled_reference" | "uploaded_file";
  label: string;
  attachment_id?: string;
};
```

Source references never contain an absolute path. Uploaded-file references
resolve through a project-owned attachment record.

### Alignment-map revision

```ts
type AlignmentMapRevision = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  alignment_map_revision_id: string;
  project_id: string;
  parent_alignment_map_revision_id: string | null;
  operation: "create" | "revise";
  decision_brief_revision_id: string;
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  entries: Array<{
    mapping_id: string;
    business_ref: string;
    mapping_kind: "requirement" | "assumption" | "constraint" | "non_goal";
    model_refs: string[];
    rationale: string;
    source: SourceRef;
  }>;
  known_gaps: Array<{ gap_id: string; statement: string; blocking: boolean }>;
  created_by_actor_id: string;
  created_at: string;
};
```

`model_refs` are allowlisted identifiers found in the bound model revision's
verified `model-spec.json`, parameter schema, metric schema, or
`traceability.json`; paths and executable expressions are forbidden. The
backend verifies the referenced model bundle before committing the alignment
revision.

### Experiment revision

```ts
type ExperimentRevision = {
  schema_version: 2;
  canonical_json_version: "riff-canonical-json-v2";
  experiment_revision_id: string;
  project_id: string;
  parent_experiment_revision_id: string | null;
  operation: "create" | "edit" | "reset_defaults";
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  brief_revision_id: string;
  alignment_revision_id: string;
  preset_id: string;
  defaults_digest: string; // dd_<64 lowercase hex>
  parameter_defaults: Record<string, JsonScalar>;
  parameters: Record<string, JsonScalar>;
  parameter_diff: Array<{
    parameter_id: string;
    default_value: JsonScalar;
    current_value: JsonScalar;
  }>;
  execution_defaults: {
    horizon_days: number;
    warmup_days: number;
    seed: number;
  };
  execution_values: {
    horizon_days: number;
    warmup_days: number;
    seed: number;
  };
  execution_diff: Array<{
    field: "horizon_days" | "warmup_days" | "seed";
    default_value: number;
    current_value: number;
  }>;
  runtime_profile: RuntimeProfile;
  created_by_actor_id: string;
  created_at: string;
};
```

`JsonScalar` is string, boolean, null, or a finite number. The concrete Gate 1
parameter schema remains authoritative for parameter names, types, units,
ranges, and distribution families. `parameter_defaults` is the complete
normalized parameter section of the bound default preset. `parameters` is the
complete normalized current parameter set, never a sparse patch.
`parameter_diff` is sorted by `parameter_id` and contains exactly the entries
for which canonical values differ. `execution_defaults` and
`execution_values` separately cover every editable non-parameter execution
value: horizon, warm-up, and seed. `execution_diff` is sorted in the fixed order
`horizon_days`, `warmup_days`, `seed`. `defaults_digest` covers both default
objects and the preset identity.

Exactly, `defaults_digest` is `dd_` plus SHA-256 of
`riff-canonical-json-v2` bytes for this object and no other fields:

```json
{
  "preset_id": "<preset-id>",
  "parameter_defaults": { "<every-parameter-id>": "<normalized-value>" },
  "execution_defaults": {
    "horizon_days": 1095,
    "warmup_days": 365,
    "seed": 2
  }
}
```

The displayed parameter value is schematic; actual values retain their
normalized JSON scalar types. Node and Python independently rebuild this exact
object from the verified preset, canonicalize it, and require the same `dd_`
value during revision creation, Mesa admission, worker startup, and final run
verification. Tests mutate each component and cover key-order/numeric golden
cases.

The experiment carries the same normalized execution inputs, runtime profile,
horizon, warm-up, and seed semantics as Gate 1. A Gate 2 adapter extends the
worker-side schema for non-null business bindings without reconstructing the
revision. Runtime profile is locked by the model revision and is not a user
editable Gate 2 value; changing it requires a new model/runtime revision. The
backend validates the final document against the bound model revision's v2
experiment contract before committing it. It does not copy user-supplied
derived fields, defaults, diffs, runtime profile, or upstream IDs.

The Gate 2 experiment envelope deliberately contains **no** issue IDs,
attestation IDs, endorsement counts, open-issue counts, `policy_satisfied`,
`workflow_policy`, workflow label, or promotion state. Those facts can change
without changing the experiment definition and therefore must not participate
in `experiment_revision_id`. `draft_unverified` is likewise supplied as the
run's admission-time trust label, not used to turn an endorsement into a new
experiment identity. The exact same `er_...` may consequently produce separate
runs with different frozen workflow-policy snapshots; the experiment bytes
remain identical.

Gate 1's bootstrap experiment uses the delivered Gate 1 compatibility shape;
its canonical bytes contain null brief/alignment fields and a fixed
`workflow_policy_unmet`/`draft_unverified` pair. Gate 2 does not reinterpret or
rehash that record. New backend-authored experiments use this Gate 2 schema and
keep mutable policy facts exclusively in run admission.

Rule meaning, units, ranges, distribution families, state transitions, and
metric formulas are not experiment edits. Such requests fail with
`422 model_revision_required`.

## Revision-chain transition contract

Clients submit authored fields but never IDs, hashes, defaults, diffs, current
pointers, or timestamps. The exact full payloads are:

```ts
type CreateOrReviseBrief = {
  operation: "create" | "revise";
  parent_decision_brief_revision_id: string | null;
  question: string;
  decision_owner: string;
  objective: string;
  constraints: Array<{ id: string; statement: string; source: SourceRef }>;
  assumptions: Array<{ id: string; statement: string; source: SourceRef }>;
  non_goals: string[];
  sources: SourceRef[];
};

type CreateOrReviseAlignment = {
  operation: "create" | "revise";
  parent_alignment_map_revision_id: string | null;
  decision_brief_revision_id: string;
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  entries: AlignmentMapRevision["entries"];
  known_gaps: AlignmentMapRevision["known_gaps"];
};

type CreateExperiment = {
  operation: "create";
  parent_experiment_revision_id: null;
  brief_revision_id: string;
  alignment_revision_id: string;
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  preset_id: string;
  parameters: Record<string, JsonScalar>;
  execution_values: {
    horizon_days: number;
    warmup_days: number;
    seed: number;
  };
};

type EditExperiment = {
  operation: "edit";
  parent_experiment_revision_id: string;
  parameter_changes: Record<string, JsonScalar>;
  execution_changes: Partial<{
    horizon_days: number;
    warmup_days: number;
    seed: number;
  }>;
};

type ResetExperiment = {
  operation: "reset_defaults";
  parent_experiment_revision_id: string;
};
```

Brief `create` is legal only when the current brief is null and its parent is
null. Brief `revise` requires a non-null parent exactly equal to the current
brief. Alignment follows the same create/revise rule for its own parent and
must bind the exact current brief and exact Mesa-authoritative active model
tuple. Experiment `create` is legal only when current experiment is null, its
parent is null, and its brief/alignment/model/preset tuple equals the current
brief, current alignment, the alignment's bindings, and the verified active
model. Experiment edit/reset requires its parent to equal current experiment;
the upstream tuple is inherited and cannot appear in the payload.

The server derives and validates complete values before hashing. A create must
provide every editable parameter and every execution value. Edit changes must
be non-empty and produce at least one canonical value change. Reset restores
every parameter and execution value from the currently bound verified default
preset. The complete post-edit execution tuple must satisfy the model contract,
including integer seed/horizon/warm-up bounds and `warmup_days < horizon_days`.
Runtime profile is never editable.

Pointer transitions are atomic with revision creation:

| Committed event | New current pointer | Cleared downstream pointers | Phase |
| --- | --- | --- | --- |
| `model.selected` bootstrap event | model | alignment, experiment, run | `align` |
| `brief.revision_created` | brief | alignment, experiment, run | `align` |
| `alignment.revision_created` | alignment | experiment, run | `configure` |
| `experiment.revision_created` | experiment | run | `review` |
| issue or attestation event | none | none | unchanged, normally `review` |
| client `run.intent_committed` | run | none | `run` |
| run reconciliation event | run-index entry always | none | current run/phase only under the equality rule below |

Clearing a current pointer never deletes its immutable revision, issues,
attestations, or historical runs. Policy projections include only the exact
current subjects. If Mesa reports a different active model revision, the
backend first commits `model.selected` and invalidates downstream pointers; it
never silently rebinds an alignment or experiment.

While `current.run_id` resolves to a non-terminal `PendingRunReference`, every
command that would change the current model, brief, alignment, or experiment
pointer returns `409 active_run_conflict` with no event or snapshot increment.
Starting another run is rejected by the same rule. Issue, comment, attestation,
cancel, and read operations remain available. After that current run becomes
terminal, pointer mutation and a later run are allowed normally.

Every queued/running/terminal system event always advances the named run's
entry in `run_index`. It changes `current.run_id` or `phase` only when the
snapshot immediately before the event still has `current.run_id` equal to that
event's `run_id`. A terminal event for the still-current run sets phase to
`inspect`; an event for a historical run leaves the newer current pointer and
phase byte-identical. Thus a late historical observation cannot rewind a
project after a terminal run was cleared by a revision change or replaced by a
later run.

A parent that exists but is not current returns `409 revision_not_current`.
An upstream tuple mismatch returns `409 upstream_revision_mismatch`. Unknown or
cross-project parents return `404`. A current-pointer transition with no actual
new revision is rejected as `422 no_effective_change`. Tests cover stale brief,
alignment, and experiment parents; alignment against stale brief/model;
experiment against stale brief/alignment/model/preset; and all pointer/phase
invalidation rows. Concurrency tests race each pointer mutation and a second
run against an active run, then race historical run events against a terminal-
then-revised or later-run snapshot.

## Project snapshot and event schemas

`project.json` is a replaceable cache of the latest committed state, not the
transaction commit point:

```ts
type DurableProjectSnapshot = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  display_name: string;
  snapshot_revision: number;
  snapshot_digest: string;
  previous_event_digest: string | null;
  phase: "brief" | "align" | "configure" | "review" | "run" | "inspect";
  current: {
    decision_brief_revision_id: string | null;
    alignment_map_revision_id: string | null;
    model_revision_id: string | null;
    experiment_revision_id: string | null;
    run_id: string | null;
  };
  actor_ids: string[];
  issue_index: IssueSummary[];
  attestation_index: AttestationSummary[];
  run_index: RunReference[];
  created_at: string;
  updated_at: string;
};
```

The canonical snapshot digest omits only `snapshot_digest`. Index entries are
bounded summaries and immutable-record references; complete histories are not
embedded.

`RunReference` is a discriminated projection, not an immutable record:

```ts
type RunReferenceIdentity = {
  project_id: string;
  run_id: string;
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  brief_revision_id: string;
  alignment_revision_id: string;
  experiment_revision_id: string;
  preset_id: string;
  seed: number;
  visibility: "private_draft";
  trust_label: "draft_unverified";
  workflow_label: "workflow_policy_met" | "workflow_policy_unmet";
  policy_snapshot_digest: string;
  run_admission_digest: string;
  run_intent_digest: string;
};

type PendingRunReference = RunReferenceIdentity & {
  reference_kind: "pending";
  status: "dispatch_pending" | "queued" | "running" | "cancellation_requested";
  terminal_metadata_digest?: never;
  artifact_ids?: never;
};

type TerminalRunReference = RunReferenceIdentity & ({
  reference_kind: "terminal";
  status: "succeeded";
  terminal_evidence_source: "mesa_terminal_metadata";
  terminal_metadata_digest: string;
  verified_success: true;
  artifact_ids: string[]; // exact eight verified declared artifacts
  cancel_outcome: null | "completed_before_cancel_effect";
} | {
  reference_kind: "terminal";
  status: "failed";
  terminal_evidence_source:
    | "mesa_terminal_metadata" | "local_run_terminal_evidence";
  terminal_metadata_digest: string;
  verified_success: false;
  artifact_ids?: never;
  cancel_outcome: null | "failed_before_cancel_effect";
} | {
  reference_kind: "terminal";
  status: "timed_out";
  terminal_evidence_source: "mesa_terminal_metadata";
  terminal_metadata_digest: string;
  verified_success: false;
  artifact_ids?: never;
  cancel_outcome: null | "timed_out_before_cancel_effect";
} | {
  reference_kind: "terminal";
  status: "cancelled";
  terminal_evidence_source:
    | "mesa_terminal_metadata" | "local_run_terminal_evidence";
  terminal_metadata_digest: string;
  verified_success: false;
  artifact_ids?: never;
  cancel_outcome: "cancelled_before_dispatch" | "cancelled_by_worker";
});

type RunReference = PendingRunReference | TerminalRunReference;
```

`run.intent_committed` first inserts a pending reference. Later append-only
ProjectEvents replace that entry in the mutable `run_index` projection without
editing any intent/admission/lifecycle record. Current run may therefore be
pending or terminal. Pending references carry no terminal digest or artifact
IDs. Only a verifier-backed `succeeded` terminal reference carries artifact
IDs; failure, timeout, and cancellation never do.

Pre-dispatch terminal outcomes have no Mesa run metadata. The backend records
them in this immutable evidence family instead of writing a Mesa-owned file:

```ts
type LocalRunTerminalEvidence = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  local_terminal_evidence_digest: string; // lte_<64 lowercase hex>
  project_id: string;
  run_id: string;
  terminal_status: "cancelled" | "failed";
  outcome_code: "cancelled_before_dispatch" | "pre_receipt_admission_failed";
  run_intent_digest: string;
  run_admission_digest: string;
  policy_snapshot_digest: string;
  downstream_idempotency_key: string;
  downstream_request_digest: string;
  cancel_tombstone_digest: string | null;
  evidence_base_snapshot_revision: number;
  evidence_base_project_event_digest: string;
  mesa_receipt_absent: true;
  dispatch_owner_absent: true;
  failure: null | { code: string; safe_message: string };
  created_at: string;
};

type CancelTombstone = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  cancel_tombstone_digest: string; // ct_<64 lowercase hex>
  project_id: string;
  run_id: string;
  cancel_command_id: string;
  cancel_command_digest: string;
  requested_by_actor_id: string;
  requested_at_snapshot_revision: number;
  created_at: string;
};
```

`local_terminal_evidence_digest` is `lte_` plus SHA-256 of its exact v2
canonical bytes with only that field omitted. The file path is
`run-terminal-evidence/<run-id>/<lte-digest>.json`. The evidence base is the
committed pre-terminal project snapshot. `cancelled_before_dispatch` requires a
matching immutable cancel tombstone and null failure. A
`pre_receipt_admission_failed` record requires a stable sanitized admission
failure and no tombstone unless cancellation independently occurred. Both
require a Mesa receipt lookup by downstream key and no live/in-flight backend
dispatch owner at their linearization point.

The cancel tombstone digest is `ct_` plus SHA-256 of its exact v2 canonical
bytes with only that field omitted. The cancellation client ProjectEvent
references it before any system terminal evidence can do so.

The following system terminal ProjectEvent includes a `record_ref` of kind
`local_run_terminal_evidence` with this exact ID/digest and projects a terminal
reference whose `terminal_evidence_source` is
`local_run_terminal_evidence` and whose `terminal_metadata_digest` is the
`lte_` digest. All worker-reached terminal references instead use
`mesa_terminal_metadata` and the independently verified Mesa metadata digest.
Succeeded/timed-out can never cite backend local evidence.

Recovery recomputes the local evidence digest and all intent/admission/policy/
tombstone/base-event links before replaying its terminal ProjectEvent. Missing,
unreferenced, cross-run, or changed evidence makes the run/project fail closed.
If a receipt appears after local cancellation, recovery requires the Mesa
lifecycle to converge to terminal cancelled without a worker; any other state
is corruption. A receipt after `pre_receipt_admission_failed` is corruption.
The backend never creates or edits Mesa-owned
`runs/<run-id>/metadata.json`; that path and every worker terminal metadata
record remain Mesa-only.

Each accepted client command and each independently idempotent system
transition commits one project event:

```ts
type ProjectEvent = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  snapshot_revision: number;
  previous_snapshot_revision: number | null;
  previous_event_digest: string | null;
  event_digest: string;
  command_id: string;
  command_digest: string;
  initiator: "workspace_create" | "client" | "system";
  session_id: string | null;
  actor_id: string | null;
  system_component: null | "backend_run_reconciler" | "backend_model_reconciler";
  event_type: string;
  record_refs: Array<{ kind: string; id: string; digest: string }>;
  state_patch: JsonPatchOperation[];
  response_projection: Record<string, unknown>;
  committed_at: string;
};
```

`event_digest` omits only itself. `state_patch` is sufficient to reproduce the
next durable snapshot from the prior snapshot. Event file number equals
`snapshot_revision`; revisions start at zero with `project.created`. The hash
chain, file number, command digest, record digests, and resulting snapshot
digest are validated during recovery. Ordinary client events require their
committed session, non-null actor, and null `system_component`. Event zero uses
`workspace_create`, null session, the non-null initial actor, and null system
component. System events require null session, null actor, and one allowlisted
`system_component`, with an internal command/event ID that clients cannot
submit. A system component is never an actor record, session principal,
attestation author, or candidate for any endorsement count.
Only `workspace_create` and `client` command IDs populate the global client
command index; system IDs are de-duplicated by their run transition key.

## Workspace-level project creation and sessions

Project creation has no pre-existing project or session, so it uses a separate
workspace transaction:

```ts
type CreateProjectRequest = {
  command_id: string;
  display_name: string;
  initial_actor: {
    actor_type: "human";
    display_name: string;
    declared_role: "project_owner";
  };
};

type WorkspaceCreateEvent = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  workspace_revision: number;
  previous_event_digest: string | null;
  event_digest: string;
  command_id: string;
  command_digest: string;
  project_id: string;
  project_event_zero_digest: string;
  project_snapshot_zero_digest: string;
  initial_actor_id: string;
  initial_actor_digest: string;
  committed_at: string;
};
```

The creation command digest covers the exact normalized route and request. The
durable response contains only project and initial-actor projections; session
attachment is a separate ephemeral call. The initial actor is always a human
`project_owner` with `declared_unauthenticated_local`. Project creation cannot
bootstrap an Agent actor or accept caller-selected project/actor IDs.
Project event zero repeats the create command ID/digest for audit linkage, but
the global command index derives that transaction only from its committed
`WorkspaceCreateEvent`; event zero is not indexed as a second command.

Under the workspace create mutex the backend:

1. looks up the workspace-global command ID and returns/conflicts before doing
   any allocation;
2. mints project and actor IDs, builds the actor, project event zero, and
   snapshot zero under a pending project directory, and flushes all bytes;
3. atomically renames that whole directory to `projects/<project-id>`; this
   makes it durable but not yet reachable;
4. writes, flushes, and renames the next `WorkspaceCreateEvent`; that rename is
   the project-creation commit point;
5. atomically rewrites `workspace.json` and the global command-index cache.

On recovery, committed workspace events are the only source of project
membership. A project directory with no committed workspace event is a
precommit orphan and is quarantined. An event committed while `workspace.json`
or its command-index entry is missing is replayed and indexed. Missing project
event zero, mismatched event/snapshot/actor digests, duplicate project ID,
event gap/hash failure, or two committed commands claiming one project marks
the workspace index corrupt and prevents creates or project opens until
repaired; the service never chooses one arbitrarily. Concurrent creates are
serialized and yield distinct IDs. An exact repeated create command returns
the original durable project/actor result; a changed request, or reuse of that
command against any project route, returns `409 command_id_conflict`.

`POST /api/projects/{projectId}/sessions` accepts an existing durable actor ID
and returns a new ephemeral session. It neither writes a project event nor
promises the same session ID on retry. After restart all sessions expire and a
new attachment is required for new work.

Later durable actors are created through
`POST /api/projects/{projectId}/actors` using the normal project command
envelope. Only a live attached human `project_owner` may declare another local
human or Agent actor. The Agent adapter has no actor-creation capability, never
receives this route, and cannot enter the human declaration path. The command
creates the actor and project event atomically; exact retry returns the same
actor even after restart.

For every command, the server parses enough of the request to find
`command_id`, then checks the workspace-global committed command index and
compares the normalized request digest **before** checking whether its recorded
session is still live. Thus an exact retry after restart returns the stored
durable result even with the original expired session ID. Only an unseen
command proceeds to live-session, actor, base-revision, and permission checks.
Ephemeral session material is never stored in a durable command response.

## Atomic commit and restart recovery

For each state-changing command the backend performs these steps in order:

1. Under the workspace command mutex, check the global committed command index
   and atomically reserve an unseen command ID. A competing request waits for
   the in-process owner and then returns the committed result or conflict.
2. Acquire the project FIFO mutex. For an unseen command, validate the exact
   request schema, live session/project/actor binding, base
   revision, all referenced records, model bundle, sizes, and policy-neutral
   domain rules without changing disk.
3. Build immutable records and the resulting snapshot entirely in memory.
4. Write each new immutable record beneath a transaction directory in
   `.pending`, flush file content, atomically rename it to its final location
   with no overwrite, and flush each parent directory. Existing identical
   content is accepted; any differing collision is corruption.
5. Write and flush the next project-event temporary file. Atomically rename it
   to the zero-padded final event name and flush `project-events`. This rename
   is the transaction commit point.
6. Write the resulting `project.json.tmp`, flush it, atomically replace
   `project.json`, and flush the project directory.
7. Atomically publish the project receipt and workspace-global command-index
   entry from the reservation, then return the event's stored durable response
   projection.

Immutable records written before step 5 but not referenced by a committed
event are unreachable orphans, not state. Startup moves abandoned `.pending`
transactions and unreferenced temporary files to `quarantine` with a local
diagnostic. They are never inferred as successful commands.

Recovery is deterministic:

- validate project ID and reject symlinks before reading files;
- validate the last usable `project.json` and its digest if present;
- scan sorted project-event names, rejecting duplicates, gaps, invalid hash
  links, invalid patches, or references to missing/digest-mismatched records;
- if the snapshot is behind, replay all contiguous later committed events and
  atomically rewrite the cache;
- if the snapshot is absent or malformed, rebuild from event zero;
- if the snapshot is ahead of the event log, an event is corrupt, or a
  committed event references missing bytes, mark only that project unavailable
  with `500 project_corrupt`; never roll back, skip the event, invent a pointer,
  or expose partial state;
- rebuild missing or stale project receipts and the workspace-global command
  index from committed workspace/project events before accepting commands;
- recover dispatch-pending run intents using the downstream idempotency key;
- treat sessions as expired; clients attach a new session to the same project
  and durable actor.

An interrupted `project.json` write is therefore recoverable; an invalid
committed hash chain is explicitly not auto-repaired.

## Commands, concurrency, and idempotency

Every durable mutation after a session is attached uses this envelope:

```ts
type ProjectCommand<T> = {
  command_id: string;
  project_id: string;
  session_id: string;
  base_snapshot_revision: number;
  payload: T;
};
```

The route project ID must equal the envelope project ID. The session must be
currently attached to that project and a durable actor. The canonical command
digest covers method, normalized route, and the entire envelope except
transport-only headers. The committed event separately freezes the actor ID
resolved from the session. On retry, request-digest comparison needs no live
session lookup; a new command is the only path that resolves and validates the
session actor.

Within a project, accepted commands form one total order. Commands for distinct
projects may commit concurrently after obtaining distinct workspace-global
command reservations. The server never performs last-write-wins merges.

Idempotency rules are exact:

- a committed `command_id` with the same command digest returns its original
  status code and response, even if its base revision is now stale;
- the same ID with different bytes, method, route, actor, or project returns
  `409 command_id_conflict`;
- an unseen command whose base differs from current returns
  `409 stale_snapshot` with only the current `snapshot_revision`;
- validation failures release the transient reservation and do not create a
  committed command-index entry;
- a response lost after commit is safely recoverable by retry;
- each successful mutation increments the snapshot revision exactly once.

State mutations return only after the event commit point. Revision creation
returns `201`; issue/attestation/current-state changes return `200`. Run start
returns `202` only after its durable intent and exact identity/policy snapshot
are committed and downstream dispatch has an idempotent recovery path. A `202`
does not imply execution success.

### Routes

| Method and route | Exact Gate 2 behavior |
| --- | --- |
| `POST /api/projects` | Idempotently create a server-ID project, initial human actor, event zero, and snapshot; no project envelope because the project does not yet exist. |
| `POST /api/projects/{projectId}/sessions` | Attach a new ephemeral session to one existing actor; no durable mutation. |
| `POST /api/projects/{projectId}/actors` | An attached human project owner declares one durable local actor. |
| `POST /api/projects/{projectId}/wind/bootstrap` | Explicitly ask Mesa to materialize/verify the Gate 1 wind bundle in this already-created project and commit the active-model pointer. |
| `GET /api/projects/{projectId}/snapshot` | Return a bounded browser-safe projection of one committed snapshot. |
| `GET /api/projects/{projectId}/events` | Send a snapshot then ordered RFC-6902 patches; `Last-Event-ID` gaps require snapshot reload. |
| `POST /api/projects/{projectId}/brief/revisions` | Create one immutable brief and make it current. |
| `POST /api/projects/{projectId}/alignment/revisions` | Create one immutable alignment revision and make it current. |
| `POST /api/projects/{projectId}/issues` | Open an issue against one or more exact revisions. |
| `POST /api/projects/{projectId}/issues/{issueId}/comments` | Append a discussion event. |
| `PATCH /api/projects/{projectId}/issues/{issueId}` | Append assign, resolve, close, or reopen event; resolve/close/reopen requires a reason. |
| `POST /api/projects/{projectId}/attestations` | Atomically create one immutable attestation per exact subject in a batch. |
| `POST /api/projects/{projectId}/experiments/revisions` | Create/edit/reset one complete immutable experiment and make it current. |
| `POST /api/projects/{projectId}/runs` | Admit an exact saved experiment as a private draft and dispatch it idempotently to Mesa. |
| `POST /api/projects/{projectId}/runs/{runId}/cancel` | Cancel only a run bound to this project; terminal runs are idempotent. |
| `GET /api/projects/{projectId}/runs/{runId}/events` | Return a bounded page of browser-safe Gate 1 domain events. |
| `GET /api/projects/{projectId}/artifacts/{artifactId}` | Return only a declared artifact bound to a project-owned run. |

Project creation takes its own top-level `command_id`, display name, and
initial human-owner declaration and returns only durable project/actor data.
Session attachment takes a project ID and existing actor ID, returns a newly
minted session, and persists nothing. Actor declaration is a separate
idempotent durable project command by an already attached human project owner.
All subsequent mutation payloads reject extra keys.

### Run dispatch

Before run admission, the backend rereads and verifies the model bundle and
experiment bytes, recomputes every bound revision ID, verifies project
ownership, and captures the admission policy described below. The backend
persists a run intent before calling Mesa. It uses the originating command ID
as a downstream idempotency key, so a crash after Mesa accepts a run but before
the backend stores the response cannot create a second run. Mesa must return
the same `run_id` for the same key/request digest and `409` for a reused key
with different bytes.

The Gate 1 direct `/v1` request remains exactly
`{"experiment_revision_id":"er_..."}`; the idempotency key is an internal
header, not an extra body field. Gate 2 expands Mesa lookup from the Gate 1
bundled default experiment to any verified, project-owned Gate 2 experiment
whose model revision equals the verified active wind model. It does not create
an implicit schema union or fall back to queue execution.

For Gate 2, Mesa loads the exact `experiment.json` bytes at the requested
content-addressed path and validates the Gate 2 schema; it must not reconstruct
that experiment with Gate 1's `build_experiment_document`, replace its
brief/alignment bindings with null, or inject a current workflow-policy value
before recomputing the `er_...` digest. The backend-owned run intent supplies a
separate immutable `RunAdmission` document to the worker. The worker copies
policy/trust labels and `policy_snapshot_digest` from that admission document
into request and artifact metadata without making them part of the experiment
revision hash.

### Immutable run intent and admission

The backend pre-mints the final `run_id`; Mesa never substitutes another ID.
Before the `run.intent_committed` project event, the backend stores these exact
v2 canonical records:

```ts
type RunAdmission = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  run_admission_digest: string; // ra_<64 hex>
  project_id: string;
  run_id: string;
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  brief_revision_id: string;
  alignment_revision_id: string;
  experiment_revision_id: string;
  experiment_sha256: string;
  policy_snapshot: PolicySnapshot;
  policy_snapshot_digest: string;
  visibility: "private_draft";
  trust_label: "draft_unverified";
  workflow_label: "workflow_policy_met" | "workflow_policy_unmet";
  admission_base_snapshot_revision: number;
  admission_base_project_event_digest: string;
  created_at: string;
};

type RunIntent = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  run_intent_digest: string; // ri_<64 hex>
  project_id: string;
  run_id: string;
  command_id: string;
  command_digest: string;
  downstream_idempotency_key: string; // rk_<64 hex>
  downstream_request_digest: string;  // rq_<64 hex>
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  brief_revision_id: string;
  alignment_revision_id: string;
  experiment_revision_id: string;
  experiment_sha256: string;
  policy_snapshot_digest: string;
  run_admission_digest: string;
  created_at: string;
};
```

Each prefixed digest is SHA-256 of its v2 canonical object with only its own
digest field omitted. `experiment_sha256` is the unprefixed SHA-256 of the
exact saved canonical experiment bytes. `downstream_idempotency_key` is a
domain-separated SHA-256 of project ID plus command ID;
`downstream_request_digest` covers project/run IDs, the exact direct Mesa body,
experiment SHA, admission digest, and model revision. The intent and admission
must cross-reference the same identities/digests or the command fails before
commit.

`admission_base_snapshot_revision` and
`admission_base_project_event_digest` name the committed **pre-intent** state
from which policy was calculated. They must equal, respectively,
`PolicySnapshot.evaluated_at_snapshot_revision` and
`PolicySnapshot.evaluated_project_event_digest`. `RunAdmission` contains no
RunIntent or intent-event reference. `RunIntent` points one-way to
`run_admission_digest`, and the later `run.intent_committed` ProjectEvent points
one-way to both record digests. This acyclic order permits independent
policy -> admission -> intent -> project-event recomputation; tests recompute
each digest in that order and reject any back-reference or cycle.

The backend-to-Mesa call uses the unchanged body plus exact headers
`Idempotency-Key: <downstream_idempotency_key>`,
`X-Riff-Run-Id: <run_id>`, and
`X-Riff-Request-Digest: <downstream_request_digest>`. These headers are
backend-only and never caller-selectable through `/api`.

Mesa's durable downstream receipt is written and flushed before it creates the
run temporary directory or spawns a worker:

```ts
type MesaRunReceipt = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  mesa_run_receipt_digest: string; // mrr_<64 hex>
  downstream_idempotency_key: string;
  downstream_request_digest: string;
  project_id: string;
  run_id: string;
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  experiment_revision_id: string;
  experiment_sha256: string;
  policy_snapshot_digest: string;
  run_admission_digest: string;
  run_intent_digest: string;
  captured_request_sha256: string;
  ownership_epoch: number;
  accepted_at: string;
};
```

The same key and request digest always returns the same pre-minted run ID. The
same key with a different digest or run ID returns `409 downstream_key_conflict`.
`mesa_run_receipt_digest` is independently recomputed from every bound field.
The receipt is never inferred from a worker directory.

### Mesa single-owner lifecycle

A receipt is admission evidence, not proof that a run is queued, running, or
terminal. Mesa maintains a second append-only lifecycle chain:

```ts
type MesaLifecycleRecord = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  mesa_lifecycle_digest: string; // mlr_<64 hex>
  project_id: string;
  run_id: string;
  sequence: number;
  previous_mesa_lifecycle_digest: string | null;
  ownership_epoch: number;
  owner_instance_id: string;
  state:
    | "receipt_committed" | "ownership_acquired" | "temp_prepared"
    | "spawn_intent" | "worker_started" | "cancel_requested"
    | "worker_exited" | "verified_succeeded" | "terminal_failed"
    | "terminal_timed_out" | "terminal_cancelled";
  receipt_digest: string;
  run_intent_digest: string;
  run_admission_digest: string;
  policy_snapshot_digest: string;
  experiment_sha256: string;
  captured_request_sha256: string;
  child_identity: null | {
    pid: number;
    process_start_token: string;
    spawn_nonce: string;
    executable_sha256: string;
    request_sha256: string;
  };
  evidence_digest: string | null;
  created_at: string;
};
```

`mesa_lifecycle_digest` covers the exact v2 canonical record with only itself
omitted. Sequence and previous digest are gap-free. Every lifecycle write,
receipt creation, temp-directory preparation, spawn decision, cancel signal,
child handshake, and terminal promotion is serialized by an OS-backed per-run
reconciliation lock. An ownership epoch is monotonically incremented when a
new Mesa service instance takes responsibility after verifying the prior
owner is unavailable. Each service has a boot-unique `owner_instance_id`.

Spawn uses a durable `spawn_intent` with a fresh nonce before process creation.
The worker receives that nonce and captured request SHA and, before writing any
domain output, records `worker_started` under the same per-run lock with PID,
OS process start token, executable digest, nonce, and request digest. PID alone
never identifies a child: PID reuse, wrong start token, executable, nonce, or
request digest is treated as a different process and never signalled or adopted.
Only the verified child identity may write that run's temporary output.

Every start call, including an exact duplicate, enters `ensure_run` under the
per-run lock. It verifies receipt plus the complete lifecycle and advances a
recoverable run toward one verified active worker or one terminal state; it
does not merely return the receipt. Mesa startup performs the same reconciliation
for every committed receipt before serving start/cancel/status calls.

Recovery cases are explicit:

- receipt only, no temp: verify all captured bindings, create the temp scaffold,
  append `temp_prepared`, then continue toward spawn;
- receipt only, valid temp created before its record: verify it contains only
  the exact captured request/scaffold, append `temp_prepared`, and continue;
- `temp_prepared`, temp missing or digest-drifted: append terminal corruption
  failure; never reconstruct over evidence that was already declared durable;
- valid temp before spawn and no spawn intent: append spawn intent and spawn
  once;
- spawn intent with no `worker_started`: identify a child only by full nonce/
  start-token/executable/request identity; if none exists and no domain output
  exists, append a new ownership epoch/spawn intent and retry once; otherwise
  fail closed rather than double-spawn;
- verified active child: preserve/adopt it under a new monitoring ownership
  epoch if necessary, reconcile its lifecycle/heartbeat, and never spawn;
- orphan/dead verified child without terminal evidence: record `worker_exited`,
  preserve temp evidence, and terminate failed; simulation does not resume from
  partial domain output;
- PID reused or unrelated orphan process: never signal/adopt it; reconcile only
  the durable run evidence;
- identity/hash/lifecycle drift, two child identities, sequence gaps, or two
  terminal records: mark the run corrupt and never spawn/write/promote;
- worker terminal evidence: independently verify the captured request and
  outputs, then append exactly one terminal lifecycle record.

The API may project Mesa `queued` only from a verified valid temp plus durable
spawn intent, and `running` only from a verified `worker_started` identity that
is still active. Receipt existence alone projects only `accepted`. Success is
not terminal until the parent verifier validates and atomically promotes the
exact eight artifacts and appends `verified_succeeded`. No two service owners
or workers may write the same run concurrently.

### Run lifecycle and reconciliation

Authoritative backend run state is projected only by append-only
`ProjectEvent`s; receipts, leases, Mesa lifecycle files, process observations,
and directories never mutate `run_index` directly. Provenance is strict:

- `run.intent_committed` is the successful `POST /runs` **client** event. It
  has the live human/Agent actor and session from the command, the workspace-
  global client command ID/digest, and the durable command receipt.
- `cancellation_requested` is the successful cancel **client** event with the
  same actor/session/command/receipt requirements and its cancel-tombstone ref.
- `queued`, `running`, local/Mesa terminal, and other reconciliation changes
  are **system** events with null actor/session and
  `system_component: backend_run_reconciler`.

Every committed client or system ProjectEvent increments `snapshot_revision`
exactly once. An idempotent retry or duplicate system observation returns its
existing projection and emits no new event or increment.

The resulting event state machine is:

```text
dispatch_pending -> queued -> running -> succeeded
        |                     |       -> failed
        |                     |       -> timed_out
        |                     |       -> cancellation_requested -> cancelled
        |                     |                                  -> succeeded
        |                     |                                  -> failed
        |                     |                                  -> timed_out
        +-> failed
dispatch_pending/queued ------+-----------------------> cancellation_requested
```

The backend reserves a non-client `system_...` event ID for each system transition;
it is deterministically derived from project ID, run ID, target status, and the
source receipt/metadata digest, so restart observation produces the same ID.
Clients cannot submit that namespace. Every transition event references the
intent, admission, Mesa receipt or terminal metadata digest as applicable.
Its command digest is independently derived from the canonical transition
kind, prior run state, source lifecycle digest, and target state; it does not
depend on an actor or session.
Duplicate observation of the same downstream state is a no-op and creates no
snapshot. Backward transitions and changes from a terminal state are
corruption, not tolerated eventual consistency.

`POST /runs` returns the stored `202` response immediately after the local
`run.intent_committed` event commit point:

```json
{
  "run_id": "run_...",
  "status": "dispatch_pending",
  "snapshot_revision": 17,
  "location": "/api/projects/project_.../runs/run_..."
}
```

That same event places the immutable run reference in `run_index`, sets
`current.run_id`, and changes phase to `run`. `202` means only durable local
admission; the reconciler repeatedly presents the pre-minted ID, exact body,
idempotency key, and request digest to Mesa until it obtains the matching
durable receipt or commits an explicit terminal admission failure.

All backend dispatch, status publication, cancellation, and terminal
publication for one run are linearized by one per-run reconciliation mutex and
lease. Before an external Mesa call the holder rereads committed ProjectEvents,
RunIntent/Admission, cancel tombstone, Mesa receipt, and Mesa lifecycle; it
records the in-flight operation/owner in the lease. After the call it reacquires
the mutex and rereads every durable source before appending a ProjectEvent.
The lease is a coordination cache, never a state fact; after restart it is
reconstructed from intent, tombstone, receipt, and lifecycle.

A cancel command acquires the same mutex. If dispatch is in flight it either
waits for that owner or commits an immutable `cancel-tombstone.json` plus the
`cancellation_requested` ProjectEvent before dispatch publication can proceed.
Mesa checks the shared tombstone before temp creation and before spawn. A
dispatcher returning with a receipt after the tombstone must persist/verify the
receipt and immediately issue the idempotent cancel; it may not publish queued
from that receipt. Local `cancelled` is legal only when the tombstone is
durable, Mesa reports no receipt after key lookup, and no live/in-flight
dispatch owner exists. A later start/receipt for that key observes the tombstone
and must reach Mesa `terminal_cancelled` without spawning.

Crash reconciliation is exact:

- after local intent commit but before Mesa receipt: resend the same request;
- after a stable pre-receipt Mesa admission rejection: write/verify
  `LocalRunTerminalEvidence(pre_receipt_admission_failed)` and append one
  system `failed` event;
- after Mesa receipt but before a verified lifecycle state: reconcile Mesa
  `ensure_run`; do not publish `queued` from the receipt alone;
- after verified Mesa temp/spawn-intent but before backend `queued`: verify the
  lifecycle chain and append `queued` once;
- after worker handshake but before `running`: verify full child identity is
  active in `worker_started` and append `running` once;
- after a cancel command commits `cancellation_requested`: retry the
  idempotent Mesa cancel until terminal; if no Mesa receipt exists yet, do not
  dispatch; after proving no dispatch owner, write/verify
  `LocalRunTerminalEvidence(cancelled_before_dispatch)` and append one system
  `cancelled` event;
- after Mesa terminal metadata but before backend publication: re-verify the
  captured request and terminal artifacts, then append exactly one terminal
  event;
- after any terminal event: never redispatch, recancel, relabel, or promote.

A cancel request is a normal idempotent client command. It commits the
tombstone and `cancellation_requested` before invoking Mesa; a run already
terminal at command linearization returns its stored projection without a new
event. A late race from `cancellation_requested` may end as `cancelled`,
`succeeded`, `failed`, or `timed_out`, exactly matching verified Mesa terminal
evidence. Terminal metadata records quantitative `cancel_outcome` as one of
`cancelled_before_dispatch`, `cancelled_by_worker`,
`completed_before_cancel_effect`, `failed_before_cancel_effect`, or
`timed_out_before_cancel_effect`; it never claims that a request caused a
terminal result without evidence. Failed, timed-out, and cancelled runs publish
only bounded terminal metadata. A successful run is not published as
`succeeded`, and gains no artifact references in project state, until the Mesa
worker has atomically promoted its final directory and the parent verifier has
confirmed the exact eight declared Gate 1 artifacts, their hashes, identities,
policy/admission fields, complete event log, and no truncation. Verifier failure
commits `failed` and no success artifact references.

### Parent/worker byte capture and TOCTOU

At admission the backend parent reads the exact v2 experiment canonical bytes,
recomputes `er_...` and `experiment_sha256`, builds canonical PolicySnapshot and
RunAdmission bytes, and freezes all of them in RunIntent. Immediately before
spawn, the Mesa parent rereads both the content-addressed experiment source and
Mesa-authoritative active-model pointer. It requires byte-for-byte/digest
equality with the admitted experiment and the same admitted model revision.
Either drift between admission and spawn fails closed as
`experiment_revision_drift` or `active_model_revision_drift`.

The immutable run `request.json` embeds the exact experiment document and exact
RunAdmission object and records their expected SHA/prefixed digests. The worker
reads only this captured request; it never rereads the mutable active pointer or
experiment source and never calls the v1 default-document builder. Before
simulation it independently canonicalizes the embedded objects, recomputes the
experiment ID/SHA, policy snapshot digest, admission digest, and all identity
cross-links. Any mismatch produces terminal failure before domain events.

Tests mutate the source experiment and active pointer after admission but
before spawn, mutate each embedded object/hash, and replace a v2 document with
v1/mixed keys. They require fail-closed behavior. A successful test also proves
that only the exact eight artifacts are promoted.

## Issue and resolution event model

An issue's immutable creation record contains:

```ts
type IssueCreated = {
  issue_id: string;
  project_id: string;
  subject_revision_ids: string[];
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  blocking: boolean;
  reporter_actor_id: string;
  assignee_actor_id: string | null;
  created_at: string;
};
```

Subjects are unique, sorted IDs from supported revision families in this
project. Model revisions may be issue subjects for traceability, but the Gate 2
progression calculation evaluates alignment and experiment subjects only.

Each issue has a zero-based, gap-free, independently verifiable event chain:

```ts
type IssueEvent = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  issue_event_id: string;
  project_id: string;
  issue_id: string;
  sequence: number;
  previous_issue_event_digest: string | null;
  issue_event_digest: string;
  event_type:
    | "opened" | "commented" | "assigned"
    | "resolved" | "closed" | "reopened";
  actor_id: string;
  payload: Record<string, unknown>;
  created_at: string;
};
```

`issue_event_digest` is `ied_` plus SHA-256 of v2 canonical bytes with only that
field omitted. Event zero is `opened`, has null previous digest, and embeds the
complete `IssueCreated` payload. Later payloads use exact keys: `commented`
contains non-empty `body`; `assigned` contains `assignee_actor_id` (or null)
and non-empty `reason`; status events contain non-empty `reason`. Unknown or
event-inappropriate keys fail `422`.

Legal transitions are:

| Current status | comment | assign | resolve | close | reopen |
| --- | --- | --- | --- | --- | --- |
| `open` | yes | yes | `resolved` | `closed` | no |
| `resolved` | yes | no | no | `closed` | `open` |
| `closed` | yes | no | no | no | `open` |

Any attached actor may open an issue or comment. Assignment requires a human
project owner. Resolve requires the human assignee or a human project owner.
Close requires the human reporter or a human project owner. Reopen requires the
human reporter, assignee, or project owner. Agent adapters may open/comment but
cannot assign, resolve, close, or reopen. These are application workflow rules,
not an authentication claim.

Illegal or same-state transitions return `409 invalid_issue_transition`.
Assigning the existing assignee, empty comment/reason, duplicate subject, or
another semantic no-op returns `422 no_effective_change`. Unknown/cross-project
actors, issues, subjects, or assignees return the standard `404`.

Event types and state effects are:

| Event | Required payload | State effect |
| --- | --- | --- |
| `opened` | complete creation record | status `open` |
| `commented` | actor, bounded body, timestamp | no status change |
| `assigned` | actor, assignee or null, reason, timestamp | changes assignee |
| `resolved` | actor, non-empty reason, timestamp | status `resolved` |
| `closed` | actor, non-empty reason, timestamp | status `closed` |
| `reopened` | actor, non-empty reason, timestamp | status `open` |

Only `open` issues count as open objections. `resolved` and `closed` preserve
all earlier discussion and do not delete the issue. Reopening appends an event;
it never edits the prior resolution. Blocking and subjects are immutable. If
either was mistaken, close with a reason and open a replacement issue.

`issue.json` is an atomic derived cache containing current status, assignee,
latest event sequence, and event-chain digest. On startup it is rebuilt from
the reachable issue event log when missing or behind. Every committed
`ProjectEvent.record_refs` names the exact issue event ID and digest plus the
resulting issue-cache digest. Recovery and policy calculation consume only the
gap-free issue events reachable from committed project events. An issue event
written before the project-event commit point is an unreachable orphan and is
quarantined; file presence alone never opens, resolves, closes, or reopens an
issue. Thus policy cannot observe an issue-history event without its atomic
project summary update.

An `object` attestation must reference at least one issue that shares its exact
subject and exists at commit time. Resolving that issue does not erase the
attestation. Conversely, zero open issues means only **no recorded open
objection**; it is not an endorsement, validation, correctness, or trust state.

## Immutable and superseding attestations

The attestation command accepts a non-empty unique subject list, a scope,
decision, rationale, optional issue IDs, and an optional
`supersedes_by_subject` map. The backend injects actor identity, type, declared
role, timestamp, and assurance from the session.

One immutable record is stored per subject:

```ts
type Attestation = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  attestation_id: string;
  attestation_digest: string;
  attestation_batch_id: string;
  project_id: string;
  actor_id: string;
  actor_type: "human" | "agent";
  declared_role: string;
  identity_assurance: "declared_unauthenticated_local";
  subject_revision_id: string;
  scope: "workflow_progression" | "technical_review" | "other";
  decision: "endorse" | "object" | "abstain";
  rationale: string;
  issue_ids: string[];
  supersedes_attestation_id: string | null;
  created_at: string;
};
```

`attestation_digest` is `atd_` plus SHA-256 of v2 canonical bytes with only
that field omitted. Policy evidence references and independently recomputes
this digest.

Supersession is valid only when the prior record exists in this project and has
the same actor, exact subject, and scope; a record can be directly superseded
at most once. Chains remain fully auditable. For a tuple of actor, subject, and
scope, exactly the unsuperseded chain head is effective. Creating another
decision for that tuple without explicitly naming the effective head returns
`409 attestation_supersession_required`. A stale/non-head supersedes reference
returns `409 attestation_not_effective`.

A batch covering alignment and experiment creates separate records with one
batch ID and commits atomically. Failure for any subject rejects the whole
batch. An Agent record remains an Agent record forever. No route edits an
attestation or changes its actor facts.

## Derived workflow policy

Policy is calculated independently for the exact current alignment-map
revision and exact experiment revision. For subject `S`:

```text
effectiveHumanProjectOwnerEndorsements(S) =
  count(distinct actor_id where
    effective attestation subject == S
    and scope == workflow_progression
    and actor_type == human
    and declared_role == project_owner
    and decision == endorse)

openBlockingIssues(S) =
  count(issue where
    S is an exact subject
    and blocking == true
    and current status == open)

policySatisfied(S) =
  effectiveHumanProjectOwnerEndorsements(S) >= 1
  and openBlockingIssues(S) == 0
```

The combined experiment-run workflow policy is satisfied only when both the
experiment's bound `alignment_revision_id` and the experiment revision
itself satisfy their independent calculations. The decision brief and model
identities remain visible bindings but are not Gate 2 progression-policy
subjects. Agent attestations, other human roles, non-progression scopes,
superseded records, and resolved/closed issues never increment the endorsement
count. An effective human objection does not introduce a hidden third
criterion; its required issue affects policy while open.

The browser-safe projection and frozen policy snapshot use this exact
per-subject record:

```ts
type SubjectPolicy = {
  subject_revision_id: string;
  effective_attestation_refs: Array<{
    attestation_id: string;
    attestation_digest: string;
    actor_id: string;
    actor_type: "human" | "agent";
    declared_role: string;
    scope: string;
    decision: "endorse" | "object" | "abstain";
  }>;
  human_project_owner_endorsement_attestation_ids: string[];
  human_project_owner_endorsement_count: number;
  open_issue_refs: Array<{
    issue_id: string;
    latest_issue_event_digest: string;
    blocking: boolean;
  }>;
  open_issue_ids: string[];
  open_issue_count: number;
  open_blocking_issue_ids: string[];
  open_blocking_issue_count: number;
  open_non_blocking_issue_ids: string[];
  open_non_blocking_issue_count: number;
  policy_satisfied: boolean;
  wording: "no_recorded_open_objection" | "recorded_open_objection";
};

type PolicySnapshot = {
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  policy_snapshot_digest: string;
  project_id: string;
  evaluated_at_snapshot_revision: number;
  evaluated_project_event_digest: string;
  alignment: SubjectPolicy;
  experiment: SubjectPolicy;
  combined_policy_satisfied: boolean;
  effective_attestation_ids: string[];
  open_issue_ids: string[];
};
```

Every ID/ref array is unique and sorted lexicographically; each ref array is
sorted by its ID. Counts equal the corresponding array lengths. For a
multi-subject issue, the issue appears once in each named subject's arrays;
the top-level `open_issue_ids` is the sorted, de-duplicated union, so it appears
once there. The top-level effective-attestation set is the same sorted union of
both subjects' effective heads.

`wording` is based on **all** open issues: it is
`no_recorded_open_objection` only when `open_issue_count == 0`, regardless of
the blocking count, and otherwise `recorded_open_objection`. Policy satisfaction
continues to use only open blocking issues plus human-owner endorsement count.

`policy_snapshot_digest` is `ps_` plus SHA-256 of v2 canonical bytes with only
that field omitted. The backend computes it from committed project/issue/
attestation events at one snapshot revision. Mesa admission and the final run
verifier independently replay committed ProjectEvents only through
`evaluated_at_snapshot_revision`, reload the immutable attestations and issue-
event heads referenced at that historical revision, reproduce all sets/counts/
wording, and recompute the digest. Later issue/attestation events are
intentionally ignored for this verification. A
missing, duplicate, unsorted, stale, or mismatched reference fails admission or
success verification.

These are quantitative workflow facts, never qualitative `trusted`,
`confirmed`, `valid`, `correct`, or scientifically validated states.

## Private drafts and no promotion

Execution safety is mandatory, but policy satisfaction is not a prerequisite
for a private run. The exact `RunAdmission` schema is defined in the run
lifecycle below. Its policy snapshot is computed and committed before dispatch.
Mesa metadata, run references, events, summaries, and view manifests inherit
its labels and
identity digest. Callers cannot submit any label or policy count.

Later issue or attestation changes never mutate a run, its artifacts, its
labels, or its admission snapshot. There is no promotion endpoint. To obtain a
`workflow_policy_met` result after policy changes, start a new run of the exact
experiment revision. Even a policy-met run remains `private_draft` and
`draft_unverified` in Gate 2; workflow recognition is not scientific trust or
publication.

## Identity binding through execution and artifacts

An experiment revision binds exactly one project, decision brief, alignment
map, model, default preset, complete values, seed, horizon, warm-up, and runtime
profile. Before run dispatch the backend and Mesa independently verify:

- every content ID recomputes from immutable bytes;
- the alignment revision binds the same decision brief and model revision;
- the experiment binds those exact brief/alignment/model identities;
- every record belongs to the route project;
- the model manifest and all declared entries pass Gate 1 digest and size
  checks;
- the experiment passes the bound model schema and defaults digest;
- no path or ancestor is a symlink and no path escapes the project.

For v2, `workflow_label` is the only workflow field name;
`workflow_policy` is reserved for unchanged v1 compatibility bytes. The exact
v2 identity/admission field set `I` is:

```text
project_id, run_id, model_id, model_revision_id,
brief_revision_id, alignment_revision_id,
experiment_revision_id, preset_id, seed,
visibility, trust_label, workflow_label,
policy_snapshot_digest, run_admission_digest
```

The field matrix is normative:

| Record | Exact v2 requirement |
| --- | --- |
| `request.json` | Every field in `I`, plus `experiment_sha256`, `run_intent_digest`, `downstream_request_digest`, embedded exact `experiment_document`, and embedded exact `run_admission`. |
| `metadata.json` | Every field in `I`, plus `experiment_sha256`, `run_intent_digest`, status/timestamps/limits/runtime profile and all declared artifact byte digests. |
| Every `domain-events.jsonl` event | Every field in `I` as top-level values in addition to the Gate 1 event contract. |
| Every `daily-kpis.csv` row | Every field in `I` as columns in addition to the Gate 1 KPI schema; integer seed is parsed canonically. |
| `summary.json` | Every field in `I` plus Gate 1 summary/non-claim values and semantic digests. |
| `replay-manifest.json` | Every field in `I` plus complete event-log byte/semantic digest and frame declaration. |
| `derived-views-manifest.json` | Every field in `I` plus all source artifact/model-spec/traceability digests and generator versions. |
| Project `RunReference` | Every field in `I`; pending kind has lifecycle status and no terminal/artifacts; terminal kind has verified terminal digest, with artifact IDs only for succeeded. |

No row may omit a field by inheritance in its serialized form. The final
verifier compares every occurrence against request/admission/metadata and
fails on one mismatch.

Gate 2 extends the Gate 1 worker/verifier with the non-null brief/alignment
bindings and admission-policy digest. It does not weaken Gate 1's exact eight
successful artifacts, semantic digest, pagination, no-truncation, or terminal
failure contracts. Any identity discrepancy fails the run before atomic
success promotion. Project state projects pending runs immediately from intent
and advances them only through append-only events. Terminal references require
matching verified metadata; failed/cancelled/timed-out references retain exact
terminal evidence and never masquerade as successful artifacts.

Artifact IDs are server projections of `(run_id, declared_name, sha256)` and
cannot name a path. Retrieval checks the project/run binding and Gate 1
metadata allowlist on every request.

Policy and admission facts are deliberately excluded from behavioral semantic
digests. The v2 canonical event/KPI/summary semantic projections include the
same mechanism fields as Gate 1 plus model/model-revision/experiment/preset,
seed, and locked runtime profile, but exclude project/run IDs, brief/alignment
IDs (already bound by the experiment ID), `visibility`, `trust_label`,
`workflow_label`, `policy_snapshot_digest`, `run_admission_digest`, timestamps,
paths, process/log fields, and byte offsets. Therefore two runs of the same v2
experiment and seed under the same runtime profile have identical model-event,
KPI, and summary semantic digests even if policy changes. Their full
`request.json`, metadata, event/KPI bytes, artifact byte digests, and run IDs
differ because the frozen admission fields differ.

## Experiment edit, default, diff, and reset semantics

The first Gate 2 experiment is created from the verified active Gate 1 model
default preset plus non-null current brief/alignment bindings. Gate 1's bundled
default experiment, whose brief/alignment IDs are null, remains immutable and
is never relabelled or selected as the Gate 2 current experiment.

The exact create/edit/reset payloads and parent requirements are defined in the
revision-chain transition contract. On edit, the backend loads the parent's
complete parameters and execution values, applies only known exposed changes,
normalizes through the model schema, and recomputes both complete diffs against
the bound defaults. Parameter and execution changes may be combined in one
atomic revision.

On reset, the backend reloads the active bound model revision's complete
verified default preset and restores every editable parameter plus horizon,
warm-up, and seed. The new revision has
`parameters == parameter_defaults`,
`execution_values == execution_defaults`, and both diff arrays empty. It never
derives defaults from the form, browser cache, current values, or prior diff,
and never deletes history. Reset remains an explicit revision even when the
parent already equals defaults. Runtime profile is locked and therefore has no
default/current/reset control in Gate 2.

## Browser-safe projection, isolation, and redaction

The project snapshot route is constructed from an allowlist. It includes
bounded actors, current IDs, parameter defaults/current/diff, issue summaries,
separate human and Agent attestation summaries, derived policy facts, run
status, and declared artifact references. Complete issue histories, full event
streams, model source, absolute paths, provider configuration, environment,
raw OpenCode/MCP payloads, process IDs, stack traces, and unbounded logs are not
part of `ProjectState`.

Projection wording is quantitative: exact revision IDs, actor declarations,
endorsement and issue counts, open-objection wording, and derived booleans. It
does not expose a qualitative alignment/model/experiment trust state. Every
Gate 2 run is visibly `private_draft` and `draft_unverified`, regardless of
`workflow_label`, and no API or projection offers promotion. This contract does
not claim the Gate 3 workbench/views or Gate 4 live-provider/queue-removal flow.

Limits are configured and tested for command bytes, text fields, collection
counts, attachments, SSE patches, event pages, and artifact response size.
Oversize requests fail before persistence with `413 payload_too_large`; rate
or concurrency exhaustion returns `429` with no partial write.

Isolation is fail-closed:

- route, envelope, session, actor, subject, attachment, run, and artifact must
  all resolve to the same project;
- a cross-project valid ID returns `404 resource_not_found`, revealing no
  ownership detail;
- `..`, encoded separators, NUL/control characters, absolute paths, unknown
  artifact names, and symlink components are rejected;
- JSON prototypes, duplicate keys, extra keys, non-finite numbers, and invalid
  Unicode are rejected before canonicalization;
- raw filesystem exceptions and adapter failures are mapped to stable public
  codes and correlation IDs.

Human-authored business text is an intentional durable project field, but
secrets are not valid project content. Ingress rejects known credential forms
(`Authorization: Bearer`, private-key blocks, configured provider-token
prefixes, and `*_API_KEY=`/`*_TOKEN=` assignments) and configured absolute
workspace-root strings with `422 sensitive_text_rejected`. Control characters
other than newline and tab are rejected. Adapter/tool diagnostics pass through
a recursive key allowlist and value redactor before persistence or projection;
keys such as `authorization`, `api_key`, `token`, `secret`, `password`, raw
input, environment, and path are removed or replaced with `[REDACTED]`.

Redaction never converts an otherwise failed provider or model operation into
success. Provider unavailability remains an explicit fail-closed error.

## Strict Gate 1/v1 and Gate 2/v2 branches

The v1 parser accepts exactly the delivered Gate 1 experiment keys and names,
with no `schema_version` and no extras:

```text
preset_id, executable, parameters, parameter_provenance,
horizon_days, warmup_days, seed, claim_labels,
model_id, model_revision_id, brief_revision_id, alignment_revision_id,
workflow_policy, trust_label, runtime_profile
```

It requires null brief/alignment IDs, `workflow_policy_unmet`, and
`draft_unverified`, and computes `er_...` from the entire delivered Python
canonical document exactly as Gate 1 does today. Its direct run body remains
exactly `{"experiment_revision_id":"er_..."}`. V1 field names, default
experiment ID, bundle bytes, request/artifact bytes, event/KPI/summary semantic
projections, and all existing golden digests remain unchanged.

The v2 parser accepts exactly the fields shown by `ExperimentRevision`: schema
and canonical versions, own ID, project/parent/operation, model/brief/alignment,
preset/defaults digest, complete parameter defaults/current/diff, complete
execution defaults/current/diff, runtime profile, and creation provenance. It
requires non-null business bindings and contains no `workflow_policy`,
`workflow_label`, issue, attestation, policy, or admission field. V2 computes
its ID with `riff-canonical-json-v2`, omitting only its own ID field.

Branch selection is structural: exact v1 keys select v1; exact
`schema_version: 2` plus exact v2 keys select v2. A v1 document with any v2 key,
a v2 document with any v1-only policy key, mixed names, missing keys, or unknown
version fails `422 unsupported_experiment_schema`; it never falls through to
the other validator. V2 artifacts use `workflow_label`; v1 artifacts retain
their existing `workflow_policy` spelling.

The sole experiment-writer exception is explicit: Mesa owns/materializes the
v1 bootstrap experiment together with the reviewed model bundle. The backend
owns every v2 experiment revision. Mesa remains the sole authority for
`models/wind-turbine-maintenance/active.json`; the backend verifies and projects
that pointer but never writes it.

Model/bootstrap materialization is allowed only for an explicitly created,
workspace-indexed project through the bootstrap route. The backend passes that
exact project ID to Mesa, verifies the returned active model/v1 experiment, and
then commits the bootstrap command's `model.selected` project event. Startup never scans old
directories, guesses a project from a model folder, or adopts a legacy Gate 1
workspace. A legacy directory not named by a committed workspace create event
is quarantined or left untouched according to operator migration tooling; it is
never silently made authoritative.

## Migration and compatibility

Gate 2 bootstrap is invoked only after durable project creation. It:

1. explicitly asks Mesa to materialize and verify the content-addressed
   `mr_...` bundle under that exact project ID;
2. preserves the Gate 1 `er_...` default experiment with null business
   bindings and fixed compatibility policy fields as historical bootstrap
   evidence, byte-for-byte and under its original Gate 1 digest;
3. commits the Mesa-returned active model pointer; explicit later commands
   create decision-brief and alignment revisions bound to it;
4. an explicit experiment-create command creates a distinct Gate 2 `er_...`
   experiment with complete defaults and
   non-null brief/alignment bindings but no mutable policy, issue, attestation,
   endorsement, or run-label fields;
5. each pointer change uses the revision-chain events and invalidation rules;
   event zero remains only project/initial-actor bootstrap.

Bootstrap is idempotent by command ID and content validation. A directory that
already contains conflicting bytes under a content ID fails
`500 immutable_record_corrupt`; it is never overwritten. In-memory Phase 0
sessions, messages, queue parameters, and DOM state have no durable identity
and are not fabricated as migrated records.

Gate 2 may keep the old backend/web queue routes reachable solely for the Gate
4 cutover dependency, but they cannot mutate Gate 2 wind project state, share
command receipts, satisfy policy, or be selected by an invalid wind request.
No wind request falls back to queue. Gate 4 must audit and delete the queue
implementation completely after the replacement browser flow passes.

Schema versions are explicit. Gate 2 state/event/admission records use their
declared version 1 while the Gate 2 experiment schema is version 2; the
delivered Gate 1 experiment shape is accepted only by its dedicated strict
compatibility parser. An unknown future version fails closed with
`unsupported_schema_version`; it is not partially interpreted. Migration code
is additive and writes new immutable records plus project events rather than
editing prior records.

## Explicit failure contract

| Condition | HTTP/status code | Durable effect |
| --- | --- | --- |
| Unknown/cross-project ID | `404 resource_not_found` | None. |
| Unknown/extra field, bad type/range/ID | `422 invalid_request` | None. |
| Experiment meaning/schema change | `422 model_revision_required` | None. |
| Credential/path-like sensitive text | `422 sensitive_text_rejected` | None. |
| Payload or collection limit | `413 payload_too_large` | None. |
| Rate/concurrency limit | `429 capacity_exceeded` | None. |
| Unseen command with stale base | `409 stale_snapshot` | None. |
| Reused command ID with different digest | `409 command_id_conflict` | None. |
| Stale parent/current or upstream tuple | `409 revision_not_current` / `upstream_revision_mismatch` | None. |
| Pointer mutation/new run while current run pending | `409 active_run_conflict` | None; no event/snapshot increment. |
| Illegal/no-op issue transition | `409 invalid_issue_transition` / `422 no_effective_change` | None. |
| Missing/invalid supersession head | `409 attestation_supersession_required` or `attestation_not_effective` | None. |
| Mixed/unknown experiment branch | `422 unsupported_experiment_schema` | None; no v1/v2 fallback. |
| Unsafe path or symlink | `400 unsafe_identifier` for request input; `500 unsafe_workspace` for stored state | None; affected project fails closed. |
| Immutable ID/bytes mismatch | `500 immutable_record_corrupt` | None; affected project unavailable. |
| Snapshot cache incomplete/behind | internal recovery | Replay committed events and atomically rebuild. |
| Abandoned pre-commit temp/orphan | internal recovery | Quarantine; do not expose as success. |
| Event gap/hash/reference failure | `500 project_corrupt` | No rollback or partial projection. |
| Workspace create/index conflict | `500 workspace_index_corrupt` | Creates and project opens fail closed. |
| Live provider unavailable | `503 provider_unavailable` | No canned response or inferred mutation. |
| Mesa admission rejects identity/schema | stable `409`/`422` mapping | Run intent becomes explicit failed admission; no successful run. |
| Downstream key/digest/run mismatch | `409 downstream_key_conflict` | Existing receipt/run preserved; no second worker. |
| Mesa lifecycle/owner/child drift | terminal `mesa_run_corrupt` | Preserve evidence; no spawn, signal, overwrite, or promotion. |
| Missing/mismatched local terminal evidence | `500 project_corrupt` | No terminal projection replay; backend never fabricates Mesa metadata. |
| Pre-spawn source/captured-byte drift | terminal `experiment_revision_drift` / `run_admission_mismatch` | No domain events or success artifacts. |
| Worker failure, timeout, cancel, resource limit | terminal `failed`/`timed_out`/`cancelled` | Exact immutable terminal metadata; no success artifacts. |
| Lost response after commit | retry returns stored response | No new revision/event. |

Public errors contain only stable code, bounded message, correlation ID, and
safe retry metadata. They never contain absolute paths, raw exception text,
stack traces, credentials, environment, tool inputs, or unrelated project IDs.

## Acceptance matrix

| Area | Required executable evidence |
| --- | --- |
| Workspace create | Concurrent creates commit distinct projects; exact retry resolves through the global index; same command against changed/project-scoped requests conflicts; event-committed/index-missing rebuilds; orphan project quarantines; duplicate project/event/hash corruption fails closed. |
| Durable identity | Create a project/initial human owner without a session, attach a temporary session, declare later actors through an attached owner, restart, attach a different session, and recover the same durable IDs. |
| Session retry boundary | A committed exact command retry with its expired session returns the stored durable result before live-session validation; an unseen command with that session fails; ephemeral session IDs never enter receipts. |
| Atomic recovery | Interrupt before immutable promotion, before event rename, after event rename, and during snapshot replace; pre-commit work is quarantined and committed work is replayed exactly once. |
| Corruption | Snapshot-behind recovers; event gap, hash mismatch, missing referenced record, conflicting content ID, and snapshot-ahead all fail the affected project closed. |
| Concurrency | Two commands at one base yield one commit and one deterministic `409`; commands serialize FIFO; cross-project reuse of one globally reserved command conflicts; a second backend writer cannot start. |
| Idempotency | Same command retry before/after restart returns identical durable status/body/revision; changed route/body/session/project under same ID returns `409`. |
| Command scope | One command ID is workspace-global and commits against exactly one project; exact same-project retry succeeds while any cross-project reuse conflicts before session/resource lookup. |
| Canonical v2 | Shared Node/Python golden fixtures produce identical bytes/SHA for integer/float equivalence, `-0`, exponent thresholds, Unicode ordering/non-normalization/escaping, and reject duplicate/non-finite/lone-surrogate input. |
| Revision identity | Brief/alignment/experiment IDs recompute from canonical bytes; mutation, extra fields, and cross-project bindings fail. |
| Revision transitions | Full create and current-parent revise/edit/reset rules, exact upstream tuples, stale parents, model/brief/alignment/experiment mismatch, pointer invalidation, phase transitions, and preservation of historical records all match the transition table. |
| Active-run pointer guard | While current run is pending, model/brief/alignment/experiment mutation and a second run each return exact `409 active_run_conflict` with no increment; all become legal after terminal. |
| Edit/default/diff | Every exposed Gate 1 parameter plus horizon/warm-up/seed accepts schema-valid edits; complete parameter/execution current/default/diffs are correct; invalid/non-finite/meaning/runtime-profile changes fail. |
| Defaults digest | Node and Python independently build exactly `{preset_id, parameter_defaults, execution_defaults}`, produce the same `dd_` digest, and reject mutation of any component/type/canonical byte. |
| Reset | Reset reloads verified model defaults, restores all parameters and horizon/warm-up/seed, creates a new immutable revision, empties both diffs, and preserves history. |
| Issue event chain | Every IssueEvent ID/sequence/previous/digest and ProjectEvent record ref verifies; unreferenced precommit issue events quarantine and never affect recovery or policy. |
| Issue transitions | The full legal status/permission matrix, non-empty reasons/comments, assignment rules, invalid/no-op errors, append-only history, and atomic multi-subject summaries pass. |
| Attestations | Records are immutable; valid explicit supersession changes only the effective head; stale/wrong actor/subject/scope supersession fails. |
| Actor boundary | Agent adapter cannot declare human type/role or create a human record; every local identity is visibly unauthenticated. |
| System initiator | System events require null actor/session and allowlisted component, independently derived transition ID/digest, and never create actor/session/attestation/endorsement facts. |
| Policy | Per alignment and experiment: sorted/deduplicated refs, counts, multi-subject issue inclusion/union, effective heads, combined result, `ps_` digest, and independent backend/Mesa/verifier recomputation all pass. |
| No-issue wording | Wording uses all open issues while satisfaction uses blocking issues; zero open issues projects only `no_recorded_open_objection`, never correctness/trust/endorsement. |
| Private draft | Both policy-met and policy-unmet exact experiments can run safely as `private_draft`; admission labels/counts/IDs are frozen. |
| No promotion | Resolve issues or add endorsement after a run; old run bytes and labels remain identical; only a new run can capture new policy facts. |
| Run record DAG | Independently recompute policy -> admission -> intent -> intent-event with base snapshot/digest equality and no back-reference/cycle; `ri_`, `ra_`, `ps_`, experiment SHA, command, key/request digests and identities all agree. |
| Run references | Intent inserts a pending discriminant with no terminal/artifacts; append-only events project status; terminal discriminant has evidence; only verified succeeded has exactly eight artifact IDs. |
| Lifecycle provenance | Intent/cancel are client events with actor/session/command receipt; queued/running/terminal are null-actor/session allowlisted reconciler events; each committed event increments once and retries/duplicate observations do not. |
| Local terminal evidence | Cancel-before-dispatch and pre-receipt admission failure create canonical `lte_` evidence, exact ProjectEvent ref/source union, survive restart, and fail closed on file/link/digest/receipt drift without any backend write to Mesa metadata. |
| Historical event isolation | Every run event advances only its `run_index` entry; current run/phase changes only on exact current-run equality. Races after terminal+revision and with a later run never rewind pointer or phase. |
| Mesa single owner | Receipt binds model/intent/admission/policy/experiment/request/run; lifecycle sequence/digest/epoch verifies; concurrent/duplicate starts, two service instances, and startup recovery ensure exactly one worker/writer. |
| Mesa recovery matrix | Receipt-only, missing/extra temp, temp-before-spawn, spawn-intent gap, active/orphan child, PID reuse/start-token/nonce drift, partial output, terminal evidence, corruption, resume/retry, and ownership epoch cases match the specified result without double-spawn. |
| Run lifecycle | Intent/202/current-ref and verified queued/running/cancel/terminal system events increment snapshots once; receipt alone never publishes queued/running; success only follows parent verifier/promotion. |
| Dispatch recovery | Every crash point before/after Mesa receipt, spawn, running, cancel, terminal metadata, and project publication reconciles to one pre-minted run ID, one worker, and one terminal event. |
| Cancel linearization | Per-run mutex/lease tests cancel-before-receipt, dispatch-in-flight/tombstone, receipt-during-cancel, late receipt immediate cancel, local-cancel preconditions, and success/failure/timeout-versus-cancel outcomes. |
| TOCTOU | Post-admission/pre-spawn source or active-pointer drift, embedded experiment/admission mutation, and expected-hash changes fail; worker uses only captured exact bytes. |
| Full identity | Every serialized v2 request/metadata/event/KPI/summary/replay/derived/project reference contains the exact field set `I` and agrees byte-for-field with admission. |
| Semantic separation | Same v2 experiment/seed with different policy snapshots yields identical model-event/KPI/summary semantic digests but different run IDs, requests, admission/full artifact byte digests. |
| Gate 1 preservation | V1 exact keys/names/default `er_`, Python canonical bytes, direct-run request, semantic digests, microcase, 100/3/1095/365/seed-2 baseline, eight artifacts, and no truncation remain unchanged/passing. |
| V1/v2 branch | Exact v1 and v2 documents select only their strict parser; mixed/unknown keys fail; v1 Mesa ownership and v2 backend ownership hold; only explicit indexed-project bootstrap materializes a model; no legacy scan/adoption occurs. |
| Isolation | Cross-project actor/subject/issue/attestation/experiment/run/artifact IDs, traversal, encoded separators, symlinks, and undeclared artifacts fail closed. |
| Projection bounds | Snapshots/SSE/events/artifacts obey limits; a gap causes snapshot reload; no full logs or histories leak into state. |
| Projection claims | Counts, IDs, unauthenticated declarations, all-open wording, private/draft labels, and non-claims remain quantitative; no qualitative trust/validity or Gate 3/4 completion appears. |
| Redaction | Inject credential forms, absolute workspace paths, sensitive diagnostic keys, stack traces, and raw tool payloads; none persist or reach public state/errors. |
| Compatibility | Gate 1 model/default experiment remain byte-identical; Gate 2 creates a separately bound v2 experiment; active model stays Mesa-authoritative; invalid wind requests never execute queue. |

Acceptance requires the focused backend/Mesa contract suites, existing full
backend/web/Mesa regression suites, type/build checks, canonical-byte
verifiers, and two independent Gate 1-size runs where the relevant identity
and semantic digests agree. A passing HTTP response without persisted restart
evidence is insufficient.

## Staged implementation order

Implementation should proceed in dependency order, with a focused test gate at
the end of each stage:

1. **Canonical primitives and schemas.** Freeze the untouched v1 branch; add
   shared Node/Python canonical-v2 golden bytes, strict v2 IDs/schemas, bounded
   text, safe path, redaction, and immutable-record verification tests.
2. **Workspace and project event stores.** Add writer lease, global create log
   and command index, project event/hash chains, atomic snapshot caches,
   reachability, command reservations/receipts, fault injection, quarantine,
   and restart/corruption tests.
3. **Project/session/actor API.** Add durable project/initial-owner creation,
   ephemeral existing-actor sessions, owner-authorized later actors, receipt-
   before-session retry, Agent declaration boundary, safe snapshot/SSE, and
   cross-project/idempotency tests.
4. **Business revisions.** Add explicit indexed-project Mesa bootstrap, brief/
   alignment stores, exact parents/upstream tuples, current-pointer state
   machine, active-run conflict guard, model-reference validation, ID drift,
   and v1 compatibility tests.
5. **Experiment revisions.** Add strict v2 create/edit/reset, all parameter and
   horizon/warm-up/seed defaults/current/diffs, non-null bindings, immutable
   backend-owned Mesa-readable bytes, pointer invalidation, and regression tests.
6. **Issues and attestations.** Add reachable digest-chained issue events,
   legal transition/permission matrix, current cache, atomic multi-subject
   summaries, separate human/Agent attestations, supersession, and boundary tests.
7. **Derived policy.** Implement canonical sorted/deduplicated evidence sets,
   per-subject/combined calculation, all-open wording, `ps_` digest, and
   independent recomputation tests.
8. **Run integration.** Add pre-minted run IDs, immutable `ri_`/`ra_` records,
   acyclic admission bases, Mesa receipt/lifecycle/ownership recovery, captured
   bytes/TOCTOU, pending/terminal refs, local terminal evidence, exact client/
   system event provenance, historical-event isolation, per-run dispatch/cancel
   linearization, admission-time policy, v2 identity matrix/semantic
   separation, no-promotion, and exact-eight-artifact verification.
9. **Integrated acceptance.** Execute restart/fault/concurrency/redaction/
   isolation matrices, all regression suites, and two full wind baselines.
   Record exact commands and output in the Gate 2 PR without asserting Gate 3
   browser or Gate 4 live-provider completion.

No stage may weaken a preceding invariant to make a later integration pass.
