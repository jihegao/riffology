# Riffology Stage 6 — Agent-oriented Riff flows

- Status: implemented locally; automated exit evidence passed; independent
  review pending
- Authority: Riff Store records, owned object bytes, mutation receipts, Run
  receipts, and lifecycle receipts
- Projection only: Agent text, bootstrap messages, MCP results, DOM, HTML,
  screenshots, and OpenCode idle state

## WorkspaceBinding contract

An unbound workspace receives one durable bootstrap Conversation and one
Store-owned OpenCode working directory. The directory name is a digest-derived
opaque reference under `workspace-bootstrap/`; the Store verifies canonical
ownership, mode `0700`, and absence of symlinks at startup. Neither that path
nor the private OpenCode session reference is present in an HTTP DTO.

The public binding includes a non-null Conversation projection, optional
Model/Project owner, generation, `bindingDigest`, state, selected Provider,
durable bootstrap messages, and an owner record projection. Every draft,
bootstrap write, and bind compares both expected generation and binding digest.
Stable failures distinguish stale binding, stale opaque object/provider
reference, unavailable Provider, conflict, and invalid request.

Bootstrap object and Provider references bind the workspace key, generation,
binding digest, resource identity, and current resource digest. Bootstrap MCP
inputs cannot carry `modelId`, `projectId`, `ownerId`, `path`, `sessionId`, or
other server-owned scope.

## Bootstrap turn and capability

The Riffology UI calls one bootstrap-turn endpoint; it does not expose direct
Model, Project, configuration, or Run buttons. A bootstrap turn:

1. persists the user message in the bootstrap Conversation;
2. uses the Store-verified unbound work directory;
3. restores the exact private OpenCode session or advances its durable session
   generation and reconstructs bounded Conversation context;
4. grants a short-lived capability bound to workspace key, binding generation,
   binding digest, Conversation, and turn;
5. always exposes `riff_bootstrap_list_objects` and, only for one unambiguous
   imperative, exposes exactly one of `riff_bootstrap_create_model`,
   `riff_bootstrap_create_project`, or `riff_bootstrap_bind_owner`;
6. creates the owner, first owner Conversation, binding update, and immutable
   binding receipt atomically for create operations; and
7. closes the bootstrap session and revokes its capability immediately after
   an owner bind.

Provider-down mode retains durable binding and messages as read-only. An
unbound workspace may still persist its local draft through a receipt-backed
WorkspaceBinding update; this is workspace metadata, not a Riff Model/Project
domain write. Model/Project create, existing-owner bind, and bootstrap Agent
turns fail closed while the selected Provider cannot be rediscovered. The
service does not synthesize an assistant answer or use a fallback Provider.

## Owner-scoped MCP

Model scope includes bounded file reads, proposal/direct mutation tools,
generated views, technical-check start, documents/attachments, and
receipt-backed owner lifecycle operations.

Project scope includes fixed-copy file list/read, Experiment list/create/update,
Run list/start/cancel/trash/restore, output list/read, diagnostic event read,
documents/attachments, visual/browser operations, and receipt-backed owner
lifecycle operations. Run and output inputs use opaque `runRef` and `outputRef`;
Run trash additionally requires the exact lifecycle digest, terminal status,
and terminal closure digest. Project file input is an opaque `fileRef`, never a
filesystem path.

Consequential tools are absent from proposal-only and multi-operation grants.
An exact grant binds one tool and, for lifecycle operations, one action. Its
single-operation budget is consumed synchronously before executor entry, so a
concurrent call, a retry after success, and a retry after failure are all
denied. Receipt-backed MCP operations record a durable Action transition only
after the returned projection exactly matches the corresponding immutable
Store receipt or terminal technical-check record. The manifest digest and
affected resources come from Store authority, never from an adapter-supplied
self-hash. Missing, cross-command, corrupt, or projection-tampered evidence
leaves the Action uncommitted, and restart recovery independently audits the
same Store rows. Tool completion without that evidence cannot commit an
Action. Each call rechecks
the active Conversation, active owner lifecycle, running turn, and latest
OpenCode session generation; an owner archive/trash immediately makes old
capabilities stale.

## Local evidence

