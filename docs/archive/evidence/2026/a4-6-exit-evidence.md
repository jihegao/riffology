# A4-6 MVP exit evidence（历史归档）

- Status: historical; PR #55 merged as `d333580`, merged-main rerun passed, and
  Issue #15 closed on 2026-07-25
- Role: implementation record
- Source of truth: merged revision `d33358007b36a1b4102c6dacd2c50bb302da32cc`
- Last reviewed: 2026-07-28
- Date: 2026-07-25
- Scope: the A4-6 implementation branch and the cumulative Stage 4 gate
- Redaction: no credential, OpenCode session identifier, absolute workspace
  path, or raw tool payload is recorded here

## Provider selection record

OpenCode 1.18.4 discovery first confirmed the configured qualified model
`opencode-go/deepseek-v4-pro`. Its attempted live turn returned an explicit
weekly-usage-limit error. The execution plan had already authorized DeepSeek
flash-free if OpenCode Go quota was exhausted, provided the exact identifier
was rediscovered and recorded.

A second credential-free discovery against the explicitly allowed `deepseek`
provider confirmed `deepseek/deepseek-v4-flash`. The acceptance process then
set both `A4_6_PROVIDER_ID=deepseek` and
`A4_6_MODEL_ID=deepseek-v4-flash`; the test did not silently substitute a
provider or change a locked Conversation.

## Continuous Chromium evidence

The final aggregated `npm run test:e2e:a4-6` invocation passed 1/1 in 31.2
seconds. The single same-root scenario covers the twelve
exit steps:

1. Home and the four product entries;
2. an ordinary wind Model;
3. two real provider turns, two temporary documents, and an attachment;
4. a second Conversation with persistent state and right-workspace identity;
5. a fixed-copy Project;
6. a Project Conversation CAS update with right-workspace identity retained;
7. real batch status, outputs, events, digest-checked download, and rendering;
8. an analysis document only after an explicit user request;
9. a restricted visual frame and cancellation;
10. same-root backend restart and supported-resource recovery;
11. provider-down `read_only` behavior with no fabricated reply while a direct
    Run and download remain available; and
12. 1440x900, narrow layout, actual CDP scale 2, Tab/Shift+Tab plus Enter/Space
    pane operation while scale 2 remains active, no document horizontal
    overflow, screenshots, and zero unexpected console or page errors.

The scenario also scans admitted browser API responses for credential,
external-session, absolute-path, and raw-tool-payload canaries.

## Cumulative branch gate

The traceability matrix is supported by cumulative slice and final-gate
evidence. The A4-6 continuous scenario is the integrated exit path; it is not
presented as the sole proof for every negative or recovery row.

| Gate | Result |
| --- | --- |
| Backend full suite | 598 total, 597 passed, 0 failed, 1 optional installed-OpenCode smoke skipped |
| Focused A4-6 backend | 28/28, including operation-cross-talk and schema-default replay negatives |
| Web unit suite | 28/28 |
| Production-entry integration | 1/1 |
| Production Web build | passed |
| Retained Chromium aggregate | 18/18: A4-2, A4-3, A4-4, A4-5, A4-6, A3 Product, broker/WebSocket 6/6, Visual-Agent 6/6 |
| Documentation governance | 29 Markdown files passed plus `git diff --check` |
| Independent reviews | correctness/security P0/P1/P2=0; accessibility P0/P1/P2=0; product/architecture found no technical P0/P1/P2 and its sole administrative P1 is resolved by this final recorded status |

The local branch gate is complete. After merge, the critical A4-6 scenario is
rerun from the merged `main`; only then may Issue #15 close.
