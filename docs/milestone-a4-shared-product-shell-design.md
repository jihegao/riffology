# Milestone A4 shared product shell design

- Status: active; A4-0 through A4-2 merged, A4-3 Conversation pane implemented
  as a narrow slice, A4-4 through A4-6 pending
- Role: active design
- Scope: Issue #15 Home, shared shell, browser API/lifecycle, Conversation UI,
  workspace rendering, recovery, cutover, precise retirement, and final browser acceptance
- Source of truth: [`product-requirements.md`](product-requirements.md)
- Last reviewed: 2026-07-25

## 1. Authority, entry gate, and claim boundary

The Riff MVP PRD is the only product authority. This document defines how
Stage 4 will satisfy it; it cannot add product scope or turn a target into an
implementation fact.

Stage 4 began only after all hard prerequisites were verified:

- Issue #14 is merged and closed;
- the Stage 3 Integration browser flow was re-run after merge;
- local `main...origin/main` was `0 0`; and
- the only unrelated untracked entry, `.DS_Store`, remained untouched.

A4-0 was documentation only. A4-1 implements the bounded Product
API/lifecycle/deletion slice described below. A4-2 implements the default Home,
one Model/Project router, subordinate Conversation selection, and the shared
responsive shell. A4-3 implements the persistent Conversation pane and its
closed browser contracts without changing the backend startup path or adding
the A4-4 right-pane renderers. A4-4 through A4-6 remain pending. Only A4-6 may claim
the complete MVP browser story or close Issue #15.

## 2. Product invariants and non-goals

The shell has one stable product shape:

```text
left: persistent named Conversations
right: the current Model or Project workspace
```

The following are invariants:

1. Model and Project use one router and one shell.
2. Conversation selection is subordinate to the current object. Switching a
   Conversation must not replace, remount, or discard the right workspace.
3. The right pane uses weak, data-driven rendering rather than fixed workflow
   tabs.
4. Wind is ordinary Model/Project/Experiment content. Core DTOs, routes,
   component names, tabs, conditions, and status labels cannot require wind
   identifiers or domain fields.
5. Agent prose, DOM, screenshots, OpenCode state, renderer output, and child
   process state are projections, not ProductStoreV2 authority.
6. Direct lifecycle and Run controls remain available when Agent state is
   `read_only`.
7. Technical execution, Run success, scientific validity, calibration, trust,
   and decision fitness remain distinct labels.

Stage 4 does not add direct browser editing of Model code/workspace files,
Model versions, active Model switching inside a Project, automatic analysis,
automatic recommendation, batch replay, multi-user identity, Linux support, or
hostile-code containment. Direct editing of an Experiment configuration remains
required in the Project workspace.

## 3. Slice and merge ownership

| Slice | Owns | Must not claim |
| --- | --- | --- |
| **A4-0 design gate** | This documentation-only change establishes the design, traceability, target contracts, review record, and documentation authority. | Runtime or browser behavior. |
| **A4-1 product API** | Collections, Home DTO, safe summaries, generic lifecycle HTTP, permanent deletion, uniform browser admission, owner scope. | Home or shell UI. |
| **A4-2 Home and shell** | Home, router, shared two-pane state, responsive and keyboard foundations. | Complete Conversation or Run UX. |
| **A4-3 Conversation pane** | Named Conversation lifecycle, provider lock, messages, attachments, documents, actions, honest Agent state. | Dynamic Project execution workspace. |
| **A4-4 workspace and execution** | Generic renderer registry, Model workspace, Experiment and Run UI, outputs/events/download, visual frame. | Startup cutover or legacy removal. |
| **A4-5 recovery and cutover** | Product-first startup, complete supported recovery, read-only legacy preflight, manifest-proven retirement. | Final MVP acceptance or Issue closure. |
| **A4-6 exit and closeout** | Continuous real Chromium matrix, full gates, docs, independent reviews, merge, post-merge rerun, Issue #15 closure, exact sync. | Any result not actually observed. |

Every slice follows: update `main`, create a narrow branch, implement focused
tests, synchronize docs, obtain independent review, fix and re-review, run the
full applicable gates, merge, and synchronize local and remote state.

## 4. Target browser routes and Home DTO

The collection, lifecycle, deletion, and browser-admission contracts in this
section are implemented by A4-1. The Product router and visible Home contracts
were implemented by A4-2 and are merged.

### 4.1 Product router

| URL | Meaning |
| --- | --- |
| `/` | Home with independent Models and Projects collections. |
| `/models/:modelId` | Shared shell bound to one Model. |
| `/projects/:projectId` | Shared shell bound to one Project. |
| `?conversation=:conversationId` | Optional subordinate selection. It cannot change the owner encoded in the path. |

An invalid or cross-owner Conversation query is ignored with a bounded visible
error; it never causes fallback to another owner or Conversation.

### 4.2 Collection routes

| Route | Target response |
| --- | --- |
| `GET /api/home` | One atomic `HomeDto` for initial Home rendering. |
| `GET /api/models?lifecycle=active|archived|trashed` | Ordered `ModelSummaryDto` collection. |
| `GET /api/projects?lifecycle=active|archived|trashed` | Ordered `ProjectSummaryDto` collection. |
| `GET /api/providers` | Existing provider discovery, under the same Stage 4 browser admission. |
| `POST /api/models` | Existing name/provider/model create intent and first Conversation. |
| `POST /api/projects` | Existing name/executable-Model fixed-copy create intent. |

`HomeDto` is:

```ts
type HomeDto = Readonly<{
  schemaVersion: 1;
  generatedAt: string;
  collectionDigest: string;
  models: readonly ModelSummaryDto[];
  projects: readonly ProjectSummaryDto[];
  newProjectModels: readonly ExecutableModelOptionDto[];
  providerAvailability:
    | { mode: "live"; providerModelCount: number }
    | { mode: "read_only"; reason: "opencode_unavailable" | "opencode_auth_failed" };
}>;

type ExecutableModelOptionDto = Readonly<{
  id: string;
  name: string;
  technicalStatus: "executable";
  runMode: "batch" | "visual" | "both";
  updatedAt: string;
  recordDigest: string;
}>;
```

Every resource summary contains only stable browser-safe fields:

