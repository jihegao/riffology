# Riff MVP Product Requirements Document

- Status: active
- Role: normative contract
- Scope: Riff local single-user MVP, formerly delivered as Milestone A
- Source of truth: this document for product scope and requirements; merged code and tests for implementation status
- Last reviewed: 2026-07-25

## 1. Document authority

This is the single product requirements document for the Riff MVP. It governs
the approved product outcome, user experience, functional requirements,
architecture boundaries, non-functional requirements, delivery stages, and
acceptance criteria.

Detailed stage designs, API contracts, ADRs, and test records are subordinate
documents. They may refine implementation details but cannot add a product
workflow, remove a capability, or override a requirement in this PRD. A target
described here is not proof that it is implemented; current behavior is
established by merged code, tests, and revision-scoped acceptance evidence.

Normative terms use their ordinary requirements meaning:

- **must**: required for MVP acceptance;
- **should**: expected unless a reviewed trade-off is recorded; and
- **may**: optional behavior that must not weaken a `must` requirement.

## 2. Product summary

Riff is a local AI-native simulation work platform. It helps a user turn a
business question, constraints, data, and uncertain assumptions into an
executable simulation model and repeatable experiments, then inspect outputs
and continue the same conversation.

The primary product invariant is:

```text
left: persistent simulation conversation
right: the current model or project workspace
```

The wind-turbine maintenance case is the first ordinary model and example
Project. It is not a separate product mode, a fixed page schema, or a source of
generic product type names.

## 3. Problem and user

### 3.1 Problem

Building a useful simulation normally requires a user to coordinate business
intent, modeling assumptions, code, input data, experiment configuration,
execution, and interpretation across disconnected tools. That fragmentation
makes it difficult to know what changed, which inputs a run used, and whether
an Agent response is a durable product change or only discussion.

### 3.2 MVP user

The MVP serves one local macOS user who is able to describe an operational
question and review simulation outputs but need not manually assemble the
entire Python/Mesa workspace. Multi-user administration, organizational
permissions, and cloud collaboration are outside MVP.

### 3.3 Core jobs

The user must be able to:

1. create or open a generic simulation Model;
2. discuss and deliberately change that Model with an OpenCode-backed Agent;
3. create a Project that owns a fixed copy of an executable Model;
4. configure and run repeatable visual or batch experiments;
5. inspect run status, outputs, and bounded diagnostic events;
6. ask the Agent to analyze outputs without treating prose as system state; and
7. close and reopen the application without losing supported product state.

## 4. MVP outcome and success criteria

The MVP is complete when the shared two-pane product can perform the full wind
example journey and the generic New Model journey without using a wind-specific
product surface.

Acceptance must demonstrate:

- a Models/Projects home and functional New Model/New Project actions;
- persistent, named, multi-turn conversations with an actual configured
  OpenCode provider/model;
- an explicit Model change or persistent temporary document created through a
  conversation;
- fixed-copy Project creation and source-Model isolation;
- a saved experiment configuration and a real batch run with durable outputs;
- a managed visual run in the right pane for a Model that declares visual
  capability;
- direct start, cancel, download, and trash controls that do not depend on
  Agent availability;
- restart restoration of Models, Projects, conversations, documents,
  configurations, and runs;
- explicit read-only Agent behavior when OpenCode is unavailable; and
- clear claim boundaries: technical executability and successful execution do
  not imply scientific validity, calibration, or decision suitability.

## 5. Product principles

1. **Conversation first, not conversation only.** Conversation is the main
   coordination surface, while direct resource and run controls remain
   available.
2. **Weak document conventions.** The right pane renders the useful state of
   the selected object; it does not force every Model or Project into a fixed
   set of business tabs.
3. **Explicit mutation.** Discussion, questions, and ambiguous language do not
   authorize durable changes. Clear imperative instructions may.
4. **Durable authority stays in Riff.** Agent prose, OpenCode state, rendered
   documents, DOM state, screenshots, and visual-child state are context or
   projections, not the system of record.
