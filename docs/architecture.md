# Wind Evidence Studio architecture

## System boundary

当前系统只有一个产品表面和一个模型族：浏览器中的 Wind Evidence Studio 与
`wind-turbine-maintenance`。三个本地进程职责固定：

```text
Browser :5173
    -> Backend :8787
        -> Mesa service :8091
            -> WORKSPACE_ROOT
```

浏览器只调用后端。后端是项目、命令、工作流和浏览器安全投影的权威；Mesa 是模型包、
运行生命周期和不可变结果工件的权威。浏览器 DOM、图表和说明文字不创建领域事实。

## Identity graph

以下身份不可互换：

| Identity | Meaning |
| --- | --- |
| `project_id` | 持久项目容器。 |
| `snapshot_revision` | 当前项目投影的并发序号。 |
| `brief_revision_id` | 不可变业务问题修订。 |
| `alignment_revision_id` | 不可变需求到模型映射修订。 |
| `model_revision_id` | 内容寻址的模型代码、schema、默认值和追溯包。 |
| `experiment_revision_id` | 完整参数、horizon、warm-up、seed 与上游身份绑定。 |
| `run_id` | 一次执行及其请求、策略事实和工件集合。 |

参数值改变会创建新的 experiment revision；规则、单位、范围、分布或指标公式改变会创建
新的 model revision。运行只接受已保存的 experiment revision，不接受临时覆盖值。

## Durable ownership

```text
WORKSPACE_ROOT/
  projects/<project_id>/
    project.json
    inputs/
    alignment/
    issues/
    attestations/
    experiments/
    models/wind-turbine-maintenance/
    runs/
    activations/
```

每类记录只有一个写入方。可变指针使用原子写入；不可变内容以 ID 和摘要绑定。项目事件和
运行工件在重启后恢复，浏览器连接不替代项目身份。

每个工作区根有 lifecycle 与 mutation lock；服务访问根目录前还会检查固定全局 gate 和
根 fence。无法验证锁、gate、fence 或根身份时启动和写入均 fail closed。

## Execution and review

模型激活是技术过程：校验 framed bundle、schema、默认实验、runtime profile 和候选身份，
然后以 compare-and-swap 更新活动修订。它不表达人工认可、可信度、科学批准或决策适用性。

alignment revision 与 experiment revision 分别计算工作流条件。默认条件是每个主题至少一条
`project_owner` 人工认可且没有未解决的 blocking issue。认可数、issue 数和派生条件都是
定量记录；零 issue 仅表示没有已记录的未解决异议。

技术 activation 就绪后，即使工作流条件未满足，也可安全执行 `private_draft`。运行冻结当时
的条件事实，并标记 `draft_unverified`；之后的认可不会原地升级旧运行。

## Evidence generation

模型视图来自模型包中的 spec、schema、traceability 和 visualization metadata。KPI、事件、
回放、swimlane、摘要和下载链接来自选中运行的摘要绑定工件。视图不维护手写的第二份数据，
所以新 model revision 或新 run 被选中后会自动反映对应源数据。

当前证据边界是 synthetic、single seed、behavioral reproduction、no recommendation。
详见 [`gate-1-wind-turbine-model-design.md`](gate-1-wind-turbine-model-design.md) 和
[`gate-3-evidence-studio-design.md`](gate-3-evidence-studio-design.md)。
