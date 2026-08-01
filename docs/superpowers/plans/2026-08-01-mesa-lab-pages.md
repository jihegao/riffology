# Mesa Lab Pages (Live Replay + Monte Carlo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single local FastAPI service plus two self-contained HTML pages — a live step-by-step replay page and a Monte Carlo experiment page — for the aircraft-support Mesa model, under `outputs/simulation-replay/`.

**Architecture:** One FastAPI app (`mesaLab-server.py`) running under the worktree `mesa_service` uv environment imports `AircraftSupportModel` and exposes `/api/live/*` (in-memory model sessions, step-by-step) and `/api/mc/*` (background ThreadPoolExecutor Monte Carlo jobs). Two self-contained HTML pages (`mesaLab-live.html`, `mesaLab-montecarlo.html`) call the service via fetch and are also served at `/live` and `/montecarlo`. CORS is open so `file://` usage works.

**Tech Stack:** Python 3, FastAPI 0.139, uvicorn, Mesa 3.5.1, httpx + pytest (testing), vanilla JS + canvas (front-end, no external libraries).

**Spec:** `docs/superpowers/specs/2026-08-01-mesa-lab-pages-design.md`

---

## File structure

| Path | Responsibility |
| --- | --- |
| `outputs/simulation-replay/mesaLab-server.py` | FastAPI app: live session API, Monte Carlo job API, static hosting of the two HTML pages. |
| `outputs/simulation-replay/mesaLab-live.html` | Live replay page (step + auto-play). |
| `outputs/simulation-replay/mesaLab-montecarlo.html` | Monte Carlo page (variable sweep + random seeds). |
| `outputs/simulation-replay/test_mesa_lab.py` | Service-level pytest (worktree-local, not committed). |

No existing files change. All four files are under the git-ignored `outputs/` tree.

---

## Locked design decisions

### Shared constants and model import

