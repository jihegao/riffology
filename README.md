# Riff Demo

- Status: active
- Role: implementation record
- Scope: repository overview, local operation, milestone status, and verification summary
- Source of truth: Riff MVP PRD and merged implementation
- Last reviewed: 2026-07-25

本地 Product 入口：Home 分列 Models 与 Projects；对象页左侧保留
Conversation 上下文，右侧承载当前 Model 或 Project 工作区。

> **MVP target:** the single product requirements authority is
> [`docs/product-requirements.md`](docs/product-requirements.md).
> It restores this two-pane interaction as the shared shell for generic Models
> and Projects and treats wind-turbine maintenance as the first ordinary case.
> The legacy runtime described below predates that contract and still coexists
> while the sequential Milestone A stages replace it.

## Milestone A implementation status

Stage 1's `ProductStoreV2` foundation is implemented and Stage 2 / #13 is the
completed Agent/Model-workspace authority. Stage 2 wires schema v3,
durable per-conversation Agent state, bounded OpenCode context/session recovery,
per-turn capability-scoped MCP tools, progressive simulation-skill audit,
conversation attachments and temporary documents, a generic Model scaffold, a
restricted macOS Model process, digest-bound technical checks, and the narrow
HTTP/API acceptance surface. API integration and the real-provider two-turn
browser closure are complete; the live evidence is described under Verification.

Stage 3 / #14 is implemented and accepted. The Project foundation and A3-1a frozen-planning
slice implemented fixed-copy Projects, execution contract v4, the closed canonical
input-schema profile, deterministic experiment/sample planning, digest
compare-and-set, immutable command receipts, and execution-description-v2
admission. A3-1b now adds the public run start/read routes, a durable dispatcher,
a real generic batch supervisor, hard enforcement of the currently supported
process limits, and atomic publication of successful output bytes and indexes.
The official generic Model scaffold now emits execution-description v2 with a
batch-only capability; existing v1 Models are not silently upgraded.

At the historical A3-1b boundary, visual runs failed with
`capability_not_available` and batch `domainEvents` failed with
`domain_events_not_supported`. A3-1c-a implements
schema migration v5 plus strict same-process queued/running cancellation,
durable replayable receipts, SQLite commit-order terminal precedence, and
no-successful-output publication after cancel-first. A3-1c-b adds schema
migration v6 and fail-closed cross-restart reconciliation for v4 run attempts,
durable pre-spawn scratch/launch evidence, exact PID/start-token/process-group
cleanup, cancellation precedence, and recovery-before-dispatcher-generation
handoff. A3-1c-c adds schema migration v7 and exactly-once terminal batch
completion cards: the Store atomically records a deterministic platform system
message or a permanent skip disposition, and startup reconciles older pending
terminal runs before serving reads.
A3-2a1 was merged and published through PR #28 behind the still-closed public
visual boundary. Schema migration v8 adds immutable, launch-bound visual port
evidence and an atomic one-time visual health receipt/CAS; the private Store
records the visual launch, scratch, process identity, gate, running, health,
heartbeat, exit, and cleanup checkpoints. A3-2a2a was merged and published
through PR #29 at merge commit `1584e39`; schema migration v9 replaces the
former batch-only success/output triggers with run-kind-bound atomic success
authority, rejects visual completion-card state at the database boundary, and
adds private Store authority for visual claim, queued cancellation without a
card, terminalization, and atomic success/output publication. A3-2a2b was
merged and published through PR #30 at merge commit `9f23f61`; it adds the
generic single-attempt visual supervisor and its process, listener, health,
output, sandbox, and cleanup safety primitives. A3-2a2c was merged and
published through PR #31 at merge commit `361b36f`; it integrates the
supervisor into the shared dispatcher, admits eligible visual work through the
existing Project-run API, and preserves child-port secrecy. Visual completion
still fails with HTTP `422` `visual_completion_not_supported`. A3-2b
broker/frame/WebSocket was merged through PRs #33, #35, #36, and #37.
A3-2d1 output access, A3-2d2 diagnostic events, A3-2d3 direct controls, and
A3-2d4 cross-authority revocation were merged through PRs #43, #44, #45, and
#46. A3-3, merged through PR #47, installs the reviewed wind mechanism as one ordinary Model, one
fixed-copy example Project, and one synthetic single-seed Experiment through a
versioned manifest and schema-v13 installation record. It adds no wind-specific
route or DTO. Final Integration adds an isolated real-Chromium Product
acceptance flow: the browser creates a fixed-copy Project, creates and edits an
Experiment, completes a real ordinary batch, pages diagnostic events, downloads
an indexed output, restarts the backend on the same ports, establishes fresh
browser authority, and verifies durable Project/Run/event/output reads.
Their active contract
and negative-test gates are in
[`docs/milestone-a3-project-execution-design.md`](docs/milestone-a3-project-execution-design.md).
A3-2c1's authority/audit and legacy-CDP-isolation foundation was merged through
PR #38. A3-2c2 adds one Project-only `riff_observe_current_visual` tool for
bounded structured, accessibility, DOM-text, or screenshot observation. The
runner uses a fresh backend-owned Chromium profile, exact process/listener/peer
identity, streaming exact-path reads, a script-disabled no-network snapshot,
and in-flight lifecycle revocation. It exposes no interaction, URL, selector,
script, cookie, nonce, port, capability, or legacy-CDP control. A3-2c3 was
merged through PR #41 and A3-2c4 through PR #42. A3-2d1's same-run output
list/download boundary was merged through PR #43. A3-2d2's strict diagnostic
NDJSON ingestion, schema-v12 atomic publication, and authenticated opaque
cursor read surface were merged through PR #44; A3-2d3 direct controls were
merged through PR #45. Its merge gate reports 552 backend tests with 551 passed,
zero failed, and one optional installed-OpenCode smoke skipped; web passes
104/104, the network-entry integration passes 1/1, the production build and
24-file docs check succeed, and final independent security review reports no
P0/P1 merge blocker.
A3-3 uses the published generic A3-2d event boundary. Its real ordinary
Project run publishes two indexed outputs and 38,730 bounded diagnostic events,
then survives backend restart; legacy wind/Gate event routes are not evidence
for that claim.
Its final review gate is 570 backend tests with 569 passed, zero failed, and
one optional OpenCode smoke skipped; web passes 104/104, network entry 1/1,
full Chromium 15/15, the 38-test reviewed wind suite, production build, and the
25-file docs check. Independent review reports P0/P1=0.
Live process rows created under schema v5 lack the v6 scratch/launch evidence
needed for safe signalling and therefore fail restart recovery closed rather
than being automatically cleaned.
The Integration browser gate is intentionally an API/session acceptance surface,
not the Stage 4 Home or shared-shell UX.

