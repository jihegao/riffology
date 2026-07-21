# Wind-turbine maintenance source and claim contract

## Business question

当前案例记录的问题是：

> How many field-service crews should an onshore wind farm configure to reach
> its availability target at the lowest annual maintenance cost?

当前发布物只提供一个可检查、可执行的实验和单 seed baseline，不回答该人员配置问题。比较多个
crew count、多个 seed、敏感性和不确定性后，才可能形成范围明确的分析；本案例不提供建议。

## Source provenance

结构来源是本机 AnyLogic example：

```text
/Users/Shared/AnyLogic 8 PLE/eclipse/plugins/
  com.anylogic.examples_8.9.0.202404161223/models/Field Service/Field Service.alp
```

| Field | Value |
| --- | --- |
| Source format | AnyLogic `.alp` XML |
| Examples package | `8.9.0.202404161223` |
| Declared AnyLogic version | `8.4.0.qualifier` |
| Project format | `8.4.5` |
| Time unit | day |
| Source experiment seed | `2` |
| Source size | `170957` bytes |
| SHA-256 | `2153fbf23348ece013f7d72bf0064e5d01ac52273bebf560520bb35047734755` |

Riff 在 Python/Mesa 中独立复现选定的 equipment failure、field crew travel、repair、planned
maintenance、replacement 和 return-to-depot 机制。仓库不复制 AnyLogic Java、logo、image 或
3D lorry asset。来源提供结构证据，不提供真实风场 calibration，也不证明逐事件或数值等价。

## Included and excluded scope

当前包括 turbine、crew、work order、corrective priority、FIFO within type、travel time、repair、
planned maintenance、probability-driven major replacement、warm-up、availability、wait、overdue、
crew utilization 与 synthetic cost/revenue diagnostics。

当前不包括 proactive age replacement、运行中增减 crew、road GIS、weather access、spare parts、
crew skills、real farm observations、calibration、uncertainty analysis 或 optimization recommendation。

## Defaults and editability

Source-reference values 与 Riff demo defaults 分开保存。活动 demo preset 是
`wind-turbine-maintenance-demo-v1`：100 turbines、3 crews、1095 days、365-day warm-up、seed 2。
`95%` minimum availability 是 `user_declared_demo_target`，不是行业 benchmark。

所有公开模型参数以及 horizon、warm-up、seed 都可编辑。保存或 Reset all 会创建新的 experiment
revision；Reset all 回到活动 model revision 的整套默认值。机制、语义、单位、range、distribution
或 metric formula 的变化必须产生新的 model revision。

## Review semantics

Alignment revision 与 experiment revision 各自记录 human endorsement count、Agent attestation
count、open issue count 和 blocking issue count。默认 progression threshold 为至少一条有效
`project_owner` 人工认可且零个未解决 blocking issue。

这是定量工作流，不是可信/不可信状态。零 issue 只表示没有已记录的未解决异议；认可不等于
科学批准。Technical framed activation 只证明执行合同就绪。满足执行安全与 activation 后，
private draft 可运行，无需先满足人工工作流阈值。

## Required disclosure

每个 run、Evidence view、图表、导出和摘要都必须表达：

- synthetic inputs；
- one fixed seed for the current baseline；
- behavioral reproduction；
- unverified private draft；
- no real-farm calibration；
- no staffing recommendation。

模型/运行图表从相应 revision bundle 或 immutable run artifacts 直接生成，因此模型修订或运行
变化后自动更新，且必须保留源 identity 与 digest。

实现细节见 [`gate-1-wind-turbine-model-design.md`](gate-1-wind-turbine-model-design.md)，系统边界见
[`architecture.md`](architecture.md)，测试见 [`test-plan.md`](test-plan.md)。
