# Aircraft Support Model Core Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `aircraft-support` Mesa model core layer (model package, model assets, deterministic microcase tests) in `mesa_service`, mirroring the reviewed wind-turbine-maintenance conventions exactly.

**Architecture:** A Mesa model with fractional-day mechanics and daily public stepping. Uses a hand-rolled `heapq` event scheduler with business phases, named per-stream `random.Random` sources derived from the run seed, and a private `ScenarioFixture` draw seam for hand-oracle tests. Entities: Aircraft, MaintenanceTeam, HangarSlot, PartType, WorkOrder, PartOrder. Multi-stage linkage: daily missions → flying hours → failures + scheduled maintenance due → team/hangar/part contention → AOG ground time when a part is missing.

**Tech Stack:** Python 3.10+, Mesa 3 (locked 3.5.1), pytest 8, uv.

**Source of truth:** [`docs/domain-brief-aircraft-support.md`](../../domain-brief-aircraft-support.md). The model mirrors [`mesa_service/src/mesa_service/models/wind_turbine_maintenance/model.py`](../../../mesa_service/src/mesa_service/models/wind_turbine_maintenance/model.py) conventions. This is the **core layer only**; no backend product installation, no API/worker/bundle integration.

**Claim boundary:** all inputs are synthetic defaults; verbal/experience parameters are not yet quantified. The model claims technical executability only, never calibration or decision readiness.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `mesa_service/src/mesa_service/models/aircraft_support/__init__.py` | Package exports mirroring the wind package. |
| `mesa_service/src/mesa_service/models/aircraft_support/model.py` | The full model: spec definitions, enums, records, agents, scheduler, mechanics, metrics. |
| `mesa_service/src/mesa_service/models/__init__.py` | Register `AircraftSupportModel` alongside the wind model. |
| `mesa_service/tests/test_aircraft_model.py` | Microcase + mechanism + validation tests (mirrors `test_wind_model.py`). |
| `mesa_service/src/mesa_service/model_assets/aircraft_support/model-spec.json` | Exported spec projection. |
| `mesa_service/src/mesa_service/model_assets/aircraft_support/parameter-schema.json` | Strict parameter schema (exact key set). |
| `mesa_service/src/mesa_service/model_assets/aircraft_support/metric-schema.json` | Strict metric schema (exact key set). |
| `mesa_service/src/mesa_service/model_assets/aircraft_support/visualization.json` | Visualization mapping. |
| `mesa_service/src/mesa_service/model_assets/aircraft_support/provenance.json` | Source/claim provenance (verbal/experience, unquantified). |
| `mesa_service/src/mesa_service/model_assets/aircraft_support/traceability.json` | Domain-brief rule → model-rule mapping. |
| `mesa_service/src/mesa_service/model_assets/aircraft_support/defaults/aircraft-support-demo-v1.json` | Executable synthetic demo preset. |
| `mesa_service/src/mesa_service/model_assets/aircraft_support/tests/microcase.json` | The deterministic microcase fixture + oracle summary. |

No new files outside these paths. No existing file changes except `models/__init__.py`.

---

## Locked design decisions

### Constants and identity
- `MODEL_ID = "aircraft-support"`, `MODEL_CLASS = "AircraftSupportModel"`, `MODEL_PROTOCOL_VERSION = "aircraft-support-v1"`.
- Random-stream derivation: first 64 bits of `SHA-256("aircraft-support-v1:<run-seed>:<stream-name>")`, one dedicated `random.Random` per stream (mirrors wind `_stream_seed`).
- Stream names: `initial_maintenance`, `failure`, `repair_duration`, `scheduled_duration`.

### Time and phases (mirrors wind)
- Time unit: continuous fractional days internally; one public `step()` advances to the next natural-day boundary after processing boundary events.
- Phases: `PHASE_REQUEST_TRIGGER = 10`, `PHASE_WORK_COMPLETION = 20`, `PHASE_PART_ARRIVAL = 30`, `PHASE_DISPATCH = 40`, `PHASE_DAILY_SNAPSHOT = 50`.
- Heap key `(sim_time_days, phase, -schedule_sequence)`; LIFO within a phase; `_schedule` guard rails identical to wind (`at >= sim_time_days`, no scheduling into an already-finished lower phase at the same time).
- `PHASE_DAILY_SNAPSHOT` events never mutate state; flight/mission events are ordinary model events.

### Entities, states, events
```text
AircraftState = operating | in_flight | grounded_for_repair |
                grounded_for_maintenance | grounded_for_part
TeamState     = idle | working
HangarState   = free | occupied
RequestKind   = corrective | scheduled
OperationKind = repair | scheduled_maintenance
WorkStatus    = queued | assigned | in_progress | blocked_on_part |
                completed | superseded
```

Domain events (`DOMAIN_EVENT_TYPES`, 18):
`flight_started`, `flight_completed`, `failure_occurred`, `maintenance_due`, `request_queued`, `request_superseded`, `request_suppressed`, `repair_started`, `repair_completed`, `maintenance_started`, `maintenance_completed`, `team_assigned`, `part_ordered`, `part_received`, `part_backordered`, `aircraft_grounded`, `aircraft_released`, `daily_snapshot`.

### Parameters (exact IDs, 21)
```text
aircraft_count, team_count, hangar_count,
missions_per_day, mission_flying_hours, failure_rate_per_flying_hour,
scheduled_maintenance_interval_days,
repair_low_hours, repair_mode_hours, repair_high_hours,
scheduled_low_hours, scheduled_mode_hours, scheduled_high_hours,
part_initial_stock, part_reorder_point, part_order_quantity,
part_lead_time_days, part_unit_cost, part_holding_cost_per_day,
team_cost_per_day, repair_cost, scheduled_maintenance_cost,
aog_penalty_per_day, daily_revenue_per_operating_aircraft,
minimum_availability_fraction
```
(25 IDs; ranges follow wind bounds: counts, `0.01..720` hours, `1..3650` interval, `0..1e9` currency, fractions `0..1`, `failure_rate_per_flying_hour` in `1e-6..1`.)

### Core mechanics (locked)
1. **Flights (missions):** each operating aircraft flies one daily mission block of `mission_flying_hours / 24` days, departing at the next day boundary (`floor(now) + 1`); at initialization every aircraft's first flight departs at `t=0`. On `flight_started` schedule `flight_completed` at departure + block duration. A flight is valid only while the aircraft is `in_flight` with a matching `flight_generation` token; failure invalidates the pending completion. On `flight_completed` the aircraft returns to `operating`, increments `failure_generation` (invalidating any pending failure), and schedules the next flight. Flights are not scheduled at or beyond the horizon. `missions_per_day` is reserved as the missions-per-day demand driver and currently equals 1 mission block per day (documented as v1 aggregation).
2. **Failure sampling (per flight):** on `flight_started`, pop the next scripted failure time (if within `[departure, landing)`) or sample `expovariate(failure_rate_per_flying_hour * 24)`; schedule a `failure_trigger`. A valid trigger (token matches, state `in_flight`) grounds the aircraft → `grounded_for_repair`, emits `failure_occurred` + `aircraft_grounded`, enqueues exactly one corrective order, invalidates the pending flight completion, and schedules the deduplicated dispatch. Failures occur only while flying.
3. **Scheduled maintenance due:** `maintenance_due_at_days = time_last_maintenance + interval`. Initial `time_last_maintenance` sampled uniformly in `[-interval, 0]` from `initial_maintenance` stream (or fixture). On a valid due trigger, emit `maintenance_due`; if a corrective order is active (queued/assigned/in_progress/blocked_on_part) emit `request_suppressed` (reason `corrective_order_active`) and retain the due timestamp; else if a scheduled order is already queued emit `request_suppressed` (reason `scheduled_order_active`); else create one scheduled order and emit `request_queued`. The aircraft stays `operating`/`in_flight` while overdue; it becomes `grounded_for_maintenance` only when scheduled work starts.
4. **Dispatch (phase 40, deduplicated, non-preemptive):** available idle teams sorted by `team_id`. Corrective before scheduled; FIFO within each queue; stable team ID as tie-break. Corrective work needs a team and one part; scheduled work needs a team and a free hangar slot and a grounded (`operating`) aircraft. An in-flight aircraft's scheduled order stays queued. A corrective order with zero part stock is marked `blocked_on_part`, the aircraft becomes `grounded_for_part`, `part_backordered` is emitted, and the reorder policy is checked; the order stays queued. Repair starts immediately on assignment (no travel).
5. **Same-crew maintenance continuation (mirrors wind):** if a repair completes while the aircraft is maintenance-overdue (`maintenance_due_at_days <= now`), create a scheduled order already `in_progress` with the same team (hangar must be free), emit `maintenance_started` with `same_crew=true`, close the maintenance wait, and schedule its completion.
6. **Parts (single part type, `part-0001`):** reorder-point/order-quantity policy with fixed lead time. After every part consumption and on every shortage block, `_maybe_reorder()` places one order of `part_order_quantity` when `stock + in_transit <= part_reorder_point`, emitting `part_ordered`. Part arrival increments stock by the order quantity, emits `part_received`, flips any `blocked_on_part` orders back to `queued`, restores those aircraft to `grounded_for_repair`, and schedules dispatch.
7. **Work completion:** repair adds `repair_cost`; scheduled maintenance adds `scheduled_maintenance_cost`; both only when the completion time is in `[warmup_days, horizon_days)`. On completion, if maintenance was overdue and the order is a repair, continue with the same crew; otherwise release team + hangar, set `time_last_maintenance = now` (scheduled only), reschedule the next maintenance due (`now + interval` or next scripted), return to `operating`, emit `aircraft_released`, and schedule the next flight.
8. **Flight/mission invalidation:** entering any grounded state or completing a flight increments `flight_generation`, so pending flight departures and completions with stale tokens are consumed silently and counted in `stale_scheduled_event_count`.
9. **Wait cohorts:** corrective wait origin = `failure_occurred`; maintenance wait origin = `maintenance_due`; both resolved at operation start. Right-censored origins at horizon are excluded from mean/P95 and reported via censored counts. P95 = nearest rank `sorted[ceil(0.95*n)-1]`.
10. **Metrics:** interval-exact state-time accumulation inside the half-open `[warmup_days, horizon_days)` window; `measurement_window_observed = 0` before the window with availability identity `1.0`; explicit numerator/denominator fields retained. Availability = mission-capable = `(operating + in_flight) aircraft-days / (aircraft_count * elapsed)` (documented). Team utilization = working team-days / `(team_count * elapsed)`; hangar utilization = occupied hangar-days / `(hangar_count * elapsed)`. Fixed team cost = `team_count * team_cost_per_day * elapsed`. Part procurement cost = `part_unit_cost * parts_consumed` (consumption time in window); AOG penalty = `aog_penalty_per_day * grounded_for_part_days`; holding cost = `part_holding_cost_per_day * part_stock_days` (stock level integrated over time). Revenue = `daily_revenue_per_operating_aircraft * operating_days`. Mission count = completed flights; mission completion rate = completed / (`aircraft_count * missions_per_day * elapsed`).

### The deterministic microcase (hand oracle)
- `horizon=4, warmup=0, seed=2`, `aircraft_count=3, team_count=1, hangar_count=1`.
- `missions_per_day=1, mission_flying_hours=6` (block 0.25 days); `failure_rate_per_flying_hour=0.1` (unused, scripted).
- `scheduled_maintenance_interval_days=90`; repair triangular 12/12/12h = 0.5 day; scheduled triangular 6/6/6h = 0.25 day.
- Parts: `part_initial_stock=0, part_reorder_point=1, part_order_quantity=2, part_lead_time_days=1.0, part_unit_cost=50, part_holding_cost_per_day=0`.
- `team_cost_per_day=10, repair_cost=100, scheduled_maintenance_cost=40, aog_penalty_per_day=0, daily_revenue_per_operating_aircraft=0, minimum_availability_fraction=0.95`.
- Fixture: `maintenance_due_times_days={"aircraft-0001":[0.0], "aircraft-0002":[0.1], "aircraft-0003":[1.2]}`; `failure_times_days={"aircraft-0001":[10.0], "aircraft-0002":[10.0], "aircraft-0003":[0.2, 10.0]}`; `repair_durations_days=[0.5]`; `scheduled_durations_days=[0.25, 0.25, 0.25]`.

Expected mechanism events (non-snapshot), in order (time, event, aircraft, work-order, states, payload):