```ts
type ResourceSummaryBase = Readonly<{
  id: string;
  name: string;
  lifecycleState: "active" | "archived" | "trashed";
  recordDigest: string;
  createdAt: string;
  updatedAt: string;
  recentActivityAt: string;
  recentActivityKind:
    | "resource_created"
    | "resource_updated"
    | "conversation_message"
    | "technical_check"
    | "run_started"
    | "run_terminal";
  allowedActions: readonly (
    | "open" | "rename" | "archive" | "restore" | "trash"
    | "permanent_delete_preview"
  )[];
}>;

type ModelSummaryDto = ResourceSummaryBase & Readonly<{
  kind: "model";
  technicalStatus: "draft" | "checking" | "executable" | "failed";
  runMode: "batch" | "visual" | "both" | null;
}>;

type ProjectSummaryDto = ResourceSummaryBase & Readonly<{
  kind: "project";
  sourceModelId: string;
  modelSnapshotDigest: string;
  lastRun: null | Readonly<{
    id: string;
    status:
      | "configured" | "queued" | "running" | "succeeded"
      | "failed" | "cancelled" | "timed_out" | "trashed";
    updatedAt: string;
  }>;
}>;
```

`allowedActions` is display guidance derived from current lifecycle, not an
authorization credential. The backend rechecks owner, object, operation, and
lifecycle for every request. Recent activity is derived from allowlisted Store
timestamps and kinds; it includes no message text, raw event, path, or tool
payload.

Home contains active resources only; archive/trash views use their explicit
collection queries. Models and Projects are ordered by `recentActivityAt`
descending, then NFC-normalized `name` by Unicode code point ascending, then
`id` ascending. Creation is `resource_created`, so no resource lacks an
activity kind. New-Project Model options are ordered by normalized name then id.
`collectionDigest` is the canonical digest of the ordered closed preimage
`{schemaVersion:1,models:[[id,recordDigest]],projects:[[id,recordDigest]],
newProjectModels:[[id,recordDigest]]}`; `generatedAt` and transient provider
availability are excluded. Every summary and executable option therefore
includes its Store-derived `recordDigest`.

## 5. Shared shell state

The client owns presentation state only:

```ts
type ShellState = Readonly<{
  route:
    | { kind: "home" }
    | { kind: "model"; ownerId: string }
    | { kind: "project"; ownerId: string };
  owner:
    | { state: "idle" | "loading" }
    | { state: "ready"; summaryDigest: string }
    | { state: "read_only"; reason: string }
    | { state: "recovery_required"; reason: string }
    | { state: "not_found" };
  selectedConversationId: string | null;
  conversationPane: {
    mode: "list" | "conversation";
    status: "idle" | "loading" | "live" | "connecting" | "lost" | "read_only";
  };
  workspacePane: {
    ownerKey: string;
    projectionDigest: string | null;
    selectedResource: string | null;
  };
  narrowPane: "conversation" | "workspace";
}>;
```

The workspace cache key is the owner path, never the Conversation ID.
Conversation selection changes update only the left pane and subordinate URL
state. A committed Conversation action that changes an owner resource returns
the new authoritative digest; the shell invalidates and refreshes the right-pane
projection without changing its `ownerKey` or remounting the workspace. Owner
navigation cancels stale reads and replaces both panes. Reload restores the path
owner first, validates the subordinate Conversation, then renders the latest
authoritative projection.

At desktop widths both labelled panes are visible. At narrow widths or 200%
zoom, an accessible two-choice pane selector presents the same mounted owner
state. Focus order, skip links, landmarks, headings, status announcements, and
keyboard operation are required before A4-2 merges.

## 6. Conversation and Agent target contract

The existing server-side Conversation/OpenCode contracts remain authoritative.
Stage 4 adds complete browser projections and lifecycle controls without
exposing external session state.

Target routes include:

- `GET /api/objects/{model|project}/:ownerId/conversations?lifecycle=active|archived|trashed`;
- `POST /api/objects/{model|project}/:ownerId/conversations`;
- `GET /api/conversations/:conversationId`;
- `PATCH /api/conversations/:conversationId/provider-binding`;
- `GET /api/conversations/:conversationId/messages`;
- `GET /api/conversations/:conversationId/attachments`;
- `GET /api/conversations/:conversationId/documents`;
- `GET /api/conversations/:conversationId/actions`;
- `POST /api/conversations/:conversationId/attachments`;
- `POST /api/conversations/:conversationId/turns`; and
- the lifecycle routes in section 8 for Conversation rename/archive/restore/trash.

Conversation creation requires a provider/model pair. It may change only
before the first accepted user message; the provider-binding route requires a
`commandId`, expected Conversation record digest, and an exact discovered
provider/model pair. After that message, the pair is locked. Lifecycle-filtered
owner collections are the only way the browser discovers archived or trashed
Conversations for restore; they retain the same owner checks as active reads.
The UI states are `live`, `connecting`, `lost`, and `read_only`. Provider,
authentication, reconstruction, or OpenCode failure produces `read_only` or
`lost`; it never produces a canned assistant reply.

A durable, expected provider failure is a successful Product-state response:
the turn route returns HTTP 200 with `mode: "read_only"`, a safe reason, the
persisted user message, and no assistant message. Admission, malformed-request,
owner, and transport failures remain HTTP errors. This distinction preserves
zero-console-error browser acceptance without relabelling an expected durable
state as a network failure.

Messages, attachment metadata, temporary document cards, skill uses, and action
records are durable Riff projections. The browser never receives provider
credentials, ambient credentials, OpenCode session IDs, absolute paths, raw
tool payloads, MCP capability URLs, process identities, or child endpoints.

Project tools can manage Project documents, Experiment configurations, Runs,
and user-requested analysis documents. They cannot change the fixed Model copy,
input/output definition, dependency declaration, or execution description.
Analysis documents exist only after an explicit user request and remain
documents, not platform facts.

## 7. Dynamic workspace and renderer registry

The right pane consumes declared, bounded resources through a renderer
registry. It does not infer a domain workflow.

