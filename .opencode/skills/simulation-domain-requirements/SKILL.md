---
name: simulation-domain-requirements
description: Convert a business or engineering simulation question into a traceable domain brief, including objectives, entities, rules, inputs, uncertainty, outputs, validation boundary, and decision limits. Use for new simulation cases, domain-pack requirements, model scoping, or before changing a model or experiment.
license: MIT
compatibility: opencode
metadata:
  opencode/slash: "true"
---

# Simulation domain requirements

Create a reviewable domain brief before proposing model code, parameters, or results.

## Workflow

1. Read `references/domain-brief-template.md`. For this repository, also read `docs/product-requirements.md` and the relevant Model/Project contracts.
2. Separate facts supplied by the user or source data from assumptions, chosen policy, and questions still open. Do not invent calibration or claim scientific validation.
3. Define the minimum ontology: entities, state, events, resources, queues, time unit, and decision/control variables. Give every rule an owner and an observable consequence.
4. Define input sources and units, distributions and random streams, output/KPI semantics, warm-up/horizon/replications, and acceptance microcases.
5. State what the proposed model can and cannot support. A technical run, an HTML visualization, and an Agent narrative are evidence aids, not domain truth.
6. Write the brief to a user-approved project document such as `docs/domain-brief-<case>.md`. Do not change model assets or run an experiment until the requested change is explicit.

## Riff boundaries

- Keep reusable platform behavior generic. Put wind, aircraft, maintenance, inventory, or other case-specific ontology, validation, and visualization mapping in the domain pack/model assets.
- Treat a Project as a fixed Model copy; a Run must identify the frozen configuration, seed/sample plan, horizon, and source artifacts.
- Preserve the distinction among technically executable, run succeeded, scientifically/engineering validated, calibrated, and decision-ready.
- Preserve empty state rather than silently creating domain records. Require an explicit add, template, or import action.

## Deliverable

Return a concise brief with the template headings and an explicit review checklist. Mark unavailable source data and unresolved choices as open; ask for a decision only when it changes model semantics or execution scope.
