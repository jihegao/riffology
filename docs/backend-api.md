# Backend API contracts

## Milestone A2 authority and A3-1b batch execution

The current authority is the
[`Milestone A product contract`](milestone-a-product-contract.md) and
[`Milestone A2 design`](milestone-a2-agent-workspace-design.md), not the legacy
Gate API retained below. `ProductStoreV2` schema v4 and checked object bytes are
the durable authority. Browser/API callers cannot supply ownership, workspace
paths, file digests, OpenCode session identifiers, process commands, or
technical status.

The implemented Stage 2 routes are:

| Route family | Current Stage 2 contract |
| --- | --- |
| `GET /api/providers` | Discover backend-validated OpenCode provider/model pairs; return no credentials or upstream session IDs. |
| `POST /api/models` | Accept a name and initial provider/model, then atomically create a generic Model, its first conversation, and server-owned scaffold. |
| `GET /api/models/{modelId}/workspace` | Return an allowlisted, digest-bound Model workspace projection; never an absolute path or arbitrary file API. |
| `POST /api/models/{modelId}/technical-checks` | Start or idempotently return a digest-bound thin technical check using a `commandId`. |
| `GET /api/models/{modelId}/technical-checks/{checkId}` | Read the bounded check DTO and its `pending`, `published`, or `superseded` publication state. |
| `GET/POST /api/objects/{model|project}/{id}/conversations` | List/create owner-scoped named conversations. Provider/model locks with the first accepted user message. |
| `GET /api/conversations/{conversationId}` | Return the redacted durable conversation and public session state. |
| `GET /api/conversations/{conversationId}/messages` | Return the ordered Riff-owned transcript. |
| `GET /api/conversations/{conversationId}/documents` | Return persistent temporary-document cards separately from committed owner files. |
| `POST /api/conversations/{conversationId}/attachments` | Store a bounded canonical-base64 upload under the conversation with server-derived path and digest. |
| `POST /api/conversations/{conversationId}/turns` | Run an idempotent durable turn and return live or structured read-only state, messages, skill uses, and action records. |
| `POST /a2/mcp?cap=...` | Internal loopback JSON-RPC endpoint for the short-lived, server-minted turn capability; not a browser tool API. |
| `POST /api/projects` | Create a server-owned fixed copy from an active technically executable Model. |
| `GET /api/projects/{projectId}/workspace` | Return the allowlisted copied execution metadata, conversations, experiments, runs, and indexed output projections. |
| `POST /api/projects/{projectId}/experiment-configs` | Validate and canonicalize `ExperimentConfigurationV1`, expand its exact plan, and persist an immutable create-command response receipt. |
| `PATCH /api/projects/{projectId}/experiment-configs/{configId}` | Require `commandId`, `expectedConfigurationDigest`, and `expectedRecordDigest`; apply both CAS guards and preserve exact historical response replay. |
| `POST /api/projects/{projectId}/runs` | Replan and freeze the named experiment, apply server-owned limits, atomically create/replay the queued run receipt, and make it eligible for the A3-1b batch dispatcher. |
| `GET /api/projects/{projectId}/runs/{runId}` | Return the bounded run projection and, only after atomic success, its checked output-index projections. |

The implemented experiment request fields are exact:

```ts
type ExperimentConfigurationV1 = {
  schemaVersion: 1;
  runKind: "batch" | "visual";
  parameters: JsonObject;
  sampling:
    | { kind: "single"; seed?: SafeInteger }
    | { kind: "multiple-seeds"; seeds: SafeInteger[] }
    | {
        kind: "cartesian-sweep";
        axes: Array<{ pointer: JsonPointer; values: JsonValue[] }>;
        seeds?: SafeInteger[];
      };
};

type CreateExperimentConfigurationRequest = {
  commandId: string;
  name: string;
  configuration: ExperimentConfigurationV1;
};

type UpdateExperimentConfigurationRequest = {
  commandId: string;
  expectedConfigurationDigest: string;
  expectedRecordDigest: string;
  name?: string;
  configuration?: ExperimentConfigurationV1;
}; // at least one of name/configuration is required
```