5. **Generic product, ordinary examples.** Product code must not assume wind
   turbines, crews, depots, wind metrics, fixed wind tabs, or bundled wind IDs.
6. **Frozen execution context.** A Run records the exact Project copy,
   execution description, configuration, plan, and limits it used.
7. **Honest boundaries.** Riff fails visibly when a provider, capability, or
   recovery proof is unavailable. It does not fabricate Agent output or infer
   success.
8. **Local and lightweight.** MVP optimizes for a single local macOS workflow,
   without introducing cloud, organization, or publishing machinery.

## 6. Scope

### 6.1 In scope

- Models and Projects as separate first-class resources;
- a shared two-pane shell for both resource types;
- multiple persistent named conversations per Model or Project;
- OpenCode provider/model selection, session coordination, and bounded context;
- progressive simulation-skill loading and owner-scoped Agent actions;
- temporary documents and conversation attachments;
- a functional generic Python/Mesa Model workspace;
- technical executability checks and isolated local Model environments;
- fixed-copy Project creation;
- named experiment configurations, deterministic sample planning, and frozen
  Runs;
- generic batch and visual execution;
- output indexes, downloads, bounded logs/events, cancellation, cleanup, and
  restart recovery;
- scoped visual embedding and explicit Playwright inspection/interaction;
- SQLite plus checked object-directory persistence;
- recoverable resource trash and explicit permanent-deletion preview; and
- import of the reviewed wind Model and an ordinary example Project.

### 6.2 Out of scope

- user-visible Model or experiment version management;
- multiple active Models inside one Project;
- direct editing of right-pane rendered content;
- automatic result analysis, optimization, staffing recommendations, or
  decision claims;
- fixed validation, issue, attestation, approval, or workflow-policy products;
- per-frame simulation-state storage or batch replay timelines;
- multi-user identity, roles, collaboration, or cloud synchronization;
- Linux or hosted deployment;
- container- or VM-grade containment of hostile Model code;
- a Model marketplace or publishing workflow; and
- a second user-created Model as an MVP exit requirement.

## 7. Information model

| Object | Product meaning | Key ownership rule |
| --- | --- | --- |
| **Model** | Generic simulation source, execution description, declared inputs/outputs, and Model documents. | Owns its files and conversations; becomes Project-selectable only after technical checks pass. |
| **Project** | Decision-oriented workspace created from one fixed Model copy. | Owns the copied Model bytes, Project documents, configurations, Runs, outputs, and conversations. |
| **Conversation** | Named durable user/Agent thread for one Model or Project. | Belongs to exactly one owner and fixes provider/model after the first accepted user turn. |
| **Message** | User, Agent, or platform record in a Conversation. | Riff persists the complete supported message record; OpenCode is not the sole store. |
| **Temporary document** | Persistent draft, plan, analysis, specification, or proposed change linked from a message. | Belongs to one owner and has an explicit lifecycle such as `draft`, `adopted`, `rejected`, or `superseded`. |
| **Attachment** | User-provided source initially attached to a Conversation. | Formal use copies it into owner storage and records source and purpose. |
| **Experiment configuration** | Named editable values, seeds, and optional parameter sweep for a Project. | Has no user-visible revision history; each Run freezes the exact accepted values. |
| **Run** | One frozen visual or batch execution attempt. | Belongs to one Project and never follows later configuration or source-Model changes. |
| **Output** | Checked file or bounded event index published by a successful or diagnostically useful Run. | Is accessible only through its owning Project/Run projection, never by arbitrary path. |

A Project owns one fixed copy of one Model. Later changes to the source Model do
not alter existing Projects. Deleting the source Model does not delete
Project-owned copies.

## 8. Functional requirements

### 8.1 Home and resource lifecycle

