# Test plan

## Critical end-to-end scenario

1. A user uploads a supported input file through the left pane.
2. The assistant receives attachment metadata and loads the approved Mesa model.
3. The right pane presents the model parameters.
4. A parameter is changed and an experiment is started.
5. The page reaches a terminal success state and renders metrics plus a time series.
6. The assistant reads the run artifacts and returns a result summary for that run.

The browser consumes only the canonical backend event names
`project.snapshot`, `project.patch`, `conversation.delta`, `agent.status`, and
`connection.status`. It never calls Mesa directly. A Mesa `timed_out` result is
a distinct terminal timeout UX: it has no success metrics, does not query the
successful-results endpoint, and remains distinguishable from `failed` and
`cancelled`.

## Requirements-to-tests traceability

| Requirement | Primary tests | Evidence / release gate |
| --- | --- | --- |
| R1: Attachment is safely accepted/rejected and only metadata is handed to the agent. | Upload unit tests; backend upload integration; UI supported/unsupported fixture test. | Implementation gate: test output and redaction assertions. |
| R2: Agent readiness is public but credentials/session authority stay server-side. | Bridge startup/config tests; UI `ready`/`unconfigured`/`error` state test. | Implementation gate: no secret/session ID in serialized browser state. |
| R3: Only the bundled `queue-network-v1` model and documented parameter schema can be selected. | Mesa schema/model-load unit tests; bridge tool-policy test; UI schema-driven form test. | Implementation gate: rejected arbitrary model/code cases. |
| R4: A valid seeded run is isolated, reproducible, and renders artifact-backed results. | Mesa fixed-seed smoke test; API run/results integration; real-service Playwright E2E. | Integration gate: retained run ID, metrics, series, and screenshot. |
| R5: `failed`, `cancelled`, and `timed_out` are safe terminal states. | Mesa lifecycle/API tests; UI terminal-state tests. | Integration gate: timeout evidence with no success result retrieval. |
| R6: The browser follows ordered authoritative state. | Reducer/SSE duplicate, reorder, and revision-gap tests; UI reconnect test. | Implementation gate: canonical event-name assertion and snapshot recovery. |
| R7: Playwright is a visible projection; a projection failure is visible but cannot roll back domain state. | Bridge ordering test; UI `uiControl.failed` warning test; visible-tab Playwright test. | Integration gate: warning plus manual continuation proof. |
| R8: The local OpenCode integration starts with an approved configured provider/model and performs a bounded allowed action. | Live startup/provider/model check and bounded chat/tool-call smoke below. | Live-integrated completion gate; skipped only when no key is available, which blocks this gate. |
| R9: The demo is visually usable at the target desktop viewport. | Playwright viewport assertion and screenshot review at 1440 x 900. | Independent-review gate: screenshot/video reviewed. |

## Required test layers

### Unit and component

- Public backend reducers, validation, redaction, and command acknowledgement
  behavior.
- Mesa model/schema/artifact/lifecycle tests, including fixed-seed smoke
  reproducibility.
- Frontend rendering, form validation, canonical event reducer, terminal
  timeout UI, and `uiControl` warning/manual-continuation tests.

### API and service integration

- Upload, approved model load, parameter save, run start, polling, cancellation,
  timeout, and successful result retrieval through the demo backend contract.
- Assert the browser-facing backend, not the browser, is the only component
  calling Mesa.
- Assert a timeout does not fetch or render success artifacts.

### Browser end-to-end

- Run the critical scenario against the real Mesa worker with the fixed seeded
  fixture.
- Use the named ARIA/test-id selectors in `ui-workflow.md`; attach to the same
  visible local workbench tab when exercising agent-driven Playwright control.
- Assert the assistant summary, rendered result values, and run ID agree with
  backend artifacts; retain screenshot/video evidence at 1440 x 900.

## Mandatory live OpenCode check

When a local API key is available, the integration suite must run the following
bounded live check against the installed local OpenCode server before claiming
live-integrated completion:

1. Start or health-check the loopback OpenCode server and record its version.
2. List configured providers/models; assert the configured `OPENCODE_MODEL` is
   present, approved, and usable. Do not infer a provider/model ID from a
   display name.
3. Create a disposable project/session and send one tightly scoped prompt that
   can use at most one approved tool (for example select/load the bundled
   `queue-network-v1` model). Apply a finite prompt timeout and verify the
   emitted browser-facing events are canonical and redacted.
4. Assert no arbitrary shell, network, filesystem, Mesa-direct, or unrestricted
   browser tool was exposed; clean up the disposable project/session.

If the required API key is absent, this check may be recorded as
`skipped: missing local API key`. That is an acceptable local test skip, but it
blocks the **live-integrated completion** gate: fixture/fake-agent results must
not be presented as proof that the selected DeepSeek-compatible OpenCode model
works end to end.

## Release gates

| Gate | Required decision and evidence | Owner / independence |
| --- | --- | --- |
| Design | `architecture.md`, Mesa, bridge, UI, and this test plan agree on the bounded model, state/event names, timeout behavior, and evidence. Open interface conflicts are resolved before code. | Design owners; main controller records approval. |
| Implementation | Scoped code is implemented with passing unit/component tests for every traceability row that does not require a running integration. Public contracts and selector names are covered. | Component implementers; no self-waiver for a failed contract test. |
| Integration | Backend, Mesa, UI, and visible-page Playwright scenario pass together; fixed-seed artifact/result identity and timeout/control-warning behavior are retained. Run the live OpenCode check when a key exists. | Integration owner, with evidence attached. |
| Independent review | A reviewer other than the implementer examines diffs, test evidence, redaction/authority boundaries, and the desktop visual result; findings are resolved or explicitly accepted by the controller. | Independent reviewer. |
| Live-integrated completion | All integration evidence plus the mandatory live OpenCode startup/provider/model and bounded chat/tool smoke pass. If the key is absent, this gate remains blocked rather than passed. | Main controller records the final state. |
