# Riff MVP 产品需求文档（PRD）

- Status: active
- Role: normative contract
- Scope: Riff 本地单用户 MVP，原交付代号为 Milestone A
- Source of truth: 本文档是产品目标与需求的唯一权威；合并代码与测试是实现状态的权威
- Last reviewed: 2026-07-25

## 1. 文档权威与职责分工

本文档是 Riff MVP 唯一的产品需求文档，统一定义已批准的产品结果、用户体验、
功能需求、架构边界、非功能需求、交付阶段和验收标准。

阶段设计、API 合同、ADR、Roadmap 和测试记录均为从属文档。它们可以细化实现，
但不能自行增加产品工作流、删除能力或覆盖本 PRD。本文档描述的目标不等于已经
实现；当前真实能力以已合并代码、测试和绑定具体版本的验收证据为准。

规范性措辞含义如下：

- **必须**：通过 MVP 验收不可缺少；
- **应该**：原则上应满足，偏离时必须记录经过评审的取舍；
- **可以**：可选行为，但不得削弱任何“必须”要求。

### 1.1 PRD、Roadmap、Architecture 与 Code 的权责

| 载体 | 回答的问题 | 权威范围 | 不负责 |
| --- | --- | --- | --- |
| **PRD** | Why + What：为什么做、为谁做、做什么、什么不做、如何验收 | 产品目标、范围、能力边界、需求和验收 | 排期细节、底层实现方案、完成状态 |
| **Roadmap** | When：按什么阶段和顺序交付 | 优先级、依赖关系、时间与阶段安排 | 修改产品需求、声明功能已经完成 |
| **Architecture / Stage Design / ADR** | How：如何满足已批准需求 | 技术分解、接口、安全边界、状态机和设计决策 | 扩大产品范围、替代 PRD、把设计当实现 |
| **Code + Test Evidence** | Reality：当前实际上能做什么 | 已合并行为、约束、回归测试和版本化证据 | 自行定义产品方向或未来承诺 |

发生冲突时：

1. 产品目标和范围以 PRD 为准；
2. 当前实现状态以合并代码和版本化测试证据为准；
3. Roadmap 只能安排 PRD 需求，不能创造新的产品事实；
4. Architecture 只能解释如何实现 PRD，不能改变 Why 或 What。

## 2. 产品概述

Riff 是一个本地运行的 AI 原生仿真工作平台。它帮助用户把业务问题、约束、
数据和不确定假设转化为可执行的仿真模型和可重复实验，再检查计算产物并沿用
同一上下文继续讨论。

产品最核心且不可破坏的形态是：

```text
左侧：持续、可恢复的仿真对话
右侧：当前 Model 或 Project 工作区
```

风机维护是第一个普通 Model 和示例 Project，不是独立产品模式、固定页面结构，
也不能成为通用产品类型命名的来源。

## 3. 问题与用户

### 3.1 要解决的问题

构建可用仿真通常要求用户在多个割裂工具中协调业务目标、建模假设、代码、输入
数据、实验配置、运行和解释。工具割裂导致用户难以判断：

- 某次修改是否真的持久化；
- 一次 Run 使用了哪些精确输入；
- Agent 的回答是讨论、建议，还是已经提交的产品状态；
- 当前结果是否足以支持某个业务判断。

### 3.2 MVP 用户

MVP 服务于一名本地 macOS 用户。该用户能够描述运营或决策问题并审阅仿真产物，
但不需要亲自搭建完整 Python/Mesa 工作区。多用户管理、组织权限和云端协作不在
MVP 范围内。

### 3.3 核心用户任务

用户必须能够：

1. 创建或打开一个通用仿真 Model；
2. 通过 OpenCode 驱动的 Agent 讨论并明确修改 Model；
3. 从一个技术上可执行的 Model 创建拥有固定副本的 Project；
4. 配置并运行可重复的可视化实验或批量实验；
5. 检查运行状态、输出文件和有界诊断事件；
6. 请求 Agent 分析输出，同时不把 Agent 文本误当作系统事实；
7. 关闭并重新打开应用后继续使用已支持的产品状态。

## 4. MVP 目标与成功标准

MVP 完成的定义是：共享双栏产品可以完整执行风机示例流程和通用 New Model
流程，且不依赖任何风机专用产品界面。

验收必须证明：

- 首页同时提供 Models、Projects、New Model 和 New Project；
- 存在由真实配置的 OpenCode provider/model 支持的持久命名多轮对话；
- 对话可以完成一次明确的 Model 修改或创建持久临时文档；
- Project 创建的是固定 Model 副本，之后不受源 Model 修改影响；
- 可以保存实验配置并完成一次产生持久输出的真实批量 Run；
- 声明 visual 能力的 Model 可以在右栏启动受平台管理的可视化 Run；
- start、cancel、download 和 trash 等直接控制不依赖 Agent 可用性；
- 重启后能够恢复 Models、Projects、对话、文档、配置和 Runs；
- OpenCode 不可用时进入明确只读状态，而不是生成伪造 Agent 回复；
- 界面明确区分“技术上可执行”“运行成功”“科学有效”“已校准”和“适合决策”。

