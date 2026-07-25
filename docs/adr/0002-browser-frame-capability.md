# ADR 0002: Browser frame capability

- Status: Proposed — A3-2b implementation gate
- Role: active design
- Scope: A3-2b browser bootstrap, frame session, nonce redemption, cookies,
  and iframe policy
- Source of truth: active A3 design and backend API contract
- Last reviewed: 2026-07-25

Derived from [`../architecture.md`](../architecture.md), “Milestone A2
authority and A3 execution architecture”; [`../backend-api.md`](../backend-api.md),
“A3-2 visual API/runtime gates”; and
[`../milestone-a3-project-execution-design.md`](../milestone-a3-project-execution-design.md),
“Visual execution and scoped WebSocket access”.

## Context

A local browser needs narrowly scoped access to one current healthy visual
attempt. This is a single-local-user browser capability, not login, identity,
multi-user authorization, Agent/tool authorization, or reuse of a legacy
default-session mechanism.

## Decision

1. `POST /api/browser-session/bootstrap` runs on the exact app origin and
   returns HTTP `201`. It
   rejects missing, `null`, or wrong app `Origin`, wrong app `Host:port`, and
   any `Sec-Fetch-Site` value other than `same-origin`. The server-side browser
   session expires 15 minutes after issue.
2. Bootstrap sets a random app cookie that is host-only, HttpOnly,
   `SameSite=Strict`, has no `Domain`, and uses `Path=/api/`. It returns a
   separate in-memory CSRF token. The cookie may omit `Secure` on current HTTP
   and must set it under future HTTPS. Its `Max-Age` and `Expires` both encode
   the same 15-minute session lifetime.
3. Each successful bootstrap rotates the browser-session generation and
   revokes every older frame/WebSocket capability before returning. Backend
   restart also rotates the capability.
4. `POST /api/projects/{projectId}/runs/{runId}/visual-frame-session` returns
   HTTP `201` and requires
   the exact app cookie, matching `X-Riff-CSRF`, exact app `Origin`, and
   `Sec-Fetch-Site: same-origin`. Agent/tool credentials cannot call either
   browser endpoint.
5. A successful frame-session response contains one `frameUrl` on the exact
   broker origin with a random single-use nonce. The in-memory registry binds
   it to browser-session generation, Project, run, attempt generation, expiry,
   and the capability's live socket set. Nonce expiry is no later than 60
   seconds after issue and never later than the attempt expiry.
6. The initial nonce-bearing iframe navigation normally has no `Origin`. It is
   authorized only by exact broker `Host:port`, exact nonce path, atomic
   one-use consumption, live registry binding, and expiry. Replay, expiry,
   restart, or browser-generation rotation invalidates it.
7. Successful redemption returns HTTP `303` with a relative `Location` for the
   nonce-free broker path and sets a
   broker cookie with a random name independent of the app cookie. It is
   host-only, HttpOnly, `SameSite=Strict`, has no `Domain`, uses the exact
   broker path, and expires at
   `min(attempt claimedAt + frozen wallTimeMs, issue time + 15 minutes)`. It
   follows the same current-HTTP/future-HTTPS `Secure` rule as the app cookie.
8. After redirect, broker HTTP requires the exact broker cookie and live
   binding. If an HTTP `Origin` is present it must equal the exact broker
   origin; navigation or subresources without `Origin` are allowed only with
   the cookie. The app never accepts the broker cookie, and the broker ignores
   all other cookies.
9. `riff-visual-v1` does not add an execution-description field for frame HTTP.
   The frame HTTP surface is server-owned: below the nonce-free minted
   capability base, the broker forwards only `GET` and `HEAD` with a normalized
   same-origin suffix. Query strings are allowed, but the complete normalized
   path plus query is at most 4,096 bytes. Frame HTTP has no request body.
   Visual applications must be capability-base compatible: document, CSS,
   script, and fetch references use relative URLs beneath that base. Root-
   absolute application routes are deliberately not rewritten or authorized.
10. The child request forwards only `Accept`, `Accept-Language`,
    `If-None-Match`, `If-Modified-Since`, and `Range`. The broker sets the exact
    child `Host` and forces `Accept-Encoding: identity`; it forwards no cookie,
    authorization, proxy authorization, capability, nonce, CORS, or hop-by-hop
    header. The child response exposes only `Content-Type`, `Content-Length`,
    `Content-Range`, `Accept-Ranges`, `ETag`, `Last-Modified`, and
    `Cache-Control`. It removes `Set-Cookie`, `Location`, `Refresh`,
    authentication challenge, CORS, and hop-by-hop headers.
    The broker never trusts child caching policy: it replaces `Cache-Control`
    with `private, no-store` so generation rotation and revocation cannot be
    bypassed by a fresh cached capability response.
