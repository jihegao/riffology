# ADR 0003: WebSocket forwarding, revocation, and secrecy

- Status: Implemented and Chromium-verified — A3-2b3/A3-2b4
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

- Forwarding is denied unless the run-frozen `webSocket` object exists. The
  browser URL is exactly
  `ws://localhost:<broker-port>/frame/c/<route-id><declared-absolute-path>`.
  The route ID comes only from the redeemed frame capability. Query,
  fragment, percent-equivalent path spelling, repeated slash, traversal, a
  root-absolute broker path, and every other suffix are denied without dialing
  the child.
- `subprotocols` contains zero to eight unique tokens. Every client-offered
  token must be unique and declared. An empty declaration permits only an
  upgrade with no `Sec-WebSocket-Protocol`; a non-empty offer may contain an
  ordered subset of declared tokens. The child's selected token must be both
  offered and declared, and the broker returns that exact token. No extension,
  including `permessage-deflate`, is negotiated on either leg.
- Frozen values satisfy these server ceilings:

  - `maxFrameBytes`: 1 through 1,048,576 bytes;
  - `maxConnections`: 1 through 8 concurrent connections for the attempt;
  - `idleTimeoutMs`: 1,000 through 300,000 milliseconds.

- Upgrade requires the exact broker `Host`, exact broker `Origin`, declared
  path/subprotocol, exact broker cookie, and live registry binding. Missing,
  `null`, duplicate, app, child, and all other origins are rejected before a
  child TCP connection. Duplicate security-sensitive headers are rejected.
- `maxConnections` is counted per exact run attempt across all minted routes,
  and includes pending child handshakes. The child handshake has a 5,000
  millisecond deadline. Reservation occurs before asynchronous inspection or
  child dial and is released on every failure and close path.
- `maxFrameBytes` is the maximum assembled text or binary message in either
  direction. Each fragment and the aggregate fragmented message are bounded;
  control frames may be interleaved but do not reset fragmentation state.
  Each direction may queue at most 16 messages and at most another
  `maxFrameBytes` of payload for a backpressured destination. The source is
  paused while bounded queued bytes drain; accepting the next message above
  either ceiling closes both legs with `1013`.
- Valid text, binary, close, ping, and pong behavior follows RFC 6455. Ping/pong
  is terminated on each proxy leg rather than blindly forwarded. Valid data or
  control activity resets the idle deadline.
- Close codes are frozen: malformed framing/masking/RSV/opcode/continuation or
  control-frame structure uses `1002`; invalid assembled UTF-8 uses `1007`;
  assembled-message overflow uses `1009`; queued-byte/backpressure overflow
  uses `1013`; idle timeout and absolute capability expiry use `1001`;
  generation/lifecycle revocation and other application policy loss use
  `1008`; an unexpected bounded upstream failure after upgrade uses `1011`.
- The child leg is fixed to
  `ws://127.0.0.1:<recorded-port><declared-path>`. It follows no redirect and
  forwards no cookie, authorization, raw browser Origin, capability route,
  nonce, compression extension, arbitrary header, query, or alternate path.
  Its fixed child handshake instead carries a server-generated exact broker
  Origin.
- The registry binds browser-session generation, Project, run, attempt
  generation, expiry, and the live socket set. Stop, unhealthy state, terminal
  reconciliation, backend restart, expiry, redemption replay, or browser-
  session generation change revokes access.
- Revocation is an idempotent `revokeVisualAccess(runId)` lifecycle hook.
  Cancellation, unhealthy observation, visual success/failure/timeout commit,
  recovery, and dispatcher stop invoke it before their state commit or process
  abort. It starts closure of every pending/registered socket before deleting
  registry authority. Repeated calls remain effective for a later attempt of
  the same run ID; the dispatcher does not permanently memoize a revoked run
  ID. A fresh bootstrap and frame-session request is required afterward.
  Stored child ports never restore access after restart.
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
- Stable pre-upgrade results are:

  | HTTP | Code | Meaning |
  | --- | --- | --- |
  | `400` | `broker_request_failed` | The HTTP parser rejected a malformed request before WebSocket admission. |
  | `400` | `visual_websocket_protocol_denied` | HTTP parsed successfully, but the Upgrade, Connection, version, key, or duplicate-sensitive WebSocket handshake structure is malformed. |
  | `405` | `visual_websocket_protocol_denied` | A syntactically valid upgrade attempt did not use `GET`. |
  | `404` | `visual_websocket_not_declared` | The exact frozen attempt has no WebSocket declaration or the minted suffix is not its exact path. |
  | `403` | `visual_frame_session_denied` | Broker session, cookie, Origin, authorization, or capability authority is absent or invalid. |
  | `403` | `visual_websocket_protocol_denied` | Offered subprotocols or another declared WebSocket policy field is denied. |
  | `429` | `visual_websocket_limit` | The attempt connection/pending-handshake limit is full. |
  | `502` | `visual_websocket_upstream_failed` | The fixed child handshake is not an exact bounded `101` with an allowed selection. |
  | `504` | `visual_websocket_timeout` | Exact inspection or the child handshake exceeded its bounded deadline. |

  Existing exact topology and broker-session failures retain
  `broker_host_denied` (`421`) and `visual_frame_session_denied` (`403`);
  WebSocket handling does not remap them.

## Acceptance

- Tests reject an absent WebSocket declaration, wrong or arbitrary path,
  query/encoded aliases, wrong or duplicate origin, undeclared/duplicate/excess
  subprotocols, pending-handshake races, cross-route connection-limit bypass,
  and every value outside the frozen frame/connection/idle bounds.
- Real-process evidence proves exact path/subprotocol forwarding, inbound and
  outbound text/binary and fragmented-message accounting, interleaved control
  frames, backpressure pause/resume and queued-byte ceiling, close codes
  `1001`, `1002`, `1007`, `1008`, `1009`, `1011`, and `1013`, connection
  `maxConnections + 1` denial, idle expiry, and redirect denial.
- Stop, unhealthy state, terminal reconciliation, restart, expiry, replay, and
  generation rotation each close live sockets before removing capability
  state.
- Three-party secret scans use known sentinel values and their hashes. They
  prove that child headers, logs, SQLite, errors, completion/card/context DTOs,
  and unrelated API responses contain no app cookie, broker cookie, nonce
  (including expired values), route capability, or `frameUrl`. The authorized
  bootstrap/frame-session/redeem request and response fields that necessarily
  carry their own transient secret are explicit scan allowlist entries, not a
  false global-absence claim. Child ports are absent from public/log/error
  surfaces and remain allowed only in schema-defined private process, launch,
  and health recovery evidence.
  The scan covers observable responses, configured log sinks, persisted bytes,
  and public projections; it makes no claim about arbitrary process heap bytes.

## Browser closeout boundary

A3-2b3 uses component tests, raw RFC 6455 TCP peers, and real local child and
broker sockets. A3-2b4 exclusively owns the real-browser matrix: browser cookie
jar and SameSite behavior across ports, HttpOnly script denial, browser-
generated WebSocket Origin and cookie delivery, iframe-relative
`new WebSocket`, parent-DOM/CSP/sandbox and hostile embedder isolation, and a
page-observed close/reconnect denial after live revocation. Raw fragmentation,
control-frame, backpressure, connection-limit, port-reuse, restart, and secret
scan evidence is required in b3 and is not deferred to b4.
