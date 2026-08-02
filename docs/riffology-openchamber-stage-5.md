# Riffology OpenChamber Stage 5: scoped Browser Agent control

- Status: release candidate pending independent final review
- Role: Stage 5 implementation, security, and review contract
- Scope: local Browser MCP control, single-turn authority, and explicit human takeover
- OpenCode baseline: `1.18.11`
- Last reviewed: 2026-08-02

## Delivered architecture

Stage 5 adds `BrowserAgentAuthority` as an in-memory authority around the Stage
4 `LocalBrowserBroker`. It is separate from Riff domain authority,
`VisualAgentAuthority`, OpenCode permission state, and durable Conversation
state. Browser state, DOM projections, screenshots, Agent text, and OpenCode
terminal status cannot create, repair, or restore a Model, Project, Experiment,
Run, output, receipt, or other authoritative Riff record.

One Browser grant is bound to all of the following:

- the server-owned OpenCode workspace digest and owner;
- one Conversation id and durable Conversation generation;
- one turn id;
- one fixed server-declared Riff target alias;
- an exact set of Browser operations;
- a bounded action budget and expiry;
- private normalized-argument commitments for individual allow-once decisions.

At most one non-revoked turn grant may exist for one Conversation. Different
Conversations remain isolated and may execute in parallel. A prompt that merely
asks for browser work creates only a dormant grant; it does not activate
authority.

## Browser MCP surface

The scoped MCP exposes exactly ten tools when Browser intent and the current
owner scope permit them:

| Tool | Bounded operation |
| --- | --- |
| `browser_open` | Open one of `riff-app`, `riff-visual`, or `riff-artifact`. |
| `browser_snapshot` | Return a bounded interactive projection with opaque element references. |
| `browser_screenshot` | Return a PNG as MCP text metadata plus image content, limited to 4 MiB. |
| `browser_click` | Click one current opaque element reference. |
| `browser_type` | Replace text in one editable opaque reference, limited to 4096 UTF-8 bytes. |
| `browser_scroll` | Apply one bounded vertical delta from -2000 to 2000. |
| `browser_wait` | Wait for 50 to 2000 milliseconds. |
| `browser_back` | Return to the prior server-declared Riff target. |
| `browser_reload` | Reload the current declared target. |
| `browser_close` | Close the ephemeral page and revoke Browser authority. |

No Browser tool accepts a URL, hostname, port, IP address, filesystem path,
selector, JavaScript, cookie, upload, download, browser profile, CDP address,
or capability token. Snapshots use a fixed backend selector and return only
bounded role, name, disabled, and editable fields. Opaque references bind both
page and DOM generations; navigation or DOM replacement makes old references
stale.

`browser_screenshot` validates an exact four-field backend result, PNG magic,
base64 shape, page generation, content type, and the 4 MiB decoded-byte limit.
The base64 body is emitted only as MCP image content and is not placed in its
text metadata.

## Permission activation and revocation

OpenCode `1.18.11` treats a dynamically enabled prompt tool as an exact allow,
so its native `/permission` queue cannot be the authority for Browser MCP calls.
Riffology therefore owns the Browser pending gate. The real MCP `tools/call`
registers one opaque pending interaction and remains suspended. Conversation
runtime projects only the tool, safe target summary, budget, and expiry. The
server privately retains the exact normalized-argument digest. `allow_once`
rechecks workspace, owner, Conversation generation, turn, TTL, and the pending
identity before waking the original MCP call. Reject, Stop, takeover, expiry,
or scope drift revokes the whole turn and rejects the suspended call.
If an operator configuration unexpectedly causes OpenCode to emit a native
Browser permission, Riffology rejects it upstream and revokes the turn; that
path cannot create or bypass Browser authority.

Repeated calls with the same arguments never inherit a prior approval: each
completed call requires a new pending card and a new one-shot approval. Identical
concurrent calls share one pending card, but at most one can consume its approval.
After approval, the grant consumes its operation commitment and budget before
the first Playwright await, so concurrent calls cannot overspend. Failed actions
also consume budget. The public `BrowserSessionDto` may project only
Conversation/page generations, semantic URL, trust state, control mode,
remaining budget, recovery state, navigation flags, and expiry. It never
contains a grant, digest, raw OpenCode session id, internal target, cookie, or
control epoch.

Authority is permanently revoked on turn completion, stop/cancel, rejection,
budget exhaustion, TTL expiry, browser close, human takeover, Broker/service
restart, Chromium disconnect, missing session, or stale/lost control epoch.
Reconnect never reactivates an old grant: a new turn and a new allow-once
decision are required.

## Control competition and human takeover

