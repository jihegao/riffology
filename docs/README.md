# Design and delivery records

Each implementation stage is gated by the architecture and contracts in this
directory. Gate 0 is a design baseline: it approves the target but is not proof
that Gates 1-4 are implemented. Technical owners must document public
interfaces, test expectations, and assumptions before implementation.

Stages 1 and 2 are implemented, and Stage 2 / #13 remains the completed
Agent/Model-workspace authority. Its contract is the
Milestone A product contract plus
[`milestone-a2-agent-workspace-design.md`](milestone-a2-agent-workspace-design.md).
Schema v3/store, conversation/OpenCode context, scoped MCP/skills, attachments,
temporary documents, generic Model workspace, restricted process, technical
checker, and the narrow HTTP/API surface are implemented. Final acceptance has
completed the real-provider, same-session, two-turn browser rerun with OpenCode
`1.18.4`. Legacy Gate and queue code still coexist and are not silently retired
by Stage 2.

Stage 3 / #14 is in progress through
[`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md).
The first foundation slice implemented fixed-copy Project creation and the
Project workspace projection. A3-1a adds schema v4, the closed canonical
input-schema profile, deterministic sample planning, experiment configuration
and record digest CAS with immutable historical receipts, Store-only
execution-description-v2 admission,
and atomic frozen queued-run/start receipts. The generic Stage 2 scaffold still
emits execution-description v1 and requires a future explicit upgrade before
that internal run gate can accept it.
The public start route, dispatcher, batch/visual execution, cancellation,
outputs/events, completion cards, Playwright access, and ordinary wind import
remain target contracts, not implementation evidence.

The authoritative product target is now
[`milestone-a-product-contract.md`](milestone-a-product-contract.md). It
supersedes the former Gate 0-4 product target wherever they disagree. The older
records below remain implementation history and wind-model evidence, not
authority for removing conversation or hard-coding Evidence Studio as the
product.

- [`milestone-a-product-contract.md`](milestone-a-product-contract.md): current
  shared two-pane Models/Projects product contract and four-stage delivery plan.
- [`milestone-a1-data-foundation-design.md`](milestone-a1-data-foundation-design.md):
  Stage 1 SQLite/object-store domain, atomic mutation, recovery, lifecycle, and
  deletion-preview design implemented by `backend/src/product-store-v2.ts`.
- [`milestone-a1-obsolete-state-removal-plan.md`](milestone-a1-obsolete-state-removal-plan.md):
  audited boundary between future tracked-code retirement and protected local
  workspaces/artifacts; it does not authorize deletion.
- [`milestone-a2-agent-workspace-design.md`](milestone-a2-agent-workspace-design.md):
  Stage 2 design for persistent OpenCode conversations, backend-only session
  recovery, progressive skill/action audit, owner-scoped Model tools, atomic
  workspace mutation, generic Mesa scaffolding, and technical executability
  checks. The #13 implementation and real-provider two-turn browser closure are
  complete as documented in the test plan. Stage 3/4 behavior remains
  explicitly out of scope.
- [`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md):
  active Stage 3 / #14 contract and implementation ledger. It distinguishes the
  landed Project foundation and A3-1a frozen-planning boundary from pending
  dispatch, batch/visual supervision, outputs/events, scoped Playwright access,
  and the ordinary wind import.
- [`wind-turbine-maintenance-gate-0.md`](wind-turbine-maintenance-gate-0.md):
  authoritative Gate 0 source mapping, scope, claims, workflow policy, and exit
  contract.
- [`architecture.md`](architecture.md): target system boundaries, revision
  identities, ProductStoreV2 authority, Stage 2 process boundaries, and the
  legacy/current distinction.
- [`product-roadmap.md`](product-roadmap.md): legacy long-term roadmap retained
  as history, with the current Milestone A3 foundation boundary called out
  explicitly.
- [`ui-workflow.md`](ui-workflow.md): minimal Stage 2 acceptance surface and the
  legacy/future browser workflow boundaries.
- [`mesa-service.md`](mesa-service.md): target Mesa model, event, revision, and artifact contract.
- [`opencode-bridge.md`](opencode-bridge.md): current Stage 2 per-conversation
  OpenCode/session/context contract followed by the legacy Gate contract.
- [`backend-api.md`](backend-api.md): current Stage 2 API integration boundary
  followed by the legacy Gate project API target.
- [`test-plan.md`](test-plan.md): current Stage 2 acceptance, Stage 3 foundation
  evidence and pending gates, plus retained legacy Gate test history.
