# Durable project-state contract

## Authority and persistence

后端是 project、business revision、issue、attestation、experiment revision、command
idempotency、workflow calculation 和 browser-safe projection 的唯一权威。Mesa 只负责已绑定
风机模型的执行与工件；浏览器状态和说明文字只是投影。

项目使用本地文件持久化。`project.json` 是当前快照，项目事件 append-only；brief、alignment、
experiment、issue history 和 attestation 都按不可变记录或显式 superseding event 保存。原子
promotion、摘要校验和 restart recovery 防止半写入记录变成当前事实。

## Identities and commands

`project_id` 持久存在；浏览器 `session_id` 只表达一次显式 actor attachment。所有 mutation
命令绑定 `command_id`、project、session、`base_snapshot_revision` 和 payload。重复命令返回原
结果；同一 ID 不同 payload 被拒绝；过期 base revision 返回 conflict。

项目明确绑定 brief、alignment、model、experiment 和 run identities。任何跨项目、失配、
缺失或未验证上游身份都 fail closed。参数编辑和 reset 均产生新 experiment revision。

## Quantitative workflow

Issue 是 revision-scoped 的异议记录，包含 severity、blocking 标记、状态、评论和解决原因。
Attestation 是 actor、role、scope、subject revisions、decision 和 rationale 的不可变记录。

默认 progression 条件分别针对 alignment revision 与 experiment revision：

- 至少 1 条有效 `project_owner` 人工 workflow endorsement；
- 0 个未解决 blocking issue。

UI 展示的是 endorsement count、all-open count、blocking count、non-blocking count 和派生阈值。
零 issue 只表示没有已记录的未解决异议。Agent attestation 单独计数，不能冒充人工认可；
endorsement 也不是可信、科学有效或正确的定性状态。

## Private-draft execution

技术 framed activation 就绪后，`private_draft` 可以在 workflow threshold 未满足时运行。后端在
admission 时冻结 subject revisions、计数与 `workflow_policy_met` 或
`workflow_policy_unmet` 标签。之后新增的 issue 或认可不会改变旧 run；需要新的政策事实时必须
启动新 run。

每个 draft 还带 `draft_unverified`、`synthetic_inputs`、`single_seed` 和
`no_staffing_recommendation` 声明。执行安全是硬门，人工认可不是执行许可，也不会升级科学声明。

## Projection and recovery

公开投影只含有界摘要、身份、计数和 artifact references。完整事件使用分页或 SSE；revision
gap 触发 reload，而不是猜测 patch。重启后恢复 current pointers、命令结果、问题历史、认可、
运行和工件，不恢复隐式浏览器 actor。

测试与 API 见 [`test-plan.md`](test-plan.md) 和 [`backend-api.md`](backend-api.md)。
