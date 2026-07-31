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
