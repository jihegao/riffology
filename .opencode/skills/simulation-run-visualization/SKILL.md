---
name: simulation-run-visualization
description: Turn simulation event outputs or snapshots into a standalone HTML replay and evidence summary. Use after a batch or visual run to inspect domain events, queues, resources, state changes, and KPI samples; always write HTML first and then open it in an external browser.
license: MIT
compatibility: opencode
metadata:
  opencode/slash: "true"
---

# Simulation run visualization

Render the output of one identified run as a local replay document. The output data remains authoritative; the HTML is a bounded, untrusted projection.

## Workflow

1. Identify the exact run, frozen inputs, source output files, time unit, and claim boundary. Do not combine events from different runs or quietly replace missing events with inferred frames.
2. Read `references/run-visualization-contract.md`. Prefer the authoritative event stream declared by the Model (for the wind case: `domain-events.jsonl`).
3. Generate the standalone HTML before any browser action. Use `scripts/render_run_replay.py`; it accepts JSONL event objects or a JSON list/object containing events.
4. Save it under `outputs/simulation-replay/` unless the user asks for a durable artifact elsewhere; then execute the same command with `--open` to use the external system browser.
5. Inspect the page only as a visualization aid. Report the absolute HTML path, source digest, input event count, displayed-event limit, and any parsing/omission warning.
6. Keep result interpretation bounded: distinguish simulation observations from calibration, validation, causal claims, optimization, or recommendations.

## Command

```bash
python3 .opencode/skills/simulation-run-visualization/scripts/render_run_replay.py \
  --events path/to/domain-events.jsonl \
  --output outputs/simulation-replay/run-42.html \
  --title "Run 42 · 风机维护推演" --open
```

Use `--max-events` to keep huge reports reviewable. The document shows the limit and never conceals it. It is self-contained: do not replace it with iframe embedding, a product frame URL, or a live local service.
