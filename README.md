# Riff Demo

本地双栏演示：左侧为由 OpenCode 驱动的建模对话与文件上传，右侧为 Mesa 仿真工作台。

> **Milestone A target:** the newly approved product contract is
> [`docs/milestone-a-product-contract.md`](docs/milestone-a-product-contract.md).
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

Stage 3 / #14 is in progress. The Project foundation and A3-1a frozen-planning
slice implemented fixed-copy Projects, execution contract v4, the closed canonical
input-schema profile, deterministic experiment/sample planning, digest
compare-and-set, immutable command receipts, and execution-description-v2
admission. A3-1b now adds the public run start/read routes, a durable dispatcher,
a real generic batch supervisor, hard enforcement of the currently supported
process limits, and atomic publication of successful output bytes and indexes.
The official generic Model scaffold now emits execution-description v2 with a
batch-only capability; existing v1 Models are not silently upgraded.

A3-1b explicitly rejects visual runs with `capability_not_available` and batch
`domainEvents` with `domain_events_not_supported`. A3-1c-a implements
schema migration v5 plus strict same-process queued/running cancellation,
durable replayable receipts, SQLite commit-order terminal precedence, and
no-successful-output publication after cancel-first. A3-1c-b adds schema
migration v6 and fail-closed cross-restart reconciliation for v4 run attempts,
durable pre-spawn scratch/launch evidence, exact PID/start-token/process-group
cleanup, cancellation precedence, and recovery-before-dispatcher-generation
handoff. Exactly-once completion-card delivery remains later A3-1c work.
Visual execution, scoped Playwright
access, and ordinary wind import are later #14 slices. Their active contract and
negative-test gates are in
[`docs/milestone-a3-project-execution-design.md`](docs/milestone-a3-project-execution-design.md).
Live process rows created under schema v5 lack the v6 scratch/launch evidence
needed for safe signalling and therefore fail restart recovery closed rather
than being automatically cleaned.
This lifecycle slice is not completion evidence for Stage 3, completion cards, visual execution, wind
import, or final browser acceptance.

The older Gate wind path and `queue-network-v1` code still coexist in the tree.
They remain runnable history, not current Milestone A product authority, and
Stage 3 does not authorize their deletion. Remaining Project execution and wind
import belong to #14; the final Models/Projects home and shared two-pane shell
belong to #15.

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
Where they conflict, the Milestone A contract above is authoritative.

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

Milestone A 依次交付 SQLite/对象目录基础、持久 OpenCode 对话与通用模型工作区、
项目实验与通用执行，以及共享双栏产品和风机案例的浏览器验收。它不保留旧的
immutable-revision、Evidence Studio 或 Gate 4 作为产品路线。详见当前
[`Milestone A contract`](docs/milestone-a-product-contract.md)；旧
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
run → open Results. The backend is at `127.0.0.1:8787`; Mesa is an internal
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

The latest full backend suite passed, with only the optional smoke against an
installed OpenCode instance skipped. The latest web evidence is 104 passing
tests plus a successful production build. API tests cover provider discovery,
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