| Renderer | Admission and fallback |
| --- | --- |
| Markdown | At most 1 MiB UTF-8, 50,000 AST nodes and depth 32; fixed React elements, raw HTML disabled, centralized safe-link policy. |
| Code | At most 1 MiB UTF-8 and 20,000 lines; text-only presentation with language allowlist; never executed in the browser. |
| Table | At most 2 MiB, 2,000 rows, 100 columns and 16 KiB per cell; semantic headers/caption and downloadable source where allowed. |
| JSON | At most 2 MiB, 50,000 nodes and depth 32; duplicate-key-safe server validation and plain-text error fallback. |
| Chart/diagram | At most 2 MiB; chart maximum 10,000 marks; diagram maximum 2,000 nodes/4,000 edges; depth 32 and 4 KiB labels; accessible summary/table. |
| Model page | Only the existing restricted current-Run frame/broker contract; never a caller-provided URL or child port. |

Renderer selection is based on server-declared resource kind and validated media
type. Filenames, document text, Model output, event payloads, and child content
are untrusted. Rendering cannot authorize a tool, mutate Product state, or
promote a document to an adopted state.
The server enforces all byte and structural limits before returning a renderer
DTO. A limit failure returns stable `renderer_limit_exceeded` plus a bounded
plain-text explanation and an attachment-only source download where allowed;
content is never silently truncated. Browser negatives prove oversized and
deep Markdown, code, table, JSON, chart, and diagram inputs remain responsive.

Renderer links and resources use one centralized policy. `javascript:`,
`file:`, caller-created `blob:`, active `data:`, caller-selected local URLs,
remote images, remote fonts, and remote embedded resources are rejected.
Allowlisted external links are HTTPS only, visibly external, and use
`noopener noreferrer`. HTML, SVG, and any other active attachment are never
rendered inline; they are served only from an opaque same-origin download route
with attachment disposition, `nosniff`, `private, no-store`, and a safe media
type. The Product app CSP has this mandatory, non-weakening baseline:
`default-src 'none'; script-src 'self';
style-src 'self'; img-src 'self'; connect-src 'self' <exact broker origin>;
frame-src <exact broker origin>; object-src 'none'; base-uri 'none';
form-action 'self'; frame-ancestors 'self'`; any required style/script nonce is
backend-generated and never derived from content. Wildcards, `unsafe-eval`,
unreviewed `unsafe-inline`, remote script/style origins, and content-derived
nonces or sources are forbidden. Any additional source requires independent
security review and a browser negative proving content cannot select it.
Stored-XSS, unsafe URL, SVG, remote-load, opener, and CSP browser negatives are
required before A4-4 merges.

Model workspace shows safe file/document projections, inputs/outputs, technical
checks, and honest status labels. Project workspace shows the fixed-copy
identity, named Experiment configurations, deterministic sample preview, Runs,
status, outputs, diagnostic events, download, cancel, trash/restore, and the
restricted visual frame. It adds no wind branch or fixed Evidence tab.

## 8. Resource lifecycle API

### 8.1 Recoverable lifecycle

The initial generic lifecycle surface covers the exact public kind enum
`"model" | "project" | "conversation"`:

| Route | Intent |
| --- | --- |
| `PATCH /api/resources/:kind/:id` | Rename with `commandId`, expected record digest, and `name`. |
| `POST /api/resources/:kind/:id/archive` | Active to archived. |
| `POST /api/resources/:kind/:id/restore` | Archived to active or trashed to its exact prior state. |
| `POST /api/resources/:kind/:id/trash` | Move to recoverable trash. |

Experiment, temporary-document, and Run lifecycle retain their more specific
contracts. Run cancel/trash/restore keep the existing lifecycle digest,
terminal closure, revocation, and receipt semantics; a generic endpoint cannot
weaken them.

Every mutation returns a durable idempotent receipt with `commandId`, resource
identity, previous/current state or digest, committed time, and receipt digest.
Changed-intent replay is rejected.

### 8.2 Permanent deletion

`ProductStoreV2.previewPermanentDelete()` is currently a read-only primitive.
It is not deletion. A4-1 must implement this exact protocol:

1. `POST /api/resources/:kind/:id/permanent-delete-preview` re-verifies the
   complete target closure and returns:
   - target identity;
   - exact record/file counts and total bytes;
   - blockers and exclusions;
   - deterministic `previewToken` and `stateToken`;
   - a high-entropy, process-local, single-use `confirmationToken` bound to the
     browser generation, exact kind/id, preview/state tokens, action,
     counts/bytes, and expiry; and
   - `expiresAt` no more than five minutes later.
2. The UI renders the target, closure counts, blockers, exclusions, and exact
   destructive action. Preview has no mutation side effect and must never be
   labelled or returned as a delete receipt.
3. `POST /api/resources/:kind/:id/permanent-delete` requires:

```ts
type PermanentDeleteCommand = Readonly<{
  commandId: string;
  previewToken: string;
  stateToken: string;
  confirmationToken: string;
  confirmation: {
    action: "permanently_delete";
    kind: "model" | "project" | "conversation";
    id: string;
    recordCount: number;
    fileCount: number;
    totalBytes: number;
  };
}>;
```

4. Path kind, body kind, token kind, and receipt kind must be byte-identical.
   Unknown kinds, aliases, case variants, duplicate JSON keys, and unexpected
   fields fail before lookup.
5. Receipt lookup happens after current browser admission but before checking
   process-local confirmation state:
   - if a durable receipt exists, exact
     `{commandId, kind, id, canonicalIntentDigest}` match returns the original
     receipt even after restart; changed intent or target is rejected;
   - if no receipt exists, the backend checks the current browser generation,
     Host, Origin, Fetch Metadata, CSRF, token purpose/expiry, owner tuple,
     trashed lifecycle, and exact typed confirmation. It atomically consumes
     the one-use confirmation token inside the mutation coordination boundary.
     Every attempted commit, including drift or validation failure after token
     lookup, invalidates the token and requires a new preview.
6. For a new commit it recomputes the closure and both deterministic tokens
   immediately before mutation.
7. Any blocker, state drift, byte/digest drift, symlink, unknown file,
   unsupported record, active recovery, or token mismatch fails before delete.
8. Database rows and only the verified owned file closure are removed through
   the mutation coordinator. A durable `permanent_delete_receipts` record
   outside the deleted closure supports exact response-loss/restart replay.
9. The receipt reports identities, counts, total bytes, deterministic
   `previewToken`/`stateToken` and receipt digests, and committed time, but no
   confirmation token, path, or deleted content.

