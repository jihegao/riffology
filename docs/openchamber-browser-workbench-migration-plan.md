# Riffology OpenChamber workbench migration plan

- Status: active
- Role: normative staged implementation contract
- Scope: seven local-only PR stages for a Riffology-branded, OpenChamber-derived conversation shell with one controlled browser/file viewer
- Source of truth: [`product-requirements.md`](product-requirements.md) for product behavior; merged code, tests, and Riff receipts for implementation state
- Last reviewed: 2026-08-01

## 1. Outcome and current status

Riffology is the public product name. OpenChamber is a pinned internal upstream
and OpenCode supplies the Agent session runtime. Riff remains the durable domain
authority for Model, Project, Experiment, Run, output, receipt, and owner-binding
facts.

The editable visual authority is
[`prototypes/openchamber-browser-workbench.svg`](prototypes/openchamber-browser-workbench.svg),
with a fixed
[`PNG review fixture`](prototypes/openchamber-browser-workbench.png). Stage 1
freezes that baseline and the implementation contracts; it does not claim that
the new shell, Browser Broker, Browser MCP, or Agent-oriented Riff flows already
exist. Each later capability exists only after its independent PR is merged and
its exit gate passes.

This implementation cycle is local only. It does not include `aliyun_99`,
Cloudflare, public hosting, general web browsing, uploads, downloads, or
external login. Those require a separately approved deployment plan.

## 2. Fixed product constraints

- Display **Riffology**, never OpenChamber, as the product brand.
- Put browser navigation, URL, trust state, Agent state, OpenCode version, and
  the file toggle in the global header; do not add a second browser chrome.
- Let the central browser/file viewer extend from the header to the bottom.
- Dock the collapsible file tree at the far right, beginning below the header.
- Use the far-left `+ / 新项目` for an Agent-guided unbound workspace and put
  `新会话` in the current-project session header.
- Do not restore an audit button, control-rights bar, action timeline, or
  authority-explanation bar.
- Keep Model, Project, configuration, and Run operations Agent-oriented in the
  new UI. Consequential writes use a single-turn grant and require durable Riff
  receipts.

If the SVG or PNG changes after a stage begins, development stops until a new
baseline PR records both digests, dimensions, and fixed screenshots. Agents
must not infer the new layout from an old screenshot.

## 3. Stable authority and API contract

| Concern | Authority | Projection only |
| --- | --- | --- |
| Model/Project identity and source digest | Riff Store and owned object files | Agent text, editor buffer, DOM |
| Experiment, Run, outputs, events, cancellation | Riff dispatcher, Store, frozen output bytes | browser animation, screenshots, summaries |
| Conversation-to-owner binding | server-side `WorkspaceBinding` | sidebar grouping and client storage |
| Browser lifecycle and admitted action receipts | Browser Broker | visible page, client history, OpenCode idle |
| Provider and credentials | server-side OpenCode/Riff configuration | labels and redacted readiness state |

Public state is deliberately narrower than server state:

- `WorkspaceBinding` exposes a workspace key, Conversation projection,
  optional Riff owner, generation, and state; it never exposes a raw OpenCode
  session ID.
- `BrowserSessionDto` exposes page generation, projected URL, trust state,
  control mode, remaining budget, and recovery state; it never exposes CDP,
  cookies, or capability tokens.
- `TurnGrantDto` exposes the requested operation summary, target, and expiry.
  The server retains exact tools, parameter digest, owner, turn, budget, and
  revocation state.
- Browser HTTP APIs own lifecycle and observation. Browser MCP owns Agent page
  actions. Owner-scoped Riff MCP owns domain actions.
- Every write carries an expected digest or generation and returns an explicit
  `denied`, `stale`, `expired`, `conflict`, or `unavailable` state.

Agent text, HTML, DOM, screenshots, browser storage, and OpenCode idle cannot
create or restore authoritative Riff data.

## 4. Seven independent PR stages

### Stage 1 — Design baseline, contracts, and upstream pin

- Freeze SVG/PNG digests, dimensions, visible copy, layout annotations, and
  interaction states as the visual acceptance fixture.
- Record Riffology branding and the OpenCode, Browser Broker, and Riff authority
  boundaries.
- Prepare a separate Riffology OpenChamber fork at
  `18fefc997749445b1281f565cefa0cfa86504bf1`, preserving its MIT license and a
  mandatory `UPSTREAM_DELTA.md` ledger.
- Pin Node 22+, Bun 1.3.14, and the reviewed OpenCode SDK/Server target. Runtime
  compatibility is not accepted until the exact tuple is exercised.
- Record the public-surface denylist: Terminal, arbitrary file editing, Git
  publication, sharing, tunnels, Provider-secret management, uncontrolled
  navigation, uploads, downloads, and external login.

Exit: the design check, version/provenance manifest, reproducible Web build,
license/delta check, and existing Riff regression tests pass. An unavailable
remote fork or mismatched OpenCode runtime is reported as a blocker, not hidden.

### Stage 2 — Riffology shell and conversation area

- Replace visible upstream branding, title, and icons without copying upstream
  brand assets.
- Implement the left project rail, `新项目`, project initials, conversation
  title, `新会话`, message stream, tool/permission cards, and composer.
- Create an unbound Agent-guided workspace first, then display Riff Project
  identity after binding.
- Remove the denylisted upstream surfaces from navigation, shortcuts, deep
  links, and product API composition.

