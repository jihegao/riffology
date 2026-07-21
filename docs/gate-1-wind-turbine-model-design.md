# Wind-turbine maintenance model contract

## Implemented model

`WindTurbineMaintenanceModel` 是 Mesa 3 行为模型，包含 turbine、maintenance crew 和
work order。内部时间为连续 day；公开 `step()` 推进到下一个自然日边界，并处理该边界前后
应发生的全部事件。

Turbine 状态：`operating`、`failed_waiting`、`corrective_repair`、
`planned_maintenance`、`major_replacement`。Crew 状态：`idle`、
`driving_to_work`、`working`、`driving_home`。

同一时刻按 request trigger、work completion、arrival/return、central dispatch、daily
snapshot 排序；相同阶段使用稳定序号。纠正性工单优先于计划性工单，各类内部 FIFO，多个可用
crew 按 ID 稳定选择。所有随机选择来自 run seed 派生的具名随机流。

## Source mapping

结构证据来自本机 AnyLogic `Field Service.alp`，SHA-256 为
`2153fbf23348ece013f7d72bf0064e5d01ac52273bebf560520bb35047734755`。
实现独立复现 failure、crew travel、repair、maintenance、probability-driven replacement 和
return-to-depot 机制，没有复制 AnyLogic Java 或视觉资产。proactive age replacement、运行中
增减 crew、road GIS、weather access、spare parts 和 crew skills 不在当前模型内。

这是一种行为机制复现，不是 AnyLogic runtime import，也不是逐事件或数值等价声明。

## Revision bundle

每个 `model_revision_id` 绑定代码、`model-spec.json`、parameter schema、metric schema、默认
实验、traceability、visualization metadata 和 runtime profile 的规范字节与摘要。导出测试会
比较代码定义和提交的 JSON；任一漂移都会拒绝 bundle 或运行。

所有 26 个公开模型参数，加上 horizon、warm-up 和 seed，都可在 Experiment 视图编辑并保存为
新 revision。Reset all 复制当前活动模型 revision 的完整默认 preset，不删除历史。

默认演示为 100 turbines、3 crews、1095 days、365-day warm-up、seed 2。`95%` availability
是用户声明的演示约束，不是行业 benchmark。

## Metrics and generated views

测量窗口使用 `[warm_up_days, horizon_days)`，状态 KPI 通过事件区间积分计算。等待与 overdue
样本以原始请求事件为 cohort，并分别记录完成样本和右删失样本；P95 使用 nearest-rank。

`corrective_queue_length` 与 `planned_queue_length` 仅表示风机维修模型内两类待处理工单数量。
它们用于每日 KPI、回放聚合和诊断，不是另一种模型或产品入口。

模型包直接提供 entity/state、transition、parameter、metric 和 traceability 视图源；运行直接
提供 daily metrics、domain events、summary、replay 和 derived views。模型 revision 或 run 变化
后，Evidence Studio 读取新源并自动更新图表与表格。

## Execution evidence

一次成功运行发布请求、metadata、每日 KPI、领域事件、summary、replay、derived views 和有界
日志。父进程与 worker 分别校验 bundle、experiment、request、policy、receipt、runtime 与工件
身份，之后结果才可见。

```sh
cd mesa_service
uv sync --extra test --frozen
PYTHONDONTWRITEBYTECODE=1 uv run pytest -q
uv run python -m mesa_service.run_baseline \
  --preset wind-turbine-maintenance-demo-v1 \
  --output-dir ../outputs/gate1-wind-baseline
uv run python -m mesa_service.verify_run ../outputs/gate1-wind-baseline
```

这些检查证明确定性、合同一致性和可追溯性。输入是 synthetic，当前证据是 single seed、
unverified private draft，不支持真实风场校准结论或 staffing recommendation。
