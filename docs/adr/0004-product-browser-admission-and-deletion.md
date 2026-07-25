# ADR 0004: Product browser admission and permanent deletion

- Status: Accepted — A4-1
- Role: normative contract
- Scope: shared Product browser admission, lifecycle receipts, and permanent-delete commit authority
- Source of truth: PRD, A4 design, and implementation
- Last reviewed: 2026-07-25

## Decision

Every recognized Product API route is served only on the isolated app listener
and uses one process-local browser session. Reads require exact app Host,
same-origin Fetch Metadata, current HttpOnly cookie, and no browser
authorization header. Mutations additionally require exact Origin, CSRF, JSON
framing, and a closed request shape. Successful responses are private,
`no-store`, and `nosniff`. This session is admission authority, not a user
account.

Model, Project, and Conversation lifecycle commands use expected record digest,
canonical intent, and immutable receipt-first replay. Permanent deletion is
separate from trash and requires:

1. a side-effect-free exact closure preview;
2. preview and state tokens plus a short-lived, single-use confirmation token
   bound to browser generation, target, counts, and bytes;
3. an exact typed confirmation;
4. a fresh closure, activity, reference, and authority check; and
5. one mutation-coordinated SQLite and object-file commit followed by an
   immutable receipt.

The object closure is verified by no-follow device, inode, single-link, regular
file, size, and digest identity. Files are staged recoverably before the
database mutation while the verified source descriptor remains open; staging
is reopened and matched before SQL. Immutable historical rows may be deleted
only while a process-private SQLite UDF context is active. The dedicated delete
transaction alone defers foreign-key checks to commit, including closed
Run/command cycles. New v2 recovery manifests preserve exact identity, and the
v1 reader preserves upgrade recovery.

The server holds a process-local resource deletion fence across the synchronous
durable commit. Frame, WebSocket, Agent tool, and Visual-Agent issuers fail
closed or recheck immediately before minting; active downloads, turns, checks,
Runs, process/recovery evidence, and existing authorities remain blockers.
Deletion never implicitly cancels or revokes work.

## Consequences

- Response loss and restart replay the exact durable receipt without requiring
  a still-live confirmation token.
- Changed intent, browser generation, token reuse, state drift, unindexed
  bytes, identity drift, or newly active authority fails before deletion.
- A recovery mismatch poisons the live Store, retains its writer lock and
  evidence, and blocks later database-only lifecycle mutations.
- A Project delete retains its fixed source Model; deleting a source Model is
  blocked while Project lineage exists.
- Public previews and receipts never expose table rows, paths, process
  identity, OpenCode session IDs, credentials, or raw tool payloads.
- A4-1 adds no Home DOM, shared-shell router, startup cutover, or legacy
  retirement.

The Product object root is a single-backend-writer boundary and is never
granted to provider, Model, visual-child, or broker processes. A hostile
same-OS-user process with arbitrary filesystem access is outside this local
deployment guarantee; no native descriptor-relative rename is claimed.
