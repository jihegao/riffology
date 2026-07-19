# MVP architecture decision record

## Objective

Deliver one local, demonstrable workflow: file upload in the conversation pane, Mesa model preparation, parameter editing, experiment execution, result display, and assistant summary.

## Non-goals

- Multi-user collaboration, remote deployment, arbitrary code execution, and model scientific validation.
- General support for every simulation method or file format.

## Required boundaries

The browser never receives the API key. The backend owns the per-session workspace and is the sole source of truth for project and run state. Mesa runs in a separate, cancellable process. Playwright may enact visible browser actions but must not be the source of model or run state.

## Stage gate

Implementation begins only after the component contracts and end-to-end acceptance test are recorded and reconciled.

