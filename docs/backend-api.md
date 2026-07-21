# Backend project API

后端监听 `127.0.0.1:8787`，是浏览器唯一调用的服务。除 `GET /health` 外，业务路由均位于
`/api/projects`。未知资源、方法和路径不会选择隐含模型。

## Commands and concurrency

除项目创建和 session attachment 外，变更命令使用同一 envelope：

```json
{
  "command_id": "UUID",
  "project_id": "project_...",
  "session_id": "session_...",
  "base_snapshot_revision": 12,
  "payload": {}
}
```

`command_id` 提供幂等性；`base_snapshot_revision` 防止覆盖并发更新。schema 错误返回 `422`，
过期修订返回 `409`，未知或跨项目身份返回 `404`。`202` 仅表示命令已接收，不表示运行成功。

## Project and workflow routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | 进程与 workspace lifecycle proof。 |
| `GET` | `/api/projects/default` | 当前默认项目的 Evidence Studio 引导投影。 |
| `POST` | `/api/projects` | 创建项目和初始本地参与者。 |
| `POST` | `/api/projects/{project_id}/sessions` | 将显式选择的参与者附加到临时浏览器 session。 |
| `GET` | `/api/projects/{project_id}/snapshot` | 有界公开项目投影。 |
| `GET` | `/api/projects/{project_id}/events` | 项目事件页或 SSE snapshot/patch 流。 |
| `POST` | `/api/projects/{project_id}/actors` | 创建声明式本地参与者。 |
| `POST` | `/api/projects/{project_id}/wind/bootstrap` | 绑定经审核的风机模型和初始业务/实验修订。 |
| `POST` | `/api/projects/{project_id}/brief/revisions` | 创建业务简报修订。 |
| `POST` | `/api/projects/{project_id}/alignment/revisions` | 创建对齐映射修订。 |
| `POST` | `/api/projects/{project_id}/experiments/revisions` | 保存参数或 reset 后的新实验修订。 |
| `POST` | `/api/projects/{project_id}/issues` | 创建修订范围内的 issue。 |
| `GET` | `/api/projects/{project_id}/issues/{issue_id}/history` | 读取 issue 完整事件历史。 |
| `POST` | `/api/projects/{project_id}/issues/{issue_id}/comments` | 添加 issue 评论。 |
| `PATCH` | `/api/projects/{project_id}/issues/{issue_id}` | 记录解决或重新打开事件。 |
| `GET` | `/api/projects/{project_id}/attestations` | 按主题分页读取认可记录。 |
| `POST` | `/api/projects/{project_id}/attestations` | 创建不可变或 superseding 认可。 |

本地参与者身份是 `declared_unauthenticated_local`。人工认可与 Agent 记录分组计数；只有明确
主题、角色和 scope 的有效人工记录参与默认工作流条件。

## Run and evidence routes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/projects/{project_id}/runs` | 以已保存实验修订启动 private draft；成功接收返回 `202`。 |
| `GET` | `/api/projects/{project_id}/runs/{run_id}` | 读取运行状态。 |
| `POST` | `/api/projects/{project_id}/runs/{run_id}/cancel` | 幂等取消。 |
| `GET` | `/api/projects/{project_id}/runs/{run_id}/events` | 分页读取权威领域事件。 |
| `GET` | `/api/projects/{project_id}/artifacts/{artifact_id}` | 下载摘要绑定工件。 |
| `GET` | `/api/projects/{project_id}/runs/{run_id}/evidence` | 读取 Evidence Studio 证据索引。 |
| `GET` | `/api/projects/{project_id}/runs/{run_id}/event-projection/v1` | 按 day、event、turbine、crew 或 work order 过滤事件投影。 |
| `GET` | `/api/projects/{project_id}/runs/{run_id}/kpis` | 按 `after_day` 和 `limit` 分页读取 KPI。 |
| `GET` | `/api/projects/{project_id}/runs/{run_id}/replay` | 按 `after_frame` 和 `limit` 分页读取回放。 |

## Model and browser projections

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/{project_id}/browser-projection/v1` | Evidence Studio 的有界聚合投影。 |
| `GET` | `/api/projects/{project_id}/events/browser-v1` | 浏览器 snapshot/patch/reload-required SSE。 |
| `GET` | `/api/projects/{project_id}/wind/framed-candidate` | 当前技术候选状态。 |
| `POST` | `/api/projects/{project_id}/wind/framed-evidence/activate` | 技术 framed activation。 |
| `GET` | `/api/projects/{project_id}/brief/revisions/{revision_id}` | 摘要绑定业务简报。 |
| `GET` | `/api/projects/{project_id}/alignment/revisions/{revision_id}` | 摘要绑定对齐映射。 |
| `GET` | `/api/projects/{project_id}/models/{model_revision_id}/view-sources` | 模型视图源集合。 |
| `GET` | `/api/projects/{project_id}/models/{model_revision_id}/view-sources/{name}` | 单个模型视图源。 |

投影只返回允许公开的字段和可下载引用，不返回绝对路径、原始内部日志或完整历史。完整 Mesa
内部路由见 [`mesa-service.md`](mesa-service.md)。
