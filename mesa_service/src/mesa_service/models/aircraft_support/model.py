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
        if values["part_reorder_point"] < 0:
            raise ValueError("part_reorder_point must be non-negative")
        if values["part_initial_stock"] < 0:
            raise ValueError("part_initial_stock must be non-negative")
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

    def _peek_work_exists(self) -> bool:
        return any(order.status in {WorkStatus.QUEUED, WorkStatus.BLOCKED_ON_PART} for order in self.work_orders.values())

    def _dispatch(self) -> None:
        pass

    def _handle_maintenance_due(self, event: _ScheduledEvent) -> None:
        return None

    def _handle_part_arrival(self, event: _ScheduledEvent) -> None:
        return None

    def _handle_completion(self, work_order_id: str | None) -> None:
        return None

    def _in_measurement_origin(self, time_days: float) -> bool:
        return self.warmup_days <= time_days < self.horizon_days

    def _emit(self, event_type: str, phase: int, *, aircraft_id: str | None = None, team_id: str | None = None, work_order_id: str | None = None, part_order_id: str | None = None, correlation_id: str | None = None, before_state: str | None = None, after_state: str | None = None, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
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
            "part_order_id": part_order_id,
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

    def step(self) -> None:
        if self._day_index >= self.horizon_days:
            raise RuntimeError("model has reached its horizon")
        self._day_index += 1
        self._process_until(float(self._day_index))
        self._emit_daily_snapshot()

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

    @staticmethod
    def _p95(values: list[float]) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        return ordered[math.ceil(0.95 * len(ordered)) - 1]

    def drain_domain_events(self) -> list[dict[str, Any]]:
        events = self._domain_buffer
        self._domain_buffer = []
        return events

    def export_model_spec(self) -> dict[str, Any]:
        return copy.deepcopy(MODEL_SPEC_DEFINITIONS)
