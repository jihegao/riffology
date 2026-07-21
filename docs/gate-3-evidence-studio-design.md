# Gate 3 Evidence Studio design

## Status, dependency, and authority

This document is the implementation contract for issue #5. It does not claim
that Gate 3 is implemented or reviewed. Gate 3 starts from the committed Gate
0 product boundary, the Gate 1 `wind-turbine-maintenance` bundle and exact
eight-artifact run contract, and the Gate 2 durable project-state contract.

The backend project projection and verified immutable records are the only
workflow authority. The reviewed model bundle is the only model-structure
authority. Verified run artifacts are the only result authority. Conversation,
React state, DOM text, SVG, Canvas, charts, diagrams, and browser replay are
projections and cannot create a project fact, policy fact, model fact, run
fact, or scientific claim.

Gate 3 implements the two-pane alignment workbench and generated evidence
views for the wind-turbine case. It does not perform the Gate 4 live-provider
release story and does not remove the legacy queue path.

## Non-negotiable outcomes

The implementation is complete only when all of the following are true:

- reopening the durable project or restarting the backend restores the same
  project and current revision identities in the browser;
- every editable model parameter and `horizon_days`, `warmup_days`, and `seed`
  is rendered from a verified schema/default projection, not a hand-maintained
  form definition;
- edit and reset save new immutable experiment revisions and never mutate or
  delete an earlier revision;
- alignment and experiment review remain separate quantitative subjects;
- Agent reviews never count as human project-owner endorsements;
- zero open issues is worded only as `no recorded open objection`;
- workflow-policy failure does not disable an otherwise safe private draft
  run;
- entity/state, process/swimlane, traceability, replay, and KPI views regenerate
  from exact model-specification or run-artifact digests after the selected
  model revision or run changes;
- every visual view exposes a table or text equivalent from the same normalized
  data object;
- the 100-turbine, 3-crew, 1,095-day, 365-day warm-up, seed-2 result remains
  usable as interactive playback of verified completed evidence without
  loading all 38,730 baseline events into the DOM;
- `synthetic_inputs`, `single_seed`, behavioural-reproduction, private-draft,
  unverified, and no-recommendation disclosures remain visible in all result
  modes.

In Gate 3, `live 2D projection` means an interactive, responsive playback
surface driven by a selected verified completed run. It does not mean
streaming unverified child-process state while the simulation is executing.
While a run is pending, queued, running, or cancelling, the browser displays
only committed lifecycle status and the cancel control. Adding a separately
labelled unverified preview channel would require a later explicit contract;
Gate 3 does not add one.

## Information architecture

### Desktop shell

At the 1440 x 900 acceptance viewport the existing visual language is retained:
dark navy surfaces, blue structure accents, green primary actions, compact
eyebrows, rounded status pills, and bounded cards. Gate 3 changes the content,
not the product identity.

```text
+---------------- Conversation (40%) ----------------+ Workbench (60%) -----+
| project + declared actor | attachments | transcript | Brief / Model /       |
| Agent proposals and explanations | composer         | Experiment / Review /|
|                                                     | Run / Evidence         |
+-----------------------------------------------------+------------------------+
```

The conversation pane identifies the durable `project_id`, current declared
actor, unauthenticated-local identity assurance, and connection/provider state.
It may explain or propose actions, but it never supplies the workbench state.

The workbench has six ARIA tabs:

| Tab | Primary content | Authoritative owner |
| --- | --- | --- |
| Brief | question, owner, objective, constraints, assumptions, non-goals, sources, revision ID | immutable decision-brief revision |
| Model | model identity, entity/state view, event vocabulary, source adaptation, model non-claims | reviewed model bundle |
| Experiment | schema-driven values, defaults, diff, reset preview, execution values, revision lineage | immutable experiment revision plus model parameter schema |
| Issues & review | scoped issues, history, human and Agent attestations, separate subject policy cards | project issue/attestation event chains and derived backend policy |
| Run | start/cancel, lifecycle, exact bindings, labels, safe diagnostics | Gate 2 run reference and verified terminal evidence |
| Evidence | KPI charts/tables, event table, process/swimlane, replay, traceability, summary, downloads | verified run artifacts and immutable upstream revisions |

Tab selection, open cards, filters, table sort, chart metric selection, and
replay playhead are presentational only. They never submit a project command.

### Narrow layout

Below 960 px, `Conversation` and `Workbench` become an explicit two-option
pane switch. Only one pane is visually present at a time, but switching panes
does not unmount the durable-project connection or discard an experiment
draft. The six workbench tabs become a horizontally scrollable ARIA tablist.
Below 560 px, cards use one column; diagrams remain horizontally pannable;
tables remain reachable without forcing the page wider than the viewport.

## State ownership and browser state machine

### Authoritative state

Gate 2 `GET /api/projects/{projectId}/snapshot`, `GET
/api/projects/{projectId}/events`, their payload bytes, and all existing tests
remain unchanged. Gate 3 does not append browser-only fields to those
projections. The Gate 3 web installs authority only from `GET
/api/projects/{projectId}/browser-projection/v1` and ordered events from `GET
/api/projects/{projectId}/events/browser-v1`. Chat text, the Gate 2 projection,
and legacy session state never fill missing Gate 3 browser fields.

The versioned browser SSE stream sends one `browser.project.snapshot.v1`
first. These are the exact response/event schemas:

```ts
type BrowserProjectionResponse = {
  schema_id: "riff://evidence-studio/browser-projection-response/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  snapshot_revision: number;
  projection_digest: string;
  projection: BrowserProjectState;
};

type BrowserProjectSnapshotEvent = BrowserProjectionResponse & {
  event_type: "browser.project.snapshot.v1";
};

type BrowserProjectPatchEvent = {
  schema_id: "riff://evidence-studio/browser-project-patch/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  event_type: "browser.project.patch.v1";
  project_id: string;
  base_snapshot_revision: number;
  snapshot_revision: number;
  projection_digest: string;
  operations: [{ op: "replace"; path: ""; value: BrowserProjectState }];
};

type BrowserProjectReloadRequiredEvent = {
  schema_id: "riff://evidence-studio/browser-project-reload-required/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  event_type: "browser.project.reload-required.v1";
  project_id: string;
  base_snapshot_revision: number;
  snapshot_revision: number;
  projection_digest: string;
  reason: "revision_gap" | "projection_changed_while_disconnected" |
    "projection_digest_mismatch" | "unsupported_patch";
};
```

The client applies the root replacement only when project ID and base revision
equal its installed snapshot and the next revision is exactly base plus one.
It recomputes `projection_digest` over canonical-v2 projection bytes excluding
the digest field and requires the `pd_` value to match the envelope. The
backend produces these fields only on the new Gate 3 routes.
`browser.project.reload-required.v1`, a non-root operation, more than one
operation, a gap, duplicate, or schema/digest mismatch triggers a reload from
`/browser-projection/v1`. It
never merges a durable root with the legacy in-memory `ProjectState` shape.

Backend-owned state includes:

- project, actor, snapshot, brief, alignment, model, experiment, issue,
  attestation, policy, run, and artifact identities;
- parameter defaults/current values/diffs and run admission labels;
- issue and attestation counts and the derived policy booleans;
- run status and verified artifact allowlist;
- safe immutable source records used by generated views.

Model-bundle-owned state includes entity definitions, states, transition/event
mapping, parameter and metric schemas, visualization declaration,
traceability source mapping, and their exact SHA-256 digests.

Run-owned state includes complete domain events, daily KPI rows, summary,
replay manifest, derived-view manifest, and their exact artifact digests.

### Browser-safe current projection

Gate 3 derives a separate versioned browser projection from Gate 2 durable
state by allowlist; it does not extend the Gate 2 route bytes. The current Brief,
Model, Experiment, Review, Run, and Evidence tabs must be restorable from a
single verified snapshot without chat or DOM inference:

```ts
type BrowserProjectState = {
  schema_id: "riff://evidence-studio/project-state/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  display_name: string;
  snapshot_revision: number;
  projection_digest: string;       // pd_ + canonical-v2 digest excluding this field
  phase: "brief" | "align" | "configure" | "review" | "run" | "inspect";
  current: {
    decision_brief_revision_id: string | null;
    alignment_map_revision_id: string | null;
    model_revision_id: string | null;
    experiment_revision_id: string | null;
    run_id: string | null;
  };
  model_activation: BrowserModelActivation | null;
  current_records: {
    decision_brief: null | BrowserDecisionBrief;
    alignment_map: null | BrowserAlignmentMap;
    model_view: null | {
      model_id: "wind-turbine-maintenance";
      model_revision_id: string;
      view_sources_href: string;
      source_set_digest: string;
    };
    experiment: null | BrowserExperimentRevision;
  };
  actors: BrowserActor[];
  issues: IssueSummary[];
  review_summaries: BrowserReviewSummaries;
  workflow_policy: BrowserWorkflowPolicy | null;
  runs: RunReference[];
  current_terminal_artifacts: Array<{
    artifact_id: string;
    logical_name: "request.json" | "metadata.json" | "daily-kpis.csv" |
      "domain-events.jsonl" | "summary.json" | "replay-manifest.json" |
      "derived-views-manifest.json" | "run.log";
    sha256: string;
    href: string;
  }>;
  recent_command_results: Array<{
    command_id: string;
    command_digest: string;
    command_digest_version: "gate2-command-digest-v1" | "gate3-command-digest-v2";
    event_type: string;
    committed_snapshot_revision: number;
    result_identity: Record<string, string | number | boolean | null>;
  }>;
  projection_truncation: Record<string, { count: number; truncated: boolean }>;
};

type BrowserModelActivation = {
  activation_id: string;
  source: {
    model_revision_id: string;
    brief_revision_id: string;
    alignment_revision_id: string;
    experiment_revision_id: string;
  };
  target: {
    model_revision_id: string;
    brief_revision_id: string;
    alignment_revision_id: string;
    experiment_revision_id: string;
  };
  status: "authorizing" | "candidate_ready" | "project_committed" |
    "mesa_switch_pending" | "ready" | "failed_fenced";
  run_admission_fenced: boolean;
  safe_error: null | { code: string; message: string; correlation_id: string };
  intent_digest: string;
  candidate_digest: string | null;
  project_event_digest: string | null;
  switch_receipt_digest: string | null;
  reconcile_digest: string | null;
};
```

`BrowserDecisionBrief` and `BrowserAlignmentMap` are the bounded, exact
allowlisted current immutable records, including their revision/parent/upstream
IDs and source declarations. `BrowserExperimentRevision` includes the complete
default/current/diff data already defined by Gate 2. `current_terminal_artifacts`
is empty unless the exact current run is verified succeeded; then it contains
exactly eight name/ID/SHA/link declarations that agree with terminal metadata.
Large history, source code, raw events, logs, paths, and provider data remain
excluded. Historical records are fetched through bounded read routes.
`recent_command_results` is a bounded, digest-verified projection of committed
command receipts needed only for client reconciliation; it contains no
session ID, payload, path, or secret. A pending command outside that bounded
window is reconciled by its exact idempotent retry.

`model_activation` is the browser-authoritative activation projection; the UI
never infers activation state from a model pointer, HTTP success, or Mesa
response. Start-run admission reads this field and fails closed while
`run_admission_fenced=true`, while status is anything except `ready`, or when a
ready activation's target model differs from either the durable
`current.model_revision_id` or the backend-verified Mesa active model. A null
activation permits normal admission only when the same project/Mesa active
model agreement is independently verified. A `failed_fenced` activation never
re-enables Start run.

Projection invariants are exact. `authorizing` has only the required intent
digest; `candidate_digest` is the exact `candidate_receipt_digest`,
`project_event_digest` is the activation-commit event digest, and
`reconcile_digest` is the exact marker digest. `candidate_ready` additionally requires candidate digest;
`project_committed` and `mesa_switch_pending` additionally require project
event digest; `ready` additionally requires switch and reconcile digests,
and every non-failed status requires `safe_error=null`; `ready` is the only activation status with
`run_admission_fenced=false`. `failed_fenced` requires a non-null safe error and
the digests of every stage that durably occurred. Any impossible null/non-null
combination is project-state corruption, not a UI loading state.
The projected source and target tuples equal `ActivationIntent.source` and
`ActivationIntent.planned_target` byte-for-byte at every status; after project
commit the latter must also equal `ActivationTargetBinding.target`.

### Ephemeral UI state

React may own only:

```ts
type DraftBinding = {
  baseSnapshotRevision: number;
  decisionBriefRevisionId: string | null;
  alignmentMapRevisionId: string | null;
  modelRevisionId: string | null;
  experimentRevisionId: string | null;
  relevantSubjectRevisionIds: string[];
};

type MutationDraft<T> = {
  binding: DraftBinding;
  value: T;
  status: "clean" | "dirty" | "invalid" | "stale" | "saving";
};

type PendingCommand = {
  command_id: string;             // canonical lowercase UUID
  command_digest: string;
  command_digest_version: "gate2-command-digest-v1" | "gate3-command-digest-v2";
  frozen_envelope: ProjectCommand<unknown>;
  frozen_canonical_json: string;
  expected_result_identity: {
    command_id: string;
    command_digest: string;
    event_type: string;
    parent_or_subject_ids: string[];
  };
  observed_result_identity: Record<string, string | number | boolean | null> | null;
  transport_status: "not_sent" | "in_flight" | "http_accepted" |
    "http_rejected" | "response_lost";
  reconciliation_status: "unobserved" | "awaiting_snapshot" |
    "receipt_observed" | "confirmed" | "deterministically_rejected";
  safe_error: null | { code: string; message: string };
};

type EvidenceStudioUiState = {
  activePane: "conversation" | "workbench";
  activeTab: "brief" | "model" | "experiment" | "review" | "run" | "evidence";
  experimentDraft: null | MutationDraft<{
    operation: "edit" | "reset_defaults";
    parentExperimentRevisionId: string;
    parameterChanges: Record<string, JsonScalar>;
    executionChanges: Partial<ExecutionValues>;
  }>;
  resetPreviewOpen: boolean;
  issueDraft: null | MutationDraft<IssueDraft>;
  attestationDraft: null | MutationDraft<AttestationDraft>;
  pendingCommands: PendingCommand[];
  evidenceSelection: {
    runId: string | null;
    metricKeys: string[];
    eventFilters: EventFilters;
    replayDay: number;
    replayPlaying: boolean;
    replaySpeed: 0.5 | 1 | 2 | 4;
  };
};
```

No ephemeral field is serialized as a project fact. The selected run may be an
older run, but the Run and Evidence headers must state `historical run` when it
differs from `current.run_id`.

### Stale draft rule

Every experiment edit/reset, issue action, and attestation draft captures the
complete `DraftBinding` when opened. Installing any different
`snapshot_revision` marks every existing mutation draft `stale`, even when the
concurrent event appears unrelated and all relevant IDs remain unchanged.
This conservative rule prevents a draft from silently changing its policy,
actor, issue-head, or command context. Save, reset, issue, and attestation
submission are disabled while stale.

Reconnect and `409 stale_snapshot`, `revision_not_current`,
`upstream_revision_mismatch`, `attestation_not_effective`, or
`attestation_supersession_required` preserve the user's draft bytes, reload the
snapshot, and mark the draft stale. The only recovery is an explicit `Discard
and load current`, after which a newly opened draft captures a new binding.
There is no silent rebase, overwrite, auto-resubmit, or subject substitution.
The concurrency oracle includes an unrelated comment or actor event between
draft open and submit and requires the original draft to become stale with no
durable mutation.

### Pending command reconciliation

Submitting does not turn an editable `MutationDraft` into an optimistic state
change. Before transport, the client creates a separate `PendingCommand` from
the complete `ProjectCommand` envelope, serializes it once as canonical-v2,
computes its command digest using the backend route/method preimage, and freezes
the route's exact digest version, bytes, command ID, base revision, expected
event type, and parent/subject
identities as `expected_result_identity`. Neither reconnect nor a newer
snapshot edits that identity or those bytes. A concrete server-minted revision,
issue, attestation, run, or activation ID is stored separately only as
`observed_result_identity` after HTTP or receipt evidence.

An installed snapshot may stale the still-editable draft while independently
reconciling the pending command. Reconciliation succeeds only when a verified
`recent_command_results` receipt has the exact command ID/digest/event type and
digest version, and its result identity is present in the corresponding
authoritative projection.
The client then marks the pending command confirmed, installs the result, and
clears both the pending command and its corresponding now-stale editable draft.
A matching HTTP response arriving later is ignored except for an exact
consistency check.

An HTTP acceptance before SSE stores the exact returned result identity and
waits for a snapshot/receipt proving it; HTTP success alone does not mutate UI
authority. SSE before HTTP may confirm and clear first. A lost HTTP response
with matching SSE confirms normally. If both are lost, reconnect loads the
snapshot and reconciles from the receipt. If the receipt is outside the
projection window or commit status remains unknown, the only permitted action
is an exact idempotent retry of `frozen_canonical_json`, with the same command
ID, session, payload, and old base revision. Gate 2 receipt lookup occurs
before live-session/base validation for that exact retry. The client never
constructs a retry from current form state.

