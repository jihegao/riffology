# Issue #56 PR 5 exit evidence

- Status: local branch gate passed; draft stacked PR and merged-main rerun are
  separate ordered gates
- Scope: durable post-idle goal verification, recovery, public UI projection,
  and the real Conversation/tool-loop browser exit
- Base dependency: PR 5 is based on Issue #56 PR 4 and therefore depends on
  PR 4, PR 3, PR 2, and PR 1 in order
- Last reviewed: 2026-07-26

## Implemented contract

Schema v16 stores one immutable goal-verification receipt for every Agent turn
newly terminalized under schema v16. Historical terminal turns migrated from
schema v15 remain readable with a null verification; Riff does not fabricate
retroactive evidence. The Store commits each new receipt with the terminal
assistant or failure transition and verifies its digest on readback. Startup first
reconciles durable action records, then records either an interrupted
no-effect failure or a non-retryable outcome-unknown result after an effect.

The verifier distinguishes durable response delivery, explicit mutation, and
visual Model intent. `completed` requires bounded positive evidence:

- proposal-only response text was durably delivered; or
- every explicit action is terminal, every committed action declares a nonempty
  effect, the supported goal/action mapping matches, and the current affected
  resources match the committed mutation transaction; and
- for a visual Model, this turn committed a `model_files_mutate` action and the
  current execution description is valid execution-protocol-v2 with run mode
  `visual` or `both`.

Denied or unverified explicit work needs user input. Provider-down, timeout
without effect, interruption before effect, partial/unknown effects, resource
drift, and incomplete action reconciliation remain distinct non-completed
outcomes. Riff deliberately does not send a second outer prompt after the
native OpenCode tool loop because an ambiguous boundary could duplicate a
mutation.

The runtime/UI now consumes the implemented public DTO shape
(`activeTurn`, `parts`, `pendingInteractions`, `agent`, and `mcp`) and exposes a
terminal goal card. Terminal `needs_user_input` leaves the composer available
when there is no still-active native interaction. Public responses omit the
raw goal/digest, upstream session/message/request identity, paths, credentials,
capabilities, and raw tool payloads.

## Real provider and browser exit

The opt-in exit starts OpenCode `1.18.4` in an ephemeral exact Model owner
directory and selects `zhipuai-coding-plan/glm-5.2`; it does not reuse the
developer repository workdir. One browser-authored user message instructs the
Agent to use these four ordered scoped tools:

1. `riff_read_owner_summary`
2. `riff_list_model_workspace`
3. `riff_read_model_file`
4. `riff_apply_model_changes` exactly once

The final tool uses the exact typed item schema and performs one atomic
mutation. The persisted Model moves from batch to visual mode with a valid v2
visual execution description. OpenCode reaches canonical idle only before the
receipt becomes `completed` with reason `visual_model_state_verified`.
Assertions cover the exact four completed redacted public tool-result labels in
the requested order, exactly one committed mutation, exactly one durable user
message, browser refresh, backend restart, and public-response leak negatives.

Command:

```bash
cd web
npm run test:e2e:issue-56-live
```

Observed 2026-07-26 final result: Chromium 1/1 passed; provider scenario
40.5 seconds (41.9 seconds including runner setup).

The installed-server integration smoke independently verified two ordered MCP
tool calls, canonical idle reconciliation, and capability revocation:

```bash
cd backend
RUN_OPENCODE_MULTI_TOOL_SMOKE=true \
OPENCODE_LIVE_SMOKE_MODEL=zhipuai-coding-plan/glm-5.2 \
node --experimental-strip-types --test test/opencode-smoke.test.ts
```

Observed result: live case passed in 22.2 seconds; the unrelated opt-in
non-credential case remained skipped.

## Deterministic negative matrix

Focused backend coverage verifies:

- provider unavailable becomes `read_only` without a fabricated reply;
- wall timeout before an effect becomes non-completed
  `budget_exhausted`;
- timeout or abort after an effect becomes non-retryable `outcome_unknown`;
- stale affected-resource evidence becomes `outcome_unknown`;
- explicit idle with no committed action becomes `needs_user_input`;
- proposal-only idle with a durable answer becomes `completed`;
- restart recovery distinguishes no-effect interruption from a committed
  visual action whose outcome must be reviewed;
- receipt inserts are atomic, digest-bound, migration-safe, immutable, and
  required for direct terminal inserts and every new terminal transition under
  schema v16;
- runtime refresh/restart preserves the terminal projection and excludes raw
  goal text/digest, paths, upstream IDs, and capability material;
- the Web normalizer renders the actual public permission/question/runtime
  shape without depending on internal adapter fields.

The final gate records the exact aggregate test counts in
[`test-plan.md`](test-plan.md).

## Defects found by the exit

The first real browser pass exposed two integration gaps that deterministic
adapter-shaped fixtures had hidden:

- the Web client normalized legacy/internal runtime field names instead of the
  implemented public API shape, hiding live permission/question controls; and
- `riff_apply_model_changes` exposed an underspecified array-item schema, so the
  model guessed unsupported keys even though the server implementation already
  required exact typed fields.

The fixes are limited to public DTO normalization and exact MCP input-schema
publication. They do not broaden owner, object, operation, filesystem, command,
or credential authority.

## Claim boundaries

This evidence proves the Issue #56 Conversation/OpenCode/tool/receipt path for
the exact tested provider/model and owner-scoped visual mutation. It does not
prove simulation semantic correctness, calibration, AnyLogic equivalence,
generic Model technical-check success, automatic visual-run startup, provider
generality, merged-main state, or Issue closure.
