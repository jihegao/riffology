# Riff Demo

本地双栏演示：左侧为由 OpenCode 驱动的建模对话与文件上传，右侧为 Mesa 仿真工作台。首版仅交付一条可运行的演示闭环：上传输入、生成或加载受限 Mesa 模型、设置参数、运行实验、查看结果并在对话中总结。

## Delivery gates

1. 设计：架构、接口、状态模型及验收场景经主控评审后才能编码。
2. 实现：各组件仅修改分配的目录，并为其公开契约提供测试。
3. 集成：主控合并接口、运行端到端场景并验证可见 UI。
4. 审查：独立审查通过且关键问题修复后才交付。

本地密钥仅放在 `.env`；不得提交或在前端暴露。

## Product direction

当前单模型限制是可信演示的实现边界，不是长期产品边界。后续路线将把
`queue-network-v1` 改造成通用模型包的首个实例，允许用户和建模 Agent
自由创建模型、在隔离沙箱中运行未验证 revision，再通过用户测试、Agent
评审和第三方专家评审逐步积累可信证据。详见
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

For the default browser demonstration, no live provider is contacted. It starts
with a deliberately limited deterministic development agent which can only load
the approved `queue-network-v1` model from a matching chat request. Start all
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
release gate described in `docs/opencode-bridge.md`.