```text
(0.0,  flight_started,        a3, -, in_flight, operating→in_flight, {})
(0.0,  flight_started,        a2, -, in_flight, operating→in_flight, {})
(0.0,  flight_started,        a1, -, in_flight, operating→in_flight, {})
(0.0,  maintenance_due,       a1, -, -, -, {})
(0.0,  request_queued,        a1, work-00000001, -, -, {request_kind: scheduled})
(0.1,  maintenance_due,       a2, -, -, -, {})
(0.1,  request_queued,        a2, work-00000002, -, -, {request_kind: scheduled})
(0.2,  failure_occurred,      a3, -, grounded_for_repair, in_flight→grounded_for_repair, {})
(0.2,  aircraft_grounded,     a3, -, grounded_for_repair, in_flight→grounded_for_repair, {})
(0.2,  request_queued,        a3, work-00000003, -, -, {request_kind: corrective})
(0.2,  part_backordered,      a3, work-00000003, grounded_for_part, -, {part_id: part-0001})
(0.2,  part_ordered,          -, -, -, -, {part_id: part-0001, quantity: 2, eta_days: 1.2})
(0.25, flight_completed,      a1, -, operating, in_flight→operating, {})
(0.25, flight_completed,      a2, -, operating, in_flight→operating, {})
(0.25, team_assigned,         a1, work-00000001, -, -, {request_kind: scheduled})
(0.25, aircraft_grounded,     a1, -, grounded_for_maintenance, operating→grounded_for_maintenance, {})
(0.25, maintenance_started,   a1, work-00000001, -, -, {same_crew: false})
(0.5,  maintenance_completed, a1, work-00000001, operating, grounded_for_maintenance→operating, {cost: 40.0})
(0.5,  aircraft_released,     a1, -, operating, grounded_for_maintenance→operating, {})
(0.5,  team_assigned,         a2, work-00000002, -, -, {request_kind: scheduled})
(0.5,  aircraft_grounded,     a2, -, grounded_for_maintenance, operating→grounded_for_maintenance, {})
(0.5,  maintenance_started,   a2, work-00000002, -, -, {same_crew: false})
(0.75, maintenance_completed, a2, work-00000002, operating, grounded_for_maintenance→operating, {cost: 40.0})
(0.75, aircraft_released,     a2, -, operating, grounded_for_maintenance→operating, {})
(1.0,  flight_started,        a1, -, in_flight, operating→in_flight, {})
(1.0,  flight_started,        a2, -, in_flight, operating→in_flight, {})
(1.2,  maintenance_due,       a3, -, -, -, {})
(1.2,  request_suppressed,    a3, -, -, -, {reason: corrective_order_active})
(1.2,  part_received,         -, -, -, -, {part_id: part-0001, quantity: 2, stock: 2})
(1.2,  team_assigned,         a3, work-00000003, -, -, {request_kind: corrective})
(1.2,  repair_started,        a3, work-00000003, -, -, {same_crew: false})
(1.2,  part_ordered,          -, -, -, -, {part_id: part-0001, quantity: 2, eta_days: 2.2})
(1.25, flight_completed,      a1, -, operating, in_flight→operating, {})
(1.25, flight_completed,      a2, -, operating, in_flight→operating, {})
(1.7,  repair_completed,      a3, work-00000003, grounded_for_maintenance, grounded_for_repair→grounded_for_maintenance, {cost: 100.0})
(1.7,  maintenance_started,   a3, work-00000004, -, -, {same_crew: true})
(1.95, maintenance_completed, a3, work-00000004, operating, grounded_for_maintenance→operating, {cost: 40.0})
(1.95, aircraft_released,     a3, -, operating, grounded_for_maintenance→operating, {})
(2.0,  flight_started,        a1, -, in_flight, operating→in_flight, {})
(2.0,  flight_started,        a2, -, in_flight, operating→in_flight, {})
(2.0,  flight_started,        a3, -, in_flight, operating→in_flight, {})
(2.2,  part_received,         -, -, -, -, {part_id: part-0001, quantity: 2, stock: 3})
(2.25, flight_completed,      a1, -, operating, in_flight→operating, {})
(2.25, flight_completed,      a2, -, operating, in_flight→operating, {})
(2.25, flight_completed,      a3, -, operating, in_flight→operating, {})
(3.0,  flight_started,        a1, -, in_flight, operating→in_flight, {})
(3.0,  flight_started,        a2, -, in_flight, operating→in_flight, {})
(3.0,  flight_started,        a3, -, in_flight, operating→in_flight, {})
(3.25, flight_completed,      a1, -, operating, in_flight→operating, {})
(3.25, flight_completed,      a2, -, operating, in_flight→operating, {})
(3.25, flight_completed,      a3, -, operating, in_flight→operating, {})
```
Plus 5 `daily_snapshot` events at days 0,1,2,3,4. Total 56 domain events, sequences 1..56. `stale_scheduled_event_count = 3` (A3 flight completion at 0.25; A1 and A2 stale flight departures at 1.0 invalidated by maintenance grounding).

> **LIFO ordering note:** within one timestamp+phase, later-scheduled events fire first (negative schedule-sequence heap key, wind convention). The oracle rows are ordered by this rule; e.g. at t=0 the three `flight_started` fire `a3, a2, a1` because a1's flight was scheduled first. When implementing the Task 5 exact-sequence test, run the model and verify the *semantics* of each row (time, phase, IDs, states, payload) against this oracle; if the exact intra-phase ordering differs, re-derive it from the LIFO rule rather than hand-editing the oracle.

Final snapshot oracle (day 4, window `[0,4)`):
```text
state days: operating=7.05, in_flight=2.7, grounded_for_repair=0.5,
            grounded_for_maintenance=0.75, grounded_for_part=1.0
availability_numerator=9.75, denominator=12, availability_fraction=9.75/12
team working=1.25, utilization=1.25/4
hangar occupied=0.75, utilization=0.75/4
corrective_wait samples=[1.0], mean=1.0, p95=1.0, censored=0
maintenance_overdue samples=[0.25, 0.4, 0.5], mean=0.38333, p95=0.5, censored=0
mission completed=10 (a1=4, a2=4, a3=2), required=12, completion=10/12
failure_count=1, repair_count=1, maintenance_count=3
parts_consumed=1, part_orders_placed=2, part_stock=3
team_cost=40, work_cost=220 (repair 100 + scheduled 120),
part_procurement_cost=50, aog=0, holding=0, total_cost=310, revenue=0
stale_scheduled_event_count=3
```

### Tests plan (mirrors `test_wind_model.py` helpers)
- `_aircraft_module()`, `_parameters(**overrides)`, `_microcase_fixture(module)`, `_run_to_horizon(model)`, `_mechanism_events`, `_event_projection`, `_snapshot_payload`.
- Main test asserts the full ordered event list, exact per-event semantics (sequence, phase, IDs, correlation, states, payload), daily snapshot KPIs, final snapshot, invariants, and finite values.
- Focused tests: stale flight invalidation after failure; part shortage AOG + reorder arrival unblocks; request_suppressed reason; same-crew continuation; maintenance-due-while-in-flight queued then grounded; phase ordering at simultaneous events; zero-duration rejection; snapshot exactly matches metric schema; parameterized invalid-parameter rejection.
- A supersession test: failure while a queued scheduled order exists (aircraft in flight, due while flying) → scheduled superseded, corrective created.

---

## Tasks

### Task 1: Package scaffold, spec definitions, enums, records

**Files:**
- Create: `mesa_service/src/mesa_service/models/aircraft_support/model.py`
- Create: `mesa_service/src/mesa_service/models/aircraft_support/__init__.py`
- Test: `mesa_service/tests/test_aircraft_model.py`

- [ ] **Step 1: Write failing tests** for the spec export contract and identity (no model class yet → import fails). Put in `test_aircraft_model.py`:

```python
from __future__ import annotations

import importlib


def _aircraft_module():
    return importlib.import_module("mesa_service.models.aircraft_support.model")


def test_module_identity_and_spec_contract() -> None:
    module = _aircraft_module()
    assert module.MODEL_ID == "aircraft-support"
    assert module.MODEL_CLASS == "AircraftSupportModel"
    assert module.MODEL_PROTOCOL_VERSION == "aircraft-support-v1"
    spec = module.MODEL_SPEC_DEFINITIONS
    assert spec["model_id"] == "aircraft-support"
    assert spec["time_unit"] == "day"
    assert spec["public_step"] == "next_natural_day_boundary"
    assert set(spec["entities"]) == {"aircraft", "maintenance_team", "hangar_slot", "part_type", "work_order"}
    assert len(module.DOMAIN_EVENT_TYPES) == 18
    assert "daily_snapshot" in module.DOMAIN_EVENT_TYPES
    assert spec["event_ordering"]["heap_key"] == ["sim_time_days", "phase", "negative_schedule_sequence"]
    assert spec["queue_policy"]["priority"] == ["corrective", "scheduled"]
```

- [ ] **Step 2: Run** `uv run --project mesa_service pytest tests/test_aircraft_model.py -q`. Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement** the module constants, `MODEL_SPEC_DEFINITIONS`, enums, `ScenarioFixture`, `WorkOrder`, `PartOrder`, `_ScheduledEvent` in `model.py` (complete code in Task 2; here only the scaffold plus spec/enums/records). Full spec follows the wind layout with the aircraft ontology:

```python
"""Reviewed Mesa aircraft maintenance & logistics support model (core layer).

The decision question is fleet mission capability under daily missions,
maintenance, team/hangar resources, and a single spare-part stock policy.
All inputs are synthetic defaults; no calibration or decision readiness is
claimed.
"""

from __future__ import annotations

import copy
import hashlib
import heapq
import math
import random
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Mapping

import mesa


MODEL_ID = "aircraft-support"
MODEL_CLASS = "AircraftSupportModel"
MODEL_PROTOCOL_VERSION = "aircraft-support-v1"

PHASE_REQUEST_TRIGGER = 10
PHASE_WORK_COMPLETION = 20
PHASE_PART_ARRIVAL = 30
PHASE_DISPATCH = 40
PHASE_DAILY_SNAPSHOT = 50

DOMAIN_EVENT_TYPES = [
    "flight_started",
    "flight_completed",
    "failure_occurred",
    "maintenance_due",
    "request_queued",
    "request_superseded",
    "request_suppressed",
    "repair_started",
    "repair_completed",
    "maintenance_started",
    "maintenance_completed",
    "team_assigned",
    "part_ordered",
    "part_received",
    "part_backordered",
    "aircraft_grounded",
    "aircraft_released",
    "daily_snapshot",
]

PARAMETER_IDS = [
    "aircraft_count",
    "team_count",
    "hangar_count",
    "missions_per_day",
    "mission_flying_hours",
    "failure_rate_per_flying_hour",
    "scheduled_maintenance_interval_days",
    "repair_low_hours",
    "repair_mode_hours",
    "repair_high_hours",
    "scheduled_low_hours",
    "scheduled_mode_hours",
    "scheduled_high_hours",
    "part_initial_stock",
    "part_reorder_point",
    "part_order_quantity",
    "part_lead_time_days",
    "part_unit_cost",
    "part_holding_cost_per_day",
    "team_cost_per_day",
    "repair_cost",
    "scheduled_maintenance_cost",
    "aog_penalty_per_day",
    "daily_revenue_per_operating_aircraft",
    "minimum_availability_fraction",
]

MODEL_SPEC_DEFINITIONS: dict[str, Any] = {
    "model_id": MODEL_ID,
    "model_class": MODEL_CLASS,
    "model_protocol_version": MODEL_PROTOCOL_VERSION,
    "time_unit": "day",
    "public_step": "next_natural_day_boundary",
    "entities": {
        "aircraft": {
            "class": "AircraftAgent",
            "id_pattern": "aircraft-%04d",
            "states": ["operating", "in_flight", "grounded_for_repair", "grounded_for_maintenance", "grounded_for_part"],
        },
        "maintenance_team": {
            "class": "MaintenanceTeamAgent",
            "id_pattern": "team-%02d",
            "states": ["idle", "working"],
        },
        "hangar_slot": {
            "class": "HangarSlot",
            "id_pattern": "hangar-%02d",
            "states": ["free", "occupied"],
        },
        "part_type": {
            "id_pattern": "part-0001",
            "stock_policy": "reorder_point_order_quantity",
        },
        "work_order": {
            "id_pattern": "work-%08d",
            "request_kinds": ["corrective", "scheduled"],
            "operation_kinds": ["repair", "scheduled_maintenance"],
            "statuses": ["queued", "assigned", "in_progress", "blocked_on_part", "completed", "superseded"],
        },
    },
    "event_ordering": {
        "heap_key": ["sim_time_days", "phase", "negative_schedule_sequence"],
        "phase_values": {
            "request_trigger": 10,
            "work_completion": 20,
            "part_arrival": 30,
            "dispatch": 40,
            "daily_snapshot": 50,
        },
        "same_phase_tie_break": "lifo",
        "team_assignment_tie_break": "ascending_team_id",
    },
    "queue_policy": {
        "priority": ["corrective", "scheduled"],
        "within_priority": "fifo",
        "dispatch": "centralized_non_preemptive",
    },
    "distribution_families": {
        "failure": "exponential_per_flying_hour",
        "repair": "triangular",
        "scheduled_maintenance": "triangular",
    },
    "failure_semantics": {
        "sampling": "once_per_flight_on_flight_entry",
        "rate": "failure_rate_per_flying_hour",
        "unit": "1/flying-hour",
    },
    "named_random_streams": ["initial_maintenance", "failure", "repair_duration", "scheduled_duration"],
    "parts": {
        "single_part_type": True,
        "part_type_id": "part-0001",
        "policy": "reorder_point_order_quantity_with_fixed_lead_time",
    },
    "required_domain_events": DOMAIN_EVENT_TYPES,
    "measurement_window": "half_open_warmup_to_horizon",
    "p95_method": "nearest_rank",
    "claim_scope": "synthetic_draft_unverified_no_calibration",
}


class AircraftState(str, Enum):
    OPERATING = "operating"
    IN_FLIGHT = "in_flight"
    GROUNDED_FOR_REPAIR = "grounded_for_repair"
    GROUNDED_FOR_MAINTENANCE = "grounded_for_maintenance"
    GROUNDED_FOR_PART = "grounded_for_part"


class TeamState(str, Enum):
    IDLE = "idle"
    WORKING = "working"


class HangarState(str, Enum):
    FREE = "free"
    OCCUPIED = "occupied"


class RequestKind(str, Enum):
    CORRECTIVE = "corrective"
    SCHEDULED = "scheduled"


class OperationKind(str, Enum):
    REPAIR = "repair"
    SCHEDULED_MAINTENANCE = "scheduled_maintenance"


class WorkStatus(str, Enum):
    QUEUED = "queued"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    BLOCKED_ON_PART = "blocked_on_part"
    COMPLETED = "completed"
    SUPERSEDED = "superseded"


@dataclass
class ScenarioFixture:
    """Private deterministic draw seam used by hand-oracle tests."""

    maintenance_due_times_days: Mapping[str, list[float]] = field(default_factory=dict)
    failure_times_days: Mapping[str, list[float]] = field(default_factory=dict)
    repair_durations_days: list[float] = field(default_factory=list)
    scheduled_durations_days: list[float] = field(default_factory=list)


@dataclass
class WorkOrder:
    work_order_id: str
    request_kind: RequestKind
    aircraft_id: str
    requested_at_days: float
    source_event_id: str
    enqueue_sequence: int
    status: WorkStatus = WorkStatus.QUEUED
    operation_kind: OperationKind | None = None
    correlation_id: str | None = None
    assigned_team_id: str | None = None
    assigned_at_days: float | None = None
    started_at_days: float | None = None
    completed_at_days: float | None = None
    superseded_by_order_id: str | None = None


@dataclass
class PartOrder:
    part_order_id: str
    quantity: int
    ordered_at_days: float
    arrival_at_days: float
    received: bool = False


@dataclass(frozen=True)
class _ScheduledEvent:
    sim_time_days: float
    phase: int
    schedule_sequence: int
    event_type: str
    aircraft_id: str | None = None
    team_id: str | None = None
    work_order_id: str | None = None
    part_order_id: str | None = None
    token: int | None = None
```