Stage 4 starts with the documentation-only A4-0 design gate in
[`docs/milestone-a4-shared-product-shell-design.md`](docs/milestone-a4-shared-product-shell-design.md).
It fixes the PRD-to-API-to-UI-to-test traceability,
Home and shared-shell target contracts, browser admission, lifecycle/deletion,
recovery, and precise retirement boundaries. It changes no runtime behavior;
every A4 implementation row remains pending, and only A4-6 may claim the
complete MVP or close #15.

A4-1 implements the shared Product browser-API foundation. Schema v14 adds durable Model/Project/
Conversation lifecycle receipts and permanent-delete receipts. `GET /api/home`,
the lifecycle-filtered Model/Project collections, generic rename/archive/
restore/trash commands, and explicit preview/confirm permanent deletion all use
one exact browser-session Host/Origin/Fetch/CSRF boundary. Permanent deletion
fails closed on reference, byte/index, process, download, frame/WebSocket,
Agent/tool, generation, token, or closure drift and preserves fixed-copy
lineage.

A4-2 is merged. The default Vite entry is Home
at `/`, with independent Models and Projects collections plus New Model and
New Project forms. `/models/:id` and `/projects/:id` use one responsive
two-pane Product shell; `?conversation=` changes only the persistent left
selection and does not remount the right owner workspace. The UI bootstraps
the real browser session, consumes only the closed A4-1 DTOs, reports provider
unavailability honestly, and keeps the Model/Project workspace content
explicitly bounded to A4-4. Deprecated `?mode=legacy` and `?mode=evidence`
compatibility entries remain only until the manifest-proven A4-5 retirement.

A4-3 is merged as a narrow slice. The persistent left pane now owns
named Conversation creation, selection, rename, archive, restore, trash, and
preview/confirm permanent deletion. Exact provider/model binding is durable and
locks after the first accepted user message. Messages, safe attachment metadata,
temporary-document cards, and redacted skill/action records survive selection
changes; the right owner workspace remains mounted. Expected provider failure
returns HTTP 200 with `mode: "read_only"`, persists the user message, creates no
assistant message, and leaves direct lifecycle controls available. Schema v15
adds immutable provider-binding command receipts.

