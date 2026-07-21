# Mesa wind execution service

Mesa 服务监听 `127.0.0.1:8091`，只接受后端提供的、绑定到已提交项目与活动 framed model 的
风机执行合同。浏览器不直接调用它。

## Public backend-to-Mesa routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | 服务与 workspace lifecycle proof。 |
| `PUT` | `/v2/projects/{project_id}/models/wind-turbine-maintenance` | 为已索引项目 materialize 审核过的 preset。 |
| `POST` | `/v2/projects/{project_id}/runs` | 以固定 headers 和 request digest 接收 run，返回 `202`。 |
| `GET` | `/v2/projects/{project_id}/runs/{run_id}/evidence` | 返回运行 lifecycle 与 evidence declaration。 |
| `GET` | `/v2/projects/{project_id}/run-receipts/{downstream_key}` | 返回幂等 dispatch receipt。 |
| `POST` | `/v2/projects/{project_id}/runs/{run_id}/cancel` | 应用后端已提交的 cancellation tombstone。 |
| `GET` | `/v1/projects/{project_id}/runs/{run_id}/events` | 后端使用的分页事件读取。 |
| `GET` | `/v1/projects/{project_id}/runs/{run_id}/artifacts/{name}` | 后端使用的单工件读取。 |

## Internal activation routes

技术 activation 使用固定 protocol headers、canonical JSON、idempotency key、byte capture 和
compare-and-swap：

- `GET /internal/projects/{project_id}/wind/runtime-candidate-handshake/v1`
- `POST /internal/wind/framed-candidates/materialize`
- `GET /internal/wind/framed-candidates/{activation_id}`
- `GET /internal/projects/{project_id}/wind/framed-candidates/{activation_id}/byte-capture/v1`
- `POST /internal/wind/active/cas`
- `GET /internal/wind/activations/{activation_id}/status`

Activation 只证明 bundle、experiment、runtime profile 与 authority chain 技术一致；它不是人工
认可、信任、科学批准或业务建议。

## Artifacts and safety

成功 run 发布精确声明的 request、metadata、daily KPI、domain events、summary、replay、derived
views 和 bounded log。父进程与 worker 独立校验 identity/digest；未完成或失败目录不能公开成功
结果。写入使用临时目录和原子 promotion。

服务在访问 workspace 前校验 global gate、root fence、lifecycle lock 与 mutation lock。根或锁
不是预期 regular file/directory、存在 symlink ambiguity 或恢复未完成时 fail closed。

```sh
cd mesa_service
uv sync --extra test --frozen
PYTHONDONTWRITEBYTECODE=1 uv run pytest -q
uv run uvicorn mesa_service.app:app --host 127.0.0.1 --port 8091
```

`WORKSPACE_ROOT` 默认是当前目录的 `.riff-workspace`；集成栈会显式传入仓库的共享 root。
