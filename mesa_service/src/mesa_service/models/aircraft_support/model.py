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