Exit: fixture-aligned layout/copy/scroll/composer plus workspace/session switch,
refresh recovery, and read-only Provider-state tests pass.

### Stage 3 — Global browser header and far-right file rail

- Put back, forward, refresh, URL, trusted-source state, Agent state, OpenCode
  version, and `文件 ↗` in the global header.
- Extend the central viewer to the bottom with no secondary chrome.
- Dock the file rail at the far right with collapse, resize, and narrow-screen
  drawer behavior.
- Show sanitized relative paths. Render admitted HTML, Markdown, JSON, and CSV
  in the central viewer, never inside the rail.
- Sandbox HTML, sanitize Markdown, bound JSON/CSV depth/size/rows, and reject
  unknown, oversized, or active content deterministically.

Exit: the stable 1800×1180 region differs from the fixture by at most 1%; the
1440×900, 390×844, and 200% reflow cases have no overflow.

### Stage 4 — Local Browser Broker observation

- Add an independent Broker using isolated local Playwright Chromium.
- Give each Conversation generation exactly one browser session.
- Admit only declared server aliases for Riff app, visual, and artifact
  resources. Reject public internet, raw/private IPs, arbitrary loopback,
  undeclared ports, and redirect escape.
- Support open, refresh, back, screenshot, close, restart, expiry, and reconnect.
- Project real page state into the global header and reuse the central viewer
  for browser and file modes.

Exit: real-Chromium observation, recovery, expiry, rejection, and Broker restart
tests pass. The Agent still cannot click or type.

### Stage 5 — Agent browser control and single-turn grants

- Register Browser MCP operations for open, snapshot, screenshot, click, type,
  scroll, wait, back, reload, and close.
- Bind element references to page generation and fail old references after
  navigation or document replacement.
- Bind each grant to workspace, Conversation generation, turn, target,
  operation set, action budget, and expiry.
- Revoke immediately on budget exhaustion, turn completion, cancellation,
  manual takeover, or service restart.
- Open pause/takeover/return controls from the header Agent state; do not add a
  control bar.

Exit: real OpenCode tests cover click/type/wait/screenshot, stale references,
budget, denial, concurrent control, manual takeover, and Chromium crash.

### Stage 6 — Agent-oriented Riff flows and durable evidence

- Add bootstrap tools to list objects, create Model/Project, and select/bind an
  owner.
- Persist `WorkspaceBinding` across Riffology workspace, Conversation, owner,
  and generation.
- Add owner-scoped Riff MCP operations for files, Model mutations, technical
  checks, Experiment, Run, outputs, events, and lifecycle.
- Keep existing bound content read-only when Provider access is unavailable.
- Require expected digests plus mutation/Run receipts; Agent completion alone
  never proves a write.

Exit: one Model flow and one Project flow complete real multi-turn OpenCode,
single-turn authorization, durable writes, browser display, refresh, and
restart recovery.

### Stage 7 — Default cutover and full local acceptance

- Make the Riffology OpenChamber workbench the default entry.
- Hide the old Product UI entry while retaining a configuration-only local
  rollback switch.
- Run unit, integration, Broker security, real-Provider, continuous-browser,
  responsive, and visual regression suites.
- Exercise OpenCode down, Provider down, Broker down, Riff recovery-required,
  browser loss, and restart recovery without hidden fallback.

Exit: development, testing, and independent review pass with no high-severity
findings and one continuous end-to-end evidence set for the final revision.

## 5. Test and evidence matrix

| Area | Required evidence |
| --- | --- |
| Visual | fixed fonts/data at 1800×1180; masks only for time, IDs, and streaming regions; responsive and reflow captures |
| Conversation | project/session creation, switching, drafts, refresh, archive, Provider read-only |
| Files | placement, collapse, width, focus, and safe/oversized/malicious HTML, MD, JSON, CSV |
| Browser | Riff-only admission, SSRF and redirect denial, isolation, expiry, restart, page generation |
| Control | single-turn grant, stale references, budget, denial, takeover, concurrent actions |
| Riff | Model/Project creation and mutation, Experiment, Run, outputs, receipt validation |
| Recovery | no hidden fallback, fabricated completion, or cross-workspace leakage when any service is down |

Fixture/mock, local real-backend, real-Provider, and unverified results must be
reported separately. A healthy port, rendered DOM, successful screenshot, or
Git push is not equivalent to the required end-to-end evidence.

## 6. Stage workflow and review rules

- One development subagent works on one stage. Test design may run in parallel;
  final tests run after development completes.
- Testing and independent review may run in parallel. Any blocker returns to
  the original development scope before the stage can merge.
- Low-cost agents may handle UI mechanics, documentation, fixtures, and repeated
  tests. Broker security, authorization leases, Riff authority, and complex
  concurrency require high-reasoning implementation and review.
- Each stage is an independent PR. Cross-repository changes use linked PRs;
  merge backward-compatible server contracts before their consumers.
- The main agent owns stage boundaries, worktree scope, feedback closure, and
  the merge decision. Unrelated local files remain untouched.

## 7. Assumptions and exclusions

- The current SVG/PNG pair is the implementation-time visual authority.
- This cycle delivers the complete local implementation only.
- The browser admits only Riff pages and generated files.
- “Agent-oriented” describes the product UI; operational APIs and CLI remain.
- Existing untracked prototype files, `outputs/`, and unrelated user work are
  preserved unless explicitly brought into a stage PR.