- [ ] **Step 4: Run** the test. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add mesa_service/src/mesa_service/models/aircraft_support mesa_service/tests/test_aircraft_model.py
git commit -m "feat(aircraft): scaffold aircraft-support model package and spec contract"
```

### Task 2: Agents, constructor, validation, scheduler, streams

- [ ] **Step 1: Write failing tests** (add to `test_aircraft_model.py`): parameter validation and stream seeding.

```python
import math
import pytest


def _parameters(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "aircraft_count": 3,
        "team_count": 1,
        "hangar_count": 1,
        "missions_per_day": 1,
        "mission_flying_hours": 6,
        "failure_rate_per_flying_hour": 0.1,
        "scheduled_maintenance_interval_days": 90,
        "repair_low_hours": 12,
        "repair_mode_hours": 12,
        "repair_high_hours": 12,
        "scheduled_low_hours": 6,
        "scheduled_mode_hours": 6,
        "scheduled_high_hours": 6,
        "part_initial_stock": 0,
        "part_reorder_point": 1,
        "part_order_quantity": 2,
        "part_lead_time_days": 1.0,
        "part_unit_cost": 50,
        "part_holding_cost_per_day": 0,
        "team_cost_per_day": 10,
        "repair_cost": 100,
        "scheduled_maintenance_cost": 40,
        "aog_penalty_per_day": 0,
        "daily_revenue_per_operating_aircraft": 0,
        "minimum_availability_fraction": 0.95,
    }
    values.update(overrides)
    return values


@pytest.mark.parametrize(
    ("overrides", "message_fragment"),
    [
        ({"aircraft_count": 0}, "aircraft_count"),
        ({"team_count": 0}, "team_count"),
        ({"hangar_count": 0}, "hangar_count"),
        ({"repair_low_hours": 13, "repair_mode_hours": 12}, "repair"),
        ({"scheduled_mode_hours": 7, "scheduled_high_hours": 6}, "scheduled"),
        ({"failure_rate_per_flying_hour": math.inf}, "finite"),
        ({"part_order_quantity": 0}, "part_order_quantity"),
        ({"part_reorder_point": -1}, "part_reorder_point"),
    ],
)
def test_model_rejects_invalid_cross_field_and_nonfinite_parameters(overrides: dict[str, Any], message_fragment: str) -> None:
    module = _aircraft_module()
    with pytest.raises((TypeError, ValueError), match=message_fragment):
        module.AircraftSupportModel(parameters=_parameters(**overrides), horizon_days=4, warmup_days=0, seed=2)


def test_constructor_builds_agents_and_named_streams() -> None:
    module = _aircraft_module()
    model = module.AircraftSupportModel(parameters=_parameters(), horizon_days=4, warmup_days=0, seed=2)
    assert len(model.aircraft) == 3
    assert len(model.teams) == 1
    assert len(model.hangars) == 1
    assert {name for name in model._random_streams} == set(module.MODEL_SPEC_DEFINITIONS["named_random_streams"])
    assert all(aircraft.state is module.AircraftState.OPERATING for aircraft in model.aircraft.values())
    assert all(team.state is module.TeamState.IDLE for team in model.teams.values())
    assert all(hangar.state is module.HangarState.FREE for hangar in model.hangars.values())
```

- [ ] **Step 2: Run**. Expected: FAIL (`AttributeError: AircraftSupportModel`).

- [ ] **Step 3: Implement** agents, constructor, `_validate_parameters`, `_stream_seed`, scheduler primitives in `model.py`:

```python
class AircraftAgent(mesa.Agent):
    def __init__(self, model: "AircraftSupportModel", aircraft_id: str) -> None:
        super().__init__(model)
        self.aircraft_id = aircraft_id
        self.state = AircraftState.OPERATING
        self.time_last_maintenance_days = 0.0
        self.maintenance_due_at_days = math.inf
        self.maintenance_due_event_id: str | None = None
        self.failure_generation = 0
        self.flight_generation = 0
        self.maintenance_generation = 0
        self.active_corrective_order_id: str | None = None
        self.active_planned_order_id: str | None = None
        self.assigned_team_id: str | None = None


class MaintenanceTeamAgent(mesa.Agent):
    def __init__(self, model: "AircraftSupportModel", team_id: str) -> None:
        super().__init__(model)
        self.team_id = team_id
        self.state = TeamState.IDLE
        self.current_work_order_id: str | None = None


class HangarSlot(mesa.Agent):
    def __init__(self, model: "AircraftSupportModel", hangar_id: str) -> None:
        super().__init__(model)
        self.hangar_id = hangar_id
        self.state = HangarState.FREE
        self.current_work_order_id: str | None = None


class AircraftSupportModel(mesa.Model):
    """Mesa model with fractional-day mechanics and daily public stepping."""

    def __init__(
        self,
        *,
        parameters: Mapping[str, Any],
        horizon_days: int,
        warmup_days: int,
        seed: int,
        scenario_fixture: ScenarioFixture | None = None,
        event_sink: Callable[[dict[str, Any]], None] | None = None,
        identity: Mapping[str, Any] | None = None,
    ) -> None:
        self.parameters = self._validate_parameters(parameters)
        if isinstance(horizon_days, bool) or not isinstance(horizon_days, int) or not 1 <= horizon_days <= 3660:
            raise ValueError("horizon_days must be an integer between 1 and 3660")
        if isinstance(warmup_days, bool) or not isinstance(warmup_days, int) or not 0 <= warmup_days < horizon_days:
            raise ValueError("warmup_days must be an integer below horizon_days")
        if isinstance(seed, bool) or not isinstance(seed, int):
            raise TypeError("seed must be an integer")
        super().__init__(rng=seed)
        self.horizon_days = horizon_days
        self.warmup_days = warmup_days
        self.seed = seed
        self.sim_time_days = 0.0
        self._day_index = 0
        self._fixture = copy.deepcopy(scenario_fixture)
        self._fixture_due = {key: list(value) for key, value in (self._fixture.maintenance_due_times_days.items() if self._fixture else [])}
        self._fixture_failure = {key: list(value) for key, value in (self._fixture.failure_times_days.items() if self._fixture else [])}
        self._fixture_repair = list(self._fixture.repair_durations_days) if self._fixture else []
        self._fixture_scheduled = list(self._fixture.scheduled_durations_days) if self._fixture else []
        self._event_sink = event_sink
        self._identity = dict(identity or {})
        self._domain_buffer: list[dict[str, Any]] = []
        self._domain_sequence = 0
        self._schedule_sequence = 0
        self._work_sequence = 0
        self._queue_sequence = 0
        self._part_order_sequence = 0
        self._scheduled: list[tuple[float, int, int, _ScheduledEvent]] = []
        self._processing_time: float | None = None
        self._processing_phase: int | None = None
        self._dispatch_times: set[float] = set()
        self._corrective_queue: list[tuple[float, int, str]] = []
        self._scheduled_queue: list[tuple[float, int, str]] = []
        self.work_orders: dict[str, WorkOrder] = {}
        self.part_orders: dict[str, PartOrder] = {}
        self.part_stock = int(self.parameters["part_initial_stock"])
        self.part_in_transit = 0
        self.stale_scheduled_event_count = 0
        self.processed_scheduled_event_count = 0
        self.flight_count = 0
        self.failure_count = 0
        self.repair_count = 0
        self.maintenance_count = 0
        self.parts_consumed = 0
        self.part_orders_placed = 0
        self.failure_delay_sample_count = 0
        self._last_integrated_time = 0.0
        self._aircraft_state_days = {state: 0.0 for state in AircraftState}
        self._team_state_days = {state: 0.0 for state in TeamState}
        self._hangar_state_days = {state: 0.0 for state in HangarState}
        self._part_stock_days = 0.0
        self._last_part_stock = float(self.part_stock)
        self._corrective_waits: list[float] = []
        self._maintenance_waits: list[float] = []
        self._open_corrective_waits: dict[str, float] = {}
        self._open_maintenance_waits: dict[str, float] = {}
        self._work_cost = 0.0
        self._random_streams = {name: random.Random(self._stream_seed(name)) for name in MODEL_SPEC_DEFINITIONS["named_random_streams"]}

        self.aircraft: dict[str, AircraftAgent] = {}
        self.teams: dict[str, MaintenanceTeamAgent] = {}
        self.hangars: dict[str, HangarSlot] = {}
        self._create_agents()
        self._initialize_events()
        self._process_until(0.0)
        self._emit_daily_snapshot()

    @staticmethod
    def _validate_parameters(raw: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(raw, Mapping):
            raise TypeError("parameters must be a mapping")
        if set(raw) != set(PARAMETER_IDS):
            raise ValueError("parameters must contain the exact aircraft-support model parameter set")
        values = dict(raw)
        for name, value in values.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"{name} must be numeric")
            if not math.isfinite(float(value)):
                raise ValueError(f"{name} must be finite")
        for name in ("aircraft_count", "team_count", "hangar_count", "missions_per_day", "part_initial_stock", "part_reorder_point", "part_order_quantity"):
            if not isinstance(values[name], int):
                raise TypeError(f"{name} must be an integer")
        if not 1 <= values["aircraft_count"] <= 100:
            raise ValueError("aircraft_count must be between 1 and 100")
        if not 1 <= values["team_count"] <= 20:
            raise ValueError("team_count must be between 1 and 20")
        if not 1 <= values["hangar_count"] <= 20:
            raise ValueError("hangar_count must be between 1 and 20")
        if not 1 <= values["missions_per_day"] <= 10:
            raise ValueError("missions_per_day must be between 1 and 10")
        if not 0 < values["mission_flying_hours"] <= 24:
            raise ValueError("mission_flying_hours must be in (0, 24]")
        if values["failure_rate_per_flying_hour"] <= 0:
            raise ValueError("failure rate must be positive")
        if values["scheduled_maintenance_interval_days"] <= 0:
            raise ValueError("scheduled maintenance interval must be positive")
        for prefix in ("repair", "scheduled"):
            low = float(values[f"{prefix}_low_hours"])
            mode = float(values[f"{prefix}_mode_hours"])
            high = float(values[f"{prefix}_high_hours"])
            if low <= 0 or not low <= mode <= high:
                raise ValueError(f"{prefix} triangular parameters must satisfy 0 < low <= mode <= high")
        if values["part_order_quantity"] < 1:
            raise ValueError("part_order_quantity must be at least 1")
        if values["part_reorder_point"] < 0 or values["part_initial_stock"] < 0:
            raise ValueError("part stock values must be non-negative")
        if values["part_lead_time_days"] <= 0:
            raise ValueError("part lead time must be positive")
        if not 0 <= values["minimum_availability_fraction"] <= 1:
            raise ValueError("minimum availability must be between zero and one")
        for name in ("part_unit_cost", "part_holding_cost_per_day", "team_cost_per_day", "repair_cost", "scheduled_maintenance_cost", "aog_penalty_per_day", "daily_revenue_per_operating_aircraft"):
            if values[name] < 0:
                raise ValueError(f"{name} must be non-negative")
        return values

    def _stream_seed(self, name: str) -> int:
        material = f"{MODEL_PROTOCOL_VERSION}:{self.seed}:{name}".encode()
        return int.from_bytes(hashlib.sha256(material).digest()[:8], "big")

    def _create_agents(self) -> None:
        for index in range(1, int(self.parameters["aircraft_count"]) + 1):
            aircraft_id = f"aircraft-{index:04d}"
            self.aircraft[aircraft_id] = AircraftAgent(self, aircraft_id)
        for index in range(1, int(self.parameters["team_count"]) + 1):
            team_id = f"team-{index:02d}"
            self.teams[team_id] = MaintenanceTeamAgent(self, team_id)
        for index in range(1, int(self.parameters["hangar_count"]) + 1):
            hangar_id = f"hangar-{index:02d}"
            self.hangars[hangar_id] = HangarSlot(self, hangar_id)

    def _initialize_events(self) -> None:
        initial_rng = self._random_streams["initial_maintenance"]
        period = float(self.parameters["scheduled_maintenance_interval_days"])
        for aircraft_id in sorted(self.aircraft):
            aircraft = self.aircraft[aircraft_id]
            scripted = self._fixture_due.get(aircraft_id)
            if scripted:
                due = float(scripted.pop(0))
                aircraft.time_last_maintenance_days = due - period
            else:
                aircraft.time_last_maintenance_days = initial_rng.uniform(-period, 0.0)
                due = aircraft.time_last_maintenance_days + period
            self._schedule_maintenance_due(aircraft, due)
            self._schedule_flight(aircraft, at=0.0)

    def _schedule(self, at: float, phase: int, event_type: str, *, aircraft_id: str | None = None, team_id: str | None = None, work_order_id: str | None = None, part_order_id: str | None = None, token: int | None = None) -> None:
        at = float(at)
        if not math.isfinite(at) or at < self.sim_time_days:
            raise RuntimeError("scheduled event time must be finite and non-decreasing")
        if self._processing_time == at and self._processing_phase is not None and phase < self._processing_phase:
            raise RuntimeError("cannot schedule into an already-finished lower phase at the same simulation time")
        self._schedule_sequence += 1
        event = _ScheduledEvent(at, phase, self._schedule_sequence, event_type, aircraft_id, team_id, work_order_id, part_order_id, token)
        heapq.heappush(self._scheduled, (at, phase, -self._schedule_sequence, event))

    def _schedule_maintenance_due(self, aircraft: AircraftAgent, due: float) -> None:
        aircraft.maintenance_generation += 1
        aircraft.maintenance_due_at_days = float(due)
        self._schedule(due, PHASE_REQUEST_TRIGGER, "maintenance_due_trigger", aircraft_id=aircraft.aircraft_id, token=aircraft.maintenance_generation)

    def _schedule_flight(self, aircraft: AircraftAgent, *, at: float) -> None:
        aircraft.flight_generation += 1
        self._schedule(at, PHASE_REQUEST_TRIGGER, "flight_departure", aircraft_id=aircraft.aircraft_id, token=aircraft.flight_generation)
