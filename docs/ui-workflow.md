# UI workflow contracts

## Milestone A2 current acceptance surface

Stage 2 requires only a narrow integration surface sufficient to prove the New
model and persistent-conversation contracts. It is not the final product shell.
The current authority is
[`milestone-a2-agent-workspace-design.md`](milestone-a2-agent-workspace-design.md):

- create a generic Model using only name and initial provider/model;
- show multiple named conversations with independent durable context;
- show provider/model locked after the first accepted user message;
- distinguish live, connecting, lost, and explicit read-only Agent state;
- show skill-use and allowed/denied action records without exposing opaque
  sessions, credentials, absolute paths, or raw tool payloads;
- keep temporary documents visibly separate from committed Model workspace;
- show Model technical state as “Technically executable,” never as valid,
  trusted, calibrated, or recommended.

The narrow `/a2` HTTP/browser acceptance surface is implemented. It discovers
provider/model pairs, creates a generic Model and its initial conversation, and
sends live turns; the richer conversation/document/action/workspace projections
are verified through the API rather than presented as the final product shell.
A final real browser run created a new generic Model and completed two clean
`opencode-go/deepseek-v4-pro` turns in one OpenCode `1.18.4` session. The second
response incorporated the exact first-turn token, proving visible context reuse.
The prior provider-failure run still proves explicit read-only behavior without
a fabricated assistant response. Session-loss/rebuild, restart, scoped mutation,
and technical-check behavior remain backend integration evidence. A mock
conversation, screenshot, or healthy port alone is insufficient.

The legacy queue/wind UI still coexists and remains runnable history. Stage 2
does not delete it or treat its fixed tabs as the generic workspace. A3-3
installs wind as an ordinary Model, fixed-copy Project, and Experiment and
exercises the generic backend run/output/event contracts; it adds no wind tab,
route, or browser DTO. Final Stage 3 Integration is an isolated API/session
acceptance flow rather than a Product DOM: real Chromium creates a fixed-copy
Project, creates and edits an Experiment, completes a batch, pages events,
downloads output, and verifies recovery after backend restart. The
Models/Projects home, shared two-pane shell, responsive layout,
multi-conversation story, and polished dynamic right pane remain #15.

## A4-2 Home and shared-shell foundation

The governing UI contract is defined by
[`milestone-a4-shared-product-shell-design.md`](milestone-a4-shared-product-shell-design.md).
A4-2 now makes Product Home the default Vite entry with one router: Home at
`/`, and the same two-pane shell at `/models/:modelId` or
`/projects/:projectId`. A subordinate
`?conversation=` selection changes the persistent left pane without remounting
or discarding the right-pane owner workspace.

Home has separate Models and Projects collections plus New Model and New
Project. It uses the closed A4-1 Home and provider DTOs, creates a Model from
only name/provider/model, creates a Project from only name/executable Model,
and disables creation honestly when the required server option is unavailable.
The shell lists only durable Conversation summaries returned by the backend.
The right pane currently renders a truthful owner summary and
explicit A4-4 boundary. A4-4 will select only server-declared, bounded Markdown, code,
table, JSON, chart/diagram, or restricted Model-page renderers. At narrow width
and equivalent 200% layout, a labelled pane selector retains the same owner
state. A dedicated real-Chromium A4-2 scenario covers desktop, narrow,
keyboard pane switching, horizontal fit, real bootstrap/cookie/CSRF, and zero
console errors. The continuous A4-6 matrix and every final trace row remain
pending.

Deprecated `?mode=legacy` and `?mode=evidence` entries remain isolated for
regression only. They are not linked from Product Home and are removed only by
the identity- and manifest-proven A4-5 retirement.

## A4-3 persistent Conversation pane

The left pane now lists active Conversations and exposes archived/trash
recovery lists without changing the right workspace owner key. Users can create
and switch named Conversations, bind an exact discovered provider/model before
the first accepted message, rename/archive/restore/trash them, and permanently
delete only after a separate preview, zero blockers, and exact typed-name
confirmation.

The transcript shows only closed public messages and platform cards.
Attachments expose name, purpose, media type, size, digest, and time; temporary
documents and skill/action records are metadata cards, never raw content,
paths, rationale, intent, or tool payloads. Provider failure preserves the user
message, emits no assistant message, announces `Agent: read only`, disables
only the composer, and leaves lifecycle/resource controls operable. A4-3 uses a
deterministic provider only for focused browser automation; real-provider exit
acceptance remains owned by A4-6.

Untrusted content is rendered from data ASTs into fixed elements with raw HTML
disabled. Active/remote URLs and inline HTML/SVG are rejected, active
attachments are download-only, external HTTPS links are visibly marked with
`noopener noreferrer`, and the app uses the exact CSP and no-store policy in
the A4 design. Stored-XSS, unsafe-URL, remote-load, CSP, cache-rotation, and
back/forward-cache negatives are required A4-4/A4-6 browser evidence.
Renderer limits are fixed by the A4 design for total bytes, Markdown AST,
code lines, table cells, JSON nodes/depth, and chart/diagram complexity.
Oversized content yields a stable bounded fallback or safe source download,
never silent truncation or an unresponsive DOM.

---

# Legacy wind-turbine alignment workbench target

## Status and authority

This Gate 0 contract is the former Gate 3 browser target, not current A2 UI
authority. The checked-out UI may still expose the legacy queue demo.
Backend `ProjectState` and immutable artifacts are authoritative; conversation,
DOM, diagrams, and Playwright actions are projections or verification layers.

## Desktop shell

At the 1440 x 900 acceptance viewport, two persistent regions share one page:

```text
+---------------- Conversation (40%) ----------------+ Workbench (60%) -----+
| actor + project | uploads | messages | composer     | Brief / Model /       |
| Agent proposals and plain-language explanations    | Experiment / Issues / |
|                                                     | Run / Evidence         |
+-----------------------------------------------------+------------------------+
```

Below 960 px the regions become labelled tabs without changing project state.
The workbench remains usable without the assistant. Keyboard and screen-reader
semantics follow the ARIA tabs pattern; charts and diagrams have equivalent
text/tables.

## Required workbench views

| View | Authoritative content |
| --- | --- |
| Brief | Decision question, 95% demo constraint, assumptions, non-goals, sources, revision identity. |
| Model | Model/spec identity, entity/state view, mechanism mapping, synthetic/source labels. |
| Experiment | Editable exposed parameters with default/current/diff, reset, horizon, warm-up, seed, experiment revision. |
| Issues & review | Open/blocking issue counts, exact revision subjects, human endorsements, Agent reviews, derived policy status. |
| Run | Draft/run controls, bounded progress/log, exact identities, cancel, terminal status. |
| Evidence | Daily KPIs, event table, 2D replay, swimlane, traceability, summaries, downloads. |

View selection is presentational. It never mutates workflow, model, experiment,
or run state.

## Parameter edit and reset

Every Phase 1 exposed parameter is editable within the active schema. The form
shows unit, provenance, valid range, distribution family when relevant, default,
current value, and changed marker. `Reset all` previews and then saves the
active model revision's complete default preset as a new experiment revision.
It does not delete prior revisions.

`ReplaceOldEquipment` and its age threshold are deferred strategy fields, not
Phase 1 exposed parameters. Probability-driven major replacement remains an
editable synthetic assumption. Editing a value creates an experiment revision;
editing meaning, unit, range/schema, distribution family, rule, or formula
requires a model revision and is not performed by this form.

## Issues, attestations, and progression

Two review cards are shown separately for alignment-map and experiment
revisions. Each displays:

- human project-owner endorsement count;
- other human attestations;
- Agent reviews in a separate group;
- open blocking and non-blocking issue counts;
- exact subject revision and the derived `policySatisfied` result.

The default threshold is one human project-owner endorsement and zero open
blocking issues. The UI says “no recorded blocking objection,” never
“confirmed,” “trusted,” or “valid.” Local identities are declared and
unauthenticated. Creating an objection prompts for an internal issue; resolving
one requires a reason.

Private draft run remains enabled when policy is unmet, provided execution
safety checks pass. It carries visible `draft_unverified` and
`workflow_policy_unmet` labels. A later endorsement never upgrades an old run;
the user starts a new run for the policy-qualified experiment revision.

## Generated views

The browser renders, but never authors, three view families:

1. Entity/state diagram from `model-spec.json`.
2. Process/swimlane and 2D replay from `domain-events.jsonl` and its replay
   manifest.
3. Business traceability from decision brief, requirement map, model spec, and
   experiment revision.

Each view shows source identity, digest, and generator version. The 2D view
shows the central depot, turbines by state, crews by state/location, queue
counts, day, warm-up/statistics phase, and selected KPIs. Browser playback may
sample frames but cannot hide events from authoritative tables or metrics.

Accessible fallbacks include entity/state lists, a paged event table, a
work-order/crew timeline table, and a requirement-to-rule-to-metric table.

## Browser-visible workflow

| Step | Conversation | Workbench |
| --- | --- | --- |
| Open project | Shows durable project and declared local actor. | Restores current artifact pointers after restart. |
| Describe decision | Agent proposes typed brief/alignment changes. | Shows proposal diff; state changes only after an accepted domain action. |
| Inspect model | Explains source mapping and non-claims. | Shows generated structure and traceability views. |
| Configure | Explains assumptions and impact. | User edits one value, sees diff, resets, then saves intended experiment revision. |
| Raise objection | Agent or human records rationale. | Blocking issue makes policy false but draft run remains available. |
| Review | Human closes the issue with reason and endorses exact revisions. | Counts update; no qualitative truth state appears. |
| Run | Agent may narrate only committed actions. | Starts 100 turbines, 3 crews, 1095 days, 365 warm-up, seed 2. |
| Inspect | Agent summarizes artifact-backed facts with claim labels. | Shows KPIs, events, diagrams, replay, IDs, and downloads. |

Failures, cancellation, and timeout are terminal non-success states with safe
diagnostics. Previous successful results retain their original run identity.
Provider unavailability is explicit and never replaced by a canned live-agent
response.

## Persistent disclosures

The model, experiment, run, evidence, and assistant-summary views always make
available:

- synthetic data and synthetic currency;
- fixed seed 2 and no multi-seed uncertainty;
- behavioural reproduction, not AnyLogic equivalence;
- no weather/components/spares/GIS or real calibration;
- 95% is a user-declared demo target, not an industry benchmark;
- no crew-count or consequential real-world recommendation;
- endorsement/issues are workflow facts, not model trust.

## Gate 3 acceptance

- Real browser state shows exact project/model/experiment/run identities without
  relying on chat claims.
- Default/current/diff/reset behaviour is visible and revisioned.
- A blocking issue changes derived policy; safe draft execution remains
  possible; issue resolution and human endorsement are counted correctly.
- All three generated-view families resolve to documented source artifacts and
  expose accessible equivalents.
- The 100-turbine live projection remains usable; frame reduction does not
  change computation or evidence.
- No secret, absolute path, stack trace, raw tool payload, or unsupported trust
  claim enters the browser.
