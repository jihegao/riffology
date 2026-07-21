# Gate 4 hard-retirement design

## Status, authority, and changed decision

This is the design-only implementation contract for issue #6. The observed
baseline is branch `codex/gate-4-retire-legacy` at `0b23ce0` on 2026-07-21.
Nothing in this document claims that retirement, local deletion, review, or
release acceptance has happened.

The controlling product decision is stricter and newer than the issue's
original wording:

- delete `queue-network-v1` completely;
- delete the legacy UI/session/MCP/OpenCode product capability completely;
- keep no fallback, hidden mode, compatibility route, disabled provider
  configuration, fixture-only substitute, or downgrade path;
- preserve the wind-turbine Evidence Studio and its durable evidence.

This explicitly supersedes issue #6's earlier real-provider acceptance. A real
OpenCode run is no longer a release prerequisite because the provider bridge
itself is removed. Provider availability and provider-unavailable behavior are
therefore not Gate 4 states. Gate 4 instead proves that the retired capability
is absent and cannot be selected or invoked.

The backend durable project projection remains workflow authority. The
reviewed `wind-turbine-maintenance` bundle remains model authority. Verified
immutable wind run artifacts remain result authority. Browser state, charts,
conversation copy, deletion reports, and GitHub prose are evidence or
projections, never new domain facts.

## Exit contract

Gate 4 is accepted only when all of these statements are simultaneously true:

1. `/` has one product surface: wind Evidence Studio. Query strings, including
   the former mode selector, cannot expose a second UI.
2. The backend has no root session API, MCP endpoint, provider adapter, agent
   readiness, prompt/event bridge, browser-driving projection, or legacy
   in-memory `ProjectState`.
3. Mesa has no queue model, queue contracts, queue worker, or generic legacy
   model/run API. Wind APIs used by Evidence Studio remain.
4. Tracked source, runtime, UI, configuration, tests, lockfiles, and current
   user documentation have zero retired-product fingerprints under the exact
   scan policy below.
5. The wind unit, integration, recovery, E2E, responsive-browser, and restart
   persistence suites pass without provider configuration or a deterministic
   provider substitute.
6. A manifest-bound dry run and reviewed deletion report identify exact local
   queue artifacts. Only after code review, and before PR acceptance, the same
   frozen manifest is applied. The post-delete audit finds no exact queue
   reference and no ambiguity.
7. Unrelated projects, wind evidence, workspace roots/indexes, inputs, pending
   command records, quarantine roots, and ambiguous records are preserved.
8. Git history is retained. Rollback of tracked code is by Git revert only;
   no deleted product implementation is kept as a runtime flag or archive.

No exception is allowed because a removed path is "test only", "documentation
only", "disabled", or "useful for comparison". Historical discussion remains
available in Git and issue/PR history, not in the released tree.

## Read-only baseline and fingerprint policy

The baseline inventory used `git ls-files`, targeted `rg`, JSON parsing, and
SHA-256 comparison only. It did not delete, rename, stage, or commit anything.

| Observation | Baseline result |
| --- | ---: |
| Tracked files | 133 |
| Tracked files hit by the expanded textual candidate scan | 55 |
| Workspace roots inspected | 3 |
| Non-empty workspace roots | 1 (`.riff-workspaces`) |
| Project directories in the non-empty root | 1 |
| Quarantine container directories | 20 |
| Queue manifests | 25 |
| Queue active pointers | 15 |
| Queue-signature run requests | 18 |
| Unique request-bound model revisions | 17 |
| Run metadata files | 18 |
| Explicit `model_id` in metadata | 1 |
| Run summaries with exact queue `model_id` | 18 |
| Request digests matching metadata | 18 of 18 |
| Run-to-manifest digest links matching | 18 of 18 |
| Active-to-manifest digest links matching | 15 of 15 |
| Input files without a formal model-identity binding | 24 (23 quarantine, 1 live project) |

The 17 metadata records without `model_id` are not identified by their
directory names. Their current queue identity is derivable only through the
exact request revision, matching request digest, matching manifest digest, and
the same-container manifest. The apply pass must re-prove all four links.

"Retired-product fingerprint" is deliberately specific. It includes:

- exact queue identity/class/module and its four legacy parameter keys and
  three legacy output keys;
- OpenCode names, environment keys, adapter/readiness/event types, provider
  copy, and provider test fixtures;
- root `/mcp`, root `/api/sessions`, legacy chat/upload/parameter/run routes,
  MCP tool names, capability tokens, and legacy browser-session state;
- `LegacyApp`, `legacy.css`, the legacy UI subtree, the mode switch, and former
  query-mode labels.

It does **not** ban the English word `queue` globally. Corrective and planned
maintenance queues, their wind KPI fields, and replay aggregates are valid
wind-domain concepts. It also does not classify Gate 3's verified historical
wind artifact format as the removed product merely because an internal enum
contains the word `legacy`. Those wind records are not a queue/OpenCode entry
point, and removing their verifier would destroy Evidence Studio evidence.
Tests must prove this distinction with an explicit retired-symbol list and an
explicit wind allowlist; a broad `grep legacy` is neither safe nor sufficient.

### Reproducible baseline scan

The 55-hit number is tied to the immutable input commit, not to the later
working tree that contains this design. Run from the repository root with
`LC_ALL=C`; the first command must print `55`, and the second command is the
sorted input to the file-level disposition table below:

```bash
BASELINE_COMMIT=0b23ce0
BASELINE_PATTERN='queue[-_ ]network|queuenetworkmodel|arrival_rate|initial_backlog|service_capacity|service_time|queue_length|average_wait|opencode|RIFF_SKIP_OPENCODE|RIFF_MCP_URL|RIFF_CDP_URL|RIFF_SESSION_ID|OPENCODE_PROMPT_TIMEOUT_MS|LegacyApp|mode=legacy|Legacy queue|/api/sessions|riff_select_and_load_model'
LC_ALL=C git grep -IilE "$BASELINE_PATTERN" "$BASELINE_COMMIT" -- | cut -d: -f2- | sort | wc -l
LC_ALL=C git grep -IilE "$BASELINE_PATTERN" "$BASELINE_COMMIT" -- | cut -d: -f2- | sort
```

The input universe is every regular tracked blob from `git ls-tree -r
--name-only 0b23ce0`, and binary blobs are ignored by `git grep -I`. Final
acceptance runs the exact rule IDs below against the final commit rather than
reusing the broad baseline pattern.

### Exact forbidden rules

All literal rules are case-sensitive unless marked `ASCII-i`. Path rules apply
to normalized repository-relative paths. A zero-hit rule has no exception
unless the wind allowlist names the exact file and exact allowed meaning.

