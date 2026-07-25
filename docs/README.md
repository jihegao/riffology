# Design and delivery records

- Status: active
- Role: normative contract
- Scope: documentation governance and repository document index
- Source of truth: this index and the linked governing documents
- Last reviewed: 2026-07-25

## Document governance

This directory uses four lightweight document roles. The role describes how a
reader should use a document; it does not replace the document's explicit
status or the repository's implementation and test evidence.

| Role | Meaning | Change rule |
| --- | --- | --- |
| **Normative contract** | Defines currently approved product, API, security, or lifecycle behavior. | Update before or with the implementation that changes the contract; do not infer implementation from the document alone. |
| **Active design** | Defines an in-progress milestone or slice, including pending gates. | Keep landed and pending boundaries explicit; link stable decisions to the governing normative contract. |
| **Implementation record** | Records commands, test results, PRs, commits, and acceptance evidence. | Preserve dated or stage-scoped evidence; do not rewrite historical results as current results. |
| **Historical record** | Retains superseded design or implementation context. | Keep for traceability, label conflicts as superseded, and do not use it as current product authority. |

New or materially revised active documents should identify, near the title:

- `Status`: active, implemented, superseded, or historical;
- `Role`: one of the four roles above;
- `Scope`: the milestone, API, subsystem, or decision covered;
- `Source of truth`: the governing document or implementation authority; and
- `Last reviewed`: an ISO date when the document's current-state claims were
  checked.

The ordinary-document `Status` vocabulary above describes a document's
lifecycle. ADRs use a separate decision-maturity vocabulary:
`Proposed`, `Accepted`, or `Superseded`. A `Proposed` ADR is a derived review
checklist for a pending implementation gate; it is neither an accepted
normative contract nor implementation evidence. Promoting or superseding an
ADR requires the corresponding source contract to be reviewed in the same
change.

These fields are navigation metadata, not delivery evidence. PR merge state is
authoritative on GitHub; runtime behavior is authoritative in the merged code
and Store/API invariants; test results remain scoped to the recorded command
and revision.

Run the repository's dependency-free documentation check before review; it
uses only the existing Bash, Git, and Node.js toolchain and installs no package:

```sh
bash scripts/check-docs.sh
```

The command performs a lightweight relative-link check, detects stale
merged-slice wording in active documents, and validates Git whitespace. It does
not replace a full CommonMark parser.

### Source-of-truth map

| Question | Primary source of truth | Supporting record |
| --- | --- | --- |
| What product and two-pane workflow are approved? | [`milestone-a-product-contract.md`](milestone-a-product-contract.md) | [`README.md`](../README.md) |
| What is the active Stage 3 contract and what remains pending? | [`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md) | Issue #14 and its merged PRs |
| What HTTP/API behavior is currently exposed? | Merged server/Store implementation and [`backend-api.md`](backend-api.md) | API and Store tests |
| What evidence is required or has historically passed? | [`test-plan.md`](test-plan.md) | Revision-scoped test output and PR checks |
| What is the current Stage 3 runtime/security boundary? | Merged implementation and [`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md) | [`architecture.md`](architecture.md) overview |
| Which A3-2b decisions gate implementation? | [`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md) and [`backend-api.md`](backend-api.md) | Derived [`ADR review checklist`](adr/README.md) |
| How should superseded Gate and roadmap documents be read? | Their explicit historical/superseded labels | Current Milestone A contract |

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

Stage 3 / #14 remains in progress through
[`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md).
The first foundation slice implemented fixed-copy Project creation and the
Project workspace projection. A3-1a adds execution contract v4, the closed canonical
input-schema profile, deterministic sample planning, experiment configuration
and record digest CAS with immutable historical receipts, Store-only
execution-description-v2 admission,
and atomic frozen queued-run/start receipts. A3-1b adds the public run
start/read routes, durable dispatch, a real generic batch subprocess,
hard-enforced currently supported limits, and atomic successful output
publication. The official generic scaffold now emits execution-description v2
and declares only batch execution; existing v1 Models are not silently
upgraded.