A deterministic HTTP rejection proves no commit only when its stable code and
command digest match the frozen envelope. The pending command becomes
`deterministically_rejected`; editable values are preserved, but they are stale
and disabled. The user must explicitly discard/reload and create a newly bound
draft with a new command ID. Ambiguous transport failure is never presented as
rejection or silently rebound.

Client command receipts are immutable historical outcomes, not aliases for
current project state. In particular, an activation command receipt ending
`failed_fenced` is never rewritten, replaced, or projected as `ready` if a
later system reconciliation event brings `model_activation.status` to `ready`.
`recent_command_results` shows that historical failed receipt separately from
the current `model_activation` projection and its system reconcile digest. A
pending command first reconciles against its exact receipt ID/digest/version/
outcome; after confirming and clearing that pending command, the client reads
the current browser projection. It may display both `activation command failed
fenced` and `system reconciliation later reached ready`, but never treats the
latter as mutation of the former.

### Safe local discovery and project session reattachment

The browser begins with `GET /api/projects/default`. It never creates,
imports, resets, or selects a project as a side effect. The route returns `200`
only when exactly one healthy configured durable project exists:

```ts
type DefaultActorDeclaration = {
  actor_id: string;
  display_name: string;
  actor_type: "human" | "agent";
  declared_role: string;
  assurance: "declared_unauthenticated_local";
};

type DefaultProjectDiscovery = {
  schema_id: "riff://evidence-studio/default-project-discovery/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  display_name: string;
  health: "healthy_configured";
  actors: DefaultActorDeclaration[]; // at most 50 safe declarations
  actor_count: number;
  actors_truncated: boolean;
};
```

It returns `404 {code:"no_default_project"}` when none exists and
`409 {code:"multiple_default_projects"}` when more than one healthy configured
project exists; neither response chooses one or creates state. Actor
declarations contain only project-owned actor ID, display label, actor type,
declared role, and `declared_unauthenticated_local`. The user explicitly
chooses one returned actor. The browser may remember only that actor ID for
that project in local preferences; it never remembers session authority and
must ask again if the actor is absent or the list is truncated.

The URL or local app launch state identifies the durable `project_id` and a
previously explicitly selected `actor_id`, never an old session as project identity. On
initial open and after backend restart the client calls
`POST /api/projects/{projectId}/sessions` with that exact same-project actor,
receives a new ephemeral `session_id`, fetches
`/browser-projection/v1`, then opens `/events/browser-v1`.
An expired or unknown session is never adopted, persisted into revision
records, or replaced by a new actor. If actor reattachment fails, the
workbench remains read-only until the user selects an actor exposed by the
safe project-open flow.

Before any public candidate discovery, the backend performs one read-only
internal handshake:

```text
GET /internal/projects/{project_id}/wind/runtime-candidate-handshake/v1
Accept: application/json
X-Riff-Internal-Protocol: wind-runtime-handshake-v1
```

It accepts no query/body and returns this exact `additionalProperties:false`
document:

```ts
type MesaRuntimeCandidateHandshake = {
  schema_id: "riff://mesa-wind/runtime-candidate-handshake/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  runtime_instance_id: string;
  actual_python_implementation: string;
  actual_python_major_minor: string;
  actual_mesa_version: string;
  model_protocol_version: string;
  candidate_source_revision: string;
  candidate_bundle_protocol: string;
  candidate_manifest_sha256: string;
  candidate_file_map_sha256: string;
  candidate_source_descriptor_digest: string;
  active_model_revision_id: string | null;
  handshake_digest: string;
};
```

`handshake_digest` is `rh_` plus SHA-256 of canonical-v2 bytes excluding only
that field, therefore binding `project_id`, runtime instance, and that project's
active pointer. `runtime_instance_id` is an opaque random identifier minted at
Mesa service start, not an OS process ID, path, host, or secret. The endpoint reads the actual process/library versions,
project-specific active pointer, and installed candidate source descriptors;
it does not materialize a
candidate, capture bytes, alter the active pointer, reserve an activation ID,
or write a file. The backend independently verifies the response digest,
exact CPython 3.12/Mesa 3.5.1/model protocol/bundle protocol, reviewed candidate
source revision, manifest/file-map/source-descriptor digests, and current Mesa
pointer before serving a public descriptor. A public discovery request never
reuses a handshake from a prior Mesa process or active-pointer observation.
Stable safe failures are `409
incompatible_framed_runtime`, `409 framed_candidate_source_mismatch`, and `503
mesa_runtime_handshake_unavailable`; responses expose no paths, imports,
stacks, environment values, or candidate bytes. A failed handshake creates no
activation intent or external write.

The path project, response `project_id`, backend project ownership, and
project-specific active pointer must all agree. Unknown projects and any
cross-project request/response/descriptor mismatch return the same redacted
`404 {code:"project_not_found"}` with no existence detail, bytes, or write.

The sole reviewed framed candidate is then discovered separately with
`GET /api/projects/{projectId}/wind/framed-candidate`:

```ts
type FramedCandidateDescriptor = {
  schema_id: "riff://evidence-studio/framed-candidate-descriptor/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  runtime_handshake_digest: string;
  expected_active_model_revision_id: string;
  candidate_source_revision: string;
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  bundle_protocol: "wind-turbine-maintenance-bundle-v2-framed";
  manifest_sha256: string;
  file_map_sha256: string;
  runtime_profile: {
    canonical_json_version: "riff-canonical-json-v2";
    mesa_version: "3.5.1";
    model_protocol_version: "wind-turbine-maintenance-v2-framed-replay";
    python_implementation: "CPython";
    python_major_minor: "3.12";
  };
  preset_id: "wind-turbine-maintenance-demo-v1";
  preset_sha256: string;
  provenance_sha256: string;
  descriptor_digest: string;      // cand_ + digest excluding this field
};
```

The backend constructs this descriptor only from the just-verified handshake
and its independently loaded installed reviewed descriptors;
the caller supplies no filesystem path, URL, model revision, preset, or file
map. `descriptor_digest` is `cand_` plus SHA-256 of canonical-v2 bytes of the
entire descriptor excluding only that field. Its `project_id`,
`runtime_handshake_digest`, candidate source revision, and expected active model
must equal that same project-bound handshake; a digest from another project is
never reusable. A runtime other than exact
CPython 3.12 plus Mesa 3.5.1 returns stable
`409 {code:"incompatible_framed_runtime"}` and leaves all legacy reads/runs
available; absence of the installed reviewed descriptor returns stable `404
{code:"framed_candidate_unavailable"}`. Provisioning a genuinely new wind
project selects this framed
candidate by default only after this compatibility and bundle verification;
an already configured legacy project remains on its current tuple until the
explicit activation protocol succeeds.

## Browser-safe data contracts

Every new Gate 3 JSON document and SSE payload declares an exact `schema_id`,
integer `schema_version`, and `canonical_json_version`. The schemas use
`additionalProperties: false`; unsupported versions fail with
`422 unsupported_schema_version` at request boundaries or the corresponding
safe `500` corruption code for stored evidence. Illustrative TypeScript below
omits no schema metadata unless it explicitly extends a type that already
contains these three fields.

Inline response notation such as `404 {code:"no_default_project"}` names only
the stable code inside the existing exact safe-error envelope; it is not a
one-key JSON response and does not waive schema metadata.

The sole exception is the strict legacy/framed model-bundle `manifest.json`
union defined below. Those two manifest branches do not carry root
`schema_id` or root `canonical_json_version`. Their normative equivalents are
root `schema_version`; framed root `bundle_protocol` (with the legacy branch
fixed by its exact five-key root and profile); and exact
`runtime_profile.canonical_json_version`. This exception applies only to the
model-bundle `manifest.json`, not to replay manifests, derived-view manifests,
API documents, SSE payloads, or any other new Gate 3 JSON. Because both bundle
root keysets are exact, an unexpected root `schema_id` or root
`canonical_json_version` is an extra key and fails strict bundle parsing.

### Existing Gate 2 routes used unchanged

Gate 3 consumes these existing routes and mutation envelopes exactly:

```text
POST /api/projects/{projectId}/sessions
GET  /api/projects/{projectId}/snapshot
GET  /api/projects/{projectId}/events
POST /api/projects/{projectId}/experiments/revisions
POST /api/projects/{projectId}/issues
GET  /api/projects/{projectId}/issues/{issueId}/history
POST /api/projects/{projectId}/issues/{issueId}/comments
PATCH /api/projects/{projectId}/issues/{issueId}
POST /api/projects/{projectId}/attestations
POST /api/projects/{projectId}/runs
GET  /api/projects/{projectId}/runs/{runId}
POST /api/projects/{projectId}/runs/{runId}/cancel
GET  /api/projects/{projectId}/runs/{runId}/events
GET  /api/projects/{projectId}/artifacts/{artifactId}
```

The first two Gate 2 read routes remain for legacy consumers and regression
tests; the Gate 3 web does not call them or reinterpret their projection bytes.

Every mutation uses the Gate 2 `ProjectCommand<T>` with a fresh
workspace-global canonical lowercase UUID `command_id`, the durable `project_id`, attached ephemeral
`session_id`, and displayed `base_snapshot_revision`. The browser never sends
policy counts, workflow/trust labels, an arbitrary run seed, a workspace path,
or an artifact filename.

The UUID uses the canonical `8-4-4-4-12` lowercase hexadecimal representation;
placeholders such as `command_<id>` or `cmd_<id>` are invalid wire values. The
command digest is a strict versioned union. Existing Gate 2 routes and exact
retries retain the delivered branch forever:

```text
gate2-command-digest-v1 =
  cmd_ + sha256(riff-canonical-json-v2({method,route,request}))
```

For v1, `method`, `route`, and `request` are exactly the values passed to the
delivered helper. It replaces only literal `:project` with the actual project
ID; it deliberately retains literal `:issue` and `:run` segments on the
existing issue-event and run-cancel routes, and preserves each route's existing
POST/PATCH choice. No origin, query, or version field is added. Historical
events, no-event receipts, retries, Gate 2 browser fixtures, and legacy callers
are never recomputed or reinterpreted under a new route normalization rule.

New Gate 3 route identities use only:

```text
gate3-command-digest-v2 = cmd_ + sha256(JCS({
  version:"gate3-command-digest-v2",
  method,
  actual_normalized_route,
  request
}))
```

`JCS` here is the project's exact `riff-canonical-json-v2` implementation.
Here `method` is uppercase; `actual_normalized_route` contains concrete
percent-normalized project/resource IDs and no origin, fragment, query, or
template placeholders; and `request` is the exact `ProjectCommand` envelope,
or, for a read projection's route-identity golden, its exact normalized query
object with every nullable key present. Activation receipts persist v2. Read
projections do not create command receipts, but use the same v2 route preimage
for cache/golden identity. Browser and backend maintain route-specific literal
goldens for both branches. A `PendingCommand` freezes the digest version with
its bytes; reconciliation selects that branch only and refuses a missing,
unknown, or mismatched version.

Delivered Gate 2 receipt/event bytes do not gain a version field. The new
browser projection annotates them as `gate2-command-digest-v1` from their
allowlisted existing route/event provenance; an activation intent/receipt
stores explicit v2. Absence of a version in historical durable bytes is never
interpreted as v2.

### Gate 3 read-only routes

Gate 3 adds only the following browser-safe read routes. They do not increment
the snapshot revision and cannot repair or reinterpret corrupt evidence.

| Route | Exact purpose |
| --- | --- |
| `GET /api/projects/default` | Discover exactly one healthy configured project and bounded safe actors; never create/select. |
| `GET /api/projects/{p}/browser-projection/v1` | Return the exact Gate 3 `BrowserProjectionResponse`; never alter the Gate 2 snapshot. |
| `GET /api/projects/{p}/events/browser-v1` | Stream only the exact Gate 3 browser snapshot/patch/reload-required event union. |
| `GET /api/projects/{p}/wind/framed-candidate` | After a fresh project-bound internal handshake, return the sole reviewed descriptor bound to that project/pointer, or a stable safe failure. |
| `GET /api/projects/{p}/brief/revisions/{dbr}` | Return the allowlisted immutable decision brief after project/ID/digest verification. |
| `GET /api/projects/{p}/alignment/revisions/{amr}` | Return the allowlisted immutable alignment map after project/upstream/digest verification. |
| `GET /api/projects/{p}/models/{mr}/view-sources` | Return verified, bounded model view sources and source descriptors. |
| `GET /api/projects/{p}/models/{mr}/view-sources/{name}` | Download one allowlisted JSON source by logical name; no path input. |
| `GET /api/projects/{p}/attestations?subject_revision_id={id}&after={cursor}&limit={n}` | Page project-owned redacted attestation details and supersession links. |
| `GET /api/projects/{p}/runs/{r}/evidence` | Return the verified evidence index, parsed bounded summary/manifests, labels, and artifact links. |
| `GET /api/projects/{p}/runs/{r}/event-projection/v1?after={sequence}&limit={n}&...` | Page the new versioned filtered event projection without changing the Gate 2 event route. |
| `GET /api/projects/{p}/runs/{r}/kpis?after_day={d}&limit={n}` | Page validated daily KPI rows in ascending day order. |
| `GET /api/projects/{p}/runs/{r}/replay?after_frame={i}&limit={n}` | Page verified model/worker-generated sampled frames embedded in the replay manifest. |

The sole Gate 3 browser mutation route is normative here, rather than being
introduced only in the implementation narrative:

```text
POST /api/projects/{projectId}/wind/framed-evidence/activate
```

Its `ProjectCommand` and receipt use only `gate3-command-digest-v2`; no Gate 2
route or receipt is migrated to that branch.

The two immutable business-revision routes return an envelope rather than
changing historical revision bytes:

```ts
type ImmutableBusinessRevisionResponse<T> = {
  schema_id: "riff://evidence-studio/business-revision-response/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  revision_kind: "decision_brief" | "alignment_map";
  revision_id: string;
  revision_digest: string;
  source: SourceDescriptor;
  record: T;
};
```

The backend verifies the historical record's existing Gate 2 schema,
content-derived identity, project ownership, parent/upstream tuple, and
committed project-event reachability before placing it in this Gate 3 envelope.

The existing Gate 2 route remains byte- and behavior-compatible and retains
its delivered unfiltered `limit<=1000` contract:

```text
GET /api/projects/{p}/runs/{r}/events?after={sequence}&limit={1..1000}
```

Gate 3 does not add filter keys, change response bytes, reduce its limit, or
install new sparse-index semantics on that route. Filtered/projection reads use
the new versioned route exclusively:

```text
GET /api/projects/{p}/runs/{r}/event-projection/v1
  ?after={sequence}&limit={1..500}
  &from_day={finite >= 0}&to_day={finite >= from_day}
  &event_type={known event type}
  &turbine_id={exact ID}&crew_id={exact ID}&work_order_id={exact ID}
```

Unknown filters, duplicate scalar query keys, non-finite numbers, unknown event
types, cross-run IDs, and invalid ranges return `422 invalid_request`. A run
without verified success returns `409 run_evidence_pending`. A digest,
identity, schema, or manifest mismatch returns `500 mesa_run_corrupt`; the
backend never returns a partial view as success.

The response `filters` object always carries all six normalized keys, using
null for an omitted filter; it never echoes raw query spelling. Response and
page-cache identity are `(project_id,run_id,source.sha256,after,limit,filters,
projection_schema_version)`. The sparse source index itself is shared only by
exact `(source.sha256,source_event_count,artifact_byte_length,index_version)`.

The exclusive event cursor is `after`, with sequence zero as the initial
sentinel because event sequences start at one. Query parsing rejects every
duplicated key, including identical duplicates, in lexicographically stable
key order before artifact access. The exact filtered response is:

```ts
type FilteredDomainEventProjectionPage = {
  schema_id: "riff://evidence-studio/filtered-domain-event-projection-page/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  projection_kind: "filtered_domain_events";
  project_id: string;
  run_id: string;
  experiment_revision_id: string;
  source: SourceDescriptor;
  filters: {
    from_day: number | null;
    to_day: number | null;
    event_type: string | null;
    turbine_id: string | null;
    crew_id: string | null;
    work_order_id: string | null;
  };
  source_event_count: number;
  after: number;
  scanned_through_sequence: number;
  next_after: number;
  has_more: boolean;
  events: DomainEvent[];
};
```

Only `FilteredDomainEventProjectionPage` and its new route use the following
scanner/cache rules. The scanner stops at the earliest of the `limit`-th
matching event, the 5,000th examined source event, or EOF. It returns every match encountered
through that stop; no match is scanned and then discarded.
`scanned_through_sequence` is the last source event
examined, even when `events` is empty; `next_after` always equals it, so an
exclusive-cursor client makes progress through a sparse filter. `has_more`
means unscanned source sequences remain, not that another match is known.