## 5. 产品原则

1. **对话优先，但不只靠对话。** 对话是主要协作入口，资源管理和 Run 控制仍
   提供直接操作。
2. **弱文档约定。** 右栏展示当前对象有价值的状态，而不是强迫所有 Model 或
   Project 使用固定业务标签页。
3. **显式修改。** 讨论、提问和歧义表达不授权持久修改；明确命令可以授权
   允许范围内的修改。
4. **持久权威留在 Riff。** Agent 文本、OpenCode 状态、渲染文档、DOM、
   screenshot 和可视化子进程状态都只是上下文或投影，不是系统记录。
5. **平台通用，案例普通。** Core 代码不得假设风机、机组、维修队、仓库、
   飞机、风机指标、固定风机标签页或特定 bundle ID。
6. **冻结执行上下文。** 每个 Run 都记录实际使用的 Project 副本、执行描述、
   配置、样本计划和限制。
7. **诚实暴露边界。** provider、能力或恢复证据不可用时必须明确失败，不伪造
   Agent 结果，不推断成功。
8. **本地且轻量。** MVP 优先服务单用户本地 macOS 流程，不引入云、组织或
   发布市场机制。

## 6. 范围

### 6.1 MVP 范围内

- Models 和 Projects 两类独立的一等资源；
- 两类资源共享的双栏工作区；
- 每个 Model 或 Project 可以拥有多个持久命名对话；
- OpenCode provider/model 选择、session 协调和有界上下文；
- 渐进加载仿真 skill，以及对象范围内的 Agent action；
- 临时文档和对话附件；
- 可实际运行的通用 Python/Mesa Model 工作区；
- 技术可执行性检查和隔离的本地 Model 环境；
- 固定副本式 Project 创建；
- 命名实验配置、确定性样本计划和冻结 Run；
- 通用 batch 和 visual 执行；
- output 索引、下载、有界日志/事件、取消、清理和重启恢复；
- 有范围的 visual 嵌入，以及显式授权的 Playwright 检查/交互；
- SQLite 与经过校验的对象目录持久化；
- 可恢复资源回收站和永久删除前预览；
- 将已评审风机 Model 和示例 Project 作为普通领域内容导入。

### 6.2 非目标（Non-goals）

MVP 明确不建设：

- 通用 CAD 或专业几何建模系统；
- 万能浏览器 Agent 或可任意访问本机/互联网的 Playwright Agent；
- 完整 SaaS、Domain Pack 市场、计费、组织管理或分发平台；
- 通用低代码/无代码仿真搭建器；
- 自主科学验证、自动校准或自动证明模型正确性的系统；
- 面向用户的 Model 或实验版本管理；
- 一个 Project 内的多 active Model 切换；
- 右栏渲染内容的通用直接编辑器；
- 自动结果分析、自动优化、人员配置建议或自动决策结论；
- 固定 validation、issue、attestation、审批或 workflow-policy 产品；
- 逐帧仿真状态持久化或 batch replay 时间线；
- 多用户身份、角色、实时协作或云同步；
- Linux 或托管部署；
- 面向恶意 Model 代码的容器或虚拟机级强隔离；
- Model 发布流程；
- 以第二个用户自建业务 Model 作为 MVP 退出条件。

Playwright 在 MVP 中只是一项有边界的当前 Project visual 检查能力，不是通用
浏览器自动化平台，也不能获得任意页面、主机、credential 或本机文件权限。

## 7. Platform 与 Domain Pack 能力归属边界

该边界用于阻止风机、飞机等领域概念重新进入 Riff Core。它定义长期能力归属，
不表示所有列出的 Platform 能力都已在 MVP 中交付；例如 Platform 长期拥有
协作基础能力，但 MVP 仍然只支持单用户本地模式。

### 7.1 Platform（Riff Core）负责

| 能力 | Platform 责任 |
| --- | --- |
| User / Workspace | 通用用户与工作区边界、对象所有权、存储和未来协作扩展点；MVP 仅实现本地单用户。 |
| Agent runtime | 对话、provider/session、上下文、skill 路由、工具授权、action 记录和只读降级。 |
| Model lifecycle | 通用 Model 创建、文件工作区、技术检查、归档、回收站和可执行状态。 |
| Project lifecycle | 固定 Model 副本、Project 文档、配置、Runs 和 outputs 的通用所有权。 |
| Experiment | 通用输入 schema 承载、配置、seed/sweep 展开、样本计数和冻结计划。 |
| Run | batch/visual 生命周期、资源限制、取消、恢复、状态、进程监督和输出发布。 |
| Evidence substrate | output、digest、日志、事件、来源和 Run 绑定的通用存储与检索；不负责领域解释。 |
| Visual transport | 通用 visual health、broker、frame、WebSocket、撤销和有界 Playwright 能力。 |
| Collaboration substrate | 未来通用共享、权限和协作基础能力的归属；不属于当前 MVP 实现范围。 |

### 7.2 Domain Pack 负责

