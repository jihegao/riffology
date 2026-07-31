from __future__ import annotations

import importlib
import math
from typing import Any

import pytest


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