A4-4 implements the dynamic right workspace on its narrow branch. A
server-declared renderer registry admits bounded Markdown, code, CSV table,
strict JSON, chart, and diagram DTOs; HTML, SVG, and unsupported media stay
opaque and downloadable. Model workspaces expose declared resources and
technical checks. Project workspaces expose fixed-copy identity, editable
Experiment configurations, deterministic sample preview, frozen batch/visual
Runs, status, outputs, diagnostic events with content-free payload summaries,
downloads, cancel,
trash/restore, and the existing exact-app restricted visual host. The ordinary
wind import remains data, while a separate generic visual fixture proves the
Core path has no wind branch. Vite remains a development proxy and cannot
impersonate the exact platform origin; the exact platform host owns broker
iframe redemption. A4-5 and A4-6 remain pending, all final trace rows remain
pending, and Issue #15 stays open. The A4-4 branch gate is backend 592
total/591 passed/zero failed/one optional skip, Web 127/127, network 1/1,
dedicated A4-4 Chromium 1/1, retained A4-2 and A4-3 Chromium 1/1 each,
retained Chromium 15/15, Visual-Agent Chromium 6/6, production build, and
27-document governance. Independent A4-4 review results are recorded before
this branch is published.

The older Gate wind path and `queue-network-v1` code still coexist in the tree.
They remain runnable history, not current Milestone A product authority, and
Stage 3 does not authorize their deletion. The final Models/Projects home,
shared two-pane shell, full multi-conversation story, and precise legacy
retirement belong to #15.

Restricted Model execution currently supports the local-user macOS boundary
through `/usr/bin/sandbox-exec`, a Model-owned working directory, scrubbed
environment, no network rule, and finite process/output/time limits. This is
defense against accidental access, not container/VM-grade isolation from
hostile code. “Technically executable” means only that the thin syntax,
interface, dependency, smoke, output, resource, cancellation, and applicable
visual-health checks pass; it is not scientific validation or decision trust.

## Legacy implementation status

`main` currently contains the completed historical Gate 0-3 wind implementation
and the earlier `queue-network-v1` demo. Those records remain useful as wind-model
evidence and implementation history, but they no longer define the target product.
Where they conflict, the Riff MVP PRD above is authoritative.

## Delivery gates

1. 设计：架构、接口、状态模型及验收场景经主控评审后才能编码。
2. 实现：各组件仅修改分配的目录，并为其公开契约提供测试。
3. 集成：主控合并接口、运行端到端场景并验证可见 UI。
4. 审查：独立审查通过且关键问题修复后才交付。

本地密钥仅放在 `.env`；不得提交或在前端暴露。

## Product direction

Riff 的长期定位不是 Mesa 代码生成器，而是面向业务决策的 AI 原生仿真
Agent 工作平台。它帮助人类把目标、约束、数据和不确定假设快速对齐为可
执行的模型、场景与实验方案，再通过计算分析持续比较方案和修订问题定义。

安全隔离与可复现是运行这一协作循环的先决条件；基于模型身份、运行时冻结的
配置、运行产物和适用范围积累的证据，则决定结果能否支持具体决策。产品核心
价值是在业务要求、模型、实验、分析和人类决策之间保持结构化、可审查的连续性。

MVP 依次交付 SQLite/对象目录基础、持久 OpenCode 对话与通用模型工作区、
项目实验与通用执行，以及共享双栏产品和风机案例的浏览器验收。它不保留旧的
immutable-revision、Evidence Studio 或 Gate 4 作为产品路线。详见当前
[`Riff MVP PRD`](docs/product-requirements.md)；旧
[`product roadmap`](docs/product-roadmap.md) 仅保留为设计历史。

## Run locally

Prerequisites: Python 3.10+ (the checked local flow uses Python 3.12), `uv`,
Node 23+, and npm. Install the web dependencies once:

```sh
cd web && npm install
```

Create `.env` from the example. Keep the key local and do not commit it:

```sh
cp .env.example .env
```

The commands below describe the legacy implementation that remains runnable
while Milestone A is implemented; they are not the target product. For the
default browser demonstration, no live provider is contacted. It starts
with a deliberately limited deterministic development agent which can only load
the legacy bundled `queue-network-v1` model from a matching chat request. Start all
three local processes with:

```sh
bash scripts/start-local-demo.sh
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The standard demo path is:
upload CSV/JSON/TXT → ask to load the queue model → save a parameter change →
run → open Results. The backend socket exact-binds `[::1]:8787` and uses the
browser authority `http://localhost:8787`; its empty visual broker
uses a second server-owned `[::1]` port. Mesa remains an internal
service at `127.0.0.1:8091` and must not be called by the browser.

## Live OpenCode setup

Live mode expects an already configured, loopback OpenCode server. In `.env`,
set the actual provider-qualified model identifier after confirming it in that
server's provider catalogue, along with its local server URL and, when enabled,
server credentials:

```dotenv
OPENCODE_API_KEY=your-provider-key          # consumed by your local OpenCode provider configuration
OPENCODE_MODEL=provider_id/model_id
OPENCODE_URL=http://127.0.0.1:4096
OPENCODE_ALLOWED_PROVIDERS=provider_id
# Optional only when the local OpenCode server requires basic auth.
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=
RIFF_SKIP_OPENCODE=false
# Optional Stage 2 controls.
OPENCODE_REQUEST_TIMEOUT_MS=30000
RIFF_PRODUCT_ROOT=/absolute/path/to/application-owned-product-data
RIFF_MODEL_PYTHON=/absolute/path/to/the/approved/python
RIFF_SKILL_ROOT=/absolute/path/to/simulation-skills
RIFF_ALLOWED_SKILLS=skill-one,skill-two
```

`OPENCODE_API_KEY` is never sent to the browser or stored in the demo workspace.
The local OpenCode installation/provider configuration must consume that key;
the demo backend checks health and the exact configured provider/model before
it accepts a turn. `OPENCODE_REQUEST_TIMEOUT_MS` also accepts the legacy
`OPENCODE_PROMPT_TIMEOUT_MS` fallback. `RIFF_MODEL_PYTHON` must name an
application-approved absolute interpreter; the restricted runner grants only
the exact virtual-environment/framework runtime roots it derives from that
interpreter. Skill instructions are loaded only from `RIFF_SKILL_ROOT` and the
`RIFF_ALLOWED_SKILLS` allowlist. The live acceptance gate is not satisfied by
deterministic mode.

## Verification

The final integrated A3-1b backend run passed 256 tests with 0 failures and
1 optional installed-OpenCode smoke skipped. Focused A3-1b coverage includes execution-protocol-v2
validation, real generic batch supervision, durable dispatch/orchestration,
public run start/read, server-owned limits, terminal/process/output database
invariants, output integrity, error unwind, and shutdown cleanup.
The prior A3-1c-c branch's full backend run contained 295 tests: 294 passed,
zero failed, and one optional smoke was skipped. Its web TypeScript check and
production build also passed; this is historical A3-1 evidence, not an A3-2
publication gate.
Focused A3-2a1 tests cover schema-v8 migration/rollback and visual
health-receipt invariants, the stable public visual-admission rejection, the
private Store visual process-evidence lifecycle, and cross-restart recovery.
The focused recovery suite passes 29/29 using a fake supervisor. It starts no
real visual child and opens no listener. A3-2a1 was merged and published through
PR #28.

Historical A3-2a2a publication evidence covers schema-v9 migration/rollback, run-kind-bound
atomic success/output publication, the visual no-completion database invariant,
generation-fenced visual claim, queued cancel with no card, cancellation-first
terminalization, verified health/exit-zero/cleanup success prerequisites,
required outputs, and atomic rollback/retry. Two independent reviews are PASS,
the focused root gate passes 78/78, and the final backend gate reports 325
total: 324 passed, zero failed, and one optional installed-OpenCode smoke
skipped. Web tests pass 104/104 and the production build succeeds. This evidence
does not include a dispatcher, supervisor, real visual child, listener, or
positive public visual admission. A3-2a2a was merged and published through PR
#29 at merge commit `1584e39`.

Historical A3-2a2b publication evidence reports 379 backend tests with 378
passed, zero failed, and one optional installed-OpenCode smoke skipped; the
focused concurrency combination passed 102/102 three consecutive times, web
passed 104/104, and the production build succeeded. A3-2a2b was merged and
published through PR #30 at merge commit `9f23f61`.