The backend builds a disposable digest-keyed sparse index in one streaming pass
after verifying the artifact. Every 512th event records sequence, byte offset,
simulation day, and safe filter keys. The index has exact schema/version,
source SHA, event count, artifact byte length, and index digest; it is written
atomically under a derived-cache namespace, never exposed as a run artifact or
project fact. A request seeks to the greatest indexed sequence not exceeding
`after` and parses only the bounded scan window. Index/source drift deletes the
cache and performs one streaming rebuild before serving the page. If the index
cannot be built or atomically read, the route returns a safe retryable error;
it never falls back to rereading/parsing the full ~26 MiB artifact per page.

The sparse index sits on a digest-keyed immutable artifact adapter. After
same-project authorization and terminal-metadata verification, the adapter
streams the declared artifact once into a temporary cache file, verifies exact
byte length and SHA-256, fsyncs, and atomically promotes it under
`artifact-cache/<sha256>`. Readers receive only a bounded random-access
`read(offset,length)` handle to that immutable file; no page owns the whole
artifact buffer. The adapter permits at most 1 MiB per read, 8 MiB aggregate
memory buffers, 64 MiB per cached source file (matching the existing artifact
response bound), and 512 MiB total derived-cache disk with closed-handle LRU
eviction. Cache/index files are not evidence or project state.

The cache record binds schema/version, project/run/artifact ID, logical name,
terminal metadata digest, source byte length/SHA, and cache-file SHA. Any new
terminal declaration, source SHA/size mismatch, partial file, symlink, or
index/source mismatch invalidates both file and index before use. Concurrent
builders share a digest lock and verify the winner. Restart may reuse only a
fully verified cache record; otherwise it rebuilds once. Thus filtered pages
seek and stream bounded byte ranges, while duplicate query rejection remains
deterministic and occurs before adapter/cache access.

### Shared source descriptor

Every source presented by a chart or diagram uses this shape:

```ts
type SourceDescriptor = {
  schema_id: "riff://evidence-studio/source-descriptor/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  source_kind: "model_bundle" | "business_revision" | "run_artifact";
  logical_name: string;
  sha256: string;                 // lowercase 64-hex, no prefix
  identity: {
    project_id: string;
    model_revision_id: string | null;
    brief_revision_id: string | null;
    alignment_revision_id: string | null;
    experiment_revision_id: string | null;
    run_id: string | null;
  };
  href: string;                   // same-project allowlisted GET route
};
```

`href` is constructed by the backend. The browser never combines an artifact
name with a filesystem path. Model-source responses use
`ETag: "sha256-{sha256}"`; run downloads retain Gate 2 artifact-ID addressing.

### Model view-source response

```ts
type ModelViewSources = {
  schema_id: "riff://evidence-studio/model-view-sources/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  generator_contract_version: "wind-evidence-view-contract-v1";
  sources: {
    model_spec: SourceDescriptor;
    parameter_schema: SourceDescriptor;
    execution_field_schema: SourceDescriptor;
    metric_schema: SourceDescriptor;
    visualization: SourceDescriptor;
    traceability: SourceDescriptor;
  };
  contract_bindings: {
    default_preset: SourceDescriptor;
    provenance: SourceDescriptor;
  };
  model_spec: ModelSpecView;
  parameter_schema: ParameterSchemaView;
  execution_field_schema: ExecutionFieldSchemaView;
  metric_schema: MetricSchemaView;
  visualization: VisualizationView;
  traceability: TraceabilityView;
  source_set_digest: string;      // viewsrc_ + canonical-v2 SHA-256
};
```

`source_set_digest` is `viewsrc_` plus the canonical-v2 SHA-256 of the exact
sorted map `{model_spec, parameter_schema, execution_field_schema,
metric_schema, visualization, traceability, default_preset, provenance}`,
where every value is that source's lowercase SHA-256. The first six are parsed
view sources; the last two bind the exact preset/default and provenance bytes
that authorize editor values and explanations. No source may be omitted by
inheritance.

Only the exact eight declared JSON files may be served: six parsed inline view
sources plus descriptor-only default-preset and provenance bindings. Their
bytes must match the selected content-addressed bundle manifest before parsing.
Unknown keys and unsupported schema versions fail closed. The response is
bounded to 512 KiB. The route rejects a valid `mr_` that is not owned by the
project.

The current Gate 1 model spec lists states and event vocabulary but does not
fully declare initial states and event-to-transition edges. Gate 3 must add
these fields to the versioned model spec and its code/spec drift oracle before
rendering a transition graph:

```ts
type ModelSpecView = {
  model_id: "wind-turbine-maintenance";
  entities: Record<string, {
    states: string[];
    initial_state: string;
  }>;
  transition_events: Array<{
    event_type: string;
    entity: "turbine" | "crew" | "work_order" | "system";
    from_state: string | null;
    to_state: string | null;
    lane: "turbine" | "queue" | "crew" | "system";
  }>;
  required_domain_events: string[];
  claim_scope: "synthetic_single_seed_behavioral_reproduction";
  // Existing reviewed mechanism fields remain present and verified.
};
```

Adding those fields changes bundle bytes and therefore creates a new immutable
model revision; Gate 1's reviewed revision remains byte-identical and
available as history. The corresponding Gate 3 experiment is a new revision
bound to the new model revision. The UI does not guess missing edges or encode
wind-specific edges in JSX. An older model revision without the required view
contract shows a text-only `view contract unavailable for this historical
revision` state while preserving source downloads.

### Framed parameter schema

The framed v2 `parameter-schema.json` is the sole rendering contract for all
26 model parameters. Its exact property metadata is a strict union:

```ts
type ParameterProvenance = {
  source_id: "anylogic-field-service-reference" | "synthetic-demo-assumption";
  source_locator: string;
  disposition: "direct" | "adapted" | "synthetic_gap";
};

type FramedParameterPropertyBase = {
  type: "integer" | "number";
  minimum: number;
  maximum: number;
  display_name: string;
  section_id: string;
  display_order: number;
  unit: string;
  provenance: ParameterProvenance;
};

type FramedParameterProperty = FramedParameterPropertyBase & (
  { distribution_group_id: null; distribution_family: null; distribution_role: null } |
  { distribution_group_id: string; distribution_family: "triangular";
    distribution_role: "low" | "mode" | "high" }
);

type FramedParameterSchemaView = {
  schema_id: "riff://wind-turbine-maintenance/parameters/v2";
  schema_version: 2;
  canonical_json_version: "riff-canonical-json-v2";
  type: "object";
  additionalProperties: false;
  required: string[];             // exact sorted 26-key set
  properties: Record<string, FramedParameterProperty>; // same exact keyset
};
```

Every property carries exact `unit` and `provenance`. A triangular low/mode/high
member carries a non-null shared `distribution_group_id`, exact
`distribution_family="triangular"`, and exactly one role; every group has
exactly one of each role and satisfies low <= mode <= high. Every scalar field
carries null for all three distribution metadata fields. Omission, a partly
declared group, duplicate role, unit/provenance drift, or schema/preset value
outside the declared range fails before rendering or persistence.

Node and Python independently load and compare the literal parameter schema,
default preset, and provenance bytes, recompute their bundle file hashes and
`source_set_digest`, validate all groups/ranges/defaults, and run mutation
goldens for each metadata field. JSX receives only the verified normalized
property objects; it never infers units, provenance, group membership, family,
or role from parameter names or key suffixes.

### Execution-field schema

Gate 3 adds `execution-field-schema.json` as a versioned, digest-bound source
in the new model bundle. It is authoritative for form rendering and for the
shared backend/Mesa validator; the browser must not hardcode execution types,
ranges, units, defaults, or cross-field rules.

```ts
type ExecutionFieldSchemaView = {
  schema_id: "riff://wind-turbine-maintenance/execution-fields/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  type: "object";
  additionalProperties: false;
  required: ["horizon_days", "warmup_days", "seed"];
  properties: {
    horizon_days: { type: "integer"; minimum: 1; maximum: 3660; unit: "day" };
    warmup_days: { type: "integer"; minimum: 0; maximum: 3659; unit: "day" };
    seed: {
      type: "integer";
      minimum: -2147483648;
      maximum: 2147483647;
      unit: "signed_int32";
    };
  };
  invariants: [{ rule: "warmup_days < horizon_days" }];
};
```

All three fields are required. Booleans, numeric strings, fractions,
non-finite numbers, out-of-range integers, extra keys, `warmup_days < 0`, and
`warmup_days >= horizon_days` fail before persistence. The execution schema
descriptor and SHA are included in `source_set_digest`, experiment defaults
verification, public model-view identity, and derived-view manifest inputs.
Node and Python independently load the exact bytes and run golden valid/invalid
fixtures; any schema/model/backend/default drift fails the bundle. Browser E2E
asserts the three rendered controls and boundaries from the fetched source,
including signed-int32 seed endpoints and the cross-field warm-up rule.

### Strict model-bundle protocol union

Model loading is also a strict discriminated union. Branch selection uses the
manifest root keyset before any model file is trusted; no missing or extra root
key is tolerated.

The historical Gate 1/2 branch remains byte-for-byte unchanged. Its manifest
has the exact root keyset
`{schema_version,model_id,model_revision_id,runtime_profile,files}`,
`schema_version=1`, and the exact eleven-file payload set:

```text
model.py
model-spec.json
parameter-schema.json
metric-schema.json
visualization.json
traceability.json
provenance.json
defaults/source-field-service-reference.json
defaults/wind-turbine-maintenance-demo-v1.json
tests/microcase.json
tests/source-transition-disposition.json
```

Its `runtime_profile` has exactly
`{canonical_json_version,mesa_version,model_protocol_version,python_implementation,python_major_minor}`
with the delivered values
`rfc8259-sort-keys-compact-v1`, `3.5.1`,
`wind-turbine-maintenance-v1`, `CPython`, and `3.12`, respectively. Every
`files` value has exactly `{sha256,byte_length,media_type}`. The legacy
revision algorithm, legacy canonicalizer, manifest bytes including one final
LF, and reviewed revision remain unchanged:

```text
mr_d8a62ba22c547c82286f42460dccf80f31f1d224ac8fbe8367bacd470956eb11
```

The Gate 3 framed branch has the exact root keyset
`{schema_version,bundle_protocol,model_id,model_revision_id,runtime_profile,files}`,
with `schema_version=2` and
`bundle_protocol="wind-turbine-maintenance-bundle-v2-framed"`. Its
`runtime_profile` has the same exact five-key set as legacy, with exact values
`riff-canonical-json-v2`, `3.5.1`,
`wind-turbine-maintenance-v2-framed-replay`, `CPython`, and `3.12`. Its
`files` object contains exactly the eleven paths above plus
`execution-field-schema.json`; every file descriptor again has exactly
`{sha256,byte_length,media_type}`.

The framed revision preimage has exactly
`{schema_version,bundle_protocol,model_id,runtime_profile,files}`. It omits
only `model_revision_id`, and the identifier is defined normatively as:

```text
mr_ + sha256(riff-canonical-json-v2({
  schema_version,
  bundle_protocol,
  model_id,
  runtime_profile,
  files
}))
```

After inserting that identifier, the framed manifest bytes are the entire
six-key root encoded with `riff-canonical-json-v2` followed by exactly one LF.
The LF is not part of the revision preimage, but is part of the manifest file
digest and byte length wherever the manifest itself is referenced.

The implementation PR must commit two literal golden contracts. The legacy
golden contains the delivered v1 manifest bytes, delivered v1 revision
preimage, and exact revision above. The framed golden contains the literal
canonical-v2 five-key preimage bytes for the committed twelve file
descriptors, its independently recorded expected `mr_` value, and the final
six-key manifest bytes with one LF. Node and Python must independently parse
the literal fixture, independently recompute every file descriptor and model
revision, and compare against the literal expected bytes/hash; neither test may
derive its expected value with the implementation under test. The old v1
golden remains an explicit regression test.

Runtime admission is branch-specific. The legacy loader, worker, fixtures, and
tests remain compatible with Python >=3.10; the immutable delivered manifest's
captured profile is not rewritten on those runtimes. The framed candidate is
offered, bootstrapped, materialized, or activated only when the actual process
reports exact CPython 3.12 and Mesa 3.5.1. Any other actual runtime returns
stable `incompatible_framed_runtime` before candidate bytes or an activation
intent are created, while the legacy branch continues to operate. Because the
runtime profile is inside the framed revision preimage, the committed framed
golden and its one `mr_` cover only that reviewed runtime; another Python/Mesa
profile would require separately reviewed bytes, descriptor, golden, and model
revision rather than reusing the same ID.

Both parsers require their branch's exact file-name set, byte sizes, SHA-256
values, descriptor keysets, no undeclared entries, and no symlink/path escape.
A legacy root with `bundle_protocol`, a framed root without it, a legacy
manifest with a twelfth file, a framed manifest with eleven or thirteen files,
or any mixed root, file set, runtime profile, model protocol, canonical JSON
version, discriminator, preimage, expected hash, or future unknown protocol
fails closed. There is no field injection, canonicalizer fallback, or
cross-branch upgrade.

### Evidence-index response

```ts
type RunEvidenceIndex = {
  schema_id: "riff://evidence-studio/run-evidence-index/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  run: RunReference;
  identity: {
    run_id: string;
    model_id: "wind-turbine-maintenance";
    model_revision_id: string;
    brief_revision_id: string;
    alignment_revision_id: string;
    experiment_revision_id: string;
    preset_id: string;
    seed: number;
    policy_snapshot_digest: string;
    run_admission_digest: string;
    run_intent_digest: string;
  };
  labels: {
    visibility: "private_draft";
    trust_label: "draft_unverified";
    workflow_label: "workflow_policy_met" | "workflow_policy_unmet";
    claim_labels: string[];
    non_claims: string[];
  };
  summary: BoundedWindSummary;
  replay_manifest_summary: ReplayManifestSummary;
  derived_views_manifest: BoundedDerivedViewsManifest;
  artifacts: Array<{
    artifact_id: string;
    logical_name: "request.json" | "metadata.json" | "daily-kpis.csv" |
      "domain-events.jsonl" | "summary.json" | "replay-manifest.json" |
      "derived-views-manifest.json" | "run.log";
    sha256: string;
    href: string;
  }>;
  source_links: SourceDescriptor[];
};

type ReplayManifestSummary = {
  schema_id: "riff://evidence-studio/replay-manifest-summary/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  manifest_kind: "complete" | "unavailable_population_limit" | "legacy_frameless";
  manifest_sha256: string;
  generator_version: "wind-worker-sampled-replay-v1" | null;
  sampling_algorithm: "wind-replay-sample-days-v1" | null;
  event_source_sha256: string;
  event_semantic_sha256: string;
  event_count: number;
  frame_count: number;
  sample_days_sha256: string | null;
  claim_labels_sha256: string;
  non_claims_sha256: string | null;
  unavailable_reason: null | "population_exceeds_frame_contract" |
    "legacy_frameless_manifest";
};
```

The route succeeds only for verified terminal success with exactly the Gate 1
eight-artifact allowlist. The backend rechecks the selected legacy terminal
metadata branch or the framed core/derived/final-terminal DAG, all artifact
digests needed by the response, all full run identities, replay source SHA,
and every `derived-views-manifest.json` input digest. `summary` is projected by
an allowlist and remains below 128 KiB; no raw log content is included.
`ReplayManifestSummary` declares the selected strict branch, schema/version,
count, sampling policy, whole-event/frame digests, and availability, but omits
embedded entity-frame/range arrays; those are available only through the
bounded replay page. `BoundedReplayManifest` below names the complete verified
artifact union bounded by the 4 MiB artifact limit, not this evidence-index
summary. `claim_labels_sha256` binds the exact ordered claim-label array in
every branch. `non_claims_sha256` binds the exact ordered framed non-claim array
and is null only for an immutable legacy replay that has no such field.

The Gate 3 evidence-index `labels` object and the browser's selected-run
Evidence projection are the run-projection label carrier. Gate 2
`BrowserProjectState.runs: RunReference[]` remains its exact delivered schema;
Gate 3 does not add claim/non-claim arrays to each `RunReference`. The browser
fetches and verifies the evidence index before displaying a selected run's
labels, and clears them when selection changes or verification fails. Any
future migration of `RunReference` would require a separately versioned
project-state schema and is outside this contract.

### KPI page

```ts
type KpiPage = {
  schema_id: "riff://evidence-studio/kpi-page/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  run_id: string;
  experiment_revision_id: string;
  source: SourceDescriptor;       // daily-kpis.csv
  metric_schema_source: SourceDescriptor;
  columns: Array<{ key: string; label: string; unit: string | null }>;
  rows: Array<Record<string, string | number>>;
  after_day: number;              // exclusive cursor; -1 includes day 0
  next_after_day: number;
  has_more: boolean;
};
```

`after_day` is an exclusive integer cursor and defaults to `-1`, so the first
page can contain day 0. `next_after_day` is the last scanned/returned day and
is always safe as the next exclusive cursor, including an empty terminal page.
Duplicate, missing-value, non-integer, or repeated query keys return the same
`422 invalid_request` before reading evidence. `limit` defaults to 100 and is
restricted to 1..366. Rows are parsed and
validated against `metric-schema.json`, have identical run identity fields,
and are strictly increasing by `sim_time_days`. Pagination never downsamples.
The browser may downsample only its plotted pixel series and must retain the
full fetched rows for the table/export link.