```

- [ ] **Step 4: Run** tests. Expected: PASS (constructor test passes; microcase test does not yet exist).

- [ ] **Step 5: Commit**
```bash
git add mesa_service/src/mesa_service/models/aircraft_support mesa_service/tests/test_aircraft_model.py
git commit -m "feat(aircraft): add agents, constructor, validation, streams, scheduler"
```

### Task 3: Flight mechanism

- [ ] **Step 1: Write failing test** for the flight lifecycle and stale invalidation.

```python
def test_flight_lifecycle_and_failure_invalidates_flight_completion() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [10.0]},
        failure_times_days={"aircraft-0001": [0.2, 10.0]},
        repair_durations_days=[0.5],
        scheduled_durations_days=[0.25],
    )
    model = module.AircraftSupportModel(
        parameters=_parameters(aircraft_count=1),
        horizon_days=1,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )
    events = _run_to_horizon(model)
    projections = [_event_projection(event) for event in _mechanism_events(events)]
    assert projections[0][0] == 0.0 and projections[0][1] == "flight_started"
    assert any(event["event_type"] == "failure_occurred" for event in projections)
    assert not any(event["event_type"] == "flight_completed" for event in projections)
    final = model.snapshot()
    assert final["in_flight_count"] == 0
    assert final["grounded_for_repair_count"] == 1
    assert final["stale_scheduled_event_count"] == 1
```

(Requires `_run_to_horizon`, `_mechanism_events`, `_event_projection` helpers — add them now.)

```python
def _run_to_horizon(model) -> list[dict[str, Any]]:
    events = list(model.drain_domain_events())
    while model.sim_time_days < model.horizon_days:
        model.step()
        events.extend(model.drain_domain_events())
    return events


def _mechanism_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event for event in events if event["event_type"] != "daily_snapshot"]


def _event_projection(event: dict[str, Any]) -> tuple[float, str, str | None]:
    return (float(event["sim_time_days"]), event["event_type"], event.get("aircraft_id"))


def _snapshot_payload(event: dict[str, Any]) -> dict[str, Any]:
    payload = event["payload"]
    return payload.get("snapshot", payload)
```

- [ ] **Step 2: Run**. Expected: FAIL (`flight_started` never emitted).

- [ ] **Step 3: Implement** the flight handlers, failure sampling, `_process_until`, `_handle_scheduled`, `_emit`, `_emit_daily_snapshot`, `step`, and a minimal `_handle_failure` that grounds and enqueues corrective (full corrective logic comes in Task 5).

```python
    def _process_until(self, target: float) -> None:
        while self._scheduled and self._scheduled[0][0] <= target:
            at, _, _, event = heapq.heappop(self._scheduled)
            self._integrate_to(at)
            self.sim_time_days = at
            self.processed_scheduled_event_count += 1
            self._processing_time = at
            self._processing_phase = event.phase
            try:
                self._handle_scheduled(event)
            finally:
                self._processing_time = None
                self._processing_phase = None
        self._integrate_to(target)
        self.sim_time_days = target

    def _handle_scheduled(self, event: _ScheduledEvent) -> None:
        if event.event_type == "flight_departure":
            self._handle_flight_departure(event)
        elif event.event_type == "flight_completion":
            self._handle_flight_completion(event)
        elif event.event_type == "failure_trigger":
            self._handle_failure(event)
        elif event.event_type == "maintenance_due_trigger":
            self._handle_maintenance_due(event)
        elif event.event_type == "part_arrival":
            self._handle_part_arrival(event)
        elif event.event_type == "dispatch":
            self._dispatch_times.discard(event.sim_time_days)
            self._dispatch()
        elif event.event_type == "work_completion":
            self._handle_completion(event.work_order_id)
        else:
            raise RuntimeError(f"unknown scheduled event {event.event_type}")

    def _integrate_to(self, target: float) -> None:
        if target < self._last_integrated_time:
            raise RuntimeError("simulation time moved backwards")
        start = max(self._last_integrated_time, float(self.warmup_days))
        end = min(float(target), float(self.horizon_days))
        duration = max(0.0, end - start)
        if duration:
            for aircraft in self.aircraft.values():
                self._aircraft_state_days[aircraft.state] += duration
            for team in self.teams.values():
                self._team_state_days[team.state] += duration
            for hangar in self.hangars.values():
                self._hangar_state_days[hangar.state] += duration
            self._part_stock_days += self._last_part_stock * duration
        self._last_integrated_time = target

    def _emit(self, event_type: str, phase: int, *, aircraft_id: str | None = None, team_id: str | None = None, work_order_id: str | None = None, correlation_id: str | None = None, before_state: str | None = None, after_state: str | None = None, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        self._domain_sequence += 1
        event = {
            **self._identity,
            "event_id": f"event-{self._domain_sequence:08d}",
            "sequence": self._domain_sequence,
            "sim_time_days": self.sim_time_days,
            "event_type": event_type,
            "phase": phase,
            "aircraft_id": aircraft_id,
            "team_id": team_id,
            "work_order_id": work_order_id,
            "correlation_id": correlation_id,
            "before_state": before_state,
            "after_state": after_state,
            "payload": dict(payload or {}),
        }
        if self._event_sink is None:
            self._domain_buffer.append(event)
        else:
            self._event_sink(event)
        return event

    def _emit_daily_snapshot(self) -> None:
        self._emit("daily_snapshot", PHASE_DAILY_SNAPSHOT, payload={"snapshot": self.snapshot()})

    def _schedule_next_flight(self, aircraft: AircraftAgent) -> None:
        boundary = math.floor(self.sim_time_days) + 1.0
        if boundary >= float(self.horizon_days):
            return
        self._schedule_flight(aircraft, at=boundary)

    def _handle_flight_departure(self, event: _ScheduledEvent) -> None:
        aircraft = self.aircraft[event.aircraft_id or ""]
        if event.token != aircraft.flight_generation or aircraft.state is not AircraftState.OPERATING:
            self.stale_scheduled_event_count += 1
            return
        before = aircraft.state.value
        aircraft.state = AircraftState.IN_FLIGHT
        self._emit("flight_started", PHASE_REQUEST_TRIGGER, aircraft_id=aircraft.aircraft_id, before_state=before, after_state=aircraft.state.value)
        block_days = float(self.parameters["missions_per_day"]) * float(self.parameters["mission_flying_hours"]) / 24.0
        aircraft.flight_generation += 1
        self._schedule(self.sim_time_days + block_days, PHASE_WORK_COMPLETION, "flight_completion", aircraft_id=aircraft.aircraft_id, token=aircraft.flight_generation)
        self._schedule_failure_on_flight_entry(aircraft)

    def _handle_flight_completion(self, event: _ScheduledEvent) -> None:
        aircraft = self.aircraft[event.aircraft_id or ""]
        if event.token != aircraft.flight_generation or aircraft.state is not AircraftState.IN_FLIGHT:
            self.stale_scheduled_event_count += 1
            return
        before = aircraft.state.value
        aircraft.state = AircraftState.OPERATING
        aircraft.flight_generation += 1
        aircraft.failure_generation += 1
        self.flight_count += int(self.parameters["missions_per_day"])
        self._emit("flight_completed", PHASE_WORK_COMPLETION, aircraft_id=aircraft.aircraft_id, before_state=before, after_state=aircraft.state.value)
        self._schedule_next_flight(aircraft)
        if self._peek_work_exists():
            self._ensure_dispatch()

    def _schedule_failure_on_flight_entry(self, aircraft: AircraftAgent) -> None:
        aircraft.failure_generation += 1
        self.failure_delay_sample_count += 1
        scripted = self._fixture_failure.get(aircraft.aircraft_id)
        if scripted and scripted[0] < self.sim_time_days + float(self.parameters["missions_per_day"]) * float(self.parameters["mission_flying_hours"]) / 24.0:
            failure_at = float(scripted.pop(0))
        else:
            failure_at = self.sim_time_days + self._random_streams["failure"].expovariate(float(self.parameters["failure_rate_per_flying_hour"]) * 24.0)
        if failure_at < self.sim_time_days:
            raise ValueError("fixture failure time cannot precede flight entry")
        self._schedule(failure_at, PHASE_REQUEST_TRIGGER, "failure_trigger", aircraft_id=aircraft.aircraft_id, token=aircraft.failure_generation)
```

- [ ] **Step 4: Run**. Expected: PASS for the flight lifecycle test. (The failure test needs a corrective enqueue in `_handle_failure`; if `_handle_failure` is not yet implemented the test fails at `AttributeError`. Implement a minimal `_handle_failure` now that grounds, emits, and enqueues a corrective order via `_new_order`, calling `_ensure_dispatch` — full dispatch arrives in Task 4/5.)

```python
    def _handle_failure(self, event: _ScheduledEvent) -> None:
        aircraft = self.aircraft[event.aircraft_id or ""]
        if event.token != aircraft.failure_generation or aircraft.state is not AircraftState.IN_FLIGHT:
            self.stale_scheduled_event_count += 1
            return
        before = aircraft.state.value
        aircraft.state = AircraftState.GROUNDED_FOR_REPAIR
        aircraft.flight_generation += 1
        aircraft.failure_generation += 1
        domain = self._emit("failure_occurred", PHASE_REQUEST_TRIGGER, aircraft_id=aircraft.aircraft_id, before_state=before, after_state=aircraft.state.value)
        self._emit("aircraft_grounded", PHASE_REQUEST_TRIGGER, aircraft_id=aircraft.aircraft_id, before_state=before, after_state=aircraft.state.value)
        if self._in_measurement_origin(self.sim_time_days):
            self.failure_count += 1
            self._open_corrective_waits[domain["event_id"]] = self.sim_time_days
        self._new_order(RequestKind.CORRECTIVE, aircraft, self.sim_time_days, domain["event_id"])
        self._ensure_dispatch()

    def _new_order(self, request_kind: RequestKind, aircraft: AircraftAgent, requested_at: float, source_event_id: str, *, correlation_id: str | None = None, emit_queued: bool = True) -> WorkOrder:
        self._work_sequence += 1
        self._queue_sequence += 1
        order = WorkOrder(
            work_order_id=f"work-{self._work_sequence:08d}",
            request_kind=request_kind,
            aircraft_id=aircraft.aircraft_id,
            requested_at_days=float(requested_at),
            source_event_id=source_event_id,
            enqueue_sequence=self._queue_sequence,
            correlation_id=correlation_id,
        )
        self.work_orders[order.work_order_id] = order
        if request_kind is RequestKind.CORRECTIVE:
            aircraft.active_corrective_order_id = order.work_order_id
            queue = self._corrective_queue
        else:
            aircraft.active_planned_order_id = order.work_order_id
            queue = self._scheduled_queue
        heapq.heappush(queue, (order.requested_at_days, order.enqueue_sequence, order.work_order_id))
        if emit_queued:
            self._emit("request_queued", PHASE_REQUEST_TRIGGER, aircraft_id=aircraft.aircraft_id, work_order_id=order.work_order_id, correlation_id=correlation_id, payload={"request_kind": request_kind.value})
        return order

    def _ensure_dispatch(self) -> None:
        if self.sim_time_days not in self._dispatch_times:
            self._dispatch_times.add(self.sim_time_days)
            self._schedule(self.sim_time_days, PHASE_DISPATCH, "dispatch")
```

- [ ] **Step 5: Commit**
```bash
git add mesa_service/src/mesa_service/models/aircraft_support mesa_service/tests/test_aircraft_model.py
git commit -m "feat(aircraft): implement flight lifecycle and per-flight failure sampling"
```

### Task 4: Maintenance due, dispatch, team + hangar assignment

- [ ] **Step 1: Write failing tests** for maintenance-due suppression, scheduled dispatch with hangar, and the same-crew continuation.

```python
def test_maintenance_due_while_grounded_for_repair_is_suppressed_and_same_crew_continues() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [0.0]},
        failure_times_days={"aircraft-0001": [10.0]},
        repair_durations_days=[],
        scheduled_durations_days=[0.25],
    )
    model = module.AircraftSupportModel(parameters=_parameters(aircraft_count=1), horizon_days=1, warmup_days=0, seed=2, scenario_fixture=fixture)
    events = _mechanism_events(_run_to_horizon(model))
    assert any(e["event_type"] == "maintenance_started" and e["work_order_id"] == "work-00000001" for e in events)
    assert any(e["event_type"] == "maintenance_completed" for e in events)
    final = model.snapshot()
    assert final["operating_count"] == 1
    assert final["maintenance_count"] == 1
