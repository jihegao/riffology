# OpenCode bridge target contract

## Status and authority

This Gate 0 document defines the Gate 4 integration target. The current bridge
still exposes legacy queue actions. The backend project state remains
authoritative: OpenCode text/session history, DOM state, diagrams, Playwright
observations, and fixture responses are never model, workflow, or run truth.

## Ownership and live-provider boundary

The bridge is backend only. It connects a durable Riff project to one local,
loopback OpenCode session, validates configured provider/model health, supplies
bounded project context, and translates approved typed actions into backend
commands. It never exposes provider credentials, OpenCode session IDs, Mesa,
workspace paths, raw tool payloads, or stack traces to the browser.

Before accepting live chat it:

1. checks the configured local OpenCode server version and health;
2. verifies the provider-qualified `OPENCODE_MODEL` in the server catalogue;
3. enforces the approved provider allowlist;
4. publishes only redacted readiness facts; and
5. fails closed if provider, model, credentials, or server are unavailable.

No hard-coded display name, deterministic fixture, canned reply, or alternate
provider may satisfy the live release gate. Deterministic Agent mode is for
component tests only.

The opaque OpenCode session linkage is stored server side and tied to the
durable `projectId`. On restart it is reused only after verifying both session
existence and workspace ownership; otherwise the bridge opens a new session and
supplies a bounded current-project summary. A temporary browser `sessionId`
does not replace project identity.

## Context handoff

Each prompt contains:

- the user's bounded text and selected upload manifests;
- current decision-brief/alignment/model/experiment/run revision IDs;
- issue and attestation summaries, with unauthenticated-local-identity warning;
- target model and claim-boundary summary;
- allowed action schemas and current snapshot revision.

Uploads remain backend-validated CSV/JSON/TXT files. OpenCode receives bounded
previews through `inspect_uploaded_files`, never a user-provided filesystem path.
The model cannot read arbitrary project files, execute shell commands, write
source, access the network, or call generic browser tools in Phase 1.

## Typed proposal and action surface

Agent changes are proposals or domain actions, not prose side effects:

| Action | Effect |
| --- | --- |
| `inspect_uploaded_files` | Read bounded metadata/text for allowlisted current-project uploads. |
| `propose_decision_brief_revision` | Return a typed brief diff for human/application review. |
| `propose_alignment_revision` | Return typed requirement/assumption/model mappings and impact. |
| `open_issue` | Record a scoped objection/question against exact revisions. |
| `comment_on_issue` | Append discussion to an existing current-project issue. |
| `resolve_issue` | Resolve/close with actor and reason; cannot invent a human attestation. |
| `record_agent_review` | Store a separately labelled Agent attestation; never counts as human endorsement. |
| `propose_experiment_revision` | Return normalized parameter/default/diff/horizon/seed changes. |
| `run_experiment_revision` | Start an exact saved experiment revision; backend derives workflow labels from current scoped policy facts. |
| `get_run_status` | Read bounded backend status/log facts. |
| `read_run_evidence` | Read declared summaries, events, metrics, and view manifests. |
| `drive_workbench_ui` | After domain success, mirror an allowlisted UI intent and report observation. |

The Agent cannot record a human endorsement, alter actor type/role, set
`policySatisfied`, set trust, close an issue without a recorded resolution, or
submit an unversioned parameter override. It cannot claim an action succeeded
until the backend commits it. An Agent `endorse` remains an Agent review.

Human edits and attestations may be submitted directly through the structured
workbench. If one UI gesture targets both alignment and experiment review, both
exact subject revisions must be explicit; no endorsement is silently reused.

## Browser verification

Domain mutations commit first. `drive_workbench_ui` may then use an allowlisted
intent such as opening a view, focusing a parameter, opening an issue, or
opening results. Playwright observation is evidence that the projection is
visible, not evidence that the domain action happened. A mirror failure leaves
committed backend state intact, emits a safe warning, and permits manual
continuation.

The bridge maps provider/tool events into the canonical project snapshot/patch,
conversation delta, agent status, and connection status vocabulary. It
deduplicates reconnects, tolerates unknown upstream event types, refetches
canonical state after gaps, and never forwards raw OpenCode events.

## Result summaries and claim safety

The summary context contains exact project/model/experiment/run identities,
artifact digests, seed, horizon, warm-up, KPI definitions, workflow facts, and
the persistent synthetic/behavioural/single-seed/no-recommendation boundary.
The Agent may summarize observed metrics and diagnostic threshold status. It may
not state AnyLogic equivalence, scientific validation, industry calibration,
optimal crew count, or consequential recommendation.

Zero open issues is phrased as “no recorded open objection.” A human endorsement
is a scoped review record. Neither is phrased as confirmation, correctness, or
trust. Trust claims require separate evidence contracts beyond Phase 1.

## Gate 4 live exit story

One visible 1440 x 900 browser flow with the configured real provider/model must:

1. turn a natural-language wind-farm staffing question into a typed brief and
   alignment proposal;
2. show model/source/claim mappings;
3. edit a parameter, show its diff, reset it, and save the intended experiment;
4. open a blocking issue and show the progression policy unmet;
5. resolve it with reason and record a declared human project-owner endorsement
   through the workbench;
6. render entity/state, process/swimlane, and traceability views from artifacts;
7. run the 100-turbine, 3-crew, 1095-day, 365-warm-up, seed-2 baseline;
8. show the live 2D projection and identity-consistent evidence; and
9. retain all non-claim disclosures in the workbench and Agent summary.

The release test asserts backend/artifact state as well as visible UI, then
restarts the backend and verifies recovery. Only after this replacement passes
does Gate 4 delete all current-tree queue actions, prompts, fixtures, tests, and
precisely identified local queue artifacts.
