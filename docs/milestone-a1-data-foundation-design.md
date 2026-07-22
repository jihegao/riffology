# Milestone A1 data-foundation design

Status: Stage 1 implementation design. This document is subordinate to the
[Milestone A product contract](milestone-a-product-contract.md). It defines the
local domain and persistence boundary only; it does not connect that boundary
to HTTP, OpenCode, Mesa execution, or the final UI.

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

Schema version 1 contains the following records:

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
| `object_files` | Ownership, kind, root-relative path, media type, byte size, digest, and optional adopted-attachment source. Exactly one owner is required. |
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
checks make impossible combinations unrepresentable. Restore uses the recorded
pre-trash state. Runs keep their execution status separately and record it in
`pre_trash_status` while trashed.

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
The primitive must:

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
Model- or Project-owned object file with `source_attachment_id`; conversation
deletion or trash cannot erase the adopted copy. Run output indexes likewise
point to separately owned run files.

## Verification gates

Focused schema/domain tests must prove:

- a fresh file database initializes with the required PRAGMAs and reopens with
  all supported records intact;
- foreign keys, owner XOR checks, lifecycle checks, JSON checks, path checks,
  per-owner uniqueness, and ownership triggers reject invalid data;
- a Run cannot bind an experiment from another Project;
- a message/document/attachment/output cannot cross its owning scope;
- project snapshot metadata remains unchanged after source-Model file changes;
- later object-store/store tests cover symlink escapes, fault recovery,
  trash/restore, exact permanent-delete preview, and preservation of unrelated
  untracked files.

The full backend suite remains mandatory before Stage 1 review and merge.
