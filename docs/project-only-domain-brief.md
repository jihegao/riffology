# Project-only simulation workspace domain brief

Status: approved implementation contract
Approved: 2026-08-04; revised for direct Project writes: 2026-08-11

## Decision question and scope

- Replace the user-visible Model/Project split with one mutable Project resource.
- A Project owns executable files, environment declarations, execution description,
  experiments, Conversations, Runs, outputs, and visual services.
- Projects are reused through immutable Project Template versions, never through a
  shared mutable Model.
- Existing Product data is exported once and is not imported into the new store.

## Evidence and assumptions

| Type | Item | Source or rationale | Owner | Status |
| --- | --- | --- | --- | --- |
| policy | Only Project is a public and durable workspace owner | User-approved replacement architecture | Product | approved |
| policy | A Project admits at most one nonterminal Run | Avoid ambiguous execution locks | Platform | approved |
| policy | Executable files and execution description are locked only during a nonterminal Run | Prevent live execution drift | Platform | approved |
| policy | Experiment configuration may change during a Run and affects only future Runs | User-selected lock scope | Product | approved |
| policy | Run source bytes are not retained after terminal cleanup | User explicitly accepts non-reproducible historical Runs | Product | approved |
| fact | A digest without retained bytes cannot reproduce a historical Run after Project edits | Content-addressing limitation | Platform | accepted limitation |
| policy | Opening an already healthy visual service is an unprivileged scoped Agent operation | No arbitrary target or browser control | Platform | approved |

## Ontology and behavior

- Project: mutable single-user simulation workspace and sole Conversation owner.
- Project Template Version: immutable seed containing executable files, execution
  description, and default experiments; excludes Conversations and Runs.
- Project Write Receipt: idempotent, CAS-bound proof of one atomic UTF-8 text change set.
- Execution Lock: persistent Project state covering queued, running, and cancelling
  Runs. It rejects executable workspace mutations and a second
  Run, but does not block Conversation, document, metadata, or experiment edits.
- Run: one batch or visual execution using the experiment values captured at start.
- Visual Service: projection of the current healthy visual Run, opened through a
  short-lived frame capability without transferring Browser Agent control.

## Inputs and uncertainty

- Blank Project creation produces an explicit minimal draft scaffold.
- Template creation copies one exact immutable version.
- Import creation validates a bounded archive before committing any Project state.
- Runtime parameters and seeds are captured at Run admission. Later Experiment
  edits do not affect an admitted Run.

## Outputs and experiment plan

- Terminal Runs retain output artifacts, captured configuration, sample plan,
  limits, source digest, terminal evidence, and cleanup evidence.
- Terminal Runs do not retain executable source bytes or a source download route.
- If the current Project digest differs from a Run's source digest, the UI labels
  the Run as non-reproducible and not replayable.

## Validation and claim boundary

- A successful real Run establishes only that the frozen execution attempt completed;
  it does not establish calibration, scientific validity, or decision readiness.
- A healthy visual page proves service availability only.
- Historical Run outputs remain execution records but cannot be reproduced after
  their source bytes are discarded.
- The legacy export is an archive, not a migration or active authority source.

## Review checklist

- [x] Project is the only new-store workspace and Conversation owner.
- [x] One active Run and persistent execution-lock recovery are explicit.
- [x] Experiment edits during a Run affect future Runs only.
- [x] Missing historical source and replay limitations are user-visible.
- [x] Template contents and exclusions are explicit.
- [x] Visual open and visual start have distinct authorization semantics.