```

- [ ] **Step 2: Run**. Expected: FAIL (`maintenance_started` never emitted).

- [ ] **Step 3: Implement** `_handle_maintenance_due`, `_dispatch`, queue pops, team/hangar assignment, scheduled start, and `_handle_completion` for scheduled work.

```python
    def _handle_maintenance_due(self, event: _ScheduledEvent) -> None:
        aircraft = self.aircraft[event.aircraft_id or ""]
        if event.token != aircraft.maintenance_generation:
            self.stale_scheduled_event_count += 1
            return
        aircraft.maintenance_due_at_days = self.sim_time_days
        domain = self._emit("maintenance_due", PHASE_REQUEST_TRIGGER, aircraft_id=aircraft.aircraft_id)
        aircraft.maintenance_due_event_id = domain["event_id"]
        if self._in_measurement_origin(self.sim_time_days):
            self._open_maintenance_waits[domain["event_id"]] = self.sim_time_days
        corrective = self.work_orders.get(aircraft.active_corrective_order_id or "")
        if corrective and corrective.status in {WorkStatus.QUEUED, WorkStatus.ASSIGNED, WorkStatus.IN_PROGRESS, WorkStatus.BLOCKED_ON_PART}:
            self._emit("request_suppressed", PHASE_REQUEST_TRIGGER, aircraft_id=aircraft.aircraft_id, correlation_id=domain["event_id"], payload={"reason": "corrective_order_active"})
            return
        planned = self.work_orders.get(aircraft.active_planned_order_id or "")
        if planned and planned.status not in {WorkStatus.COMPLETED, WorkStatus.SUPERSEDED}:
            self._emit("request_suppressed", PHASE_REQUEST_TRIGGER, aircraft_id=aircraft.aircraft_id, correlation_id=domain["event_id"], payload={"reason": "scheduled_order_active"})
            return
        self._new_order(RequestKind.SCHEDULED, aircraft, self.sim_time_days, domain["event_id"])
        self._ensure_dispatch()

    def _valid_queue_pop(self, queue: list[tuple[float, int, str]], kind: RequestKind) -> WorkOrder | None:
        while queue:
            _, _, order_id = heapq.heappop(queue)
            order = self.work_orders[order_id]
            if order.status is WorkStatus.QUEUED and order.request_kind is kind:
                return order
        return None

    def _peek_work_exists(self) -> bool:
        return any(order.status in {WorkStatus.QUEUED, WorkStatus.BLOCKED_ON_PART} for order in self.work_orders.values())

    def _dispatch(self) -> None:
        available = sorted((team for team in self.teams.values() if team.state is TeamState.IDLE), key=lambda team: team.team_id)
        for team in available:
            order = self._next_corrective_order()
            if order is None:
                order = self._next_scheduled_order()
            if order is None:
                break
            self._assign_order(team, order)

    def _next_corrective_order(self) -> WorkOrder | None:
        while self._corrective_queue:
            _, _, order_id = heapq.heappop(self._corrective_queue)
            order = self.work_orders[order_id]
            if order.status is WorkStatus.SUPERSEDED:
                continue
            if order.status is WorkStatus.BLOCKED_ON_PART or order.status is not WorkStatus.QUEUED:
                heapq.heappush(self._corrective_queue, (order.requested_at_days, order.enqueue_sequence, order.work_order_id))
                return None
            if self.part_stock <= 0:
                self._block_on_part(order)
                heapq.heappush(self._corrective_queue, (order.requested_at_days, order.enqueue_sequence, order.work_order_id))
                return None
            return order
        return None

    def _next_scheduled_order(self) -> WorkOrder | None:
        while self._scheduled_queue:
            _, _, order_id = heapq.heappop(self._scheduled_queue)
            order = self.work_orders[order_id]
            if order.status is WorkStatus.QUEUED:
                aircraft = self.aircraft[order.aircraft_id]
                if aircraft.state is not AircraftState.OPERATING:
                    heapq.heappush(self._scheduled_queue, (order.requested_at_days, order.enqueue_sequence, order.work_order_id))
                    return None
                if not any(hangar.state is HangarState.FREE for hangar in self.hangars.values()):
                    heapq.heappush(self._scheduled_queue, (order.requested_at_days, order.enqueue_sequence, order.work_order_id))
                    return None
                return order
        return None

    def _block_on_part(self, order: WorkOrder) -> None:
        if order.status is WorkStatus.BLOCKED_ON_PART:
            self._maybe_reorder()
            return
        order.status = WorkStatus.BLOCKED_ON_PART
        aircraft = self.aircraft[order.aircraft_id]
        before = aircraft.state.value
        aircraft.state = AircraftState.GROUNDED_FOR_PART
        self._emit("part_backordered", PHASE_DISPATCH, aircraft_id=aircraft.aircraft_id, work_order_id=order.work_order_id, before_state=before, after_state=aircraft.state.value, payload={"part_id": "part-0001"})
        self._maybe_reorder()

    def _maybe_reorder(self) -> None:
        if self.part_stock + self.part_in_transit <= int(self.parameters["part_reorder_point"]):
            quantity = int(self.parameters["part_order_quantity"])
            self._part_order_sequence += 1
            part_order = PartOrder(
                part_order_id=f"po-{self._part_order_sequence:08d}",
                quantity=quantity,
                ordered_at_days=self.sim_time_days,
                arrival_at_days=self.sim_time_days + float(self.parameters["part_lead_time_days"]),
            )
            self.part_orders[part_order.part_order_id] = part_order
            self.part_in_transit += quantity
            self.part_orders_placed += 1
            eta = part_order.arrival_at_days
            self._emit("part_ordered", PHASE_DISPATCH, part_order_id=part_order.part_order_id, payload={"part_id": "part-0001", "quantity": quantity, "eta_days": eta})
            self._schedule(eta, PHASE_PART_ARRIVAL, "part_arrival", part_order_id=part_order.part_order_id)

    def _assign_order(self, team: MaintenanceTeamAgent, order: WorkOrder) -> None:
        aircraft = self.aircraft[order.aircraft_id]
        order.status = WorkStatus.ASSIGNED
        order.assigned_team_id = team.team_id
        order.assigned_at_days = self.sim_time_days
        team.current_work_order_id = order.work_order_id
        team.state = TeamState.WORKING
        self._emit("team_assigned", PHASE_DISPATCH, aircraft_id=aircraft.aircraft_id, team_id=team.team_id, work_order_id=order.work_order_id, payload={"request_kind": order.request_kind.value})
        if order.request_kind is RequestKind.CORRECTIVE:
            self.part_stock -= 1
            self.parts_consumed += 1
            order.operation_kind = OperationKind.REPAIR
            before = aircraft.state.value
            aircraft.state = AircraftState.GROUNDED_FOR_REPAIR
            self._emit("repair_started", PHASE_DISPATCH, aircraft_id=aircraft.aircraft_id, team_id=team.team_id, work_order_id=order.work_order_id, before_state=before, after_state=aircraft.state.value, payload={"same_crew": False})
            self._record_wait_start(self._open_corrective_waits, self._corrective_waits, order.source_event_id, order.requested_at_days)
            duration = self._duration(OperationKind.REPAIR)
            self._maybe_reorder()
        else:
            order.operation_kind = OperationKind.SCHEDULED_MAINTENANCE
            hangar = next(h for h in self.hangars.values() if h.state is HangarState.FREE)
            hangar.state = HangarState.OCCUPIED
            hangar.current_work_order_id = order.work_order_id
            before = aircraft.state.value
            aircraft.state = AircraftState.GROUNDED_FOR_MAINTENANCE
            aircraft.flight_generation += 1
            self._emit("aircraft_grounded", PHASE_DISPATCH, aircraft_id=aircraft.aircraft_id, before_state=before, after_state=aircraft.state.value)
            self._emit("maintenance_started", PHASE_DISPATCH, aircraft_id=aircraft.aircraft_id, team_id=team.team_id, work_order_id=order.work_order_id, before_state=before, after_state=aircraft.state.value, payload={"same_crew": False})
            self._record_wait_start(self._open_maintenance_waits, self._maintenance_waits, order.source_event_id, order.requested_at_days)
            duration = self._duration(OperationKind.SCHEDULED_MAINTENANCE)
        order.status = WorkStatus.IN_PROGRESS
        order.started_at_days = self.sim_time_days
        self._schedule(self.sim_time_days + duration, PHASE_WORK_COMPLETION, "work_completion", aircraft_id=aircraft.aircraft_id, team_id=team.team_id, work_order_id=order.work_order_id)

    def _duration(self, operation: OperationKind) -> float:
        if operation is OperationKind.REPAIR:
            fixture = self._fixture_repair
            prefix = "repair"
            stream = "repair_duration"
        else:
            fixture = self._fixture_scheduled
            prefix = "scheduled"
            stream = "scheduled_duration"
        if fixture:
            duration = float(fixture.pop(0))
        else:
            low = float(self.parameters[f"{prefix}_low_hours"]) / 24.0
            mode = float(self.parameters[f"{prefix}_mode_hours"]) / 24.0
            high = float(self.parameters[f"{prefix}_high_hours"]) / 24.0
            duration = self._random_streams[stream].triangular(low, high, mode)
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError(f"{prefix} duration must be finite and positive")
        return duration
