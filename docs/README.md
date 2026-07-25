# Riff documentation index and governance

- Status: active
- Role: normative contract
- Scope: repository documentation roles, authority, navigation, and maintenance rules
- Source of truth: this index for documentation governance; linked documents for their declared scope
- Last reviewed: 2026-07-25

## Authority order

Riff has one product requirements authority:
[`product-requirements.md`](product-requirements.md).

Use repository information in this order:

1. the PRD governs MVP outcome, scope, user workflows, architecture boundaries,
   functional requirements, non-functional requirements, and acceptance;
2. merged code and tests govern what is currently implemented;
3. active stage, API, security, and lifecycle documents refine implementation
   within the PRD;
4. revision-scoped test records show what was verified for a named revision;
   and
5. historical documents preserve context but do not govern current product
   behavior.

No stage design, ADR, roadmap, README status paragraph, issue, or historical
Gate document may override the PRD. A documented target is not implementation
evidence.

## Document roles

| Role | Meaning | Change rule |
| --- | --- | --- |
| **Normative contract** | Defines approved product, API, security, lifecycle, or documentation behavior. | Update before or with behavior that changes the contract. |
| **Active design** | Defines an in-progress stage or slice and its pending gates. | Keep implemented and pending boundaries explicit and link decisions to the PRD. |
| **Implementation record** | Records commands, tests, PRs, commits, and acceptance evidence. | Preserve revision/date scope; do not rewrite historical evidence as current evidence. |
| **Historical record** | Retains superseded design or delivery context. | Keep for traceability, label it clearly, and do not use it as current authority. |

New or materially revised active documents must identify near the title:

- `Status`: `active`, `implemented`, `superseded`, or `historical`;
- `Role`: one of the four roles above;
- `Scope`: the bounded subject of the document;
- `Source of truth`: the governing document or implementation authority; and
- `Last reviewed`: the ISO date on which current-state claims were checked.

ADRs use `Proposed`, `Accepted`, or `Superseded` for decision maturity. A
Proposed ADR is a review checklist, not an approved product requirement or
implementation claim.

## Source-of-truth map

| Question | Primary source | Supporting material |
| --- | --- | --- |
| What is the approved MVP? | [`product-requirements.md`](product-requirements.md) | Repository [`README`](../README.md) |
| What is actually implemented? | Merged code and tests | Repository README and revision-scoped PR evidence |
| What remains in Stage 3? | [`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md) | Issue #14 and merged Stage 3 PRs |
| What HTTP/API behavior is exposed? | Merged server/Store code and [`backend-api.md`](backend-api.md) | API and Store tests |
| How do Agent/OpenCode sessions work? | [`milestone-a2-agent-workspace-design.md`](milestone-a2-agent-workspace-design.md) and [`opencode-bridge.md`](opencode-bridge.md) | Agent/API tests |
| What runtime/security boundary is intended? | PRD plus merged implementation and active Stage 3 design | [`architecture.md`](architecture.md) and [`adr/`](adr/README.md) |
| What evidence passed? | [`test-plan.md`](test-plan.md) for its named revision | Test output and PR checks |
| How should Gate/legacy documents be read? | Their historical labels | PRD for every current product decision |

## Current delivery snapshot

This section is navigation only. GitHub merge state and merged code remain the
implementation authority.

| Stage | Status on 2026-07-25 |
| --- | --- |
| **1 — data foundation** | Implemented and merged. |
| **2 — Agent and Model workspace** | Implemented, merged, and accepted with real-provider same-session two-turn evidence. |
| **3 — Project and execution** | In progress. Fixed-copy Projects, deterministic planning, batch lifecycle, cancellation/recovery/completion cards, visual persistence/supervision/dispatch, and the isolated browser broker/frame/WebSocket path plus Chromium security closeout are merged. Scoped Playwright, generic output/event/direct controls, and ordinary wind import remain. |
| **4 — shared product shell** | Pending Stage 3. Owns Models/Projects home, final shared two-pane UX, cleanup, and complete wind browser acceptance. |

A3-2c1 is the merged authority/audit and legacy-CDP-isolation foundation
(PR #38). A3-2c2 adds bounded Project-only read observation through a fresh,
backend-owned browser profile and exact process/listener/peer checks. It adds
no interaction tool; A3-2c3 and A3-2c4 remain pending and Stage 3 remains in
progress.

A3-3 diagnostic-event acceptance begins only after A3-2d publishes the
generic event-ingestion boundary; legacy wind/Gate event routes are not
substitute evidence.

## Active product and stage documents

- [`product-requirements.md`](product-requirements.md): the Chinese single MVP
  PRD, including Platform/Domain Pack ownership, requirement-ID lifecycle, and
  PRD/Roadmap/Architecture/Code authority boundaries.
- [`milestone-a1-data-foundation-design.md`](milestone-a1-data-foundation-design.md):
  implemented Stage 1 SQLite/object-directory, atomic mutation, lifecycle,
  recovery, and fixed-copy Project design.
- [`milestone-a2-agent-workspace-design.md`](milestone-a2-agent-workspace-design.md):
  implemented Stage 2 Conversations, OpenCode, scoped tools/skills, documents,
  generic Model workspace, and technical-check design.
- [`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md):
  active Stage 3 execution design and implementation ledger.
