# Durable project and backend API target

## Status

This Gate 0 contract describes the Gate 2 target. The current backend remains a
queue-bound, in-memory Phase 0 implementation; these routes and records are not
yet available.

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