| ID | Requirement |
| --- | --- |
| FR-HOME-01 | The home page must list Models and Projects as separate first-class collections with basic status and recent activity. |
| FR-HOME-02 | The home page must provide separate **New model** and **New project** actions. |
| FR-HOME-03 | New Model must require only a name and the provider/model selection for its first Conversation. |
| FR-HOME-04 | New Project must require only a name and one technically executable Model. |
| FR-LIFE-01 | Rename, archive, restore, trash, and delete actions must be direct resource controls and must not require an Agent. |
| FR-LIFE-02 | Delete must first move a resource to recoverable local trash. Permanent deletion must be a separate explicit action with an affected-data preview. |
| FR-LIFE-03 | Resource operations must preserve ownership boundaries; deleting a source Model must not delete Project-owned copies or unrelated local files. |

### 8.2 Shared two-pane workspace

| ID | Requirement |
| --- | --- |
| FR-SHELL-01 | Models and Projects must open in the same shell with persistent Conversation on the left and the selected object's current workspace on the right. |
| FR-SHELL-02 | Switching a Conversation must not switch, recreate, or lose the selected Model or Project workspace. |
| FR-SHELL-03 | The right pane must support generic renderers for Markdown, code, tables, JSON, diagrams, and Model-provided pages. |
| FR-SHELL-04 | Right-pane content must use weak conventions and must not require a fixed set of wind, evidence, or approval tabs. |
| FR-SHELL-05 | Direct run and resource controls must remain usable when the Agent is read-only or unavailable. |

### 8.3 Conversations, skills, documents, and attachments

| ID | Requirement |
| --- | --- |
| FR-CONV-01 | Every Model and Project must support multiple named Conversations that can be created, renamed, switched, archived, restored, and safely deleted. |
| FR-CONV-02 | Riff must persist messages, supported attachments, document cards, and action records. Browser clients must not receive provider credentials or opaque OpenCode session IDs. |
| FR-CONV-03 | A Conversation must select an OpenCode provider/model at creation and lock that selection after the first accepted user message. |
| FR-CONV-04 | Riff must bind a Conversation to an OpenCode session when available and reconstruct a lost session from bounded Riff-owned context. |
| FR-CONV-05 | Context must be assembled from the authoritative object summary, recent messages, an older-message summary, explicitly relevant documents/attachments, and selected skill instructions. |
| FR-CONV-06 | The Agent must expose a simulation-skill catalog, load full skill material only when needed, and record which skill it used. |
| FR-CONV-07 | Provider or OpenCode failure must put Agent mutation into explicit read-only mode without fabricated responses. |
| FR-CONV-08 | Only an explicit permitted instruction may trigger a direct mutation. Direct mutation must be typed, owner-scoped, validated, and atomic. |
| FR-DOC-01 | Agent output may create persistent temporary documents linked from message cards; a temporary document must not be mandatory for every change. |
| FR-DOC-02 | Temporary documents must support explicit lifecycle state and must not become authoritative Model/Project state merely because they are rendered. |
| FR-ATT-01 | Attachments must initially belong to a Conversation. Adoption must copy bytes into the owning Model/Project and record source and purpose. |
| FR-ATT-02 | Deleting a Conversation must not delete an attachment copy already adopted by its owner. |

### 8.4 Model workspace and technical checks

| ID | Requirement |
| --- | --- |
| FR-MODEL-01 | New Model must create a real generic Python/Mesa workspace, not a placeholder or wind-specific template. |
| FR-MODEL-02 | A Model must declare inputs, a runnable entry point, status/cancellation behavior, and output files; metrics and bounded domain events are optional. |
| FR-MODEL-03 | The Model workspace may contain overview, specification, code, input/output, structure, or Model-specific documents without a mandatory product schema. |
| FR-MODEL-04 | A Model must pass syntax, interface, dependency, smoke-run, resource, cancellation, and output checks before New Project can select it. |
| FR-MODEL-05 | “Technically executable” must be presented only as thin contract evidence, never as correctness, calibration, trust, or decision suitability. |
| FR-MODEL-06 | Model execution must use an isolated environment, a restricted owner workspace, scrubbed credentials, no network by default, finite limits, and cancellation. |
| FR-MODEL-07 | Model-scoped Agent tools must not access other objects, product source, arbitrary home paths, ambient credentials, or unadopted references. |

