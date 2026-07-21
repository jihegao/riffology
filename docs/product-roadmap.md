# Product direction

## Released product

Riff 当前是面向业务对齐与证据审查的本地仿真工作台。已发布的完整切片是一个
`wind-turbine-maintenance` Evidence Studio：

```text
business question
  -> immutable brief and alignment revisions
  -> reviewed model bundle
  -> immutable experiment revision
  -> safe private-draft run
  -> generated evidence views
  -> issues and quantitative endorsements
  -> revised question or experiment
```

核心价值是保持业务要求、模型机制、实验配置、运行工件、异议和人工决定之间的结构化连续性。
模型代码只是可替换执行工件；业务意图、revision lineage 和 evidence identity 才是持久资产。

## Product principles

- 业务问题、约束、假设、非目标和指标先于实验运行。
- 重要事实进入结构化 project state，而不是只存在于对话或页面文字。
- 参数值改变创建 experiment revision；机制或语义改变创建 model revision。
- 图、表和回放从模型或运行数据生成，并随 revision/run 自动更新。
- 安全、隔离、可复现是执行前提；它们不自动赋予科学可信度。
- Issue 与 endorsement 是可计数、可追溯的 revision-scoped 记录，不是二元真值。
- 零 issue 只表示没有已记录的未解决异议。
- Agent 输出和页面投影都不能扩大源证据支持的 claim。

## Current claim scope

当前风机案例是基于 AnyLogic Field Service 结构证据的独立 Mesa 行为复现。输入为 synthetic，
Phase 1 使用 single seed，`95%` availability 是 demo constraint。结果适合检查机制、参数、事件
顺序、可复现性与证据链，不构成 real-farm calibration、uncertainty result 或 staffing
recommendation。

## Controlled expansion

后续扩展只有在保持现有边界时才成立：

1. 多 seed 与参数 sweep，输出不确定性而非单值建议。
2. 经版本化、范围明确的数据集绑定和 calibration evidence。
3. 从风机切片中提取可复用 model-package contract，而不弱化执行隔离。
4. Claim-scoped validation：按 model revision、dataset、scenario 和 operating range 积累证据。
5. 只有在授权、审计和发布策略明确后，才增加多用户或远程执行能力。

每一步都必须保持 private draft 可安全运行，同时让验证程度、适用范围和未解决 issue 明确可见。