### Replay page

Current Gate 1 events and artifacts do not expose turbine coordinates or
sampled entity-state frames. Therefore the browser and backend are forbidden
to create a grid, replay the model with a client RNG, infer coordinates from
IDs, or label reconstructed guesses as run evidence. Gate 3 extends the
existing `replay-manifest.json` artifact; it does not add a ninth artifact.

The Mesa model/worker captures actual model entity state at a deterministic
bounded set of daily sampling boundaries while it owns the run. It embeds the
frames below in the replay manifest before the parent verifier computes final
artifact digests and promotes success.

```ts
type CompleteFramedReplayManifest = {
  schema_id: "riff://wind-turbine-maintenance/replay-manifest/framed/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  manifest_kind: "complete";
  identity: ReplayRunIdentity;
  generator_version: "wind-worker-sampled-replay-v1";
  sampling_algorithm: "wind-replay-sample-days-v1";
  declared_population: { turbine_count: number; crew_count: number };
  event_source: ReplayEventSourceIdentity;
  sample_days: number[];
  sample_days_sha256: string;
  frame_count: number;
  source_event_ranges: SourceEventRange[];
  frames: ReplayFrame[];
  claim_labels: string[];
  non_claims: string[];
};

type UnavailablePopulationReplayManifest = {
  schema_id: "riff://wind-turbine-maintenance/replay-manifest/framed/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  manifest_kind: "unavailable_population_limit";
  identity: ReplayRunIdentity;
  generator_version: "wind-worker-sampled-replay-v1";
  sampling_algorithm: "wind-replay-sample-days-v1";
  declared_population: { turbine_count: number; crew_count: number };
  event_source: ReplayEventSourceIdentity;
  unavailable_reason: "population_exceeds_frame_contract";
  sample_days: [];
  sample_days_sha256: string;
  frame_count: 0;
  source_event_ranges: [];
  frames: [];
  claim_labels: string[];
  non_claims: string[];
};

type BoundedReplayManifest = CompleteFramedReplayManifest |
  UnavailablePopulationReplayManifest | LegacyFramelessReplayManifest;

type SourceEventRange = {
  range_index: number;
  event_count: number;
  first_sequence: number;
  last_sequence: number;
  byte_offset: number;
  byte_length: number;
  raw_range_sha256: string;
  semantic_range_sha256: string;
};

type ReplayFrame = {
  frame_index: number;
  day: number;
  phase: "warmup" | "measurement" | "horizon_end";
  through_event_sequence: number;
  source_event_range_index: number;
  frame_state_sha256: string;
  depot: { x_km: number; y_km: number };
  turbines: Array<{ turbine_id: string; x_km: number; y_km: number; state: string }>;
  crews: Array<{
    crew_id: string;
    x_km: number;
    y_km: number;
    state: string;
    turbine_id: string | null;
    work_order_id: string | null;
  }>;
  queues: { corrective: number; planned: number };
  daily_metrics: DailyMetricProjection;
};

type ReplayPage = {
  schema_id: "riff://evidence-studio/replay-page/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  page_kind: "complete" | "unavailable_population_limit" | "legacy_frameless";
  project_id: string;
  run_id: string;
  event_source: SourceDescriptor; // domain-events.jsonl
  manifest_source: SourceDescriptor;
  generator_version: "wind-worker-sampled-replay-v1" | null;
  source_set_digest: string;
  sampling_algorithm: "wind-replay-sample-days-v1" | null;
  declared_population: { turbine_count: number; crew_count: number };
  sample_days: number[];
  sample_days_sha256: string | null;
  frame_count: number;
  unavailable_reason: null | "population_exceeds_frame_contract" |
    "legacy_frameless_manifest";
  source_event_ranges: SourceEventRange[];
  frames: ReplayFrame[];
  after_frame: number;            // exclusive cursor; -1 includes frame 0
  next_after_frame: number;
  has_more: boolean;
};
```

The framed replay manifest declares its own exact schema metadata, run/full
identity, frame generator version, exact sample-day list/digest, frame count,
complete event-log byte length/raw SHA/semantic SHA, and claim labels. Its
sampling algorithm is exactly `wind-replay-sample-days-v1`:

```text
N = min(120, horizon_days + 1)
S = [floor(i * horizon_days / (N - 1)) for i in 0..N-1]
if 0 < warmup_days < horizon_days and warmup_days is absent from S:
  replace the non-endpoint member of S nearest to warmup_days;
  if two members are equally near, replace the smaller member
sort ascending and remove duplicates
```

For `horizon_days >= 1`, `N >= 2`, so division is defined. Day 0 and horizon
are always present. `warmup_days == 0` naturally uses day 0. The replacement
cannot remove an endpoint. The sample-day digest is lowercase SHA-256 of the
canonical-v2 integer array with no prefix.

The 1095/365 baseline golden list is:

```text
[0,9,18,27,36,46,55,64,73,82,92,101,110,119,128,138,147,156,165,174,
184,193,202,211,220,230,239,248,257,266,276,285,294,303,312,322,331,
340,349,358,365,377,386,395,404,414,423,432,441,450,460,469,478,487,
496,506,515,524,533,542,552,561,570,579,588,598,607,616,625,634,644,
653,662,671,680,690,699,708,717,726,736,745,754,763,772,782,791,800,
809,818,828,837,846,855,864,874,883,892,901,910,920,929,938,947,956,
966,975,984,993,1002,1012,1021,1030,1039,1048,1058,1067,1076,1085,1095]
```

It contains 120 days and has digest
`7a80f485f327f5b83c0d6810819dde4893e0aa55a1d20326b114fd8f99889841`.
Node and Python golden tests must reproduce both values.

Replay capture is model-owned. The worker passes the exact sample-day set and
a callback into `WindTurbineMaintenanceModel`; it never introspects turbine or
crew attributes. On each sampled day the model creates one canonical
`replay_snapshot` containing depot, all entity IDs/coordinates/states,
crew associations, queues, and the same KPI projection. It computes
`frame_state_sha256`, includes that digest in the day's phase-50
`daily_snapshot` event payload, emits the event, and immediately invokes the
callback with the unchanged projection and emitted sequence. No scheduler or
agent mutation may occur between emission and callback.

The framed manifest contains no more than 120 frames and is limited to
`4 * 1024 * 1024` bytes. The worker limit
`total_success_artifact_bytes` rises from 300 MiB to exactly 304 MiB, and the
backend verifier uses the same declared limits. Before model execution, the
worker computes the worst-case framed-manifest bound from sampled-frame count,
turbine count, crew count, fixed field limits, and canonical numeric/ID bounds.
If it exceeds 4 MiB or the total artifact budget, admission/execution fails
deterministically with `worker_limit_reached`; it never drops a frame or entity.

The strict `complete` branch is required when `turbine_count <= 100` and
`crew_count <= 50`; `sample_days`, `source_event_ranges`, and `frames` are
non-empty and have the same length. For the Gate 3 baseline each frame contains exactly 100 ID-sorted turbines and
3 ID-sorted crews, with the model's actual `x_km`, `y_km`, and state at that
sample boundary, plus exact queue counts, phase, and KPI values. Coordinates
are model coordinates but still carry the persistent no-GIS disclosure. No
interpolation or browser-authored position is allowed.

Each frame range covers raw `domain-events.jsonl` bytes after the prior frame
through the current sampled phase-50 event. The binary verifier proves that
ordered `(byte_offset, byte_length)` ranges are line-aligned, non-overlapping,
contiguous, and partition exactly `[0, artifact_size)`. It requires a final
newline and recomputes the whole-artifact SHA. Non-empty ranges have
`event_count >= 1`, required integer first/last sequences, gap-free consecutive event
coverage, `last_sequence == through_event_sequence`, a raw SHA over exact
bytes, and a semantic SHA over the Gate 2 canonical event semantic projections.
Every sampled day necessarily emits its phase-50 `daily_snapshot`, so the
complete branch permits no empty range. The last event in each range is exactly
that frame's matching day/phase-50 event. The first range starts at byte zero;
the final range ends at artifact size and the final through-sequence equals
manifest `event_source.event_count`.

The parent verifier also recomputes each exact model replay projection and its
`frame_state_sha256`, requires equality with the frame and matching phase-50
daily event, validates ID uniqueness/counts/coordinate bounds/legal states,
and compares queue and KPI state counts to the same daily snapshot. Missing,
overlapping, gapped, altered, or internally inconsistent frames make the run
fail before successful promotion. Crew coordinates are the discrete
model-stored/last positions at capture; the worker and browser never
interpolate them.

For a valid run above either population limit, only the strict
`unavailable_population_limit` branch is legal. It declares the actual counts,
reason, complete whole-event byte/semantic digests and event count, but has
exact empty `sample_days`, `source_event_ranges`, and `frames`, their empty-array
sample digest
`4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`,
and zero frame count. The verifier performs whole-event and
identity checks but no final-frame or range-partition checks. The UI exposes
events/KPIs and an explicit unavailable message rather than truncating entities.

The read route pages already-verified embedded frames. `after_frame` is an
exclusive integer cursor defaulting to `-1`, so frame 0 is not skipped;
`next_after_frame` is the final returned/scanned frame index. Duplicate query
keys or invalid cursors fail deterministically before evidence access. `limit` defaults to 14
and is restricted to 1..31. It does not reconstruct frames from raw events.
The backend may cache parsed manifest pages by
`(run_id, replay_manifest_sha256, generator_version)`. The cache is disposable,
not project state, and invalidates automatically when any key changes.

### Normative replay keysets and frame-state digest

All schemas in this subsection set JSON Schema `additionalProperties: false`
at the root and every nested object. Types are exact: integers reject booleans,
all numbers are finite, arrays have declared bounds and unique IDs, and mixed
or extra keys fail verification.

`ReplayRunIdentity` has exactly these keys:

```text
project_id, run_id, model_id, model_revision_id, brief_revision_id,
alignment_revision_id, experiment_revision_id, preset_id, seed, visibility,
trust_label, workflow_label, policy_snapshot_digest, run_admission_digest
```

`ReplayEventSourceIdentity` has exactly
`logical_name, byte_length, event_count, raw_sha256, semantic_sha256,
final_newline`; logical name is `domain-events.jsonl` and `final_newline` is
true. `declared_population` has exactly `turbine_count, crew_count`.

The complete manifest exact root keyset is the keyset shown by
`CompleteFramedReplayManifest`: schema metadata, `manifest_kind`, identity,
generator/sampling versions, declared population, event source, sample list/
digest, frame count, source ranges, frames, claim labels, and non-claims. The
unavailable branch has that same keyset plus only `unavailable_reason`, with
its exact empty arrays and zero count. Both framed branches require the exact
ordered label arrays below; they are included in the strict manifest bytes and
therefore in the manifest SHA-256:

```json
{
  "claim_labels": [
    "synthetic_inputs",
    "single_seed",
    "behavioral_reproduction_not_runtime_equivalence",
    "draft_unverified",
    "no_staffing_recommendation"
  ],
  "non_claims": [
    "not_anylogic_runtime_or_numerical_equivalence",
    "not_calibrated_to_a_real_wind_farm",
    "single_seed_is_not_uncertainty_analysis",
    "no_staffing_recommendation"
  ]
}
```

Missing, reordered, duplicated, substituted, or extra label values fail strict
verification. Each framed replay root is encoded as its exact full root with
`riff-canonical-json-v2` followed by exactly one LF; its declared artifact
SHA-256 is over those final bytes, so `claim_labels` and `non_claims` cannot be
changed without a digest failure. The framed discriminator values are only
`complete` and `unavailable_population_limit`.

`LegacyFramelessReplayManifest` is the third top-level branch and delegates to
two immutable exact subparsers. Legacy v1 has exactly the seven Gate 1 identity
keys plus `claim_labels, source_artifact, source_sha256,
canonical_event_sha256, event_count, frame_policy`. Legacy v2 has exactly the
fourteen `ReplayRunIdentity` keys plus those same six replay keys.
`frame_policy` has exactly `kind, full_event_log_retained`, with values
`daily_projection` and true. Neither legacy subbranch accepts a framed schema
field. In particular, immutable legacy replay manifests do not have a
`non_claims` key; adding one would alter the old artifact bytes and must fail
the exact legacy parser.

`SourceEventRange` has exactly `range_index, event_count, first_sequence,
last_sequence, byte_offset, byte_length, raw_range_sha256,
semantic_range_sha256`. `ReplayFrame` has exactly `frame_index, day, phase,
through_event_sequence, source_event_range_index, frame_state_sha256, depot,
turbines, crews, queues, daily_metrics`. Depot has exactly `x_km, y_km`;
each turbine has exactly `turbine_id, x_km, y_km, state`; each crew has exactly
`crew_id, x_km, y_km, state, turbine_id, work_order_id`; queues has exactly
`corrective, planned`. `daily_metrics` has exactly the verified metric-schema
keyset, including all state counts and KPI numerator/denominator fields.

`ReplayPage` has exactly its displayed type keys. For page kind `complete`,
generator/sampling versions are non-null, reason is null, and returned frame/
range slices have equal indexes. For `unavailable_population_limit`, reason is
the population reason, sample-day digest is the canonical empty-array digest,
and all sample/range/frame arrays stay empty. For
`legacy_frameless`, generator/sampling are null, reason is
`legacy_frameless_manifest`, sample-day digest is null, and all
sample/range/frame arrays stay empty.
`FilteredDomainEventProjectionPage`, `KpiPage`, `SourceDescriptor`, source identity, columns,
rows, and event objects likewise use only their declared schemas; the exact
source identity always carries all nullable identity keys rather than omitting
them.

The model's canonical `ReplayFrameStatePreimage` has exactly:

```text
schema_id, schema_version, canonical_json_version,
model_id, model_revision_id, experiment_revision_id, preset_id, seed,
day, phase, depot, turbines, crews, queues, daily_metrics
```

Its schema ID is
`riff://wind-turbine-maintenance/replay-frame-state/v1`, version is 1, and
canonical JSON version is v2. Turbines and crews are ID-sorted before
serialization. `frame_state_sha256` is `fs_` plus SHA-256 of those exact
canonical-v2 bytes. The preimage deliberately excludes `project_id`, `run_id`,
brief/alignment IDs, visibility/trust/workflow/policy/admission facts,
frame/range indexes, event byte offsets/digests, timestamps, paths, and the
digest field itself. The phase-50 event stores only the resulting `fs_` value
beside its complete daily metric snapshot; the verifier rebuilds the preimage
from the model-owned callback and requires exact equality.

## Experiment editor contract

### Schema-driven fields

Fields are sorted only by verified parameter-schema `section_id` and
`display_order`: population, maintenance/failure, duration distributions,
replacement, farm/depot/crew travel, synthetic economics, and declared
availability target. Human-readable labels, type, requiredness, minimum,
maximum, unit, provenance, distribution metadata, and current/default values
all come from the verified contract. An unknown but schema-valid parameter
renders from its own declared section/label and remains editable; it is never
dropped or classified from its key in JSX.

Every row displays:

- label and canonical parameter key;
- type, unit, valid range, and distribution grouping when declared;
- `Default` and `Current` values;
- a changed marker computed from canonical scalar equality;
- a local validation message without pretending the edit has been saved.

Execution fields use the same treatment. `runtime_profile` is visible as a
read-only identity-bound detail and has no edit or reset control.

### Current, default, and diff truth

The browser displays backend-projected `parameter_defaults`, `parameters`,
`parameter_diff`, `execution_defaults`, `execution_values`, and
`execution_diff`. It independently recomputes a UI diff for immediate feedback,
but after save it accepts only the backend revision and backend diff. A
mismatch between response and refreshed snapshot is an error, not a UI merge.

### Save edit

The editor sends only changed fields:

```json
{
  "command_id": "7f27db28-84a8-4e62-9a46-0f1b9ad61d5a",
  "project_id": "<project id>",
  "session_id": "<attached session id>",
  "base_snapshot_revision": 12,
  "payload": {
    "operation": "edit",
    "parent_experiment_revision_id": "er_...",
    "parameter_changes": { "crew_count": 4 },
    "execution_changes": {}
  }
}
```

`Save as new revision` is disabled for an empty or invalid diff and while the
current run is pending. The success response is not installed optimistically;
the browser reloads or waits for the authoritative snapshot containing the
returned new experiment revision.

### Reset to defaults

`Reset all` first opens a confirmation panel listing every parameter and
execution value that will change. The preview is computed from current
backend-projected defaults and is labelled a preview. Confirm sends exactly:

```json
{
  "command_id": "933a0f6d-d3b8-4ba5-8236-d63ed84cb878",
  "project_id": "<project id>",
  "session_id": "<attached session id>",
  "base_snapshot_revision": 12,
  "payload": {
    "operation": "reset_defaults",
    "parent_experiment_revision_id": "er_..."
  }
}
```

The backend reloads the verified active model defaults. A successful reset
creates a new immutable `er_`, even if the parent was already at defaults, and
returns empty parameter/execution diffs. Cancel closes the preview without a
mutation. Reset never uses form constants, browser cache, or a prior diff.