### 8.5 Projects and experiment configurations

| ID | Requirement |
| --- | --- |
| FR-PROJ-01 | New Project must copy the selected Model's current files and execution description into Project-owned storage. |
| FR-PROJ-02 | A Project must not expose an active-Model switch or Model-version browser. |
| FR-PROJ-03 | Project Conversations must be able to manage Project documents, configurations, Runs, and analysis but must not modify copied Model code, input/output definitions, or dependencies. |
| FR-EXP-01 | A Project must support named directly editable experiment configurations. |
| FR-EXP-02 | A configuration may represent one parameter set, multiple seeds, or a parameter sweep, and Riff must show the estimated sample count before execution. |
| FR-EXP-03 | Starting a Run must validate and freeze exact configuration values, deterministic sample plan, Project execution identity, and server-owned limits. |
| FR-EXP-04 | Riff must not automatically select important metrics, recommend an optimum, or reinterpret Model-defined values. |

### 8.6 Batch and visual execution

| ID | Requirement |
| --- | --- |
| FR-RUN-01 | A Model may declare `batch`, `visual`, or both execution capabilities; unsupported capabilities must fail explicitly. |
| FR-RUN-02 | Start, cancel, download, and trash must be direct controls with durable, idempotent lifecycle behavior. |
| FR-RUN-03 | A batch Run must show platform-owned status, sample count, steps or horizon, seed count, metric count, duration, resource overview, and output files. |
| FR-RUN-04 | Batch execution must publish successful outputs only after declared path, size, media type, and digest validation completes atomically. |
| FR-RUN-05 | Riff may expose a bounded filterable domain-event log, but must not store per-frame state or provide a batch replay timeline. |
| FR-RUN-06 | A terminal batch Run must create at most one deterministic platform completion card in the selected Conversation, or one durable explicit skip disposition. |
| FR-RUN-07 | Result analysis must begin only after a user asks the Agent to inspect outputs; the resulting analysis is a temporary or adopted document, not automatic system truth. |
| FR-RUN-08 | Runs must enforce bounded time, output, log/event, process, and resource use and must preserve cancel-first precedence. |
| FR-RUN-09 | Restart recovery must use durable process, scratch, launch, health, exit, and cleanup evidence and must fail closed when safe recovery cannot be proven. |
| FR-VIS-01 | A visual Run must start a Model-provided local web entry point under platform-managed health, proxy, stop, timeout, output, and resource controls. |
| FR-VIS-02 | The right pane must embed a healthy visual page in a restricted frame without exposing the child port, platform credentials, or unrelated local routes. |
| FR-VIS-03 | Visual HTTP and WebSocket access must be scoped to the current browser session, Project, Run, attempt generation, origin, host, path, and expiry, with revocation on lifecycle change. |
| FR-VIS-04 | Playwright observation must be limited to the current healthy Project Run. Interaction must require an explicit user instruction and create a Conversation action record. |
| FR-VIS-05 | DOM, accessibility-tree, screenshot, and structured-inspection observations must be timestamped context and must not become authoritative Project state. |
| FR-VIS-06 | Visual Runs must not create batch completion cards or a platform-generated result report. |

### 8.7 Persistence and recovery

| ID | Requirement |
| --- | --- |
| FR-DATA-01 | SQLite must store supported resource ownership, lifecycle, metadata, messages, documents, configurations, Run state, and object indexes. |
| FR-DATA-02 | Object directories must store Model code, adopted attachment bytes, environment descriptions, visual assets, and Run outputs with size/digest metadata. |
| FR-DATA-03 | Mixed database/filesystem mutation must be atomic or recoverable to the prior consistent state. |
| FR-DATA-04 | Application restart must restore all supported Models, Projects, Conversations, documents, configurations, Runs, and output indexes. |
| FR-DATA-05 | Browser/API projections must omit arbitrary filesystem paths, process identity, child ports, provider secrets, and external session identifiers. |

