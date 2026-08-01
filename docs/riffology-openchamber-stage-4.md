# Riffology OpenChamber Stage 4: local Browser Broker observation

- Status: implementation candidate
- Role: Stage 4 implementation and review contract
- Scope: local, read-only Chromium observation for the Riffology workbench
- Last reviewed: 2026-08-02

## Delivered boundary

Stage 4 adds `LocalBrowserBroker` as an authority independent from the legacy
Run visual frame proxy and `VisualAgentAuthority`. It owns ephemeral browser
lifecycle only. It cannot create or restore Model, Project, Experiment, Run,
output, receipt, or Conversation data.

One ephemeral Playwright context belongs to one exact `(Conversation id,
Conversation generation)` pair. Opening a newer generation revokes the older
generation's context. Page mutation uses the public page generation as a
compare-and-set fence.

The public `BrowserSessionDto` contains only:

- Conversation and page generations;
- a `riff-app://`, `riff-visual://`, or `riff-artifact://` URL projection;
- trust, observer mode, null action budget, navigation availability, expiry,
  and recovery state.

It contains no real target origin, host, port, CDP address, cookie, CSRF value,
capability token, profile path, or raw OpenCode session reference. Screenshots
are separate bounded observations and are not durable Riff evidence.

## Admission and network rules

The HTTP caller can supply only one of three enum aliases: `riff-app`,
`riff-visual`, or `riff-artifact`. The caller cannot submit a URL, hostname,
port, IP address, redirect target, path, cookie, profile, selector, or script.

Each usable alias must resolve to an opaque, process-local target record made
by the Broker registration factory; an arbitrary resolver object is rejected. A record is
valid only for an explicit `http://localhost:<declared-port>` origin. Default
startup declares `riff-app` as a tokenized, expiring, server-rendered read-only
observation document for the current Project Conversation. It contains no
script and never calls the SPA browser-session bootstrap. Visual and
artifact aliases remain unavailable until their owning server services declare
an exact target record; there is no URL fallback.

The browser context intercepts every request and fetches it without automatic
redirect following. A redirect is followed internally only when every hop
remains on the exact declared origin. Public internet, raw IPs, private
addresses, arbitrary loopback names, undeclared ports, credentials in URLs,
redirect escape, WebSockets, downloads, service workers, and popups fail
closed. Page-originated traffic is GET/HEAD only; every POST/PATCH operation,
including browser-session bootstrap, is blocked by the Broker before network
access.

The DTO projection is the fixed semantic URL stored in the server registration;
it is never derived from the internal target pathname. Consequently an
observation token or internal redirect path cannot appear in `projectedUrl`.
Token records expire with the Broker session and are also revoked on close,
Conversation-generation drift, and Backend shutdown.

This fixed server-target model removes caller-controlled DNS input. The only
hostname resolved by Chromium is the literal server-declared `localhost` on an
explicit port reserved by the local topology.

## HTTP surface

All routes remain behind the existing same-origin browser cookie and CSRF
admission boundary.

| Method and route | Purpose |
| --- | --- |
| `GET /api/conversations/{id}/browser` | Read the current generation's projected state. |
| `POST .../browser/open` | Open one declared alias. Body: `{ "alias": "riff-app" }`. |
| `POST .../browser/reload` | Reload with Conversation and page generation fences. |
| `POST .../browser/back` | Return to a prior server-declared alias target. |
| `GET .../browser/screenshot` | Read one bounded base64 PNG observation for exact generations. |
| `POST .../browser/close` | Close the ephemeral page/context. |
| `POST .../browser/restart` | Recreate the current page in a fresh context. |
| `POST .../browser/reconnect` | Recover after owned Chromium disconnect. |

Errors are explicit: `browser_alias_denied`, `browser_alias_unavailable`,
`browser_conversation_stale`, `browser_page_stale`, `browser_session_expired`,
`browser_session_disconnected`, and `browser_broker_unavailable`.

Operations for one Conversation serialize. Every HTTP handler rechecks the
durable Conversation generation after its awaited Broker operation and revokes
the old scope before returning `browser_conversation_stale`. Page generations
start from a cryptographically random process epoch and then increase
monotonically, so a DTO from an old Broker process cannot address a reconstructed
page. An explicit alias open renews an expired observation with a new TTL while
carrying the generation fence forward.

## Workbench projection

The global header now reads the real projected URL and trust state. Back and
reload call Broker lifecycle APIs; forward remains disabled because Stage 4
does not add arbitrary navigation. The central viewer displays the bounded
Chromium screenshot and the existing far-right file rail continues to replace
that same viewer when a file is selected.

No click, type, selector, DOM snapshot, JavaScript evaluation, Browser MCP,
Agent grant, control bar, or audit surface is added. Those are outside Stage 4
and require the separately reviewed Stage 5 authority model.

## Verification

Focused tests cover:

- real Playwright Chromium open, reload, back, screenshot, close, restart,
  disconnect/reconnect, and expiry;
- exact DTO field allowlisting and target-origin non-disclosure;
- generation isolation and stale page rejection;
- two-Conversation cookie, local-storage, and network isolation;
- operation serialization, expiry renewal, and Broker reconstruction fencing;
- unsafe target registration and bounded redirect matrices;
- caller URL rejection and redirect escape without an external request;
- authenticated HTTP admission, mid-operation generation drift, and default
  no-bootstrap observation without outer-session rotation;
- real header/viewer projection with no Stage 5 click/type surface.

The Stage 3 file renderer, visual authority, Product API, and full Web suites
remain regression gates.