| 能力 | Domain Pack 责任 |
| --- | --- |
| Ontology | 领域实体、关系、术语和语义，例如风机、飞机、维修队或备件。 |
| Domain schema | 领域输入、业务约束、数据映射和输出语义。 |
| Domain Agent skills | 领域提示、skill、参考资料和专用分析流程。 |
| Validation rules | 领域完整性、业务规则、适用范围和科学/工程校验规则。 |
| Model compiler / adapter | 把领域描述转换或适配为 Platform 执行合同所需的 Model 资产。 |
| Visualization mapping | 把领域状态、事件和结果映射为领域可视化，而不是修改 Platform frame/broker。 |
| Domain evidence interpretation | 定义领域指标、证据含义、限制和允许的结论，不改变 Platform 的原始 Run 事实。 |
| Pack assets | 示例 Model、模板、数据映射、图标、文档和可选示例 Project。 |

### 7.3 依赖规则

1. Riff Core 不得导入 Domain Pack 的 ontology、schema、字段名、指标或固定页面。
2. Domain Pack 只能依赖公开的 Platform 合同；Platform 不反向依赖某个 Pack。
3. 只服务单一领域的能力默认留在 Domain Pack；只有证明跨领域稳定后才可提炼到
   Platform。
4. 风机和飞机能力必须以 Pack、Model、Project 或数据存在，不得以 Core 条件
   分支存在。
5. Platform 负责证据的身份、存储和可追溯性；Domain Pack 负责证据的领域含义
   和验证规则。
6. Domain Pack 不得绕过 ProductStoreV2、Run 冻结、资源限制、visual broker
   或 Agent 工具授权。

## 8. 信息模型

| 对象 | 产品含义 | 关键所有权规则 |
| --- | --- | --- |
| **Model** | 通用仿真源代码、执行描述、输入/输出声明和 Model 文档。 | 拥有自己的文件和对话；只有通过技术检查后才能被 New Project 选择。 |
| **Project** | 从一个固定 Model 副本创建的决策工作区。 | 拥有复制后的 Model、Project 文档、配置、Runs、outputs 和对话。 |
| **Conversation** | 属于一个 Model 或 Project 的命名持久用户/Agent 线程。 | 只能属于一个 owner；首个接受的用户 turn 后固定 provider/model。 |
| **Message** | Conversation 中的用户、Agent 或平台记录。 | Riff 持久化受支持的完整消息；OpenCode 不是唯一消息存储。 |
| **Temporary document** | 与消息关联的持久草稿、计划、分析、spec 或变更建议。 | 属于一个 owner，并具有 `draft`、`adopted`、`rejected`、`superseded` 等显式状态。 |
| **Attachment** | 用户提供、最初附属于 Conversation 的来源文件。 | 正式采用时复制到 owner 存储，并记录来源和用途。 |
| **Experiment configuration** | Project 中可编辑的命名参数、seeds 和可选 sweep。 | 没有面向用户的版本历史；每个 Run 冻结实际接受的值。 |
| **Run** | 一次冻结的 visual 或 batch 执行尝试。 | 只属于一个 Project，不跟随之后的配置或源 Model 变化。 |
| **Output** | 成功 Run 或诊断 Run 发布的受检文件或有界事件索引。 | 只能通过所属 Project/Run 投影访问，不得使用任意路径访问。 |

一个 Project 只拥有一个 Model 的固定副本。源 Model 后续变化不会修改既有
Project；删除源 Model 也不会删除 Project 已拥有的副本。

## 9. 功能需求

### 9.1 首页与资源生命周期

| ID | 需求 |
| --- | --- |
| FR-HOME-01 | 首页必须将 Models 和 Projects 作为两个独立一等集合展示，并显示基本状态和最近活动。 |
| FR-HOME-02 | 首页必须分别提供 **New model** 和 **New project** 操作。 |
| FR-HOME-03 | New Model 只必须要求名称和首个 Conversation 使用的 provider/model。 |
| FR-HOME-04 | New Project 只必须要求名称和一个技术上可执行的 Model。 |
| FR-LIFE-01 | rename、archive、restore、trash 和 delete 必须是直接资源操作，不依赖 Agent。 |
| FR-LIFE-02 | delete 必须先进入本地可恢复回收站；永久删除必须是独立显式操作，并预览受影响数据。 |
| FR-LIFE-03 | 资源操作必须保持所有权边界；删除源 Model 不得删除 Project 副本或无关本地文件。 |

### 9.2 共享双栏工作区

| ID | 需求 |
| --- | --- |
| FR-SHELL-01 | Models 和 Projects 必须打开在同一 shell 中：左侧为持久 Conversation，右侧为当前对象工作区。 |
| FR-SHELL-02 | 切换 Conversation 不得切换、重建或丢失当前 Model/Project 工作区。 |
| FR-SHELL-03 | 右栏必须支持 Markdown、代码、表格、JSON、图表和 Model 自带页面的通用 renderer。 |
| FR-SHELL-04 | 右栏必须使用弱约定，不得强制固定的风机、Evidence 或审批标签页。 |
| FR-SHELL-05 | Agent 只读或不可用时，直接 Run 和资源操作必须仍可使用。 |

### 9.3 对话、Skills、文档与附件

