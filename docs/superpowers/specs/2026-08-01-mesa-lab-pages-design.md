# Mesa Lab: Live Replay + Monte Carlo Experiment Pages — Design

- Status: approved for implementation
- Role: design spec for two interactive aircraft-support experiment pages
- Scope: local-only, non-persistent experiment tooling inside `outputs/simulation-replay/` (git-ignored); no Riff Product UI changes
- Source of truth: aircraft-support model (`mesa_service/src/mesa_service/models/aircraft_support/`), domain brief `docs/domain-brief-aircraft-support.md`
- Last reviewed: 2026-08-01

## Decision question

Give the demo user two interactive experiment surfaces for the aircraft-support Mesa model:
1. a live, step-by-step replay page (with auto-play), and
2. a Monte Carlo experiment page that sweeps parameter combinations across random seeds.

Both are local projections/experiment tools. They do not create persistent model state, do not modify Riff Product UI, and are not authoritative domain evidence.

## Architecture

Single FastAPI service (running under the worktree `mesa_service` uv environment, which already has `fastapi` 0.139 + `uvicorn` + `mesa` 3.5.1) exposing two API families. Two fully self-contained HTML pages call the service over fetch. Service also serves the two pages at `/live` and `/montecarlo`. CORS `allow_origins=["*"]` so the HTML can also be opened from `file://`.

```
outputs/simulation-replay/
  mesaLab-server.py        # FastAPI app (uvicorn), model import from mesa_service
  mesaLab-live.html        # live replay page
  mesaLab-montecarlo.html  # Monte Carlo experiment page
```

Data flow:
- Live: page `POST /api/live/init` → server constructs an `AircraftSupportModel` in an in-memory session; `POST /api/live/step` advances one day and returns that day's incremental events + snapshot; `POST /api/live/state` returns full state; `POST /api/live/reset` destroys the session.
- Monte Carlo: page `POST /api/mc/submit` (scenario list × seed count) → server queues a background `ThreadPoolExecutor` job; `GET /api/mc/progress` returns done/total/per-sample rows; `GET /api/mc/result` returns per-group aggregation (mean/median/P95 across seeds).

All HTML are projections; session state lives only in the server process memory and is lost on exit.

## Component 1 — Live replay page (mesaLab-live.html)

Layout:
- Top control bar: parameter form (aircraft_count, team_count, hangar_count, failure_rate_per_flying_hour, scheduled_maintenance_interval_days, repair/scheduled duration hours, part_initial_stock, part_reorder_point, part_order_quantity, part_lead_time_days, horizon, warmup, seed, auto-play speed slider) + `init / step / auto-play / reset` buttons.
- Fleet status panel: one status bar per aircraft, 5-state coloring (operating / in_flight / grounded_for_repair / grounded_for_maintenance / grounded_for_part).
- Daily KPI cards: availability fraction, mission completion fraction, failure count, repair/maintenance counts, part stock, queue lengths, total cost.
- Live event stream: most-recent-N mechanism events appended (day, type, aircraft, work order, payload).
- Bottom charts: availability and mission-completion trends over days, drawn with canvas (no external libraries).

API:
- `POST /api/live/init` body = parameters → `{session_id, day, snapshot}`
- `POST /api/live/step` body = `{session_id}` → `{day, snapshot, events_today}`
- `POST /api/live/state` body = `{session_id}` → `{day, snapshot, aircraft_states, queues, part_stock, all_events}`
- `POST /api/live/reset` body = `{session_id}` → destroy session

## Component 2 — Monte Carlo page (mesaLab-montecarlo.html)

Layout:
- Variable setup: three groups —
  - resources: `aircraft_count`, `team_count`, `hangar_count`
  - reliability: `failure_rate_per_flying_hour`, `scheduled_maintenance_interval_days`, repair/scheduled duration
  - parts: `part_initial_stock`, `part_reorder_point`, `part_order_quantity`, `part_lead_time_days`, `aog_penalty_per_day`
  - Each variable has baseline + min/max/step + an "in sweep" checkbox. Swept variables form a Cartesian grid across the swept set, then × seed count.
- Execution: horizon, warmup, seeds, worker threads; `submit experiment`; progress bar.
- Results:
  - main KPI comparison table: per group → availability mean/median/P95, mission completion fraction, failure/maintenance counts, total cost (aggregated across seeds).
  - sensitivity curve: chosen KPI vs chosen swept variable (each point = group mean across seeds), drawn with canvas.
  - per-group × per-seed detail table.

API:
- `POST /api/mc/submit` body = `{scenarios: [...], seeds: N, horizon, warmup}` → `{experiment_id}`
- `GET /api/mc/progress?experiment_id=` → `{done, total, per_sample: [...]}`
- `GET /api/mc/result?experiment_id=` → `{groups: [{scenario, samples, mean/p50/p95 per KPI}]}`

Sample-size guard: the page pre-computes and displays total samples (combinations × seeds); the server rejects with 409 above a configured cap (default 5000 samples).

## Component 3 — mesaLab-server.py

- FastAPI app; imports `AircraftSupportModel` from `mesa_service.models.aircraft_support.model`.
- Live: in-memory `{session_id: model}`; one model per session.
- Monte Carlo: background `ThreadPoolExecutor`; each sample constructs its own model (distinct seed) and runs to horizon; results aggregated per group (mean / median / P95, nearest-rank).
- Error handling:
  - invalid parameters → 422 with the model's `_validate_parameters` semantics
  - unknown session/experiment_id → 404
  - per-sample failure (invalid/zero-duration/timeout) → sample marked failed, excluded from aggregation, failed count surfaced
  - sample cap exceeded → 409 with clear message
  - responses carry only numbers/strings; no file paths or process details
- Static hosting of the two HTML at `/live` and `/montecarlo`; CORS open for `file://` usage.
- Startup: `uv run --project mesa_service python outputs/simulation-replay/mesaLab-server.py --port 8765`.

## Error handling & limits

| Condition | Response |
| --- | --- |
| invalid parameters | 422 (model validation message) |
| unknown session / experiment | 404 |
| sample cap (default 5000) exceeded | 409 |
| per-sample run failure | sample failed, excluded from aggregation, failed count shown |

## Testing & validation

Service-level pytest (worktree-local, not committed):
- `test_live_cycle`: init → step to horizon → state validates day advance, readable events, complete snapshot keys.
- `test_mc_small`: 2 groups × 2 seeds small experiment; validates progress and aggregation (means in sane range, sample counts correct).
- `test_errors`: invalid params 422, unknown session 404, sample cap 409.
- `test_html_self_contained`: both HTML have no external CDN/iframe references.

Manual acceptance: start server, open both pages in the browser; live page steps + auto-plays with fleet bars and event stream updating; Monte Carlo page runs 3 resource groups × 8 seeds and shows sensitivity curve + progress.

Boundary: pages/service are projections and local experiment tools. They do not touch Riff Product UI, do not modify product code, and do not create persistent model state.

## Non-goals

- No persistence of runs or results (in-memory only).
- No Riff Product integration or browser frame embedding.
- No multi-user / concurrency guarantees beyond the single local user.
- No calibration, validation, or decision-readiness claims; results are synthetic single/multi-seed projections.