11. The broker never follows redirects. Every child `3xx` is rejected. Request
    and response headers are each bounded to 32,768 bytes, the response body is
    bounded to 8 MiB, the complete child exchange has a 5,000 millisecond
    deadline, and each capability admits at most eight concurrent frame HTTP
    requests. Store generation/lease/process-heartbeat evidence and exact OS
    listener ownership are revalidated before and after every child exchange.
    OS reads are asynchronous, serialized, and admitted through a bounded
    global inspection queue so frame traffic cannot synchronously block the app
    event loop. Each queued inspection has a 5,000 millisecond overall deadline
    and fails closed before child transport if it cannot complete.
12. Every broker document replaces child framing policy with exactly:

    ```text
    Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors http://[::1]:<exact-app-port>
    ```

    It emits no `X-Frame-Options`, wildcard or alternate ancestor, or
    permissive CORS header. The iframe omits top-navigation, popup,
    parent-origin, and unrestricted-download permissions.
13. Bootstrap and frame-session support only `POST` plus CORS preflight
    `OPTIONS`. Responses allow only the exact app origin with credentials,
    `POST, OPTIONS`, and request headers `Content-Type, X-Riff-CSRF`; they never
    emit a wildcard CORS origin. The Vite development origin is not the app
    origin and is rejected.
14. `Origin` and `Sec-Fetch-Site` checks mitigate browser CSRF. They do not
    establish the identity of an arbitrary local native client and are not
    presented as local-client authentication.
15. Stable A3-2b2 admission and forwarding results are:

    | HTTP | Code | Meaning |
    | --- | --- | --- |
    | `405` | `browser_method_denied` | Bootstrap or frame-session received an unsupported method. |
    | `403` | `browser_session_denied` | Bootstrap Host, Origin, Fetch-Site, CORS, session, or CSRF admission failed. |
    | `409` | `visual_frame_unavailable` | The exact current healthy visual run/attempt cannot mint a frame capability. |
    | `404` | `visual_frame_nonce_invalid` | A nonce route is unknown, consumed, expired, rotated, or invalid after restart. |
    | `403` | `visual_frame_session_denied` | The broker cookie, live binding, or broker Origin admission failed. |
    | `404` or `405` | `visual_frame_proxy_denied` | The minted base, normalized suffix, query, or method is outside the frame HTTP surface. |
    | `502` | `visual_frame_proxy_redirect_denied` | The child returned a redirect. |
    | `502` | `visual_frame_proxy_limit_exceeded` | Header, body, or concurrency bounds were exceeded. |
    | `504` | `visual_frame_proxy_timeout` | The 5,000 millisecond child deadline expired. |
    | `502` | `visual_frame_proxy_failed` | The bounded child exchange otherwise failed. |

## Consequences

- Cookie `Path` and port separation are defense in depth, not authorization;
  authorization remains the one-use capability, live binding, CSRF/Origin,
  exact Host/port/path, and expiry.
- The broker never serializes its private child target into platform DTOs,
  routes, headers, errors, or broker-generated content. Model-authored child
  response bytes are application data, not a child-port confidentiality
  boundary: the child already knows its own listener. A3-2b treats active frame
  HTML/JavaScript as operator-provided, trusted browser code; this is a local
  deployment trust assumption, not a runtime code-review assertion. The server
  process remains sandboxed and receives no platform or browser credential. Arbitrary
  adversarial active payload is not supported by this frame surface. Supporting
  it later requires a trusted data-only wrapper or a transport the browser
  cannot address directly; CSP, iframe sandbox, and literal response scanning
  do not make self-navigation safe.
- `allow-same-origin` may be used only because the broker is a distinct origin;
  browser same-origin policy prevents parent DOM access.
- A3-2c does not reuse a user's `frameUrl`, nonce, app cookie, or broker cookie.
- The exact app-origin host page and real-browser proof remain A3-2b4 work.

## Acceptance

- Counterexamples for every bootstrap and frame-session cookie, CSRF, Origin,
  Host, Fetch-Site, generation, Project, run, attempt, and expiry binding fail.
- Real-browser evidence proves atomic one-use nonce redemption within at most
  60 seconds, immediate invalidation on replay/rotation/restart/expiry, the
  nonce-free redirect, and actual `SameSite=Strict` broker-cookie delivery.
- Browser evidence proves JavaScript cannot read the HttpOnly cookies and
  cross-origin parent DOM access fails.
- Response evidence proves the complete exact-app-only CSP, no wildcard, no
  `X-Frame-Options`, and no permissive CORS.
- Bootstrap and frame-session response tests prove exact-app-origin CORS with
  credentials and explicit headers and methods, and reject wildcard or other
  origins.
- HTTP integration tests cover suffix normalization, method and query bounds,
  request/response header filtering, redirect denial, byte/deadline/concurrency
  limits, and the exact stable errors. Real-browser acceptance remains A3-2b4.