- [`milestone-a1-obsolete-state-removal-plan.md`](milestone-a1-obsolete-state-removal-plan.md):
  audited boundary between later tracked-code retirement and protected local
  state; it does not authorize deletion.

## Active subsystem contracts and evidence

- [`architecture.md`](architecture.md): deeper current execution/security
  architecture plus clearly separated legacy architecture history.
- [`backend-api.md`](backend-api.md): implemented Stage 2/3 API and Store
  boundaries plus retained legacy API history.
- [`opencode-bridge.md`](opencode-bridge.md): current Conversation/OpenCode
  contract followed by the legacy bridge target.
- [`ui-workflow.md`](ui-workflow.md): current minimal UI acceptance surface and
  the legacy/future browser workflow boundaries.
- [`test-plan.md`](test-plan.md): revision-scoped current acceptance and retained
  legacy test history.
- [`adr/README.md`](adr/README.md): Stage 3 ADR review checklist and decision
  maturity.

## Historical product and Gate records

- [`milestone-a-product-contract.md`](milestone-a-product-contract.md): stable
  redirect from the former product contract to the single PRD.
- [`product-roadmap.md`](product-roadmap.md): superseded Gate-era roadmap.
- [`wind-turbine-maintenance-gate-0.md`](wind-turbine-maintenance-gate-0.md):
  former Gate 0 wind target and source mapping.
- [`gate-1-wind-turbine-model-design.md`](gate-1-wind-turbine-model-design.md),
  [`gate-2-project-state-design.md`](gate-2-project-state-design.md), and
  [`gate-3-evidence-studio-design.md`](gate-3-evidence-studio-design.md):
  historical Gate implementation designs.
- [`mesa-service.md`](mesa-service.md): historical wind-specific Mesa service
  contract.

These files may still describe runnable code or useful wind-model evidence.
They do not authorize a wind-only product, removal of Conversation/OpenCode, or
deletion of unrelated local artifacts.

## Validation

Run the dependency-free documentation check before review:

```sh
bash scripts/check-docs.sh
```

It validates relative Markdown links, required active-document metadata,
selected stale-status wording, and Git whitespace. It does not replace
CommonMark rendering, code tests, browser acceptance, or independent review.

## Change rules

1. Update the PRD before or with any product-scope, user-workflow,
   user-visible-claim, or MVP-acceptance change.
2. Keep implementation ledgers in stage/test documents; do not copy
   slice-by-slice status into the PRD or this index unless it aids navigation.
3. Link implementation decisions to stable PRD requirement IDs.
4. Mark superseded documents and preserve stable links instead of maintaining
   a second product contract.
5. Never infer implementation from documentation alone.
6. Never infer permission to delete untracked user files from a cleanup plan or
   historical retirement document.