## Issues, review, and quantitative policy semantics

The Issues & review tab always displays two policy cards, one for the current
alignment revision and one for the current experiment revision. Each card
shows the exact subject revision ID and:

```text
human project_owner workflow endorsements: N
open blocking issues: B
open non-blocking issues: W
all open issues: O
derived policy satisfied: true | false
wording: no recorded open objection | recorded open objection
```

The UI may explain the fixed default formula
`N >= 1 AND B == 0`; it does not independently recalculate the authoritative
boolean for mutation or admission. `true` is labelled `workflow threshold
met`, never trusted/correct/valid/confirmed. `false` is labelled `workflow
threshold not met`, never untrusted/invalid.

Human and Agent attestations are separate lists. Every item displays actor ID,
declared type and role, `declared_unauthenticated_local`, scope, decision,
subject, attestation ID, and supersession state. Agent endorsements and human
roles other than project owner remain visible but do not contribute to `N`.

### Exact issue commands and permissions

The issue composer may select only the exact current alignment and/or current
experiment revision. Subjects are sorted, unique, non-empty, and captured in
the draft binding. It sends this exact open payload:

```ts
type OpenIssuePayload = {
  subject_revision_ids: string[];
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  blocking: boolean;
  assignee_actor_id: string | null;
};
```

Issue-row actions use these exact route payloads:

```ts
type CommentIssuePayload =
  { issue_id: string; event_type: "commented"; body: string };
type AssignIssuePayload =
  { issue_id: string; event_type: "assigned"; assignee_actor_id: string | null; reason: string };
type TransitionIssuePayload =
  { issue_id: string; event_type: "resolved" | "closed" | "reopened"; reason: string };
```

All bodies/reasons are non-empty bounded safe text. Any attached actor may open
or comment. Only a human project owner may set the initial assignee or assign
an open issue later. An open issue may be resolved only by a human project
owner or its human assignee. An open/resolved issue may be closed only by a
human project owner or its human reporter. A resolved/closed issue may be
reopened only by a human project owner, human reporter, or human assignee.
Agent actors can open/comment/object but cannot perform human transitions by
declaring a different role. The UI derives control visibility from the
declared actor projection, while the backend independently enforces every
rule. Invalid/no-op transitions remain `409`/`422` with no event.

### Bounded attestation detail projection

The review list never relies on counts alone. Its read route returns the exact
project-owned, redacted, bounded projection:

```ts
type AttestationDetailPage = {
  schema_id: "riff://evidence-studio/attestation-detail-page/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  subject_revision_id: string;
  after: string | null;
  next_after: string | null;
  has_more: boolean;
  items: Array<{
    attestation_id: string;
    actor: {
      actor_id: string;
      display_name: string;
      actor_type: "human" | "agent";
      declared_role: string;
      assurance: "declared_unauthenticated_local";
    };
    subject_revision_ids: string[];
    scope: "workflow_progression" | "technical_review" | "other";
    decision: "endorse" | "object" | "abstain";
    rationale: string;
    issue_refs: Array<{
      issue_id: string;
      title: string;
      status: "open" | "resolved" | "closed";
      href: string;
    }>;
    created_at: string;
    supersedes_attestation_id: string | null;
    superseded_by_attestation_id: string | null;
    effective_head: boolean;
    record_digest: string;
  }>;
};
```

`limit` defaults to 25 and is 1..100. The opaque cursor binds project,
subject, last `(created_at,attestation_id)`, filter keyset, and page schema;
cross-project, altered, duplicate, or expired cursors fail closed. Items sort by
`(created_at,attestation_id)` and each ID, subject, issue reference, and
supersession edge must be reachable in the same project's event chain.
`created_at` is the immutable canonical UTC RFC3339 timestamp already stored
by the project event. The singular supersedes/superseded-by fields are the
edges for the route's selected `subject_revision_id`; a multi-subject
attestation is repeated on each subject page with that subject's own head edge.
Rationale/title are allowlisted safe text with control characters removed and
their existing bounds preserved; actor provider metadata, prompts, paths,
emails, tool payloads, and secrets are never projected. Truncation is expressed
only by `has_more/next_after`, not by silently shortening rationale, issue
references, or supersession chains. Each attestation is limited at mutation
time to 50 unique same-project issue references; an impossible historical
record above that bound fails the projection rather than truncating it.

### Exact attestation command and effective heads

```ts
type AttestationPayload = {
  subject_revision_ids: string[];
  scope: "workflow_progression" | "technical_review" | "other";
  decision: "endorse" | "object" | "abstain";
  rationale: string;
  issue_ids: string[];
  supersedes_by_subject: Record<string, string>;
};
```

Subjects are a sorted unique non-empty subset of the exact current alignment
and experiment IDs. The rationale is required. `object` requires at least one
existing issue bound to every selected subject; the Gate 3 UI requires that
issue to be open so the quantitative objection remains visible. `endorse` and
`abstain` normally send an empty issue list but may reference same-subject
issues for rationale traceability.

Effective heads are keyed by `(actor_id, subject_revision_id, scope)`. If the
actor already has an effective head for a selected subject/scope,
`supersedes_by_subject` must map that subject to the exact displayed head ID.
If there is no head, that key must be absent. Stale, non-head, cross-actor,
cross-scope, or cross-subject IDs fail; old records remain immutable.

Any attached human or Agent may create an attestation under its own immutable
declared identity. Only an effective `endorse` with
`actor_type=human`, `declared_role=project_owner`, and
`scope=workflow_progression` contributes one actor to `N`. Human non-owner,
Agent, technical-review, other-scope, abstain, and object records remain
quantitatively visible but do not increment it. An effective superseding
abstain/object removes that actor's prior qualifying endorsement from the
derived count. Agent identity can never be submitted as human.

Opening an objection is explicitly a two-command flow. The issue commits
first. After its authoritative snapshot arrives, the UI asks the user to open
a newly bound object-attestation draft; it does not silently rebase the old
draft. If the attestation then fails, the UI displays `Issue recorded;
objection attestation not recorded`, the committed issue ID/link, the exact
attestation error, and a retry control. A lost-response retry reuses the exact
attestation command ID/body and returns the idempotent stored result; a
deterministic stale/rejection requires explicit reload and a fresh command ID.
The issue is never rolled back or hidden. `resolved` and `closed` are not
displayed as proof of correctness. Issue history is loaded on demand and shows
the append-only event sequence/digest; a truncated history is labelled and
never represented as complete.

The Run button stays enabled under `workflow_policy_unmet` when an immutable
current experiment exists, no run is active, and execution-safety conditions
are satisfied. A confirmation callout states that the result will be
`private_draft`, `draft_unverified`, and `workflow_policy_unmet`. Later issue or
attestation changes never relabel an old run; the user must start a new run to
capture a new policy snapshot.

## Generated-view pipelines

### Shared rules

Every generated view is a pure function of a normalized source object:

```text
verified sources -> normalized view model -> visual renderer
                                      \----> accessible renderer
```

The visual and accessible renderer receive the same normalized object. Neither
renderer reads DOM text from the other. Each view header shows generator
version, input identities, abbreviated digests with copy controls, and links to
the full authoritative sources. Selecting a new model revision or run replaces
the source object and regenerates both renderers; no checked-in SVG coordinates,
PNG snapshots, or hand-entered chart series are product data.

If `derived-views-manifest.json` does not declare the selected view or its input
digest disagrees with the current verified source, the view is unavailable and
the download/source inspector remains available. A stale visual is never
displayed beside a new identity.

### Entity/state view

Input: verified `model-spec.json` and `visualization.json` from one exact
`model_revision_id`.

The renderer creates entity groups, state nodes, initial-state markers, and
event-labelled transition edges from the model spec. It also shows queue
priority, FIFO, non-preemption, same-time ordering, and named distribution
families as adjacent mechanism facts. It does not parse Python in the browser.

Accessible equivalent: an entity table (`entity`, `initial state`, `all
states`) followed by a transition table (`event`, `lane`, `from`, `to`) and a
mechanism definition list.

### Process/swimlane and event replay

Inputs: verified `model-spec.json`, `domain-events.jsonl`, and
`replay-manifest.json` for one exact run identity.

The process overview is generated from the model event vocabulary and lane
mapping. The run swimlane is generated from paged domain events. Each event is
placed by `sim_time_days`, `phase`, and `sequence`; turbine, queue, crew, and
system lanes are not inferred from prose. A work-order filter shows one
correlated path across request, dispatch, arrival, work, and return events.

The table equivalent contains sequence, simulation time, phase, event type,
turbine, work order, crew, before state, after state, and bounded payload. It is
the complete paged access path even when the swimlane reduces labels for
legibility.

### Business traceability

Inputs: exact decision brief, alignment map, `model-spec.json`,
`traceability.json`, parameter/execution/metric schemas, and the selected
experiment revision.

The graph follows:

```text
brief requirement/assumption/constraint/non-goal
  -> alignment entry
  -> model rule/parameter/event/metric reference
  -> experiment current value or run evidence metric
```

Known gaps and deferred/excluded source mechanisms remain visible. A broken
reference, wrong upstream revision, or unrecognized model ref fails the view;
the browser never drops the row. Accessible equivalent: a table with business
reference, mapping kind, rationale, source, model refs, current parameter value
or metric source, disposition, and gap/blocking flag.

### Bounded two-dimensional projection

Input: model/worker-generated sampled frames from the verified completed run's
`replay-manifest.json`. The event log supplies the independently recomputed
range digests; it is not used by the browser to invent missing frame state.

The diagram renders at most 100 turbine marks, 50 crew marks, one depot, two
queue counters, the day/phase, and selected KPI values. The issue-acceptance
baseline uses exactly 100 turbines and 3 crews. State is encoded by both color
and icon/shape; a legend and state-count list are always visible. Selecting a
turbine or crew opens the same entity details present in the accessible frame
table.

Playback renders one daily frame at a time. It does not replay 38,730 DOM
nodes. At 1x it advances through the sampled frames at no more than 10 visual
frames per second; higher speeds skip displayed sampled frames but update the
labelled source day and never synthesize an intermediate state. Pause,
previous frame, next frame, range slider, and direct sampled-day selection are
keyboard operable. `prefers-reduced-motion` defaults playback to paused and
removes transitions. The UI labels the result `sampled completed-run playback`,
not continuous time or live telemetry.

Accessible equivalent: for the current day, state-count tables, one 100-row
turbine table, one crew table, queue values, and KPI values. The event table is
linked as the complete temporal record.

### KPI plots

Input: validated `daily-kpis.csv` rows plus `metric-schema.json` and summary.

Default plots are availability fraction, crew utilization fraction,
corrective/planned queue lengths, turbine state counts, crew state counts, and
synthetic cost/revenue. Warm-up is visibly shaded and the measurement boundary
is labelled at day 365 for the baseline. Fractions show both numerator and
denominator in details. Synthetic currency is never formatted as a real
currency code.

Charts use one algorithm only,
`wind-kpi-equal-index-floor-v1`, and permit at most eight selected metric keys.
For `R` validated source rows:

1. if `R <= 300`, select every row index;
2. otherwise create a mandatory index set containing index 0, index `R-1`,
   the exact row whose day equals `warmup_days`, and, for each selected metric
   key in lexical order, the minimum-value and maximum-value row; equal extrema
   choose the smallest row index;
3. let `B = 300 - |mandatory|`; for `j = 1..B`, add
   `floor(j * (R - 1) / (B + 1))`;
4. deduplicate by row index with mandatory membership taking precedence, then
   sort ascending. Duplicate equal-index candidates are not refilled.

All selected metric values must be finite. The exact warm-up row must exist;
absence is evidence corruption. This produces at most 300 points, always keeps
first, last, warm-up, and declared extrema, and has no viewport-dependent
branch. The view exposes `downsampling_algorithm`, selected source-row count,
sorted source indexes, and `downsampling_digest`, defined as SHA-256 of
canonical-v2 `{algorithm_version, source_sha256, metric_keys, warmup_days,
source_indexes}`. Node and browser golden fixtures cover fewer/equal/more than
300 rows, tied extrema, candidate collisions, multiple metrics, and the
1096-row baseline. The accompanying paged raw table and CSV download remain
complete and never use this sampling.

Accessible equivalent: metric summary plus a table of exact fetched daily
rows, with metric selector, day range, units, and source digest. Charts use an
ARIA label that states metric, run, range, and number of source rows; they do
not use `role=img` as the only access path.

## Persistent labels and claim boundary

A disclosure strip is pinned under the workbench heading and repeated in the
Evidence summary/export view. It is populated from the selected model/run
source and contains, without euphemism:

- synthetic inputs and synthetic currency;
- single fixed seed and no multi-seed uncertainty analysis;
- behavioural reproduction, not AnyLogic runtime or numerical equivalence;
- no real wind-farm calibration, weather, component, spare, road, or GIS data;
- the 95% threshold is user-declared demo context, not an industry benchmark;
- private draft and `draft_unverified`;
- no crew-count, staffing, or consequential real-world recommendation;
- endorsement and issue counts are workflow facts, not scientific trust.

`minimum_availability_met` is rendered only as a comparison between the run
metric and its declared synthetic threshold. `staffing_recommendation` must be
null.

Label reconciliation is branch-aware and byte-bound. In every branch,
`claim_labels` is compared as an exact ordered array across every verified
source that carries it, including summary, replay, derived-view manifest, and
run projection when their exact branch schemas declare the field. A source
whose selected schema requires `claim_labels` but omits it fails closed.

For a framed run, `non_claims` is required in the verified summary, framed
replay manifest, framed derived-view manifest, and run projection. All four
must equal the exact ordered array in the normative framed replay contract;
the replay-manifest bytes/digest and derived-view input digests bind that
comparison. Missing or unequal values in any one source hide Evidence and fail
closed.

For a legacy run, the immutable replay manifest contains no `non_claims` and is
explicitly excluded from non-claim reconciliation. Legacy Evidence may source
non-claims only from the verified summary, verified legacy derived-view
manifest, and verified run projection. The exact selected legacy schemas
determine which of those are field carriers: omission is valid only where the
delivered immutable schema never declared the field and contributes no value;
omission from a carrier whose schema requires it fails closed. Evidence renders
the disclosure only when all required legacy carriers are present and their
ordered arrays agree. The backend never injects the summary value into old
replay or derived-manifest bytes merely to make the comparison pass.

## Loading, error, restart, and stale-source behavior

| State | Required browser behavior |
| --- | --- |
| Initial project load | Show skeleton structure with no fabricated IDs; install only the returned Gate 3 browser projection. |
| SSE reconnecting | Keep the last committed browser projection read-only, show `reconnecting`, and disable mutations until `/events/browser-v1` resync. |
| Backend restart | Reattach a new session to the same durable project/actor, reload `/browser-projection/v1`, and preserve no authority in the expired session. |
| Snapshot gap | Stop applying browser-v1 patches, reload `/browser-projection/v1`, and mark any based draft stale. |
| Model source loading | Show source identity placeholder; do not show a previous revision's diagram. |
| Evidence page loading | Keep selected run header, clear previous run visuals, and show per-panel loading states. |
| Historical run selected | Label it historical; never replace current project pointers. |
| Active run | Show bounded authoritative lifecycle status and cancel only; Evidence and replay say pending. Do not expose temp output, sampled frames, live charts, or an unverified preview. |
| Cancelled/failed/timed out | Show stable safe code/message and terminal evidence identity; no success charts or artifacts. |
| Unsupported historical view contract | Show text-only unavailable state plus verified source links; do not guess. |
| Corrupt/mismatched evidence | Hide generated result views, show safe `evidence unavailable` error/correlation ID, retain no stale chart. |
| `409` mutation conflict | Reload snapshot, preserve draft only as visibly stale, and require explicit discard. |
| `422` validation | Keep local draft, associate safe field/global errors, and do not advance revision. |
| `429` capacity | Keep state unchanged and expose safe retry guidance. |
| Provider unavailable | Conversation is disabled with explicit status; workbench inspection and direct domain actions remain available. |

Errors never expose absolute paths, stack traces, environment, credentials,
raw tool payloads, process IDs, or unrelated project IDs. An HTTP `202`, Mesa
receipt, worker exit, or browser-visible file is not displayed as run success;
only the verified terminal project projection is success.

## Accessibility contract

- All six workbench tabs follow the WAI-ARIA tabs keyboard pattern with a
  single roving tab stop and labelled tabpanels.
- Every mutation has a persistent text label, disabled explanation, pending
  state, and programmatic success/error announcement.
- Color is never the sole carrier of entity state, policy result, issue
  severity, changed values, run status, or chart series.
- All diagrams and charts have a same-source table/text equivalent adjacent or
  reachable by a labelled control without rerunning the model.
- Tables use captions, scoped headers, and paged navigation with announced row
  ranges. Virtualized tables preserve semantic row/column access.
- Focus returns to the invoking control after modal close and moves to the
  first error summary after a failed submit.
- Replay is paused by default for reduced-motion users; no content flashes more
  than three times per second.