| ID | 需求 |
| --- | --- |
| FR-CONV-01 | 每个 Model 和 Project 必须支持多个可创建、重命名、切换、归档、恢复和安全删除的命名 Conversation。 |
| FR-CONV-02 | Riff 必须持久化 messages、受支持附件、document cards 和 action records；浏览器不得接收 provider credential 或 OpenCode session ID。 |
| FR-CONV-03 | Conversation 创建时必须选择 OpenCode provider/model，并在首个接受的用户 message 后锁定。 |
| FR-CONV-04 | OpenCode 可用时，Riff 必须绑定 Conversation 与 session；session 丢失时必须能从有界 Riff 上下文重建。 |
| FR-CONV-05 | 上下文必须来自权威对象摘要、最近消息、旧消息摘要、明确相关的文档/附件和选中的 skill instruction。 |
| FR-CONV-06 | Agent 必须提供仿真 skill catalog，仅在需要时加载完整 skill，并记录实际使用的 skill。 |
| FR-CONV-07 | provider 或 OpenCode 失败时，Agent 修改能力必须进入明确只读状态，不得伪造回复。 |
| FR-CONV-08 | 只有明确且允许的指令可以触发直接修改；修改必须 typed、owner-scoped、经过验证且原子提交。 |
| FR-CONV-09 | OpenCode 的 developer repo-root 与普通 Product 的精确 Model/Project workspace 必须是不同的工作目录 profile；Product backend 必须从 durable owner 派生目录并作用域化所有会话相关请求，前者不得给普通 Product Agent 产品源码、任意文件或命令权限。 |
| FR-CONV-10 | OpenCode 第一段 assistant 文本和中间 tool step 只能作为流式证据；Riff 必须在精确 session 不再 busy/retry、该 turn 的完整 assistant messages 均具备完成证据且相关 Riff action 已提交后，才可完成 durable turn 并撤销 scoped MCP capability。 |
| FR-CONV-11 | Conversation 必须以可恢复的 revisioned public runtime DTO 投影当前 Agent 状态、脱敏 activity 和等待中的 permission/question；SSE 只是便利通道，普通 GET 是断线后的恢复权威。浏览器不得接收上游 session/message/request ID、tool input/output、raw metadata、credential、path 或 capability。 |
| FR-CONV-12 | Stop、Retry、Resume 必须绑定精确 turn：Stop 仅中止当前 requestKey 并等待持久终态；Retry 使用新 requestKey 且只恢复 Riff 持久化的原始 intent；Resume 只回答该 turn 当前等待的 interaction，不得发起第二个 prompt。 |
| FR-CONV-13 | 用户可以按 turn 选择已发现的 primary Agent；Agent 选择必须进入 turn intent 与持久消息，active/waiting turn 期间锁定。Provider/model 仍按 Conversation 在首个接受的 message 后锁定。 |
| FR-CONV-14 | Skill 只能从服务端规范根目录及显式 Riff allowlist 发现，必须固定 catalog version 与 instruction digest，并按需加载、记录实际选择；Skill 文本不能扩大 tool、owner、object、operation、visual 或 credential 权限。OpenCode 的 ambient filesystem-backed `skill` tool 在 Product turn 中必须保持禁用。 |
| FR-CONV-15 | 每个需要工具的 turn 只能注册一个 opaque loopback Riff MCP，并从同一 owner/session-generation capability 的 sorted exact tool list 逐项启用；`*`、native file/command/Skill built-ins、ambient/plugin MCP 与第三方工具必须 deny-all。唯一 native 例外 `question` 只能经过 FR-CONV-12 的精确当前 turn Resume 边界回答，且不授予 Riff tool/object 权限。bind/prompt MCP 列表不一致、缺失、重复、乱序、伪造、跨 owner 或过期均须在 prompt 或执行前稳定拒绝，capability URL 与 credential 不得进入 prompt、transcript 或 browser DTO。 |
| FR-DOC-01 | Agent 输出可以创建链接在 message card 上的持久临时文档，但每次变更不得强制先创建临时文档。 |
| FR-DOC-02 | 临时文档必须具有显式生命周期；仅被渲染不得使其成为 Model/Project 权威状态。 |
| FR-ATT-01 | 附件最初必须属于 Conversation；采用时必须复制到 Model/Project 并记录来源和用途。 |
| FR-ATT-02 | 删除 Conversation 不得删除已经被 owner 采用的附件副本。 |

### 9.4 Model 工作区与技术检查

| ID | 需求 |
| --- | --- |
| FR-MODEL-01 | New Model 必须创建真实通用 Python/Mesa 工作区，而不是 placeholder 或风机专用模板。 |
| FR-MODEL-02 | Model 必须声明 inputs、可运行入口、状态/取消行为和 output files；metrics 和有界 domain events 可选。 |
| FR-MODEL-03 | Model 工作区可以包含 overview、spec、代码、输入/输出、结构或 Model 专属文档，无强制产品 schema。 |
| FR-MODEL-04 | Model 必须通过 syntax、interface、dependency、smoke-run、resource、cancellation 和 output 检查后才能被 New Project 选择。 |
| FR-MODEL-05 | “技术上可执行”只能表达薄执行合同已通过，绝不能表达正确、已校准、可信或适合决策。 |
| FR-MODEL-06 | Model 执行必须使用隔离环境、受限 owner 工作区、清理后的 credential、默认无网络、有限资源和取消能力。 |
| FR-MODEL-07 | Model 范围 Agent 工具不得访问其他对象、产品源码、任意 home 路径、环境 credential 或未采用引用。 |

