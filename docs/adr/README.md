# Architecture decision records

- Status: active
- Role: normative contract
- Scope: browser isolation, forwarding, Product admission, and deletion decisions
- Source of truth: PRD, active stage designs, backend API contract, and implementation
- Last reviewed: 2026-07-25

This directory extracts stable architecture decisions from the active A3 design
so that A3-2b implementation and review can use a small, explicit gate.

These records are **Proposed — A3-2b implementation gate**. They describe the
contract that an A3-2b implementation must satisfy; they do not claim that the
broker, frame, or WebSocket behavior is implemented. They are derived review
checklists; the active A3 design and API documents remain the source of truth.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-isolated-browser-network-topology.md) | Isolate the app/broker origins from the visual child | Proposed — A3-2b implementation gate |
| [0002](0002-browser-frame-capability.md) | Bootstrap and redeem a browser-scoped frame capability | Proposed — A3-2b implementation gate |
| [0003](0003-websocket-forwarding-and-revocation.md) | Enforce frozen WebSocket limits, revocation, and secrecy | Proposed — A3-2b implementation gate |
| [0004](0004-product-browser-admission-and-deletion.md) | Use one Product browser boundary and fenced preview/confirm permanent deletion | Accepted — A4-1 |

## Source contract

- [`../architecture.md`](../architecture.md), especially the A3-2b topology and
  capability summary
- [`../backend-api.md`](../backend-api.md), especially the A3-2b browser access
  contract
- [`../milestone-a3-project-execution-design.md`](../milestone-a3-project-execution-design.md),
  especially execution-description v2 WebSocket bounds and “Visual execution
  and scoped WebSocket access”

Changing a decision recorded here requires updating the corresponding source
contract in the same review.