| Rule ID | Exact forbidden literals or route/path condition |
| --- | --- |
| `Q-ID-01` | `queue-network-v1` |
| `Q-ID-02` | `QueueNetworkModel` |
| `Q-ID-03` | `queue_network.py`, `queue_network`, `queue_network_v1` |
| `Q-PAR-01..04` | `arrival_rate`, `initial_backlog`, `service_capacity`, `service_time` |
| `Q-OUT-01..03` | `queue_length`, `completed_jobs`, `mean_wait_time` |
| `Q-TOOL-01..08` | `riff_inspect_uploaded_files`, `riff_select_and_load_model`, `riff_set_parameters`, `riff_run_experiment`, `riff_get_run_status`, `riff_read_run_results`, `riff_drive_workbench_ui`, `show_dashboard` |
| `Q-ACTION-01..07` | `inspect_uploaded_files`, `select_and_load_model`, `set_parameters`, `run_experiment`, `get_run_status`, `read_run_results`, `drive_workbench_ui` when used as the removed `SimulationActions` action discriminators |
| `OC-NAME-01` | ASCII-i `opencode`, including symbols, filenames, prose, provider fixtures, and source-map text |
| `OC-ENV-01..12` | `OPENCODE_API_KEY`, `OPENCODE_MODEL`, `OPENCODE_URL`, `OPENCODE_ALLOWED_PROVIDERS`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_PROMPT_TIMEOUT_MS`, `RIFF_SKIP_OPENCODE`, `RIFF_MCP_URL`, `RIFF_CDP_URL`, `RIFF_SESSION_ID`, `RUN_OPENCODE_SMOKE` |
| `OC-ROUTE-01` | the root HTTP route `/mcp` and any MCP registration/capability path |
| `OC-ROUTE-02` | root `/api/sessions` and descendants; this rule explicitly excludes durable `/api/projects/{projectId}/sessions` |
| `MCP-NAME-01` | `McpToolServer`, `mcpCapabilities`, `capabilityTtlMs`, and `mcpUrl` in the removed root-session capability implementation |
| `UI-01..08` | `LegacyApp`, `legacy.css`, normalized path prefix `web/src/legacy/`, import prefix `./legacy/`, `mode=legacy`, `?mode=legacy`, `?mode=evidence`, `Legacy queue / OpenCode` |
| `UI-09..10` | CSS selectors/classes `.mode-switch` and `.legacy-mode` |
| `PATH-01` | every exact path in **Delete outright** |

`Q-PAR` and `Q-OUT` are legacy only in their old four-parameter/three-output
contract or outside the allowlist. A single `service_capacity` in the original
wind source-reference record and wind fields such as
`corrective_queue_length` are allowed only at the exact files listed below.
Substring matching must retain match offsets so an allowlist for
`corrective_queue_length` cannot accidentally permit a standalone legacy
`queue_length` field in an unrelated file.

### Complete 55-hit disposition

Every file emitted by the reproducible baseline scan has one disposition:

| Exact file | Final disposition |
| --- | --- |
| `.env.example` | Rewrite to zero `OC-*` hits. |
| `README.md` | Rewrite to zero queue/OpenCode/legacy-product hits. |
| `backend/src/gate3-runtime.ts` | Preserve only `W-WIND-QUEUE` and `W-FRAMELESS`; remove any other forbidden hit. |
| `backend/src/index.ts` | Rewrite to zero `OC-*` and old-session hits. |
| `backend/src/mcp.ts` | Delete (`PATH-01`). |
| `backend/src/opencode-adapter.ts` | Delete (`PATH-01`). |
| `backend/src/opencode-events.ts` | Delete (`PATH-01`). |
| `backend/src/server.ts` | Prune to zero root-session/MCP/OpenCode/action hits; retain durable project sessions. |
| `backend/src/simulation-actions.ts` | Delete (`PATH-01`). |
| `backend/test/gate2-api.test.ts` | Rewrite: remove no-agent/legacy coexistence, add negative root-route proof. |
| `backend/test/gate2-real-integration.test.ts` | Rewrite to wind-only construction. |
| `backend/test/gate3-api.test.ts` | Rewrite to wind-only construction. |
| `backend/test/gate3-real-integration.test.ts` | Rewrite to wind-only construction. |
| `backend/test/gate3-recovery.test.ts` | Rewrite to wind-only construction; do not remove framed recovery. |
| `backend/test/mcp-events.test.ts` | Delete (`PATH-01`). |
| `backend/test/opencode-smoke.test.ts` | Delete (`PATH-01`). |
| `backend/test/project-store.test.ts` | Delete (`PATH-01`). |
| `backend/test/server.test.ts` | Split retained wind adapter error tests, then remove all old server fixtures/hits. |
| `docs/README.md` | Rewrite to zero retired-product hits. |
| `docs/architecture.md` | Rewrite to wind-only current architecture. |
| `docs/backend-api.md` | Rewrite to wind-only current API. |
| `docs/gate-1-wind-turbine-model-design.md` | Rewrite stale migration statements; preserve its exact `W-WIND-QUEUE` metric declaration. |
| `docs/gate-2-project-state-design.md` | Rewrite stale migration/provider statements; preserve Gate 2 evidence. |
| `docs/gate-3-evidence-studio-design.md` | Rewrite retired-product statements; preserve exact `W-FRAMELESS` contract only. |
| `docs/mesa-service.md` | Rewrite to wind-only current service. |
| `docs/opencode-bridge.md` | Delete (`PATH-01`). |
| `docs/product-roadmap.md` | Rewrite completed cutover state. |
| `docs/test-plan.md` | Replace provider/queue acceptance with absence and wind regression. |
| `docs/ui-workflow.md` | Rewrite to one Evidence Studio route. |
| `docs/wind-turbine-maintenance-gate-0.md` | Rewrite obsolete Gate 4/provider and queue-retirement prose; preserve Gate 0 wind contract. |
| `mesa_service/README.md` | Rewrite to wind-only runtime. |
| `mesa_service/src/mesa_service/contracts.py` | Delete (`PATH-01`). |
| `mesa_service/src/mesa_service/gate3_verify_run.py` | Preserve exact `W-WIND-QUEUE` validation only. |
| `mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/defaults/source-field-service-reference.json` | Preserve the one source-backed `service_capacity` field as `W-SOURCE-REF`; it is not a runnable legacy parameter contract. |
| `mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/metric-schema.json` | Preserve exact corrective/planned wind queue metrics as `W-WIND-QUEUE`. |
| `mesa_service/src/mesa_service/models/queue_network.py` | Delete (`PATH-01`). |
| `mesa_service/src/mesa_service/models/wind_turbine_maintenance/framed_model.py` | Preserve exact wind queue aggregation as `W-WIND-QUEUE`. |
| `mesa_service/src/mesa_service/models/wind_turbine_maintenance/model.py` | Preserve exact wind maintenance queue state as `W-WIND-QUEUE`. |
| `mesa_service/src/mesa_service/service.py` | Prune queue imports/storage/dispatch; preserve reached wind endpoints only. |
| `mesa_service/src/mesa_service/worker.py` | Delete (`PATH-01`). |
| `mesa_service/tests/test_api.py` | Delete after its four queue-only tests are retired (`PATH-01`). |
| `mesa_service/tests/test_contracts.py` | Delete (`PATH-01`). |
| `mesa_service/tests/test_wind_model.py` | Preserve exact wind queue assertions as `W-WIND-QUEUE`. |
| `scripts/e2e-live.mjs` | Delete (`PATH-01`). |
| `scripts/e2e-local.mjs` | Delete (`PATH-01`). |
| `scripts/start-local-demo.sh` | Rewrite to provider-free wind stack. |
| `web/e2e/evidence-studio.spec.ts` | Remove legacy-entry assertion; retain and extend wind browser story. |
| `web/e2e/start-live-stack.sh` | Remove skip-provider configuration; rename without compatibility wrapper. |
| `web/src/App.test.tsx` | Rewrite to assert a single Evidence Studio. |
| `web/src/App.tsx` | Rewrite to render only Evidence Studio. |
| `web/src/EvidenceStudioApp.test.tsx` | Preserve exact wind KPI plus `W-FRAMELESS` unavailable-evidence tests. |
| `web/src/LegacyApp.tsx` | Delete (`PATH-01`). |
| `web/src/evidence.ts` | Preserve exact wind KPI/replay queue fields and `W-FRAMELESS` verification. |
| `web/src/legacy/LegacyApp.test.tsx` | Delete (`PATH-01`). |
| `web/src/legacy/api.ts` | Delete (`PATH-01`). |

Structural reachability adds files that the 55-hit text scan did not find.
Delete the remaining exact legacy subtree/type files already listed under
`PATH-01`; prune `backend/src/mesa-adapter.ts`, `mesa_service/src/mesa_service/app.py`,
`web/src/main.tsx`, and `web/playwright.config.ts`; and prune
`web/src/styles.css` by deleting only `.mode-switch` rules. The
`.evidence-mode` selectors are the current Evidence Studio namespace and stay.

The complete file-level wind allowlist is therefore:

| Allow rule | Exact files and allowed disposition |
| --- | --- |
| `W-SOURCE-REF` | `mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/defaults/source-field-service-reference.json`: source provenance field `service_capacity` only. |
| `W-WIND-QUEUE` | `backend/src/gate3-runtime.ts`; `docs/gate-1-wind-turbine-model-design.md`; `mesa_service/src/mesa_service/gate3_verify_run.py`; `mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/metric-schema.json`; `mesa_service/src/mesa_service/models/wind_turbine_maintenance/framed_model.py`; `mesa_service/src/mesa_service/models/wind_turbine_maintenance/model.py`; `mesa_service/tests/test_wind_model.py`; `web/src/EvidenceStudioApp.test.tsx`; `web/src/evidence.ts`: only corrective/planned maintenance queue fields, aggregates, and assertions. |
| `W-FRAMELESS` | `backend/src/gate3-runtime.ts`; `docs/gate-3-evidence-studio-design.md`; `web/src/types.ts`; `web/src/EvidenceStudioApp.test.tsx`; `web/src/evidence.test.ts`; `web/src/evidence.ts`: only the `legacy_frameless` wind replay enum, exact verification branch, unavailable-reason projection, type, and tests. |

No other file may contain `legacy_frameless`. It is not a UI route, backend
session, provider fallback, queue model, or runnable compatibility mode; it
only verifies and truthfully projects already-committed wind evidence that has
no replay frames. A new occurrence or a branch that generates new frameless
artifacts fails the scan.

## Authoritative tracked-path inventory

The inventory combines textual fingerprints with import/call reachability.
Text search alone misses files such as the CSS import seam and type-only legacy
modules.

### Delete outright

These paths have no wind responsibility after callers are cut over:

| Area | Exact tracked paths |
| --- | --- |
| Backend capability | `backend/src/mcp.ts`; `backend/src/opencode-adapter.ts`; `backend/src/opencode-events.ts`; `backend/src/playwright-projection.ts`; `backend/src/project-store.ts`; `backend/src/simulation-actions.ts`; `backend/src/types.ts` |
| Backend tests | `backend/test/mcp-events.test.ts`; `backend/test/opencode-smoke.test.ts`; `backend/test/project-store.test.ts` |
| Mesa queue runtime | `mesa_service/src/mesa_service/contracts.py`; `mesa_service/src/mesa_service/models/queue_network.py`; `mesa_service/src/mesa_service/worker.py` |
| Mesa queue tests | `mesa_service/tests/test_api.py`; `mesa_service/tests/test_contracts.py` |
| Legacy web | `web/src/LegacyApp.tsx`; `web/src/legacy.css`; `web/src/legacy/LegacyApp.test.tsx`; `web/src/legacy/api.ts`; `web/src/legacy/state.ts`; `web/src/legacy/state.test.ts`; `web/src/legacy/types.ts` |
| Obsolete harnesses | `scripts/e2e-live.mjs`; `scripts/e2e-local.mjs` |
| Obsolete current documentation | `docs/opencode-bridge.md` |

No barrel export, copied fixture, compatibility shim, ignored duplicate, or
commented implementation may replace these files.

### Prune or rewrite in place

| Area | Exact tracked paths and required result |
| --- | --- |
| Process/config | `.env.example`, `backend/src/index.ts`, `scripts/start-local-demo.sh`: retain only Mesa/workspace/backend/web settings; remove every provider, MCP, CDP, prompt-timeout, default legacy-session, and skip-agent branch. |
| Backend router | `backend/src/server.ts`: retain durable Gate 2/Gate 3 project APIs; remove legacy store/actions/MCP/provider ownership, initialization/subscriptions, root session routes, root MCP route, chat/upload/parameter/run handlers, and agent health projection. |
| Mesa adapter | `backend/src/mesa-adapter.ts`: remove `loadModel`, generic queue run/results conversions, and dependencies on `backend/src/types.ts`; retain the wind dispatch/evidence/event/artifact/activation contract. |
| Backend tests | `backend/test/gate2-api.test.ts`, `gate2-real-integration.test.ts`, `gate3-api.test.ts`, `gate3-real-integration.test.ts`, `gate3-recovery.test.ts`, and `server.test.ts`: remove provider mocks and legacy coexistence assertions; retain durable/wind behavior and add negative route checks. The two useful stable-error Mesa adapter tests in `server.test.ts` move to a wind adapter test rather than preserving legacy setup. |
| Mesa router/service | `mesa_service/src/mesa_service/app.py` and `service.py`: remove the queue loader, generic queue start/status/cancel/results branches, source copy, and worker spawn. Retain only routes reached by the current wind adapter and internal framed-activation protocol. A `/v1` prefix alone is not proof of legacy identity; each remaining wind event/artifact route must have a live caller and test. |
| Web shell | `web/src/App.tsx`, `App.test.tsx`, `main.tsx`, and `styles.css`: render only `EvidenceStudioApp`, remove query-mode parsing/nav/classes and the legacy stylesheet import, and delete `.mode-switch` CSS while retaining the current `.evidence-mode` namespace. |
| Browser E2E | `web/e2e/evidence-studio.spec.ts`, `web/e2e/start-live-stack.sh`, `web/e2e/bootstrap-live.mjs`, and `web/playwright.config.ts`: become a provider-free Evidence Studio stack. Rename the latter two helpers to evidence-specific names and update callers; leave no compatibility wrapper at the old names. |
| Root docs | `README.md`; describe one Evidence Studio, its wind model, local startup, tests, claims boundary, and workspace behavior only. |
| Documentation set | `docs/README.md`, `architecture.md`, `backend-api.md`, `gate-1-wind-turbine-model-design.md`, `gate-2-project-state-design.md`, `gate-3-evidence-studio-design.md`, `mesa-service.md`, `product-roadmap.md`, `test-plan.md`, `ui-workflow.md`, and `wind-turbine-maintenance-gate-0.md`: rewrite current-tense guidance and future-gate text so the retired product is not documented as available or required. |
| Mesa docs | `mesa_service/README.md`: document the wind-only service and its exact supported routes/tests. |

The final documentation cleanup also deletes this design file after its design
commit has been reviewed. That is necessary for literal zero current-tree docs
fingerprints. The reviewed design remains in normal Git history and is linked
from the PR by commit ID.

### Inspect and preserve as wind semantics

The expanded scan also reaches the following files because the wind model has
real corrective/planned maintenance queues or because Gate 3 verifies an older
wind artifact representation:

- `backend/src/gate3-runtime.ts`;
- `mesa_service/src/mesa_service/gate3_verify_run.py`;
- `mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/defaults/source-field-service-reference.json`;
- `mesa_service/src/mesa_service/model_assets/wind_turbine_maintenance/metric-schema.json`;
- `mesa_service/src/mesa_service/models/wind_turbine_maintenance/framed_model.py`;
- `mesa_service/src/mesa_service/models/wind_turbine_maintenance/model.py`;
- `mesa_service/tests/test_wind_model.py`;
- `web/src/evidence.ts` and `web/src/EvidenceStudioApp.test.tsx`.

These paths are not blanket-exempt. Review confirms each hit is a wind field or
verified wind format; any actual removed symbol found there is deleted. A
machine-readable scan result records the matched line, rule ID, and disposition
so an allowlist cannot hide a future retired capability.

## Runtime, API, configuration, and dependency cutover

### Backend

`BackendOptions` becomes a wind-only composition root: Mesa adapter, workspace
root, optional durable store, and the existing Gate 3 fault injector. Startup
recovers Gate 3 and starts Gate 2; it does not discover a provider, create a
legacy browser session, grant a capability, subscribe to an event stream, or
drive a browser.

`GET /health` reports service health only and contains no `agent`, provider, or
model-readiness object. The following old surfaces return the normal unknown
route response and cannot be re-enabled by environment variables:

- `POST /mcp`;
- `POST /api/sessions`;
- every `/api/sessions/{id}/...` snapshot, event, attachment, chat, parameter,
  run, result, and cancel route.

`POST /api/projects/{projectId}/sessions` is **not** the old root session API.
It remains the durable declared-actor attachment boundary required by Evidence
Studio. Tests and scans distinguish the full route shapes.

### Mesa

The legacy model load/parameter API and generic queue run API are removed:

- `PUT|GET /v1/projects/{projectId}/model`;
- `GET /v1/projects/{projectId}/parameters`;
- queue dispatch through `POST /v1/projects/{projectId}/runs`;
- queue status/cancel/results through the corresponding generic v1 routes.

Wind materialization, v2 dispatch/evidence/receipt/cancel, verified wind events
and artifacts, and framed activation remain only where the backend's wind
adapter has an exact caller. Any redundant alias discovered by call-graph and
integration-test inspection is deleted rather than retained as compatibility.
Unknown removed endpoints fail with 404; they never dispatch to a default
model.

### Browser

`App` returns `EvidenceStudioApp` directly. There is no mode state, nav, CSS
class, alternate component, or lazy bundle. `/`, `/?mode=evidence`, and the
former legacy query all display the same Evidence Studio or canonicalize to
`/`; none can select a retired UI. The production bundle inspection must show
that deleted modules and labels are absent.

### Environment and npm

`.env.example`, `backend/src/index.ts`, shell scripts, and docs retain only
currently consumed wind-stack keys such as `WORKSPACE_ROOT`,
`MESA_SERVICE_URL`, `PORT`, `WEB_PORT`, and `VITE_API_BASE_URL`. Every provider,
skip-provider, MCP URL, browser CDP, legacy session, and provider timeout key is
removed.

The current backend and web package manifests have no direct OpenCode package
dependency. Therefore Gate 4 must not manufacture a dependency change. It
removes obsolete npm scripts/entry points if found, runs a manifest/lockfile
fingerprint scan, and regenerates a lockfile only if a package manifest really
changed. `npm ls`, clean installs, tests, and builds must agree; deleting a
lockfile merely to make a text scan pass is forbidden.

The untracked repository `.env` currently contains four retired key names. At
the irreversible local-cleanup gate, a key-aware rewrite removes only those
exact assignments without reading values into logs. If no unrelated keys
remain, `.env` is deleted; otherwise the unrelated lines and file permissions
are preserved. Home-directory provider configuration and unrelated OpenCode
installations are outside scope.

## Test and E2E replacement

Provider and queue tests are deleted, not skipped. Mixed tests are rewritten so
their fixtures construct the wind-only backend without a no-agent mock.

Required automated checks are:

1. backend unit/API tests for durable project commands, exact actor attachment,
   wind bootstrap/activation/run/evidence, restart recovery, stable error
   projection, and 404 responses for retired route shapes;
2. Mesa tests for wind schema/defaults, deterministic seeds, events, artifacts,
   framed activation, cancellation, corruption detection, and removal of queue
   route registrations from OpenAPI;
3. web unit tests for one shell, schema-driven edit/reset-to-default behavior,
   quantitative issue/endorsement policy, Evidence views, provenance, and no
   mode switch;
4. a production bundle scan and an HTTP/OpenAPI negative-route suite;
5. synthetic retirement-auditor tests for exact schemas and reverse references,
   report/journal/control containment, HEAD/tree/index/auditor/Node/Mach-O/
   dyld-cache drift with
   zero-delete abort, absolute container prohibition, every fault-injection
   point, out-of-protocol mutation at every observable path precheck,
   OS-CSPRNG attempt uniqueness for repeated same-head/target audits, cross-
   attempt rejection, recovery, same-attempt repeated apply, and byte-identical
   idempotent report B without any claim about the final malicious path-based
   TOCTOU interval;
6. cross-process lifecycle-lock tests proving backend and Mesa hold shared locks
   for their whole lifetimes, every write uses the mutation gate, mandatory
   dry-run holds three sorted shared/exclusive gates through atomic A commit and
   writes zero root bytes, apply conflicts with either process/test writer,
   Mesa restart fails closed while apply holds exclusive ownership, three-root
   ordering has no deadlock, crash releases OS locks, and
   symlink/duplicate/wrong-root configurations fail;
7. persistent-gate tests for all-root service-start/write failure in every crash
   window, global-gate-first arming, resume then successful startup, partial
   three-root fence installation repair, mismatched-gate refusal, root-fence
   cleanup while global remains armed, success/abort global-removal
   started/unlink+parent-fsync/completed/terminal boundaries, strict missing-
   gate recovery only after matching durable started, global-last release, and
   zero successful leftovers;
8. exact-TCB tests that invoke the same bound Node realpath and one-file auditor
   command used by apply, preload every auditor path, enumerate actual
   `sharedObjects`, prove every addressable Homebrew/system Mach-O tuple/hash and
   dyld-cache build/arch/header-UUID/component-hash binding, prove Darwin lock
   behavior, and reject closure drift, un-attributable cache objects,
   npm/shebang/loader/preload, environment injection, local/dynamic/third-party
   imports, and changed Node/auditor bytes; test tooling is never imported by
   apply;
9. authenticated-live-PR tests for absent/draft/unapproved/wrong repo, base,
   branch, or head; network/auth failure before mutation with zero deletion and
   no gate or safe terminal-abort cleanup; proof that
   `pre_mutation_aborted` can never reach an operation state or B; crash recovery
   of every abort-removal record; post-B failure with global/root gates retained;
   review binding to the exact attempt/A-digest pair, new-A invalidation; and
   fresh final/pre-merge reads;
10. a real local Playwright run against Mesa + backend + Vite, with no provider
   process, provider env, or provider fixture.

The browser acceptance story uses the default wind case and proves:

- `/` opens Evidence Studio and has no legacy navigation; the former query
  cannot change that;
- a declared human actor attaches through the durable project session route;
- model, experiment, review, run, and Evidence tabs come from the authoritative
  projection;
- changing any exposed input creates a new immutable experiment revision and
  Reset restores the one model-owned default set;
- zero open issues is worded as no recorded open objection; endorsements remain
  quantitative records, not a trusted/untrusted label;
- the 100-turbine, 3-crew, 1,095-day, 365-day warm-up, seed-2 baseline completes
  unless the existing bounded-event acceptance explicitly selects a smaller
  event horizon for runtime, in which case the full baseline remains covered
  by deterministic model/integration tests;
- KPI charts, tables, event view, replay, process/swimlane, traceability, source
  provenance, and downloads regenerate from model/run digests;
- synthetic-input, single-seed, behavioral-reproduction, private-draft,
  unverified, and no-recommendation labels remain visible;
- 1440 x 900 and 390 px layouts work, including 200% zoom checks;
- after backend restart and browser reload, the same project, immutable
  revisions, active model, current run, issues/attestations, and Evidence
  artifact identities are restored without chat history or DOM inference.

## Exact local workspace audit and deletion

Tracked deletion and local cleanup are separate operations:

| Operation | Reviewability | Rollback |
| --- | --- | --- |
| Tracked source/test/docs/config deletion | Normal Git diff and commits | `git revert` only |
| Local `.riff-workspaces` queue artifacts and deprecated `.env` keys | Dry-run manifest plus apply report | Intentionally irreversible; no archive or compatibility copy |

The three explicitly inspected roots are:

- `/Users/gaojihe/apps/riff-demo/.riff-workspaces`;
- `/Users/gaojihe/apps/riff-demo/.riff-workspace`;
- `/Users/gaojihe/apps/riff-demo/mesa_service/.riff-workspace`.

The last two were empty at design time. Roots are preserved even when empty.
No home directory, parent directory, sibling checkout, cache, or wildcard-
discovered root is in scope.

### Workspace lifecycle lock protocol

The existing `.backend-writer.lock` is a backend-specific lock and does not
cover Mesa. It is not evidence that a Mesa process, worker, activation, test,
or restart cannot write. Gate 4 therefore adds one independent
`.workspace-lifecycle.lock` per canonical workspace root. The same protocol
also provisions a permanent `.workspace-mutation.lock` beside it so read-only
audits can freeze writes while still obeying the required shared lifecycle
mode. Both regular files are initialized by the reviewed runtime migration
before dry-run; dry-run never creates or modifies either file or any root.

Backend and Mesa acquire a shared OS advisory lock on that exact file before
their first workspace read/write and hold the open descriptor continuously
from process startup through shutdown. Test helpers and every subprocess that
can write without remaining under a lock-holding parent use the same protocol.
Every actual workspace mutation additionally holds a shared, non-blocking OS
lock on `.workspace-mutation.lock` for its complete transaction. This companion
gate does not replace existing transaction/run locks; it lets dry-run acquire
an exclusive mutation lock and obtain one closed read snapshot without falsely
claiming that a shared lifecycle lock excludes writers.
Mesa's per-run/per-activation locks and the backend's existing writer lock
remain for their narrower concurrency guarantees; neither substitutes for the
lifecycle lock.

The auditor follows this protocol:

- dry-run **must** acquire shared lifecycle locks for all three byte-sorted
  roots, then exclusive mutation locks in the same order, and hold every
  descriptor until report A is atomically renamed, its file is `fsync`ed, and
  the output parent directory is `fsync`ed;
- a lock conflict aborts dry-run without report A; acquired-lock results,
  observed service/worker state, root tuples, and the zero-write assertion are
  recorded in A, so all dispositions come from that one closed snapshot;
- dry-run writes only the ignored output directory. It never writes a
  workspace root, lock file, model record, run record, pointer, or fence;
- apply acquires exclusive lifecycle locks before preflight and retains them
  through full revalidation, all mutations, report B commit, final journal
  commit, fence cleanup, and post-state verification; it also acquires the
  exclusive mutation gates for a uniform cross-process proof;
- the three canonical root paths are byte-sorted and locks are acquired in that
  fixed order and released in reverse order, preventing multi-root deadlock;
- any shared/exclusive holder makes apply fail immediately and without mutation;
  apply never waits for a service to become idle;
- a backend, Mesa service, test writer, worker, or activation started while
  apply owns an exclusive lock also fails closed before workspace access; it
  does not wait, retry in the background, or start against another root;
- kernel descriptor release after process crash releases the advisory lock, but
  does not alter journal recovery requirements;
- each lifecycle/mutation lock file and all three roots are permanent preserved infrastructure and
  can never be a report-A delete entry.

The shared lock implementation is in one reviewed cross-language protocol:
same canonical realpath rules, two fixed lock filenames, shared/exclusive semantics,
non-blocking behavior, and error codes. Startup exposes the canonical
`workspace_root_realpath` and lifecycle-protocol version in local service
health/handshake data so an integration preflight can reject a backend/Mesa
wrong-root split. Symlink aliases, duplicate roots, roots outside the explicit
three-root set, and a service configured against a different realpath all fail
closed.

### Generic auditor

Implementation adds a generic, target-argument-driven workspace retirement
auditor. The source contains no hard-coded retired model identity. Its dry-run
invocation supplies the target identity out of band and emits a JSON report
outside all candidate deletion directories, for example
`/Users/gaojihe/apps/riff-demo/outputs/gate-4-retirement/<audit-id>/report-a.json`.
`intent-progress.json` and `report-b.json` live in that same output directory.
`audit-id` is the head digest plus target-identity digest plus a fresh
`attempt_id`. The one-file auditor generates `attempt_id` from the operating
system CSPRNG through `node:crypto.randomUUID()` (or equivalently sized
`randomBytes` encoded canonically), never from time, PID, counters, input, or a
caller-selected value. Every new audit invocation generates a new attempt and
must atomically `mkdir` its previously absent audit directory after no-follow
validation of the output parent; an existing path is a hard conflict. Even the
same head and target therefore produce a new directory. An aborted or
superseded journal is retained, and no later A may overwrite, reuse, or append
to any earlier attempt directory.
Before auditing, the tool canonicalizes the output directory, rejects a
symlink, and proves it is neither inside nor equal to a workspace root, an
eligible run/revision/pointer, or any ancestor/descendant scheduled for
removal. It separately canonicalizes the fixed `.riff-control` directory,
proves that directory is outside every workspace and candidate tree, and
rejects any containment overlap between it, the audit output, and any delete
entry. No report, journal, control-directory, or gate path can appear in report
A's delete entries.
These files are not committed because they contain machine-local absolute
paths; the PR records their schema versions, SHA-256 digests, counts, and
redacted dispositions.

The report contains at least:

```text
schema_id, schema_version, mode, generated_at, attempt_id, audit_id,
audited_repository_head,
git_tree_oid, tracked_worktree_clean_proof,
auditor{path, file_tuple, sha256, import_policy_digest},
node_runtime{realpath, file_tuple, sha256, version, exec_argv,
loaded_macho_closure[{reported_path, realpath, file_tuple, sha256}],
dyld_cache_identity{platform_build, kernel_release, architecture,
components[{path, header_magic, header_uuid, file_tuple, sha256}]},
closure_digest},
github_pr{host, repository, number, base_branch, head_branch, head_oid,
state, is_draft, review_decision, authenticated_read_digest},
workspace_realpaths, target_identity_digest, scan_root_device_and_inode,
output_directory{canonical_realpath, parent_file_tuple, attempt_id, audit_id},
service_state_proof, lock_conflicts, lifecycle_lock_proof, mutation_lock_proof,
entries[{kind, exact_realpath, relative_path, file_type,
byte_length, sha256, identity_evidence, disposition, reason}],
before_counts, ambiguous_entries, preserved_entries, delete_entries,
reverse_references, report_digest, prior_report_digest, after_counts
```

It records key names but never `.env` values. It records hashes and identities,
not copies of retired source or data. Report A and the canonical
output-directory identity bind the exact `attempt_id` and derived `audit_id`.
Every full journal snapshot, report B, the global gate, and each root fence bind
those same identifiers plus the exact report-A digest. A reviewer approves the
exact pair `(attempt_id, report-A digest)`; approving a head, target, path, or
prior attempt is insufficient.

`audited_repository_head` is the exact commit OID from `HEAD`; `git_tree_oid` is
that commit's tree OID. The one-file auditor spawns no Git or other subprocess.
Using `node:fs`, `node:crypto`, `node:zlib`, `node:https`, and other bound
`node:` built-ins, it resolves `.git`/gitdir and HEAD, parses the index, and compares
all stage-0 index path/mode/blob identities and working-tree bytes to the exact
live commit tree. Unsupported index/object formats, sparse/split index,
submodules, unmerged stages, or unknown extensions fail closed; there is no Git
CLI fallback. `tracked_worktree_clean_proof` binds the resulting index-tree and
worktree-tree digests to `git_tree_oid`. Untracked files do not enter that proof.
The final exact tracked `.gitignore` blob contains `outputs/` and
`.riff-control/`, and the report/journal
paths are absent from the parsed index/tree; generating A, the journal, or B
therefore cannot dirty tracked state or alter the audited tree.

The JavaScript apply surface is exactly one tracked, plain Node ESM `.mjs` file.
The native TCB is the Node executable plus its actually loaded Mach-O closure
and the identified Apple dyld shared-cache trust root; the design does not
pretend the Node binary alone contains libnode, OpenSSL, libuv, ICU, or system
framework code. The auditor imports only `node:` built-ins. It has no npm,
third-party, local-file, generated, native-addon, loader, transpiler, shebang,
or package-runtime dependency; every JavaScript helper is in that one source
file. Apply is invoked directly as:

```text
<A-bound realpath Node executable> <tracked auditor realpath> --mode apply --report-a <exact path>
```

It spawns no subprocess and is never invoked through npm, Git, `flock`, a shell
wrapper, a shebang, `--loader`,
`--import`, or `NODE_OPTIONS`. The auditor rejects `NODE_OPTIONS`, `NODE_PATH`,
unexpected `process.execArgv`, dynamic import, `createRequire`, `require`,
`module.register`, and any static import specifier not beginning with `node:`.
Before capturing its closure, it runs safe deterministic preload/self-tests for
every auditor code path (Git/index parsing, TLS/HTTPS, hashing, report/journal,
lock/fence/gate validation, and file/directory prechecks) without invoking a
delete primitive. It then reads
`process.report.getReport().sharedObjects` in the same process.

A binds the auditor realpath, no-follow device/inode/type/mode/size and SHA-256,
plus the Node executable's resolved realpath, same file tuple, SHA-256, exact
version, and empty approved exec-argument set. Every reported shared object
that resolves to an addressable regular file is no-follow opened, `fstat`ed,
hashed through that descriptor, re-`lstat`ed to the same device/inode, and bound
by reported path, realpath, type/device/inode/size, and SHA-256. This explicitly
includes Homebrew `libnode`, OpenSSL, libuv, ICU, and every other addressable
loaded dylib.

Modern macOS reports many `/usr/lib` and `/System/Library` images that are
resident in the dyld shared cache and have no individually addressable file.
Those entries are accepted only when every such reported path is attributable
to one readable, architecture-matching cache set under the fixed system dyld
cache directory. The auditor reads each main/subcache regular file directly,
parses and binds its header magic and UUID, binds realpath/type/device/inode/
size, and computes a full SHA-256 when readable. It also binds the macOS product
build from the hashed system-version record, Darwin kernel release, and
architecture. An un-attributable cache-resident path, unreadable cache header
or component, missing UUID, architecture mismatch, or component that cannot be
hashed fails closed. The cache identity is an explicit platform trust root, not
a fabricated per-library hash.

Apply repeats the preload and `sharedObjects` enumeration, then requires the
addressable-file set, every tuple/hash, the complete dyld-cache identity, and
the closure digest to equal A before mutation. It captures again after the
operation and rejects any closure addition or drift; post-operation drift
prevents B/`apply_completed` and retains the global/root gates for validated
recovery. The working auditor bytes must also equal the Git blob at A's head.
The current Darwin lock implementation
uses numeric `open(2)` shared/exclusive/non-blocking flags through `node:fs`,
with no `flock` process or addon; cross-process tests must prove the bound native
closure actually provides the required semantics. Unsupported behavior fails
closed rather than selecting a fallback. Test runners and fixture helpers are
not loaded by apply and are not part of its TCB.

Report A is not valid until the auditor performs an authenticated live GitHub
API read through a `node:` built-in HTTPS client. Credentials are read only from
the process environment and are never stored or logged. The live record must
identify the expected repository and base branch, an already-created open,
non-draft PR, the expected head branch, a review decision of `APPROVED`, and a
head OID equal to the clean local `audited_repository_head`. Network failure,
authentication failure, missing PR, draft/unapproved state, or any identity/OID
mismatch prevents A from being committed.

### Eligibility rules

The auditor canonicalizes each supplied root, rejects a symlink root or root
escape, verifies the required lifecycle/mutation locks and recorded service
state, and enumerates directory entries through filesystem APIs. Apply requires
all writers stopped; dry-run instead freezes actual writes with its exclusive
mutation gates. It does not use a shell glob, `find -delete`, or recursive `rm`.

A model revision is eligible only when:

- `manifest.json` parses with the exact known legacy manifest shape;
- its exact model identity, class, and protocol identify the target;
- the manifest digest and the copied model source digest validate under the
  service's actual legacy JSON-digest algorithm;
- mandatory `manifest.json`, `model.py`, `model_schema.json`, and
  `experiment_schema.json` are regular files within the same revision;
- any Python bytecode descendant is an enumerated regular cache file bound to
  that exact copied source; all paths and hashes appear individually in the
  report;
- there is no symlink, device, socket, unexpected file, or unrecognized child.

At design time the 25 proven manifests cover 100 mandatory revision files and
17 observed Python cache files. These counts are evidence, not a deletion
instruction; apply uses the reviewed exact path list.

A run directory is eligible only when:

- `request.json` and `metadata.json` are regular, parseable, exact-shape files;
- request digest equals metadata `request_digest`;
- request `model_revision` resolves inside the same container to an eligible
  revision;
- metadata `model_manifest_digest` equals that manifest's computed digest;
- any explicit metadata model ID equals the target;
- `summary.json` parses and its exact model ID equals the target;
- the exact child set is the known five regular files: `request.json`,
  `metadata.json`, `run.log`, `summary.json`, and `timeseries.csv`;
- all five exact paths, sizes, and hashes are listed, with no symlink or unknown
  child.

The design-time snapshot has 18 such five-file run candidates, all with valid
request and manifest links. Seventeen use an older metadata shape without a
model ID; the digest chain, not omission or directory name, is the only reason
they can qualify.

An active pointer is eligible only when its exact `model_id`, revision, and
manifest digest bind to an eligible revision in the same container. The 15
design-time candidates all satisfy that check. Apply deletes the exact pointer;
it never rewrites it to wind, guesses a replacement, or leaves a fallback.

Before report A is final, the auditor builds reverse references from every
recognized `active.json`, run request/metadata/summary, workspace index,
pending command, command/event index, and durable project record inside each
exact root. A candidate revision or run referenced by any preserved record is
ambiguous and cannot enter `delete_entries`. Unknown JSON schemas are preserved
and reported; they cannot be treated as proof of no reference. The report also
proves that its output directory and journal/report files have no reference or
containment relationship with a candidate.

### Preserve and ambiguous rules

Always preserve:

- workspace roots and `workspace.json`;
- `inputs/`, project roots, quarantine root directories, `.pending`, command
  indexes/events, and unrelated wind or unknown project data;
- the 24 currently observed input files, `.DS_Store` files, the repository
  writer lock, and the quarantined stale-writer-lock record unless a separate
  identity contract proves them in scope; names such as `arrivals.csv` are not
  model identity;
- every `.workspace-lifecycle.lock` and `.workspace-mutation.lock`; an armed
  `.workspace-apply.fence` is never a model delete entry and only the exact
  completed-journal fence-cleanup state machine may remove it;
- the generic `.riff-control` directory; an armed global gate is never a model
  delete entry and only the completed release state machine may remove that
  exact gate file last;
- any file outside an exact eligible revision/run/pointer;
- unrelated `.env` keys and file metadata;
- Git objects and history.

Malformed JSON, digest mismatch, missing binding, cross-container reference,
mixed model identity, unexpected descendant, symlink, concurrent modification,
or unknown schema is `ambiguous`. Ambiguous content is preserved and reported;
the apply pass exits nonzero. Gate 4 cannot be accepted while an ambiguity also
leaves a retired fingerprint. The operator must investigate and produce a new
reviewed dry run; the tool never guesses.

### Persistent recovery fence

The OS locks prevent live concurrency but disappear when apply crashes. Before
the first unlink, apply therefore uses a cross-root global release gate plus the
fixed root-level fences.

The reviewed runtime migration creates the generic control directory
`/Users/gaojihe/apps/riff-demo/.riff-control`, outside every workspace and
candidate tree, rejects symlinks, and adds `.riff-control/` to the tracked
ignore policy. Backend, Mesa, test writers, workers, and activations derive this
fixed path from the canonical repository root; no retirement-specific
environment variable or feature switch can disable or redirect the check. The
fixed global filename is `.workspace-global-apply.gate`.

After acquiring its shared lifecycle lock and before **any** workspace access,
every writer first no-follow checks the global gate, then checks the fence in
its configured root. An active, malformed, inconsistent, symlinked, or
unreadable global gate makes every root fail closed. The gate's canonical JSON
binds only generic schema/version, A/journal/head/auditor/Node-executable/
loaded-closure/dyld-cache/target digests, exact `attempt_id`/`audit_id`, the
three root digests, and `armed`; neither its filename nor content contains a
forbidden literal.

Apply creates and durably `fsync`s the global gate first with no-follow
`O_CREAT|O_EXCL`, then installs the fixed root-level regular file
`.workspace-apply.fence` in each of the three exact roots. Its canonical JSON
contains only schema/version, root digest, report-A digest, journal-intent
digest, audited head/tree, auditor SHA-256, Node-executable SHA-256,
loaded-closure and dyld-cache identity digests, target-identity digest, and an
exact `attempt_id`/`audit_id` plus an `armed` state. It contains neither the
target literal nor any other forbidden fingerprint.

While all exclusive lifecycle/mutation locks are held, each fence is created
with no-follow `O_CREAT|O_EXCL`, mode `0600`; apply writes the complete bytes,
`fsync`s the file, closes it, and `fsync`s the root directory. Existing,
symlinked, non-regular, malformed, mismatched, or multiply linked fence paths
abort. Roots are processed in canonical byte order. No model/run/config
deletion may begin until the global gate plus all three fence bytes and their
parent-directory entries are durable and re-read byte-identical.

An armed root fence, malformed/inconsistent fence, unexpected file type, or
fence it cannot verify also makes startup and writes fail closed. A multi-root
coordinator checks all roots. These checks occur even when the OS lock was
acquired successfully. An apply crash releases OS locks but leaves the global
gate and installed fences, so no root can restart into a partially deleted
workspace—even during partial fence installation or removal.

Resume first reacquires all exclusive lifecycle/mutation locks, then validates
each present fence against A, the journal intent, HEAD/tree, auditor/Node bytes,
loaded closure, dyld-cache identity, target digest, root identity, and exact
global gate. Partial installation implies no deletion was
permitted. After complete revalidation and live-PR admission, recovery may
install the missing matching fences, or—only if the journal proves no unlink
started—durably mark the intent aborted and remove matching installed fences.
An inconsistent fence is never guessed away.

Successful apply may remove root fences only after report B and the journal's
`apply_completed` state are both atomically committed and `fsync`ed. It
revalidates each exact fence tuple/hash, unlinks in reverse root order, and
`fsync`s every root while the global gate stays armed. After committing
`fences_cleared`, it proves all three root fences absent and the A/B/completed-
journal chain and exact attempt binding valid. Before unlinking the global gate,
it commits and output-parent-`fsync`s a full
`release_global_gate_removal_started` journal snapshot. It then revalidates the
gate tuple/hash, unlinks it **last**, `fsync`s the control directory, commits and
output-parent-`fsync`s a full `release_global_gate_removal_completed` snapshot,
and only then commits terminal `release_gate_cleared`. If a crash interrupts
clearing, recovery follows those durable states without guessing. The final
successful global-gate unlink is the admission-release linearization point:
every crash before it is blocked by that gate or a root fence; after it, all
root fences are durably absent and the completed A/B chain was already verified,
so the system is fully released even if the completed or terminal snapshot
still needs to be recorded. Lifecycle/mutation lock files and the control
directory remain. Successful Gate 4 has zero `.workspace-apply.fence` and zero
`.workspace-global-apply.gate` leftovers.

### Apply order and race closure

Local cleanup occurs after code review and green automated tests, but before PR
acceptance and merge:

1. stop backend, Mesa, Vite, test workers, and any writer for the exact roots;
2. produce dry-run report A and review every delete/keep/ambiguous disposition;
3. require zero ambiguities and explicit reviewer approval of the exact
   `(attempt_id, report-A digest)` pair;
4. acquire all three exclusive lifecycle and mutation locks in canonical byte
   order, record each lock path/device/inode/ownership token, and fail
   immediately if any backend, Mesa, test, worker, activation, dry-run, or other
   holder is active;
5. while holding those locks, re-read report A
   and recompute its digest; require its CSPRNG `attempt_id`, derived `audit_id`,
   and canonical output-directory identity to match every attempt-bound
   artifact; require current `HEAD` and its tree to equal
   `audited_repository_head` and `git_tree_oid`, rerun the tracked index/worktree
   clean proof, and byte-verify the single-file auditor, lifecycle/mutation lock
   files, Node executable identity, preloaded `sharedObjects` addressable-file
   closure, and complete dyld-cache platform identity against A. Any Git,
   auditor, executable, Mach-O closure, or platform trust-root drift is a
   zero-deletion abort and requires a newly generated and reviewed report A;
6. perform an authenticated live GitHub read and require repository, base/head
   branch, open non-draft approved PR, and head OID to match A and current clean
   `HEAD`. This occurs before journal intent or fence creation; network or
   identity failure is a zero-deletion/no-fence abort;
7. then revalidate every root and every report entry by no-follow `lstat`:
   exact device, inode, type, mode, size, and SHA-256; in that same closed pass,
   parse the exact schemas again and
   re-prove manifest/source digest, request/metadata/summary identity and
   digest, active pointer, same-container joins, reverse-reference closure,
   directory membership, and output-directory exclusion. Any drift causes a
   zero-deletion abort; validation does not partially apply;
8. atomically create and durably commit the apply-intent journal bound to the
   exact attempt and report A's digest, install and verify the attempt-bound
   persistent global gate, then install and verify all three attempt-bound root
   fences;
9. immediately before the first unlink, repeat the authenticated live PR read.
   Failure or drift writes durable terminal `pre_mutation_aborted`; that journal
   can never enter mutation. Abort cleanup removes only exact matching root
   fences in reverse order with per-fence started/completed records and root
   `fsync`, then commits `abort_fences_cleared`. It commits and
   output-parent-`fsync`s a full `abort_global_gate_removal_started` snapshot,
   revalidates and removes the global gate last, `fsync`s the control directory,
   commits and output-parent-`fsync`s a full
   `abort_global_gate_removal_completed` snapshot, and only then commits
   terminal `abort_release_gate_cleared`. It exits with zero deletion;
   if safe cleanup cannot be proved, gates remain and recovery may only finish
   abort cleanup rather than permitting service startup or mutation;
10. perform only the exact journaled model/config operations; key-rewrite the
    local `.env` as its own journaled exact-key operation;
11. while still holding all exclusive locks and armed fences, run the
    filesystem post-state scan and atomically commit report B;
12. after B, repeat the authenticated live PR verification. If it succeeds,
    durably commit journal `apply_completed`, safely clear and `fsync` all root
    fences while the global gate stays armed, commit `fences_cleared`, verify
    all three absent and the chain complete, then persist
    `release_global_gate_removal_started`, clear/fsync the global gate last,
    persist `release_global_gate_removal_completed`, and commit terminal
    `release_gate_cleared` before releasing locks. A network/
    identity failure here performs no further deletion, retains the global gate
    and remaining fences, and blocks service startup pending recovery;
13. prove the local and live PR head still equal A's audited head, then restart
    the wind stack and run the browser/restart suite.

Exclusive lifecycle ownership makes the revalidated snapshot closed against
all repository backend, Mesa, test, worker, and activation writers because each
is required to obey the lifecycle/mutation protocol and persistent gates. The
local cleanup guarantee does not cover a malicious, privileged, or unrelated
process that mutates filesystem entries outside that protocol.

Node has no `unlinkat` API, so the implementation makes no descriptor-relative
or impossible atomic-delete claim. Immediately before each file deletion it:

1. canonicalizes the parent realpath, proves root containment, and opens that
   parent with `O_DIRECTORY|O_NOFOLLOW` for the later directory `fsync`;
2. no-follow `lstat`s the pathname and rejects a symlink or tuple mismatch;
3. opens the regular file with `O_NOFOLLOW`, `fstat`s it, hashes bytes from that
   descriptor, and requires the A device/inode/type/mode/size/SHA-256;
4. no-follow `lstat`s the pathname again and requires the same device/inode as
   the still-open descriptor;
5. while exclusive lifecycle/mutation locks and global/root gates remain armed,
   immediately calls path-based `fs.unlink`, then `fsync`s the already-open
   parent directory.

For an allowed empty directory it performs the same containment and opens the
parent descriptor, no-follow `lstat`s the target, opens the target directory
with `O_DIRECTORY|O_NOFOLLOW`, `fstat`s and enumerates it as exactly empty,
re-`lstat`s the path to the same device/inode, immediately calls path-based
`fs.rmdir`, and `fsync`s the parent descriptor. Any detected change aborts
before that operation. Tests inject out-of-protocol changes at every observable
precheck boundary and require detection. The design does not claim to close the
final malicious TOCTOU interval between the last `lstat` and Node's path-based
unlink/rmdir instruction; that actor is explicitly outside the local cleanup
threat model.

### Crash-safe intent, progress, and recovery

`intent-progress.json` is a canonical journal with these states:
`intent_committed`, `global_gate_armed`, `fence_installed`,
`all_fences_armed`, `pre_mutation_aborted`,
`abort_fence_removal_started`, `abort_fence_removal_completed`,
`abort_fences_cleared`, `abort_global_gate_removal_started`,
`abort_global_gate_removal_completed`, `abort_release_gate_cleared`,
`operation_started`, `operation_completed`, `report_b_committed`,
`apply_completed`, `fence_removal_started`, `fence_removal_completed`,
`fences_cleared`, `release_global_gate_removal_started`,
`release_global_gate_removal_completed`, and `release_gate_cleared`. The initial
intent contains the exact `attempt_id`/`audit_id`, report A's digest, audited
repository head/tree, auditor and
Node-executable, loaded-closure, and dyld-cache identity digests, root
device/inodes, lifecycle/mutation-lock proof, ordered operation list, and every
pre-delete tuple. It is written to a sibling temporary
file, the file is `fsync`ed, renamed atomically, and the parent output directory
is `fsync`ed before the first unlink.

Every transition creates a complete next journal snapshot with a monotonic
sequence, prior-journal digest, and operation history. It is written to a
sibling temporary file, `fsync`ed, atomically renamed over the journal, and
followed by output-parent `fsync`. Thus each started/completed transition is
atomic and a crash cannot expose a torn final record. For every file unlink and
allowed directory removal, `operation_started` is durably committed first; the
unlink/removal is then performed and its target parent directory `fsync`ed;
only then is `operation_completed` durably committed. Report B is likewise
written to a sibling temporary file, `fsync`ed, atomically renamed, and followed
by parent-directory `fsync`; only then may the journal atomically record
`report_b_committed`. A successful post-B live-PR check permits
`apply_completed`; only subsequent exact root-fence removal, durable
`fences_cleared`, durable `release_global_gate_removal_started`, last
global-gate removal plus control-directory `fsync`, durable
`release_global_gate_removal_completed`, and terminal `release_gate_cleared`
permit release of lifecycle ownership. The abort branch uses its separately
named started/completed/terminal states and can never transition into these
success states. The
committed journal and A/B reports remain outside the candidate tree through PR
acceptance; cleanup of those audit files is a separate manual decision, never
part of the model-artifact apply.

Recovery or repeated apply accepts exactly five cases, all within the one exact
A-bound `attempt_id`/`audit_id`. A report, journal, B, gate, fence, or output
directory from another attempt is a conflict, never resume input; repeated
apply may resume only the attempt named by its reviewed report A.

1. report B and `release_gate_cleared` both match report A: rerun post-state,
   live-PR, verify the success started/completed/terminal chain and
   zero-global/root-gate state, and return `already_applied` without mutation;
2. report B and `apply_completed` exist while the global gate and zero or more
   matching root fences remain or success release is incomplete: reacquire
   exclusive locks, verify the chain, and finish only root-fence/global-gate
   cleanup. Once `fences_cleared` is durable, a present gate with no started
   state first requires durable `release_global_gate_removal_started`; a present
   gate with matching started is revalidated and safely unlinked; a missing gate
   is accepted only when matching started is already durable, after which
   any missing completed and terminal snapshots are committed. A missing gate
   without matching started is corruption and fails closed;
3. `pre_mutation_aborted` exists without B: it is permanently mutation-
   ineligible. Reacquire exclusive locks, validate the attempt-bound chain and
   every present global gate or partial matching root fence, persist every
   abort-removal started/completed transition, and commit
   `abort_fences_cleared`. A present global gate with no
   abort started state first requires durable
   `abort_global_gate_removal_started`; a present matching gate with matching
   started is revalidated and safely unlinked; a missing gate is accepted only
   when matching abort started is already durable, after which
   any missing `abort_global_gate_removal_completed` and terminal
   `abort_release_gate_cleared` snapshots are committed. A missing gate without
   matching abort started is corruption and fails closed. This branch never
   creates B or enters any operation/success state; a terminal rerun returns
   `already_aborted`;
4. an intent/applying journal exists without B and without
   `pre_mutation_aborted`: reacquire the same
   exclusive locks, verify every absent target is an already-deleted journaled
   operation and every present target still has the exact report-A
   device/inode/type/mode/size/hash and schema/join identity, validate/repair the
   exact matching global/root gate set, repeat live admission, then continue at
   the first incomplete operation;
5. no journal exists in this A-created attempt directory: execute the full
   closed pre-unlink validation and create intent for that same attempt.

An unjournaled replacement, an unexpected extra/missing entry, a present target
with any tuple/hash/schema difference, a conflicting A/B digest, or a changed
root/output path aborts recovery without further deletion. Absence is accepted
only for an operation in the bound ordered intent, covering a crash after
unlink but before its completed record. Replaying a completed operation is a
no-op; repeated apply of the same attempt is idempotent. A new audit of the same
head/target has a new CSPRNG attempt and cannot reuse this idempotency path.

Fault-injection tests crash before/after global-gate creation/fsync; after intent
fsync; before/after each individual fence create/root fsync; after a partial
fence set; immediately before/after a path unlink; before/after its progress
fsync; before/after each allowed directory removal; before/after report-B
rename/fsync; after B but before `apply_completed`; before/after every root-fence
unlink/root fsync; and, on the success branch, before/after the full
`release_global_gate_removal_started` temporary write, file `fsync`, atomic
rename, and output-parent `fsync`; before/after global-gate unlink and control-
directory `fsync`; and before/after the corresponding temporary write, file
`fsync`, rename, and output-parent `fsync` for full
`release_global_gate_removal_completed` and terminal `release_gate_cleared`.
Separate abort injections cover every abort-fence started/completed,
`abort_fences_cleared`, and every boundary before/after the full
`abort_global_gate_removal_started` temporary write, file `fsync`, atomic
rename, and output-parent `fsync`; before/after global-gate unlink and control-
directory `fsync`; and before/after the corresponding temporary write, file
`fsync`, rename, and output-parent `fsync` for full
`abort_global_gate_removal_completed` and terminal
`abort_release_gate_cleared`. Tests prove present-gate+started resumes unlink,
missing-gate+started completes the journal, missing-gate-without-started fails
closed, and cross-attempt artifacts are rejected on both branches. Each restart
must either complete the same attempt to byte-identical B and zero gates, finish
a no-B terminal abort with zero gates, or stop without touching a mismatched
target.

### Absolute container prohibition

Report A may schedule only:

- exact eligible files inside one proven run directory and that exact empty run
  directory;
- exact eligible files inside one proven model revision, its exact enumerated
  empty `__pycache__` directory when present, and that exact empty revision
  directory;
- exact eligible `model/active.json` pointers;
- explicitly listed internal parents named exactly `runs`, `model/revisions`,
  or `model`, and only when report A proves they become empty solely through
  its eligible child operations.

It is categorically forbidden to schedule or remove a project container, an
`orphan-*` quarantine container, the quarantine directory, any workspace root,
the repository root, or any ancestor of those roots—even if empty after apply.
No `project`, `quarantine container`, or `root` deletion operation exists in the
tool schema. Empty internal parents are individual report-A entries with exact
device/inode and expected child operations; they are never discovered by a
post-delete recursive prune.

### Repository and PR-head binding

Report B repeats `audited_repository_head`, `git_tree_oid`, the auditor and
Node-executable digests, the loaded-Mach-O closure digest, complete dyld-cache
identity digest, exact `attempt_id`/`audit_id`, report A's digest, and the pre-B
journal-state digest. It also contains the post-state scan and authenticated
live-PR-read digests. The later completed journal contains B's digest, avoiding
a circular digest and yielding one verified attempt → A → intent/progress state
→ B → completed journal chain.

The irreversible cleanup is valid only for the exact reviewed PR head recorded
by A and the exact reviewer-approved `(attempt_id, report-A digest)` pair. At
the final PR acceptance and again immediately before merge, verify:

- local `HEAD` and tree equal A's audited head/tree;
- a fresh authenticated live read shows the same repository/base/head branches,
  open non-draft approved PR, and head OID equal to
  `audited_repository_head`; this read occurs after B, at final acceptance, and
  once more immediately before the merge mutation;
- tracked index/worktree cleanliness still passes;
- the one-file auditor bytes, Node executable tuple/hash/version, actual loaded
  addressable-Mach-O tuples/hashes, dyld-cache platform identity, and lockfiles
  still equal A;
- B, A, journal, lifecycle/mutation-lock proof, post-scan digest, attempt/output
  identity, zero-root-fence proof, and zero-global-gate proof form the exact
  chain above.

Any new commit, amended/rebased head, force-push, tracked edit, index change,
auditor/Node/loaded-closure/dyld-cache change, or PR-head mismatch invalidates local-cleanup
acceptance. Generate a new report A at the new head, obtain new review, and run
apply again in its fresh CSPRNG attempt directory. If prior cleanup left no
eligible candidates, the new apply still
acquires exclusive lifecycle/mutation locks, runs complete post-state verification, and
atomically emits a new zero-deletion B/journal chain bound to the new A. No
"already clean" shortcut may reuse evidence from an older PR head.

If a post-B check detects head drift, the matching global gate and root fences
remain active and the chain enters recovery. A new-head dry-run may proceed
only after validating the old A/journal/B/gate/fence chain; the global gate
continues to block every service. The reviewed new apply then rotates only that
exact matching gate/fence set while holding exclusive locks and produces the
required zero-candidate or nonzero-candidate new chain.
Authenticated network failure before mutation is always zero-deletion. Network
failure after mutation never authorizes acceptance or fence removal; it leaves
the system fail-closed until the authenticated check succeeds.

There is no archive, backup bundle, compatibility branch, or restore script for
local queue artifacts. That is why the review/freeze gate precedes deletion.

## Negative scans and fail-closed absence

The final acceptance job constructs its forbidden literals in the job command
or generated temporary input, not in a committed scanner, so the scanner does
not become the sole remaining fingerprint. It scans:

- `git ls-files` content and pathnames;
- source maps and production bundles;
- `.env.example`, package manifests, npm lockfiles, shell scripts, test
  discovery, docs indexes, and generated OpenAPI;
- the three exact workspace roots and the key names of repository `.env`;
- live route behavior and visible DOM/accessibility tree.

It requires zero exact old model/class/module/parameter/output identities, zero
provider/config/adapter names, zero legacy UI/session/MCP names, and absence of
every outright-delete path. Wind maintenance queue fields are accepted only by
the reviewed rule IDs described above. The retirement design itself is gone
from the final tree before this scan.

Runtime fail-closed checks prove:

- old endpoints are 404 and cannot select a default model;
- former query modes show only Evidence Studio;
- startup does not read deprecated keys or contact a provider;
- provider processes/credentials are unnecessary for all tests;
- absence of a durable wind project yields the bounded existing
  not-found/selection-required state, never a queue fallback;
- no queue artifact remains in an active pointer, revision manifest, request,
  metadata, or reportable descendant in the exact roots;
- all three lifecycle/mutation lock-file pairs remain regular and unlocked after
  apply, the fixed `.riff-control` directory remains regular and outside every
  workspace/candidate tree, and the global gate plus all three
  `.workspace-apply.fence` paths are absent before normal service restart.

## Documentation and claims cutover

README and docs describe the released state, not the migration story. They must
not claim a live assistant, alternate queue demo, provider setup, or future
retirement. The Evidence Studio authority and claim boundary remain explicit:
safe private-draft execution is allowed, human endorsements and issues are
quantitative records, no issue means no recorded objection, and neither UI nor
Agent prose upgrades evidence to scientifically validated advice.

The PR and issue provide the historical rationale. Current product docs link
only to current wind architecture, APIs, test commands, model contract, and
Evidence Studio workflow.

## Exact implementation commits and review gates

The implementation uses these commits in order; each must be independently
reviewable and tests relevant to it must pass:

1. `docs(gate4): define hard retirement contract` — commit this design only.
2. `feat(runtime): add cross-process workspace lifecycle lock` — make backend,
   Mesa, tests, and writers hold the shared per-root lifecycle/mutation protocol,
   derive and check the fixed global gate before the root fence and before any
   workspace access, preserve the generic control directory, and add
   fail-closed multi-process tests.
3. `chore(gate4): add manifest-bound workspace retirement audit` — add the
   generic dry-run/apply tool and its synthetic safety tests, with no hard-coded
   target identity.
4. `refactor(web): make Evidence Studio the only product surface` — delete the
   legacy UI, remove mode switching, and rename/rebuild the E2E stack.
5. `refactor(backend): remove provider and legacy session control plane` —
   delete OpenCode/MCP/session/browser-driving code and prune the router/adapter.
6. `refactor(mesa): remove queue runtime and legacy model API` — delete the
   queue bundle/worker/contracts/routes and their tests while retaining wind.
7. `test(gate4): prove retired capability absence and wind persistence` —
   replace mixed/provider acceptance with negative, wind regression, browser,
   responsive, and restart tests.
8. `docs(gate4): complete wind-only product cutover` — rewrite all current docs,
   delete the bridge document, and delete this reviewed working design from the
   final tree.

After commit 8, run all suites from clean installs, push the exact branch, open
the PR, move it out of draft, obtain approval, and only then generate report A.
The PR therefore exists before any fence or local mutation. After A review,
perform the separately reviewed irreversible local apply. Local artifact
deletion is never smuggled into a Git commit, and no later PR commit is allowed
without invalidating A as described above.

The PR title is `Gate 4: retire queue and legacy provider path`. Its body:

- states that the user's later hard-retirement decision supersedes the
  provider-run wording in issue #6;
- maps every exit criterion to tests, browser evidence, scan output, and the
  redacted report A/B digests;
- uses `Closes #6`, not merely `Refs #6`;
- contains no credentials or machine-local artifact paths.

