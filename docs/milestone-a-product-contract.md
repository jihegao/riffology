# Milestone A product contract: conversational model and project workspaces

Status: approved product target; implementation is split across four sequential
issues. This contract supersedes the former Gate 0-4 product target where the
two disagree. Existing documents remain useful as implementation history and as
evidence for the reviewed wind model, but they are not authority for the new
product shape.

## Outcome

Milestone A restores and extends Riff's original product invariant:

```text
left: persistent simulation conversation
right: the current model or project workspace
```

The wind-turbine maintenance model is the first ordinary model and example
project. It is not a product mode, a fixed page schema, or a source of product
type names. The same shell also exposes a functional **New model** path. A
second user-created model is a later user-validation milestone rather than an
exit requirement for Milestone A.

## Product invariants

1. The home page has two first-class resource collections: **Models** and
   **Projects**, with separate **New model** and **New project** actions.
2. Models and projects open in the same two-pane shell. The left pane is the
   conversation surface; the right pane projects the selected object's current
   durable state.
3. Conversation text, OpenCode output, rendered documents, DOM state, and
   Playwright observations are context and projections. They do not silently
   become authoritative model or project state.
4. The wind model is data in the model library. Product code must not assume
   turbines, crews, depots, wind-specific metrics, fixed wind tabs, or wind
   bundle identifiers.
5. A project owns one fixed copy of one model. It has no active-model switch and
   no model-version browser.
6. Milestone A is local, single-user, and macOS-only. Linux support, cloud sync,
   authentication, roles, concurrent editing, and hostile-code isolation are
   not claims of this milestone.

## Home and object lifecycle

The home page lists models and projects independently. It shows names, basic
status, and recent activity without opening a wind-specific dashboard.

Creating a model requires only:

- a model name;
- the provider/model selection for its first conversation.

Creating a project requires only:

- a project name;
- one existing technically executable model.

At project creation, Riff copies the model's current files and execution
description into the project. Later edits to the source model do not change the
project copy. A project conversation cannot modify model code, input
definitions, output definitions, or runtime dependencies. It can manage project
documents, experiment configurations, runs, and analysis.

Rename, archive, restore, and delete are direct resource-management actions and
do not require an Agent. Delete moves an object to a local recoverable trash.
Permanent deletion is a separate explicit action that previews the affected
data. Deleting a source model does not delete model copies already owned by
projects.

## Conversation contract

Every model and project may own multiple named conversations. A conversation:

- persists its complete messages, attachments, document cards, and action
  records in Riff;
- binds to one OpenCode session while that session is available;
- selects an OpenCode provider/model when created;
- fixes that provider/model after the first user message;
- may be renamed, switched, archived, restored, or safely deleted;
- may be reconstructed in a new OpenCode session from Riff-owned context when
  the external session is lost.

Riff must not use OpenCode as the sole conversation store. The browser never
receives OpenCode credentials or opaque OpenCode session identifiers.

OpenCode receives bounded context assembled from:

- the current authoritative model or project summary;
- recent conversation messages;
- a rolling summary of older messages;
- explicitly relevant documents and attachments;
- the selected simulation skill instructions.

The Agent preloads the simulation-skills capability catalog. A user may name a
skill explicitly; otherwise the Agent may route to a relevant skill and reports
which skill it used. Full skill instructions and references are loaded only
when needed rather than injecting every skill into every turn.

If OpenCode or the selected provider/model is unavailable, Agent conversation
mutation enters an explicit read-only mode. Existing models, projects,
configurations, runs, and results remain browsable, and direct run controls for
saved configurations remain available. Riff does not use canned responses to
imitate a live Agent.

## Conversation changes and temporary documents

An explicit imperative such as "set the crew count to four" may directly
modify the permitted current object. Discussion, questions, and ambiguous
language do not authorize a mutation. Large or connected changes should prompt
the Agent to offer a temporary plan, but temporary documents are not a mandatory
state-machine step.