The Broker owns a private control epoch. Every Agent action validates it before
and after each awaited Playwright operation. Revocation and takeover invalidate
the epoch synchronously, clear references and budget, and begin closing the
owned context before joining the per-Conversation operation queue. Therefore an
in-flight old action cannot report success after control was withdrawn.

Takeover first removes all private grants for the Conversation. The Broker may
publish `human` only after it safely rebuilds the same server-declared target in
a fresh context; a failed rebuild remains unavailable and is never labelled
human-ready. Return changes `human` to `observer` under a new epoch. It does not
restore the prior Agent grant. Only a later explicit authorization can establish
new Agent control.

During Agent control, public `open`, `reload`, `back`, `restart`, `reconnect`,
and direct close mutations fail at the Broker boundary, not merely in the UI.
Authenticated state and screenshot reads remain observational. The authenticated
HTTP control routes are:

| Method and route | Contract |
| --- | --- |
| `POST /api/conversations/{id}/browser/takeover` | Exact Conversation and page generation CAS; revoke Agent authority and request human control. |
| `POST /api/conversations/{id}/browser/return` | Exact generation CAS; return human control to observer only. |

Close revokes Browser authority before closing the session. Every route retains
the existing same-origin cookie/CSRF boundary and revalidates the durable
Conversation generation after its awaited operation.

The global-header `Agent` menu is the only control surface. It can stop an exact
currently stoppable request key, request human takeover, or return to observer.
There is no control, audit, action-tracking, or authority-explanation bar.
Browser state is polled with a bounded interval; an explicit control operation
advances a client request epoch so an older poll cannot overwrite newer state.

## Default Riff observation targets

The default `riff-app` alias supports both Model and Project Conversations.
Each expiring observation token binds the exact owner kind/id, Conversation,
and Conversation generation. Every token resolution rechecks the durable
Conversation owner, owner existence, and generation. A Model token cannot be
reused for a Project with the same textual id, or conversely.

Semantic projections are:

- `riff-app://models/{model-id}?conversation={conversation-id}`;
- `riff-app://projects/{project-id}?conversation={conversation-id}`.

The internal tokenized page uses generic “Owner workspace” wording and exposes
neither its token nor its local origin through the DTO.

## Verification

Focused Backend verification:

```sh
cd backend
node --experimental-strip-types --test --test-concurrency=1 \
  test/agent-mcp-permissions.test.ts \
  test/browser-agent-authority.test.ts \
  test/local-browser-broker.test.ts \
  test/opencode-conversation-runtime.test.ts \
  test/agent-turn-runtime.test.ts \
  test/workbench-browser-api.test.ts
```

Focused Web and build verification:

```sh
cd web
npx vitest run src/product/api.test.ts src/App.test.tsx
npm run build
```

Opt-in real-provider Browser MCP integration smoke:

```sh
cd backend
RUN_OPENCODE_BROWSER_AGENT_SMOKE=true \
OPENCODE_BROWSER_AGENT_SMOKE_MODEL='provider/model' \
node --experimental-strip-types --test \
  test/opencode-browser-agent-smoke.test.ts
```

The opt-in smoke starts the installed OpenCode `1.18.11` pure server, binds an
actual scoped MCP HTTP endpoint through `HttpOpenCodeAdapter`, and drives a real
Playwright Chromium page through open, snapshot, opaque-ref type, snapshot,
wait, and screenshot. It verifies exact call order, page change, PNG content,
budget, final revocation, and the absence of any Riff mutation tool. The test
observes each server-owned pending interaction, approves it through the exact
workspace/generation/turn scope, and verifies that the original MCP call only
then reaches Chromium. A separate Conversation service test verifies the same
permission card and resume route without calling OpenCode's permission reply.

The automated coverage includes private commitment matching, allow-once
activation, Model/Project tool exposure, real Chromium click/type/scroll/wait,
screenshot image content, navigation/DOM stale references, failed-action budget
consumption, same-Conversation controller conflict, cross-Conversation
parallelism, takeover of in-flight work, old-grant non-revival, disconnect,
HTTP CAS/admission, Model/Project default targets, polling races, and accessible
header controls.

## Exit evidence

On 2026-08-02 the installed OpenCode `1.18.11` and authenticated
`opencode-go/deepseek-v4-pro` completed the opt-in Browser smoke with no fallback:
six server-owned one-shot approvals preceded six real MCP calls in the required
order, Chromium reflected the typed state, screenshot returned a PNG, the action
budget reached two, final revocation returned the Broker to observer, and no
Riff mutation tool ran. The ordinary backend suite separately covers rejection,
stale references, budget, Stop, takeover, disconnect, restart, and scope drift.
Stage 5 still requires an independent reviewer to confirm this final revision
before merge.
