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

1. `POST /api/browser-session/bootstrap` runs on the exact app origin. It
   rejects missing, `null`, or wrong app `Origin`, wrong app `Host:port`, and
   any `Sec-Fetch-Site` value other than `same-origin`.
2. Bootstrap sets a random app cookie that is host-only, HttpOnly,
   `SameSite=Strict`, has no `Domain`, and uses `Path=/api/`. It returns a
   separate in-memory CSRF token. The cookie may omit `Secure` on current HTTP
   and must set it under future HTTPS.
3. Each successful bootstrap rotates the browser-session generation and
   revokes every older frame/WebSocket capability before returning. Backend
   restart also rotates the capability.
4. `POST /api/projects/{projectId}/runs/{runId}/visual-frame-session` requires
   the exact app cookie, matching `X-Riff-CSRF`, exact app `Origin`, and
   `Sec-Fetch-Site: same-origin`. Agent/tool credentials cannot call either
   browser endpoint.
5. A successful frame-session response contains one `frameUrl` on the exact
   broker origin with a random single-use nonce. The in-memory registry binds
   it to browser-session generation, Project, run, attempt generation, expiry,
   and the capability's live socket set. Nonce expiry is no later than 60
   seconds after issue.
6. The initial nonce-bearing iframe navigation normally has no `Origin`. It is
   authorized only by exact broker `Host:port`, exact nonce path, atomic
   one-use consumption, live registry binding, and expiry. Replay, expiry,
   restart, or browser-generation rotation invalidates it.
7. Successful redemption redirects to a nonce-free broker path and sets a
   broker cookie with a random name independent of the app cookie. It is
   host-only, HttpOnly, `SameSite=Strict`, has no `Domain`, uses the exact
   broker path, and expires at `min(attempt expiry, 15 minutes)`. It follows the
   same current-HTTP/future-HTTPS `Secure` rule as the app cookie.
8. After redirect, broker HTTP requires the exact broker cookie and live
   binding. If an HTTP `Origin` is present it must equal the exact broker
   origin; navigation or subresources without `Origin` are allowed only with
   the cookie. The app never accepts the broker cookie, and the broker ignores
   all other cookies.
9. Every broker document emits CSP
   `frame-ancestors http://[::1]:<exact-app-port>` with no wildcard or alternate
   app origin, does not emit `X-Frame-Options: SAMEORIGIN`, and emits no
   permissive CORS header. The iframe omits top-navigation, popup,
   parent-origin, and unrestricted-download permissions.
10. Bootstrap and frame-session POST responses allow only the exact app origin
    with credentials and explicit headers and methods. They never emit a
    wildcard CORS origin.

## Consequences

- Cookie `Path` and port separation are defense in depth, not authorization;
  authorization remains the one-use capability, live binding, CSRF/Origin,
  exact Host/port/path, and expiry.
- `allow-same-origin` may be used only because the broker is a distinct origin;
  browser same-origin policy prevents parent DOM access.
- A3-2c does not reuse a user's `frameUrl`, nonce, app cookie, or broker cookie.

## Acceptance

- Counterexamples for every bootstrap and frame-session cookie, CSRF, Origin,
  Host, Fetch-Site, generation, Project, run, attempt, and expiry binding fail.
- Real-browser evidence proves atomic one-use nonce redemption within at most
  60 seconds, immediate invalidation on replay/rotation/restart/expiry, the
  nonce-free redirect, and actual `SameSite=Strict` broker-cookie delivery.
- Browser evidence proves JavaScript cannot read the HttpOnly cookies and
  cross-origin parent DOM access fails.
- Response evidence proves exact-app-only CSP `frame-ancestors`, no wildcard,
  no blocking `X-Frame-Options: SAMEORIGIN`, and no permissive CORS.
- Bootstrap and frame-session response tests prove exact-app-origin CORS with
  credentials and explicit headers and methods, and reject wildcard or other
  origins.