### 9.5 Project 与实验配置

| ID | 需求 |
| --- | --- |
| FR-PROJ-01 | New Project 必须把所选 Model 当前文件和执行描述复制到 Project 自有存储。 |
| FR-PROJ-02 | Project 不得暴露 active Model 切换或 Model version browser。 |
| FR-PROJ-03 | Project Conversation 可以管理 Project 文档、配置、Runs 和分析，但不得修改复制后的 Model 代码、输入/输出定义或依赖。 |
| FR-EXP-01 | Project 必须支持可直接编辑的命名 experiment configuration。 |
| FR-EXP-02 | 配置可以表示单参数集、多 seed 或 parameter sweep；执行前必须显示预计 sample 数。 |
| FR-EXP-03 | 启动 Run 必须验证并冻结精确配置值、确定性样本计划、Project 执行身份和服务端限制。 |
| FR-EXP-04 | Riff 不得自动选择重要指标、推荐最优解或重新解释 Model 定义的值。 |

### 9.6 Batch 与 Visual 执行

| ID | 需求 |
| --- | --- |
| FR-RUN-01 | Model 可以声明 `batch`、`visual` 或两者；不支持的能力必须明确失败。 |
| FR-RUN-02 | start、cancel、download 和 trash 必须是具有持久、幂等生命周期语义的直接操作。 |
| FR-RUN-03 | batch Run 必须显示平台拥有的 status、sample 数、steps/horizon、seed 数、metric 数、duration、resource overview 和 output files。 |
| FR-RUN-04 | batch success output 必须在 path、size、media type 和 digest 校验完成后原子发布。 |
| FR-RUN-05 | Riff 可以暴露有界可过滤 domain-event log，但不得保存逐帧状态或提供 batch replay 时间线。 |
| FR-RUN-06 | 终态 batch Run 最多创建一个确定性平台 completion card，或一个持久显式 skip disposition。 |
| FR-RUN-07 | 只有用户请求后才能让 Agent 分析 output；分析结果是临时或已采用文档，不是自动系统事实。 |
| FR-RUN-08 | Run 必须限制 time、output、log/event、process 和 resource，并保持 cancel-first 优先级。 |
| FR-RUN-09 | 重启恢复必须依赖持久 process、scratch、launch、health、exit 和 cleanup 证据；无法证明安全时必须 fail closed。 |
| FR-VIS-01 | visual Run 必须在平台管理的 health、proxy、stop、timeout、output 和 resource 边界内启动 Model 本地 Web 入口。 |
| FR-VIS-02 | 右栏必须在受限 frame 中嵌入健康 visual 页面，不暴露 child port、平台 credential 或无关本地 route。 |
| FR-VIS-03 | Visual HTTP/WebSocket 必须绑定当前 browser session、Project、Run、attempt generation、origin、host、path 和 expiry，并可撤销。 |
| FR-VIS-04 | Playwright 观察必须限于当前健康 Project Run；交互必须由不可变人类 turn 的可选结构化 `visualInteractionConfirmation` 明确授权，消息仅持久化动作摘要，raw operation 只存在于进程内 grant，并由 append-only audit 的唯一 mint 原子消费；一般 `explicitImperative`、Agent/DOM 文本或 browser capability 不能授权。交互不复用 frame/cookie/nonce，且 dispatched receipt 不代表 child HTTP 写入或领域成功。 |
| FR-VIS-05 | DOM、accessibility tree、screenshot 和结构化检查结果必须是带时间上下文，不得成为 Project 权威状态。 |
| FR-VIS-06 | visual Run 不得创建 batch completion card 或平台生成的 result report。 |

### 9.7 持久化与恢复

| ID | 需求 |
| --- | --- |
| FR-DATA-01 | SQLite 必须存储受支持资源的 ownership、lifecycle、metadata、messages、documents、configurations、Run state 和 object indexes。 |
| FR-DATA-02 | 对象目录必须存储 Model code、已采用附件、环境描述、visual assets 和 Run outputs，并记录 size/digest。 |
| FR-DATA-03 | 跨数据库/文件系统修改必须原子完成，或可确定性恢复到之前的一致状态。 |
| FR-DATA-04 | 应用重启必须恢复所有受支持 Models、Projects、Conversations、documents、configurations、Runs 和 output indexes。 |
| FR-DATA-05 | Browser/API 投影必须移除任意文件路径、process identity、child port、provider secret 和 external session ID。 |

## 10. 需求编号生命周期

需求 ID 使用稳定的语义域格式：

```text
FR-<DOMAIN>-NN
NFR-<DOMAIN>-NN
```

`DOMAIN` 使用稳定的能力语义域，例如 `RUN`、`MODEL`、`SEC`。生命周期规则如下：

