# Milestone A2 Agent and model-workspace design

Status: Stage 2 implemented and release-accepted, including the real-provider
same-session two-turn browser closure recorded in
[`test-plan.md`](test-plan.md). This document is subordinate to the
[Milestone A product contract](milestone-a-product-contract.md) and builds on
the [Stage 1 data foundation](milestone-a1-data-foundation-design.md). It owns
persistent Agent conversations and the generic Model workspace. Project
execution and the final product shell remain later stages.

## Outcome and stage boundary

Stage 2 makes **New model** functional: a user supplies a name and the
provider/model for its first conversation, receives a generic Python/Mesa
workspace, and can use a real OpenCode-backed conversation to inspect or change
that Model within explicit permissions. Riff persists the complete durable
conversation, files, temporary documents, skill/action evidence, and technical
check results across restart.

This stage does not implement:

- New project exposure, experiment/run execution, output indexes, or the wind
  model migration owned by Stage 3 / #14;
- the final Models/Projects home, polished two-pane shell, dynamic right-pane
  browser acceptance, or final wind demo owned by Stage 4 / #15;
- direct right-pane content editing, user-visible versions, publishing,
  multi-user authorization, Linux support, cloud sync, or hostile-code
  containment;
- scientific validation, calibration, decision recommendations, or a claim
  that a technically executable Model is correct or trustworthy.

Stage 2 may expose narrow HTTP endpoints and an intentionally plain acceptance
surface needed to prove its API and browser contracts. Those are test seams,
not an early implementation of the Stage 4 product shell.

## Authority and trust boundaries

`ProductStoreV2` remains the only system of record. SQLite is authoritative for
identity, ownership, lifecycle, ordered messages, provider binding, summaries,
documents, attachment metadata, skill/action evidence, and technical-check
status. Object bytes are authoritative only when they match their
`object_files` owner, path, size, and digest. Every new Stage 2 repository
method extends ProductStoreV2; no Agent service, route, or workspace helper may
write the database or object tree directly.

The following are projections or external capabilities, never authority:

- OpenCode sessions, streams, tool calls, and provider discovery responses;
- Agent prose, browser/DOM state, rendered documents, and skill-generated text;
- a Mesa process, model-provided page, technical-check log, or temporary file;
- caller-supplied IDs, paths, ownership, file metadata, action results, or
  executability claims.

OpenCode session identifiers and credentials remain backend-only. Browser DTOs
return `sessionState`, never an opaque session reference. The browser never
receives provider credentials, environment secrets, storage paths, or process
handles.

Milestone A is local, single-user, macOS-only. Model code is treated as locally
user-authorized but fallible, not adversarial. Separate processes, a restricted
working directory, scrubbed credentials, no network by default, and finite
limits reduce accidental harm; they are not a container/VM sandbox claim.

## Components and dependency direction

```text
HTTP / acceptance surface
  -> AgentWorkspaceService
       -> ProductStoreV2 (all durable reads and writes)
       -> OpenCodeLoopbackClient (discovery, session, turn stream)
       -> SkillCatalog (catalog then selected instructions)
       -> ModelWorkspaceRunner (isolated process and technical checks)
            -> ObjectStore / MutationCoordinator through ProductStoreV2 only
```

`AgentWorkspaceService` coordinates a turn but owns no durable state.
`OpenCodeLoopbackClient` accepts loopback HTTP endpoints only and has bounded
connect/read/turn timeouts, response sizes, redirects, and concurrency. It must
not accept a browser-provided URL. `ModelWorkspaceRunner` receives an
application-resolved Model workspace capability rather than an arbitrary path.

## Schema v3 and repository contract

Stage 2 introduces ordered schema migration v2 to v3. It uses the Stage 1
transactional migration rules, version-marker agreement, integrity checks, and
repeatable fail-closed rollback. Existing v2 rows remain valid. Before v3 is
published, migration checks provider-lock consistency, message ordinals,
owner bindings, and JSON validity.

### Existing records retained and tightened