## 9. Core user journeys

### 9.1 Create and refine a Model

1. From Home, the user selects **New model**, supplies a name, and chooses a
   provider/model.
2. Riff creates a Model workspace and its first Conversation.
3. The user describes the simulation; the Agent uses relevant simulation
   skills and may create files or a temporary plan.
4. An explicit user instruction applies an atomic permitted change.
5. Riff runs thin technical checks and marks the Model technically executable
   only when all required checks pass.

### 9.2 Create a Project and run an experiment

1. The user selects **New project**, supplies a name, and chooses an executable
   Model.
2. Riff creates a Project-owned fixed copy.
3. The user or Project Agent creates a named experiment configuration.
4. The user reviews estimated samples and starts a batch or visual Run.
5. The right pane shows direct status and controls while Riff persists exact
   frozen execution context.
6. A successful batch Run publishes checked outputs and one completion card.
7. On request, the Agent inspects the outputs and creates an analysis document.

### 9.3 Continue after failure or restart

1. Riff restarts and reconstructs supported state from SQLite and checked
   object storage.
2. In-flight execution is reconciled only from durable ownership/process
   evidence; ambiguous state fails closed for operator repair.
3. If the OpenCode session is lost, Riff rebuilds bounded context in a new
   backend-only session.
4. If the provider remains unavailable, the Conversation is visibly read-only
   while saved resources and direct run controls remain usable.

## 10. Target architecture

### 10.1 Logical architecture

```text
React/Vite browser
  ├─ Models/Projects home
  └─ shared two-pane workspace
       ├─ Conversation client
       ├─ generic document/data renderers
       └─ restricted visual frame
             │
             ▼
Node.js/TypeScript Riff backend (only browser-facing authority)
  ├─ HTTP/API projections and direct controls
  ├─ Conversation/session/context coordinator
  │    └─ loopback OpenCode adapter
  ├─ scoped Agent tools and simulation-skill loader
  ├─ Model workspace and technical checker
  ├─ ProductStoreV2 mutation/recovery boundary
  ├─ deterministic experiment planner
  ├─ Run dispatcher and batch/visual supervisors
  └─ scoped visual access broker and Playwright adapter
             │
      ┌──────┼──────────────┐
      ▼      ▼              ▼
   SQLite  checked object  restricted Model/Run processes
           directories     (Python/Mesa or Model web entry point)
```

### 10.2 Component responsibilities

| Component | Responsibility | Must not become |
| --- | --- | --- |
| Browser | Render projections, collect explicit commands, expose direct controls, and host the restricted visual frame. | A durable authority, secret holder, or arbitrary file/process client. |
| Riff backend | Authenticate local browser capabilities, validate commands, coordinate services, and expose bounded projections. | A bypass around Store ownership or execution admission. |
| ProductStoreV2 | Own SQLite state, checked object references, atomic mutations, receipts, and restart recovery. | A scientific validator or Agent memory substitute. |
| OpenCode adapter | Discover provider/models, coordinate backend-only sessions, send bounded context, and stream real Agent results. | The sole message store or owner of product mutations. |
| Scoped tools/skills | Give one active turn the minimum owner-specific capabilities and progressively loaded instructions. | Ambient access to other objects, product source, credentials, or arbitrary tools. |
| Experiment planner | Validate canonical inputs and deterministically expand seeds/sweeps into a frozen sample plan. | An optimizer or recommender. |
| Run dispatcher/supervisors | Claim admitted Runs, launch restricted processes, enforce lifecycle/limits, and publish verified outputs. | A direct browser process API or untracked background runner. |
| Visual broker/Playwright adapter | Provide short-lived scoped access to one healthy visual attempt and bounded explicit inspection. | A general-purpose localhost proxy or durable Project authority. |

### 10.3 Authority and trust boundaries

The authority order is:

```text
validated command
  -> ProductStoreV2 transaction and checked bytes
  -> bounded backend projection
  -> browser / OpenCode / visual / Playwright context
```