Both routes return the version-4 experiment DTO with `id`, `projectId`, `name`,
canonical `configuration`, `lifecycleState`, `createdAt`, `updatedAt`,
`contractVersion: 4`, `readOnly: false`, `legacyDigest: null`,
`configurationDigest`, `recordDigest`, and exact `sampleCount`.
`estimatedSampleCount` remains in the public DTO only as an equal-valued
compatibility alias. Callers do not send `sampleCount`, expanded samples,
server-derived IDs, sample-plan digests, or timestamps.

The A3-1b public start request is exact:

```ts
type StartProjectRunRequest = {
  commandId: string;
  experimentConfigId: string;
  completionConversationId?: string;
};

type RunStartDto = {
  schemaVersion: 1;
  commandId: string;
  runId: string;
  projectId: string;
  experimentConfigId: string;
  completionConversationId: string | null;
  status: "queued";
  runKind: "batch";
  sampleCount: number;
  createdAt: string;
};
```

Accepted starts return `201` and the exact durable receipt. Reusing the same
`commandId` with the same intent returns that same receipt, including after the
run has completed; changed intent fails idempotency. The route owns
`projectId`. Callers cannot provide a Project path, execution root, snapshot or
plan digest, sample expansion, limits, process command, attempt identity, or
output metadata. Unknown fields fail with `422 unknown_field`.

The public read DTOs are allowlisted:

```ts
type ProjectRunDto = {
  id: string;
  projectId: string;
  experimentConfigurationId: string;
  status: string;
  requestedSampleCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  contractVersion: 3 | 4;
  readOnly: boolean;
  legacyDigest: string | null;
  runKind: "batch" | "visual" | null;
  cancelRequestedAt: string | null;
  terminalCode: string | null;
  completionCardDisposition: string | null;
  outputs: ProjectOutputDto[];
};

type ProjectOutputDto = {
  id: string;
  runId: string;
  logicalName: string;
  outputType: string;
  contractVersion: 3 | 4;
  readOnly: boolean;
  legacyDigest: string | null;
  sampleIndex: number | null;
  sampleId: string | null;
  declaredRole: string | null;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};
```

Non-succeeded run projections return `outputs: []`. A succeeded run exposes
only atomically published indexes whose bytes, size, and SHA-256 were rechecked;
there is not yet a public list/download endpoint in A3-1b.

Opaque OpenCode sessions and MCP capabilities stay backend-only.
Provider/OpenCode unavailability returns explicit read-only state and never a
canned Agent response. Model mutation is limited to typed current-Model tools;
Project conversations cannot mutate Model code, schemas, execution description,
or dependencies.

The Stage 2 process boundary is macOS/local-user `sandbox-exec` with a
Model-owned writable root, scrubbed environment, denied network by default,
finite time/output/process limits, and read-only access only to the fixed Python
application/framework and exact configured virtual-environment roots needed by
the backend-selected interpreter. Arbitrary home, repository, credential, and
sibling paths remain denied. It is not hostile-code containment.
`technicalStatus: "executable"` means the thin technical checks passed; it is
not a scientific-validity, calibration, trust, or recommendation field.

The run boundary accepts only a copied execution-description v2 with
`inputs.schemaProfile: "riff-json-schema-2020-12-v1"`, required smoke input,
declared outputs/cancellation, and the matching batch or visual protocol. It
revalidates the frozen plan against the copied schema. The official generic
scaffold now emits v2 with batch capability only. A3-1b publicly starts and
reads runs, dispatches a real `riff-batch-v1` process per sample, enforces the
currently supported hard limits, and atomically publishes successful outputs.

`RunLimitsV1` is server-owned. A3-1b hard-enforces sample count, concurrency,
wall time, termination grace, stdout bytes, stderr bytes, output file count,
output bytes, and scratch/Project integrity. CPU time, resident memory, and
model-spawned process-count limits are not accepted as supported limits.
`startupTimeMs` and event count/byte fields remain frozen reserved fields:
visual starts currently fail with `capability_not_available`, and batch
`domainEvents` fail with `domain_events_not_supported`.

