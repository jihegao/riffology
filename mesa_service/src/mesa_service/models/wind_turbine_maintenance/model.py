"""Reviewed Mesa wind-turbine maintenance behavioural reproduction.

The AnyLogic Field Service example is structural evidence only.  This module
implements the approved synthetic, single-seed Gate 1 mechanism and deliberately
does not claim runtime or numerical equivalence with AnyLogic.
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


MODEL_ID = "wind-turbine-maintenance"
MODEL_CLASS = "WindTurbineMaintenanceModel"
MODEL_PROTOCOL_VERSION = "wind-turbine-maintenance-v1"

PHASE_REQUEST_TRIGGER = 10
PHASE_WORK_COMPLETION = 20
PHASE_ARRIVAL_OR_RETURN = 30
PHASE_DISPATCH = 40
PHASE_DAILY_SNAPSHOT = 50

DOMAIN_EVENT_TYPES = [
    "failure_occurred",
    "maintenance_due",
    "request_queued",
    "request_superseded",
    "request_suppressed",
    "crew_dispatched",
    "crew_arrived",
    "repair_started",
    "repair_completed",
    "maintenance_started",
    "maintenance_completed",
    "replacement_started",
    "replacement_completed",
    "crew_return_started",
    "crew_returned",
    "daily_snapshot",
]

PARAMETER_IDS = [
    "turbine_count",
    "crew_count",
    "maintenance_period_days",
    "normal_failure_rate_per_day",
    "repair_low_hours",
    "repair_mode_hours",
    "repair_high_hours",
    "maintenance_low_hours",
    "maintenance_mode_hours",
    "maintenance_high_hours",
    "replacement_low_hours",
    "replacement_mode_hours",
    "replacement_high_hours",
    "major_replacement_enabled",
    "major_replacement_probability",
    "farm_width_km",
    "farm_height_km",
    "depot_x_km",
    "depot_y_km",
    "crew_speed_km_per_hour",
    "daily_revenue_per_operating_turbine",
    "crew_cost_per_day",
    "repair_cost",
    "maintenance_cost",
    "replacement_cost",
    "minimum_availability_fraction",
]

MODEL_SPEC_DEFINITIONS: dict[str, Any] = {
    "model_id": MODEL_ID,
    "model_class": MODEL_CLASS,
    "model_protocol_version": MODEL_PROTOCOL_VERSION,
    "time_unit": "day",
    "public_step": "next_natural_day_boundary",
    "entities": {
        "turbine": {
            "class": "WindTurbineAgent",
            "id_pattern": "turbine-%04d",
            "states": ["operating", "failed_waiting", "corrective_repair", "planned_maintenance", "major_replacement"],
        },
        "crew": {
            "class": "MaintenanceCrewAgent",
            "id_pattern": "crew-%03d",
            "states": ["idle", "driving_to_work", "working", "driving_home"],
        },
        "work_order": {
            "id_pattern": "work-%08d",
            "request_kinds": ["corrective", "planned"],
            "operation_kinds": ["repair", "maintenance", "replacement"],
            "statuses": ["queued", "assigned", "in_progress", "completed", "superseded"],
        },
    },
    "event_ordering": {
        "heap_key": ["sim_time_days", "phase", "negative_schedule_sequence"],
        "phase_values": {
            "request_trigger": 10,
            "work_completion": 20,
            "arrival_or_return": 30,
            "dispatch": 40,
            "daily_snapshot": 50,
        },
        "same_phase_tie_break": "lifo",
        "crew_assignment_tie_break": "ascending_crew_id",
    },
    "queue_policy": {
        "priority": ["corrective", "planned"],
        "within_priority": "fifo",
        "dispatch": "centralized_non_preemptive",
    },
    "distribution_families": {
        "failure": "exponential",
        "repair": "triangular",
        "maintenance": "triangular",
        "replacement": "triangular",
    },
    "failure_semantics": {
        "sampling": "once_on_operating_entry",
        "overdue_factor": "max(1,(now-time_last_maintenance_days)/maintenance_period_days)",
        "age_factor": "max(1,(now-time_last_replacement_days)/(3*maintenance_period_days))",
        "rate": "normal_failure_rate_per_day*overdue_factor*age_factor",
    },
    "named_random_streams": [
        "layout",
        "initial_maintenance",
        "failure",
        "repair_duration",
        "maintenance_duration",
        "replacement_decision",
        "replacement_duration",
    ],
    "proactive_age_replacement": "excluded",
    "required_domain_events": DOMAIN_EVENT_TYPES,
    "measurement_window": "half_open_warmup_to_horizon",
    "p95_method": "nearest_rank",
    "claim_scope": "synthetic_single_seed_behavioral_reproduction",
}

SOURCE_TRANSITION_DISPOSITIONS: dict[str, Any] = {
    "source_model": "AnyLogic Field Service",
    "source_sha256": "2153fbf23348ece013f7d72bf0064e5d01ac52273bebf560520bb35047734755",
    "equipment_transitions": [
        {"source_transition": "Failure", "target_rule": "failure_triggered", "disposition": "adapted", "reason": "Creates one corrective order and supersedes queued planned work."},
        {"source_transition": "SCArrivedForRepair", "target_rule": "crew_arrived_then_corrective_work_selected", "disposition": "adapted", "reason": "The replacement decision is drawn once after crew arrival."},
        {"source_transition": "FinishRepair", "target_rule": "corrective_repair_completed", "disposition": "adapted", "reason": "Completion may continue overdue maintenance with the same crew."},
        {"source_transition": "StartReplacement", "target_rule": "corrective_work_selected", "disposition": "adapted", "reason": "Only the unrepairable-failure branch is retained."},
        {"source_transition": "FinishReplacement", "target_rule": "major_replacement_completed", "disposition": "adapted", "reason": "Replacement resets replacement and maintenance timestamps."},
        {"source_transition": "FinishMaintenance", "target_rule": "planned_maintenance_completed", "disposition": "adapted", "reason": "Completion reschedules the maintenance due event."},
        {"source_transition": "SCArrivedForMtce", "target_rule": "crew_arrived_then_planned_maintenance_started", "disposition": "adapted", "reason": "Arrival and operation start remain separately observable events."},
        {"source_transition": "StartRepair", "target_rule": "corrective_work_selected", "disposition": "combined", "reason": "A corrective work order selects repair or replacement without changing identity."},
        {"source_transition": "transition", "target_rule": "corrective_repair_completed_direct_operating", "disposition": "combined", "reason": "The direct branch is selected when maintenance is not overdue."},
        {"source_transition": "MaintenanceDue", "target_rule": "corrective_repair_completed_same_crew_maintenance", "disposition": "combined", "reason": "The overdue branch starts maintenance with the same crew."},
        {"source_transition": "PlannedReplacement", "target_rule": None, "disposition": "deferred", "reason": "Proactive age replacement is fixed off in Phase 1."},
        {"source_transition": "StartMaintenance", "target_rule": "planned_maintenance_started", "disposition": "adapted", "reason": "Planned and same-crew maintenance use one rule."},
    ],
    "crew_transitions": [
        {"source_transition": "CheckRequestQueue", "target_rule": "centralized_dispatch", "disposition": "adapted", "reason": "Dispatch is deduplicated once per timestamp."},
        {"source_transition": "Arrived", "target_rule": "crew_arrived", "disposition": "adapted", "reason": "Arrival selects and starts exactly one operation."},
        {"source_transition": "Finished", "target_rule": "work_completion_then_dispatch", "disposition": "adapted", "reason": "Completion exposes all same-time triggers before dispatch."},
        {"source_transition": "ArrivedHome", "target_rule": "crew_returned", "disposition": "adapted", "reason": "Returned crews become depot-idle before later dispatch."},
        {"source_transition": "RequestsWaiting", "target_rule": "centralized_dispatch_assign", "disposition": "adapted", "reason": "Corrective priority and FIFO queues are explicit."},
        {"source_transition": "NoRequests", "target_rule": "crew_return_started", "disposition": "adapted", "reason": "Away crews return only when both queues are empty."},
        {"source_transition": "IAmOK", "target_rule": "configured_population_post_work_dispatch", "disposition": "adapted", "reason": "Crew population is frozen at run start."},
        {"source_transition": "IAmLaidOff", "target_rule": None, "disposition": "deferred", "reason": "Mid-run workforce resizing is outside Phase 1."},
        {"source_transition": "CheckIfLaidOff", "target_rule": None, "disposition": "deferred", "reason": "Crew count is immutable in an experiment revision."},
    ],
    "simultaneous_event_rule": {
        "source": "global_lifo",
        "target": "business_phase_then_lifo",
        "disposition": "adapted",
        "reason": "All corrective and planned request triggers at one time are visible before a free crew is assigned, preserving corrective priority.",
    },
    "excluded_mechanisms": [
        "proactive_age_replacement",
        "mid_run_hiring",
        "mid_run_layoff",
        "road_gis",
        "weather_access",
        "spare_parts",
        "crew_skills",
    ],
}


class TurbineState(str, Enum):
    OPERATING = "operating"
    FAILED_WAITING = "failed_waiting"
    CORRECTIVE_REPAIR = "corrective_repair"
    PLANNED_MAINTENANCE = "planned_maintenance"
    MAJOR_REPLACEMENT = "major_replacement"


class CrewState(str, Enum):
    IDLE = "idle"
    DRIVING_TO_WORK = "driving_to_work"
    WORKING = "working"
    DRIVING_HOME = "driving_home"


class RequestKind(str, Enum):
    CORRECTIVE = "corrective"
    PLANNED = "planned"


class OperationKind(str, Enum):
    REPAIR = "repair"
    MAINTENANCE = "maintenance"
    REPLACEMENT = "replacement"


class WorkStatus(str, Enum):
    QUEUED = "queued"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    SUPERSEDED = "superseded"


@dataclass
class ScenarioFixture:
    """Private deterministic draw seam used by hand-oracle tests."""

    positions_km: Mapping[str, tuple[float, float]] = field(default_factory=dict)
    maintenance_due_times_days: Mapping[str, list[float]] = field(default_factory=dict)
    failure_times_days: Mapping[str, list[float]] = field(default_factory=dict)
    repair_durations_days: list[float] = field(default_factory=list)
    maintenance_durations_days: list[float] = field(default_factory=list)
    replacement_durations_days: list[float] = field(default_factory=list)
    replacement_decisions: list[bool] = field(default_factory=list)


@dataclass
class WorkOrder:
    work_order_id: str
    request_kind: RequestKind
    turbine_id: str
    requested_at_days: float
    source_event_id: str
    enqueue_sequence: int
    status: WorkStatus = WorkStatus.QUEUED
    operation_kind: OperationKind | None = None
    correlation_id: str | None = None
    assigned_crew_id: str | None = None
    assigned_at_days: float | None = None
    started_at_days: float | None = None
    completed_at_days: float | None = None
    superseded_by_order_id: str | None = None


@dataclass(frozen=True)
class _ScheduledEvent:
    sim_time_days: float
    phase: int
    schedule_sequence: int
    event_type: str
    turbine_id: str | None = None
    crew_id: str | None = None
    work_order_id: str | None = None
    token: int | None = None


class WindTurbineAgent(mesa.Agent):
    def __init__(self, model: "WindTurbineMaintenanceModel", turbine_id: str, x_km: float, y_km: float) -> None:
        super().__init__(model)
        self.turbine_id = turbine_id
        self.x_km = float(x_km)
        self.y_km = float(y_km)
        self.state = TurbineState.OPERATING
        self.time_last_maintenance_days = 0.0
        self.time_last_replacement_days = 0.0
        self.maintenance_due_at_days = math.inf
        self.maintenance_due_event_id: str | None = None
        self.failure_generation = 0
        self.maintenance_generation = 0
        self.active_corrective_order_id: str | None = None
        self.active_planned_order_id: str | None = None
        self.assigned_crew_id: str | None = None


class MaintenanceCrewAgent(mesa.Agent):
    def __init__(self, model: "WindTurbineMaintenanceModel", crew_id: str, x_km: float, y_km: float) -> None:
        super().__init__(model)
        self.crew_id = crew_id
        self.x_km = float(x_km)
        self.y_km = float(y_km)
        self.state = CrewState.IDLE
        self.current_work_order_id: str | None = None
        self.destination_turbine_id: str | None = None
        self.state_entered_at_days = 0.0
        self.travel_generation = 0


class WindTurbineMaintenanceModel(mesa.Model):
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
        self._fixture_positions = dict(self._fixture.positions_km) if self._fixture else {}
        self._fixture_due = {key: list(value) for key, value in (self._fixture.maintenance_due_times_days.items() if self._fixture else [])}
        self._fixture_failure = {key: list(value) for key, value in (self._fixture.failure_times_days.items() if self._fixture else [])}
        self._fixture_failure_last = {key: values[-1] for key, values in self._fixture_failure.items() if values}
        self._fixture_repair = list(self._fixture.repair_durations_days) if self._fixture else []
        self._fixture_maintenance = list(self._fixture.maintenance_durations_days) if self._fixture else []
        self._fixture_replacement = list(self._fixture.replacement_durations_days) if self._fixture else []
        self._fixture_replacement_decisions = list(self._fixture.replacement_decisions) if self._fixture else []
        self._event_sink = event_sink
        self._identity = dict(identity or {})
        self._domain_buffer: list[dict[str, Any]] = []
        self._domain_sequence = 0
        self._schedule_sequence = 0
        self._work_sequence = 0
        self._queue_sequence = 0
        self._scheduled: list[tuple[float, int, int, _ScheduledEvent]] = []
        self._processing_time: float | None = None
        self._processing_phase: int | None = None
        self._dispatch_times: set[float] = set()
        self._corrective_queue: list[tuple[float, int, str]] = []
        self._planned_queue: list[tuple[float, int, str]] = []
        self.work_orders: dict[str, WorkOrder] = {}
        self.stale_scheduled_event_count = 0
        self.processed_scheduled_event_count = 0
        self.failure_delay_sample_count = 0
        self._last_integrated_time = 0.0
        self._turbine_state_days = {state: 0.0 for state in TurbineState}
        self._crew_state_days = {state: 0.0 for state in CrewState}
        self._corrective_waits: list[float] = []
        self._maintenance_waits: list[float] = []
        self._open_corrective_waits: dict[str, float] = {}
        self._open_maintenance_waits: dict[str, float] = {}
        self._work_cost = 0.0
        self.failure_count = 0
        self.repair_count = 0
        self.maintenance_count = 0
        self.replacement_count = 0
        self._random_streams = {name: random.Random(self._stream_seed(name)) for name in MODEL_SPEC_DEFINITIONS["named_random_streams"]}

        self.turbines: dict[str, WindTurbineAgent] = {}
        self.crews: dict[str, MaintenanceCrewAgent] = {}
        self._create_agents()
        self._initialize_events()
        self._process_until(0.0)
        self._emit_daily_snapshot()

    @staticmethod
    def _validate_parameters(raw: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(raw, Mapping):
            raise TypeError("parameters must be a mapping")
        if set(raw) != set(PARAMETER_IDS):
            raise ValueError("parameters must contain the exact wind model parameter set")
        values = dict(raw)
        for name, value in values.items():
            if name == "major_replacement_enabled":
                if not isinstance(value, bool):
                    raise TypeError(f"{name} must be boolean")
            elif isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"{name} must be numeric")
            elif not math.isfinite(float(value)):
                raise ValueError(f"{name} must be finite")
        for name in ("turbine_count", "crew_count"):
            if isinstance(values[name], bool) or not isinstance(values[name], int):
                raise TypeError(f"{name} must be an integer")
        if not 1 <= values["turbine_count"] <= 500:
            raise ValueError("turbine_count must be between 1 and 500")
        if not 1 <= values["crew_count"] <= 50:
            raise ValueError("crew_count must be between 1 and 50")
        if values["maintenance_period_days"] <= 0 or values["normal_failure_rate_per_day"] <= 0:
            raise ValueError("maintenance period and failure rate must be positive")
        for prefix in ("repair", "maintenance", "replacement"):
            low = float(values[f"{prefix}_low_hours"])
            mode = float(values[f"{prefix}_mode_hours"])
            high = float(values[f"{prefix}_high_hours"])
            if low <= 0 or not low <= mode <= high:
                raise ValueError(f"{prefix} triangular parameters must satisfy 0 < low <= mode <= high")
        if values["farm_width_km"] <= 0 or values["farm_height_km"] <= 0:
            raise ValueError("farm dimensions must be positive")
        if not 0 <= values["depot_x_km"] <= values["farm_width_km"] or not 0 <= values["depot_y_km"] <= values["farm_height_km"]:
            raise ValueError("depot must be inside the farm")
        if values["crew_speed_km_per_hour"] <= 0:
            raise ValueError("crew speed must be positive")
        if not 0 <= values["major_replacement_probability"] <= 1:
            raise ValueError("major replacement probability must be between zero and one")
        if not 0 <= values["minimum_availability_fraction"] <= 1:
            raise ValueError("minimum availability must be between zero and one")
        for name in ("daily_revenue_per_operating_turbine", "crew_cost_per_day", "repair_cost", "maintenance_cost", "replacement_cost"):
            if values[name] < 0:
                raise ValueError(f"{name} must be non-negative")
        return values

    def _stream_seed(self, name: str) -> int:
        material = f"{MODEL_PROTOCOL_VERSION}:{self.seed}:{name}".encode()
        return int.from_bytes(hashlib.sha256(material).digest()[:8], "big")

    def _create_agents(self) -> None:
        layout = self._random_streams["layout"]
        for index in range(1, int(self.parameters["turbine_count"]) + 1):
            turbine_id = f"turbine-{index:04d}"
            if turbine_id in self._fixture_positions:
                x_km, y_km = self._fixture_positions[turbine_id]
            else:
                x_km = layout.uniform(0, float(self.parameters["farm_width_km"]))
                y_km = layout.uniform(0, float(self.parameters["farm_height_km"]))
            if not 0 <= x_km <= self.parameters["farm_width_km"] or not 0 <= y_km <= self.parameters["farm_height_km"]:
                raise ValueError(f"fixture position for {turbine_id} is outside the farm")
            self.turbines[turbine_id] = WindTurbineAgent(self, turbine_id, x_km, y_km)
        depot_x = float(self.parameters["depot_x_km"])
        depot_y = float(self.parameters["depot_y_km"])
        for index in range(1, int(self.parameters["crew_count"]) + 1):
            crew_id = f"crew-{index:03d}"
            self.crews[crew_id] = MaintenanceCrewAgent(self, crew_id, depot_x, depot_y)

    def _initialize_events(self) -> None:
        initial_rng = self._random_streams["initial_maintenance"]
        period = float(self.parameters["maintenance_period_days"])
        for turbine_id in sorted(self.turbines):
            turbine = self.turbines[turbine_id]
            if turbine_id in self._fixture_due and self._fixture_due[turbine_id]:
                due = float(self._fixture_due[turbine_id].pop(0))
                turbine.time_last_maintenance_days = due - period
            else:
                turbine.time_last_maintenance_days = initial_rng.uniform(-period, 0.0)
                due = turbine.time_last_maintenance_days + period
            turbine.time_last_replacement_days = 0.0
            self._schedule_maintenance_due(turbine, due)
            self._schedule_failure_on_operating_entry(turbine)

    def _schedule(self, at: float, phase: int, event_type: str, *, turbine_id: str | None = None, crew_id: str | None = None, work_order_id: str | None = None, token: int | None = None) -> None:
        at = float(at)
        if not math.isfinite(at) or at < self.sim_time_days:
            raise RuntimeError("scheduled event time must be finite and non-decreasing")
        if self._processing_time == at and self._processing_phase is not None and phase < self._processing_phase:
            raise RuntimeError("cannot schedule into an already-finished lower phase at the same simulation time")
        self._schedule_sequence += 1
        event = _ScheduledEvent(at, phase, self._schedule_sequence, event_type, turbine_id, crew_id, work_order_id, token)
        heapq.heappush(self._scheduled, (at, phase, -self._schedule_sequence, event))

    def _schedule_maintenance_due(self, turbine: WindTurbineAgent, due: float) -> None:
        turbine.maintenance_generation += 1
        turbine.maintenance_due_at_days = float(due)
        self._schedule(due, PHASE_REQUEST_TRIGGER, "maintenance_due_trigger", turbine_id=turbine.turbine_id, token=turbine.maintenance_generation)

    def _schedule_failure_on_operating_entry(self, turbine: WindTurbineAgent) -> None:
        turbine.failure_generation += 1
        self.failure_delay_sample_count += 1
        scripted = self._fixture_failure.get(turbine.turbine_id)
        if scripted:
            failure_at = float(scripted.pop(0))
        elif turbine.turbine_id in self._fixture_failure_last:
            failure_at = max(float(self._fixture_failure_last[turbine.turbine_id]), float(self.horizon_days + 1))
        else:
            period = float(self.parameters["maintenance_period_days"])
            overdue_factor = max(1.0, (self.sim_time_days - turbine.time_last_maintenance_days) / period)
            age_factor = max(1.0, (self.sim_time_days - turbine.time_last_replacement_days) / (3.0 * period))
            rate = float(self.parameters["normal_failure_rate_per_day"]) * overdue_factor * age_factor
            failure_at = self.sim_time_days + self._random_streams["failure"].expovariate(rate)
        if failure_at < self.sim_time_days:
            raise ValueError("fixture failure time cannot precede operating entry")
        self._schedule(failure_at, PHASE_REQUEST_TRIGGER, "failure_trigger", turbine_id=turbine.turbine_id, token=turbine.failure_generation)

    def _next_due_after_completion(self, turbine: WindTurbineAgent) -> float:
        scripted = self._fixture_due.get(turbine.turbine_id)
        if scripted:
            return float(scripted.pop(0))
        return self.sim_time_days + float(self.parameters["maintenance_period_days"])

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
        if event.event_type == "failure_trigger":
            self._handle_failure(event)
        elif event.event_type == "maintenance_due_trigger":
            self._handle_maintenance_due(event)
        elif event.event_type == "dispatch":
            self._dispatch_times.discard(event.sim_time_days)
            self._dispatch()
        elif event.event_type == "crew_arrival":
            self._handle_arrival(event.crew_id, event.work_order_id, PHASE_ARRIVAL_OR_RETURN)
        elif event.event_type == "work_completion":
            self._handle_completion(event.work_order_id)
        elif event.event_type == "crew_return":
            self._handle_return(event.crew_id, event.token)
        else:
            raise RuntimeError(f"unknown scheduled event {event.event_type}")

    def _integrate_to(self, target: float) -> None:
        if target < self._last_integrated_time:
            raise RuntimeError("simulation time moved backwards")
        start = max(self._last_integrated_time, float(self.warmup_days))
        end = min(float(target), float(self.horizon_days))
        duration = max(0.0, end - start)
        if duration:
            for turbine in self.turbines.values():
                self._turbine_state_days[turbine.state] += duration
            for crew in self.crews.values():
                self._crew_state_days[crew.state] += duration
        self._last_integrated_time = target

    def _emit(self, event_type: str, phase: int, *, turbine_id: str | None = None, crew_id: str | None = None, work_order_id: str | None = None, correlation_id: str | None = None, before_state: str | None = None, after_state: str | None = None, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        self._domain_sequence += 1
        event = {
            **self._identity,
            "event_id": f"event-{self._domain_sequence:08d}",
            "sequence": self._domain_sequence,
            "sim_time_days": self.sim_time_days,
            "event_type": event_type,
            "phase": phase,
            "turbine_id": turbine_id,
            "crew_id": crew_id,
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

    def _ensure_dispatch(self) -> None:
        if self.sim_time_days not in self._dispatch_times:
            self._dispatch_times.add(self.sim_time_days)
            self._schedule(self.sim_time_days, PHASE_DISPATCH, "dispatch")

    def _new_order(self, request_kind: RequestKind, turbine: WindTurbineAgent, requested_at: float, source_event_id: str, *, correlation_id: str | None = None, emit_queued: bool = True) -> WorkOrder:
        self._work_sequence += 1
        self._queue_sequence += 1
        order = WorkOrder(
            work_order_id=f"work-{self._work_sequence:08d}",
            request_kind=request_kind,
            turbine_id=turbine.turbine_id,
            requested_at_days=float(requested_at),
            source_event_id=source_event_id,
            enqueue_sequence=self._queue_sequence,
            correlation_id=correlation_id,
        )
        self.work_orders[order.work_order_id] = order
        if request_kind is RequestKind.CORRECTIVE:
            turbine.active_corrective_order_id = order.work_order_id
            queue = self._corrective_queue
        else:
            turbine.active_planned_order_id = order.work_order_id
            queue = self._planned_queue
        heapq.heappush(queue, (order.requested_at_days, order.enqueue_sequence, order.work_order_id))
        if emit_queued:
            self._emit("request_queued", PHASE_REQUEST_TRIGGER, turbine_id=turbine.turbine_id, work_order_id=order.work_order_id, correlation_id=correlation_id, payload={"request_kind": request_kind.value})
        return order

    def _handle_failure(self, event: _ScheduledEvent) -> None:
        turbine = self.turbines[event.turbine_id or ""]
        if event.token != turbine.failure_generation or turbine.state is not TurbineState.OPERATING:
            self.stale_scheduled_event_count += 1
            return
        before = turbine.state.value
        turbine.failure_generation += 1
        turbine.state = TurbineState.FAILED_WAITING
        domain = self._emit("failure_occurred", PHASE_REQUEST_TRIGGER, turbine_id=turbine.turbine_id, before_state=before, after_state=turbine.state.value)
        if self._in_measurement_origin(self.sim_time_days):
            self.failure_count += 1
            self._open_corrective_waits[domain["event_id"]] = self.sim_time_days
        planned = self.work_orders.get(turbine.active_planned_order_id or "")
        assigned_crew: MaintenanceCrewAgent | None = None
        if planned and planned.status in {WorkStatus.QUEUED, WorkStatus.ASSIGNED}:
            planned.status = WorkStatus.SUPERSEDED
            self._emit("request_superseded", PHASE_REQUEST_TRIGGER, turbine_id=turbine.turbine_id, work_order_id=planned.work_order_id, payload={"request_kind": "planned"})
            turbine.active_planned_order_id = None
            if planned.assigned_crew_id:
                assigned_crew = self.crews[planned.assigned_crew_id]
        corrective = self._new_order(RequestKind.CORRECTIVE, turbine, self.sim_time_days, domain["event_id"])
        if planned and planned.status is WorkStatus.SUPERSEDED:
            planned.superseded_by_order_id = corrective.work_order_id
        if assigned_crew is not None:
            corrective.status = WorkStatus.ASSIGNED
            corrective.assigned_crew_id = assigned_crew.crew_id
            corrective.assigned_at_days = self.sim_time_days
            assigned_crew.current_work_order_id = corrective.work_order_id
        self._ensure_dispatch()

    def _handle_maintenance_due(self, event: _ScheduledEvent) -> None:
        turbine = self.turbines[event.turbine_id or ""]
        if event.token != turbine.maintenance_generation:
            self.stale_scheduled_event_count += 1
            return
        turbine.maintenance_due_at_days = self.sim_time_days
        domain = self._emit("maintenance_due", PHASE_REQUEST_TRIGGER, turbine_id=turbine.turbine_id)
        turbine.maintenance_due_event_id = domain["event_id"]
        if self._in_measurement_origin(self.sim_time_days):
            self._open_maintenance_waits[domain["event_id"]] = self.sim_time_days
        corrective = self.work_orders.get(turbine.active_corrective_order_id or "")
        if turbine.assigned_crew_id or corrective and corrective.status in {WorkStatus.ASSIGNED, WorkStatus.IN_PROGRESS}:
            self._emit("request_suppressed", PHASE_REQUEST_TRIGGER, turbine_id=turbine.turbine_id, correlation_id=domain["event_id"], payload={"reason": "crew_already_assigned"})
            return
        if corrective and corrective.status is WorkStatus.QUEUED:
            self._emit("request_suppressed", PHASE_REQUEST_TRIGGER, turbine_id=turbine.turbine_id, correlation_id=domain["event_id"], payload={"reason": "corrective_order_active"})
            return
        planned = self.work_orders.get(turbine.active_planned_order_id or "")
        if planned and planned.status not in {WorkStatus.COMPLETED, WorkStatus.SUPERSEDED}:
            self._emit("request_suppressed", PHASE_REQUEST_TRIGGER, turbine_id=turbine.turbine_id, correlation_id=domain["event_id"], payload={"reason": "planned_order_active"})
            return
        self._new_order(RequestKind.PLANNED, turbine, self.sim_time_days, domain["event_id"])
        self._ensure_dispatch()

    def _valid_queue_pop(self, queue: list[tuple[float, int, str]], kind: RequestKind) -> WorkOrder | None:
        while queue:
            _, _, order_id = heapq.heappop(queue)
            order = self.work_orders[order_id]
            if order.status is WorkStatus.QUEUED and order.request_kind is kind:
                return order
        return None

    def _peek_work_exists(self) -> bool:
        return any(order.status is WorkStatus.QUEUED for order in self.work_orders.values())

    def _dispatch(self) -> None:
        available = sorted((crew for crew in self.crews.values() if crew.state is CrewState.IDLE), key=lambda crew: crew.crew_id)
        for crew in available:
            order = self._valid_queue_pop(self._corrective_queue, RequestKind.CORRECTIVE)
            if order is None:
                order = self._valid_queue_pop(self._planned_queue, RequestKind.PLANNED)
            if order is None:
                break
            turbine = self.turbines[order.turbine_id]
            order.status = WorkStatus.ASSIGNED
            order.assigned_crew_id = crew.crew_id
            order.assigned_at_days = self.sim_time_days
            crew.current_work_order_id = order.work_order_id
            crew.destination_turbine_id = turbine.turbine_id
            turbine.assigned_crew_id = crew.crew_id
            before = crew.state.value
            crew.state = CrewState.DRIVING_TO_WORK
            crew.travel_generation += 1
            distance = math.hypot(turbine.x_km - crew.x_km, turbine.y_km - crew.y_km)
            travel = distance / (float(self.parameters["crew_speed_km_per_hour"]) * 24.0)
            eta = self.sim_time_days + travel
            self._emit("crew_dispatched", PHASE_DISPATCH, turbine_id=turbine.turbine_id, crew_id=crew.crew_id, work_order_id=order.work_order_id, before_state=before, after_state=crew.state.value, payload={"request_kind": order.request_kind.value, "eta_days": eta})
            if travel == 0:
                self._handle_arrival(crew.crew_id, order.work_order_id, PHASE_DISPATCH)
            else:
                self._schedule(eta, PHASE_ARRIVAL_OR_RETURN, "crew_arrival", turbine_id=turbine.turbine_id, crew_id=crew.crew_id, work_order_id=order.work_order_id, token=crew.travel_generation)

    def _handle_arrival(self, crew_id: str | None, work_order_id: str | None, phase: int) -> None:
        if crew_id is None or work_order_id is None:
            raise RuntimeError("arrival is missing identity")
        crew = self.crews[crew_id]
        order = self.work_orders[work_order_id]
        if order.status is WorkStatus.SUPERSEDED and crew.current_work_order_id:
            converted = self.work_orders[crew.current_work_order_id]
            if converted.status is WorkStatus.ASSIGNED and converted.turbine_id == order.turbine_id:
                order = converted
                work_order_id = converted.work_order_id
        if order.status is not WorkStatus.ASSIGNED or crew.current_work_order_id != work_order_id:
            self.stale_scheduled_event_count += 1
            return
        turbine = self.turbines[order.turbine_id]
        crew.x_km, crew.y_km = turbine.x_km, turbine.y_km
        crew_before = crew.state.value
        crew.state = CrewState.WORKING
        self._emit("crew_arrived", phase, turbine_id=turbine.turbine_id, crew_id=crew.crew_id, work_order_id=order.work_order_id, before_state=crew_before, after_state=crew.state.value)
        order.status = WorkStatus.IN_PROGRESS
        order.started_at_days = self.sim_time_days
        if order.request_kind is RequestKind.CORRECTIVE:
            replace = self._replacement_decision()
            if bool(self.parameters["major_replacement_enabled"]) and replace:
                order.operation_kind = OperationKind.REPLACEMENT
                turbine_before = turbine.state.value
                turbine.state = TurbineState.MAJOR_REPLACEMENT
                event_type = "replacement_started"
                duration = self._duration(OperationKind.REPLACEMENT)
            else:
                order.operation_kind = OperationKind.REPAIR
                turbine_before = turbine.state.value
                turbine.state = TurbineState.CORRECTIVE_REPAIR
                event_type = "repair_started"
                duration = self._duration(OperationKind.REPAIR)
            self._record_wait_start(self._open_corrective_waits, self._corrective_waits, order.source_event_id, order.requested_at_days)
        else:
            order.operation_kind = OperationKind.MAINTENANCE
            turbine_before = turbine.state.value
            turbine.state = TurbineState.PLANNED_MAINTENANCE
            event_type = "maintenance_started"
            duration = self._duration(OperationKind.MAINTENANCE)
            self._record_wait_start(self._open_maintenance_waits, self._maintenance_waits, order.source_event_id, order.requested_at_days)
        turbine.failure_generation += 1
        self._emit(event_type, phase, turbine_id=turbine.turbine_id, crew_id=crew.crew_id, work_order_id=order.work_order_id, correlation_id=order.correlation_id, before_state=turbine_before, after_state=turbine.state.value, payload={"same_crew": False})
        self._schedule(self.sim_time_days + duration, PHASE_WORK_COMPLETION, "work_completion", turbine_id=turbine.turbine_id, crew_id=crew.crew_id, work_order_id=order.work_order_id)

    def _replacement_decision(self) -> bool:
        if self._fixture_replacement_decisions:
            return bool(self._fixture_replacement_decisions.pop(0))
        return self._random_streams["replacement_decision"].random() < float(self.parameters["major_replacement_probability"])

    def _duration(self, operation: OperationKind) -> float:
        if operation is OperationKind.REPAIR:
            fixture = self._fixture_repair
            prefix = "repair"
            stream = "repair_duration"
        elif operation is OperationKind.MAINTENANCE:
            fixture = self._fixture_maintenance
            prefix = "maintenance"
            stream = "maintenance_duration"
        else:
            fixture = self._fixture_replacement
            prefix = "replacement"
            stream = "replacement_duration"
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

    def _handle_completion(self, work_order_id: str | None) -> None:
        if work_order_id is None:
            raise RuntimeError("completion is missing work order")
        order = self.work_orders[work_order_id]
        if order.status is not WorkStatus.IN_PROGRESS or order.operation_kind is None or order.assigned_crew_id is None:
            self.stale_scheduled_event_count += 1
            return
        turbine = self.turbines[order.turbine_id]
        crew = self.crews[order.assigned_crew_id]
        operation = order.operation_kind
        event_type = {
            OperationKind.REPAIR: "repair_completed",
            OperationKind.MAINTENANCE: "maintenance_completed",
            OperationKind.REPLACEMENT: "replacement_completed",
        }[operation]
        cost = float(self.parameters[{OperationKind.REPAIR: "repair_cost", OperationKind.MAINTENANCE: "maintenance_cost", OperationKind.REPLACEMENT: "replacement_cost"}[operation]])
        turbine_before = turbine.state.value
        if operation is OperationKind.REPAIR and turbine.maintenance_due_at_days <= self.sim_time_days:
            turbine_after = TurbineState.PLANNED_MAINTENANCE.value
        else:
            turbine_after = TurbineState.OPERATING.value
        self._emit(event_type, PHASE_WORK_COMPLETION, turbine_id=turbine.turbine_id, crew_id=crew.crew_id, work_order_id=order.work_order_id, correlation_id=order.correlation_id, before_state=turbine_before, after_state=turbine_after, payload={"cost": cost})
        order.status = WorkStatus.COMPLETED
        order.completed_at_days = self.sim_time_days
        if self._in_measurement_completion(self.sim_time_days):
            self._work_cost += cost
            if operation is OperationKind.REPAIR:
                self.repair_count += 1
            elif operation is OperationKind.MAINTENANCE:
                self.maintenance_count += 1
            else:
                self.replacement_count += 1

        if operation is OperationKind.REPAIR:
            turbine.active_corrective_order_id = None
            if turbine.maintenance_due_at_days <= self.sim_time_days:
                self._start_same_crew_maintenance(turbine, crew, order)
                return
            self._enter_operating(turbine)
        elif operation is OperationKind.MAINTENANCE:
            turbine.active_planned_order_id = None
            turbine.time_last_maintenance_days = self.sim_time_days
            self._schedule_maintenance_due(turbine, self._next_due_after_completion(turbine))
            self._enter_operating(turbine)
        else:
            turbine.active_corrective_order_id = None
            if turbine.maintenance_due_event_id is not None:
                self._open_maintenance_waits.pop(turbine.maintenance_due_event_id, None)
            turbine.active_planned_order_id = None
            turbine.maintenance_due_event_id = None
            turbine.time_last_replacement_days = self.sim_time_days
            turbine.time_last_maintenance_days = self.sim_time_days
            self._schedule_maintenance_due(turbine, self._next_due_after_completion(turbine))
            self._enter_operating(turbine)
        self._release_crew(turbine, crew)

    def _start_same_crew_maintenance(self, turbine: WindTurbineAgent, crew: MaintenanceCrewAgent, completed_corrective: WorkOrder) -> None:
        self._work_sequence += 1
        self._queue_sequence += 1
        order = WorkOrder(
            work_order_id=f"work-{self._work_sequence:08d}",
            request_kind=RequestKind.PLANNED,
            turbine_id=turbine.turbine_id,
            requested_at_days=turbine.maintenance_due_at_days,
            source_event_id=turbine.maintenance_due_event_id or "maintenance-due",
            enqueue_sequence=self._queue_sequence,
            status=WorkStatus.IN_PROGRESS,
            operation_kind=OperationKind.MAINTENANCE,
            correlation_id=completed_corrective.work_order_id,
            assigned_crew_id=crew.crew_id,
            assigned_at_days=self.sim_time_days,
            started_at_days=self.sim_time_days,
        )
        self.work_orders[order.work_order_id] = order
        turbine.active_planned_order_id = order.work_order_id
        turbine.assigned_crew_id = crew.crew_id
        turbine_before = turbine.state.value
        turbine.state = TurbineState.PLANNED_MAINTENANCE
        crew.current_work_order_id = order.work_order_id
        crew.state = CrewState.WORKING
        self._record_wait_start(self._open_maintenance_waits, self._maintenance_waits, order.source_event_id, order.requested_at_days)
        self._emit("maintenance_started", PHASE_WORK_COMPLETION, turbine_id=turbine.turbine_id, crew_id=crew.crew_id, work_order_id=order.work_order_id, correlation_id=completed_corrective.work_order_id, before_state=turbine_before, after_state=turbine.state.value, payload={"same_crew": True})
        self._schedule(self.sim_time_days + self._duration(OperationKind.MAINTENANCE), PHASE_WORK_COMPLETION, "work_completion", turbine_id=turbine.turbine_id, crew_id=crew.crew_id, work_order_id=order.work_order_id)

    def _enter_operating(self, turbine: WindTurbineAgent) -> None:
        turbine.state = TurbineState.OPERATING
        self._schedule_failure_on_operating_entry(turbine)

    def _release_crew(self, turbine: WindTurbineAgent, crew: MaintenanceCrewAgent) -> None:
        turbine.assigned_crew_id = None
        crew.current_work_order_id = None
        crew.destination_turbine_id = None
        crew.state = CrewState.IDLE
        if self._peek_work_exists():
            self._ensure_dispatch()
            return
        depot = (float(self.parameters["depot_x_km"]), float(self.parameters["depot_y_km"]))
        distance = math.hypot(crew.x_km - depot[0], crew.y_km - depot[1])
        if distance == 0:
            return
        crew.state = CrewState.DRIVING_HOME
        crew.travel_generation += 1
        eta = self.sim_time_days + distance / (float(self.parameters["crew_speed_km_per_hour"]) * 24.0)
        self._emit("crew_return_started", PHASE_WORK_COMPLETION, crew_id=crew.crew_id, before_state=CrewState.WORKING.value, after_state=crew.state.value, payload={"eta_days": eta})
        self._schedule(eta, PHASE_ARRIVAL_OR_RETURN, "crew_return", crew_id=crew.crew_id, token=crew.travel_generation)

    def _handle_return(self, crew_id: str | None, token: int | None) -> None:
        if crew_id is None:
            raise RuntimeError("return is missing crew")
        crew = self.crews[crew_id]
        if token != crew.travel_generation or crew.state is not CrewState.DRIVING_HOME:
            self.stale_scheduled_event_count += 1
            return
        crew.x_km = float(self.parameters["depot_x_km"])
        crew.y_km = float(self.parameters["depot_y_km"])
        crew.state = CrewState.IDLE
        self._emit("crew_returned", PHASE_ARRIVAL_OR_RETURN, crew_id=crew.crew_id, before_state=CrewState.DRIVING_HOME.value, after_state=crew.state.value)
        if self._peek_work_exists():
            self._ensure_dispatch()

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

    def snapshot(self) -> dict[str, int | float]:
        elapsed = max(0.0, min(self.sim_time_days, float(self.horizon_days)) - float(self.warmup_days))
        availability_numerator = self._turbine_state_days[TurbineState.OPERATING]
        availability_denominator = int(self.parameters["turbine_count"]) * elapsed
        driving_to_work = self._crew_state_days[CrewState.DRIVING_TO_WORK]
        returning = self._crew_state_days[CrewState.DRIVING_HOME]
        driving = driving_to_work + returning
        working = self._crew_state_days[CrewState.WORKING]
        utilization_numerator = driving + working
        utilization_denominator = int(self.parameters["crew_count"]) * elapsed
        availability = availability_numerator / availability_denominator if availability_denominator else 1.0
        utilization = utilization_numerator / utilization_denominator if utilization_denominator else 0.0
        crew_cost = int(self.parameters["crew_count"]) * float(self.parameters["crew_cost_per_day"]) * elapsed
        state_counts = {state: sum(turbine.state is state for turbine in self.turbines.values()) for state in TurbineState}
        crew_counts = {state: sum(crew.state is state for crew in self.crews.values()) for state in CrewState}
        corrective_queue = sum(order.status is WorkStatus.QUEUED and order.request_kind is RequestKind.CORRECTIVE for order in self.work_orders.values())
        planned_queue = sum(order.status is WorkStatus.QUEUED and order.request_kind is RequestKind.PLANNED for order in self.work_orders.values())
        return {
            "sim_time_days": self.sim_time_days,
            "turbine_count": int(self.parameters["turbine_count"]),
            "crew_count": int(self.parameters["crew_count"]),
            "operating_count": state_counts[TurbineState.OPERATING],
            "failed_waiting_count": state_counts[TurbineState.FAILED_WAITING],
            "corrective_repair_count": state_counts[TurbineState.CORRECTIVE_REPAIR],
            "planned_maintenance_count": state_counts[TurbineState.PLANNED_MAINTENANCE],
            "major_replacement_count": state_counts[TurbineState.MAJOR_REPLACEMENT],
            "idle_crew_count": crew_counts[CrewState.IDLE],
            "driving_to_work_crew_count": crew_counts[CrewState.DRIVING_TO_WORK],
            "working_crew_count": crew_counts[CrewState.WORKING],
            "driving_home_crew_count": crew_counts[CrewState.DRIVING_HOME],
            "corrective_queue_length": corrective_queue,
            "planned_queue_length": planned_queue,
            "operating_turbine_days": availability_numerator,
            "failed_waiting_turbine_days": self._turbine_state_days[TurbineState.FAILED_WAITING],
            "corrective_repair_turbine_days": self._turbine_state_days[TurbineState.CORRECTIVE_REPAIR],
            "planned_maintenance_turbine_days": self._turbine_state_days[TurbineState.PLANNED_MAINTENANCE],
            "major_replacement_turbine_days": self._turbine_state_days[TurbineState.MAJOR_REPLACEMENT],
            "idle_crew_days": self._crew_state_days[CrewState.IDLE],
            "crew_driving_days": driving,
            "crew_working_days": working,
            "availability_numerator": availability_numerator,
            "availability_denominator": availability_denominator,
            "availability_fraction": availability,
            "crew_utilization_numerator": utilization_numerator,
            "crew_utilization_denominator": utilization_denominator,
            "crew_utilization_fraction": utilization,
            "crew_driving_fraction": driving_to_work / utilization_denominator if utilization_denominator else 0.0,
            "crew_working_fraction": working / utilization_denominator if utilization_denominator else 0.0,
            "crew_returning_fraction": returning / utilization_denominator if utilization_denominator else 0.0,
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
            "failure_count": self.failure_count,
            "repair_count": self.repair_count,
            "maintenance_count": self.maintenance_count,
            "replacement_count": self.replacement_count,
            "failure_delay_sample_count": self.failure_delay_sample_count,
            "stale_scheduled_event_count": self.stale_scheduled_event_count,
            "processed_scheduled_event_count": self.processed_scheduled_event_count,
            "pending_scheduled_event_count": len(self._scheduled),
            "work_cost": self._work_cost,
            "crew_cost": crew_cost,
            "total_maintenance_cost": self._work_cost + crew_cost,
            "operating_revenue": availability_numerator * float(self.parameters["daily_revenue_per_operating_turbine"]),
        }

    def drain_domain_events(self) -> list[dict[str, Any]]:
        events = self._domain_buffer
        self._domain_buffer = []
        return events

    def export_model_spec(self) -> dict[str, Any]:
        return copy.deepcopy(MODEL_SPEC_DEFINITIONS)