For a Model the closure is its row, owned object indexes/files, technical
checks, owned Conversations and their message/attachment/document/action/session
closure; every fixed-copy Project that names it is a blocker. For a Project the
closure is its row, owned object indexes/files, owned Conversations, Experiment
configurations and receipts, Runs, attempts, process/scratch/launch/recovery
evidence, outputs, diagnostic events, commands/receipts, and completion-card
records; its source Model is an exclusion. For a Conversation the closure is
its row and message/attachment/document/action/session closure; a Run that
references it for completion is a blocker and adopted copies owned outside the
Conversation are exclusions. These Store-derived rules are closed; an
unrecognized record or reference is a blocker, not an inferred cascade.

Permanent delete never implicitly cancels work or revokes live authority as
part of deletion. Preview and commit both block while the target or any
descendant has a running Agent turn, live external-session/tool grant,
nonterminal technical check, queued/running/cancelling Run, live process or
scratch/dispatcher/recovery lease, active download, frame, WebSocket, or
Visual-Agent capability. The user must first use the existing typed
cancel/terminalization and lifecycle/revocation operations and wait for their
durable receipts. Commit acquires the Product writer plus the relevant
turn/check/run/download/frame/WebSocket/tool authority issuance fences, then
rechecks that no work, process, lease, transfer, or capability is active before
the first delete byte. Any new or changed activity is state drift and fails
closed with a new preview required. A4-1 negative tests cover this gate
separately for Model, Project, and Conversation.

The prepared file manifest contains only Store-indexed canonical root-relative
paths and exact `{device, inode, nlink, type, size, digest}` identity. Absolute
or traversing paths, symlinks, special files, external hardlinks, duplicate
inodes, unindexed files, and closure-external references are rejected. Under the
single backend writer/mutation lock, each target is opened with `O_NOFOLLOW`;
the source descriptor remains open across the atomic path rename into
coordinator-owned staging, and the staged file is reopened and matched by
device, inode, link count, size, and digest before SQL proceeds. The same
staged identities are rechecked after SQL and before commit. Rollback and any
recovery that must stage or consume still-present removal evidence repeat the
exact-identity check; an already-cleaned committed recovery has no target or
staging bytes left to infer. Deletion is non-recursive and manifest-driven; any
mismatch poisons the live Store and retains the writer lock and recovery
material.

This local-workspace guarantee assumes the backend is the only Product object
writer. Provider, Model, visual child, and broker processes never receive the
Product object-root path or filesystem authority. A separate hostile process
already running as the same OS user with arbitrary filesystem access is outside
the deployment guarantee; such a process can mutate all user-owned Product
bytes independently of this API. A native descriptor-relative rename is not
claimed. New manifests use recovery schema v2; pre-A4 v1 manifests remain
readable and are rolled back or forward using their original backup semantics.

Confirmation tokens are process-local and invalid after restart. An uncommitted
command must preview again; a committed exact-intent command replays its durable
receipt after fresh browser admission without needing the expired token.

`canonicalIntentDigest` is the canonical digest of exactly
`{kind,id,previewToken,stateToken,confirmation:{action,kind,id,recordCount,
fileCount,totalBytes}}`. `commandId` is matched separately. The digest preimage
explicitly excludes `confirmationToken`, cookies, CSRF, browser/session
generation, Origin, and all other admission credentials. Receipt-first replay
matches this stable semantic digest; only a new-commit branch validates the
process-local token.

## 9. Browser admission and owner scope

Stage 4 has one browser-session admission boundary for every browser API,
including provider discovery, collections, workspaces, Conversations,
technical checks, Experiment configuration, Run start/read, lifecycle,
outputs, events, and downloads.

- Bootstrap is the only browser API exception that requires no existing app
  cookie or CSRF. It accepts only `POST` and exact preflight `OPTIONS`, exact
  app `Host:port`, exact non-null app `Origin`,
  `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: cors`,
  `Sec-Fetch-Dest: empty`, exact JSON framing, and the closed body `{}` with
  duplicate or unknown fields rejected. CORS permits credentials only for that exact origin,
  methods `POST, OPTIONS`, and the exact allowlisted headers; Vite, `null`, and
  all other origins are rejected.
- Successful bootstrap creates a random host-only HttpOnly SameSite=Strict app
  cookie with no `Domain`, `Path=/api/`, and matching 15-minute server,
  `Max-Age`, and `Expires` lifetimes; HTTPS also requires `Secure`. It returns a
  separate closure-memory CSRF token. Before success returns, it rotates the
  browser generation and revokes every older app, frame, WebSocket, and
  Visual-Agent authority. Backend restart rotates the generation before any
  browser listener admits traffic.
- Reads require the current cookie, exact Host, same-origin Fetch Metadata, no
  ambient authorization, and route-specific empty/query/header constraints.
- Mutations additionally require exact Origin, CSRF, non-simple JSON content
  type, bounded body, and idempotency key.
- IDs are not bearer credentials. The service resolves the resource and
  rechecks its Model/Project/Conversation/Run ownership tuple and lifecycle.
- Cross-owner, cross-run, stale generation, duplicate sensitive header,
  foreign Origin, missing Fetch Metadata, expired token, and changed-intent
  requests fail closed.

The MVP remains local single-user. The app cookie proves a current local human
browser session; it is not a multi-user account principal. “Owner scope” means
the durable Product resource hierarchy, not a fabricated account/role model.

Every public DTO and stable error is constructed server-side from an explicit
closed schema/field allowlist; unknown fields are rejected, and the server never
spreads or serializes Store rows, exceptions, provider/tool payloads, child
responses, or raw blocker objects. Public schema families expose only:

| DTO family | Allowlisted field groups |
| --- | --- |
| Home/resource summary | schema version/time/digest; resource id/name/kind/lifecycle/timestamps/allowedActions; thin technical/run summary |
| Conversation/message | Riff ids, owner tuple, name/provider/model/status/timestamps/digests; actor/content/card subtype and bounded content |
| Attachment/document/action | Riff ids, lifecycle/provenance/media/size/digest/timestamps; typed action/status and bounded safe summary |
| Provider failure/stable error | stable code, bounded user-safe message, retry/read-only flag, request correlation id |
| Delete preview/blocker/exclusion | public kind/id/reason code, counts/bytes, deterministic preview/state tokens, expiry, and the one high-entropy `confirmationToken`; never paths or internal table names |
| Delete receipt | command/target/counts/bytes/state/receipt digests and committed time |