Agent output may create persistent temporary documents linked from message
cards. A document may contain prose, specifications, code, parameters, metrics,
diagrams, analyses, or one or many proposed changes. Documents use lifecycle
states such as `draft`, `adopted`, `rejected`, and `superseded`. "Temporary"
describes workflow state, not volatile storage.

Direct mutations are atomic. The system stages affected files and database
changes, validates the operation, and commits all of it or restores the previous
state. This is transaction safety, not user-visible version management.

Attachments initially belong to a conversation. When formally used by a model
or project, Riff copies them into that object's storage and records their source
and purpose. Deleting a conversation does not delete an adopted copy.

## Model workspace

The New model path creates a real, restricted Python/Mesa model workspace rather
than a placeholder. Business domain, agent types, spatial representation,
metrics, and modeling purpose are not restricted to the wind case.

The right pane uses weak document conventions, not six mandatory product tabs.
It may render overview, specification, code, inputs, outputs, structure, or
model-specific documents when they exist. Riff supplies generic renderers for
Markdown, code, tables, JSON, Mermaid/diagrams, and model-provided pages.

Only a thin technical execution contract is mandatory:

- declared inputs;
- a runnable entry point;
- status and cancellation;
- output-file declarations;
- optional metrics and bounded domain events.

A model becomes available to New project after syntax, interface, dependency,
smoke-run, resource, cancellation, and output checks pass. This status means
technically executable, not correct, trusted, calibrated, or suitable for a
decision. Milestone A does not expose model versions or publishing workflows.

Each model declares dependencies and uses an isolated environment. The Agent
may access only the current object's workspace, current conversation
attachments, and explicitly adopted references. It cannot access other objects,
the product source, ambient credentials, or arbitrary home-directory paths.

Milestone A treats created model code as locally user-authorized, not adversarial
code. It provides a separate process, a restricted working directory, scrubbed
credentials, no network by default, finite time/output/resource limits, and
cancellation. It does not claim container- or VM-grade isolation from malicious
code.

## Project, experiment, and run contract

Project documents use the same weak, dynamic document conventions as model
documents. Business briefs, assumptions, explanations, and analyses are not
fixed tabs or mandatory schemas.

The structured project core contains:

- named experiment configurations;
- run records and status;
- output-file indexes;
- optional bounded domain-event indexes.

Experiment configurations are directly editable records without revision
history. A run freezes the exact configuration values it used. Configurations
may describe a single parameter set, multiple seeds, or a parameter sweep. Riff
shows the estimated sample count but does not automatically choose important
metrics or recommend an optimum.

Models declare `visual`, `batch`, or both:

- A visual run starts a model-provided local web entry point. Riff manages
  health, proxying, stopping, timeout, and resource limits. It does not create a
  system result report. The right pane embeds the page in a restricted frame.
- A batch run displays only a platform-owned status overview: state, sample
  count, steps or time horizon, seed count, metric count, duration, resource
  overview, and output files.

Riff stores no per-frame simulation state and provides no replay timeline.
Models may emit a bounded, filterable domain-event log for diagnosis. When a
batch run finishes, the system adds a completion card to the conversation.
Analysis occurs only after the user asks the Agent to inspect the outputs and
create a temporary or adopted analysis document.

Playwright may inspect the current project's visual run through its embedded
page, accessibility tree, DOM, and screenshots. A structured model inspection
endpoint is preferred when present. Observations are timestamped context, not
authoritative project state. Playwright may interact with the visualization
only after an explicit user instruction, and the conversation records the
action.

Run controls for start, cancel, download, and trash remain available directly
in the right pane; they do not require Agent availability. Runs have bounded
time, output size, logs, events, and resource use. Results persist until the user
trashes them; the Agent may suggest but never autonomously perform cleanup.

## Storage contract

Milestone A uses:

- SQLite for models, projects, conversations, messages, temporary documents,
  attachments, experiment configurations, and run/output indexes;
- object directories for model code, adopted attachments, environment
  descriptions, visual assets, and run output files.

The database stores ownership, paths, types, sizes, digests, and timestamps.
The application restores all supported objects after restart. It does not retain
the previous immutable revision/event architecture, attestation system,
workflow policy, model activation state machine, per-frame replay, or retirement
auditor as product requirements.