- Model import path: `from mesa_service.models.aircraft_support.model import AircraftSupportModel` (run under the `mesa_service` uv project so `src` is on the path).
- Baseline parameters (matching the aircraft model's 25 required keys) for live defaults and Monte Carlo baselines:

```python
BASELINE_PARAMETERS = {
    "aircraft_count": 6,
    "team_count": 2,
    "hangar_count": 2,
    "missions_per_day": 2,
    "mission_flying_hours": 4,
    "failure_rate_per_flying_hour": 0.0004,
    "scheduled_maintenance_interval_days": 45,
    "repair_low_hours": 4,
    "repair_mode_hours": 8,
    "repair_high_hours": 18,
    "scheduled_low_hours": 6,
    "scheduled_mode_hours": 10,
    "scheduled_high_hours": 16,
    "part_initial_stock": 5,
    "part_reorder_point": 2,
    "part_order_quantity": 10,
    "part_lead_time_days": 3,
    "part_unit_cost": 5000,
    "part_holding_cost_per_day": 2,
    "team_cost_per_day": 1000,
    "repair_cost": 2000,
    "scheduled_maintenance_cost": 1200,
    "aog_penalty_per_day": 1500,
    "daily_revenue_per_operating_aircraft": 600,
    "minimum_availability_fraction": 0.9,
}
```

### KPI extraction from snapshot

Every live/MC response derives KPIs from the model `snapshot()` dict. The full snapshot key set is the 62-key metric schema. The surface KPIs used by the pages:

```text
availability_fraction, availability_numerator, availability_denominator,
mission_completion_fraction, flight_count, mission_required,
failure_count, repair_count, maintenance_count,
part_stock, part_orders_in_transit, parts_consumed, part_orders_placed,
corrective_queue_length, scheduled_queue_length,
grounded_for_repair_count, grounded_for_maintenance_count, grounded_for_part_count,
in_flight_count, operating_count,
team_cost, work_cost, part_procurement_cost, aog_penalty_cost, part_holding_cost, total_cost,
operating_revenue, measurement_window_observed
```

### Live session

- `LiveSession` holds the model + the full event list seen so far.
- `init` constructs the model with an `event_sink` that appends every emitted event to a per-session list. It runs `step()` until the first day boundary? No — `init` returns the day-0 state only (the constructor already processes t=0 and emits a day-0 snapshot). Each `step` advances one natural day.
- `state` returns: `day` (= `int(model.sim_time_days)`), `snapshot`, `aircraft_states` (per aircraft id → state value), `queues` (`{corrective: n, scheduled: n}`), `part_stock`, and the full event list (with the last-N slice computed client-side).
- Session dict is keyed by a short id (e.g. `uuid4().hex[:8]`). Reset deletes it.
- Concurrency: a module-level lock guards the sessions dict only; a single session is touched by one request at a time in normal use.

### Monte Carlo

- `McExperiment` holds `scenarios` (list of parameter dicts), `seeds`, `horizon`, `warmup`, `results` (list of `{scenario_index, seed, kpis, ok, error}`), `done` count, `total`, `failed` count.
- `submit` enqueues a background task that runs each (scenario, seed) sample via a `ThreadPoolExecutor`. Each sample constructs `AircraftSupportModel(parameters=scenario_params, horizon_days=horizon, warmup_days=warmup, seed=seed)` and steps to horizon, then reads `snapshot()`.
- Per-sample failure (exception) → `ok=False`, excluded from aggregation, `failed` incremented.
- `progress` returns `{done, total, failed, per_sample}` where per_sample is a bounded list (last 200 rows).
- `result` aggregates per scenario: for each KPI, mean/median/P95 (nearest-rank) across `ok` samples. Empty samples → None values.
- Sample cap: `MAX_SAMPLES = 5000`. `submit` computes `len(scenarios) * seeds`; if > cap → 409.
- Experiments dict keyed by `experiment_id` (`uuid4().hex[:8]`); results retained for the process lifetime.

### API summary

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/live/init` | `{parameters, horizon_days, warmup_days, seed}` | `{session_id, day, snapshot, kpis}` |
| `POST /api/live/step` | `{session_id}` | `{day, snapshot, kpis, events_today}` |
| `POST /api/live/state` | `{session_id}` | `{day, snapshot, kpis, aircraft_states, queues, part_stock, events}` |
| `POST /api/live/reset` | `{session_id}` | `{ok: true}` |
| `POST /api/mc/submit` | `{scenarios, seeds, horizon, warmup}` | `{experiment_id, total_samples}` |
| `GET /api/mc/progress?experiment_id=` | — | `{done, total, failed, per_sample}` |
| `GET /api/mc/result?experiment_id=` | — | `{groups: [...]}` |
| `GET /live`, `GET /montecarlo` | — | static HTML |

Error codes: invalid params → 422 (reuse `AircraftSupportModel._validate_parameters` semantics via a try/except `(TypeError, ValueError)`); unknown session/experiment → 404; sample cap → 409.

### KPI projection helper

```python
def project_kpis(snapshot: dict) -> dict:
    keys = [
        "availability_fraction", "availability_numerator", "availability_denominator",
        "mission_completion_fraction", "flight_count", "mission_required",
        "failure_count", "repair_count", "maintenance_count",
        "part_stock", "part_orders_in_transit", "parts_consumed", "part_orders_placed",
        "corrective_queue_length", "scheduled_queue_length",
        "grounded_for_repair_count", "grounded_for_maintenance_count", "grounded_for_part_count",
        "in_flight_count", "operating_count",
        "team_cost", "work_cost", "part_procurement_cost", "aog_penalty_cost",
        "part_holding_cost", "total_cost", "operating_revenue",
        "measurement_window_observed",
    ]
    return {k: snapshot.get(k) for k in keys}
```

---

## Tasks

### Task 1: FastAPI service skeleton with live API + validation

**Files:**
- Create: `outputs/simulation-replay/mesaLab-server.py`
- Test: `outputs/simulation-replay/test_mesa_lab.py`

- [ ] **Step 1: Write failing tests** for the live API lifecycle, error handling, and KPI projection. `test_mesa_lab.py` (complete file):

```python
from __future__ import annotations

import importlib.util
import pathlib
import time
import types

import httpx
import pytest

from mesa_service.models.aircraft_support.model import AircraftSupportModel


def _server_path() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent / "mesaLab-server.py"


def _load_server() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("mesaLab_server", _server_path())
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SERVER = _load_server()


def _baseline() -> dict:
    return {
        "aircraft_count": 6, "team_count": 2, "hangar_count": 2,
        "missions_per_day": 2, "mission_flying_hours": 4,
        "failure_rate_per_flying_hour": 0.0004, "scheduled_maintenance_interval_days": 45,
        "repair_low_hours": 4, "repair_mode_hours": 8, "repair_high_hours": 18,
        "scheduled_low_hours": 6, "scheduled_mode_hours": 10, "scheduled_high_hours": 16,
        "part_initial_stock": 5, "part_reorder_point": 2, "part_order_quantity": 10,
        "part_lead_time_days": 3, "part_unit_cost": 5000, "part_holding_cost_per_day": 2,
        "team_cost_per_day": 1000, "repair_cost": 2000, "scheduled_maintenance_cost": 1200,
        "aog_penalty_per_day": 1500, "daily_revenue_per_operating_aircraft": 600,
        "minimum_availability_fraction": 0.9,
    }


@pytest.fixture(scope="module")
def client():
    app = SERVER.create_app()
    with httpx.Client(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


def test_live_init_returns_day_zero_snapshot_and_kpis(client):
    resp = client.post("/api/live/init", json={
        "parameters": _baseline(), "horizon_days": 5, "warmup_days": 0, "seed": 2,
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session_id"]
    assert body["day"] == 0
    assert body["snapshot"]["sim_time_days"] == 0
    assert body["kpis"]["aircraft_count"] == 6


def test_live_step_advances_day_and_returns_todays_events(client):
    init = client.post("/api/live/init", json={
        "parameters": _baseline(), "horizon_days": 3, "warmup_days": 0, "seed": 2,
    }).json()
    sid = init["session_id"]
    step = client.post("/api/live/step", json={"session_id": sid}).json()
    assert step["day"] == 1
    assert step["snapshot"]["sim_time_days"] == 1
    assert isinstance(step["events_today"], list)
    state = client.post("/api/live/state", json={"session_id": sid}).json()
    assert state["day"] == 1
    assert len(state["aircraft_states"]) == 6
    assert set(state["queues"]) == {"corrective", "scheduled"}


def test_live_unknown_session_404(client):
    resp = client.post("/api/live/step", json={"session_id": "nope"})
    assert resp.status_code == 404


def test_live_invalid_parameters_422(client):
    bad = _baseline()
    bad["aircraft_count"] = 0
    resp = client.post("/api/live/init", json={
        "parameters": bad, "horizon_days": 5, "warmup_days": 0, "seed": 2,
    })
    assert resp.status_code == 422


def test_live_reset_destroys_session(client):
    init = client.post("/api/live/init", json={
        "parameters": _baseline(), "horizon_days": 3, "warmup_days": 0, "seed": 2,
    }).json()
    sid = init["session_id"]
    assert client.post("/api/live/reset", json={"session_id": sid}).json()["ok"] is True
    assert client.post("/api/live/step", json={"session_id": sid}).status_code == 404


def test_kpi_projection_matches_model_snapshot(client):
    model = AircraftSupportModel(parameters=_baseline(), horizon_days=2, warmup_days=0, seed=2)
    while model.sim_time_days < model.horizon_days:
        model.step()
    kpis = SERVER.project_kpis(model.snapshot())
    snap = model.snapshot()
    assert kpis["availability_fraction"] == snap["availability_fraction"]
    assert kpis["total_cost"] == snap["total_cost"]
    assert kpis["mission_completion_fraction"] == snap["mission_completion_fraction"]


def test_mc_submit_rejects_sample_cap(client):
    scenarios = [{"aircraft_count": 6}, {"aircraft_count": 7}, {"aircraft_count": 8}]
    resp = client.post("/api/mc/submit", json={
        "scenarios": scenarios, "seeds": 2000, "horizon": 2, "warmup": 0,
    })
    assert resp.status_code == 409


def test_mc_small_experiment_progress_and_result(client):
    scenarios = [
        {"aircraft_count": 4, "failure_rate_per_flying_hour": 0.0004},
        {"aircraft_count": 8, "failure_rate_per_flying_hour": 0.0025},
    ]
    resp = client.post("/api/mc/submit", json={
        "scenarios": scenarios, "seeds": 2, "horizon": 30, "warmup": 3,
    })
    assert resp.status_code == 200, resp.text
    exp_id = resp.json()["experiment_id"]
    for _ in range(200):
        prog = client.get(f"/api/mc/progress?experiment_id={exp_id}").json()
        if prog["done"] == prog["total"]:
            break
        time.sleep(0.05)
    assert prog["done"] == prog["total"] == 4
    result = client.get(f"/api/mc/result?experiment_id={exp_id}").json()
    assert len(result["groups"]) == 2
    g0 = result["groups"][0]
    assert g0["samples"] == 2
    assert 0 <= g0["kpis"]["availability_fraction"]["mean"] <= 1
    assert g0["kpis"]["total_cost"]["mean"] > 0
    assert g0["scenario"]["aircraft_count"] == 4


def test_mc_unknown_experiment_404(client):
    assert client.get("/api/mc/result?experiment_id=nope").status_code == 404


def test_live_page_served(client):
    resp = client.get("/live")
    assert resp.status_code == 200
    assert "实时推演" in resp.text


def test_mc_page_served(client):
    resp = client.get("/montecarlo")
    assert resp.status_code == 200
    assert "蒙特卡洛" in resp.text


def test_html_self_contained():
    for name in ("mesaLab-live.html", "mesaLab-montecarlo.html"):
        text = pathlib.Path(__file__).resolve().parent.joinpath(name).read_text(encoding="utf-8")
        assert "http://" not in text and "https://" not in text
        assert "<iframe" not in text
        assert "src=" not in text
```

Run tests from the `mesa_service` directory with `uv run --project . pytest ../outputs/simulation-replay/test_mesa_lab.py -q` so `mesa_service` is importable and the `../outputs/` relative path resolves.

- [ ] **Step 2: Run** `cd mesa_service && uv run --project . pytest ../outputs/simulation-replay/test_mesa_lab.py -q`. Expected: FAIL (`ModuleNotFoundError: No module named 'mesaLab-server'`).

- [ ] **Step 3: Implement** `mesaLab-server.py` with the live API, KPI projection, validation, and error handling:

```python
"""Mesa Lab — live replay + Monte Carlo service for the aircraft-support model.

Local-only experiment tool. Sessions and experiments live in process memory and
are lost on exit. All outputs are projections, not durable domain state.
"""
from __future__ import annotations

import threading
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from mesa_service.models.aircraft_support.model import AircraftSupportModel

BASELINE_PARAMETERS: dict[str, Any] = {
    "aircraft_count": 6, "team_count": 2, "hangar_count": 2,
    "missions_per_day": 2, "mission_flying_hours": 4,
    "failure_rate_per_flying_hour": 0.0004, "scheduled_maintenance_interval_days": 45,
    "repair_low_hours": 4, "repair_mode_hours": 8, "repair_high_hours": 18,
    "scheduled_low_hours": 6, "scheduled_mode_hours": 10, "scheduled_high_hours": 16,
    "part_initial_stock": 5, "part_reorder_point": 2, "part_order_quantity": 10,
    "part_lead_time_days": 3, "part_unit_cost": 5000, "part_holding_cost_per_day": 2,
    "team_cost_per_day": 1000, "repair_cost": 2000, "scheduled_maintenance_cost": 1200,
    "aog_penalty_per_day": 1500, "daily_revenue_per_operating_aircraft": 600,
    "minimum_availability_fraction": 0.9,
}

KPI_KEYS = [
    "availability_fraction", "availability_numerator", "availability_denominator",
    "mission_completion_fraction", "flight_count", "mission_required",
    "failure_count", "repair_count", "maintenance_count",
    "part_stock", "part_orders_in_transit", "parts_consumed", "part_orders_placed",
    "corrective_queue_length", "scheduled_queue_length",
    "grounded_for_repair_count", "grounded_for_maintenance_count", "grounded_for_part_count",
    "in_flight_count", "operating_count",
    "team_cost", "work_cost", "part_procurement_cost", "aog_penalty_cost",
    "part_holding_cost", "total_cost", "operating_revenue",
    "measurement_window_observed",
]


def project_kpis(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {k: snapshot.get(k) for k in KPI_KEYS}


def build_model(parameters: dict[str, Any], horizon_days: int, warmup_days: int, seed: int, event_sink=None) -> AircraftSupportModel:
    return AircraftSupportModel(
        parameters=parameters,
        horizon_days=horizon_days,
        warmup_days=warmup_days,
        seed=seed,
        event_sink=event_sink,
    )


class LiveInitRequest(BaseModel):
    parameters: dict[str, Any] = BASELINE_PARAMETERS
    horizon_days: int = 30
    warmup_days: int = 3
    seed: int = 42


class LiveSessionRequest(BaseModel):
    session_id: str


class LiveSession:
    def __init__(self) -> None:
        self.model: AircraftSupportModel | None = None
        self.events: list[dict[str, Any]] = []


def _live_sink(session: LiveSession):
    def sink(event: dict[str, Any]) -> None:
        session.events.append(event)
    return sink


def create_app() -> FastAPI:
    app = FastAPI(title="Mesa Lab")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    sessions: dict[str, LiveSession] = {}
    sessions_lock = threading.Lock()

    def _require_session(session_id: str) -> LiveSession:
        with sessions_lock:
            session = sessions.get(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="unknown session")
        return session

    @app.post("/api/live/init")
    def live_init(req: LiveInitRequest) -> dict[str, Any]:
        session = LiveSession()
        try:
            session.model = build_model(req.parameters, req.horizon_days, req.warmup_days, req.seed, _live_sink(session))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        session_id = uuid.uuid4().hex[:8]
        with sessions_lock:
            sessions[session_id] = session
        return {
            "session_id": session_id,
            "day": int(session.model.sim_time_days),
            "snapshot": session.model.snapshot(),
            "kpis": project_kpis(session.model.snapshot()),
        }

    @app.post("/api/live/step")
    def live_step(req: LiveSessionRequest) -> dict[str, Any]:
        session = _require_session(req.session_id)
        before = len(session.events)
        session.model.step()
        today = session.events[before:]
        return {
            "day": int(session.model.sim_time_days),
            "snapshot": session.model.snapshot(),
            "kpis": project_kpis(session.model.snapshot()),
            "events_today": today,
        }

    @app.post("/api/live/state")
    def live_state(req: LiveSessionRequest) -> dict[str, Any]:
        session = _require_session(req.session_id)
        snap = session.model.snapshot()
        aircraft_states = {aid: a.state.value for aid, a in session.model.aircraft.items()}
        return {
            "day": int(session.model.sim_time_days),
            "snapshot": snap,
            "kpis": project_kpis(snap),
            "aircraft_states": aircraft_states,
            "queues": {"corrective": snap["corrective_queue_length"], "scheduled": snap["scheduled_queue_length"]},
            "part_stock": snap["part_stock"],
            "events": session.events,
        }

    @app.post("/api/live/reset")
    def live_reset(req: LiveSessionRequest) -> dict[str, Any]:
        with sessions_lock:
            sessions.pop(req.session_id, None)
        return {"ok": True}

    return app


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(create_app(), host="127.0.0.1", port=8765)
```

(`LiveSession()` starts with `model=None, events=[]`; `build_model` with `_live_sink(session)` appends the constructor-emitted day-0 events to the session list.)

- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** (note: `outputs/` is git-ignored, so this commit only records the test file if you force-add; the convention here is that `outputs/simulation-replay/` is NOT committed — so SKIP the commit, or commit only a note. The plan's execution runs in the worktree where `outputs/` is ignored. Confirm with the controller; by default do NOT commit these files.)

### Task 2: Static hosting of the two pages + MC API

**Files:**
- Modify: `outputs/simulation-replay/mesaLab-server.py`
- Test: `outputs/simulation-replay/test_mesa_lab.py`

- [ ] **Step 1: Write failing tests** for MC submit/progress/result and static hosting:

```python
def test_mc_submit_rejects_sample_cap(client):
    scenarios = [{"aircraft_count": 6}, {"aircraft_count": 7}, {"aircraft_count": 8}]
    resp = client.post("/api/mc/submit", json={
        "scenarios": scenarios, "seeds": 2000, "horizon": 2, "warmup": 0,
    })
    assert resp.status_code == 409


def test_mc_small_experiment_progress_and_result(client):
    scenarios = [
        {"aircraft_count": 4, "failure_rate_per_flying_hour": 0.0004},
        {"aircraft_count": 8, "failure_rate_per_flying_hour": 0.0025},
    ]
    resp = client.post("/api/mc/submit", json={
        "scenarios": scenarios, "seeds": 2, "horizon": 30, "warmup": 3,
    })
    assert resp.status_code == 200, resp.text
    exp_id = resp.json()["experiment_id"]
    # poll until done
    for _ in range(100):
        prog = client.get(f"/api/mc/progress?experiment_id={exp_id}").json()
        if prog["done"] == prog["total"]:
            break
        time.sleep(0.05)
    assert prog["done"] == prog["total"] == 4
    result = client.get(f"/api/mc/result?experiment_id={exp_id}").json()
    assert len(result["groups"]) == 2
    g0 = result["groups"][0]
    assert g0["samples"] == 2
    assert 0 <= g0["kpis"]["availability_fraction"]["mean"] <= 1
    assert g0["kpis"]["total_cost"]["mean"] > 0
    # scenario merging: each scenario dict merges over baseline
    assert g0["scenario"]["aircraft_count"] == 4


def test_mc_unknown_experiment_404(client):
    assert client.get("/api/mc/result?experiment_id=nope").status_code == 404


def test_live_page_served(client):
    resp = client.get("/live")
    assert resp.status_code == 200
    assert "mesaLab-live" in resp.text


def test_mc_page_served(client):
    resp = client.get("/montecarlo")
    assert resp.status_code == 200
    assert "mesaLab-montecarlo" in resp.text


def test_html_self_contained():
    import pathlib
    for name in ("mesaLab-live.html", "mesaLab-montecarlo.html"):
        text = pathlib.Path(f"../outputs/simulation-replay/{name}").read_text(encoding="utf-8")
        assert "http://" not in text and "https://" not in text
        assert "<iframe" not in text and "src=" not in text
```

Add `import time` and `import pathlib` to the test file. For `test_html_self_contained`, the pages must exist (Task 3/4 create them) — so write this test in Task 3/4 or make it tolerant of missing files (skip if absent). To keep Task 2 focused, only add the MC + serving tests here; add `test_html_self_contained` in Task 4.

- [ ] **Step 2: Run** `cd mesa_service && uv run --project . pytest ../outputs/simulation-replay/test_mesa_lab.py -q`. Expected: FAIL (endpoints missing).

- [ ] **Step 3: Implement** the MC engine and static hosting in `mesaLab-server.py`:

Add imports: `import math`, `import time`, `from concurrent.futures import ThreadPoolExecutor`, `from pathlib import Path`, `from fastapi.responses import HTMLResponse`, `import os`.

MC models and helpers:

```python
MAX_SAMPLES = 5000
EXPERIMENTS: dict[str, "McExperiment"] = {}
EXPERIMENTS_LOCK = threading.Lock()
EXECUTOR = ThreadPoolExecutor(max_workers=4)


class McSubmitRequest(BaseModel):
    scenarios: list[dict[str, Any]]
    seeds: int
    horizon: int = 30
    warmup: int = 3


class McExperiment:
    def __init__(self, scenarios, seeds, horizon, warmup) -> None:
        self.scenarios = scenarios
        self.seeds = seeds
        self.horizon = horizon
        self.warmup = warmup
        self.total = len(scenarios) * seeds
        self.done = 0
        self.failed = 0
        self.results: list[dict[str, Any]] = []
        self._lock = threading.Lock()


def _run_sample(exp: McExperiment, scenario: dict[str, Any], seed: int, scenario_index: int) -> None:
    try:
        params = {**BASELINE_PARAMETERS, **scenario}
        model = AircraftSupportModel(parameters=params, horizon_days=exp.horizon, warmup_days=exp.warmup, seed=seed)
        while model.sim_time_days < model.horizon_days:
            model.step()
        kpis = project_kpis(model.snapshot())
        with exp._lock:
            exp.results.append({"scenario_index": scenario_index, "seed": seed, "ok": True, "kpis": kpis})
    except Exception:
        with exp._lock:
            exp.results.append({"scenario_index": scenario_index, "seed": seed, "ok": False, "kpis": None})
            exp.failed += 1
    finally:
        with exp._lock:
            exp.done += 1


def _p95(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[math.ceil(0.95 * len(ordered)) - 1]


def _aggregate(samples: list[dict[str, Any]]) -> dict[str, Any]:
    ok_samples = [s for s in samples if s["ok"] and s["kpis"] is not None]
    if not ok_samples:
        return {}
    kpi_names = KPI_KEYS
    out: dict[str, Any] = {}
    for name in kpi_names:
        values = [s["kpis"][name] for s in ok_samples if isinstance(s["kpis"].get(name), (int, float))]
        if not values:
            out[name] = {"mean": None, "p50": None, "p95": None}
            continue
        ordered = sorted(values)
        out[name] = {
            "mean": sum(values) / len(values),
            "p50": ordered[len(ordered) // 2] if len(ordered) % 2 else (ordered[len(ordered) // 2 - 1] + ordered[len(ordered) // 2]) / 2,
            "p95": _p95(values),
        }
    return out
```

Add the MC endpoints and static hosting inside `create_app()`:

```python
    @app.post("/api/mc/submit")
    def mc_submit(req: McSubmitRequest) -> dict[str, Any]:
        total = len(req.scenarios) * req.seeds
        if total > MAX_SAMPLES:
            raise HTTPException(status_code=409, detail=f"sample cap {MAX_SAMPLES} exceeded: {total}")
        if req.seeds < 1 or req.horizon < 1:
            raise HTTPException(status_code=422, detail="seeds and horizon must be positive")
        exp = McExperiment(req.scenarios, req.seeds, req.horizon, req.warmup)
        exp_id = uuid.uuid4().hex[:8]
        with EXPERIMENTS_LOCK:
            EXPERIMENTS[exp_id] = exp
        for si, scenario in enumerate(req.scenarios):
            for seed in range(1, req.seeds + 1):
                EXECUTOR.submit(_run_sample, exp, scenario, seed, si)
        return {"experiment_id": exp_id, "total_samples": total}

    @app.get("/api/mc/progress")
    def mc_progress(experiment_id: str) -> dict[str, Any]:
        with EXPERIMENTS_LOCK:
            exp = EXPERIMENTS.get(experiment_id)
        if exp is None:
            raise HTTPException(status_code=404, detail="unknown experiment")
        with exp._lock:
            per_sample = sorted(exp.results, key=lambda r: r["seed"])[-200:]
            return {"done": exp.done, "total": exp.total, "failed": exp.failed, "per_sample": per_sample}

    @app.get("/api/mc/result")
    def mc_result(experiment_id: str) -> dict[str, Any]:
        with EXPERIMENTS_LOCK:
            exp = EXPERIMENTS.get(experiment_id)
        if exp is None:
            raise HTTPException(status_code=404, detail="unknown experiment")
        groups = []
        for si, scenario in enumerate(exp.scenarios):
            samples = [r for r in exp.results if r["scenario_index"] == si]
            groups.append({
                "scenario": {**BASELINE_PARAMETERS, **scenario},
                "scenario_index": si,
                "samples": len([s for s in samples if s["ok"]]),
                "kpis": _aggregate(samples),
            })
        return {"groups": groups}

    @app.get("/live", response_class=HTMLResponse)
    def live_page() -> str:
        return Path(__file__).with_name("mesaLab-live.html").read_text(encoding="utf-8")

    @app.get("/montecarlo", response_class=HTMLResponse)
    def mc_page() -> str:
        return Path(__file__).with_name("mesaLab-montecarlo.html").read_text(encoding="utf-8")
```

- [ ] **Step 4: Run** the tests. Expected: PASS (MC tests + serving tests).
- [ ] **Step 5: Commit** — `outputs/` is git-ignored; by default do NOT commit these files (confirm with controller).

### Task 3: Live replay page (mesaLab-live.html)

**Files:**
- Create: `outputs/simulation-replay/mesaLab-live.html`

- [ ] **Step 1: Write failing test** — add `test_html_self_contained` to `test_mesa_lab.py` (see Task 2 for the code). Expected: FAIL (file missing).

- [ ] **Step 2: Implement** `mesaLab-live.html`. Complete self-contained HTML with inline CSS + JS (no external references, no iframes). Key behaviors:

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mesa Lab · 实时推演</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f7f8fc;color:#172033}
  header{background:#fff;border-bottom:1px solid #dbe2ef;padding:16px 24px}
  h1{font-size:20px;margin:0}
  .controls{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;padding:16px 24px;background:#fff;border-bottom:1px solid #dbe2ef}
  .field{display:flex;flex-direction:column;gap:4px}
  .field label{font-size:11px;color:#526078}
  .field input{width:110px;padding:5px;border:1px solid #dbe2ef;border-radius:6px}
  .btn{background:#3e73d8;color:#fff;border:none;border-radius:6px;padding:7px 14px;cursor:pointer}
  .btn.secondary{background:#e8edf6;color:#172033}
  main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px 24px}
  .panel{background:#fff;border:1px solid #dbe2ef;border-radius:12px;padding:16px}
  h2{font-size:14px;margin:0 0 10px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
  .kpi{background:#fbfcff;border:1px solid #e5eaf3;border-radius:8px;padding:8px}
  .kpi b{display:block;font-size:18px}
  .kpi span{font-size:11px;color:#526078}
  .fleet{display:flex;flex-direction:column;gap:6px}
  .row{display:flex;align-items:center;gap:8px}
  .row .id{width:110px;font-size:11px;color:#526078;text-align:right}
  .bar{flex:1;height:20px;border-radius:4px;background:#eef2f8}
  .seg{display:inline-block;height:100%;float:left}
  .ev{font:11px ui-monospace,monospace;max-height:220px;overflow:auto;border:1px solid #e5eaf3;border-radius:6px;padding:8px}
  .ev div{padding:2px 0;border-bottom:1px dotted #e5eaf3}
  canvas{width:100%;height:140px}
  .color-operating{background:#2f9e6e}.color-in_flight{background:#3e73d8}
  .color-grounded_for_repair{background:#dd8b00}.color-grounded_for_maintenance{background:#8e44ad}
  .color-grounded_for_part{background:#c0392b}
</style>
</head>
<body>
<header><h1>Mesa Lab · 飞机保障实时推演</h1></header>
<div class="controls">
  <!-- parameter inputs bound to BASELINE defaults -->
</div>
<main>
  <section class="panel">
    <h2>机队状态</h2><div class="fleet" id="fleet"></div>
  </section>
  <section class="panel">
    <h2>当日 KPI</h2><div class="kpis" id="kpis"></div>
    <h2>可用度 / 出动架次率</h2>
    <canvas id="chart"></canvas>
  </section>
</main>
<section class="panel" style="margin:0 24px 16px">
  <h2>实时事件流</h2><div class="ev" id="events"></div>
</section>
<script>
/* Full JS implementation: fetch to /api/live/*, fleet bars rendered as
   segments by state, KPI cards, canvas line chart of availability + sortie
   over days, event stream append with last 60 rows. Auto-play uses
   setInterval at the slider speed; each tick calls /api/live/step.
   Fleet bar: one .row per aircraft; .bar contains one .seg per state with
   width proportional to state day share when multi-state, but for a live
   step view render the current state as a single full-width segment.
   Chart: cumulative daily arrays pushed after each step; draw two polylines. */
</script>
</body>
</html>
```

The page must include the parameter inputs (all 25 baseline keys from the spec's BASELINE_PARAMETERS, prefilled), the four buttons (`init`/`step`/`auto-play`/`reset`), and the auto-play speed slider. Write the full JS (fetch wrapper, state render, chart draw, event append, auto-play loop). The `src=` check in `test_html_self_contained` is satisfied because the page uses inline `<script>` with no `src` attribute and no external URLs.

- [ ] **Step 3: Run** the self-contained test. Expected: PASS.
- [ ] **Step 4: Manual smoke** — start the server, open `/live`, init and step a few days. Confirm fleet bars and events update. (No automated browser test required; the pytest self-contained check plus manual smoke is the acceptance.)
- [ ] **Step 5: Commit** — `outputs/` is git-ignored; by default do NOT commit (confirm with controller).

### Task 4: Monte Carlo page (mesaLab-montecarlo.html)

**Files:**
- Create: `outputs/simulation-replay/mesaLab-montecarlo.html`

- [ ] **Step 1: Add `test_html_self_contained` for the MC page** if not already present (Task 3 adds it covering both files). Expected: FAIL (file missing).

- [ ] **Step 2: Implement** `mesaLab-montecarlo.html`. Self-contained, no external libs. Key behaviors:

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mesa Lab · 蒙特卡洛实验</title>
<style>/* same visual language as live page: controls, cards, canvas */</style>
</head>
<body>
<header><h1>Mesa Lab · 蒙特卡洛实验</h1></header>
<div class="controls">
  <!-- variable groups: resources / reliability / parts; each variable row =
       name, baseline input, sweep checkbox, min, max, step -->
  <!-- execution: horizon, warmup, seeds, submit button, progress bar -->
</div>
<main>
  <section class="panel"><h2>KPI 对比</h2><table id="kpiTable"></table></section>
  <section class="panel"><h2>敏感性曲线</h2>
    <select id="kpiSelect"></select><canvas id="chart"></canvas></section>
</main>
<section class="panel"><h2>逐样本明细</h2><table id="detailTable"></table></section>
<script>
/* Sweep grid builder: for each swept variable produce values from min..max by
   step (inclusive), Cartesian product across swept vars; each scenario = baseline
   merged with one combo; × seeds → total samples shown before submit.
   fetch POST /api/mc/submit; poll GET /api/mc/progress; render progress bar.
   GET /api/mc/result → KPI table (rows = scenario, cols = KPI mean/med/p95),
   sensitivity curve for chosen KPI vs chosen swept variable (each point = group
   mean), detail table of per-sample rows. All drawing in canvas/table; no libs. */
</script>
</body>
</html>
```

The page must include the three variable groups with sweep controls, the execution settings, sample-count preview, submit + progress bar, KPI comparison table, sensitivity curve selector + canvas, and per-sample detail table. Write the full JS for sweep grid generation, sample-count preview, submit/poll, and result rendering.

- [ ] **Step 3: Run** the self-contained test. Expected: PASS.
- [ ] **Step 4: Manual smoke** — open `/montecarlo`, run 3 resource groups × 8 seeds; confirm progress bar and sensitivity curve.
- [ ] **Step 5: Commit** — `outputs/` is git-ignored; by default do NOT commit (confirm with controller).

### Task 5: Integration verification

**Files:**
- Modify: none (verification only)

- [ ] **Step 1: Run** the full service test suite:
```bash
cd mesa_service && uv run --project . pytest ../outputs/simulation-replay/test_mesa_lab.py -q
```
Expected: all PASS.

- [ ] **Step 2: Regression check** — the service imports the aircraft model; ensure the aircraft/wind model suites still pass:
```bash
cd mesa_service && uv run --project . pytest tests/test_aircraft_model.py tests/test_wind_model.py -q
```
Expected: PASS.

- [ ] **Step 3: Start the server** and verify both pages load:
```bash
cd mesa_service && uv run --project . python ../outputs/simulation-replay/mesaLab-server.py --port 8765 &
sleep 2
curl -s http://127.0.0.1:8765/live | head -5
curl -s http://127.0.0.1:8765/montecarlo | head -5
kill %1
```
Expected: both return HTML with the correct titles.

- [ ] **Step 4: Report** final status; do NOT commit (`outputs/` is git-ignored).

---

## Self-review

**Spec coverage:**
- Live page: Task 3 (fleet bars, KPI cards, event stream, charts, step + auto-play).
- Monte Carlo page: Task 4 (variable groups, sweep grid, sample preview, progress, KPI table, sensitivity curve, detail table).
- Server: Task 1 (live API + validation + KPI projection) and Task 2 (MC API + static hosting).
- Error handling: 422 invalid params, 404 unknown session/experiment, 409 sample cap (Tasks 1-2).
- Testing: Tasks 1-4 service tests + Task 5 integration.
- Boundary: files under git-ignored `outputs/`; pages are projections; no product code changes.

**Placeholder scan:** no TBD/TODO; every task has complete code. The `mesaLab-live.html` / `mesaLab-montecarlo.html` implementations in Task 3/4 describe required structure and the full JS scope but note that the complete page body must be written by the implementer (the plan gives the skeleton + required behaviors, which is the appropriate granularity for two substantial HTML files; the controller will review the full pages at spec-review time).

**Type consistency:** API request/response field names are consistent across tasks (`session_id`, `experiment_id`, `day`, `snapshot`, `kpis`, `events_today`, `aircraft_states`, `queues`, `part_stock`, `events`, `groups`, `per_sample`, `scenario`, `samples`). `project_kpis` used in both live and MC paths. `BASELINE_PARAMETERS` shared. `_load_server()` used consistently in tests.
