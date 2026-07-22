# Milestone A1 obsolete-state removal plan

Status: Stage 1 audit plan only. This document does not authorize or perform
source, workspace, artifact, branch, or user-data deletion.

## Purpose and boundary

Milestone A replaces the former file-backed Gate 0-3 product shape with a
SQLite/object-store domain. Stage 1 establishes the new storage foundation and
records the old-state boundary; it does not remove the old implementation or
migrate, clean, or reinterpret local data. Tracked source retirement belongs to
the Stage 4 cutover, after the replacement product path passes its own tests and
browser acceptance.

Two classes of state must remain separate:

1. **Tracked obsolete implementation** is code, tests, routes, fixtures, and
   current-product documentation in Git that a later audited change may remove
   or rewrite.
2. **Ignored or untracked local state** is machine-local data outside Git's
   ownership. Its presence is never evidence that it is obsolete, reproducible,
   or safe to delete.

Git history and the reviewed wind model remain retained evidence. A name match,
directory name, age, test status, or replacement implementation is not deletion
authority for local data.

## Future Stage 4 tracked-code audit candidates

The following are candidate families, not a pre-approved deletion list. Stage 4
must rescan references and prove each exact file is replaced or no longer
reachable before changing it.

### Queue demo product path

- `mesa_service/src/mesa_service/models/queue_network.py`;
- the `queue-network-v1` branches in
  `mesa_service/src/mesa_service/contracts.py`, `service.py`, and `worker.py`;
- the `queue-network-v1` branches in `backend/src/mcp.ts`, `server.ts`, and
  `simulation-actions.ts`;
- queue-specific assertions and fixtures in `mesa_service/tests/test_api.py`,
  `backend/test/mcp-events.test.ts`, `backend/test/project-store.test.ts`,
  `backend/test/server.test.ts`, `web/src/legacy/LegacyApp.test.tsx`, and
  `scripts/e2e-live.mjs`.

Shared files in this list must be edited surgically. Their non-queue behavior is
not a deletion candidate.

### File-backed revision and policy product path

- `backend/src/durable-project-store.ts`, `durable-project-types.ts`,
  `gate2-runtime.ts`, `gate3-runtime.ts`, `gate3-types.ts`, and the corresponding
  Gate 2/Gate 3 route branches in `backend/src/server.ts`;
- revision-, issue-, attestation-, workflow-policy-, activation-, and
  retirement-audit tests in `backend/test/durable-project-store.test.ts`,
  `gate2-api.test.ts`, `gate2-real-integration.test.ts`, `gate3-api.test.ts`,
  `gate3-real-integration.test.ts`, and `gate3-recovery.test.ts`;
- Gate 2/Gate 3 framing code and tests under `mesa_service/src/mesa_service/`
  and `mesa_service/tests/`, including files prefixed `gate2_` or `gate3_`.

The audit must retain generic model execution and the reviewed ordinary wind
model where Stage 3 depends on them. A file containing an obsolete term is not
necessarily wholly obsolete.

### Evidence Studio and fixed wind-product UI

- `web/src/EvidenceStudioApp.tsx`, `EvidenceStudioApp.test.tsx`,
  `TraceabilityView.test.tsx`, `business-records.ts`, `business-records.test.ts`,
  `evidence.ts`, `evidence.test.ts`, and Evidence-Studio-specific branches in
  `web/src/api.ts`, `state.ts`, `types.ts`, and their tests;
- `web/e2e/evidence-studio.spec.ts` and Evidence-Studio-specific CSS;
- `riff://evidence-studio/*` projections and routes in backend and Mesa files.

Stage 4 may retire this fixed product surface only after the generic two-pane
replacement is browser-verified. Reusable generic renderers, APIs, and wind
model assets must be separated from the fixed UI before removal.

### Documentation disposition

Current entrypoints such as `README.md`, `docs/README.md`,
`docs/backend-api.md`, `docs/test-plan.md`, and `docs/ui-workflow.md` may require
cutover edits. Gate design documents are historical evidence and should be
labelled historical or archived rather than silently rewritten as current
truth. `docs/milestone-a-product-contract.md` remains authoritative and is not
an obsolete-state candidate.

## Stage 1 protected state: deletion forbidden

Stage 1 code, tests, scripts, and manual cleanup must not delete, move, import,
adopt, rename, rewrite, hash-normalize, or change permissions on any existing
local state. The current checkout audit on 2026-07-22 found these protected
families:

- `.riff-workspaces/**` (including `workspace.json`, project/run trees,
  quarantine entries, and `.backend-writer.lock`);
- `.riff-workspace/**`;
- `mesa_service/.riff-workspace/**`, including
  `.workspace-lifecycle.lock` and `.workspace-mutation.lock`;
