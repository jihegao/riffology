---
name: simulation-model-visualization
description: Design or review a discrete-event or agent-based simulation model and, by default, create a runnable Solara visualization app. Use the standalone HTML workflow only for model-contract/design review; always write the selected artifact before opening it in a browser.
license: MIT
compatibility: opencode
metadata:
  opencode/slash: "true"
---

# Simulation model and runtime visualization

Create an inspectable model contract and a runnable, source-backed visualization. The default runtime visualization is a Solara app. A standalone HTML document remains the required artifact for a model-contract/design review. Do not silently turn a design projection into a simulation result.

## Default: Solara runtime app

When the user asks for a visual simulation page, visualization, visual model, or to start the simulation visualization, produce a Solara app unless they explicitly request a static design/replay HTML document. The app must:

- import the authoritative Model or an explicit read-only result artifact; never invent domain state while rendering;
- expose declared inputs and a deterministic seed, show the model/revision/source digest, and label synthetic, single-seed, draft, or otherwise limited evidence;
- keep simulation execution separate from rendering: use the declared Mesa runner or a bounded replay artifact, and do not mutate the Product Store from Solara callbacks;
- bind to loopback by default and run with `solara run <app.py> --host 127.0.0.1 --port <port>` (or the repository's equivalent); record the exact command, port, source path, and digest;
- provide a health-visible page with a stable heading and an explicit “not calibrated / not a recommendation” boundary when the source evidence has those limits;
- be loaded as a browser page or explicitly authorized visual frame. Do not iframe or persist the Solara DOM as Product domain state.

Use a stable runtime output directory such as `outputs/solara/<model-slug>/`; keep the source app and its run/receipt metadata together. A successful Solara process or HTTP 200 proves availability only; it does not prove model validity or a completed run.

## Workflow

1. Load `simulation-domain-requirements` first if the domain brief is absent or materially stale. Read the applicable contract before rendering.
2. Inspect the source model specification and code. Preserve exact states, event ordering, queue priorities, units, random-stream names, and claim scope; label omissions as unknown rather than filling them in.
3. For the default runtime path, write/update the Solara app source first, then start it with the declared loopback command. For design review, write/update the model design source/spec first, then generate standalone HTML with `scripts/render_model_design.py`.
4. Save Solara runtime artifacts under `outputs/solara/<model-slug>/` and design documents under `outputs/model-design/` unless the user requests a durable artifact elsewhere.
5. Open the selected page only after its source has been written and the service reports healthy. For a Solara app, inspect the rendered heading, source/revision identity, and evidence boundary in the browser; for design HTML, use the external-browser workflow below.
6. If the visualization changes a model contract, update tests/microcases and retain the source spec as authority. A Solara page or HTML document is a projection and never a mutation receipt or proof of calibration.

## Solara command and acceptance record

```bash
solara run outputs/solara/<model-slug>/app.py \
  --host 127.0.0.1 --port <port>
```

Before reporting success, record: app path and SHA-256, model/revision or source-artifact digest, exact command, loopback URL, health result, browser URL, and any event truncation or claim limitation. If the user invokes the page through a Riffology conversation, the assistant must send the exact command requested by the user (for example, `启动可视化仿真`) and verify that the resulting browser page is the Solara page, not merely the Riff app shell.

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