Admission and request failures use stable codes including `unknown_field`,
`invalid_request`, `resource_not_found`, `state_conflict`,
`idempotency_conflict`, `legacy_contract_read_only`,
`execution_protocol_upgrade_required`, `capability_not_declared`,
`capability_not_available`, `domain_events_not_supported`,
`project_snapshot_corrupt`, `invalid_sample_plan`, and
`sample_limit_exceeded`. Batch terminal codes include
`batch_run_succeeded`, `batch_process_failed`, `run_wall_timeout`,
`run_stdout_limit`, `run_stderr_limit`, `run_output_file_limit`,
`run_output_byte_limit`, `run_output_invalid`,
`process_cleanup_unverified`, `dispatcher_shutdown`,
`dispatcher_heartbeat_failed`, and `batch_publication_failed`; an unexpected
supervisor failure records `batch_supervisor_failed`.

The dispatcher shuts down in-process work through an abort signal, verified
process-group termination, owned-scratch cleanup, and a durable failure.
Heartbeat, capability, supervisor, output-consumption, and publication
exceptions use the same best-effort unwind. A run terminalizes only after every
registered process has durable exit and cleanup evidence; otherwise it stays
live and recovery-required rather than publishing a false failure/success.
Startup refuses unresolved prior live attempts with
`dispatcher_recovery_required`; cross-restart attempt/scratch recovery is not
yet implemented. The user-cancel API/race, completion-card exactly-once
delivery, visual supervision, output downloads, events, wind migration, and
final shell routes remain later #14/#15 work. The legacy Gate API below still
coexists until separately reviewed retirement.

---

# Legacy durable project and backend API target

## Status

This Gate 0 contract describes the former Gate 2 target. It is retained as
implementation history and may still describe coexisting legacy queue/wind
code. It is not the current Milestone A2 API authority.

The backend is the only browser-facing authority. It owns durable project
identity, project snapshots, business artifacts, issue/attestation records,
experiment revisions, command idempotency, OpenCode adaptation, and Mesa
orchestration. The browser never supplies workspace paths, Mesa project IDs, or
OpenCode session IDs.

## Identity and mutation envelope

`projectId` is durable. `sessionId` is a temporary browser/OpenCode control
connection. Reopening a project or restarting the backend preserves project and
revision identities.

Every browser mutation includes:

```ts
type ProjectCommand<T> = {
  commandId: string;
  projectId: string;
  sessionId: string;
  baseSnapshotRevision: number;
  payload: T;
};
```

`commandId` is idempotent. A stale `baseSnapshotRevision` returns `409`; schema
failure returns `422`; unknown or cross-project identities return `404`; unsafe
payload size returns `413`/`429`. Accepted commands publish later authoritative
snapshot/patch events. A `202` acknowledgement is not itself state.

## Browser-safe project projection

The canonical projection contains bounded data and references:

```ts
type ProjectState = {
  projectId: string;
  snapshotRevision: number;
  phase: string;
  actors: DeclaredLocalActor[];
  attachments: Attachment[];
  conversation: Message[];
  current: {
    decisionBriefRevisionId?: string;
    alignmentMapRevisionId?: string;
    modelRevisionId?: string;
    experimentRevisionId?: string;
    runId?: string;
  };
  model?: ModelProjection;
  experiment?: ExperimentProjection;
  workflow: WorkflowProjection;
  issues: IssueSummary[];
  attestations: AttestationSummary[];
  run?: RunSummary;
  artifacts: ArtifactReference[];
};
```

Full domain events, raw model files, complete histories, absolute paths, provider
credentials, and stack traces are excluded. SSE sends a snapshot first and then
ordered RFC-6902-style patches. Gaps trigger snapshot reload.

## Immutable business and experiment revisions

The API distinguishes snapshot, brief, alignment, model, experiment, and run
identities exactly as defined in [`architecture.md`](architecture.md). Creating
an experiment revision normalizes all values, stores the selected defaults
preset, default/current diff, horizon, warm-up, seed, and bound upstream
revisions. Reset is an explicit mutation that copies active defaults into a new
draft; it never erases history.

The run route accepts only an `experimentRevisionId`. It does not accept an
execution label, arbitrary parameters, steps, or seed overrides. The backend
records a complete identity and policy snapshot, then derives
`workflow_policy_met | workflow_policy_unmet`; callers cannot choose or
promote that label.

## Issues and attestations

An issue binds to exact subjects and revisions:

```ts
type Issue = {
  issueId: string;
  subjectRevisionIds: string[];
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  blocking: boolean;
  status: "open" | "resolved" | "closed";
  reporterActorId: string;
  assigneeActorId?: string;
  createdAt: string;
  resolution?: { actorId: string; reason: string; at: string };
};
```

Comments and state changes are append-only events with an atomic current
snapshot. Closing requires a reason. `openBlockingIssueCount === 0` means only
that no recorded blocking objection remains.

```ts
type Attestation = {
  attestationId: string;
  actorId: string;
  actorType: "human" | "agent";
  declaredRole: string;
  subjectRevisionIds: string[];
  scope: string;
  decision: "endorse" | "object" | "abstain";
  rationale: string;
  createdAt: string;
  supersedesAttestationId?: string;
};
```

Records are immutable; later decisions supersede rather than edit. One human
actor contributes at most one effective endorsement to a given revision.
Declared local identity is explicitly unauthenticated in Phase 1. Agent review
is stored and displayed separately and never counts toward human policy.
`object` should reference an issue.

## Derived workflow policy

Alignment-map and experiment revisions are independent review subjects. The
default policy for each is:

```text
human project_owner endorsements >= 1
AND open blocking issues == 0
```

The projection exposes counts, named subjects, and `policySatisfied`. It never
calls the artifact trusted, correct, valid, or confirmed. Safe
policy-unmet private drafts are admitted while the policy is false. A later
attestation does not mutate or relabel an existing run; a policy-qualified
experiment requires a new run for correspondingly labelled results.

## Target routes

All mutation bodies use `ProjectCommand` except binary upload transfer.

| Method and route | Purpose |
| --- | --- |
| `GET /api/projects/{projectId}/snapshot` | Current browser-safe state. |
| `GET /api/projects/{projectId}/events` | Snapshot plus ordered patches. |
| `POST /api/projects/{projectId}/sessions` | Attach a temporary local session to a durable project. |
| `POST /api/projects/{projectId}/uploads` | Validate and persist CSV/JSON/TXT input. |
| `POST /api/projects/{projectId}/chat` | Submit bounded context to configured OpenCode. |
| `POST /api/projects/{projectId}/brief/revisions` | Create an immutable decision-brief revision. |
| `POST /api/projects/{projectId}/alignment/revisions` | Create an immutable requirement/mapping revision. |
| `POST /api/projects/{projectId}/issues` | Open a scoped issue. |
| `POST /api/projects/{projectId}/issues/{issueId}/comments` | Append discussion. |
| `PATCH /api/projects/{projectId}/issues/{issueId}` | Resolve/close/reopen with reason. |
| `POST /api/projects/{projectId}/attestations` | Add a scoped immutable review decision. |
| `POST /api/projects/{projectId}/experiments/revisions` | Save normalized parameter values or reset result. |
| `POST /api/projects/{projectId}/runs` | Execute one immutable experiment revision. |
| `POST /api/projects/{projectId}/runs/{runId}/cancel` | Cancel only a run owned by this project. |
| `GET /api/projects/{projectId}/runs/{runId}/events` | Page browser-safe domain events. |
| `GET /api/projects/{projectId}/artifacts/{artifactId}` | Fetch a declared project-owned artifact. |

## Persistence and safety

The layout and single-writer rules are defined in
[`architecture.md`](architecture.md). Backend snapshots use temporary files and
atomic rename. Revisions and attestations are immutable. Issue history is
append-only. Startup validates manifests, rejects traversal/symlinks and
quarantines incomplete temporary writes without inventing success.

Uploads remain bounded to declared CSV/JSON/TXT size and media types. Provider
keys, raw tool input, absolute paths, control characters, and unbounded logs are
redacted from public errors and state. The service fails closed when its live
provider/model configuration is unavailable.

## Gate 2 acceptance

- Restart recovers project identity, current revision pointers, issues,
  attestations, experiment revisions, and run references.
- Stale writes and idempotent retries behave deterministically.
- Parameter edit and reset create immutable, correctly diffed experiment
  revisions.
- Policy counts are revision-scoped; Agent records never satisfy the human
  count; zero issues is not rendered as trust.
- Unendorsed, policy-unmet private drafts run and retain that label.
- Every run/event/artifact reference resolves to the same project, model,
  experiment, brief, and alignment identities.