- Acceptance covers keyboard-only use at 1440 x 900, 960 x 720, 390 x 844,
  200% zoom, and a screen-reader name/role/value scan.

## Performance and bounded rendering

The browser-safe snapshot retains Gate 2 collection bounds. Gate 3 adds these
view limits:

| Resource | Limit and behavior |
| --- | --- |
| model view sources | 512 KiB verified parsed JSON response |
| evidence index | 128 KiB summary/manifests plus eight descriptors |
| legacy unfiltered event page | delivered default and maximum 1,000; no Gate 3 filters or cache behavior |
| filtered event projection page | default 100, maximum 500; never append unbounded pages to DOM |
| KPI page | default 100, maximum 366 rows |
| replay manifest | <= 120 model/worker-generated frames and <= 4 MiB; no ninth artifact |
| replay page | default 14, maximum 31 verified sampled frames |
| event table DOM | virtualized window <= 200 rows |
| replay DOM | one current frame, <= 100 turbines and <= 50 crews |
| chart points | <= 300 shared source indexes across <= 8 selected metrics; source table unchanged |
| issue/attestation lists | respect snapshot truncation flags and load bounded history on demand |

The backend may cache only verified derived read models keyed by exact source
digests and generator version. It may not persist them as project authority or
serve them after a digest mismatch. Any limit breach returns a safe bounded
error; it never silently reduces turbines, horizon, model events, or evidence
files.

## Strict replay compatibility and project activation

Replay evidence is a strict union with no heuristic upgrade:

| Branch | Recognition | Playback behavior |
| --- | --- | --- |
| Gate 3 framed `complete` | exact framed schema plus complete discriminator, exact claim/non-claim arrays, population <=100/50, non-empty equal sample/range/frame arrays | playback available only after all frame, label, and byte-range verification |
| Gate 3 framed `unavailable_population_limit` | exact framed schema plus unavailable discriminator, exact claim/non-claim arrays, population above a limit, exact empty arrays and whole-event digests | explicit population-limit message; no playback or final-frame check |
| Legacy `frameless` | exact delivered Gate 1 v1 or Gate 2 v2 sub-keyset and identity rules, including no `non_claims` replay key | old bytes and summary/events/KPIs/downloads remain readable; sampled playback unavailable; replay is exempt from legacy non-claim comparison |

Unknown, mixed, extra-key, or partially framed manifests fail closed. Legacy
parsers never add schema fields or rewrite prior files. The Gate 3
`derived-views-manifest.json` is also a new strict version and includes the
exact `replay_manifest_sha256` in its input map; its strict root also carries
the exact `claim_labels` and `non_claims` arrays. Legacy derived-view manifests
remain byte-identical/readable, do not authorize framed playback, and
participate in legacy non-claim reconciliation only if their delivered exact
schema carries that field.

### Framed metadata/derived terminal DAG

The framed branch separates the immutable `metadata.json` core artifact from
the backend's final terminal metadata record. Every object below has an exact
keyset and `additionalProperties:false` recursively:

```ts
type MetadataCoreProjection = {
  schema_id: "riff://wind-turbine-maintenance/metadata-core-projection/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  run_id: string;
  model_id: "wind-turbine-maintenance";
  model_revision_id: string;
  brief_revision_id: string;
  alignment_revision_id: string;
  experiment_revision_id: string;
  preset_id: "wind-turbine-maintenance-demo-v1";
  seed: number;
  visibility: "private_draft";
  trust_label: "draft_unverified";
  workflow_label: "workflow_policy_met" | "workflow_policy_unmet";
  policy_snapshot_digest: string;
  run_admission_digest: string;
  run_intent_digest: string;
  request_digest: string;
  experiment_digest: string;
  runtime_profile: {
    canonical_json_version: "riff-canonical-json-v2";
    mesa_version: "3.5.1";
    model_protocol_version: "wind-turbine-maintenance-v2-framed-replay";
    python_implementation: "CPython";
    python_major_minor: "3.12";
  };
  terminal_status: "succeeded";
  started_at: string;
  completed_at: string;
};

type FramedMetadataCoreArtifact = {
  schema_id: "riff://wind-turbine-maintenance/metadata/framed/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  metadata_kind: "framed_terminal_core";
  metadata_core_projection: MetadataCoreProjection;
  metadata_core_digest: string;  // mcore_
};

type FinalArtifactBinding = {
  artifact_id: string;
  sha256: string;
  byte_length: number;
};

type FramedTerminalMetadataRecord = {
  schema_id: "riff://evidence-studio/framed-terminal-metadata/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  terminal_metadata_kind: "framed_verified_success";
  project_id: string;
  run_id: string;
  metadata_core_projection: MetadataCoreProjection;
  metadata_core_digest: string;
  artifacts: {
    "request.json": FinalArtifactBinding;
    "metadata.json": FinalArtifactBinding;
    "daily-kpis.csv": FinalArtifactBinding;
    "domain-events.jsonl": FinalArtifactBinding;
    "summary.json": FinalArtifactBinding;
    "replay-manifest.json": FinalArtifactBinding;
    "derived-views-manifest.json": FinalArtifactBinding;
    "run.log": FinalArtifactBinding;
  };
  finalized_at: string;
  terminal_metadata_digest: string; // tm_
};
```

`metadata_core_digest` is exactly `mcore_ +
sha256(riff-canonical-json-v2(metadata_core_projection))`. The core projection
contains no artifact ID/SHA/size map, no derived-view digest, no terminal
metadata digest, and no field derived from final artifact enumeration.
`metadata.json` is exactly canonical-v2 `FramedMetadataCoreArtifact` plus one
LF. `FramedTerminalMetadataRecord` is a project-owned parent record, not one of
the eight run artifacts; its digest excludes only `terminal_metadata_digest`,
and its core projection/digest must byte-match the core artifact, so it may bind
all eight final artifact IDs/SHAs/sizes without self-hashing.
It is stored under the allowlisted logical key
`projects/{project_id}/run-terminal-metadata/{run_id}/framed-v1.json`; neither
worker nor browser supplies that path.
The legacy metadata artifact and legacy terminal record branches remain their
exact delivered bytes/parsers.

The framed derived-view branch is fully frozen as follows; every displayed
type is an exact keyset with `additionalProperties:false` at every object:

```ts
type DerivedArtifactInput = {
  artifact_id: string;
  sha256: string;
};

type MetadataCoreInput = {
  metadata_core_digest: string;
};

type DerivedModelSourceInput = {
  model_revision_id: string;
  source_set_digest: string;
};

type FramedDerivedViewsManifest = {
  schema_id: "riff://wind-turbine-maintenance/derived-views-manifest/framed/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  manifest_kind: "framed_evidence_views";
  identity: ReplayRunIdentity;
  generator: {
    generator_id: "wind-evidence-derived-views";
    generator_version: "wind-evidence-derived-views-v1";
  };
  inputs: {
    metadata_core: MetadataCoreInput;
    model_sources: DerivedModelSourceInput;
    artifacts: {
      "request.json": DerivedArtifactInput;
      "daily-kpis.csv": DerivedArtifactInput;
      "domain-events.jsonl": DerivedArtifactInput;
      "summary.json": DerivedArtifactInput;
      "replay-manifest.json": DerivedArtifactInput;
    };
  };
  claim_labels: string[];
  non_claims: string[];
  projection_digests: {
    event_projection_sha256: string;
    kpi_projection_sha256: string;
    replay_projection_sha256: string;
    label_projection_sha256: string;
  };
};
```

Each `inputs.artifacts` key is the logical artifact name and its value is
exactly the same-run project-owned artifact ID plus lowercase byte SHA-256; the
replay entry must equal the separately verified replay-manifest artifact SHA.
`inputs.metadata_core` contains only the independently recomputed
`metadata_core_digest`; it deliberately contains no metadata artifact ID/SHA,
final artifact map, or terminal metadata digest. `inputs.model_sources` binds
the exact verified model revision and eight-entry
source-set digest, including execution schema, default preset, and provenance.
Identity is the exact framed `ReplayRunIdentity`; generator values, both exact ordered
label arrays, and all four projection digests are mandatory. Projection
digests are lowercase SHA-256 over these exact canonical-v2 preimages, never
rendered DOM or chart bytes:

```text
event_projection_sha256 = sha256({
  projection_kind:"filtered_domain_events", projection_schema_version:1,
  run_id, domain_events_sha256, event_count
})
kpi_projection_sha256 = sha256({
  projection_kind:"daily_kpis", projection_schema_version:1,
  run_id, daily_kpis_sha256, summary_sha256
})
replay_projection_sha256 = sha256({
  projection_kind:"sampled_replay", projection_schema_version:1,
  run_id, replay_manifest_sha256, manifest_kind, frame_count
})
label_projection_sha256 = sha256({
  projection_kind:"run_labels", projection_schema_version:1,
  run_id, summary_sha256, replay_manifest_sha256, claim_labels, non_claims
})
```

Each displayed object has exactly the shown keys; names such as
`domain_events_sha256` resolve only to the matching exact
`inputs.artifacts` value. The
root is serialized as canonical-v2 followed by exactly one LF. The
terminal artifact declaration for logical name `derived-views-manifest.json`
stores the SHA-256 and byte length of those complete bytes; Evidence index,
download descriptor, final terminal metadata record, and parent verifier must all match
that external artifact-byte digest. Self-digests are forbidden.

The parent verifier constructs and verifies the one-way DAG in this exact
order:

```text
verified run/admission/runtime facts
  -> MetadataCoreProjection -> metadata_core_digest -> metadata.json bytes
  -> replay/summary/KPI/event and other non-derived artifact bindings
  -> derived-views-manifest bytes/digest
  -> FramedTerminalMetadataRecord with all eight final artifact bindings
  -> terminal-success project event/reference
```

The terminal-success event references only the already computed
`terminal_metadata_digest`; the terminal record never references that future
event. Missing/extra/back edges, a derived input containing metadata artifact
ID/SHA, a core containing final artifacts, or a final record omitting any of
the eight exact names fails closed. Python and Node golden fixtures recompute
core/artifact/derived/final digests independently and mutate every prohibited
cycle edge.

The legacy derived-view branch retains its exact delivered discriminator,
root/nested keysets, bytes, and parser. It neither gains framed labels nor new
inputs/projections. Unknown, mixed, omitted, or extra root/input/projection
keys and any identity/artifact/label/digest mismatch fail closed; there is no
legacy-to-framed synthesis.

An already configured durable project does not silently switch to the new
model. Its explicit activation request is target-free except for the descriptor
digest already fetched from the candidate route:

```text
POST /api/projects/{projectId}/wind/framed-evidence/activate
```

```json
{
  "command_id": "261ef53e-c827-4cdd-864b-66fc2dd8a672",
  "project_id": "<project id>",
  "session_id": "<attached session>",
  "base_snapshot_revision": 20,
  "payload": {
    "source_model_revision_id": "mr_<current old>",
    "source_brief_revision_id": "dbr_<current brief>",
    "source_alignment_map_revision_id": "amr_<current old>",
    "source_experiment_revision_id": "er_<current old>",
    "expected_candidate_descriptor_digest": "cand_<reviewed descriptor digest>"
  }
}
```

The command is allowed only to an attached human `project_owner`, with no
active run, exact current four-ID source tuple, exact compatible runtime, and
the sole current candidate descriptor digest. There is no caller-supplied
target model, preset, file map, source path, or URL; the backend resolves all
target facts from that installed immutable descriptor.

### Exact activation records, digests, and ownership

All objects below have `additionalProperties:false`. Each top-level persisted
record whose last field is its own prefixed digest hashes canonical-v2 bytes of
the complete object excluding only that named digest field; helper/nested
objects do not invent a self-digest. Persisted JSON is canonical-v2 plus one LF.

```ts
type ActivationTuple = {
  model_revision_id: string;
  brief_revision_id: string;
  alignment_revision_id: string;
  experiment_revision_id: string;
};

type BundleFileDescriptor = {
  sha256: string;
  byte_length: number;
  media_type: string;
};

type FramedCandidateFileMap = {
  "model.py": BundleFileDescriptor;
  "model-spec.json": BundleFileDescriptor;
  "parameter-schema.json": BundleFileDescriptor;
  "execution-field-schema.json": BundleFileDescriptor;
  "metric-schema.json": BundleFileDescriptor;
  "visualization.json": BundleFileDescriptor;
  "traceability.json": BundleFileDescriptor;
  "provenance.json": BundleFileDescriptor;
  "defaults/source-field-service-reference.json": BundleFileDescriptor;
  "defaults/wind-turbine-maintenance-demo-v1.json": BundleFileDescriptor;
  "tests/microcase.json": BundleFileDescriptor;
  "tests/source-transition-disposition.json": BundleFileDescriptor;
};

type StagedRecordRefBase = {
  project_id: string;
  record_id: string;
  record_digest: string;
  canonical_bytes_sha256: string;
  byte_length: number;
  created_at: string;
  created_by_actor_id: string;
};

type StagedRecordRef = StagedRecordRefBase & (
  { record_kind: "decision_brief";
    record_schema_id: "riff://evidence-studio/decision-brief/activation-v1";
    record_schema_version: 1 } |
  { record_kind: "alignment_map";
    record_schema_id: "riff://evidence-studio/alignment-map/framed/v1";
    record_schema_version: 1 } |
  { record_kind: "experiment_revision";
    record_schema_id: "riff://evidence-studio/experiment-revision/framed/v1";
    record_schema_version: 1 }
);

type ActivationStagingManifest = {
  schema_id: "riff://evidence-studio/activation-staging-manifest/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  activation_id: string;
  project_id: string;
  created_at: string;
  created_by_actor_id: string;
  source: ActivationTuple;
  target: ActivationTuple;
  brief: StagedRecordRef & {
    parent_brief_revision_id: string;
    copy_rule: "exact_content_activation_copy_v1";
  };
  alignment: StagedRecordRef & {
    parent_alignment_revision_id: string;
    brief_revision_id: string;
    model_revision_id: string;
    migration_rule: "framed_alignment_rebind_v1";
  };
  experiment: StagedRecordRef & {
    parent_experiment_revision_id: null;
    model_revision_id: string;
    brief_revision_id: string;
    alignment_revision_id: string;
    preset_id: "wind-turbine-maintenance-demo-v1";
    copy_migration_rule: "framed_parameter_copy_revalidate_v1";
    defaults_digest: string;
    parameter_defaults_digest: string;
    parameters_digest: string;
    parameter_diff_digest: string;
    execution_defaults_digest: string;
    execution_values_digest: string;
    execution_diff_digest: string;
  };
  staging_manifest_digest: string; // astage_
};

type ActivationIntent = {
  schema_id: "riff://evidence-studio/activation-intent/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  activation_id: string;
  project_id: string;
  command_id: string;
  command_digest: string;
  command_digest_version: "gate3-command-digest-v2";
  base_snapshot_revision: number;
  expected_event_head_digest: string;
  authorized_actor_id: string;
  source: ActivationTuple;
  planned_target: ActivationTuple;
  staging_manifest_digest: string;
  staged_record_refs: {
    brief: StagedRecordRef;
    alignment: StagedRecordRef;
    experiment: StagedRecordRef;
  };
  expected_candidate_descriptor_digest: string;
  runtime_handshake_digest: string;
  runtime_instance_id: string;
  candidate_source_revision: string;
  expected_active_model_revision_id: string;
  created_at: string;
  intent_digest: string;          // aint_
};

type CandidateReceipt = {
  schema_id: "riff://mesa-wind/candidate-receipt/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  activation_id: string;
  project_id: string;
  intent_digest: string;
  expected_old_model_revision_id: string;
  candidate_descriptor_digest: string;
  target_model_revision_id: string;
  bundle_protocol: "wind-turbine-maintenance-bundle-v2-framed";
  manifest_sha256: string;
  files: FramedCandidateFileMap;
  file_map_sha256: string;
  candidate_bytes_digest: string;
  created_at: string;
  candidate_receipt_digest: string; // acand_
};

type ActivationTargetBinding = {
  schema_id: "riff://evidence-studio/activation-target-binding/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  activation_id: string;
  project_id: string;
  source: ActivationTuple;
  target: ActivationTuple;
  base_snapshot_revision: number;
  base_project_event_digest: string;
  intent_digest: string;
  staging_manifest_digest: string;
  staged_record_refs: {
    brief: StagedRecordRef;
    alignment: StagedRecordRef;
    experiment: StagedRecordRef;
  };
  candidate_receipt_digest: string;
  captured_candidate_bytes_digest: string;
  target_binding_digest: string;  // atb_
};

type ActivationCommitObservation = {
  schema_id: "riff://evidence-studio/activation-commit-observation/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  activation_id: string;
  target_binding_digest: string;
  project_event_digest: string;
  committed_snapshot_revision: number;
  observation_digest: string;     // aobs_
};

type MesaSwitchReceipt = {
  schema_id: "riff://mesa-wind/active-switch-receipt/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  activation_id: string;
  project_id: string;
  expected_old_model_revision_id: string;
  target_model_revision_id: string;
  candidate_receipt_digest: string;
  project_event_digest: string;
  previous_active_model_revision_id: string;
  active_model_revision_id: string;
  switched_at: string;
  switch_receipt_digest: string;  // asw_
};

type ReconcileMarker = {
  schema_id: "riff://evidence-studio/activation-reconcile-marker/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  activation_id: string;
  project_id: string;
  target_binding_digest: string;
  base_project_event_digest: string;
  base_snapshot_revision: number;
  switch_receipt_digest: string;
  verified_project_target_model_revision_id: string;
  verified_mesa_active_model_revision_id: string;
  reconciled_at: string;
  reconcile_digest: string;       // arec_
};

type ActivationCommandReceipt = {
  schema_id: "riff://evidence-studio/activation-command-receipt/v1";
  schema_version: 1;
  canonical_json_version: "riff-canonical-json-v2";
  project_id: string;
  command_id: string;
  command_digest: string;
  command_digest_version: "gate3-command-digest-v2";
  activation_id: string;
  intent_digest: string;
  terminal_status: "ready" | "failed_no_effect" | "failed_fenced";
  event_type: "model.activation_reconciled" | "model.activation_failed";
  committed_snapshot_revision: number;
  terminal_project_event_digest: string;
  target_binding_digest: string | null;
  reconcile_digest: string | null;
  safe_error_code: string | null;
  created_at: string;
  receipt_digest: string;         // acr_
};
```