Visual completion and batch `domainEvents` are explicit current rejections,
not partial implementations; published A3-2a2c admits eligible visual starts
through the existing Project-run API. A3-1c-a adds schema migration v5 and strict
same-process cancel receipts/precedence for queued and running batch work.
A3-1c-b adds schema migration v6, durable scratch/launch manifests and receipts,
and recovery of v4 claimed/starting/running attempts before a new dispatcher
generation may activate. Contradictory or missing evidence fails closed without
scanning untracked scratch. A3-1c-c adds schema migration v7, deterministic
platform completion cards, terminal skip receipts, and startup reconciliation
of older pending terminal runs. Brokered browser access, Playwright authority,
and ordinary wind import remain later #14 slices. A3-1c-c is therefore not
completion evidence for Stage 3.

The visual sequence is frozen as A3-2a1 schema-v8 Store/recovery, A3-2a2
real visual lifecycle, A3-2b isolated broker/frame/WebSocket, and A3-2c scoped
Playwright. A3-2a1 and A3-2a2a/A3-2a2b/A3-2a2c are merged and published through
PRs #28/#29/#30/#31 respectively; A3-2a2c's merge commit is `361b36f`.
A3-2a1 is only the schema/Store/recovery extension plus negative admission: it
hardens the existing v4 port/health shape with port immutability, atomic health
receipt, and fail-closed unproven pre-v8 evidence. A3-2a2 uses
the canonical single-sample input envelope and assigned output directory, never
publishes child ports, uses a visual-only no-outbound sandbox, starts with one
active visual slot without blocking batch claims, and sends one no-retry exact
bounded health GET. It does not support visual completion cards or make a
browser claim. A3-2b exact-binds platform app and broker to `::1` on different ports:
the port split isolates DOM origins while remaining same-site, and the IPv6
host keeps platform cookies away from the untrusted IPv4 visual child. Its
generation/≤60-second nonce/Origin/Host/registry checks and exact-app
`frame-ancestors`, not Cookie Path, are authority. A3-3 remains the ordinary
wind import.

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
  landed Project foundation, A3-1a frozen-planning boundary, and A3-1b generic
  batch execution plus A3-1c cancellation/restart recovery and exactly-once
  batch completion cards plus the published A3-2a1/A3-2a2 visual runtime from
  the pending A3-2b broker/frame/WebSocket, A3-2c scoped Playwright, and A3-3
  ordinary wind import.
- [`wind-turbine-maintenance-gate-0.md`](wind-turbine-maintenance-gate-0.md):
  authoritative Gate 0 source mapping, scope, claims, workflow policy, and exit
  contract.
- [`architecture.md`](architecture.md): supporting architecture overview,
  revision identities, ProductStoreV2 authority, Stage 2 process boundaries,
  and the legacy/current distinction. Current Stage 3 runtime/security
  authority remains the merged implementation plus the active A3 design.
- [`product-roadmap.md`](product-roadmap.md): legacy long-term roadmap retained
  as history, with the current Milestone A3 foundation boundary called out
  explicitly.
- [`ui-workflow.md`](ui-workflow.md): minimal Stage 2 acceptance surface and the
  legacy/future browser workflow boundaries.
- [`mesa-service.md`](mesa-service.md): target Mesa model, event, revision, and artifact contract.
- [`opencode-bridge.md`](opencode-bridge.md): current Stage 2 per-conversation
  OpenCode/session/context contract followed by the legacy Gate contract.
- [`backend-api.md`](backend-api.md): current Stage 2 plus published A3-1 and
  A3-2a API/runtime boundary, the A3-2b1 implementation under review, and the
  pending A3-2b2/A3-2b3/A3-2b4/A3-2c gates, followed by the retained legacy
  Gate project API target.
- [`test-plan.md`](test-plan.md): current Stage 2 acceptance, published A3-1 and
  A3-2a evidence, A3-2b1 focused evidence, pending
  A3-2b2/A3-2b3/A3-2b4/A3-2c/A3-3 gates, and retained legacy Gate test history.
