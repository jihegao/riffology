# Design and delivery records

Each implementation stage is gated by the architecture and contracts in this
directory. Gate 0 is a design baseline: it approves the target but is not proof
that Gates 1-4 are implemented. Technical owners must document public
interfaces, test expectations, and assumptions before implementation.

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