The backend project store owns immutable logical records
`projects/{project_id}/activations/{activation_id}/{intent.json,
target-binding.json,reconcile.json,command-receipt.json}`, exact pre-intent
staging bytes under
`projects/{project_id}/activation-staging/{activation_id}/{brief.json,
alignment.json,experiment.json,staging-manifest.json}`, and the corresponding
append-only project events, plus the verified immutable byte capture under
`projects/{project_id}/activations/{activation_id}/captured-candidate/
{model_revision_id}/`. Mesa owns
`wind/candidates/{activation_id}/{model_revision_id}/` bundle bytes,
`wind/candidates/{activation_id}/candidate-receipt.json`,
`wind/switch-receipts/{activation_id}.json`, and its atomic
`wind/active.json` pointer. These are logical adapter namespaces, never browser or
caller filesystem paths. `activation_id` is a backend-minted canonical UUID
bound one-to-one to the command UUID. Exact command retries find the immutable
command/intent receipt before live session or base validation; same UUID with
different command digest returns `409 idempotency_conflict`.

`ActivationCommitObservation` may exist only in a disposable derived-cache
namespace and is rebuilt from the event chain; it is not project authority and
is never referenced by the same commit event whose digest it observes. If a
later durable record needs that digest, it names it only as a prior/base event,
as `ReconcileMarker` does.

Every staged ref repeats the project, schema, final ID/digest, exact canonical
byte SHA/length, actor, and frozen timestamp found inside its final record
bytes. The staging manifest's parent/copy/migration/model/preset/default/current/
diff declarations must equal those bytes; its actor/timestamp equal all three
refs and `ActivationIntent.authorized_actor_id/created_at`. The backend accepts
only its fixed
project-owned staging keys above, rejects symlinks/path traversal/cross-project
IDs, and verifies every byte before intent persistence and again before
promotion. Commit performs an atomic exact-byte promotion; retry/recovery may
never rebuild content, call the clock, remint an ID, recopy a default, or rerun
migration logic after the atomic authorization commit. A crash leaving temp or
staged bytes without a reachable matching intent/authorization event moves
that entire activation staging directory to a project-scoped
orphan quarantine under
`projects/{project_id}/quarantine/activation-staging/{activation_id}/` on
startup. Staging with a valid intent remains immutable
until terminal reconciliation; mismatched project/path/ref bytes fail fenced
and are quarantined without promotion.

The staged brief record exact root keyset is
`{schema_id,schema_version,canonical_json_version,project_id,
decision_brief_revision_id,decision_brief_digest,parent_brief_revision_id,
source_brief_revision_id,operation,copy_rule,content,created_by_actor_id,
created_at}` with `operation="activation_copy"`. The staged alignment exact
root is `{schema_id,schema_version,canonical_json_version,project_id,
alignment_revision_id,alignment_digest,parent_alignment_revision_id,
brief_revision_id,model_revision_id,migration_rule,mappings,gaps,source_refs,
created_by_actor_id,created_at}`. The staged experiment exact root is the
framed revision root containing IDs/digest/project, null parent,
`operation="create"`, model/brief/alignment/preset IDs, defaults digest,
parameter defaults/current/diff, execution defaults/current/diff,
`runtime_profile`, copy/migration rule, actor, and timestamp—no other key. Each
`content`, mapping/gap/source-ref collection, and defaults/current/diff object
uses its already declared exact nested schema and is included in canonical
record ID/digest computation.

`file_map_sha256` is SHA-256 of the canonical-v2 exact twelve-key `files`
object. `candidate_bytes_digest` is SHA-256 of a deterministic raw-byte stream:
`manifest.json` first, followed by the twelve logical paths in UTF-8 lexical
order; each entry is framed as unsigned big-endian 32-bit path-byte length,
path bytes, unsigned big-endian 64-bit content-byte length, then exact content
bytes. No separators, newline normalization, archive metadata, path aliases, or
filesystem order participate. Backend and Mesa compute it independently.

### Internal Mesa protocol

Only the backend's local Mesa adapter may call these endpoints. Every request
uses exact headers `Content-Type: application/json`,
`X-Riff-Internal-Protocol: wind-activation-v1`, and
`Idempotency-Key: {activation_id}`; GET uses `Accept: application/json` instead
of Content-Type. Unknown/duplicate headers relevant to the protocol, query
keys, or body keys fail `422 invalid_activation_protocol`.

1. `POST /internal/wind/framed-candidates/materialize` accepts exactly
   `{schema_id,schema_version,canonical_json_version,activation_id,project_id,
   expected_old_model_revision_id,candidate_descriptor_digest,intent_digest}`.
   Its metadata values are
   `riff://mesa-wind/materialize-candidate-request/v1`, 1, and
   `riff-canonical-json-v2`.
   It verifies actual CPython/Mesa versions and the installed reviewed
   descriptor, materializes immutable inactive bytes, and returns the exact
   `CandidateReceipt`: `201` for first creation or `200` for an exact replay.
2. `GET /internal/wind/framed-candidates/{activation_id}` returns exactly
   `{schema_id,schema_version,canonical_json_version,activation_id,
   candidate_descriptor,candidate_receipt,candidate_bytes_digest}` with
   metadata values `riff://mesa-wind/candidate-capture-response/v1`, 1, and
   `riff-canonical-json-v2`, after recomputing the stored byte-map digest. It never returns a caller path and
   the backend captures bytes only through bounded adapter reads keyed by the
   receipt.
3. `POST /internal/wind/active/cas` additionally requires exact header
   `If-Match: "{expected_old_model_revision_id}"` and body
   `{schema_id,schema_version,canonical_json_version,activation_id,project_id,
   expected_old_model_revision_id,target_model_revision_id,
   candidate_receipt_digest,project_event_digest}`. The request metadata values are
   `riff://mesa-wind/active-cas-request/v1`, 1, and
   `riff-canonical-json-v2`. It atomically switches and
   returns the exact `MesaSwitchReceipt`; exact already-switched replay returns
   `200` with the original receipt and no new switch.
4. `GET /internal/wind/activations/{activation_id}/status` returns exactly
   `{schema_id,schema_version,canonical_json_version,activation_id,status,
   active_model_revision_id,candidate_receipt_digest,switch_receipt}` where
   metadata values are `riff://mesa-wind/activation-status/v1`, 1, and
   `riff-canonical-json-v2`; status is `candidate_ready|switched` and `switch_receipt` is the exact
   stored receipt or null. A missing activation returns stable `404
   activation_not_found` rather than a synthetic status document.

All internal JSON uses canonical-v2. Stable failures are `409
incompatible_framed_runtime`, `409 active_model_mismatch`, `409
candidate_descriptor_mismatch`, `409 candidate_bytes_changed`, `409
idempotency_conflict`, `409 concurrent_activation`, `422
invalid_activation_protocol`, and safe `500 mesa_adapter_failure`. No 409 is
treated as success except an exact idempotent lookup whose request digest and
stored receipt match. Before project commit the backend re-GETs the candidate,
recomputes every file/manifest/revision digest from the captured Mesa-owned
bytes, and rechecks the active pointer. It never reconstructs candidate files
from the descriptor, bundled source templates, or project data.

### Crash-safe activation sequence

1. **Fresh project-bound preflight.** After validating only the command shape
   and same-project session/actor, immediately call the read-only project-bound
   handshake again, before creating a staging directory, command reservation,
   intent, project event, or fence. Rebuild the sole public candidate descriptor
   from that fresh response and reviewed sources. Require exact equality among
   path/response/command `project_id`, submitted
   `expected_candidate_descriptor_digest`, recomputed descriptor digest,
   runtime handshake digest/instance, exact runtime/protocol/source revision/
   manifest/file-map/source-descriptor tuple, and expected active pointer. The
   pointer must equal both the descriptor's
   `expected_active_model_revision_id` and command source model. Runtime
   incompatibility returns `409 incompatible_framed_runtime`; restart, pointer,
   source, descriptor, or handshake drift returns `409 stale_candidate`. Both
   have zero durable/temp writes, no fence, and no materialization/CAS call.
2. **Stage and authorize.** Using only the just-verified fresh descriptor,
   validate permission/source tuple. Freeze one `created_at`
   and actor, build exact final canonical bytes for a new brief copy, new
   alignment migration, and new experiment migration, and compute their final
   content IDs/digests. The brief names its source brief as parent and exact
   copy rule; alignment names source alignment, new brief/model, and migration
   rule; experiment has null experiment parent and exact model/brief/alignment/
   preset/runtime bindings plus complete defaults/current/diff objects and their
   digests. Fsync the three bytes and `ActivationStagingManifest`, then
   atomically promote the staging directory, persist `ActivationIntent` and the
   command reservation, and append `model.activation_authorized` with exact
   ordered refs to staging manifest then intent. That event sets
   `run_admission_fenced=true`. Only then may a
   state-changing/materialization Mesa endpoint be called. Browser status is
   `authorizing`.
3. **Materialize/capture.** Invoke the internal materialize and GET endpoints,
   verify exact bytes and `CandidateReceipt`, then expose `candidate_ready`.
4. **Bind then commit project truth.** Persist `ActivationTargetBinding` from
   the prior snapshot/event, intent, staged refs, candidate receipt, and captured
   bytes; it contains no future event digest. One atomic project transaction
   promotes the three exact staged byte files without reparsing/reserializing or
   regenerating IDs/timestamps, clears current run, advances phase to `review`,
   and appends `model.activation_committed`. That ProjectEvent's exact ordered
   `record_refs` are target binding, staged brief, staged alignment, staged
   experiment; the event is the first object allowed to contain its computed
   event digest. Status moves through `project_committed` to
   `mesa_switch_pending`; the fence remains.
5. **Switch.** Invoke exact Mesa CAS with the committed project-event digest;
   independently verify the returned `MesaSwitchReceipt` and status endpoint.
6. **Mark then reconcile.** Persist `ReconcileMarker` referencing only the
   activation-commit event as its base and the switch receipt; it contains no
   future reconciliation-event digest. Append `model.activation_reconciled`
   with exactly one `record_ref` to that marker. Only afterward write a `ready`
   command receipt referencing that terminal event digest if the original
   client command has no terminal receipt. If it already has immutable
   `failed_fenced`, system reconciliation writes no replacement client receipt
   and updates only authoritative activation state. Exact target
   agreement among project tuple, staged bytes, target binding, captured
   candidate, commit event, switch receipt, marker, and Mesa active pointer
   produces `ready` and lifts the fence.

The normative digest graph is acyclic and one-way:

```text
staged brief/alignment/experiment bytes
  -> staging manifest -> activation intent -> authorization ProjectEvent
  -> candidate receipt/capture
  -> activation target binding -> activation-commit ProjectEvent
  -> Mesa switch receipt -> reconcile marker -> reconciliation ProjectEvent
  -> activation command receipt/browser projection
```

The authorization event `record_refs` are exactly
`[(activation_staging_manifest,activation_id,staging_manifest_digest),
(activation_intent,activation_id,intent_digest)]`. The commit event
`record_refs` are exactly
`[(activation_target_binding,activation_id,target_binding_digest),
(decision_brief,target.brief_revision_id,brief.record_digest),
(alignment_map,target.alignment_revision_id,alignment.record_digest),
(experiment_revision,target.experiment_revision_id,experiment.record_digest)]`
in that order. The reconciliation event has exactly
`[(activation_reconcile_marker,activation_id,reconcile_digest)]`. No referenced
record contains the digest of the event that references it. Node/backend golden
fixtures require target binding base snapshot/event to equal the commit event's
`previous_snapshot_revision/previous_event_digest`, and marker base
snapshot/event to equal that committed event. They independently recompute
every node/edge, reject a back-edge/future
event digest, and prove exact `record_refs` ordering.

If any copied value is invalid under the new schemas, any source/current tuple
is stale, or any target digest differs, the entire command has no durable
project-pointer effect before the project-commit transaction. Exact retries
return the stored result. For a deterministic failure before project commit,
recovery records one immutable
failed command receipt. It may return to the pre-activation null projection and
lift the fence only after independently proving both durable and Mesa pointers
still equal the expected old model, recording `failed_no_effect`; otherwise it
records and projects `failed_fenced`. A
failure at or after project commit cannot roll back pointers or new revisions;
it remains `failed_fenced` until exact reconciliation succeeds.
Old brief, model, alignment, experiment, attestations, issues, runs, and
artifacts remain immutable and
addressable. Because policy is revision-scoped, old attestations/issues do not
silently apply to the new subjects; the new alignment and experiment begin
with their quantitatively derived current policy. The UI explicitly shows the
new subject IDs and requires new review actions. No old run is relabelled or
given generated frames.

Startup recovery loads the staging manifest/bytes, activation intent, target
binding, candidate receipt, project-event
chain, switch receipt, and both pointers before serving run admission. It
idempotently resumes the first missing stage. A crash before the atomic
stage/intent/authorization promotion leaves no authorized activation and its
temp bytes are quarantined; after that atomic point, recovery uses only the
frozen bytes. Crashes before/after authorization,
candidate receipt, byte capture, project-event rename, snapshot replace, Mesa
compare-and-swap, switch receipt, and reconciliation event are fault-injected.
Every case yields one activation intent, one candidate, one project activation
event, one Mesa switch, and one reconciled terminal state after retry/restart.

If Mesa appears switched while the browser snapshot or durable pointer appears
old (for example, crash after project-event commit but before cache rebuild),
the activation fence blocks old-model and new-model runs. Recovery first
replays committed project events; if no project event is yet committed, it
uses only the authorized intent/candidate receipt to finish or safely fail the
protocol. It never executes an old durable experiment against the new Mesa
pointer or a new experiment against the old pointer. Pointer disagreement,
candidate-byte TOCTOU, wrong expected-old/new IDs, or two concurrent activations
is a fail-closed reconciliation state, never split-brain fallback.

Candidate lifetime is immutable and explicit. Before project commit, inactive
candidate bytes are Mesa-owned, retained by `(activation_id,model_revision_id)`,
and unavailable from public model source routes; only the safe descriptor is
public. The backend's verified capture is retained with the project activation
records and is never treated as the active source by itself. After ready, the
target bundle becomes a project-owned model revision and public active or
historical `view-sources` reads must reverify exact retained manifest/file bytes
against that revision and project event reachability. Later activations do not
delete it. A failed/unreconciled candidate remains immutable and quarantined,
cannot back a run or public view source, and is not garbage-collected in Gate 3.
Legacy/historical bundle bytes likewise remain immutable and are verified by
their own strict branch on every source read.

## Legacy coexistence through Gate 3

Gate 3 makes the durable wind project the default browser workbench. The old
`/api/sessions/{sessionId}` queue demo routes, queue model, old UI types, and
fixture tests may remain reachable only as an explicitly labelled legacy path
until Gate 4.

Any conversation shown in Gate 3 is explicitly a non-authoritative legacy or
fixture conversation surface. It may explain a snapshot or suggest that the
user use a typed workbench action, but it cannot issue a durable project
mutation, declare that a command committed, derive readiness, or supply a
missing brief/model/review/run fact. Gate 3 direct domain controls remain usable
when chat/provider state is absent. Gate 4 owns the live OpenCode typed-action
bridge and its release evidence.

The two paths cannot share durable project IDs, command receipts, session
authority, parameter types, run references, artifacts, or success state. A
failed wind request never falls back to queue. No Gate 3 component imports a
queue schema or uses queue fixture data to fill a wind state. New wind browser
tests enter through `/api/projects/{projectId}`.

Gate 4, not Gate 3, performs the audited destructive deletion of all queue
source, routes, prompts, tests, fixtures, docs, and build references after the
replacement live-provider flow passes.

## Explicit Gate 4 non-goals

