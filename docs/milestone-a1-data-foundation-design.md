# Milestone A1 data-foundation design

Status: Stage 1 implementation design. This document is subordinate to the
[Milestone A product contract](milestone-a-product-contract.md). It defines the
local domain and persistence boundary only; it does not connect that boundary
to HTTP, OpenCode, Mesa execution, or the final UI.

Stage 1's historical schema contract ended at v2. Stage 2 / #13 now extends the
same ProductStoreV2 authority through the ordered schema v3 migration for Agent
sessions, turns, summaries, skill/action evidence, document adoption, and Model
technical checks. The current v3 behavior is specified by
[`milestone-a2-agent-workspace-design.md`](milestone-a2-agent-workspace-design.md);
it does not create a second repository or invalidate the Stage 1 atomic
storage/recovery guarantees. Legacy Gate/queue state still coexists until an
explicit later removal, and existing untracked workspaces remain protected.

## Stage boundary

Stage 1 provides a generic, local, single-user system of record for Models and
Projects. It includes records for conversations, messages, temporary documents,
attachments, experiment configurations, runs, output indexes, trash, and owned
files. A store implementation may expose these capabilities to later stages,
but this stage does not add product routes or screens.

The following remain outside this stage:

- OpenCode discovery, sessions, prompting, tools, or simulation-skills routing;
- model environment creation, executability checks, or arbitrary code execution;
- Mesa runtime migration, run dispatch, cancellation, or result production;
- browser state, the two-pane shell, and wind-example installation;
- migration or deletion of existing file-based workspaces.

The old immutable ProjectEvent/revision, attestation, workflow-policy,
activation, replay, and retirement-audit structures are not imported into the
new schema. They remain untouched until their explicit removal stage. Existing
untracked files and workspace directories are not inputs to initialization.

## Authority and identity

SQLite is authoritative for resource identity, lifecycle, ownership, and file
metadata. Object bytes are authoritative only when they match the owning
`object_files` row by relative path, byte length, and SHA-256 digest. UI state,
conversation prose, external Agent sessions, rendered documents, and runtime
observations cannot silently change resource state.

Identifiers are opaque application-minted strings. The database checks bounded
length; the domain/store layer owns any stronger prefix convention. Timestamps
are UTC ISO-8601 strings minted by the application. Names are non-empty and
bounded. JSON values are stored as text and checked with SQLite JSON functions.

## Schema and relationships

Schema version 2 contains the following records. Schema changes are expressed
as an ordered migration list beginning at version 1; initialization applies
each missing version in one `BEGIN IMMEDIATE` transaction and updates both
`product_schema.version` and `PRAGMA user_version` after each step. A gap,
future version, mismatch between the two version markers, or failed migration
rolls back and fails closed rather than treating the current DDL as eternally
version 1. Before v2 installs its triggers, it scans every existing v1 row for
the stricter snapshot-owner, adoption-source/purpose/scope, and lifecycle
contracts. Any violation aborts the migration; the schema and data remain
unchanged at v1 for explicit repair rather than being silently normalized.
After each migration SQL body and before either version marker advances, the
initializer also requires `PRAGMA foreign_key_check` to return no rows and
`PRAGMA integrity_check` to return exactly `ok`. Thus an orphan written by an
older connection with foreign keys disabled cannot be blessed by a later
upgrade, and a failed reopen remains repeatably fail-closed.

| Table | Purpose and important integrity rule |
| --- | --- |
| `product_schema` | Singleton installed schema version. Initialization and migrations run in `BEGIN IMMEDIATE`. |
| `models` | Generic model identity, lifecycle, technical status, run mode, and execution description. No wind identifiers or revision browser. |
| `projects` | One fixed copied model snapshot. `source_model_id` is immutable lineage; `model_snapshot_digest` binds the project-owned copy. |
| `conversations` | Exactly one Model or Project owner. Provider/model selection is Riff-owned; an external session reference is optional and server-only. |
| `messages` | Complete ordered conversation messages. `(conversation_id, ordinal)` is unique. |
| `temporary_documents` | Persistent document content and `draft/adopted/rejected/superseded` workflow state. Its source message, when present, must share the conversation. |
| `attachments` | The initial conversation-owned attachment record. Its object file must be a `conversation_attachment` owned by the same conversation. |
| `message_attachments` | Links only messages and attachments from the same conversation. |
| `experiment_configurations` | Named, directly editable Project configurations with no revision history. |
| `runs` | A Project run record with the exact frozen configuration JSON used. Its experiment must belong to the same Project. Stage 1 stores states but does not execute them. |
| `object_files` | Ownership, kind, root-relative path, media type, byte size, digest, and adopted-attachment source/purpose. Exactly one owner is required. A project snapshot can only have a Project owner. |
| `output_indexes` | A named run output whose file must be a `run_file` owned by that run. |
| `trash_entries` | Recoverable trash history for exactly one resource, with at most one unrestored entry per resource. |
| `committed_mutations` | Database-side commit receipt used by mixed database/filesystem crash recovery. |