- Workspace schema migration, rollback, receipt immutability, directory
  recovery, CAS, cross-owner rejection, restart and replay: focused tests pass.
- Atomic bootstrap Model/Project creation, opaque cross-workspace reference
  rejection, Provider-down read-only: focused tests pass.
- Exact bootstrap tools, forbidden scope input, real turn plumbing, durable
  multi-turn messages and Store restart: focused tests pass with a controlled
  OpenCode port.
- Project fixed-copy reads, Experiment/Run receipt operations, Model technical
  check, owner lifecycle digest, and raw Run-ID rejection: focused MCP tests
  pass.
- Web TypeScript production build and complete Web unit/integration suite pass.

These default-suite results are local controlled-port and Store-backed
evidence. They do not by themselves prove the Stage 6 real-provider exit gate.

An opt-in acceptance harness is available as
`backend/test/riffology-stage6-real-opencode.test.ts`. It is skipped by default.
Set `RUN_RIFFOLOGY_STAGE6_REAL_OPENCODE=true`,
`RIFFOLOGY_STAGE6_SMOKE_MODEL=provider/model`, and the pinned
`OPENCODE_EXPECTED_VERSION` to exercise the operator's already-authenticated
local OpenCode installation. The harness never accepts or logs credentials. It
requires a real bootstrap Agent turn to create and bind a Model, then requires
two receipt-verified turns in the same Model Conversation and three in the same
Project Conversation: Experiment creation, frozen Run start, and Project
rename. The Run assertion reads its immutable Store receipt, matches it to the
Action evidence, closes and reopens the Product Store, and verifies the same
receipt digest after restart. The harness also audits bindings/transcripts and
requires both Conversations to complete a further real-provider turn after
session recovery.

On 2026-08-02 the following command passed 1/1 in 92.997 seconds with installed
OpenCode `1.18.11` and the already-authenticated
`opencode-go/deepseek-v4-pro` provider/model:

```sh
RUN_RIFFOLOGY_STAGE6_REAL_OPENCODE=true \
RIFFOLOGY_STAGE6_SMOKE_MODEL=opencode-go/deepseek-v4-pro \
OPENCODE_EXPECTED_VERSION=1.18.11 \
node --experimental-strip-types --test --test-concurrency=1 \
  test/riffology-stage6-real-opencode.test.ts
```

The accepted cards were two exact Model renames, one Experiment create showing
`run kind batch`, `samples 1`, and `horizon=1`, one Run start naming the exact
Experiment ID, and one exact Project rename. The run remained a durable queued
Run, its immutable start receipt matched the committed Action, and the same
receipt digest survived Store restart. Both Model and Project Conversations
then completed another real-provider turn. The harness reported zero fallback
and zero provider/auth failures. Its session identity checks rejected only the
known `opencode_session_workspace_mismatch` signal; no other adapter failure was
accepted.

Browser and viewer acceptance is deliberately composed from separate evidence:
the opt-in Browser smoke proves real OpenCode scoped Browser MCP plus Chromium;
the LocalBrowserBroker suite proves isolation, recovery, generation and
revocation; and the Web suite proves `/workbench/models/:id` and
`/workbench/projects/:id` render the restored Conversation, central browser
projection, and right-side bounded file viewer. None of those tests alone is a
continuous Provider-backed Run execution. The Stage 5 Browser evidence is
reused without reinterpretation: on 2026-08-02 OpenCode `1.18.11` and
`opencode-go/deepseek-v4-pro` passed the real Chromium smoke with six
server-owned one-shot approvals, six ordered MCP calls, PNG evidence, no Riff
mutation, and no fallback. Its reproducible command is:

```sh
RUN_OPENCODE_BROWSER_AGENT_SMOKE=true \
OPENCODE_BROWSER_AGENT_SMOKE_MODEL=opencode-go/deepseek-v4-pro \
node --experimental-strip-types --test --test-concurrency=1 \
  test/opencode-browser-agent-smoke.test.ts
```

The pinned bootstrap/multi-turn/restart harness, receipt-backed Run gate, and
the cited Browser smoke have therefore all passed. Stage 6 remains pending only
the required independent review and merge decision; passing evidence does not
itself merge or publish the implementation.