- `conversations` remains owned by exactly one Model or Project. Stage 2 writes
  `provider_locked_at` in the same transaction as the first accepted user
  message. `provider_id` and `provider_model_id` become immutable once locked.
  `external_session_ref`, if retained in this table, is encrypted or opaque and
  is never selected into a public DTO.
- `messages` is the complete Riff-owned ordered transcript. Streaming text is
  not durable authority until a terminal `complete` or `failed` message update
  commits. Retry uses a unique caller request key and cannot append a duplicate
  user turn.
- `temporary_documents`, `attachments`, `message_attachments`, and
  `object_files` retain the Stage 1 ownership and provenance constraints.
  Stage 2 adds transition methods rather than direct state updates.

### New records

| Table | Purpose and integrity contract |
| --- | --- |
| `conversation_summaries` | At most one current rolling summary per conversation, with covered message ordinal range, bounded content, digest, and creation time. Coverage can advance but never overlap recent context or move backward. |
| `agent_sessions` | Backend-only opaque OpenCode session binding, lifecycle (`creating`, `available`, `lost`, `rebuilding`, `closed`), provider/model copy, last successful turn, and timestamps. At most one nonterminal session per conversation. Session values never appear in public DTOs or logs. |
| `agent_turns` | Idempotent turn receipt keyed by `(conversation_id, request_key)`, input message, state, bounded failure code, reconstructed-context digest, and terminal assistant message when present. It permits safe response-loss retry and recovery of in-flight turns. |
| `skill_uses` | Auditable selected skill identifier/version, routing mode (`explicit` or `automatic`), catalog digest, instruction digest, originating turn, load state, and bounded rationale. It records selection and loading, not permission. |
| `action_records` | One proposed/attempted Agent action with owner, turn, action kind, normalized intent JSON, permission decision, mutation transaction ID, terminal result, affected record/file identities, and bounded error. It cannot claim committed unless the matching database/file mutation receipt exists. |
| `model_technical_checks` | Immutable check attempt for one Model: captured workspace digest, execution-description digest, check states/results, start/finish times, limits, and log attachment/file reference. A terminal aggregate updates `models.technical_status` by compare-and-set on the captured digest. |

Foreign keys and triggers enforce same-conversation and same-owner bindings.
Provider/session values, summaries, skill use, and action evidence cannot be
moved between conversations. Project-owned conversations may exist because
Stage 1 stores them, but the Stage 2 mutation matrix below keeps Project model
snapshots immutable.

### ProductStoreV2 APIs

Inputs contain caller intent, not authoritative metadata. IDs and timestamps
are minted or validated at the application boundary; digests, ordinals,
ownership, paths, provider lock state, and mutation results are resolved inside
the store transaction.

```ts
type ConversationOwner =
  | { kind: "model"; id: string }
  | { kind: "project"; id: string };

type CreateConversationIntent = {
  owner: ConversationOwner;
  name: string;
  providerId: string;
  providerModelId: string;
};

type StartAgentTurnIntent = {
  conversationId: string;
  requestKey: string;
  text: string;
  attachmentIds: string[];
};

type CommitAgentTurnIntent = {
  conversationId: string;
  requestKey: string;
  expectedTurnState: "running";
  assistantContent: unknown;
  actions: NormalizedAgentActionResult[];
};
```

Required repository operations are:

- create/list/get/rename/archive/restore/trash conversations;
- atomically accept the first user message and lock provider/model;
- begin/resume/fail/complete an idempotent Agent turn;
- bind, mark lost, rebuild, and close a backend-only Agent session;
- read a bounded context snapshot and advance its rolling summary using
  compare-and-set coverage;
- create/link/adopt attachments through recoverable file/database mutations;
- create and transition temporary documents with exact allowed transitions;
- record skill routing/loading and action permission/result evidence;
- create a generic Model from a server-owned scaffold in one recoverable
  mutation, replace permitted Model-owned files, and publish technical-check
  results only against the captured workspace digest.

All mixed database/file methods use `MutationCoordinator`; database-only
methods use the Stage 1 expected-change transaction contract. Response-loss
retry with the same request key returns the same durable result. Reusing a key
with different intent fails closed.

