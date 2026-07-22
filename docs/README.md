# Design and delivery records

Each implementation stage is gated by the architecture and contracts in this
directory. Gate 0 is a design baseline: it approves the target but is not proof
that Gates 1-4 are implemented. Technical owners must document public
interfaces, test expectations, and assumptions before implementation.

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
  checks. Implementation is in progress on #13; Stage 3/4 behavior remains
  explicitly out of scope.
- [`wind-turbine-maintenance-gate-0.md`](wind-turbine-maintenance-gate-0.md):
  authoritative Gate 0 source mapping, scope, claims, workflow policy, and exit
  contract.
- [`architecture.md`](architecture.md): target system boundaries, revision
  identities, storage ownership, and current/target distinction.
- [`product-roadmap.md`](product-roadmap.md): evolution from the bounded MVP to open model creation,
  sandboxed draft execution, progressive validation, and governed publication.
- [`ui-workflow.md`](ui-workflow.md): target browser-visible workflow and acceptance checks.
- [`mesa-service.md`](mesa-service.md): target Mesa model, event, revision, and artifact contract.
- [`opencode-bridge.md`](opencode-bridge.md): target OpenCode proposal and domain-action boundary.
- [`backend-api.md`](backend-api.md): target durable project, issue, attestation, experiment, and run API.
- [`test-plan.md`](test-plan.md): Gate 1-4 unit, contract, integration, browser, and review requirements.
