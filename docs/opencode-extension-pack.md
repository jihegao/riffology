# OpenCode 项目扩展包

- Status: active
- Scope: 仓库内 OpenCode 领域需求、模型设计可视化与仿真推演可视化
- Source of truth: `.opencode/skills/*/SKILL.md` 与 `AGENTS.md`

本仓库携带一个项目级 OpenCode 扩展包。OpenCode 从项目根目录向下发现
`.opencode/skills/<name>/SKILL.md`，因此在本仓库运行 `opencode` 即可使用，
无需安装 Riff 后端桥接服务。

| 能力 | Skill | Slash command | 输出 |
| --- | --- | --- | --- |
| 领域要求 | `simulation-domain-requirements` | `/domain-brief` | 可审查 Markdown 领域简报 |
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