### Public DTOs

Public reads use explicit allowlisted DTOs, not database rows:

```ts
type ConversationDto = {
  id: string;
  owner: ConversationOwner;
  name: string;
  provider: { providerId: string; modelId: string; locked: boolean };
  sessionState: "none" | "connecting" | "available" | "lost" | "read_only";
  lifecycleState: "active" | "archived" | "trashed";
  updatedAt: string;
};

type AgentTurnDto = {
  requestKey: string;
  state: "queued" | "running" | "complete" | "failed" | "read_only";
  userMessageId: string | null;
  assistantMessageId: string | null;
  skillUses: SkillUseDto[];
  actions: ActionRecordDto[];
  failure: { code: string; retryable: boolean } | null;
};
```

DTOs omit opaque sessions, credentials, local absolute paths, raw environment,
full subprocess logs, internal stack traces, mutation manifests, and database
receipts. Action DTOs expose the normalized user-visible intent, permission
decision, state, and affected logical resources; they do not expose a generic
filesystem or SQL capability.

## Conversation, provider, and session state machines

### Provider binding

Conversation creation validates a provider/model pair against backend discovery
and persists the selection unlocked. The first accepted user message and
`provider_locked_at` commit atomically. Empty drafts, failed HTTP validation,
or attachment upload alone do not lock it. Before the first message, a selected
pair may be changed after rediscovery; afterward every change attempt fails.

Discovery is advisory and short-lived. A pair disappearing after creation does
not rewrite history; it puts future Agent turns in explicit read-only state
until that exact pair becomes available. Riff does not silently substitute a
provider/model.

### Agent turn

```text
queued -> running -> complete
                  -> failed
queued/running -> read_only (no available exact provider/model/OpenCode)
```

Accepting a turn first commits the Riff-owned user message and idempotent turn
receipt. OpenCode output is then streamed as projection. A terminal assistant
message, skill-use rows, action rows, and terminal turn state commit in an
ordered, retryable operation. Interruption leaves an inspectable `running`
receipt; restart reconciles it to a bounded failure unless an identical backend
operation can safely resume. It never fabricates an assistant reply.

Discussion, questions, conditionals, and ambiguous language cannot authorize a
mutation. Only an explicit imperative normalized to an allowlisted action may
reach permission evaluation. Large or connected changes may produce a draft
temporary document, but a document is not automatically adopted or committed.

### External session

```text
none -> creating -> available -> lost -> rebuilding -> available
                    |            |          |
                    +----------> closed <---+
```

One conversation has at most one nonterminal session. A second named
conversation receives an independent binding even when provider/model matches.
If the external session is absent, rejected, or lost, the service marks it lost
and creates a new session using a bounded Riff context snapshot. It never trusts
OpenCode to restore the transcript.

The reconstruction payload contains, in order:

1. current authoritative owner summary and workspace digest;
2. the rolling summary of older messages;
3. recent complete messages within configured token/byte/message limits;
4. only explicitly relevant document/attachment excerpts, each labeled with
   provenance and bounded independently;
5. the capability catalog and full instructions only for selected skills.

The context assembler records limits, included logical IDs, and a digest in the
turn receipt. It excludes opaque session data, credentials, unrelated objects,
and untrusted attachment instructions from the system-authority channel.

### Read-only behavior

OpenCode unavailable, discovery failure, exact provider/model unavailable, or
session recreation failure yields `read_only` with a structured reason. Durable
objects and history remain readable. Conversation rename/lifecycle management
and attachment download remain ordinary resource operations; Agent messages,
Agent mutations, and simulated replies do not proceed. Stage 3 direct controls
for saved runs are not implemented or blocked by this state.

## Skill catalog and action evidence

The backend preloads a bounded catalog containing stable skill ID, version,
description, supported action families, and instruction digest. It does not
inject every instruction file into every turn. Explicit `$skill-name` selection
is resolved first; otherwise routing may select from catalog metadata. Only the
selected skill's complete instructions and required references are loaded.