- `outputs/**` (currently including wind baseline artifacts);
- `test-results/**` and `web/test-results/**`;
- `.env`, local virtual environments, dependency directories, caches, build
  outputs, and Python bytecode;
- untracked `.DS_Store` files at the repository root and under `backend/`,
  `mesa_service/`, and `web/`;
- any other ignored or untracked path discovered by the final pre-change scan.

Stage 1 tests must create a unique temporary storage root with `mkdtemp`, close
all handles, and clean only that resolved temporary root. They must not point a
new store, migration, fixture, or cleanup routine at the repository root or any
existing `.riff-workspace*` path. Commands such as `git clean -fdx` and broad
recursive deletion from the repository or object-store root are prohibited.

The Stage 4 source cutover does not imply permission to delete these local
paths. If local cleanup is later desired, it requires a separate inventory,
identity-based preview, explicit user confirmation, and post-action evidence.

## Permanent-delete preview ownership closure

Stage 1 exposes a preview only; it does not permanently delete data. A preview
is read-only, deterministic for one committed state, and scoped by the target's
database identity and ownership edges. It returns the target type and ID, a
state revision or equivalent concurrency token, owned row identities, and for
each owned file its normalized relative path, type, size, and digest, plus total
row/file counts and bytes. Blocked references and exclusions are explicit.

The ownership closure is:

- **Model:** the model row; model-owned conversations, messages, temporary
  documents, and conversation attachments; and the model object directory for
  code, environment descriptions, adopted attachments, and visual assets.
  Project-owned model snapshots are always excluded.
- **Project:** the project row; project-owned conversations, messages,
  temporary documents, conversation attachments, adopted attachments,
  experiment configurations, runs, and output indexes; and the project's fixed
  model snapshot, adopted files, and run files.
- **Conversation:** the conversation row, its messages, temporary document
  cards, action records when present, and attachments still owned by that
  conversation. Copies adopted by a model or project are excluded.
- **Temporary Document:** the document row only. Its source message and owning
  conversation are references, not descendants, and are explicitly excluded.
- **Experiment:** the experiment-configuration row only. Runs that freeze or
  reference the configuration are blocking references; their rows, indexes,
  and files are explicitly excluded.
- **Run:** the run row, its output and bounded-event indexes, and files in that
  run's exact object directory. The experiment configuration and parent project
  are excluded.

Archive and trash are lifecycle states, not ownership edges. Trashing or
previewing a source model cannot reach project copies; deleting a conversation
cannot reach adopted copies. Shared references are reported as exclusions or
blockers rather than followed. Trash remains reversible and is not blocked by
an adopted copy. A future physical purge of a source attachment or its
conversation is blocked while an adopted Model/Project copy retains the
non-null `source_attachment_id`; provenance is never silently severed.

Every previewed path must be recorded in SQLite, have the same owner as the row
being traversed, and resolve beneath the exact directory
`<store>/objects/<type>/<id>/`. Absolute paths, `..`, NUL, symlinks, owner/path
mismatches, missing files, unexpected types, size drift, and digest drift block
the preview. The implementation must never broaden a failed exact path into a
recursive parent-directory operation. Unindexed files, staging directories,
quarantine, database files, store locks, the store root, and sibling object
directories are outside the closure.

Any later permanent-delete command must require the exact preview token and
must fail stale if ownership, lifecycle state, path, size, digest, or referenced
rows changed after preview. That later command requires a separate delivery
stage and is not authorized by this plan.

## Verification scans and gates

Run these read-only scans before and after each future removal patch:

```bash
git status --short --ignored
git ls-files | sort
rg -n "queue-network-v1|evidence-studio|attestation|workflow_policy|replay|retirement|gate2|gate3" \
  backend mesa_service web scripts docs README.md
find . -maxdepth 4 \
  \( -name '.riff-workspace' -o -name '.riff-workspaces' -o \
     -name 'outputs' -o -name 'test-results' \) -print
```

For a Stage 4 candidate patch, also require:

1. a before/after manifest of tracked files changed or removed;
2. repository-wide import, route, schema ID, fixture, startup-script, and docs
   reference scans with every remaining hit classified;
3. focused replacement-path tests followed by the full backend, Mesa, web, and
   browser acceptance suites;
4. `git status --short --ignored` comparison proving protected ignored and
   untracked paths are unchanged;
5. a deletion preview for any proposed local artifact cleanup, with identity
   derived from manifests/database records rather than directory names;
6. independent review of scope, ownership, recovery, and path safety.

If a scan finds an ambiguous reference, unindexed file, dirty path, active lock,
cross-owner link, or changed digest, stop. Preserve the item and resolve the
ambiguity in a separate reviewed change.