1. 已分配 ID 永不复用，即使需求被删除或废弃；
2. 仅编辑措辞但语义不变时保留原 ID；
3. 范围、行为或验收语义发生实质变化时创建新 ID；
4. 废弃需求保留原 ID，并记录 `deprecated`、原因和替代 ID，不从历史中静默删除；
5. Stage Design、Architecture、API、测试和 Issue 应引用稳定 PRD ID；
6. requirement count 只统计 active requirement，不通过重新编号制造连续序号；
7. ID 变更必须在 PR review 中单独列出，不能混在普通文字调整里。

## 11. 核心用户流程

### 11.1 创建并完善 Model

1. 用户从 Home 选择 **New model**，输入名称并选择 provider/model。
2. Riff 创建 Model 工作区和首个 Conversation。
3. 用户描述仿真问题；Agent 使用相关仿真 skill，并可以创建文件或临时计划。
4. 用户明确授权后，系统原子应用允许的修改。
5. Riff 运行薄技术检查，只有全部必需检查通过后才标记技术上可执行。

### 11.2 创建 Project 并运行实验

1. 用户选择 **New project**，输入名称并选择一个可执行 Model。
2. Riff 创建 Project 自有固定副本。
3. 用户或 Project Agent 创建命名实验配置。
4. 用户检查预计 samples，并启动 batch 或 visual Run。
5. 右栏显示直接状态和操作；Riff 持久化精确冻结的执行上下文。
6. 成功 batch Run 发布受检 outputs 和一个 completion card。
7. 用户提出请求后，Agent 检查 outputs 并创建分析文档。

### 11.3 失败或重启后继续

1. Riff 重启后从 SQLite 和受检对象存储重建受支持状态。
2. 运行中任务只能根据持久 ownership/process 证据恢复；歧义状态 fail closed。
3. OpenCode session 丢失时，Riff 使用有界上下文创建新的 backend-only session。
4. provider 仍不可用时，Conversation 明确只读，已保存资源和直接 Run 操作可用。

## 12. 目标架构

### 12.1 逻辑架构

```text
React/Vite 浏览器
  ├─ Models/Projects 首页
  └─ 共享双栏工作区
       ├─ Conversation client
       ├─ 通用文档/数据 renderer
       └─ 受限 visual frame
             │
             ▼
Node.js/TypeScript Riff backend（唯一 browser-facing 权威）
  ├─ HTTP/API 投影与直接操作
  ├─ Conversation/session/context 协调
  │    └─ loopback OpenCode adapter
  ├─ scoped Agent tools 与 simulation-skill loader
  ├─ Model workspace 与 technical checker
  ├─ ProductStoreV2 mutation/recovery 边界
  ├─ deterministic experiment planner
  ├─ Run dispatcher 与 batch/visual supervisors
  └─ scoped visual access broker 与 Playwright adapter
             │
      ┌──────┼──────────────┐
      ▼      ▼              ▼
   SQLite  受检对象目录    受限 Model/Run 进程
                           （Python/Mesa 或 Model Web 入口）
```

### 12.2 组件职责

| 组件 | 负责 | 不得成为 |
| --- | --- | --- |
| Browser | 渲染投影、收集显式命令、提供直接操作和承载受限 visual frame。 | 持久权威、secret holder 或任意文件/进程客户端。 |
| Riff backend | 验证本地 browser capability、校验命令、协调服务和输出有界投影。 | 绕过 Store ownership 或 execution admission 的旁路。 |
| ProductStoreV2 | 拥有 SQLite 状态、受检 object reference、原子修改、receipts 和重启恢复。 | 科学验证器或 Agent memory 替代品。 |
| OpenCode adapter | 发现 provider/model、协调 backend-only session、发送有界上下文和传递真实 Agent 结果。 | 唯一消息存储或产品修改权威。 |
| Scoped tools/skills | 给单个 active turn 最小 owner-specific capability 和按需 instruction。 | 对其他对象、产品源码、credential 或任意工具的环境访问。 |
| Experiment planner | 校验 canonical input，并确定性展开 seed/sweep 为冻结样本计划。 | 优化器或推荐系统。 |
| Run dispatcher/supervisors | claim 已准入 Run、启动受限进程、执行生命周期/限制并发布受检 outputs。 | 直接 browser process API 或无追踪后台 runner。 |
| Visual broker/Playwright adapter | 对单个健康 visual attempt 提供短期 scoped access 和有界显式检查。 | 通用 localhost proxy 或持久 Project 权威。 |

### 12.3 权威与信任边界

权威顺序为：

```text
经过验证的 command
  -> ProductStoreV2 transaction 与受检 bytes
  -> 有界 backend projection
  -> browser / OpenCode / visual / Playwright context
```

- SQLite 记录和 digest 校验对象 bytes 是权威；
- OpenCode session、Agent 文本、DOM、screenshot 和子进程内存不是权威；
- 只有 backend 可以把明确用户指令转换成 owner-scoped typed mutation；
- Project execution 只准入精确 Project Model 副本和冻结配置/计划/限制；
- Model 和 visual 使用独立受限进程、受限目录、清理环境、有限资源且默认无网络；
- Visual access 使用不同 platform/broker origin 和短期 capability；精确 network
  与 cookie 行为由已实现 Stage 3 设计和 ADR 约束，Stage 4 不得弱化。

