# Wind-turbine alignment workbench target

## Status and authority

This Gate 0 contract is the Gate 3 browser target, not current UI behaviour.
Until Gates 1-4 land, the checked-out UI still exposes the legacy queue demo.
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