All cross-record relationships use foreign keys with restrictive update/delete
semantics. Ownership bindings are immutable after insertion. Polymorphic
ownership is represented by explicit nullable foreign-key columns plus an XOR
check, not by an unchecked `owner_type/owner_id` string pair. Triggers enforce
same-conversation and same-run relationships that ordinary foreign keys cannot
express.

Lifecycle is `active`, `archived`, or `trashed`. Timestamp and prior-state
checks make impossible combinations unrepresentable. In particular, a trashed
resource whose `pre_trash_state` is `active` has no `archived_at`, while a
trashed resource whose `pre_trash_state` is `archived` must retain its
`archived_at`. Restore uses that exact recorded state. Runs keep their execution
status separately and record it in `pre_trash_status` while trashed. Detailed
run `started_at`/`finished_at` consistency belongs to the Stage 3 execution
state machine; Stage 1 does not claim that runtime transition contract.

## Object directories

The object-store implementation owns one configured root and uses these logical
layouts:

```text
objects/
  models/<model-id>/
    code/
    environment/
    visuals/
    attachments/
  projects/<project-id>/
    model-snapshot/
    attachments/
    runs/<run-id>/
  conversations/<conversation-id>/attachments/
.staging/<transaction-id>/
.recovery/<transaction-id>.json
```

`object_files.relative_path` is relative to its owner's directory, never to the
process working directory. SQL rejects absolute paths, backslashes, empty path
segments, trailing separators, and `..` segments. The object-store must also
resolve beneath its configured root and reject every symlink or non-regular
ancestor. SQL checks are defense in depth, not a substitute for filesystem
validation.

Paths are unique within each owner. Object deletion and permanent-delete
preview enumerate exact `object_files` rows. No operation accepts an arbitrary
directory and no broad recursive deletion is derived from a user string.

## Mixed database/filesystem mutations

SQLite transactions do not make filesystem changes atomic. The later
`MutationCoordinator` must use a durable recovery manifest:

1. Validate the complete operation and its ownership before changing state.
2. Write new bytes, prior-byte backups, and an undo/forward manifest beneath
   `.staging/<transaction-id>`; fsync files and containing directories.
3. Start `BEGIN IMMEDIATE`, apply database changes, and insert the matching
   `committed_mutations` receipt without committing yet.
4. Promote exact staged files with safe atomic renames and fsync their parents.
5. Commit SQLite, then remove the staging and recovery material.

At restart, a manifest with a matching committed receipt is rolled forward and
verified against its target digests. A manifest without a receipt is rolled
back from its backups. Missing, changed, escaped, or symlinked paths fail closed
rather than being guessed or deleted. Fault injection must cover every boundary
around file promotion and SQLite commit.

The database uses `foreign_keys=ON`, WAL journaling, `synchronous=FULL`, a
bounded busy timeout, and explicit transactions. One product-store writer owns
the local workspace. WAL sidecar files are normal SQLite state and must not be
treated as disposable artifacts while the database is open.

## Fixed-copy project primitive

Stage 1 defines `createProjectFromModel` as a store-level primitive even though
the New project API, permissions, and execution integration arrive in Stage 3.
Its input contains only caller intent: `projectId`, `projectName`,
`sourceModelId`, and `createdAt`. It must not accept caller-supplied snapshot
rows, snapshot digests, copied execution descriptions, or source paths. The
store resolves those authoritative values from the source Model within the
same operation. The primitive must:

1. require an existing technically executable source Model;
2. capture its current execution description and the exact eligible code,
   environment, visual, and adopted-attachment files;
3. copy bytes into `objects/projects/<project-id>/model-snapshot/`;
4. insert project-owned `project_model_snapshot` rows and a deterministic
   aggregate snapshot digest; and
5. commit all copied bytes and rows through one recoverable mixed mutation.

The project never stores a live path into the source Model. Later source file or
execution-description edits cannot change the project copy. Trashing a source
Model does not trash Projects; permanent deletion preview reports Project
lineage references and may block physical purge while those references remain.

## Resource operations

The public Stage 1 repository contract supports list, create, rename, archive,
restore, trash, and permanent-delete preview. Trash is reversible state, not
physical deletion. Preview returns the exact database rows, exact file metadata,
total bytes, blocking references, a deterministic `previewToken` over that
canonically ordered payload, and a `stateToken` over the target and dependency
state. A later purge must require both tokens and reject a stale or altered
preview. Stage 1 does not authorize a permanent purge operation.