## Wind case and old-state disposition

The existing reviewed and runnable `wind-turbine-maintenance` Mesa model is
preserved and imported as an ordinary preinstalled model. A separate wind
example project copies it and starts with one example experiment configuration.
It contains no fabricated conversation, analysis, recommendation, or claim of
real-wind-farm calibration.

The current product tree and local demo data do not require compatibility when
they conflict with this contract. Implementation may remove:

- `queue-network-v1` code, schemas, routes, tests, documentation, and identified
  local artifacts;
- wind-specific Evidence Studio product components and hard-coded wind types;
- obsolete revision, activation, attestation, workflow-policy, replay, and
  retirement-audit code;
- old file-based demo project state that does not fit the new SQLite product.

Git history and the reviewed wind model are retained. Removal is based on an
explicit target audit; unrelated untracked user files are never inferred to be
disposable.

## Milestone A delivery stages

The stages are sequential. Each receives its own design, tests, review, PR, and
merge before the next depends on it: [Stage 1 / #12](https://github.com/jihegao/riffology/issues/12),
[Stage 2 / #13](https://github.com/jihegao/riffology/issues/13),
[Stage 3 / #14](https://github.com/jihegao/riffology/issues/14), and
[Stage 4 / #15](https://github.com/jihegao/riffology/issues/15).

### Stage 1 — product and data foundation

Add the simplified SQLite/object-store domain for models, projects,
conversations, temporary documents, attachments, experiments, runs, trash, and
restart recovery. This stage owns the internal project-creation primitive that
copies a fixed model snapshot and proves later source edits cannot affect it; it
does not expose the final New project workflow. Do not implement OpenCode or the
final UI in this stage.

### Stage 2 — Agent and model workspace

Add persistent conversation management, OpenCode provider/model discovery and
per-conversation sessions, simulation-skills routing, scoped object tools,
attachments, temporary documents, atomic direct changes, isolated model
environments, technical executability checks, and the functional New model
path.

### Stage 3 — projects and execution

Expose New project through the Stage 1 fixed-copy primitive, add project-scoped
permissions, experiment configuration, visual and batch execution, direct run
controls, output indexes, bounded events, Playwright visual inspection
boundaries, and migrate the existing wind model and example project into the
generic runtime.

### Stage 4 — two-pane product and wind acceptance

Add the Models/Projects home, shared two-pane shell, dynamic document workspace,
conversation cards and management, offline read-only behavior, recovery UX,
old-product cleanup, documentation, and real browser acceptance of the wind
model and example project delivered by Stage 3. Stage 4 does not re-import or
redefine those objects.

## Milestone A exit story

The browser exit gate proves one complete wind case:

1. The home page exposes Models, Projects, New model, and New project.
2. The wind model opens as an ordinary model in the shared two-pane shell.
3. A real multi-turn OpenCode conversation can modify the model or create a
   persistent temporary document card; the right pane dynamically reflects
   committed state.
4. A second named conversation can use a chosen provider/model and later switch
   back without losing messages, attachments, or documents.
5. New project accepts only a name and the wind model, then copies the model.
6. A project conversation creates or modifies an experiment configuration.
7. The user starts a wind batch run and sees its status overview, output files,
   and bounded domain events without per-frame replay.
8. On request, the Agent reads the run output and creates an analysis document.
9. Restart restores models, projects, conversations, documents,
   configurations, and runs.
10. OpenCode unavailability produces explicit read-only mode, never a fake
    Agent response.
11. New model is functional, but a second model is not required for this exit
    gate. The user later creates one as Milestone B's genericity test.

## Non-goals and non-claims

Milestone A does not include:

- user-visible model or experiment version management;
- multiple active models within a project;
- direct right-pane content editing;
- automatic result analysis or staffing recommendations;
- per-frame state or animation replay for batch runs;
- fixed validation, issue, attestation, or workflow-policy products;
- multi-user identity, permissions, collaboration, or cloud sync;
- Linux support;
- strong isolation from malicious model code;
- a second-model acceptance case.
