# OpenCode 项目扩展包

- Status: active
- Role: project extension guide for Project Modeling Requirements and simulation visualizations
- Scope: 仓库内 Project Modeling Requirements、模型设计可视化与仿真推演可视化
- Source of truth: `.opencode/skills/*/SKILL.md` 与 `AGENTS.md`
- Last reviewed: 2026-08-12

本仓库携带一个项目级 OpenCode 扩展包。OpenCode 从项目根目录向下发现
`.opencode/skills/<name>/SKILL.md`，因此在本仓库运行 `opencode` 即可使用，
无需安装 Riff 后端桥接服务。

| 能力 | Skill | Slash command | 输出 |
| --- | --- | --- | --- |
| Modeling Requirements | `simulation-domain-requirements` | `/domain-brief` | 可审查 Markdown 领域简报，可按明确授权写入 Project canonical path |
| 模型设计 | `simulation-model-visualization` | `/model-design-html` | 独立 HTML 设计文档 |
| 推演回放 | `simulation-run-visualization` | `/run-replay-html` | 独立 HTML 回放文档 |

两种可视化都遵循同一顺序：先落盘 HTML，随后以 `--open` 调用系统默认的外部浏览器。
它们不再嵌入 Riff Product iframe，也不连接本地服务。生成文件默认放到已忽略的
`outputs/model-design/` 或 `outputs/simulation-replay/`；如需长期审阅，应明确指定
受版本控制的目标路径。

示例：

```bash
opencode
# 在交互界面执行：
/model-design-html 为风机维护模型生成设计页
/run-replay-html 用这次 Run 的 domain-events.jsonl 生成回放页
```

输出 HTML 是数据/规范的可视化投影，不是 Model、Project 或 Run 的权威记录，不能据此
声明模型已校准、已验证或适合决策。

活跃产品语义要求 Project 内的 Modeling Requirements 使用唯一 canonical path
`requirements/modeling-requirements.md`。官方不可变 Example Project Template 必须
包含该文件；Blank Project 不隐式创建 Modeling Requirements 或其他领域记录。Conversation
临时文档是草稿生命周期的一部分，不属于 Template，只有明确的 Project add、import 或
write 动作才能采用到 canonical path。
