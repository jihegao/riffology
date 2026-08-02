# Riffology Stage 7 — default cutover and local acceptance

## Cutover contract

`/` is now the Riffology OpenChamber workbench default. It atomically rewrites
to a fresh `/workbench/new/<workspace-key>` route, where the existing durable
`WorkspaceBinding` workflow owns the Agent-guided project bootstrap. Model and
Project routes remain under `/workbench/models/:id` and
`/workbench/projects/:id`. Historical `/models/:id` and `/projects/:id` links
are not static SPA routes, so they cannot revive the historical Product page.

There is no UI control, navigation item, deep-link hint, or user preference
that opens the historical Product app. A local operator can set
both `VITE_RIFFOLOGY_LEGACY_PRODUCT_UI=true` and
`RIFF_LEGACY_PRODUCT_UI=true` before building to recover it. The first controls
the bundle and the second controls legacy owner-route refreshes. Those flags are
disabled by default, and must not be set for normal or
production-like acceptance. The old bundle code remains present for that
explicit rollback, but has no default routing or visible entry. It is not an authority fallback: unavailable
OpenCode, Provider, Browser Broker, or Riff Store still render their explicit
read-only/recovery state.

## Final acceptance matrix

Run the commands after the final frozen revision. Keep fixture/local-real and
real-Provider evidence separate; an Agent text, DOM, screenshot, or idle state
never creates a Riff fact.

| Scenario | Required assertion |
| --- | --- |
| Default and legacy rollback | root and deprecated mode queries render Riffology; both `VITE_RIFFOLOGY_LEGACY_PRODUCT_UI=true` and `RIFF_LEGACY_PRODUCT_UI=true` form the only local rollback; historical owner paths return 404 otherwise. |
| OpenCode down / Provider down | existing binding and receipts are readable; composer/new-session/domain writes fail closed with the explicit unavailable reason. |
| Broker down / browser lost | central viewer reports unavailable or expired; no alternate browser/URL path is substituted; restarting the Broker yields a new page generation only. |
| Riff recovery-required | all authority surfaces return `503 recovery_required`; the CSP shell may load but contains no fabricated owner, receipt, or output. |
| Restart | WorkspaceBinding, Model/Project records, Experiment/Run receipts and frozen output remain Store-backed after restart; revoked grants and browser page references remain invalid. |
| Continuous live flow | the Stage 7 harness authorizes one exact Run action through a real Provider, waits for the real dispatcher terminal state, verifies Store receipt/output digests, opens the output in the central viewer through real Chromium, and then verifies restart recovery plus stale Browser-generation rejection. No provider fallback is allowed. |

## Reproducible local commands

```sh
bash scripts/check-riffology-openchamber-baseline.sh
(cd backend && npm test)
(cd web && npm test && npm run build)
(cd web && npm run test:e2e:riffology-stage2 && npm run test:e2e:riffology-stage3 && npm run test:e2e:riffology-stage4)
RUN_RIFFOLOGY_STAGE6_REAL_OPENCODE=true RIFFOLOGY_STAGE6_SMOKE_MODEL=opencode-go/deepseek-v4-pro OPENCODE_EXPECTED_VERSION=1.18.11 \
  node --experimental-strip-types --test --test-concurrency=1 backend/test/riffology-stage6-real-opencode.test.ts
RUN_RIFFOLOGY_STAGE7_CONTINUOUS_REAL=true RIFFOLOGY_STAGE7_SMOKE_MODEL=opencode-go/deepseek-v4-pro OPENCODE_EXPECTED_VERSION=1.18.11 \
  node --experimental-strip-types --test --test-concurrency=1 backend/test/riffology-stage7-continuous-real.test.ts
```

The two opt-in commands inherit the operator's separately configured local
OpenCode authentication; they do not read or print credentials. If that
provider is unavailable, record the real-Provider gates as skipped; do not
convert them to deterministic passes.

The Stage 7 continuous harness seeds one deterministic Experiment directly in
the authoritative Store so that this gate isolates the final Run-to-output
chain. It does not claim that the Provider created that Experiment. On the
frozen revision the harness passed twice consecutively with OpenCode 1.18.11
and `opencode-go/deepseek-v4-pro`: zero fallback, terminal `succeeded` Runs,
stable output SHA-256 evidence, a fresh process-random Browser page generation,
stale screenshot rejection, and an unchanged start receipt after restart.
