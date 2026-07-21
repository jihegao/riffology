# Evidence Studio UI workflow

## Entry and layout

打开 `/` 后只显示 Wind-turbine maintenance Evidence Studio。任何查询字符串都保留同一界面。
用户先从项目声明的本地 actors 中显式选择并 attach；刷新或后端重启后需要重新选择。

宽屏同时显示 alignment context 与 workbench；低于 960px 时使用明确的 pane selector。Workbench
有六个 ARIA tabs：Brief、Model、Experiment、Issues & review、Run、Evidence。切换视图不修改
项目状态。

## Brief and Model

Brief 显示决策问题、`95%` demo constraint、assumptions、non-goals、sources 和 revision identity。
Model 显示 model revision、entity/state diagram、process transitions、parameter/metric schemas 和
traceability。所有图都由当前 model bundle sources 生成，并提供等价文本或表格。

## Experiment

29 个表单字段包括 26 个模型参数、horizon、warm-up 和 seed。字段显示 unit、range、default、
current value 与 changed marker。Save as new revision 创建新的完整 experiment revision。

Reset all 先显示 preview，再把活动 model revision 的完整默认 preset 保存为新 revision；旧 revision
不被覆盖。更改参数语义、单位、范围、分布、规则或指标公式需要新的 model revision。

## Issues and review

Alignment 与 Experiment 分别显示：

- human project-owner workflow endorsement count；
- other human 与 Agent attestation count；
- all-open、blocking 与 non-blocking issue count；
- exact subject revision 与 derived workflow threshold。

零 issue 的界面文案是“no recorded open objection”，不是可信、正确或有效。新建 issue 后可读取
权威 history；解决必须带 reason。认可记录必须带 scope、decision 和 rationale，并可通过新的
superseding record 改变有效 head。

## Run and Evidence

Technical framed activation 就绪后可启动 private draft，即使 workflow threshold 未满足。Run 卡片
显示 admission-time `workflow_policy_met` 或 `workflow_policy_unmet`、`private_draft` 和
`draft_unverified`。之后的认可不改变旧 run。

选中成功 run 后，Evidence 从工件生成 daily KPI charts/table、filtered event table、2D replay、
swimlane、summary、traceability 和 exact downloads。新 run 或 model revision 被选中时，对应视图
自动更新。缺失、损坏或身份不一致的数据只会产生明确 unavailable state。

每个 Evidence 页面固定显示 Synthetic data、Single seed、Behavioral model 和 No recommendation。
这些结果用于检查机制和可追溯性，不是 staffing recommendation。

## Accessibility acceptance

Tabs 支持键盘导航和可访问名称；图表有等价表格；状态不只依赖颜色。820px 布局显示明确的
conversation/alignment pane 控件；390px viewport 与 200% zoom 下仍可选择 Workbench、读取
Evidence tab 和完整 KPI 表。
