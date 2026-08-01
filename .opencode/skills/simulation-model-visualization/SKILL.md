---
name: simulation-model-visualization
description: Design or review a discrete-event or agent-based simulation model and create a standalone HTML design document showing entities, states, queues, events, inputs, outputs, and assumptions. Use for model design, model-asset review, architecture diagrams, or stakeholder review; always write HTML before opening it in an external browser.
license: MIT
compatibility: opencode
metadata:
  opencode/slash: "true"
---

# Simulation model design visualization

Create an inspectable model contract and a standalone design page. Do not use an embedded product frame as the visual review artifact.

## Workflow

1. Load `simulation-domain-requirements` first if the domain brief is absent or materially stale. Read `references/model-visualization-contract.md` before rendering.
2. Inspect the source model specification and code. Preserve exact states, event ordering, queue priorities, units, random-stream names, and claim scope; label omissions as unknown rather than filling them in.
3. Write or update the model design source document/spec first. Then generate an HTML document using `scripts/render_model_design.py`.
4. Save generated documents under `outputs/model-design/` (ignored runtime output) unless the user requests a durable review artifact elsewhere. Give the file a meaningful, stable name.
5. Open the generated local HTML in the system's default external browser with `--open`. Report the absolute HTML path. Do not claim browser review until the open command succeeds or the user says they reviewed it.
6. If the visual design changes a model contract, update tests/microcases and retain the source spec as authority; the HTML is a rendered projection only.

## Commands

```bash
python3 .opencode/skills/simulation-model-visualization/scripts/render_model_design.py \
  --spec mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/model-spec.json \
  --output outputs/model-design/wind-turbine-maintenance-design.html \
  --title "风机维护模型设计" --open
```

For another model, provide any JSON object with recognizable `entities`, `event_ordering`, `queue_policy`, `distribution_families`, and/or `claim_scope` fields. The script retains unrecognized top-level fields in an appendix instead of discarding them.

## Required visual contents

- objective/claim boundary and source digest;
- entity-state cards;
- event-ordering and dispatch/queue policy;
- uncertainty/distribution and random-stream inventory;
- a machine-readable specification appendix.

Never render untrusted strings as HTML. Keep model design, source data, generated HTML, and runtime result evidence distinct.