A3-2a2c publication evidence reports 385 backend tests with 384 passed, zero
failed, and one optional installed-OpenCode smoke skipped; its focused review
regression gate passed 13/13, the real-process public vertical and
DTO/error/log secrecy gate passed, web passed 104/104, and the production build
succeeded. A3-2a2c was merged and published through PR #31 at merge commit
`361b36f`. A3-2b1 network isolation, A3-2b2 frame bootstrap/HTTP proxy, and
A3-2b3 WebSocket/revocation/secrecy were merged and published through PR #33,
PR #35, and PR #36 (`bb54b2a`) respectively. A3-2b3 includes real local
broker/child socket evidence, bounded negative
admission and upstream-handshake cases, attempt-global connection limits,
generation/shutdown closure, and observable/persisted sentinel scans. Its
publication backend gate reported 464 total with 463 passed, zero failed, and
one optional installed-OpenCode smoke skipped. A3-2b4 was merged and published
through PR #37: the dedicated Chromium browser security
matrix passes 5/5 and the complete Chromium suite passes 8/8. The current
backend gate reports 466 total with 465 passed, zero failed, and one optional
installed-OpenCode smoke skipped; web passes 104/104, network entry 1/1, and
the production build succeeds. A3-2d4, merged through PR #46, adds a 65/65 focused
backend revocation gate and extends the dedicated broker Chromium matrix to
6/6. Its full merge gate is 553 backend total/552 passed/zero failed/one
optional OpenCode smoke skipped, web 104/104, network entry 1/1, full Chromium
15/15, successful production build, and a 24-file docs check. A3-3 focused
evidence covers schema-v13 migration/rollback, manifest byte/digest pinning,
five restart windows, a real technical check, deterministic baseline
(1,096 daily rows and 38,730 events), a real generic Product run, and restart
recovery. The final Stage 3 Product Chromium gate passes 1/1 with Project copy,
Experiment create/edit, real batch completion, cursor paging, indexed download,
same-port backend restart, fresh browser-session bootstrap, durable reads, and
zero console errors. Run it with `cd web && npm run test:e2e:a3`; the output
bytes are fetched through the guarded same-origin API, verified against their
indexed digest, and saved through a Chromium download.

Focused Milestone A2 verification:

```sh
cd backend
node --experimental-strip-types --test \
  test/product-schema.test.ts \
  test/agent-conversation-store.test.ts \
  test/product-store-v3-recovery.test.ts \
  test/agent-context.test.ts \
  test/agent-api.test.ts \
  test/agent-turn-runtime.test.ts \
  test/agent-workspace-concurrency.test.ts \
  test/opencode-conversation-runtime.test.ts \
  test/agent-mcp-permissions.test.ts \
  test/simulation-skill-catalog.test.ts \
  test/model-workspace.test.ts \
  test/model-process-isolation.test.ts \
  test/model-technical-checker.test.ts
```

The prior integrated A3-1 full backend suite passed, with only the optional
smoke against an installed OpenCode instance skipped. Its web evidence was 104
passing tests plus a successful production build. API tests cover provider discovery,
atomic generic Model creation, independent/rebuilt conversations, idempotent
turns, attachment and temporary-document projection, scoped MCP
mutation/revocation, read-only failure, workspace secrecy, and technical-check
start/read.

Final live closure used OpenCode `1.18.4` with
`opencode-go/deepseek-v4-pro`. The real browser acceptance surface created a
new generic Model and completed two clean turns in one OpenCode session; the
second response correctly incorporated the first-turn token. OpenCode owns the
upstream user-message IDs, while Riff snapshots prior message IDs and accepts
only the assistant parented to the newly created user message. The earlier
explicit read-only result remains valid fail-closed evidence; no canned reply,
mock, or healthy-port check was used for the successful two-turn claim.

Run the component suites:

```sh
(cd mesa_service && uv run --extra test pytest)
(cd backend && npm test)
(cd web && npm test && npm run build)
```

With the local processes running, execute the visible browser smoke test:

```sh
NO_PROXY=127.0.0.1 node scripts/e2e-local.mjs
```

It saves a 1440×900 evidence screenshot under the ignored `test-results/`
directory. In deterministic mode this proves the local UI/Mesa integration only;
it does not replace the live health/provider/model, chat, and approved-tool-call
release gate described in
[`docs/opencode-bridge.md`](docs/opencode-bridge.md).
