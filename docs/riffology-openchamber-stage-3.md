# Riffology OpenChamber Stage 3 implementation evidence

- Status: implementation candidate; not the default Product entry
- Role: Stage 3 implementation boundary and verification record
- Scope: global browser frame, one central viewer, far-right Project file tree, and OpenCode compatibility baseline
- Last reviewed: 2026-08-02
- Visual authority: [`prototypes/openchamber-browser-workbench.svg`](prototypes/openchamber-browser-workbench.svg)
- Parent contract: [`openchamber-browser-workbench-migration-plan.md`](openchamber-browser-workbench-migration-plan.md)

## Delivered boundary

The `/workbench` route now places browser navigation placeholders, the Riff URL
projection, trust state, Agent state, OpenCode version, and `文件 ↗` in the
single global header. The navigation controls remain explicitly disabled until
the Stage 4 Browser Broker owns real page history.

The center is one continuous file/page viewer. A resizable 224 px file tree is
docked at the far-right edge and can be collapsed. It is assembled only from
the Project workspace's opaque, read-only file references. Absolute paths,
parent traversal, backslashes, control characters, empty path segments, and
overlong paths are omitted rather than displayed. No disk enumeration or raw
object identifier is available to the browser.

On compact screens the file tree is a modal drawer with trapped focus, Escape
close, and focus restoration. Selecting a file closes the drawer, replaces the
Conversation pane with the central viewer, and provides an explicit return to
Conversation action.

## File rendering boundary

Markdown, JSON, CSV, text/code, unknown media, and size/structure limits retain
the existing fail-closed renderer contract. Stage 3 adds one narrow
`workbench-renderable` Project endpoint for HTML. The legacy Project file route
continues to return HTML as opaque active content.

Workbench HTML must pass the server's UTF-8, byte, line, active-element,
event-handler, URL-bearing attribute, and active-CSS checks. The client then
uses an originless iframe with an empty sandbox permission set, no referrer,
and an injected `default-src 'none'` Content Security Policy. HTML, DOM, and
screenshots remain projections and cannot create or restore Riff authority.

## OpenCode 1.18.11 compatibility baseline

On 2026-08-02 the official npm `latest` tags for `opencode-ai` and
`@opencode-ai/sdk`, `@opencode-ai/plugin`, and the installed CLI all reported
`1.18.11`. The project-local extension pack now pins plugin and transitive SDK
to that exact version. The active Riff launcher default, `.env.example`,
installed-server smoke gate, live browser gate, API documentation, and product
requirement use the same version.
Historical evidence that describes an earlier `1.18.4` run remains historical
and was not rewritten.

The version remains fail-closed: `/global/health` must report exactly
`1.18.11`, and the directory-scoped `/path` must match the canonical workspace
before Provider discovery or Conversation use.

The opt-in credentialed compatibility smoke also passed on 2026-08-02 with
`opencode-go/deepseek-v4-pro`: the live turn completed the two required scoped
MCP calls in exact order before idle reconciliation and revocation. An earlier
attempt with `opencode-go/deepseek-v4-flash` reached both tools but duplicated
the first call, so it failed the stricter exact-call gate. No fallback was used;
the passing `deepseek-v4-pro` run is the positive Provider evidence, while the
Flash result remains a disclosed model-compliance limitation.

## Verification

From the repository root and `web/`:

```text
bash scripts/check-opencode-1.18.11-runtime.sh
cd backend && npm test
cd web && npm test
cd web && npm run build
cd web && npm run test:e2e:riffology-stage2
cd web && npm run test:e2e:riffology-stage3
```

The Stage 3 browser gate covers 1800×1180 and 1440×900 layouts, a real CDP 200%
page-scale check, 390×844 drawer/viewer behavior, far-right placement,
collapse, keyboard resizing, focus restoration, relative-path projection, and
the absence of a nested browser chrome. Its 1800×1180 stable-region fixture was
reviewed side by side with the SVG authority; dynamic Conversation/runtime and
file-body areas are masked, while the global chrome, rail geometry, viewer
boundary, and file-tree placement have an automated maximum 1% pixel-difference
gate. A second browser scenario covers HTML, Markdown, JSON, CSV, unknown media,
active HTML refusal, and renderer-limit refusal. Admitted file DTOs and renderer
responses in that scenario are fixture-backed; the real endpoint isolation and
server renderer policy are covered by backend integration tests.

Tracked visual fixtures are test evidence, not Riff authority. Per-run
screenshots and traces remain disposable outputs.

Stage 3 does not add BrowserSessionDto, Playwright lifecycle endpoints, Browser
MCP, general network navigation, Agent page actions, or control leases. Those
remain Stages 4 and 5.