Each selection produces a `skill_uses` row visible with the turn. Unknown,
changed, unreadable, or disallowed skills fail explicitly. Skill text is
context, not a capability: every proposed action still passes the same owner
and action matrix. A skill can neither widen filesystem access nor bypass
validation, technical checks, or user intent.

Every action has an immutable audit path:

```text
proposed -> denied
proposed -> authorized -> staging -> committed
                                  -> rolled_back
                                  -> failed
```

`committed` requires the expected ProductStoreV2 change and, for mixed
mutations, a matching committed mutation receipt. The action record contains
logical before/after digests and affected IDs, not arbitrary path lists.
Recovery reconciles a staged action from the coordinator receipt; it does not
infer success from file presence or Agent prose.

## Owner-scoped tool matrix

The service exposes typed tools, never a general shell, SQL endpoint, arbitrary
path reader, or arbitrary URL fetcher.

| Capability | Model conversation | Project conversation in Stage 2 |
| --- | --- | --- |
| Read owner summary/documents and conversation attachments | Allow current owner only | Allow current owner only |
| Create/update temporary documents | Allow current conversation | Allow current conversation |
| Adopt a conversation attachment | Allow into same Model with purpose | Allow into same Project with purpose |
| Read Model workspace files | Allow current Model allowlisted files | Deny source/snapshot model file access |
| Create/replace Model code, environment description, visuals | Allow current active Model through atomic mutation | Deny |
| Change execution description and request technical checks | Allow current active Model | Deny |
| Modify product source, schema, dependencies, another object, or ambient files | Deny | Deny |
| Create experiments/runs or execute a Model | Not implemented (#14) | Not implemented (#14) |

For Project conversations, “dependencies” includes the fixed copied Model's
environment and execution description. Project documents and adopted
attachments are mutable, but Project model snapshot bytes, schema, inputs,
outputs, runtime dependencies, and source Model are not. Permission is computed
from the durable conversation owner and tool kind, never an Agent-supplied
owner ID.

## Atomic direct mutation and documents

An explicit imperative can produce one normalized mutation plan containing one
or many file and database changes. Before staging, the service:

1. loads the active owner and current object/file digests;
2. verifies the action kind against the owner-scoped matrix;
3. validates every logical path, expected prior digest, content/size limit, and
   complete resulting execution description;
4. stages all bytes and declarative database statements under one transaction;
5. runs syntax/interface checks that are required for the mutation itself;
6. commits all changes or restores all prior bytes and rows.

A validation failure or stale digest changes nothing. Crash recovery follows
the Stage 1 manifest/receipt protocol and reconciles the action record. It is
transaction safety, not a user-visible version history.

Temporary documents persist as workflow artifacts and remain visibly distinct
from committed workspace state. Allowed transitions are:

```text
draft -> adopted
draft -> rejected
draft -> superseded
```

Terminal documents cannot return to draft. Adoption records the exact one or
many resulting action/mutation IDs. A committed direct mutation does not
retroactively mark unrelated documents adopted. Document prose or code never
becomes authoritative merely because it renders in the right pane.

## Generic Model creation and workspace

The New model service accepts only name and initial provider/model selection.
The backend mints IDs, validates discovery, and creates the Model, first
conversation, and a server-owned generic Mesa scaffold as one recoverable
operation. The scaffold is domain-neutral and contains no wind types, metrics,
tabs, bundle IDs, or assumed spatial representation.

The initial workspace includes only the minimum declared files needed to
express:

- Python/Mesa entry point and model code;
- declared inputs and output-file declarations;
- execution description with `visual`, `batch`, or `both` capability;
- dependency description/lock input and environment metadata;
- optional metrics, bounded domain events, Markdown, JSON, table, Mermaid, or
  model-provided page documents.

Documents follow weak conventions and generic media types. Missing optional
overview, specification, diagram, metric, or visualization files do not make a
Model invalid. Stage 2 does not introduce fixed product tabs.

Each Model receives an isolated environment keyed by its dependency-description
digest. Environment creation and checking run in a separate process with the
Model directory as working root, an allowlisted executable, scrubbed
environment, no inherited credentials, no network by default, finite wall/CPU
time, output/file/process limits, and cancellation. Approved tools cannot read
other objects, repository source, arbitrary home paths, SSH/config files, or
ambient credential stores. Environment artifacts are Model-owned and recorded
through ProductStoreV2.

### Thin technical checks

Checks capture the exact workspace and execution-description digests, then run:

1. path, syntax, and import checks;
2. execution-description/interface validation;
3. dependency/environment resolution using the isolated Model environment;
4. bounded smoke execution with declared inputs;
5. output declaration, resource-limit, cancellation, and cleanup checks;
6. visual entry-point health only when the Model declares `visual`.

The aggregate transition is `draft -> checking -> executable | failed`.
Publishing a terminal status uses compare-and-set against the captured digests;
workspace drift leaves the newer Model `draft` and the old check as historical
evidence. `executable` means only that the thin technical contract passed. The
DTO and browser acceptance surface must label it “Technically executable” and
must not imply validity, accuracy, calibration, safety, or recommendation.

## HTTP API boundary

Stage 2 routes are backend-owned and return the DTO allowlists above. The
implemented resource shape is:

```text
GET    /api/providers
POST   /api/models
GET    /api/models/:modelId/workspace
POST   /api/models/:modelId/technical-checks
GET    /api/models/:modelId/technical-checks/:checkId
GET    /api/objects/:ownerKind/:ownerId/conversations
POST   /api/objects/:ownerKind/:ownerId/conversations
GET    /api/conversations/:conversationId
GET    /api/conversations/:conversationId/messages
GET    /api/conversations/:conversationId/documents
POST   /api/conversations/:conversationId/turns
POST   /api/conversations/:conversationId/attachments
POST   /a2/mcp?cap=<server-minted capability>  (internal loopback only)
```

Mutation routes require idempotency/request keys, bounded bodies, strict media
types, server-derived ownership, and structured errors. Attachment names never
become storage paths. The current public turn surface completes synchronously;
its durable receipt and idempotent retry are the recovery contract. The API does
not expose a generic browser tool execution route. Adoption and temporary-
document transitions are available only through the turn-scoped typed Agent
tools in Stage 2, not public mutation endpoints.

## Failure and restart recovery

On startup ProductStoreV2 completes Stage 1 mixed-mutation recovery before the
Agent service accepts traffic. The service then:

- reconciles `staging` action records from matching receipts;
- marks orphaned `running` turns with a bounded retryable interruption failure;
- marks nonterminal external sessions `lost` without deleting messages;
- preserves provider locks, summaries, documents, attachments, skill evidence,
  committed Model files, and technical-check history;
- marks interrupted checks failed/cancelled and cleans only their exact
  application-owned process/staging artifacts;
- never scans or removes unrelated untracked files or legacy workspaces.

A lost session rebuild uses Riff-owned bounded context. A provider outage
changes availability/read-only projection, not conversation history. Technical
check, OpenCode, or subprocess logs are bounded and scrubbed before storage.
Database corruption, object digest drift, owner mismatch, manifest ambiguity,
or schema-version disagreement fails closed rather than serving partial state.

## Implementation slices and review gates

Implementation is divided into reviewable slices. Each slice includes focused
tests and documentation changes before the next relies on it.

1. **Schema v3 and ProductStoreV2 APIs:** migrations, provider lock, summary,
   session, turn, skill/action, and technical-check records; no OpenCode calls.
2. **Conversation service:** DTOs, lifecycle, idempotent messages/turns,
   attachments/documents, bounded context assembly, and read-only projection.
3. **OpenCode loopback bridge:** provider discovery, exact pair validation,
   per-conversation session reuse/loss/rebuild, stream normalization, and secret
   exclusion.
4. **Skill and scoped actions:** progressive skill loading, permission matrix,
   auditable action records, temporary-document transitions, and atomic direct
   Model mutations.
5. **Generic Model workspace:** domain-neutral scaffold, isolated environment,
   thin technical checks, CAS status publication, and functional New model API.
6. **Integration acceptance:** restart/lost-session/fault tests, API contracts,
   minimal browser proof, full suites, independent security/scope review, and
   documentation synchronization.

Stage 3 does not begin until Stage 2 design, implementation, tests, independent
review, draft PR, final review, merge, issue closure, and local `main` sync are
complete.

## Verification and acceptance matrix

| Contract | Required evidence |
| --- | --- |
| New model needs only name and provider/model | API and browser test create two domain-neutral Models from server-owned scaffold; no wind identifiers appear. |
| Provider binding locks on first message | Store/API tests cover pre-message change, atomic first-message lock, restart, and every post-lock rejection. |
| One real session per conversation | Loopback contract test proves multi-turn reuse; second conversation has a distinct session and context. |
| Lost-session reconstruction is bounded | Fault test loses the session, inspects included Riff IDs/digest and limits, excludes secrets/unrelated owners, and completes through a new session. |
| Explicit read-only mode | OpenCode down and exact provider/model missing return structured read-only state, preserve browsing, and produce no canned assistant message or mutation. |
| Complete durable conversation | Restart restores ordered terminal messages, turn receipts, summary coverage, documents, attachments, skill uses, actions, and provider lock. |
| Ambiguity does not mutate | Intent tests deny questions/conditionals; explicit allowlisted imperative commits all file/DB changes or none under validation and injected faults. |
| Temporary documents are not committed state | Lifecycle tests cover allowed/forbidden transitions, multi-action adoption evidence, and visibly distinct DTO/browser rendering. |
| Skills are inspectable but not authority | Explicit/automatic selection, digest/load audit, unknown skill failure, and attempted permission bypass tests. |
| Owner tools are scoped | Counterexamples deny cross-object reads/writes, arbitrary paths/URLs, product source, ambient credentials, and every Project attempt to alter model/schema/dependencies. |
| Attachments retain provenance | Upload/link/adopt/restart/trash tests prove exact owner, digest, purpose, and preservation of adopted copies. |
| Generic Model is technically checkable | Isolated-process tests cover syntax, interface, dependency, smoke, outputs, limits, cancellation, visual health, stale-digest CAS, and cleanup. |
| Trust boundary is honest | API/browser copy says “Technically executable”; tests forbid scientific-validity or recommendation fields/labels. |
| Recovery is deterministic | Fault injection spans Model creation and multi-file+DB mutation boundaries; restart rolls forward/back by receipt without touching protected untracked files. |

Focused store, service, bridge, runner, API, and web tests are required. The
full backend and web suites must pass; relevant Mesa scaffold/runner tests must
also pass. Final acceptance requires an independent API and real-browser review
with OpenCode available, unavailable, and session-loss cases. A healthy port or
mock-only conversation is not sufficient evidence.

## Documentation synchronization checklist

The Stage 2 PR must update documentation in the same change as behavior:

- this design and [`docs/README.md`](README.md) implementation status;
- [`backend-api.md`](backend-api.md) with actual Stage 2 routes, DTOs, error
  codes, idempotency, and read-only/session secrecy rules;
- [`opencode-bridge.md`](opencode-bridge.md) with the implemented loopback,
  discovery, session reuse/rebuild, context, skill, and action contracts;
- [`architecture.md`](architecture.md) with ProductStoreV2 authority and the
  Agent/workspace process boundaries;
- [`ui-workflow.md`](ui-workflow.md) with only the minimal Stage 2 acceptance
  surface, clearly reserving the final shell for #15;
- [`test-plan.md`](test-plan.md) with focused, full-suite, fault-injection, API,
  and browser evidence;
- environment/setup documentation with exact OpenCode and isolated-model
  prerequisites, limits, and macOS/local-user claim boundary;
- remove or label stale statements that imply OpenCode owns history, Projects
  may edit Model code, wind-specific tabs are generic product schema, or
  technically executable means scientifically trusted.

Completion notes must report exact tests and browser/API evidence, skipped
optional dependencies, remaining #14/#15 non-scope, and any claim that was not
verified. Documentation drift is a release blocker for Stage 2.
