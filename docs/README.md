# Riff documentation index and governance

- Status: active
- Role: normative contract
- Scope: repository documentation roles, authority, navigation, and maintenance rules
- Source of truth: this index for documentation governance; linked documents for their declared scope
- Last reviewed: 2026-08-01

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
| What was accepted in Stage 3? | [`milestone-a3-project-execution-design.md`](milestone-a3-project-execution-design.md) | Issue #14 and merged Stage 3 PRs |
| What HTTP/API behavior is exposed? | Merged server/Store code and [`backend-api.md`](backend-api.md) | API and Store tests |
| How do Agent/OpenCode sessions work? | [`milestone-a2-agent-workspace-design.md`](milestone-a2-agent-workspace-design.md) and [`opencode-bridge.md`](opencode-bridge.md) | Agent/API tests |
| What runtime/security boundary is intended? | PRD plus merged implementation, implemented Stage 3 design, and the A4-0 target design | [`architecture.md`](architecture.md) and [`adr/`](adr/README.md) |
| What evidence passed? | [`test-plan.md`](test-plan.md) for its named revision | Test output and PR checks |
| What visual prototypes supplement the UI design? | PRD and active stage documents | [`prototypes/`](prototypes/README.md), as non-normative visual material |
| How should Gate/legacy documents be read? | Their historical labels | PRD for every current product decision |

## Current delivery snapshot

This section is navigation only. GitHub merge state and merged code remain the
implementation authority.

| Stage | Status on 2026-07-25 |
| --- | --- |
| **1 — data foundation** | Implemented and merged. |
| **2 — Agent and Model workspace** | Implemented, merged, and accepted with real-provider same-session two-turn evidence. |
| **3 — Project and execution** | Implemented and accepted. Fixed-copy Projects, deterministic planning, batch/visual lifecycle, scoped Playwright, isolated browser broker/frame/WebSocket, generic output/event access, direct controls, A3-2d4 revocation, A3-3 ordinary wind import, and the narrow Product Chromium restart flow are complete. |
| **4 — shared product shell** | Implemented, merged through PR #55, rerun on merged `main`, and closed with Issue #15 on 2026-07-25. |

