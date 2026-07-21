# Evidence Studio projection contract

## One evidence surface

`/` 始终呈现 Wind-turbine maintenance Evidence Studio。查询字符串不切换产品。页面分为
alignment context 与 workbench；workbench 提供 Brief、Model、Experiment、Issues & review、
Run 和 Evidence 六个 tab。窄屏使用显式 pane selector，并保留同一 project state。

进入项目后必须显式选择并 attach 一个声明式本地 actor。页面刷新或后端重启后不会静默恢复
actor 身份。

## Source-bound views

- Brief 和 alignment 读取摘要绑定的不可变 business revisions。
- Model 的 entity/state、transition、process、schema 与 traceability 读取 model bundle sources。
- Experiment 读取当前 experiment revision 和活动 model schema；edit/reset 创建新 revision。
- Issues & review 读取权威 issue history、attestation pages 和定量 workflow counts。
- Run 读取持久 run state 与 admission-time labels。
- Evidence 的 KPI、事件、回放、swimlane、summary 和下载均来自选中 run 的摘要绑定工件。

前端不保存手写图表数据。选择新的 model revision 或 run 时，API 源变化会自动更新视图；
每个图表都保留等价的文本或表格表示和源身份。

## Evidence integrity

投影校验 project、brief、alignment、model、experiment、run、source-set 和 artifact digests。
分页响应必须连续且身份一致；缺页、重复、摘要失配、unknown event 或超界值会显示明确的不可用
原因，不会以部分内容冒充完整证据。

`legacy_frameless` 仅表示已提交的早期风机运行记录没有 replay frames。它是历史风机证据的
只读验证分支：UI 明确显示回放不可用，不能生成该格式的新工件，也不是运行模式或 fallback。

## Review and claim language

Issues 与 endorsements 作为 revision-scoped 数量显示。零 issue 的固定含义是没有已记录的未
解决异议；它不表示正确或有效。Technical activation 只说明 framed execution contract 已就绪，
不表示 endorsement、trust 或 scientific approval。

Evidence boundary 始终显示 Synthetic data、Single seed、Behavioral model、No recommendation、
`private_draft` 和 `draft_unverified`。页面、自动摘要或图表不得扩大这些声明。

## Browser acceptance

真实 E2E 覆盖显式 actor attachment、六个 tab、29 个实验字段、edit/reset 新 revision、issue
创建与历史、两类 revision 的定量认可、202 run、完整 KPI/event/replay、8 个下载、后端重启后
持久化，以及 820px 与 390px/200% zoom 的语义可用性。

```sh
cd web
npm test
npm run build
npm run test:e2e
```