```

- [ ] **Step 4: Run**. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add mesa_service/src/mesa_service/models/aircraft_support mesa_service/tests/test_aircraft_model.py
git commit -m "feat(aircraft): implement maintenance due, dispatch, team and hangar assignment"
```

### Task 5: Part arrival, work completion, same-crew continuation, operating re-entry

- [ ] **Step 1: Write failing tests** for part arrival unblocking, work completion costs, same-crew continuation, and the microcase main oracle. Add the full microcase test:

```python
def test_microcase_exact_events_daily_snapshots_and_kpis() -> None:
    module = _aircraft_module()
    model = module.AircraftSupportModel(
        parameters=_parameters(),
        horizon_days=4,
        warmup_days=0,
        seed=2,
        scenario_fixture=_microcase_fixture(module),
    )
    events = _run_to_horizon(model)
    mechanism = _mechanism_events(events)
    assert [_event_projection(event) for event in mechanism] == [
        (0.0, "flight_started", "aircraft-0003"),
        (0.0, "flight_started", "aircraft-0002"),
        (0.0, "flight_started", "aircraft-0001"),
        (0.0, "maintenance_due", "aircraft-0001"),
        (0.0, "request_queued", "aircraft-0001"),
        (0.1, "maintenance_due", "aircraft-0002"),
        (0.1, "request_queued", "aircraft-0002"),
        (0.2, "failure_occurred", "aircraft-0003"),
        (0.2, "aircraft_grounded", "aircraft-0003"),
        (0.2, "request_queued", "aircraft-0003"),
        (0.2, "part_backordered", "aircraft-0003"),
        (0.2, "part_ordered", None),
        (0.25, "flight_completed", "aircraft-0001"),
        (0.25, "flight_completed", "aircraft-0002"),
        (0.25, "team_assigned", "aircraft-0001"),
        (0.25, "aircraft_grounded", "aircraft-0001"),
        (0.25, "maintenance_started", "aircraft-0001"),
        (0.5, "maintenance_completed", "aircraft-0001"),
        (0.5, "aircraft_released", "aircraft-0001"),
        (0.5, "team_assigned", "aircraft-0002"),
        (0.5, "aircraft_grounded", "aircraft-0002"),
        (0.5, "maintenance_started", "aircraft-0002"),
        (0.75, "maintenance_completed", "aircraft-0002"),
        (0.75, "aircraft_released", "aircraft-0002"),
        (1.0, "flight_started", "aircraft-0001"),
        (1.0, "flight_started", "aircraft-0002"),
        (1.2, "maintenance_due", "aircraft-0003"),
        (1.2, "request_suppressed", "aircraft-0003"),
        (1.2, "part_received", None),
        (1.2, "team_assigned", "aircraft-0003"),
        (1.2, "repair_started", "aircraft-0003"),
        (1.2, "part_ordered", None),
        (1.25, "flight_completed", "aircraft-0001"),
        (1.25, "flight_completed", "aircraft-0002"),
        (1.7, "repair_completed", "aircraft-0003"),
        (1.7, "maintenance_started", "aircraft-0003"),
        (1.95, "maintenance_completed", "aircraft-0003"),
        (1.95, "aircraft_released", "aircraft-0003"),
        (2.0, "flight_started", "aircraft-0001"),
        (2.0, "flight_started", "aircraft-0002"),
        (2.0, "flight_started", "aircraft-0003"),
        (2.2, "part_received", None),
        (2.25, "flight_completed", "aircraft-0001"),
        (2.25, "flight_completed", "aircraft-0002"),
        (2.25, "flight_completed", "aircraft-0003"),
        (3.0, "flight_started", "aircraft-0001"),
        (3.0, "flight_started", "aircraft-0002"),
        (3.0, "flight_started", "aircraft-0003"),
        (3.25, "flight_completed", "aircraft-0001"),
        (3.25, "flight_completed", "aircraft-0002"),
        (3.25, "flight_completed", "aircraft-0003"),
    ]
    assert [event["sequence"] for event in events] == list(range(1, 57))
    assert len(events) == 56
```

Also add `_microcase_fixture`:

```python
def _microcase_fixture(module):
    return module.ScenarioFixture(
        maintenance_due_times_days={
            "aircraft-0001": [0.0],
            "aircraft-0002": [0.1],
            "aircraft-0003": [1.2],
        },
        failure_times_days={
            "aircraft-0001": [10.0],
            "aircraft-0002": [10.0],
            "aircraft-0003": [0.2, 10.0],
        },
        repair_durations_days=[0.5],
        scheduled_durations_days=[0.25, 0.25, 0.25],
    )
```

- [ ] **Step 2: Run**. Expected: FAIL at the first discrepancy (part arrival / completion not yet implemented).

- [ ] **Step 3: Implement** `_handle_part_arrival`, `_handle_completion`, `_start_same_crew_maintenance`, `_release_resources`, `_enter_operating`, wait helpers, snapshot, and `drain_domain_events` / `export_model_spec`.

```python
    def _handle_part_arrival(self, event: _ScheduledEvent) -> None:
        if event.part_order_id is None:
            raise RuntimeError("part arrival is missing order identity")
        part_order = self.part_orders[event.part_order_id]
        part_order.received = True
        self.part_in_transit -= part_order.quantity
        self.part_stock += part_order.quantity
        self._last_part_stock = float(self.part_stock)
        self._emit("part_received", PHASE_PART_ARRIVAL, part_order_id=part_order.part_order_id, payload={"part_id": "part-0001", "quantity": part_order.quantity, "stock": self.part_stock})
        unblocked = False
        for order in self.work_orders.values():
            if order.status is WorkStatus.BLOCKED_ON_PART:
                order.status = WorkStatus.QUEUED
                aircraft = self.aircraft[order.aircraft_id]
                aircraft.state = AircraftState.GROUNDED_FOR_REPAIR
                unblocked = True
        if unblocked:
            self._ensure_dispatch()

    def _handle_completion(self, work_order_id: str | None) -> None:
        if work_order_id is None:
            raise RuntimeError("completion is missing work order")
        order = self.work_orders[work_order_id]
        if order.status is not WorkStatus.IN_PROGRESS or order.operation_kind is None or order.assigned_team_id is None:
            self.stale_scheduled_event_count += 1
            return
        aircraft = self.aircraft[order.aircraft_id]
        team = self.teams[order.assigned_team_id]
        operation = order.operation_kind
        if operation is OperationKind.REPAIR:
            event_type = "repair_completed"
            cost = float(self.parameters["repair_cost"])
            aircraft.active_corrective_order_id = None
            overdue = aircraft.maintenance_due_at_days <= self.sim_time_days
            turbine_after = AircraftState.GROUNDED_FOR_MAINTENANCE.value if overdue else AircraftState.OPERATING.value
        else:
            event_type = "maintenance_completed"
            cost = float(self.parameters["scheduled_maintenance_cost"])
            aircraft.active_planned_order_id = None
            turbine_after = AircraftState.OPERATING.value
        before = aircraft.state.value
        self._emit(event_type, PHASE_WORK_COMPLETION, aircraft_id=aircraft.aircraft_id, team_id=team.team_id, work_order_id=order.work_order_id, correlation_id=order.correlation_id, before_state=before, after_state=turbine_after, payload={"cost": cost})
        order.status = WorkStatus.COMPLETED
        order.completed_at_days = self.sim_time_days
        if self._in_measurement_completion(self.sim_time_days):
            self._work_cost += cost
            if operation is OperationKind.REPAIR:
                self.repair_count += 1
            else:
                self.maintenance_count += 1

        if operation is OperationKind.REPAIR:
            if aircraft.maintenance_due_at_days <= self.sim_time_days:
                self._start_same_crew_maintenance(aircraft, team, order)
                return
            self._release_resources(aircraft, team, None)
            self._enter_operating(aircraft)
        else:
            self._release_resources(aircraft, team, order)
            aircraft.time_last_maintenance_days = self.sim_time_days
            self._schedule_maintenance_due(aircraft, self._next_due_after_completion(aircraft))
            self._enter_operating(aircraft)

    def _start_same_crew_maintenance(self, aircraft: AircraftAgent, team: MaintenanceTeamAgent, completed_corrective: WorkOrder) -> None:
        free_hangar = next((h for h in self.hangars.values() if h.state is HangarState.FREE), None)
        if free_hangar is None:
            self._release_resources(aircraft, team, None)
            self._new_order(RequestKind.SCHEDULED, aircraft, self.sim_time_days, aircraft.maintenance_due_event_id or "maintenance-due", emit_queued=True)
            self._ensure_dispatch()
            return
        self._work_sequence += 1
        self._queue_sequence += 1
        order = WorkOrder(
            work_order_id=f"work-{self._work_sequence:08d}",
            request_kind=RequestKind.SCHEDULED,
            aircraft_id=aircraft.aircraft_id,
            requested_at_days=aircraft.maintenance_due_at_days,
            source_event_id=aircraft.maintenance_due_event_id or "maintenance-due",
            enqueue_sequence=self._queue_sequence,
            status=WorkStatus.IN_PROGRESS,
            operation_kind=OperationKind.SCHEDULED_MAINTENANCE,
            correlation_id=completed_corrective.work_order_id,
            assigned_team_id=team.team_id,
            assigned_at_days=self.sim_time_days,
            started_at_days=self.sim_time_days,
        )
        self.work_orders[order.work_order_id] = order
        aircraft.active_planned_order_id = order.work_order_id
        free_hangar.state = HangarState.OCCUPIED
        free_hangar.current_work_order_id = order.work_order_id
        team.current_work_order_id = order.work_order_id
        before = aircraft.state.value
        aircraft.state = AircraftState.GROUNDED_FOR_MAINTENANCE
        aircraft.flight_generation += 1
        self._record_wait_start(self._open_maintenance_waits, self._maintenance_waits, order.source_event_id, order.requested_at_days)
        self._emit("maintenance_started", PHASE_WORK_COMPLETION, aircraft_id=aircraft.aircraft_id, team_id=team.team_id, work_order_id=order.work_order_id, correlation_id=completed_corrective.work_order_id, before_state=before, after_state=aircraft.state.value, payload={"same_crew": True})
        self._schedule(self.sim_time_days + self._duration(OperationKind.SCHEDULED_MAINTENANCE), PHASE_WORK_COMPLETION, "work_completion", aircraft_id=aircraft.aircraft_id, team_id=team.team_id, work_order_id=order.work_order_id)

    def _release_resources(self, aircraft: AircraftAgent, team: MaintenanceTeamAgent, completed_order: WorkOrder | None) -> None:
        aircraft.assigned_team_id = None
        team.current_work_order_id = None
        team.state = TeamState.IDLE
        if completed_order is not None:
            hangar = next((h for h in self.hangars.values() if h.current_work_order_id == completed_order.work_order_id), None)
            if hangar is not None:
                hangar.state = HangarState.FREE
                hangar.current_work_order_id = None

    def _enter_operating(self, aircraft: AircraftAgent) -> None:
        before = aircraft.state.value
        if before != AircraftState.OPERATING.value:
            aircraft.state = AircraftState.OPERATING
            self._emit("aircraft_released", PHASE_WORK_COMPLETION, aircraft_id=aircraft.aircraft_id, before_state=before, after_state=aircraft.state.value)
        self._schedule_next_flight(aircraft)
        if self._peek_work_exists():
            self._ensure_dispatch()

    def _next_due_after_completion(self, aircraft: AircraftAgent) -> float:
        scripted = self._fixture_due.get(aircraft.aircraft_id)
        if scripted:
            while scripted and scripted[0] <= self.sim_time_days:
                scripted.pop(0)
            if scripted:
                return float(scripted[0])
        return self.sim_time_days + float(self.parameters["scheduled_maintenance_interval_days"])

    def _in_measurement_origin(self, time_days: float) -> bool:
        return self.warmup_days <= time_days < self.horizon_days

    def _in_measurement_completion(self, time_days: float) -> bool:
        return self.warmup_days <= time_days < self.horizon_days

    def _record_wait_start(self, open_waits: dict[str, float], samples: list[float], source_event_id: str, fallback_origin: float) -> None:
        origin = open_waits.pop(source_event_id, None)
        if origin is None and self._in_measurement_origin(fallback_origin):
            origin = fallback_origin
        if origin is not None and self.sim_time_days <= self.horizon_days:
            samples.append(self.sim_time_days - origin)

    @staticmethod
    def _p95(values: list[float]) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        return ordered[math.ceil(0.95 * len(ordered)) - 1]

    def step(self) -> None:
        if self._day_index >= self.horizon_days:
            raise RuntimeError("model has reached its horizon")
        self._day_index += 1
        self._process_until(float(self._day_index))
        self._emit_daily_snapshot()

    def drain_domain_events(self) -> list[dict[str, Any]]:
        events = self._domain_buffer
        self._domain_buffer = []
        return events

    def export_model_spec(self) -> dict[str, Any]:
        return copy.deepcopy(MODEL_SPEC_DEFINITIONS)
```

