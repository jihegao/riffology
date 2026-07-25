# ADR 0003: WebSocket forwarding, revocation, and secrecy

- Status: Proposed — A3-2b implementation gate
- Role: active design
- Scope: A3-2b broker WebSocket admission, forwarding limits, lifecycle,
  revocation, and secret handling
- Source of truth: active A3 design and backend API contract
- Last reviewed: 2026-07-25

Derived from
[`../milestone-a3-project-execution-design.md`](../milestone-a3-project-execution-design.md),
“Execution-description v2 protocol” and “Visual execution and scoped WebSocket
access”; and [`../backend-api.md`](../backend-api.md), “A3-2 visual API/runtime
gates”.

## Context

WebSocket access is permitted only when execution-description v2 freezes an
explicit WebSocket contract for the exact healthy visual attempt. Browser
access must not create ambient access to arbitrary child paths, protocols, or
credentials, and stale capabilities must not survive lifecycle changes.

## Decision

- Forwarding is denied unless the frozen `webSocket` object exists. Its path is
  one exact absolute same-origin path.
- `subprotocols` contains zero to eight unique tokens. A client offering an
  undeclared protocol is rejected; an empty list permits only a connection
  without a subprotocol.
- Frozen values satisfy these server ceilings:

  - `maxFrameBytes`: 1 through 1,048,576 bytes;
  - `maxConnections`: 1 through 8 concurrent connections for the attempt;
  - `idleTimeoutMs`: 1,000 through 300,000 milliseconds.

- Upgrade requires the exact broker `Origin`, declared path/subprotocol, exact
  broker cookie, and live registry binding. Missing, `null`, app, child, and all
  other origins are rejected.
- The proxy counts inbound and outbound frames, closes an oversized frame with
  code `1009`, closes policy violations with `1008`, rejects connection
  `maxConnections + 1`, and expires idle connections.
- The proxy never forwards cookies, authorization headers, compression
  extensions, arbitrary paths, or cross-origin redirects.
- The registry binds browser-session generation, Project, run, attempt
  generation, expiry, and the live socket set. Stop, unhealthy state, terminal
  reconciliation, backend restart, expiry, redemption replay, or browser-
  session generation change revokes access.
- Revocation closes every registered socket before deleting the registry entry.
  A fresh bootstrap and frame-session request is required afterward. Stored
  child ports never restore access after restart.
- Raw or hashed frame nonces, `frameUrl`, cookies, and capability secrets are
  not stored in SQLite, Agent/context DTOs, conversation messages, analytics,
  access logs, completion cards, or error text. Only bounded issued/redeemed/
  revoked audit facts without secrets may be retained.
- App, broker, and child request/response headers and logs are scanned for every
  cookie, nonce (including expired nonce values), capability, URL, and
  child-port secret. Public DTOs contain none of those values. SQLite contains
  no nonce, cookie, frame URL, or browser capability; child ports are allowed
  only in the schema-defined private process-attempt, launch, and health
  evidence already required for exact recovery.

## Consequences

- A declared WebSocket surface does not authorize any other path, protocol,
  origin, connection count, frame size, or idle duration.
- Capability lifetime is bounded by both browser-session generation and the
  exact Project/run/attempt lifecycle.
- Socket-first revocation prevents registry deletion from leaving a live
  connection detached from its capability.
- Stable admission/proxy errors are
  `visual_websocket_not_declared`,
  `visual_websocket_protocol_denied`, and
  `visual_websocket_limit`.

## Acceptance

- Tests reject an absent WebSocket declaration, wrong or arbitrary path, wrong
  origin, undeclared/duplicate/excess subprotocols, and every value outside the
  frozen frame/connection/idle bounds.
- Real-process evidence proves exact path/subprotocol forwarding, inbound and
  outbound frame counting, close codes `1009` and `1008`, connection
  `maxConnections + 1` denial, idle expiry, and redirect denial.
- Stop, unhealthy state, terminal reconciliation, restart, expiry, replay, and
  generation rotation each close live sockets before removing capability
  state.
- Three-party secret scans prove that headers, logs, and DTOs contain no cookie,
  nonce (including expired values), capability, `frameUrl`, or child-port
  secret. SQLite contains none of the browser secrets and contains child ports
  only in the allowlisted private recovery evidence.