Merge is allowed only after approval, green required checks, zero scan hits,
zero workspace ambiguity, applied local cleanup, and successful wind restart
acceptance. After merge, verify the remote PR is merged and issue #6 is actually
closed. No force-push, history rewrite, `filter-repo`, or source-history purge is
part of Gate 4.

## Principal risks

1. **False deletion from name inference.** Older run metadata omits model ID.
   The four-link digest proof and exact same-container rule prevent guessing.
2. **False positive from wind maintenance queues.** Broad text deletion would
   corrupt valid KPIs/replay. Rule-level scan dispositions preserve only proven
   wind semantics.
3. **Mixed backend/Mesa files.** Deleting whole routers or adapters would remove
   Gate 2/Gate 3 behavior. Reachability plus wind integration tests bound each
   prune.
4. **A hidden compatibility seam.** Environment switches, unknown query modes,
   old routes, source maps, docs, or skipped tests could retain the product.
   Multi-layer negative scans and live 404/UI checks close these seams.
5. **Workspace race or irreversible mistake.** The frozen report digest,
   exclusive lifecycle ownership, full pre-unlink hash/schema/join revalidation,
   per-operation identity check, ambiguity refusal, and report B are mandatory
   because local artifacts have no rollback.
6. **Acceptance drift from the old issue text.** The PR explicitly records the
   superseding decision and replaces provider acceptance with absence plus the
   complete wind Evidence Studio story.
