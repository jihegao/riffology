# ADR 0001: Isolated browser network topology

- Status: Proposed — A3-2b implementation gate
- Role: active design
- Scope: A3-2b platform app, visual broker, and visual child endpoints
- Source of truth: active A3 design and backend API contract
- Last reviewed: 2026-07-25

Derived from [`../architecture.md`](../architecture.md), “Milestone A2
authority and A3 execution architecture”; [`../backend-api.md`](../backend-api.md),
“A3-2 visual API/runtime gates”; and
[`../milestone-a3-project-execution-design.md`](../milestone-a3-project-execution-design.md),
“Visual execution and scoped WebSocket access”.

## Context

The platform must embed a healthy visual attempt without exposing its assigned
child port or sending platform cookies to the untrusted visual child. At the
same time, the app and broker need distinct origins for browser DOM isolation
while remaining same-site so a `SameSite=Strict` broker cookie can be sent in
the iframe.

## Decision

- The platform app and visual broker exact-bind IPv6 loopback `::1` on different
  server-owned ports and expose `http://[::1]:<app-port>` and
  `http://[::1]:<broker-port>`.
- Both reject every other listener address and every incorrect configured
  `Host:port`. The broker additionally requires the exact server-minted route
  path.
- The untrusted visual child remains on its assigned
  `127.0.0.1:<child-port>`. Its sandbox denies every IPv6/`::1` bind, every
  other listener, and outbound/direct network access.
- The broker route is scoped to
  `{projectId, runId, attemptGeneration}`. The browser does not receive the
  child port; public DTOs, messages, and ordinary logs do not expose it.
- The broker proxies only the exact healthy attempt and bounded declared HTTP
  and WebSocket surfaces. It rejects arbitrary URLs and strips credentials and
  `Set-Cookie` headers.

## Consequences

- The different app and broker ports create different origins and therefore
  same-origin-policy DOM isolation.
- App and broker remain same-site on host `::1`; their cookies can cross ports,
  so port separation and Cookie `Path` are not authorization boundaries.
- The effective host boundary is between platform cookies on `::1` and the
  child on `127.0.0.1`: platform cookies are never sent to the child.
- The child port and health evidence remain backend-only and cannot restore
  browser access after restart.

## Acceptance

- A real browser proves that the app and broker exact-bind `::1` on distinct
  server-owned ports while the child remains on `127.0.0.1`.
- Wrong listener addresses, `Host:port` values, broker paths, arbitrary URLs,
  and cross-origin redirects fail closed.
- Browser evidence proves the app and broker are different origins, the broker
  cookie is delivered in the iframe, cross-origin parent DOM access fails, and
  platform cookies never reach the child.
- DTO, SQLite, header, and log scans prove that no child-port secret is exposed.