A3-2c1 is the merged authority/audit and legacy-CDP-isolation foundation
(PR #38). A3-2c2 adds bounded Project-only read observation through a fresh,
backend-owned browser profile and exact process/listener/peer checks. A3-2c3's
one-use typed interaction was merged through PR #41 and A3-2c4's live-CDP and
real-Chromium security closeout through PR #42. A3-2d1 output list/download was
merged through PR #43. A3-2d2 diagnostic event ingestion and opaque cursor
reads were merged through PR #44; A3-2d3 direct controls are the active
boundary merged through PR #45. The d3 merge gate is
552 backend total/551 passed/zero failed/one optional smoke skipped, web
104/104, network entry 1/1, successful production build and docs check, with
no P0/P1 finding in final independent security review.
Merged PR #46 adds one fault-injected production
API/revocation-wiring backend matrix and one real Chromium flow. They prove
that run trash revokes an unredeemed nonce, a redeemed frame, an open
WebSocket, and Visual-Agent authority, while restore does not revive any old
capability. Its focused gates pass 65/65 and 6/6.
The full merge gate is 553 backend total/552 passed/zero failed/one
optional OpenCode smoke skipped, web 104/104, network entry 1/1, full Chromium
15/15, successful production build, and a 24-file docs check. Independent
security review reports P0/P1=0.

A3-3, merged through PR #47, uses the published generic A3-2d2 event boundary. Schema v13 records the
immutable manifest installation; the reviewed source bytes enter ProductStoreV2
as an ordinary executable Model, fixed-copy Project, and named synthetic
single-seed Experiment. A real generic run produces 1,096 daily rows, 38,730
events, two indexed outputs, and restart-stable reads. There is no wind route,
DTO field, fabricated conversation, analysis, or recommendation.
The final A3-3 review gate is backend 570 total/569 passed/zero failed/one
optional OpenCode smoke skipped, web 104/104, network entry 1/1, Chromium
15/15, reviewed wind 38/38, a successful production build, and a 25-file docs
check. Independent review reports P0/P1=0.
Final Stage 3 Integration adds one isolated real-Chromium Product flow. It
creates a fixed-copy Project from the ordinary wind Model, creates and edits an
Experiment, completes a real batch, pages generic diagnostic events, downloads
an indexed output, restarts the backend on the same ports, bootstraps fresh
process-local browser authority, and verifies durable Project/Run/event/output
reads with zero console errors. It is not the Stage 4 shared shell.

A4-0 is the documentation-only design gate. The design in
[`milestone-a4-shared-product-shell-design.md`](milestone-a4-shared-product-shell-design.md)
defines the Stage 4 traceability, target Home/API/shell/renderer contracts,
resource deletion safety, browser admission, recovery, and precise retirement
boundary. A4-1 now supplies schema-v14 lifecycle/delete receipts, closed Home
and collection DTOs, generic lifecycle routes, preview/confirm permanent
deletion, and uniform Product browser admission. A4-2 consumes that boundary
for the default Home, Model/Project routes, one shared two-pane shell, honest
read-only creation states, and responsive/keyboard foundations. Deprecated
Legacy/Evidence queries now resolve to Product and their old Web
implementations are retired under the A4-5 exact manifest. A4-3 adds the
persistent Conversation pane, schema-v15 provider-binding receipts, safe
message/attachment/document/activity projections, lifecycle recovery and
preview/confirm deletion, plus explicit no-fabrication read-only behavior.
A4-4 supplies the dynamic workspace/execution slice described above. A4-5
supplies recovery/cutover/retirement without touching protected local state.
A4-6 revision-scoped evidence is retained through the stable
[`a4-6-exit-evidence.md`](a4-6-exit-evidence.md) redirect. PR #55 merged as
`d333580`, the merged-main rerun passed, and Issue #15 is closed.

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
  implemented Stage 3 execution design and implementation ledger.
- [`milestone-a4-shared-product-shell-design.md`](milestone-a4-shared-product-shell-design.md):
  A4-0 design gate, A4-1 Product API record, A4-2 Home/shared-shell record, and
  A4-3 Conversation, A4-4 dynamic workspace/execution, and A4-5
  recovery/cutover/retirement implementation records; final exit remains
  pending.
- [`milestone-a4-5-retirement-manifest.md`](milestone-a4-5-retirement-manifest.md):
  exact tracked-code retirement identities, replacements, exclusions, and
  postconditions, mechanically verified against the merged A4-4 baseline.
- [`dynamic-workbench-ui-design.md`](dynamic-workbench-ui-design.md):
  active post-MVP shared-shell refinement for full-height Conversation,
  weak-contract generated Model views, and file/change review.
- [`openchamber-browser-workbench-migration-plan.md`](openchamber-browser-workbench-migration-plan.md):
  approved staged migration design for the Riffology OpenChamber-derived
  conversation shell, a shared controlled browser, retained Riff domain
  authority, seven local-only PR gates, and configuration-level rollback.
- [`riffology-openchamber-stage-1-baseline.md`](riffology-openchamber-stage-1-baseline.md):
  Stage 1 design digest, reproducible validation, upstream/toolchain tuple,
  disabled-surface contract, and required fork-license/delta ledger.
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
- [`prototypes/`](prototypes/README.md): non-normative interface prototypes
  supplementing information architecture, user stories, and interaction
  review.

## Historical product and Gate records

- [`milestone-a-product-contract.md`](milestone-a-product-contract.md): stable
  redirect from the former product contract to the single PRD.
- [`archive/`](archive/README.md): historical-document index.
- [`archive/gate-era/`](archive/gate-era/README.md): complete superseded
  Gate-era roadmap, Wind target/model, Evidence Studio, Project-state, and
  wind-specific Mesa service documents. Their former `docs/*.md` locations are
  retained as short compatibility redirects.
- [`archive/evidence/`](archive/evidence/README.md): revision-scoped exit
  evidence, including the completed A4-6 and Issue #56 PR 5 records.

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
7. Move complete superseded content under `docs/archive/`, add historical
   metadata and an archive index, and retain a short redirect at any established
   public path.