7. **Crash after an irreversible unlink.** A durably fsynced A-bound intent, a
   global gate armed before all three persistent recovery fences, per-operation
   progress, constrained recovery, idempotent reapply, and fault injection
   prevent a restart or service from guessing what happened.
8. **Container over-deletion.** Project and quarantine containers may hold
   ambiguous inputs or unrelated records. Their deletion is absent from the
   tool schema; only exact A-listed internal empty directories may be removed.
9. **False exclusivity from a backend-only lock.** Mesa or a restarted worker
   could otherwise mutate during apply. The separate shared/exclusive lifecycle
   and mutation-gate protocol, non-blocking startup, fixed root order, and
   cross-process tests are the cleanup barrier; `.backend-writer.lock` is not
   used as that proof.
10. **Code or auditor drift after irreversible cleanup.** A later PR commit can
    invalidate what A audited. Exact HEAD/tree/auditor binding and mandatory
    new zero- or nonzero-deletion A/journal/B evidence prevent reuse across
    heads.
11. **Crash releases ephemeral locks.** Without durable cross-root admission,
    Mesa could restart through a root whose fence had not yet been installed or
    had already been removed. Global-gate-first arming, all-root fencing before
    mutation, root-fence clearing while global admission stays closed, and
    global-last release preserve the recovery boundary in every crash window.
