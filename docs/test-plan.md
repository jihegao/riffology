# Current test and acceptance plan

## Model and Mesa service

```sh
cd mesa_service
uv sync --extra test --frozen
PYTHONDONTWRITEBYTECODE=1 uv run pytest -q
```

覆盖模型 conservation、event ordering、deterministic streams、warm-up integration、等待/overdue
cohorts、schema/export drift、bundle identity、worker admission、TOCTOU rejection、artifact verification、
activation/recovery、workspace lock/fence 和风机 API。

## Backend

```sh
cd backend
npm install
npm run test:demo
```

覆盖 durable project、command idempotency、concurrency、issues、attestations、workflow counts、
private-draft admission、Mesa adapter、Evidence projection、activation recovery、restart、workspace
lifecycle。这个演示验收命令不运行 workspace-retirement auditor。

## Web and browser

```sh
cd web
npm install
npm run test:demo
npm run test:startup-config
npm run test:e2e
```

单元测试验证 projection、schema、traceability、KPI、event/replay paging 和 error states。真实 E2E
启动隔离的 Mesa、backend 与 Vite，验证单一 Evidence Studio、显式 actor attachment、edit/reset、
issue 与 endorsement 计数、202 run、8 个工件、自动生成视图、restart persistence、窄屏和 200%
zoom。测试不需要外部模型服务或凭据。

## 本阶段演示边界

本阶段验收不生成或检查 Report A/B，不读取 GitHub approval，不运行
workspace-retirement auditor 的 dry-run/apply/resume，也不删除真实工作区。启动脚本只拉起 Mesa、
backend 和 Vite；浏览器演示只通过 backend 访问 Mesa 与隔离的 `WORKSPACE_ROOT`。

已提交的审计器与 generic absence scanner 保留为后续、可选的仓库运维能力。维护者可以单独运行
`cd backend && npm test` 检查包含审计器 synthetic harness 的全量回归，或运行
`cd web && npm run test:retirement` 检查 scanner；两者都不是当前演示或合并的硬门槛，也不得针对
真实工作区执行删除。

## 可选的仓库 absence scan

需要清理历史产品入口时可以使用通用 scanner；规则文件应在仓库外临时生成，不在提交树中复制禁用字面量。
规则文件必须使用 `riff://generic-absence-scanner/rules/v1` schema，final mode 不接受 exclusions，
每个保留的风机语义 allow binding 都必须绑定 scope、path、SHA-256 和精确 occurrence count。

在仓库根运行：

```sh
cd web && npm run build && cd ..
RULES_FILE=/absolute/path/to/out-of-band-rules.json
node scripts/check-gate4-runtime-absence.mjs \
  --candidate "$(pwd -P)" \
  --rules-file "$RULES_FILE" \
  --mode final \
  --bundle-dir web/dist
```

维护者主动执行时，应确认 tracked content、tracked pathname 和 production bundle 均无未允许命中，
所有 delete path 不再 tracked，所有 allow binding 均被精确使用。该扫描不调用 workspace-retirement
auditor，也不删除真实工作区。

## Acceptance interpretation

测试通过证明当前合同实现一致、可重复且没有被禁用的产品入口；它不证明真实风场准确性。
Evidence Studio 必须持续显示 synthetic、single seed、unverified、no recommendation 边界。零 issue
只表示没有已记录的未解决异议；认可计数和 technical activation 都不能替代 scientific review。