### 12.4 部署边界

MVP 在本地 macOS 运行：

- React/Vite 提供 browser client；
- Node.js/TypeScript 进程拥有 API、ProductStoreV2、Agent 协调和 Run dispatch；
- OpenCode 只通过明确配置的 loopback 边界访问；
- Python/Mesa 和 visual 入口作为独立受监督进程运行；
- credential 只保留在 backend 和本地未提交环境配置中。

## 13. 非功能需求

| ID | 需求 |
| --- | --- |
| NFR-AUTH-01 | 每次持久写入必须在 backend/Store 边界校验 owner、object、operation 和当前 lifecycle。 |
| NFR-ATOM-01 | 直接修改和 success output 发布必须跨数据库与自有文件原子完成，或可确定性恢复。 |
| NFR-REC-01 | Startup 必须先协调未完成 mutation 和 execution attempt，再接受冲突的新任务。 |
| NFR-FAIL-01 | 缺失、冲突、过期或不支持的权威证据必须 fail closed，并返回明确可见错误。 |
| NFR-SEC-01 | Provider credential、ambient credential、OpenCode session ID、process identity、任意 path 和 child port 不得投影给 browser。 |
| NFR-SEC-02 | Model/Run 进程必须获得最小 path 权限、清理环境、默认无网络、取消能力和有限 resource/output/time。 |
| NFR-SEC-03 | Playwright 必须在全新隔离 browser context 中仅连接当前健康 Project visual peer；不得接受 caller URL、raw selector、script、download、跨 peer redirect 或共享 browser state，不得发送 credential/cookie/authorization，也不得把页面 artifact 作为工具结果投影。 |
| NFR-OC-01 | OpenCode 必须具有显式、绝对且规范化的默认 `OPENCODE_WORKDIR`，并显式固定 `OPENCODE_EXPECTED_VERSION`（启动脚本默认 `1.18.4`）；Product backend 必须从 durable Conversation owner 派生精确 Model workspace 或 Project `model-snapshot/`，并在每个 location-sensitive 请求前重新验证 loopback `/global/health` 版本与 directory-scoped `/path`。缺失、非目录、symlink 歧义、目录或版本漂移必须只让 Agent 明确只读，不能让 Product launcher 退出，也不得回退到调用目录、其他目录或 provider。 |
| NFR-SCOPE-01 | Conversations、documents、attachments、tools、Runs、outputs、visual capabilities 和 Playwright 必须 owner-scoped，并拒绝跨对象使用。 |
| NFR-IDEM-01 | 重试 create/start/cancel/finalize command 不得产生重复持久副作用。 |
| NFR-HONEST-01 | UI 和 Agent 必须区分 target、pending、running、completed、cancelled、failed、read-only 和 recovery-required，不乐观推断。 |
| NFR-COMPAT-01 | 历史 Gate/wind/queue artifact 可在分阶段替换期间共存，但不得定义当前产品行为或授权删除无关内容。 |
| NFR-TEST-01 | 每个阶段必须包含 contract test、failure/negative test、适用的 restart check、独立评审和可见行为 browser evidence。 |

## 14. 交付阶段与当前实现快照

阶段保持顺序依赖，因为后续能力依赖前序权威和持久化合同。以下状态只是
2026-07-25 的导航快照，不能替代合并代码与 GitHub 证据。

| 阶段 | 产品切片 | 当前快照 |
| --- | --- | --- |
| **1 — 数据基础** | SQLite/对象目录、ownership、原子 mutation/recovery、lifecycle、固定副本 Project primitive。 | 已实现并合并。 |
| **2 — Agent 与 Model 工作区** | 持久 Conversations、OpenCode session/context、skills/scoped tools、documents/attachments、通用 Model workspace、technical checks。 | 已实现、合并，并完成真实 provider 两轮验收。 |
| **3 — Project 与执行** | 公开 Project 创建、实验计划、冻结 Runs、batch/visual、直接操作、outputs/events、scoped visual/Playwright、普通风机导入。 | 已实现并验收。固定副本 Project、planning、batch lifecycle、cancel/recovery/cards、visual Store/supervision/dispatch、browser broker/frame/WebSocket、scoped Playwright、通用 output/download/events/direct controls、跨 authority 撤销、普通风机 Model/Project/Experiment 导入，以及创建 Project、编辑 Experiment、真实运行、下载与重启恢复的窄 Product Chromium 场景均完成。 |
| **4 — 共享产品 shell** | Models/Projects 首页、最终双栏 UX、动态右栏、Conversation 管理/cards、offline/recovery UX、旧产品清理、完整风机 browser 验收。 | A4-6 本地 branch gate 与最终独立复审已通过；最终聚合中的连续 Chromium 12 步场景为 31.2s：真实两 Conversation、两文档/附件、Project CAS、两 batch、outputs/events/download、请求后分析、受限 visual、同根 restart、provider-down 无伪回复/direct Run，以及桌面/窄屏、CDP scale 2 下真实键盘切换、无横向溢出和零 console/page error。门禁为 backend 598 total/597 passed/zero failed/one optional skip、Web 28/28、production-entry 1/1、build、retained Chromium 18/18；provider discovery 与显式授权 fallback 见 [`a4-6-exit-evidence.md`](a4-6-exit-evidence.md)。合并与 `main` 复跑仍按顺序执行，Issue #15 仍 OPEN。 |