- [ ] **Step 4: Run** the microcase test. It will likely fail on ordering/details. Iterate on exact sequencing (LIFO within phases, stale counts, request_suppressed correlation, payload keys) until the full oracle passes. Add the remaining microcase assertions (semantics, snapshots, final KPIs) from the locked design:

```python
    daily = [event for event in events if event["event_type"] == "daily_snapshot"]
    assert [event["sim_time_days"] for event in daily] == [0, 1, 2, 3, 4]
    final = model.snapshot()
    assert final["availability_numerator"] == pytest.approx(9.75)
    assert final["availability_denominator"] == 12
    assert final["availability_fraction"] == pytest.approx(9.75 / 12)
    assert final["operating_aircraft_days"] == pytest.approx(7.05)
    assert final["in_flight_aircraft_days"] == pytest.approx(2.7)
    assert final["grounded_for_part_aircraft_days"] == pytest.approx(1.0)
    assert final["team_working_days"] == pytest.approx(1.25)
    assert final["hangar_occupied_days"] == pytest.approx(0.75)
    assert final["corrective_wait_sample_count"] == 1
    assert final["corrective_wait_mean_days"] == pytest.approx(1.0)
    assert final["maintenance_overdue_sample_count"] == 3
    assert final["maintenance_overdue_mean_days"] == pytest.approx(0.3833333333333333)
    assert final["maintenance_overdue_p95_days"] == pytest.approx(0.5)
    assert final["flight_count"] == 10
    assert final["mission_completion_fraction"] == pytest.approx(10 / 12)
    assert final["failure_count"] == 1
    assert final["repair_count"] == 1
    assert final["maintenance_count"] == 3
    assert final["parts_consumed"] == 1
    assert final["part_orders_placed"] == 2
    assert final["part_stock"] == 3
    assert final["team_cost"] == 40
    assert final["work_cost"] == 220
    assert final["part_procurement_cost"] == 50
    assert final["total_cost"] == 310
    assert final["stale_scheduled_event_count"] == 3
    assert all(math.isfinite(value) for value in final.values() if isinstance(value, (int, float)))
```

- [ ] **Step 5: Implement `snapshot()`** to satisfy the metric schema exactly (see Task 6 for the schema; write the full key set now):

```python
    def snapshot(self) -> dict[str, int | float]:
        elapsed = max(0.0, min(self.sim_time_days, float(self.horizon_days)) - float(self.warmup_days))
        operating_days = self._aircraft_state_days[AircraftState.OPERATING]
        in_flight_days = self._aircraft_state_days[AircraftState.IN_FLIGHT]
        grounded_repair = self._aircraft_state_days[AircraftState.GROUNDED_FOR_REPAIR]
        grounded_maint = self._aircraft_state_days[AircraftState.GROUNDED_FOR_MAINTENANCE]
        grounded_part = self._aircraft_state_days[AircraftState.GROUNDED_FOR_PART]
        availability_numerator = operating_days + in_flight_days
        availability_denominator = int(self.parameters["aircraft_count"]) * elapsed
        team_working = self._team_state_days[TeamState.WORKING]
        team_utilization_numerator = team_working
        team_utilization_denominator = int(self.parameters["team_count"]) * elapsed
        hangar_occupied = self._hangar_state_days[HangarState.OCCUPIED]
        hangar_utilization_numerator = hangar_occupied
        hangar_utilization_denominator = int(self.parameters["hangar_count"]) * elapsed
        availability = availability_numerator / availability_denominator if availability_denominator else 1.0
        team_utilization = team_utilization_numerator / team_utilization_denominator if team_utilization_denominator else 0.0
        hangar_utilization = hangar_utilization_numerator / hangar_utilization_denominator if hangar_utilization_denominator else 0.0
        team_cost = int(self.parameters["team_count"]) * float(self.parameters["team_cost_per_day"]) * elapsed
        aircraft_counts = {state: sum(a.state is state for a in self.aircraft.values()) for state in AircraftState}
        team_counts = {state: sum(t.state is state for t in self.teams.values()) for state in TeamState}
        hangar_counts = {state: sum(h.state is state for h in self.hangars.values()) for state in HangarState}
        corrective_queue = sum(o.status in {WorkStatus.QUEUED, WorkStatus.BLOCKED_ON_PART} and o.request_kind is RequestKind.CORRECTIVE for o in self.work_orders.values())
        scheduled_queue = sum(o.status is WorkStatus.QUEUED and o.request_kind is RequestKind.SCHEDULED for o in self.work_orders.values())
        mission_required = int(self.parameters["aircraft_count"]) * int(self.parameters["missions_per_day"]) * elapsed
        part_procurement = float(self.parameters["part_unit_cost"]) * self.parts_consumed
        aog_penalty = float(self.parameters["aog_penalty_per_day"]) * grounded_part
        holding_cost = float(self.parameters["part_holding_cost_per_day"]) * self._part_stock_days
        return {
            "sim_time_days": self.sim_time_days,
            "aircraft_count": int(self.parameters["aircraft_count"]),
            "team_count": int(self.parameters["team_count"]),
            "hangar_count": int(self.parameters["hangar_count"]),
            "operating_count": aircraft_counts[AircraftState.OPERATING],
            "in_flight_count": aircraft_counts[AircraftState.IN_FLIGHT],
            "grounded_for_repair_count": aircraft_counts[AircraftState.GROUNDED_FOR_REPAIR],
            "grounded_for_maintenance_count": aircraft_counts[AircraftState.GROUNDED_FOR_MAINTENANCE],
            "grounded_for_part_count": aircraft_counts[AircraftState.GROUNDED_FOR_PART],
            "idle_team_count": team_counts[TeamState.IDLE],
            "working_team_count": team_counts[TeamState.WORKING],
            "free_hangar_count": hangar_counts[HangarState.FREE],
            "occupied_hangar_count": hangar_counts[HangarState.OCCUPIED],
            "corrective_queue_length": corrective_queue,
            "scheduled_queue_length": scheduled_queue,
            "part_stock": self.part_stock,
            "part_orders_in_transit": self.part_in_transit,
            "operating_aircraft_days": operating_days,
            "in_flight_aircraft_days": in_flight_days,
            "grounded_for_repair_aircraft_days": grounded_repair,
            "grounded_for_maintenance_aircraft_days": grounded_maint,
            "grounded_for_part_aircraft_days": grounded_part,
            "availability_numerator": availability_numerator,
            "availability_denominator": availability_denominator,
            "availability_fraction": availability,
            "team_utilization_numerator": team_utilization_numerator,
            "team_utilization_denominator": team_utilization_denominator,
            "team_utilization_fraction": team_utilization,
            "hangar_utilization_numerator": hangar_utilization_numerator,
            "hangar_utilization_denominator": hangar_utilization_denominator,
            "hangar_utilization_fraction": hangar_utilization,
            "measurement_window_elapsed_days": elapsed,
            "measurement_window_observed": int(elapsed > 0),
            "corrective_wait_sample_count": len(self._corrective_waits),
            "corrective_wait_censored_count": len(self._open_corrective_waits),
            "corrective_wait_mean_days": sum(self._corrective_waits) / len(self._corrective_waits) if self._corrective_waits else 0.0,
            "corrective_wait_p95_days": self._p95(self._corrective_waits),
            "maintenance_overdue_sample_count": len(self._maintenance_waits),
            "maintenance_overdue_censored_count": len(self._open_maintenance_waits),
            "maintenance_overdue_mean_days": sum(self._maintenance_waits) / len(self._maintenance_waits) if self._maintenance_waits else 0.0,
            "maintenance_overdue_p95_days": self._p95(self._maintenance_waits),
            "flight_count": self.flight_count,
            "mission_required": int(mission_required),
            "mission_completion_fraction": self.flight_count / mission_required if mission_required else 0.0,
            "failure_count": self.failure_count,
            "repair_count": self.repair_count,
            "maintenance_count": self.maintenance_count,
            "parts_consumed": self.parts_consumed,
            "part_orders_placed": self.part_orders_placed,
            "failure_delay_sample_count": self.failure_delay_sample_count,
            "stale_scheduled_event_count": self.stale_scheduled_event_count,
            "processed_scheduled_event_count": self.processed_scheduled_event_count,
            "pending_scheduled_event_count": len(self._scheduled),
            "team_cost": team_cost,
            "work_cost": self._work_cost,
            "part_procurement_cost": part_procurement,
            "aog_penalty_cost": aog_penalty,
            "part_holding_cost": holding_cost,
            "total_cost": team_cost + self._work_cost + part_procurement + aog_penalty + holding_cost,
            "operating_revenue": operating_days * float(self.parameters["daily_revenue_per_operating_aircraft"]),
        }
```

- [ ] **Step 6: Run** the full microcase test. Expected: PASS.
- [ ] **Step 7: Run** the whole file: `uv run --project mesa_service pytest tests/test_aircraft_model.py -q`. Expected: all PASS.

- [ ] **Step 8: Commit**
```bash
git add mesa_service/src/mesa_service/models/aircraft_support mesa_service/tests/test_aircraft_model.py
git commit -m "feat(aircraft): implement part arrival, completion, same-crew continuation, metrics"
```

### Task 6: Model assets (schemas, provenance, defaults, microcase fixture)

- [ ] **Step 1: Write failing test** asserting the exported spec matches the asset and the snapshot matches the metric schema:

```python
def test_snapshot_exactly_matches_metric_schema() -> None:
    module = _aircraft_module()
    import json
    from pathlib import Path
    asset = Path(__file__).resolve().parents[1] / "src" / "mesa_service" / "model_assets" / "aircraft_support" / "metric-schema.json"
    metric_schema = json.loads(asset.read_text())
    model = module.AircraftSupportModel(parameters=_parameters(), horizon_days=1, warmup_days=0, seed=2, scenario_fixture=_microcase_fixture(module))
    _run_to_horizon(model)
    snapshot = model.snapshot()
    assert set(metric_schema["required"]) == set(metric_schema["properties"]) == set(snapshot)
    assert metric_schema["additionalProperties"] is False
```

- [ ] **Step 2: Run**. Expected: FAIL (asset file missing).

- [ ] **Step 3: Create** the asset files (complete content below). The metric-schema `required` list must exactly equal the snapshot key set from Task 5, and the parameter-schema `required` list must exactly equal `PARAMETER_IDS`.

`model-spec.json` — must equal `MODEL_SPEC_DEFINITIONS` (exported, not hand-copied):

```bash
cd mesa_service && uv run --project . python - <<'PY'
import json, sys
sys.path.insert(0, "src")
from mesa_service.models.aircraft_support.model import MODEL_SPEC_DEFINITIONS
out = "src/mesa_service/model_assets/aircraft_support/model-spec.json"
import pathlib
pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)
pathlib.Path(out).write_text(json.dumps(MODEL_SPEC_DEFINITIONS, indent=2, ensure_ascii=False) + "\n")
print("wrote", out)
PY
```

`parameter-schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "riff://aircraft-support/parameter-schema/v1",
  "title": "Aircraft maintenance & logistics support parameters",
  "type": "object",
  "additionalProperties": false,
  "required": ["aircraft_count", "team_count", "hangar_count", "missions_per_day", "mission_flying_hours", "failure_rate_per_flying_hour", "scheduled_maintenance_interval_days", "repair_low_hours", "repair_mode_hours", "repair_high_hours", "scheduled_low_hours", "scheduled_mode_hours", "scheduled_high_hours", "part_initial_stock", "part_reorder_point", "part_order_quantity", "part_lead_time_days", "part_unit_cost", "part_holding_cost_per_day", "team_cost_per_day", "repair_cost", "scheduled_maintenance_cost", "aog_penalty_per_day", "daily_revenue_per_operating_aircraft", "minimum_availability_fraction"],
  "properties": {
    "aircraft_count": {"type": "integer", "minimum": 1, "maximum": 100, "unit": "count"},
    "team_count": {"type": "integer", "minimum": 1, "maximum": 20, "unit": "count"},
    "hangar_count": {"type": "integer", "minimum": 1, "maximum": 20, "unit": "count"},
    "missions_per_day": {"type": "integer", "minimum": 1, "maximum": 10, "unit": "missions/day"},
    "mission_flying_hours": {"type": "number", "minimum": 0.01, "maximum": 24, "unit": "hour"},
    "failure_rate_per_flying_hour": {"type": "number", "minimum": 0.000001, "maximum": 1, "unit": "1/flying-hour"},
    "scheduled_maintenance_interval_days": {"type": "number", "minimum": 1, "maximum": 3650, "unit": "day"},
    "repair_low_hours": {"type": "number", "minimum": 0.01, "maximum": 720, "unit": "hour"},
    "repair_mode_hours": {"type": "number", "minimum": 0.01, "maximum": 720, "unit": "hour"},
    "repair_high_hours": {"type": "number", "minimum": 0.01, "maximum": 720, "unit": "hour"},
    "scheduled_low_hours": {"type": "number", "minimum": 0.01, "maximum": 720, "unit": "hour"},
    "scheduled_mode_hours": {"type": "number", "minimum": 0.01, "maximum": 720, "unit": "hour"},
    "scheduled_high_hours": {"type": "number", "minimum": 0.01, "maximum": 720, "unit": "hour"},
    "part_initial_stock": {"type": "integer", "minimum": 0, "maximum": 100000, "unit": "unit"},
    "part_reorder_point": {"type": "integer", "minimum": 0, "maximum": 100000, "unit": "unit"},
    "part_order_quantity": {"type": "integer", "minimum": 1, "maximum": 100000, "unit": "unit"},
    "part_lead_time_days": {"type": "number", "minimum": 0.01, "maximum": 365, "unit": "day"},
    "part_unit_cost": {"type": "number", "minimum": 0, "maximum": 1000000000, "unit": "synthetic_currency/unit"},
    "part_holding_cost_per_day": {"type": "number", "minimum": 0, "maximum": 1000000000, "unit": "synthetic_currency/unit/day"},
    "team_cost_per_day": {"type": "number", "minimum": 0, "maximum": 1000000000, "unit": "synthetic_currency/day"},
    "repair_cost": {"type": "number", "minimum": 0, "maximum": 1000000000, "unit": "synthetic_currency/operation"},
    "scheduled_maintenance_cost": {"type": "number", "minimum": 0, "maximum": 1000000000, "unit": "synthetic_currency/operation"},
    "aog_penalty_per_day": {"type": "number", "minimum": 0, "maximum": 1000000000, "unit": "synthetic_currency/day"},
    "daily_revenue_per_operating_aircraft": {"type": "number", "minimum": 0, "maximum": 1000000000, "unit": "synthetic_currency/day"},
    "minimum_availability_fraction": {"type": "number", "minimum": 0, "maximum": 1, "unit": "fraction"}
  }
}
```