Credential, session, path, authority, log, console, network, and persistence
scanners remain regression evidence only; they are not the isolation control.
The raw `confirmationToken` appears only in a successful preview response, the
matching delete request DTO, and that request's process-local one-use admission
state. Neither raw nor hashed token enters any other response, logs, errors,
persistence, receipts, audit/scanner corpus, or stable intent digest.
All session-bound JSON, errors, documents, previews, and action projections use
`Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.
Downloads remain attachment-only and no-store. Browser tests cover reload,
back/forward cache, successful bootstrap rotation, and restart without reuse of
old responses.

## 10. Startup, recovery, and cutover

The target Product startup order is:

1. resolve and validate the explicit Product root;
2. acquire the ProductStoreV2 writer boundary;
3. complete or fail closed on mixed SQLite/object mutation recovery;
4. reconcile interrupted turns, sessions, technical checks, visual audit gaps,
   completion cards, and lifecycle receipts;
5. reconcile every prior Run attempt, scratch lease, launch/process identity,
   health, exit, cleanup, cancellation, and dispatcher generation;
6. only after all mutation and Run recovery succeeds, invoke
   composition-root-registered generic Domain Pack installers through Product
   contracts; the current wind installer is one ordinary registered pack, not
   a ProductStoreV2/Core dependency. An optional pack failure records
   `pack_installation_failed` for that pack and does not block Core browser
   admission; only deployment configuration may mark a named pack required;
7. perform the A4-5 read-only legacy-state preflight;
8. create the new dispatcher generation; and
9. bind the browser network in either full or recovery-only mode.

No conflicting write or dispatch is accepted before recovery completes. If all
reconciliation succeeds, full Product reads/writes and dispatch become
available. If a contradiction fails closed, the exact app may bind only a
minimal recovery surface: the static shell,
`POST /api/browser-session/bootstrap`, `GET /api/health`, and
`GET /api/recovery-status`. The last route returns only
`{state:"recovery_required", code, observedAt, retryable}` from a closed
allowlist; it exposes no resource, path, process, database, or recovery-manifest
detail. Every collection/resource read, mutation, Run dispatch, frame,
WebSocket, and Agent/tool route returns stable `503 recovery_required`.
The shell renders the global recovery-required state without pretending that a
specific owner loaded. Browser admission remains exact and no speculative
cleanup occurs.

The A4-5 preflight classifies, but does not automatically mutate:

| Class | Disposition |
| --- | --- |
| ProductStoreV2 SQLite, objects, recovery records, supported Runs/outputs | Preserve and recover. |
| Preinstalled ordinary wind Model/Project/Experiment and reviewed Mesa assets | Preserve. |
| Generic batch/visual supervisors, dispatcher, broker/frame/WebSocket, scoped Playwright | Preserve. |
| Queue product, fixed Evidence Studio, Gate revision/activation/attestation/policy/replay/auditor product paths | Candidate tracked-code retirement after replacement acceptance and exact dependency scan. |
| Old `.riff-workspace*`, local outputs, `test-results`, virtual environments, caches, `.DS_Store`, ignored/untracked files | Excluded from automatic cleanup; read-only classification only. |

Only A4-5 may retire tracked legacy code, and only after the new entry is
validated. Candidate status is not deletion authorization. Removal requires an
explicit tracked manifest, route/import/schema/string scans, dependency
classification, before/after Git and ignored-file manifests, exact identity,
version and digest evidence, independent review, and full regression gates.
Broad deletion, `git clean`, workspace-root recursion, glob-selected local
state, and name-only “wind” deletion are forbidden.

## 11. PRD traceability matrix

Every row is `pending` until its owning implementation slice merges with the
listed evidence. “Target API” does not mean the route exists today.

### 11.0 Slice ownership

Ownership is explicit, including requirements that cross slices. A row cannot
advance from `pending` until every listed implementation owner has merged; A4-6
then owns the continuous exit verification.

| Requirement family | Implementation owner(s) | Exit verifier |
| --- | --- | --- |
| FR-HOME, FR-LIFE | A4-1 API/lifecycle; A4-2 Home resource UI; A4-3 Conversation lifecycle UI where applicable | A4-6 |
| FR-SHELL-01/02/04 | A4-2 | A4-6 |
| FR-SHELL-03/05 | A4-4, with A4-3 for Agent read-only projection | A4-6 |
| FR-CONV, FR-DOC, FR-ATT | A4-3 | A4-6 |
| FR-MODEL | A4-1 admission/collections; A4-2 New Model entry; A4-4 workspace/check projection | A4-6 |
| FR-PROJ | A4-1 admission/collections; A4-2 New Project entry; A4-4 Project workspace | A4-6 |
| FR-EXP, FR-RUN, FR-VIS | A4-4; A4-5 for startup recovery requirements | A4-6 |
| FR-DATA-01/02/03/05 | A4-1 plus the slice that adds each projection | A4-6 |
| FR-DATA-04 | A4-5 | A4-6 |
| NFR-AUTH/ATOM/FAIL/SEC/SCOPE/IDEM | A4-1 common boundary plus every consuming implementation slice | A4-6 |
| NFR-REC, NFR-COMPAT | A4-5 | A4-6 |
| NFR-HONEST | A4-2 through A4-5 as applicable | A4-6 |
| NFR-TEST | Every implementation slice | A4-6 |

### 11.1 Home and lifecycle

| PRD ID | Target API | Target UI | Required evidence | Status |
| --- | --- | --- | --- | --- |
| FR-HOME-01 | `GET /api/home`, `/api/models`, `/api/projects` | Separate collections, state, recent activity | Owner/order/empty DTO tests; desktop/narrow/a11y browser | pending |
| FR-HOME-02 | Home/create routes | Models, Projects, New Model, New Project entries | Four-entry continuous browser start | pending |
| FR-HOME-03 | `POST /api/models`, provider discovery | Name and provider/model only | Validation, provider failure, idempotency | pending |
| FR-HOME-04 | `POST /api/projects`, executable Model options | Name and executable Model only | Inactive/non-executable/cross-owner rejection | pending |
| FR-LIFE-01 | Rename/archive/restore/trash routes | Direct menus independent of Agent | Owner, idempotency, restart, Agent-down controls | pending |
| FR-LIFE-02 | Preview then confirmed permanent delete | Explicit preview/confirm | Stale token/state, drift, replay, preview-no-delete | pending |
| FR-LIFE-03 | Lifecycle/delete projections | Blockers and exclusions | Source delete cannot touch Project copy or local files | pending |

### 11.2 Shared shell and Conversation

| PRD ID | Target API | Target UI | Required evidence | Status |
| --- | --- | --- | --- | --- |
| FR-SHELL-01 | Owner/workspace projections | One Model/Project two-pane shell | Desktop current-owner persistence | pending |
| FR-SHELL-02 | Conversation list/read under owner route | Switch left thread, retain right object | Identity/no-remount/navigation/reload | pending |
| FR-SHELL-03 | Declared document/output APIs | Markdown/code/table/JSON/chart/Model page | Escaping, untrusted input, a11y fallback | pending |
| FR-SHELL-04 | No domain route or DTO | Dynamic workspace, no wind/Evidence tabs | Route/import/string scan and generic case | pending |
| FR-SHELL-05 | Direct lifecycle and Run APIs | Controls available in `read_only` | Provider-down Chromium, no canned reply | pending |
| FR-CONV-01 | Conversation create/read/lifecycle | Named create/switch/rename/archive/restore/trash | Owner, replay, restart, browser switch | pending |
| FR-CONV-02 | Message/attachment/document/action projections | Durable cards and records | Persistence plus credential/session/raw-payload redaction | pending |
| FR-CONV-03 | Conversation create/provider binding | Selector then locked display | Change before/after first message; replay | pending |
| FR-CONV-04 | Turn/session lifecycle | live/connecting/lost/read_only | Loss, rebuild, restart, provider unavailable | pending |
| FR-CONV-05 | Internal bounded context | Safe source/status summary only | Allowlist, secret and irrelevant-document negatives | pending |
| FR-CONV-06 | Skill catalog and action records | Visible skill use | Lazy load, audit, denied scope | pending |
| FR-CONV-07 | Provider/readiness state | Explicit read-only | No fabricated assistant response | pending |
| FR-CONV-08 | Typed owner-scoped actions | Committed/denied status | Cross-owner, unauthorized, atomicity | pending |
| FR-DOC-01 | Temporary document create/read/update | Optional linked message cards | No forced card; create/update lifecycle | pending |
| FR-DOC-02 | Document lifecycle | draft/adopted/rejected/superseded | Render is not adoption; restart persistence | pending |
| FR-ATT-01 | Attachment and adoption routes | Source/provenance display | Owner copy, purpose, size, digest | pending |
| FR-ATT-02 | Conversation trash/delete | Adopted-copy disclosure | Owner copy survives Conversation deletion | pending |

### 11.3 Model, Project, and Experiment

| PRD ID | Target API | Target UI | Required evidence | Status |
| --- | --- | --- | --- | --- |
| FR-MODEL-01 | New Model/scaffold | Generic workspace | Continuous browser creation/open plus no placeholder or wind template | pending |
| FR-MODEL-02 | Execution description/check reads | Inputs/entry/status/output declarations | Malformed, cancellation, output negatives | pending |
| FR-MODEL-03 | Workspace file/document projection | Dynamic renderer sections | Arbitrary declared docs; no fixed schema | pending |
| FR-MODEL-04 | Technical check/readiness | Executable selector badge | Syntax/interface/dependency/smoke/resource/cancel/output | pending |
| FR-MODEL-05 | Honest technical DTO | Thin technical status copy | Forbidden validity/trust terminology scan | pending |
| FR-MODEL-06 | Restricted checker/supervisor | Bounded status only | Path/env/network/resource/cancel regression | pending |
| FR-MODEL-07 | Scoped Model tools | Safe action summary | Other-owner/source/home/credential denial | pending |
| FR-PROJ-01 | `POST /api/projects` fixed copy | New Project confirmation | Source edit/delete isolation | pending |
| FR-PROJ-02 | Project summary/workspace | No active Model/version UI | API and UI negative scan | pending |
| FR-PROJ-03 | Project tool/config/document API | Project Conversation workspace | Code/schema/dependency mutation denial | pending |
| FR-EXP-01 | Experiment create/read/update/lifecycle | Named editable form | Save/read/restart/idempotency | pending |
| FR-EXP-02 | Plan preview | Seeds/sweep/sample count | Invalid plan, exact count, limit | pending |
| FR-EXP-03 | Run start/frozen receipt | Accepted configuration preview | Edit-after-queue and restart freeze | pending |
| FR-EXP-04 | Outputs and explicit analysis document | User-requested analysis only | No automatic metric/optimum/reinterpretation | pending |

### 11.4 Run and visual

| PRD ID | Target API | Target UI | Required evidence | Status |
| --- | --- | --- | --- | --- |
| FR-RUN-01 | Run start/read by declared capability | Capability/error state | Unsupported capability rejection | pending |
| FR-RUN-02 | Start/cancel/download/trash | Direct controls | Replay, lifecycle, Agent-down | pending |
| FR-RUN-03 | Run overview DTO | Status/samples/horizon/seeds/metrics/duration/resources/files | Projection and real batch browser | pending |
| FR-RUN-04 | Output list/download | Checked outputs | Path/media/size/digest/atomic/cross-run failures | pending |
| FR-RUN-05 | Diagnostic-event cursor/list | Bounded filterable events | Cap, pagination, tamper, trash | pending |
| FR-RUN-06 | Completion-card receipt | One platform card or skip | Exactly once; no visual card | pending |
| FR-RUN-07 | Explicit analyze action/document | Requested analysis document | No request means no document | pending |
| FR-RUN-08 | Frozen limits/status | Timeout/cancel/failure | Resource/log/event/output/process/cancel-first | pending |
| FR-RUN-09 | Startup/recovery records | recovery-required state | Durable evidence, fail closed, restart | pending |
| FR-VIS-01 | Visual start/status | Managed visual controls | Health/proxy/stop/timeout/output/resource | pending |
| FR-VIS-02 | Frame bootstrap/redeem | Restricted right-pane frame | No child endpoint/credential/route leak | pending |
| FR-VIS-03 | Browser/frame/WebSocket session | Current frame state | Host/Origin/Fetch/CSRF/owner/generation/expiry/revocation | pending |
| FR-VIS-04 | Internal scoped Playwright capability | Action summary only | Immutable confirmation, single-use, audit, scope denial | pending |
| FR-VIS-05 | Observation projection | Timestamped DOM/a11y/screenshot | Never promoted to Project state | pending |
| FR-VIS-06 | Visual terminalization | No completion card/report | Database/API/browser absence | pending |

### 11.5 Data and non-functional requirements

| PRD ID | Target API/boundary | Target UI | Required evidence | Status |
| --- | --- | --- | --- | --- |
| FR-DATA-01 | Store reads/lifecycle | Restored status | Ownership/lifecycle persistence | pending |
| FR-DATA-02 | Object/output/attachment indexes | Declared files only | Path/size/digest/index checks | pending |
| FR-DATA-03 | Mutation coordinator and receipts | Honest transient/recovery state | Database/filesystem fault recovery | pending |
| FR-DATA-04 | Startup/read APIs | Restored supported resources | Continuous backend-restart browser test | pending |
| FR-DATA-05 | Every browser DTO | No internal authority | DTO/log/error/canary scans | pending |
| NFR-AUTH-01 | Every write admission | Disabled/forbidden state | Owner/object/operation/lifecycle matrix | pending |
| NFR-ATOM-01 | Mutation/output/delete commit | Receipt/recovery display | Crash/fault atomicity | pending |
| NFR-REC-01 | Startup coordinator | Pending/recovery state | Reconcile-before-write race | pending |
| NFR-FAIL-01 | Stable errors | Explicit safe error | Missing/conflict/expiry/unsupported | pending |
| NFR-SEC-01 | Every projection | Redacted UI | DTO/console/network/persistence secret scan | pending |
| NFR-SEC-02 | Model/Run supervisors | Limits/status only | Sandbox/env/network/resource/cancel | pending |
| NFR-SCOPE-01 | Every resource/tool/run/frame route | Current-owner state | Cross-owner/object/capability rejection | pending |
| NFR-IDEM-01 | Create/start/cancel/delete receipts | Replay-safe UI | Duplicate/change-intent/restart | pending |
| NFR-HONEST-01 | Status DTOs | Exact state vocabulary | Copy/status matrix | pending |
| NFR-COMPAT-01 | Legacy preflight/manifest | Classified, not Product UI | No behavior authority or untracked deletion | pending |
| NFR-TEST-01 | Slice gate record | Evidence links only | Contract, negative, restart, review, browser | pending |

## 12. A4-6 continuous Chromium exit matrix

One continuous Chromium scenario, not disconnected screenshots, must cover:

1. Home and all four entries, including creating and opening a functional
   generic New Model workspace;
2. the ordinary wind Model;
3. a real multi-turn OpenCode change or persistent temporary document, with
   the committed owner change reflected in the mounted right workspace;
4. a second Conversation and state-preserving switching;
5. a fixed-copy Project;
6. a Project Conversation modifying an Experiment configuration;
7. a real batch Run, status, outputs, events, and download;
8. an analysis document only after the user requests it;
9. a restricted visual frame;
10. backend restart and complete supported recovery;
11. OpenCode unavailable with read-only state and no fabricated reply; and
12. 1440×900, narrow viewport, keyboard-only operation, 200% zoom, and zero
    unexpected console errors.

The configured provider/model is discovered at runtime and recorded in
evidence. If an authorized alternative is required because quota is exhausted,
its exact discovered qualified ID is recorded; fallback is never silent and
never changes a locked Conversation.

Final gates include all backend, web, browser, build, docs, broker/WebSocket,
Visual-Agent, lifecycle/deletion, recovery, secrecy, and legacy-scan tests.
Independent correctness, security, accessibility, product, and architecture
reviews must report P0=0 and P1=0. After merge, the same critical browser flow
is re-run before Issue #15 closes and `main...origin/main = 0 0` is reported.

## 13. Documentation and review gate

Every A4 implementation slice synchronizes:

- this design and the PRD implementation snapshot;
- root and docs README;
- architecture and API contracts;
- Conversation/OpenCode and UI workflow boundaries;
- test plan and exact evidence;
- startup/recovery and removal records; and
- any ordinary wind/Mesa record affected by actual behavior.

Documentation must distinguish target, implemented on branch, merged,
post-merge reverified, and complete MVP. It must not use a preview as a delete,
a browser session as a user account, a technical check as scientific trust, a
Run success as decision fitness, or a backend/API harness as shared-shell UI.

A4-0 requires independent Product, Architecture, and Security review with
P0=0 and P1=0 before merge. Reviewers for the design gate do not implement the
design. A4-1 coding began only after A4-0 was merged and local/remote `main`
were synchronized.

### A4-0 review record

On 2026-07-25, three independent read-only reviewers who did not implement this
change completed Product, Architecture, and Security review after all findings
were fixed and re-reviewed:

| Review | Final result |
| --- | --- |
| Product | P0=0, P1=0, P2=0 |
| Architecture | P0=0, P1=0, P2=0 |
| Security | P0=0, P1=0, P2=0 |

This record accepts only the documentation design gate. It is not an A4
implementation, browser-shell, deletion, cutover, or complete-MVP acceptance.

### A4-1 implementation record

A4-1 implements the backend-only Product API slice:

- schema v14 immutable lifecycle and permanent-delete receipts plus a
  process-private SQLite UDF purge context that cannot persist after crash;
- closed Home, Model, Project, executable-Model, lifecycle, blocker, exclusion,
  and delete-receipt projections;
- generic Model/Project/Conversation rename/archive/restore/trash routes;
- real side-effect-free preview followed by single-use, browser-generation-
  bound typed confirmation and exact durable deletion;
- one Product browser admission boundary for all recognized Product reads and
  mutations, with private no-store responses; and
- exact byte/index identity, mutation recovery, runtime blockers, and a held
  authority-issuance fence across delete commit.

Focused evidence covers Model/Project/Conversation lifecycle, fixed-copy
isolation, cross-owner and unknown-field denial, response-loss/restart replay,
preview-not-delete, stale/consumed/rotated tokens, closure drift, symlink,
hardlink, unindexed bytes, active Run/process/download/frame/WebSocket/tool
authority, delayed-FK delete cycles, v1/v2 rollback/roll-forward, poisoned
recovery, and browser secrecy. Ready preinstalled resources retain ordinary
rename/archive/trash state across restart; the immutable manifest identity
blocks permanent deletion but is not a lifecycle lock.

The A4-1 record does not implement or verify Home DOM, routing, shared shell,
Conversation UI, workspace renderers, startup cutover, legacy retirement, or
the continuous A4-6 Chromium matrix. For that reason every row in section 11
remains `pending`, and Issue #15 remains open.

The branch gate is backend 583 total / 582 passed / zero failed / one optional
installed-OpenCode smoke skipped; web 104/104 and network-entry 1/1;
production build passed; 27 Markdown files and `git diff --check` passed.

Three independent read-only reviewers who did not implement A4-1 completed
final review after all findings were fixed and re-reviewed:

| Review | Final result |
| --- | --- |
| Product/correctness | P0=0, P1=0, P2=0 |
| Architecture | P0=0, P1=0, P2=0 |
| Security | P0=0, P1=0, P2=0 |

This review accepts only the A4-1 Product API implementation. It does not
accept any visible Stage 4 workflow or the complete MVP.

### A4-2 implementation record

A4-2 implements the bounded visible Product foundation:

- Product Home is the default Vite route at `/`, with independent Models and
  Projects sections, resource links, New Model, and New Project;
- New Model asks only for name plus a discovered provider/model, while New
  Project asks only for name plus an executable Model returned by Home;
- provider or executable-Model unavailability disables only the affected
  creation path and shows an honest read-only explanation;
- `/models/:id` and `/projects/:id` use the same shared shell and owner-state
  component;
- `?conversation=` changes only subordinate left-pane selection. A missing or
  cross-owner selection produces a bounded visible error and never changes or
  remounts the right owner workspace;
- Model workspaces combine the existing Model workspace projection with the
  owner Conversation collection; Project workspaces consume their existing
  combined projection; and
- desktop shows both landmarks, while narrow/equivalent-200%-layout uses a
  labelled keyboard-operable pane selector with no horizontal page overflow.

The browser client performs the exact Product bootstrap, retains CSRF only in
memory, and sends the current session cookie through the same-origin Vite
proxy. The proxy rewrites only the trusted local development Host/Origin to the
backend app authority. It does not synthesize browser Fetch Metadata or expose
the HttpOnly cookie.

Deprecated `?mode=legacy` and `?mode=evidence` compatibility paths remain
isolated and unlinked so their browser/security regressions continue until
A4-5 has manifest-proven authority to remove them. They are not Product
navigation or Stage 4 product types.

The A4-2 right pane intentionally renders only a truthful owner/status summary
and the A4-4 boundary. Messages, attachments, documents, Conversation
lifecycle/provider locking, renderer content, Experiment/Run controls, startup
cutover, recovery UI, retirement, and the continuous A4-6 matrix remain
pending. All 69 final trace rows remain `pending`, and Issue #15 remains open.

Focused evidence currently includes 10/10 Product component/client/router
tests, the complete Web component suite at 112/112, network entry 1/1, the
dedicated A4-2 real-Chromium scenario 1/1, Visual-Agent Chromium 6/6, and the
retained Chromium compatibility/security matrix at 15/15. Backend 583 total /
582 passed / zero failed / one optional installed-OpenCode smoke skipped also
passes. Production build, 27-document governance check, and `git diff --check`
also pass.

Three independent read-only reviewers who did not implement A4-2 completed
final review after the reported P1 findings were fixed and re-reviewed:

| Review | Final result |
| --- | --- |
| Product/architecture | P0=0, P1=0, P2=1 |
| Accessibility/interaction | P0=0, P1=0, P2=0 |
| Test/documentation consistency | P0=0, P1=0, P2=0 |

The remaining Product/architecture P2 records that A4-2 uses an explicitly
labelled equivalent-200%-layout CSS viewport rather than actual browser zoom.
Actual 200% zoom remains part of the A4-6 continuous exit matrix; this
non-blocking limitation is not an A4-2 completion claim.

### A4-3 implementation record

A4-3 implements the persistent left Conversation pane and its closed browser
contracts:

- owner-scoped active, archived, and trashed collections drive creation,
  selection, rename, archive, restore, trash, and safe permanent deletion;
- schema v15 records immutable, intent-bound provider/model binding receipts,
  with exact replay after restart and changed-intent rejection;
- the provider/model selector is available only before the first accepted user
  message and then displays the durable locked binding;
- ordered messages, allowlisted attachments, temporary-document metadata, and
  redacted skill/action cards survive Conversation switching without remounting
  the right owner workspace;
- attachment names and media types are fail-closed, while public DTOs exclude
  object-file IDs, paths, credentials, OpenCode session references, rationale,
  intent, affected resources, capability URLs, and raw tool payloads;
- expected provider failure persists only the user message and returns HTTP 200
  with `mode: "read_only"` and no assistant message; and
- permanent deletion is available only from Trash after a distinct preview,
  blocker display, current token/state validation, and exact typed-name
  confirmation.

The dedicated Chromium fixture is deterministic acceptance infrastructure, not
real-provider evidence. It verifies two state-independent Conversations,
provider change and lock, attachment retention, right-pane DOM identity,
lifecycle recovery, preview/confirm deletion, read-only no-fabrication,
narrow keyboard operation, horizontal fit, response secrecy, and zero console
errors. Real-provider multi-Conversation acceptance remains exclusively A4-6.

The complete implementation gate is backend 586 total / 585 passed / zero
failed / one optional installed-OpenCode smoke skipped; Web 116/116; network
entry 1/1; dedicated A4-3 Chromium 1/1; retained A4-2 Chromium 1/1; retained
full Chromium 15/15; Visual-Agent Chromium security 6/6; production build;
27-document governance; and clean `git diff --check`.

Three independent read-only reviewers who did not implement A4-3 completed
final review after all findings were fixed and re-reviewed:

| Review | Final result |
| --- | --- |
| Product/architecture/security | P0=0, P1=0, P2=0 |
| Accessibility/interaction | P0=0, P1=0, P2=0 |
| Test/documentation consistency | P0=0, P1=0, P2=0 |

A4-4 renderer/Project execution UI, A4-5 startup cutover/recovery/retirement,
and the continuous A4-6 browser matrix remain pending. All 69 final trace rows
remain `pending`, and Issue #15 remains open.
