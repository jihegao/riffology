# Riff Wind Evidence Studio

Riff 是一个本地运行的风机维护仿真证据工作台。当前产品只有一个浏览器界面：
`wind-turbine-maintenance` Evidence Studio。它把业务问题、模型映射、实验修订、
问题与认可、运行结果和可下载证据放在同一个可追溯项目中。

## 当前能力

- 后端持久化项目、参与者、业务简报、对齐映射、实验修订、问题、认可和运行记录。
- Mesa 服务执行经审核的风机维护模型并发布不可变运行工件。
- Evidence Studio 提供 Brief、Model、Experiment、Issues & review、Run 和 Evidence 视图。
- 参数修改和“Reset all”都会创建新的实验修订；默认值始终保留。
- 图表、过程图、KPI 表、事件表和回放均由模型包或运行工件直接生成；模型修订或运行改变后，视图随对应数据自动更新。
- 私有草稿可在技术 framed activation 就绪后运行，不以人工认可为执行前提。

后端项目状态是工作流事实的权威来源；Mesa 模型包和不可变运行工件是模型与结果的
权威来源。页面、图表和说明文字只是这些事实的投影。

## 证据与声明边界

人工认可和 issue 都是按修订记录的定量事实。零 issue 只表示“没有已记录的未解决异议”，
不表示正确、可信或已验证。技术 activation 只证明可执行合同完整，不代表认可、信任、
科学批准或业务适用性。

当前案例使用合成输入和单个固定 seed，验证的是可复现的行为机制与证据链。它没有经过
真实风场校准、不提供不确定性结论，也不构成人员配置建议。

## 本地启动

前置条件：Python 3.10+、`uv`、Node.js 23+ 和 npm。

```sh
cd mesa_service && uv sync --extra test --frozen
cd ../backend && npm install
cd ../web && npm install
cd ..
bash scripts/start-local-demo.sh
```

打开 <http://127.0.0.1:5173>。后端监听 `127.0.0.1:8787`；Mesa 服务监听
`127.0.0.1:8091`，仅由后端调用。`WORKSPACE_ROOT` 默认为仓库下的
`.riff-workspaces`。相对 `WORKSPACE_ROOT` 会由启动脚本按仓库根目录解析；为避免调用目录产生
歧义，自定义时建议显式传入绝对路径。

`.env.example` 只是变量参考，启动脚本不会自动读取它。如需改端口或工作区，在仓库根的同一
shell 中显式导出变量并保持两组地址配对：

```sh
export WORKSPACE_ROOT="$(pwd -P)/.riff-workspaces-custom"
export MESA_PORT=18091
export MESA_SERVICE_URL=http://127.0.0.1:18091
export PORT=18787
export VITE_API_BASE_URL=http://127.0.0.1:18787
export WEB_PORT=15173
bash scripts/start-local-demo.sh
```

`MESA_SERVICE_URL` 必须与 `MESA_PORT` 指向同一端口；`VITE_API_BASE_URL` 必须与 `PORT`
指向同一后端。`VITE_API_BASE_URL` 不带额外 `/api`，因为前端请求路径本身已经以 `/api` 开头。

停止脚本会停止三个子进程，但不会删除项目和运行工件。重启后，持久化修订、问题、认可、
运行和证据仍由同一项目恢复。

当前阶段只交付可演示的私有草稿工作流，不执行真实工作区删除，也不要求生成 Report A/B、
运行 workspace-retirement auditor/apply 或取得 GitHub approval。仓库中保留的离线审计器是后续
可选运维能力；`scripts/start-local-demo.sh` 和浏览器演示路径都不会调用它。

## 测试

```sh
cd mesa_service && PYTHONDONTWRITEBYTECODE=1 uv run pytest -q
cd ../backend && npm run test:demo
cd ../web && npm run test:demo && npm run test:startup-config && npm run test:e2e
```

完整测试范围和最终通用规则扫描命令见 [`docs/test-plan.md`](docs/test-plan.md)。
架构、API、模型与 UI 合同从 [`docs/README.md`](docs/README.md) 开始阅读。