`metric-schema.json` — required/properties lists must exactly match the snapshot keys from Task 5. See the locked design metric list.

`provenance.json`:

```json
{
  "source": {
    "name": "verbal/experience aircraft maintenance & logistics description",
    "reference_document": "docs/domain-brief-aircraft-support.md",
    "quantified_values": false,
    "time_unit": "day"
  },
  "conversion_kind": "synthetic_self_contained_model",
  "copied_source_code": false,
  "input_provenance": {
    "all_parameters": "source_seeded_synthetic_assumption",
    "verbal_parameter_values": "open_not_yet_quantified"
  },
  "claim_boundary": ["not_calibrated", "not_real_fleet_validation", "not_decision_ready", "synthetic_inputs_only"]
}
```

`traceability.json` — domain-brief rule → model rule mapping:

```json
{
  "source_document": "docs/domain-brief-aircraft-support.md",
  "rule_transitions": [
    {"source_rule": "daily flight task drives flying hours", "target_rule": "daily_mission_block", "disposition": "adapted", "reason": "One mission block per operating aircraft per day; missions_per_day reserved as v1 aggregation."},
    {"source_rule": "failures occur only while flying; risk scales with flying hours", "target_rule": "per_flight_failure_sampling", "disposition": "adapted", "reason": "Failure sampled once per flight on flight entry with rate per flying hour."},
    {"source_rule": "scheduled maintenance is interval-based on the ground", "target_rule": "maintenance_due_trigger", "disposition": "adapted", "reason": "Aircraft remains mission-capable while overdue; grounds only when scheduled work starts."},
    {"source_rule": "maintenance teams and hangar slots bound work", "target_rule": "team_and_hangar_resource", "disposition": "adapted", "reason": "Scheduled work needs a team and a free hangar; corrective repair needs a team and a part."},
    {"source_rule": "part shortage causes AOG ground time", "target_rule": "blocked_on_part_and_grounded_for_part", "disposition": "adapted", "reason": "Corrective order blocked while stock is zero; aircraft grounded until part arrival."},
    {"source_rule": "reorder-point/order-quantity policy with fixed lead time", "target_rule": "maybe_reorder", "disposition": "adapted", "reason": "Order placed when stock plus in-transit is at or below the reorder point."},
    {"source_rule": "corrective preempts scheduled at assignment", "target_rule": "corrective_priority_dispatch", "disposition": "adapted", "reason": "Dispatch pops corrective before scheduled; FIFO within each queue."}
  ],
  "simultaneous_event_rule": {
    "source": "unspecified",
    "target": "business_phase_then_lifo",
    "disposition": "adapted",
    "reason": "All same-time request triggers are visible before a free team is assigned."
  },
  "excluded_mechanisms": ["multi_echelon_supply_chain", "multiple_aircraft_types", "crew_certification", "shift_calendars", "predictive_maintenance", "flight_scheduling_optimization"]
}
```

`visualization.json`:

```json
{
  "schema_version": 1,
  "model_id": "aircraft-support",
  "entity_state_view": {"source": "model-spec.json", "entity_ids": ["aircraft", "maintenance_team", "hangar_slot", "part_type", "work_order"]},
  "process_swimlane_view": {"source": "domain-events.jsonl", "lanes": ["aircraft", "queue", "team", "parts"], "event_vocabulary_source": "model-spec.json"},
  "parts_policy_view": {"source": "parameter-schema.json", "policy": "reorder_point_order_quantity"},
  "replay": {"authoritative_source": "domain-events.jsonl", "frame_sampling_allowed": true, "event_omission_from_source_allowed": false}
}
```

`defaults/aircraft-support-demo-v1.json`:

```json
{
  "preset_id": "aircraft-support-demo-v1",
  "executable": true,
  "parameters": {"aircraft_count": 20, "team_count": 3, "hangar_count": 3, "missions_per_day": 2, "mission_flying_hours": 6, "failure_rate_per_flying_hour": 0.0001, "scheduled_maintenance_interval_days": 90, "repair_low_hours": 2.5, "repair_mode_hours": 5, "repair_high_hours": 12.5, "scheduled_low_hours": 1.5, "scheduled_mode_hours": 3, "scheduled_high_hours": 4.5, "part_initial_stock": 8, "part_reorder_point": 4, "part_order_quantity": 12, "part_lead_time_days": 7, "part_unit_cost": 5000, "part_holding_cost_per_day": 2, "team_cost_per_day": 1000, "repair_cost": 2000, "scheduled_maintenance_cost": 1200, "aog_penalty_per_day": 1500, "daily_revenue_per_operating_aircraft": 600, "minimum_availability_fraction": 0.95},
  "parameter_provenance": {"aircraft_count": "source_seeded_synthetic_assumption", "team_count": "source_seeded_synthetic_assumption", "hangar_count": "synthetic_assumption", "missions_per_day": "synthetic_assumption", "mission_flying_hours": "source_seeded_synthetic_assumption", "failure_rate_per_flying_hour": "source_seeded_synthetic_assumption", "scheduled_maintenance_interval_days": "source_seeded_synthetic_assumption", "repair_low_hours": "synthetic_assumption", "repair_mode_hours": "synthetic_assumption", "repair_high_hours": "synthetic_assumption", "scheduled_low_hours": "synthetic_assumption", "scheduled_mode_hours": "synthetic_assumption", "scheduled_high_hours": "synthetic_assumption", "part_initial_stock": "synthetic_assumption", "part_reorder_point": "synthetic_assumption", "part_order_quantity": "synthetic_assumption", "part_lead_time_days": "synthetic_assumption", "part_unit_cost": "synthetic_assumption", "part_holding_cost_per_day": "synthetic_assumption", "team_cost_per_day": "synthetic_assumption", "repair_cost": "synthetic_assumption", "scheduled_maintenance_cost": "synthetic_assumption", "aog_penalty_per_day": "synthetic_assumption", "daily_revenue_per_operating_aircraft": "synthetic_assumption", "minimum_availability_fraction": "user_declared_demo_target"},
  "horizon_days": 1095,
  "warmup_days": 365,
  "seed": 2,
  "claim_labels": ["synthetic_inputs", "single_seed", "draft_unverified", "no_calibration", "no_recommendation"]
}
```

`tests/microcase.json`:

```json
{
  "fixture_id": "three-aircraft-maintenance-logistics-microcase-v1",
  "uses_production_model": true,
  "horizon_days": 4,
  "warmup_days": 0,
  "seed": 2,
  "parameters": {"aircraft_count": 3, "team_count": 1, "hangar_count": 1, "missions_per_day": 1, "mission_flying_hours": 6, "repair_cost": 100, "scheduled_maintenance_cost": 40, "team_cost_per_day": 10, "part_initial_stock": 0, "part_reorder_point": 1, "part_order_quantity": 2, "part_lead_time_days": 1.0, "part_unit_cost": 50},
  "maintenance_due_times_days": {"aircraft-0001": [0], "aircraft-0002": [0.1], "aircraft-0003": [1.2]},
  "failure_times_days": {"aircraft-0001": [10], "aircraft-0002": [10], "aircraft-0003": [0.2, 10]},
  "durations_days": {"repair": [0.5], "scheduled": [0.25, 0.25, 0.25]},
  "oracle": {"event_count_excluding_daily_snapshots": 51, "daily_snapshot_count": 5, "availability_numerator": 9.75, "availability_denominator": 12, "team_working_days": 1.25, "hangar_occupied_days": 0.75, "total_cost": 310, "stale_scheduled_event_count": 3}
}
```

- [ ] **Step 4: Run** the schema-matching test. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add mesa_service/src/mesa_service/model_assets/aircraft_support mesa_service/tests/test_aircraft_model.py
git commit -m "feat(aircraft): add model assets, schemas, provenance, defaults, microcase fixture"
```

### Task 7: Package exports and full-suite verification

- [ ] **Step 1: Write failing test** for the package-level export.

```python
def test_package_exports() -> None:
    package = importlib.import_module("mesa_service.models.aircraft_support")
    assert package.AircraftSupportModel is not None
    assert package.ScenarioFixture is not None
    assert package.MODEL_SPEC_DEFINITIONS["model_id"] == "aircraft-support"
```

- [ ] **Step 2: Implement** `aircraft_support/__init__.py`:

```python
"""Aircraft maintenance & logistics support Mesa model (core layer)."""

from .model import (
    MODEL_SPEC_DEFINITIONS,
    AircraftSupportModel,
    AircraftAgent,
    MaintenanceTeamAgent,
    HangarSlot,
    ScenarioFixture,
    WorkOrder,
)

__all__ = [
    "MODEL_SPEC_DEFINITIONS",
    "AircraftSupportModel",
    "AircraftAgent",
    "MaintenanceTeamAgent",
    "HangarSlot",
    "ScenarioFixture",
    "WorkOrder",
]
```

- [ ] **Step 3: Update** `mesa_service/src/mesa_service/models/__init__.py` to register the aircraft model:

```python
"""Bundled, reviewed Mesa models."""

from .aircraft_support import AircraftSupportModel
from .wind_turbine_maintenance import WindTurbineMaintenanceModel

__all__ = ["AircraftSupportModel", "WindTurbineMaintenanceModel"]
```

- [ ] **Step 4: Run** the package-export test. Expected: PASS.
- [ ] **Step 5: Run** the entire aircraft + wind model test suites:
```bash
uv run --project mesa_service pytest tests/test_aircraft_model.py tests/test_wind_model.py -q
```
Expected: all PASS, no regressions.

- [ ] **Step 6: Commit**
```bash
git add mesa_service/src/mesa_service/models/aircraft_support mesa_service/src/mesa_service/models/__init__.py mesa_service/tests/test_aircraft_model.py
git commit -m "feat(aircraft): export aircraft-support model from the models package"
```

---

## Self-review

**Spec coverage:**
- Daily missions → flying hours → failures → repair (Task 3/5), scheduled maintenance due (Task 4), team/hangar resources (Task 4), parts + AOG + reorder (Task 5), same-crew continuation (Task 5), KPIs/metrics (Task 5), assets (Task 6), exports (Task 7).
- Domain brief sections covered: decision scope (locked design), evidence/provenance (Task 6), ontology (Task 1/2), inputs/distributions/streams (Task 2/3), outputs/experiment plan (Task 5/6), validation microcase (Task 5/6), claim boundary (Task 6).

**Placeholder scan:** no TODOs remain; every task has complete code.

**Type consistency:** `part_stock`, `part_in_transit`, `_maybe_reorder`, `_block_on_part`, `_next_due_after_completion`, `_release_resources` names are consistent across tasks. Event schema keys are uniform (`aircraft_id`, `team_id`, `work_order_id`, `part_order_id`, `correlation_id`, `before_state`, `after_state`, `payload`).

**Risk note for executor:** the microcase exact ordering (LIFO within phases, stale flight invalidation at grounding, part `stock` payload on `part_received`, `request_suppressed` correlation) is the most likely place for a first-run mismatch. Debug against the locked oracle in this plan; do not change the oracle to fit a buggy implementation.