12. **Hidden auditor dependency changes behavior.** npm, local imports, loaders,
    wrappers, a replaced Node executable, changed Homebrew dylib, or changed
    platform cache could evade A. The one-file built-in-only JavaScript surface,
    preloaded actual `sharedObjects` closure, per-file tuple/hash binding, and
    explicit dyld-cache platform identity reject them.
13. **PR changes or the network fails at admission.** Pre-mutation authenticated
    reads fail with zero deletion; once intent exists, the terminal
    `pre_mutation_aborted` branch can only journal root-fence cleanup under the
    global gate and use its durable abort global-removal started/completed/
    terminal sequence, never mutate or produce B. Post-B failure retains the
    global/root gates and blocks acceptance until recovery.
14. **Dry-run observes a moving workspace.** Shared lifecycle locks alone do not
    freeze service writes. The mandatory exclusive mutation gates, all-root
    acquisition order, and hold-through-A-fsync rule create the audited closed
    snapshot without writing roots.
15. **Path replacement outside the lifecycle protocol.** Node exposes only
    path-based unlink/rmdir, so the design cannot promise descriptor-relative
    deletion against a malicious last-instruction race. Parent containment,
    no-follow opens, descriptor hashing, same-inode second `lstat`, and tests at
    every observable precheck detect ordinary external drift; malicious,
    privileged, and unrelated out-of-protocol mutation is explicitly outside
    the cleanup threat model.
16. **Evidence from two attempts is mixed.** Head and target alone are not a
    unique execution identity, so a same-head rerun could otherwise overwrite
    an aborted journal or borrow its approval. An OS-CSPRNG `attempt_id`, atomic
    new-directory creation, pervasive attempt/A-digest binding, exact review
    pair, and cross-attempt rejection make every audit and resume disjoint.