- SQLite records and digest-checked object bytes are authoritative.
- OpenCode sessions, Agent prose, DOM, screenshots, and child-process memory are
  non-authoritative.
- Only the backend may translate an explicit user instruction into an
  owner-scoped typed mutation.
- Project execution admits only the exact Project-owned Model copy and frozen
  configuration/plan/limits.
- Model and visual processes run separately with restricted working
  directories, scrubbed environments, finite limits, and no network by
  default.
- Visual access uses distinct platform/broker origins and short-lived
  capabilities. Exact network and cookie behavior is refined by the active
  Stage 3 design and ADRs.

### 10.4 Deployment boundary

MVP runs locally on macOS:

- React/Vite serves the browser client;
- a Node.js/TypeScript process owns the API, ProductStoreV2, Agent
  coordination, and Run dispatch;
- OpenCode is reached only over an explicitly configured loopback boundary;
- Python/Mesa and visual entry points run as separately supervised processes;
  and
- credentials remain backend-only and local, normally supplied through
  uncommitted environment configuration.

## 11. Non-functional requirements

| ID | Requirement |
| --- | --- |
| NFR-AUTH-01 | Every durable write must validate owner, object, operation, and current lifecycle state at the backend/Store boundary. |
| NFR-ATOM-01 | Direct changes and successful output publication must be atomic across database records and owned files, or deterministically recoverable. |
| NFR-REC-01 | Startup must reconcile incomplete mutations and execution attempts before accepting conflicting new work. |
| NFR-FAIL-01 | Missing, contradictory, stale, or unsupported authority evidence must fail closed with a specific visible error. |
| NFR-SEC-01 | Provider credentials, ambient credentials, OpenCode session IDs, process identity, arbitrary paths, and child ports must not be projected to the browser. |
| NFR-SEC-02 | Model/Run processes must receive least-privilege paths, scrubbed environment, no network by default, cancellation, and finite resource/output/time limits. |
| NFR-SCOPE-01 | Conversations, documents, attachments, tools, Runs, outputs, visual capabilities, and Playwright access must be owner-scoped and deny cross-object use. |
| NFR-IDEM-01 | Retried create/start/cancel/finalize commands must not create duplicate durable effects. |
| NFR-HONEST-01 | UI and Agent responses must distinguish target, pending, running, completed, cancelled, failed, read-only, and recovery-required states without optimistic inference. |
| NFR-COMPAT-01 | Historical Gate/wind and queue artifacts may coexist during staged replacement but must not define current product behavior or authorize unrelated deletion. |
| NFR-TEST-01 | Each stage must include contract tests, failure/negative tests, restart checks where applicable, independent review, and browser evidence for visible behavior. |

## 12. Delivery stages and current implementation snapshot

The stages remain sequential because later stages depend on earlier authority
and persistence contracts. Status below is a navigation snapshot as of
2026-07-25, not a substitute for merged-code and GitHub evidence.

| Stage | Product slice | Snapshot |
| --- | --- | --- |
| **1 — data foundation** | SQLite/object directories, ownership, atomic mutation/recovery, lifecycle, fixed-copy Project primitive. | Implemented and merged. |
| **2 — Agent and Model workspace** | Persistent Conversations, OpenCode sessions/context, skills/scoped tools, documents/attachments, generic Model workspace, technical checks. | Implemented, merged, and accepted with real-provider two-turn evidence. |
| **3 — Project and execution** | Public Project creation, experiment planning, frozen Runs, batch/visual execution, direct controls, outputs/events, scoped visual/Playwright access, ordinary wind import. | In progress. Fixed-copy Projects, planning, batch lifecycle, cancellation/recovery/cards, visual Store/supervision/dispatch, and network-isolation primitives are merged. Browser broker/frame/WebSocket completion, scoped Playwright, and ordinary wind import remain. |
| **4 — shared product shell** | Models/Projects home, final two-pane UX, dynamic right pane, Conversation management/cards, offline/recovery UX, old-product cleanup, full wind browser acceptance. | Pending Stage 3 completion. |

