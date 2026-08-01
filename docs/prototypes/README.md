# Riff interface prototypes

- Status: active
- Role: active design
- Scope: non-normative visual supplements for Riff information architecture,
  interaction intent, and interface review
- Source of truth: [`product-requirements.md`](../product-requirements.md), active
  stage documents, and merged code/tests; this directory does not define
  approved product behavior or implementation status
- Last reviewed: 2026-08-01

## Purpose and authority boundary

本目录用于把文字设计转成可讨论、可版本化的界面原型，补充说明信息架构、
关键用户故事和交互意图。它不是产品需求、实现完成度或验收结果的权威来源。

当原型与 PRD、当前阶段设计、合并代码或测试发生冲突时，以后者为准。原型中
出现的按钮、状态和数据仅表达设计意图，不表示功能已经实现或通过验收。

## Prototype catalog

| Prototype | Role | Editable source | Preview |
| --- | --- | --- | --- |
| Project workbench overview | 支撑 Project 创建、计划与运行结果的整体工作台讨论 | [`project-workbench-overview.svg`](project-workbench-overview.svg) | [`project-workbench-overview.png`](project-workbench-overview.png) |
| User-story flow | 将主要用户故事延伸为六个相互衔接的界面状态 | [`user-story-flow.svg`](user-story-flow.svg) | [`user-story-flow.png`](user-story-flow.png) |
| Model design: generated structural views and auxiliary rail | 当前对话建模方向：LLM 根据 Model 动态生成类图、泳道图、数据流图等合适视图，右侧附加栏承载文件预览和 diff review | [`model-design-class-swimlane-rail.svg`](model-design-class-swimlane-rail.svg) | [`model-design-class-swimlane-rail.png`](model-design-class-swimlane-rail.png) |
| Riffology OpenChamber Workbench target | 已批准的产品壳迁移：左侧采用 Riffology 品牌的 OpenChamber/OpenCode 会话体验，右侧为带可折叠项目文件树的连续浏览器/文件查看区；Riff 继续持有领域权威 | [`openchamber-browser-workbench.svg`](openchamber-browser-workbench.svg) | [`openchamber-browser-workbench.png`](openchamber-browser-workbench.png) |

`model-design-class-swimlane-rail` 是当前 Model 设计讨论的主原型。此前以普通
结构化卡片为主的中间稿已被这一方向替代，因此不纳入本目录。

`openchamber-browser-workbench` 对应
[`Riffology OpenChamber Workbench migration plan`](../openchamber-browser-workbench-migration-plan.md)，
是已批准的分阶段目标界面。它仍不是当前实现或验收证据；各阶段只有在合并代码和
测试通过后才可声明交付。

## Interaction decisions captured

- 最左项目栏顶部的 `+` 用于新建项目；当前会话栏内提供“新会话”，顶栏提供“文件”入口。
- 浏览器导航、地址、来源信任与控制状态合并到全局顶栏，地址区域在最右文件栏前
  结束；页面与文件栏从顶栏下方平行展开。
- Browser Workbench 右侧不设置固定的控制权、动作追踪或权威说明横栏，页面与
  当前文件共用一个连续查看区；审批和动作反馈回到左侧会话上下文。
- 右侧项目文件树可隐藏或展开，点击 HTML、Markdown、JSON、CSV 后在同一查看区
  安全渲染；文件树和渲染结果不等同于持久化修改。
- Conversation 始终保留在左侧，Model/Project 工作区根据当前对象和任务动态变化。
- 进入 Model/Project 后，Conversation 从顶栏下方延伸到页面底部，消息输入框
  固定在最底部；不重复显示项目标题或“持续上下文”“模型结构讨论”等说明文字。
- 类图、泳道图和数据流图是 LLM 根据当前 Model 动态生成的结构化视图示例，
  不是固定栏目或穷举列表；LLM 可以按模型内容新增、改名或省略视图。
- 文件树、代码预览和 diff review 是稳定的平台审阅能力，与 LLM 生成的结构化
  视图保持明确边界。
- 文档、代码预览和 diff review 放在可折叠、可调整宽度的右侧附加栏；交互组织
  参考 OpenCode GUI，但不复制其品牌资产。
- diff 必须区分当前内容与拟议修改，并支持逐项审阅；Agent 回复本身不能等同于
  文件已经修改。
- Project 的直接 Run 控件独立于 Agent，可从计划、运行状态进入结果和诊断。
- Model 可视化试运行是技术预览，不等同于 Project 中冻结、持久化的正式实验。
- Core 原型保持领域无关，领域案例只作为 Model/Project 内容出现。

## Usage context and visual direction

这些原型面向产品、交互、前端和模型设计评审。视觉方向使用温暖中性色、深绿色
主操作和低噪声编辑器式工作区，让 Conversation、结构化模型和审阅辅助区保持
清晰层级。图形资产以通用类节点、关系、泳道、文件树、diff 行和状态标记为主，
不在 Core 中固化特定行业图标。

## Delivery constraints

- SVG 是可编辑源稿；同名 PNG 是评审和文档预览。
- 桌面端附加栏建议可折叠、可调整宽度；窄屏改为临时全屏抽屉，避免压缩建模画布。
- 状态不能只依赖颜色表达；类、关系、泳道和 diff 状态都需要文本标签。
- 原型不得包含真实凭据、Provider 内部信息、个人数据或未脱敏运行日志。
- 引入外部视觉参考时只借鉴交互模式，不复制商标、图标或受限资产。

## Maintenance and handoff

新增或更新原型时：

1. 使用语义化文件名，并同时提交 SVG 源稿和同名 PNG 预览；
2. 在上方目录中说明它是当前、支撑还是已替代方案；
3. 更新 `Last reviewed`，并写明它依赖的 PRD 或阶段设计；
4. 不覆盖仍需追溯的方案；需要替代时保留明确记录或移动到历史文档；
5. 运行 `bash scripts/check-docs.sh` 验证文档元数据和相对链接。

下一步交付给交互/前端时，应先把主原型拆成可验收的布局、折叠/调整宽度、
视图切换、文件预览和 diff 审阅状态，再与当前 Product shell 的真实 DOM 和 API
边界逐项对照。