Attachments start as conversation-owned bytes. Adoption creates a distinct
Model- or Project-owned object file with a non-null `source_attachment_id` and
a non-empty adoption purpose. The adopted owner must equal the source
conversation's Model or Project owner. Conversation trash does not affect the
copy. A later physical purge of the source attachment or conversation is
blocked while an adopted copy retains that provenance reference; it is not
silently cascaded or detached. Run output indexes likewise point to separately
owned run files.

The single `ManagedResourceKind` vocabulary is `model`, `project`,
`conversation`, `temporary_document`, `experiment`, and `run`. Preview record
identities use table plus a key map so join rows and other composite keys are
representable; they are not reduced to a fictional single `id`. Previews also
return explicit exclusions in addition to blocking references.

Ownership closure is exact: a Temporary Document includes its row and no source
message or conversation row; those are references outside the closure. An
Experiment includes its configuration row; Runs that freeze or reference it
are blocking references rather than descendants, and their rows/files are
excluded. The Model, Project, Conversation, and Run closures are defined in the
obsolete-state removal plan and follow the same database-owner rule.

## Verification gates

Focused schema/domain tests must prove:

- a fresh file database initializes with the required PRAGMAs and reopens with
  all supported records intact;
- ordered v1-to-v2 migration succeeds, version-marker drift fails closed, and a
  failed migration rolls back all schema/version changes;
- a file-backed v1 database containing an orphan inserted with foreign keys
  disabled fails every reopen without gaining v2 columns/triggers or rewriting
  the orphan;
- foreign keys, owner XOR checks, lifecycle checks, JSON checks, path checks,
  per-owner uniqueness, and ownership triggers reject invalid data;
- a Run cannot bind an experiment from another Project;
- a message/document/attachment/output cannot cross its owning scope;
- project snapshot metadata remains unchanged after source-Model file changes;
- Model-owned project snapshots, owner-mismatched adopted attachments, adopted
  rows without source or purpose, and inconsistent trashed pre-state timestamps
  are rejected by direct SQL counterexamples;
- later object-store/store tests cover symlink escapes, fault recovery,
  trash/restore, exact permanent-delete preview, and preservation of unrelated
  untracked files.

The full backend suite remains mandatory before Stage 1 review and merge.

## ProductStoreV2 implementation

`backend/src/product-store-v2.ts` is the Stage 1 repository implementation; its
name deliberately avoids the legacy in-memory `project-store.ts`. `open(root)`
publishes a fresh root only after building a complete sibling staging root,
closing SQLite, atomically renaming the directory, and fsyncing the parent.
Existing roots reopen the schema, acquire the single writer lock, and complete
MutationCoordinator recovery before serving reads or writes.
The production `open(root)` accepts no injection options. Fault injection is
available only through the explicitly internal `openForTesting` entrypoint.
The former `ProductRepository` interface was removed because its stale
`createModel(ModelRecord)` signature described a second, incompatible public
contract; the typed ProductStoreV2 methods are the sole Stage 1 repository
contract.

All mixed file/database methods pass declarative statements with mandatory
`expectedChanges` through MutationCoordinator. Pure database methods use the
same expected-change contract inside `BEGIN IMMEDIATE` while the ProductStore
owns that writer lock. Model creation accepts intent and bytes and calculates
all file metadata. Project creation accepts only project intent, reads each
eligible source file through one checked descriptor, captures the stored
execution description, and computes both per-file and canonical aggregate
snapshot digests before committing the copied rows and bytes together.
Model and Project creation use stable transaction identities and complete
intent matching, so a response lost after SQLite commit can be retried without
duplicating rows or bytes. A conflicting intent fails closed. Project snapshot
file IDs are deterministic, and transaction-local CAS statements recheck the
source Model state, execution description, update timestamp, complete eligible
file count, and every captured file identity/metadata field before inserting
the Project.

Typed Stage 1 methods cover conversations, messages, temporary documents,
attachments and adoption, experiments, runs, and output indexes. Adoption is a
separate operation after a Model/Project-owned conversation attachment exists;
this preserves the schema rule that provenance ownership is already provable.
No purge method exists. Deterministic previews validate every selected file
against its owner, path, size, and digest and return exact composite record
keys, blockers, and exclusions for all six managed resource kinds.
Each child-resource mutation guards its active parent and same-owner binding in
the same SQLite transaction. Preview records include every selected
`object_files` row in both record and state-token material, and byte totals are
checked as safe integers before filesystem verification.
