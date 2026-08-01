# Riff Demo OpenCode guide

Use the project-local OpenCode extension pack under `.opencode/`.

- Load `simulation-domain-requirements` before defining or materially changing domain semantics.
- Use `simulation-model-visualization` for model design review. Generate a standalone local HTML document first, then open that file with the operating system's external browser; do not embed it in the Riff Product UI.
- Use `simulation-run-visualization` for results/replay review. It operates on one identified output artifact and must disclose source digest and event truncation.
- Preserve the Riff boundary: Model/Project source and frozen Run artifacts are authoritative; Agent text, HTML, DOM, and screenshots are projections, not durable domain state.
- Keep platform code domain-neutral. Put case-specific ontology, validation, and visualization mapping in domain assets.
- Do not silently create missing persisted model data while rendering. Require an explicit add, template, or import action.

Useful slash commands: `/domain-brief`, `/model-design-html`, and `/run-replay-html`.