Gate 3 does not claim or implement:

- successful use of a configured live OpenCode provider/model;
- natural-language-to-domain-action release acceptance;
- MCP/browser action projection as authoritative state;
- public deployment, authentication, remote multi-user collaboration, or
  access-control security;
- deletion of `queue-network-v1` or legacy session APIs;
- scientific validation, calibration, AnyLogic numerical equivalence,
  uncertainty quantification, optimization, or staffing recommendation;
- promotion of private drafts or a qualitative trusted/untrusted state.

Deterministic Agent/HTTP fixtures are allowed for Gate 3 component and browser
tests, but they must be labelled fixtures and cannot be cited as Gate 4 live
provider evidence.

## Product acceptance matrix

| Scenario | Browser assertions | Backend/artifact assertions |
| --- | --- | --- |
| Safe discovery | exactly one healthy configured project is shown; actor is explicitly chosen and only actor ID is remembered | 200 only for one project, 404 none, 409 multiple; no route creates/selects silently and actor declarations are bounded/redacted |
| Open durable project | exact project/current IDs and declared actor arrive only from `/browser-projection/v1`; no legacy queue copy | Gate 3 projection matches durable store before/after restart while Gate 2 snapshot/SSE routes and bytes remain unchanged |
| Desktop/narrow shell | 40/60 two-pane desktop; labelled pane switch and ARIA tabs on narrow view | no state mutation from layout/tab changes |
| Brief/model identities | current revisions and source digests visible | returned records recompute and belong to project/model revision |
| Schema-driven edit | all 26 model parameters plus 3 execution fields appear; unit/provenance/distribution/range/default/current visible without key inference | schema properties and preset/provenance bytes bind exact field metadata; scalar nulls and triangular group low/mode/high constraints pass Node/Python drift oracles |
| Execution schema | horizon 1/3660, warm-up 0 and `< horizon`, and signed-int32 seed endpoints render from source; invalid boundaries explain safely | eight-binding source-set digest binds six parsed views plus exact execution/default-preset/provenance bytes; Node/Python valid/invalid/drift oracles agree |
| Save diff | edit one value, preview exact diff, save, see new `er_` and parent | immutable revision, backend diff, snapshot event, restart recovery all agree |
| Reset | preview every changed field; confirm; see new `er_` and empty diffs | reset reloads model defaults, restores execution defaults, preserves history |
| All-draft freshness | unrelated comment/actor event stales experiment/reset/issue/attestation drafts; reconnect/409 preserves bytes and requires explicit discard | original base and subject/head IDs remain visible; stale command has no durable effect and no silent rebase |
| Pending-command races | reducer fixtures reconcile transport races and show immutable `failed_fenced` receipt separately from later current `ready` activation | Gate 2 v1 retains literal `:issue`/`:run`; Gate 3 v2 binds version/actual route; receipt outcome is never rewritten by later system reconciliation |
| SSE contract | browser-v1 snapshot installs; next root replacement installs; gap/digest mismatch reloads the browser-v1 projection | exact new response/snapshot/patch/reload schemas verify while delivered Gate 2 `/snapshot` and `/events` bytes/tests remain unchanged |
| Review separation | alignment and experiment cards show separate IDs/counts | projections equal independently derived subject policies |
| Agent review | Agent endorsement visible only in Agent list | human project-owner count unchanged |
| Blocking objection | open scoped blocking issue makes only the subject policy false | issue event chain, counts, wording, and policy digest verify |
| Issue permission matrix | open/comment/assign/resolve/close/reopen controls and reasons match actor/status; forbidden controls explain | exact payload keys/routes and owner/reporter/assignee/human/Agent transitions pass with no-op failures closed |
| Attestation heads | paged endorse/object/abstain detail shows rationale, issue refs, created time and effective supersession; Agent/non-owner remain separate | project ownership, redaction, cursor binding, actor-subject-scope head, issue binding, and progression counts recompute |
| Partial objection | committed issue remains visibly linked when object attestation fails; exact lost-response retry is available | issue is not rolled back; idempotent attestation retry returns stored result or explicit fresh command follows rejection |
| No issue | UI says `no recorded open objection` | zero open issue count; no qualitative trust field exists |
| Policy-unmet run | run action remains available with draft warning only when model activation projection permits it | admission is private/draft and workflow-unmet, activation is null with verified pointer agreement or ready with exact target agreement, and caller supplied no labels |
| Later endorsement | old run labels remain unchanged; new run captures new state | old artifacts byte-identical; new admission has new policy snapshot |
| Entity/state diagram | nodes/edges update after selected model revision changes | normalized graph equals model spec and source digests |
| Model bundle union | historical and framed model details load under their own labels | delivered legacy exact five-key/schema-1 manifest and `mr_d8a62...eb11` stay byte-identical; framed exact six-key/schema-2 root, v2-framed protocol/profile, twelve files, canonical-v2 preimage/final LF, and literal Node/Python golden hashes pass; mixed roots/files/profiles/canonical versions and unexpected root `schema_id`/`canonical_json_version` fail as extra keys |
| Framed runtime handshake | compatible candidate is visible only after the project-bound read-only handshake; incompatible state leaves legacy usable | path/response project, runtime instance/protocol/source/pointer/descriptors/digest verify; unknown/cross-project are uniform, and restart/pointer/runtime/source TOCTOU before activation yields stale/incompatible with zero writes/materialization |
| Traceability | every business row and known gap has a visible mapping/table row | brief/alignment/model/experiment tuple and refs verify exactly |
| Swimlane/events | filtered work order sequence and accessible event rows agree | new event-projection/v1 pages retain order, identities, and complete source artifact; legacy unfiltered route remains unchanged at limit 1,000 |
| Sparse event projection | zero-match page advances cursor and preserves source/digest; duplicate queries fail consistently | versioned projection route stops at limit match/5,000/EOF, discards no scanned match, preserves `scanned_through_sequence==next_after`, and alone uses the immutable byte-range cache plus atomic 512-event index |
| 100-turbine replay | depot, 100 actual-position turbines, 3 actual-position crews, queues, sampled day/phase/KPIs usable | <=120 embedded frames and every event-range digest, entity state, coordinate, aggregate, identity, and final sequence verify before success |
| Replay sampling golden | sampled-day control starts at frame 0, includes 365 and 1095, and exposes list digest | exact v1 formula yields the documented 120-day list/digest and capture follows matching phase-50 event |
| Replay binary binding | frame source-range details and frame-state digest are inspectable | complete line-aligned ranges are non-empty and partition the event bytes; raw/semantic SHA, final newline/whole SHA, sequence and state/KPI equality pass |
| Replay budget | supported baseline is complete; oversized declared frame contract shows deterministic failure, never a partial replay | manifest <=4 MiB, total <=304 MiB, preflight bound and no frame/entity dropping pass |
| Replay discriminators | <=100/50 run has complete playback; larger run has explicit population-unavailable state; legacy run is frameless | both framed branches carry exact ordered claim/non-claim arrays and strict bytes/digest; complete ranges are non-empty/match phase-50; unavailable arrays are exact empty with whole digests; legacy replay has no non-claims and is the only third branch; extras fail |
| Frame-state canonicality | frame/source inspector shows exact `fs_` and source identities | exact preimage inclusions/exclusions, nested keysets, ID order, daily-metric keyset, and strict extra-key failures pass |
| Active-run boundary | only status/cancel is shown; playback says pending | no temp or unverified frame is browser-readable before verified terminal success |
| KPI plots | warm-up boundary and exact metric units visible; table equivalent works | values equal daily KPI artifact and metric schema; no chart-only data |
| KPI sampling golden | chart exposes <=300 deterministic indexes while raw day-0 page uses cursor -1 and remains complete | exact equal-index-floor v1 mandatory/tie/dedup digest fixtures and exclusive cursor semantics pass |
| Source inspection | each active/historical view shows generator, IDs, digests, and working source links; inactive candidate exposes descriptor only | links are same-project allowlisted retained bytes with matching revision/event/SHA; failed or unreconciled candidate bytes remain quarantined and unreadable publicly |
| Downsampling | resize/speed change alters only rendered samples/frames | source row/event counts and artifact digests remain unchanged |
| Persistent claims | synthetic/single-seed/behavioural/draft/no-recommendation visible in Run and Evidence | exact ordered claim labels agree across every carrier; framed non-claims agree across summary/replay/derived/run, while legacy excludes immutable replay and reconciles only branch-required summary/derived/run carriers; any required missing/mismatch fails closed |
| Metadata/derived DAG | selected framed views and labels load only after terminal DAG verification | run facts→exact core/digest→derived with core digest plus five artifact inputs→final terminal record with all eight artifacts is acyclic; forbidden metadata SHA/back-edge mutations fail and legacy metadata remains unchanged |
| Active/terminal failures | no premature charts; safe cancelled/failed/timed-out state visible | only verified success exposes artifacts; no temp-child success leaks |
| Restart | reconnect uses a new session and browser-v1 routes to restore the same project/revisions/run | durable replay and artifact verification succeed without minted identities; Gate 2 routes stay byte-identical |
| Current declarations | refreshed Brief/Model/Experiment/Run/Evidence and activation fence render without chat inference | browser-v1 projection carries bounded current records, exact `model_activation`, and eight terminal artifact declarations without altering Gate 2 projection |
| Framed activation | owner activates from a target-free candidate digest, sees exact staged target tuple/fence until ready, then new brief/model/alignment/experiment subjects | immutable staged bytes→intent→target binding→commit event→CAS receipt→marker→reconcile event→command receipt verify with exact one-way refs; no record contains its referencing event digest |
| Activation crash matrix | a projected `failed_fenced` state disables Start run; if system reconciliation later reaches ready, both historical failure and current readiness are visible | tests cover fresh-handshake→first-write boundary, restart/pointer/source and multi-project TOCTOU, staging/orphan quarantine, immutable receipts, and later CAS/reconcile without split brain |
| Strict replay union | legacy run remains inspectable with playback-unavailable explanation | legacy frameless v1/v2 parse only exact old branches without `non_claims`; framed complete/unavailable and derived replay/label SHA parse only the exact new branch |
| Corruption | stale visual is cleared and safe error shown | modified source/artifact/digest fails closed |
| Accessibility | full workflow keyboard-operable; equivalent tables/text present | visual and accessible components receive the same normalized object |
| Responsive | 1440, 960, and 390 widths remain usable at 200% zoom | responsive changes create no commands or project events |
| Legacy isolation | default wind UI never falls back to queue | wind failure does not call queue route/model; stores and IDs remain separate |
| Chat authority | legacy/fixture conversation is visibly non-authoritative; direct workbench remains usable without it | chat/DOM text cannot mutate or fill any durable wind projection field |

A screenshot alone is insufficient. Each browser assertion must be paired with
API state and, for run evidence, persisted artifact identity/digest assertions.

## Proportional test responsibility

Test ownership follows the failure boundary; the browser suite is not a proxy
for storage/protocol correctness:

- Backend/Mesa fault tests own every activation crash boundary, restart resume,
  fresh project-bound handshake versus first write, restart/pointer/source/
  multi-project TOCTOU, zero-write failures, staged-byte orphan/promotion,
  activation/event DAG references, concurrent
  activation, candidate-byte TOCTOU, expected-old/new CAS,
  idempotency conflict, project/Mesa pointer disagreement, runtime gate, and
  run-fence assertion.
- Independent Node and Python contract tests own strict bundle/replay/derived
  and framed metadata-core/final parsers, exact keysets/canonical bytes and
  prohibited-cycle mutations, schema-preset-provenance drift,
  event-range and frame-state reconstruction, artifact/label/projection
  digests, cursor/query fixtures, and legacy golden regressions.
- Client reducer tests own pending-command HTTP/SSE/reconnect/lost-response
  races, route-specific Gate 2 v1/Gate 3 v2 command-digest goldens,
  immutable failed receipt versus later ready current projection, browser-v1
  projection gap replacement,
  draft staleness, and projection clearing. They use immutable action fixtures,
  not a real browser.
- Playwright is intentionally limited to: activation happy path plus backend
  restart; a visibly fenced activation failure; edit/reset/policy interaction;
  one verified 100-turbine/3-crew replay; and keyboard, reduced-motion,
  responsive/200%-zoom acceptance. It does not enumerate crash points, parser
  mutations, range/digest combinations, or reducer race permutations.
- Component/accessibility tests cover all remaining generated views, source
  inspectors, attestation paging, unavailable/legacy branches, tables/charts,
  loading/corruption states, and same-normalized-object rendering.
- Compatibility tests byte-compare delivered Gate 2 snapshot/SSE responses and
  historical command receipts before/after Gate 3, including literal
  placeholder v1 route preimages; they never call the Gate 3 parser.

## Staged implementation order

Implementation proceeds in this dependency order, with focused tests and an
independent review at each boundary:

1. **Freeze types and fixtures.** Add Gate 3 public TypeScript types, exact
   response schemas, Gate 2 v1/Gate 3 v2 digest goldens, byte-identical Gate 2
   snapshot/SSE fixtures, and builders from real Gate 2 records and verified
   Gate 1 artifacts. Do not change the default UI yet.
2. **Complete the versioned view contract.** Add initial states and transition
   event mapping to model spec and its code/spec oracle, create the new model
   revision, expose six parsed model view sources plus exact preset/provenance
   bindings, implement the project-bound read-only runtime handshake, mandatory
   fresh activation preflight, and fenced staged-bytes/
   intent/target-binding/project-event/CAS/marker activation protocol with new
   brief/alignment/experiment,
   and prove older model revisions use text-only/frameless compatibility rather
   than being guessed or mutated.
3. **Add evidence read models.** Extend the existing replay manifest with at
   most 120 model/worker-generated actual-position frames and per-frame event
   byte/semantic range digests and frame-state bindings; extend the binary
   parent verifier and 4/304-MiB preflight; then implement verified evidence
   index, exclusive-cursor KPI/replay pages, the separate sparse-index filtered
   event-projection route while preserving Gate 2 events, the exact
   metadata-core→derived→final-terminal DAG, source-set digests,
   strict legacy/framed unions, corruption tests, and
   bounded digest-keyed immutable byte-range/index caches.
4. **Add durable-project client/state.** Implement safe default discovery,
   explicit actor selection/project session attachment, authoritative
   `model_activation`, exact `/browser-projection/v1` and `/events/browser-v1`
   schemas/digest/gap recovery without changing Gate 2 routes,
   restart reattachment, typed mutations, any-revision all-draft staleness, and
   frozen pending-command receipt reconciliation/idempotent retry race tests,
   and safe error mapping without touching legacy queue client behavior.
5. **Build the two-pane shell and six views.** Preserve project style, add
   responsive ARIA navigation, durable identity header, disclosure strip,
   loading/error boundaries, and source inspector.
6. **Implement experiment and review actions.** Add schema-driven edit/diff,
   execution-schema validation, reset preview/new revision, the complete issue
   permission/transition matrix, superseding attestation heads, partial
   objection recovery, separate policy cards, safe policy-unmet run,
   lifecycle, and cancel.
7. **Implement generated structure views.** Add entity/state and traceability
   normalized data builders, visual renderers, and same-object table/text
   equivalents with drift/failure tests.
8. **Implement run evidence views.** Add virtual event table, process/swimlane,
   bounded replay, KPI plots/tables, historical-run selection, source links,
   exact equal-index-floor sampling, reduced motion, and claim labels.
9. **Run integrated Gate 3 acceptance.** Execute component, reducer, API
   contract, independent Node/Python parser, backend/Mesa fault/regression,
   production-build, and the intentionally bounded Playwright scenarios above;
   verify persisted state and artifacts after backend restart. Keep the legacy
   path isolated for Gate 4.

No stage may replace verified source data with canned result arrays in product
code. Fixture data remains test-only and explicitly labelled.

## Gate 3 exit evidence

The Gate 3 PR may be marked ready only with:

- focused backend route/read-model, web component/state, accessibility, and
  corruption suites passing;
- all Gate 1 Mesa and Gate 2 durable-state regressions passing, with byte-equal
  Gate 2 snapshot/SSE and v1 receipt/placeholder-route golden evidence;
- a production web build;
- reducer evidence for stale/pending-command races; backend/Mesa evidence for
  staged activation DAG/crashes/TOCTOU/CAS, project-bound fresh runtime
  handshake, zero-write stale failures, and multi-project isolation;
  Node/Python evidence for parser/range/digest, metadata terminal DAG, and
  Gate 3 v2 route contracts; component evidence for generated/unavailable/
  legacy views;
- Playwright evidence only for activation happy path plus restart, visibly
  fenced failure, edit/reset/policy, one 100-turbine/3-crew replay, keyboard,
  reduced motion, responsive widths, and 200% zoom;
- persisted project and exact artifact digest verification after the browser
  run and after backend restart;
- an independent scope/claim review confirming that no qualitative trust,
  numerical equivalence, uncertainty, recommendation, or Gate 4 live-provider
  claim entered the UI.

Gate 3 can close issue #5 after that evidence is reviewed. Gate 4 remains a
separate goal with a separate PR and destructive queue-retirement audit.