Detailed slice status belongs in
[`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md),
the repository [README](../README.md), and revision-scoped test records.

## 13. MVP exit acceptance

One real browser scenario must prove:

1. Home exposes Models, Projects, New Model, and New Project.
2. The wind Model opens as an ordinary Model in the shared two-pane shell.
3. A real multi-turn OpenCode Conversation modifies permitted Model state or
   creates a persistent temporary document card, and the right pane reflects
   committed state.
4. A second named Conversation can use its chosen provider/model and the user
   can switch between Conversations without losing messages, attachments, or
   documents.
5. New Project accepts only a name and the wind Model and creates a fixed copy.
6. A Project Conversation creates or modifies an experiment configuration.
7. The user starts a real wind batch Run and sees status, checked outputs, and
   bounded domain events without per-frame replay.
8. On request, the Agent reads Run outputs and creates an analysis document.
9. A visual-capable Model starts a managed visual Run whose page is usable in
   the restricted right-pane frame without exposing the child endpoint.
10. Restart restores supported Models, Projects, Conversations, documents,
    configurations, Runs, and outputs and safely reconciles incomplete work.
11. OpenCode unavailability produces explicit read-only mode and never a fake
    Agent response.
12. New Model creates a functional generic Model workspace; a second completed
    business Model is deferred to post-MVP validation.

## 14. Risks and claim boundaries

| Risk | MVP boundary or mitigation |
| --- | --- |
| Agent acts beyond user intent | Require explicit imperative language, typed owner-scoped tools, capability revocation, and atomic validation. |
| Model code accesses local machine data | Restrict process paths/environment/network and resources; state clearly that this is not hostile-code containment. |
| Run result cannot be reproduced | Freeze Project copy, execution description, configuration, sample plan, limits, and checked outputs. |
| Visual child reaches platform authority | Use isolated loopback topology, separate origins, short-lived exact capabilities, no child port projection, and revocation. |
| Provider/session becomes unavailable | Persist Riff-owned context, rebuild sessions when possible, and expose honest read-only mode. |
| Historical wind/Gate documents redirect product design | Mark them historical and resolve every product conflict in favor of this PRD. |
| Successful execution is mistaken for a valid decision | Keep technical, execution, scientific, calibration, and decision claims explicitly separate. |

## 15. Supporting documents

The following documents refine or record this PRD without replacing it:

- [`milestone-a1-data-foundation-design.md`](milestone-a1-data-foundation-design.md):
  implemented Stage 1 storage and mutation design;
- [`milestone-a2-agent-workspace-design.md`](milestone-a2-agent-workspace-design.md):
  implemented Stage 2 Agent and Model-workspace design;
- [`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md):
  active Stage 3 execution design and implementation ledger;
- [`architecture.md`](architecture.md): deeper current and historical
  architecture notes;
- [`backend-api.md`](backend-api.md), [`opencode-bridge.md`](opencode-bridge.md),
  and [`ui-workflow.md`](ui-workflow.md): subsystem contracts;
- [`test-plan.md`](test-plan.md): current and historical acceptance evidence;
  and
- [`adr/README.md`](adr/README.md): derived Stage 3 decision checklists.

Historical Gate documents and [`product-roadmap.md`](product-roadmap.md) are
retained for traceability and wind-model evidence only.

## 16. Change governance

1. Product-scope, workflow, user-visible claim, or acceptance changes must
   update this PRD before or with implementation.
2. Requirement IDs should remain stable. Removed requirements are marked
   superseded in review history rather than silently reused for new meaning.
3. Stage/API/ADR documents may strengthen internal correctness and security but
   must link their decisions back to a PRD requirement.
4. Documentation-only approval does not claim implementation. Implementation
   status changes only after the relevant code, tests, review, and merge.
5. Old-product removal requires an explicit tracked-code and local-artifact
   audit. No documentation statement authorizes deletion of unrelated
   untracked user files.