详细切片状态记录在
[`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md)、
[`milestone-a4-shared-product-shell-design.md`](milestone-a4-shared-product-shell-design.md)、
仓库 [README](../README.md) 和绑定版本的测试记录中。

## 15. MVP 退出验收

一个真实 browser 场景必须证明：

1. Home 展示 Models、Projects、New Model 和 New Project；
2. 风机 Model 作为普通 Model 在共享双栏 shell 中打开；
3. 真实多轮 OpenCode Conversation 修改允许的 Model 状态或创建持久临时文档，
   右栏反映已提交状态；
4. 第二个命名 Conversation 使用自己选择的 provider/model，来回切换不丢失
   messages、attachments 或 documents；
5. New Project 只接受名称和风机 Model，并创建固定副本；
6. Project Conversation 创建或修改实验配置；
7. 用户启动真实风机 batch Run，并看到 status、受检 outputs 和有界 domain
   events，不提供逐帧 replay；
8. 用户请求后，Agent 读取 Run outputs 并创建分析文档；
9. visual-capable Model 启动受管理 visual Run，页面可在受限右栏 frame 中使用，
   且不暴露 child endpoint；
10. 重启恢复受支持 Models、Projects、Conversations、documents、
    configurations、Runs 和 outputs，并安全协调未完成工作；
11. OpenCode 不可用时进入明确只读模式，绝不生成伪 Agent 回复；
12. New Model 创建可用通用 Model workspace；第二个完整业务 Model 留给
    post-MVP 验证。

## 16. 风险与声明边界

| 风险 | MVP 边界或缓解方式 |
| --- | --- |
| Agent 超出用户意图行动 | 要求明确命令、typed owner-scoped tools、capability revocation 和原子验证。 |
| Model 代码访问本机数据 | 限制 process path/environment/network/resource，并明确这不是恶意代码强隔离。 |
| Run 结果无法复现 | 冻结 Project copy、execution description、configuration、sample plan、limits 和 outputs。 |
| Visual child 接触 Platform 权威 | 使用隔离 loopback topology、不同 origin、短期 capability、不投影 child port 并支持撤销。 |
| Provider/session 不可用 | 持久化 Riff context，可用时重建 session，不可用时诚实只读。 |
| 历史 wind/Gate 文档重新主导产品 | 明确标记 historical，所有产品冲突以本 PRD 为准。 |
| Domain Pack 概念渗入 Core | 执行 Platform/Domain Pack 依赖规则，并禁止 Core 使用领域 schema/条件分支。 |
| 成功执行被误当作有效决策 | 明确区分技术、执行、科学、校准和决策声明。 |

## 17. 支撑文档

以下文档细化或记录本 PRD，但不能替代它：

- [`milestone-a1-data-foundation-design.md`](milestone-a1-data-foundation-design.md)：
  已实现的 Stage 1 存储与 mutation 设计；
- [`milestone-a2-agent-workspace-design.md`](milestone-a2-agent-workspace-design.md)：
  已实现的 Stage 2 Agent 与 Model workspace 设计；
- [`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md)：
  已实现并合并的 Stage 3 执行设计和实现台账；
- [`milestone-a4-shared-product-shell-design.md`](milestone-a4-shared-product-shell-design.md)：
  Stage 4 共享产品 shell 的 A4-0 设计门禁、目标合同和追踪矩阵，以及
  A4-1 至 A4-5 的窄切片实现台账；
- [`milestone-a4-5-retirement-manifest.md`](milestone-a4-5-retirement-manifest.md)：
  A4-5 tracked-code 退役的身份、版本、摘要、替代证据和明确排除范围；
- [`architecture.md`](architecture.md)：更深入的当前与历史架构说明；
- [`backend-api.md`](backend-api.md)、[`opencode-bridge.md`](opencode-bridge.md)
  和 [`ui-workflow.md`](ui-workflow.md)：子系统合同；
- [`test-plan.md`](test-plan.md)：当前及历史验收证据；
- [`adr/README.md`](adr/README.md)：Stage 3 派生决策清单。

历史 Gate 文档和 [`product-roadmap.md`](product-roadmap.md) 只用于追溯和保留
风机 Model 证据。

## 18. 变更治理

1. 产品范围、工作流、用户可见声明或验收发生变化时，必须先于或同时更新 PRD；
2. Roadmap 只能调整已批准需求的顺序、依赖和阶段，不得覆盖 PRD；
3. Stage/API/ADR 可以加强内部正确性与安全，但必须链接稳定 PRD requirement ID；
4. 文档批准不代表已实现，只有相关代码、测试、评审和 merge 后才能更新实现状态；
5. requirement ID 必须遵循第 10 节生命周期规则；
6. 旧产品删除需要显式 tracked-code 和 local-artifact 审计，任何文档都不授权
   删除无关未跟踪用户文件。
