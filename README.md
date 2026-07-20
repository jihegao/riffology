# Riff Demo

本地双栏演示：左侧为由 OpenCode 驱动的建模对话与文件上传，右侧为 Mesa 仿真工作台。

## Gate 0 status

Gate 0 已冻结下一阶段目标：以本机 AnyLogic `Field Service` 示例为结构证据，
独立实现 `wind-turbine-maintenance` 风机维护案例，验证业务需求、模型、实验和
人类审查之间的对齐闭环。当前可执行代码仍是 `queue-network-v1`；Gate 0 只改
合同与路线图，不声称风机模型、持久化、自动图或新 UI 已实现。完整合同见
[`docs/wind-turbine-maintenance-gate-0.md`](docs/wind-turbine-maintenance-gate-0.md)。

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

安全隔离与可复现是运行这一协作循环的先决条件；基于 exact revision、场景、
运行产物和适用范围积累的证据，则决定结果能否支持具体决策。产品核心价值是
在业务要求、模型、实验、分析和人类决策之间保持结构化、可审查的连续性。

当前单模型限制只是这一方向的实现边界。后续路线先用审查过的风机维护案例
验证业务对齐和场景分析循环，再提取通用模型包合同，并逐步支持隔离执行、
Evidence Studio、自动评审和专家评审。旧队列案例将在 Gate 4 从当前产品树和
已精确识别的本地工件中彻底删除，不保留为 fallback 或回归 fixture。详见
[`docs/product-roadmap.md`](docs/product-roadmap.md)。

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
until Gate 4; they are not the wind-turbine target. For the default browser
demonstration, no live provider is contacted. It starts
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
```

`OPENCODE_API_KEY` is never sent to the browser or stored in the demo workspace.
The local OpenCode installation/provider configuration must consume that key;
the demo backend only checks health and the configured provider/model before it
accepts chat. The live acceptance gate is not satisfied by deterministic mode.

## Verification

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
