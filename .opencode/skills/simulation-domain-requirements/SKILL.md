---
name: simulation-domain-requirements
description: Convert a business or engineering simulation question into Project-owned Modeling Requirements, including objectives, entities, rules, inputs, uncertainty, outputs, validation boundary, and decision limits. Use for new simulation cases, Project scoping, official Example Project Templates, or before changing a model or experiment.
license: MIT
compatibility: opencode
metadata:
  opencode/slash: "true"
---

# Simulation domain requirements

Create a reviewable domain brief before proposing model code, parameters, or results.

## Workflow

1. Read `references/domain-brief-template.md`. For this repository, also read `docs/product-requirements.md` and the relevant Model/Project contracts. If a Project has one, read its canonical `requirements/modeling-requirements.md` before proposing a revision.
2. Separate facts supplied by the user or source data from assumptions, chosen policy, and questions still open. Do not invent calibration or claim scientific validation.
3. Define the minimum ontology: entities, state, events, resources, queues, time unit, and decision/control variables. Give every rule an owner and an observable consequence.
4. Define input sources and units, distributions and random streams, output/KPI semantics, warm-up/horizon/replications, and acceptance microcases.
5. State what the proposed model can and cannot support. A technical run, an HTML visualization, and an Agent narrative are evidence aids, not domain truth.
6. When the user explicitly requests durable Project requirements, write the brief to the
   Project canonical path `requirements/modeling-requirements.md`. A repository review
   document such as `docs/domain-brief-<case>.md` is not that Project artifact. Do not
   change model assets or run an experiment until the requested change is explicit.

## Riff boundaries

- Keep reusable platform behavior generic. Put wind, aircraft, maintenance, inventory, or other case-specific ontology, validation, and visualization mapping in the Project's Modeling Requirements and executable project assets, not in an independently installed Domain Pack.
- Treat `requirements/modeling-requirements.md` as the only canonical Project path for the Modeling Requirements layer. An official immutable Example Project Template must include it.
- Treat a Project as the mutable, authoritative simulation workspace; a Run must identify the frozen Project configuration, seed/sample plan, horizon, and source artifacts.
- Preserve the distinction among technically executable, run succeeded, scientifically/engineering validated, calibrated, and decision-ready.
- Preserve empty state rather than silently creating domain records. A Blank Project must not implicitly create the canonical file; require an explicit add, import, or Example Project Template action.
- Conversation temporary documents are drafts and never Template contents. Only an explicit Project write may adopt their content into the canonical path.

## Deliverable

Return a concise Modeling Requirements brief with the template headings and an explicit review checklist. Mark unavailable source data and unresolved choices as open; ask for a decision only when it changes model semantics or execution scope. A generated brief or Conversation temporary document is not a Template or Project authority until the explicit Project write succeeds.
