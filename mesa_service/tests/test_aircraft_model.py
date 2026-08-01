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
    assert all(aircraft.state is module.AircraftState.IN_FLIGHT for aircraft in model.aircraft.values())
    assert all(team.state is module.TeamState.IDLE for team in model.teams.values())
    assert all(hangar.state is module.HangarState.FREE for hangar in model.hangars.values())


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
    assert any(event[1] == "failure_occurred" for event in projections)
    assert not any(event[1] == "flight_completed" for event in projections)
    final = model.snapshot()
    assert final["in_flight_count"] == 0
    assert final["grounded_for_part_count"] == 1  # zero part stock blocks the corrective order
    assert final["stale_scheduled_event_count"] == 1


def test_flight_completion_and_warmup_window_gates_flight_count() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [10.0]},
        failure_times_days={"aircraft-0001": [10.0]},
        repair_durations_days=[],
        scheduled_durations_days=[],
    )
    model = module.AircraftSupportModel(
        parameters=_parameters(aircraft_count=1),
        horizon_days=4,
        warmup_days=2,
        seed=2,
        scenario_fixture=fixture,
    )
    _run_to_horizon(model)
    final = model.snapshot()
    assert final["flight_count"] == 2  # completions at 2.25 and 3.25 are in [2,4)
    assert final["mission_required"] == 2
    assert final["mission_completion_fraction"] == pytest.approx(1.0)
    assert final["operating_count"] == 1
    assert final["stale_scheduled_event_count"] == 0


def test_fixture_failure_beyond_flight_never_fires_randomly() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [10.0]},
        failure_times_days={"aircraft-0001": [10.0]},
        repair_durations_days=[],
        scheduled_durations_days=[],
    )
    model = module.AircraftSupportModel(
        parameters=_parameters(aircraft_count=1),
        horizon_days=4,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )
    events = _run_to_horizon(model)
    assert not any(e["event_type"] == "failure_occurred" for e in _mechanism_events(events))
    final = model.snapshot()
    assert final["failure_count"] == 0
    assert final["operating_count"] == 1


def test_scheduled_maintenance_lifecycle_with_hangar() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [0.0]},
        failure_times_days={"aircraft-0001": [10.0]},
        repair_durations_days=[],
        scheduled_durations_days=[0.25],
    )
    model = module.AircraftSupportModel(
        parameters=_parameters(aircraft_count=1),
        horizon_days=1,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )
    events = _mechanism_events(_run_to_horizon(model))
    assert any(e["event_type"] == "maintenance_started" and e["work_order_id"] == "work-00000001" for e in events)
    assert any(e["event_type"] == "maintenance_completed" for e in events)
    assert any(e["event_type"] == "team_assigned" for e in events)
    assert any(e["event_type"] == "aircraft_grounded" for e in events)
    final = model.snapshot()
    assert final["operating_count"] == 1
    assert final["maintenance_count"] == 1
    assert final["scheduled_queue_length"] == 0
    assert final["grounded_for_maintenance_count"] == 0


def test_maintenance_due_while_in_flight_queues_and_starts_on_landing() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [0.1]},
        failure_times_days={"aircraft-0001": [10.0]},
        repair_durations_days=[],
        scheduled_durations_days=[0.25],
    )
    model = module.AircraftSupportModel(
        parameters=_parameters(aircraft_count=1),
        horizon_days=1,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )
    events = _mechanism_events(_run_to_horizon(model))
    due = [e for e in events if e["event_type"] == "maintenance_due"]
    assert len(due) == 1 and due[0]["sim_time_days"] == pytest.approx(0.1)
    started = [e for e in events if e["event_type"] == "maintenance_started"]
    assert len(started) == 1 and started[0]["sim_time_days"] == pytest.approx(0.25)


def test_hangar_capacity_bounds_concurrent_scheduled_work() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [0.1], "aircraft-0002": [0.1]},
        failure_times_days={"aircraft-0001": [10.0], "aircraft-0002": [10.0]},
        repair_durations_days=[],
        scheduled_durations_days=[0.25, 0.25],
    )
    model = module.AircraftSupportModel(
        parameters=_parameters(aircraft_count=2, team_count=2, hangar_count=1),
        horizon_days=1,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )
    events = _mechanism_events(_run_to_horizon(model))
    started = [e for e in events if e["event_type"] == "maintenance_started"]
    assert len(started) == 2  # second waits for the hangar, then runs after first completes
    assert started[0]["sim_time_days"] <= started[1]["sim_time_days"]
    final = model.snapshot()
    assert final["maintenance_count"] == 2
    assert final["scheduled_queue_length"] == 0


def test_past_scripted_due_does_not_crash_completion_reschedule() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [0.0, 0.3]},
        failure_times_days={"aircraft-0001": [10.0]},
        repair_durations_days=[],
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
    due = [e for e in _mechanism_events(events) if e["event_type"] == "maintenance_due"]
    assert len(due) == 1
    assert due[0]["sim_time_days"] == pytest.approx(0.0)
    assert model._fixture_due == {"aircraft-0001": []}
    final = model.snapshot()
    assert final["operating_count"] == 1


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
        (1.0, "flight_started", "aircraft-0002"),
        (1.0, "flight_started", "aircraft-0001"),
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
        (2.0, "flight_started", "aircraft-0003"),
        (2.0, "flight_started", "aircraft-0002"),
        (2.0, "flight_started", "aircraft-0001"),
        (2.2, "part_received", None),
        (2.25, "flight_completed", "aircraft-0001"),
        (2.25, "flight_completed", "aircraft-0002"),
        (2.25, "flight_completed", "aircraft-0003"),
        (3.0, "flight_started", "aircraft-0003"),
        (3.0, "flight_started", "aircraft-0002"),
        (3.0, "flight_started", "aircraft-0001"),
        (3.25, "flight_completed", "aircraft-0001"),
        (3.25, "flight_completed", "aircraft-0002"),
        (3.25, "flight_completed", "aircraft-0003"),
    ]
    assert [event["sequence"] for event in events] == list(range(1, 57))
    assert len(events) == 56
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


def test_part_backorder_blocks_then_arrival_unblocks_repair() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [10.0]},
        failure_times_days={"aircraft-0001": [0.1]},
        repair_durations_days=[0.5],
        scheduled_durations_days=[0.25],
    )
    model = module.AircraftSupportModel(
        parameters=_parameters(aircraft_count=1),
        horizon_days=2,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )
    events = _mechanism_events(_run_to_horizon(model))
    backordered = [e for e in events if e["event_type"] == "part_backordered"]
    received = [e for e in events if e["event_type"] == "part_received"]
    started = [e for e in events if e["event_type"] == "repair_started"]
    assert len(backordered) == 1
    assert len(received) == 1
    assert len(started) == 1
    assert backordered[0]["sequence"] < received[0]["sequence"] < started[0]["sequence"]
    assert backordered[0]["aircraft_id"] == "aircraft-0001"
    assert backordered[0]["payload"]["part_id"] == "part-0001"
    assert received[0]["payload"]["stock"] == 2
    assert started[0]["sim_time_days"] == pytest.approx(1.1)
    final = model.snapshot()
    assert final["grounded_for_part_count"] == 0
    assert final["operating_count"] == 1
    assert final["repair_count"] == 1
    assert final["part_orders_placed"] == 2


def test_same_crew_maintenance_continues_after_overdue_repair() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [0.2]},
        failure_times_days={"aircraft-0001": [0.1]},
        repair_durations_days=[0.5],
        scheduled_durations_days=[0.25],
    )
    model = module.AircraftSupportModel(
        parameters=_parameters(aircraft_count=1, part_initial_stock=2),
        horizon_days=2,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )
    events = _mechanism_events(_run_to_horizon(model))
    suppressed = [e for e in events if e["event_type"] == "request_suppressed"]
    assert len(suppressed) == 1
    assert suppressed[0]["payload"]["reason"] == "corrective_order_active"
    same_crew = [e for e in events if e["event_type"] == "maintenance_started" and e["payload"].get("same_crew") is True]
    assert len(same_crew) == 1
    assert same_crew[0]["correlation_id"] == "work-00000001"
    assert same_crew[0]["payload"]["same_crew"] is True
    repair_completed = [e for e in events if e["event_type"] == "repair_completed"]
    assert len(repair_completed) == 1
    assert repair_completed[0]["sequence"] < same_crew[0]["sequence"]
    assert repair_completed[0]["sim_time_days"] == pytest.approx(0.6)
    assert same_crew[0]["sim_time_days"] == pytest.approx(0.6)
    final = model.snapshot()
    assert final["maintenance_count"] == 1
    assert final["repair_count"] == 1
    assert final["operating_count"] == 1


def test_failure_supersedes_queued_scheduled_order_and_avoids_duplicate_maintenance() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [0.1]},
        failure_times_days={"aircraft-0001": [0.2, 10.0]},
        repair_durations_days=[0.5],
        scheduled_durations_days=[0.25],
    )
    model = module.AircraftSupportModel(
        parameters=_parameters(aircraft_count=1, part_initial_stock=2),
        horizon_days=2,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )
    events = _mechanism_events(_run_to_horizon(model))
    superseded = [e for e in events if e["event_type"] == "request_superseded"]
    assert len(superseded) == 1
    assert superseded[0]["sim_time_days"] == pytest.approx(0.2)
    assert superseded[0]["work_order_id"] == "work-00000001"
    assert superseded[0]["payload"]["request_kind"] == "scheduled"
    assert model.work_orders["work-00000001"].status is module.WorkStatus.SUPERSEDED
    failure = [e for e in events if e["event_type"] == "failure_occurred"]
    assert superseded[0]["sequence"] > failure[0]["sequence"]
    corrective_queued = [e for e in events if e["event_type"] == "request_queued" and e["work_order_id"] == "work-00000002"]
    assert len(corrective_queued) == 1
    assert superseded[0]["sequence"] < corrective_queued[0]["sequence"]
    started = [e for e in events if e["event_type"] == "maintenance_started"]
    assert len(started) == 1
    assert started[0]["payload"]["same_crew"] is True
    stale_assigned = [e for e in events if e["event_type"] == "team_assigned" and e["work_order_id"] == "work-00000001"]
    stale_started = [e for e in events if e["event_type"] == "maintenance_started" and e["work_order_id"] == "work-00000001"]
    assert stale_assigned == []
    assert stale_started == []
    final = model.snapshot()
    assert final["maintenance_count"] == 1
    assert final["repair_count"] == 1
    assert final["operating_count"] == 1
    assert final["scheduled_queue_length"] == 0


def test_same_crew_continuation_with_no_free_hangar_queues_and_recovers() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [0.1], "aircraft-0002": [0.1]},
        failure_times_days={"aircraft-0001": [0.2, 10.0], "aircraft-0002": [10.0]},
        repair_durations_days=[0.25],
        scheduled_durations_days=[0.25, 0.25],
    )
    model = module.AircraftSupportModel(
        parameters=_parameters(
            aircraft_count=2,
            team_count=2,
            hangar_count=1,
            part_initial_stock=2,
            part_reorder_point=0,
            part_order_quantity=1,
            part_lead_time_days=0.1,
        ),
        horizon_days=2,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )
    events = _run_to_horizon(model)
    final = model.snapshot()
    assert final["scheduled_queue_length"] == 0
    assert final["operating_count"] == 2
    assert final["maintenance_count"] >= 2
    assert not any(e["event_type"] == "part_backordered" for e in _mechanism_events(events))


def test_part_holding_cost_tracks_consumption() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [10.0]},
        failure_times_days={"aircraft-0001": [10.0]},
        repair_durations_days=[],
        scheduled_durations_days=[],
    )
    model = module.AircraftSupportModel(
        parameters=_parameters(
            aircraft_count=1,
            part_initial_stock=3,
            part_reorder_point=0,
            part_order_quantity=1,
            part_lead_time_days=0.1,
            part_holding_cost_per_day=2,
        ),
        horizon_days=1,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )
    _run_to_horizon(model)
    final = model.snapshot()
    assert final["part_stock"] == 3
    assert final["part_holding_cost"] == pytest.approx(6.0)


def test_part_holding_cost_after_consumption_drops_stock() -> None:
    module = _aircraft_module()
    fixture = module.ScenarioFixture(
        maintenance_due_times_days={"aircraft-0001": [10.0]},
        failure_times_days={"aircraft-0001": [0.1]},
        repair_durations_days=[0.5],
        scheduled_durations_days=[0.25],
    )
    model = module.AircraftSupportModel(
        parameters=_parameters(
            aircraft_count=1,
            part_initial_stock=2,
            part_reorder_point=0,
            part_order_quantity=1,
            part_lead_time_days=0.1,
            part_holding_cost_per_day=2,
        ),
        horizon_days=1,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )
    _run_to_horizon(model)
    final = model.snapshot()
    assert final["part_stock"] == 1
    assert final["part_holding_cost"] == pytest.approx(2.2)


def test_snapshot_exactly_matches_metric_schema() -> None:
    module = _aircraft_module()
    import json
    from pathlib import Path

    asset = Path(__file__).resolve().parents[1] / "src" / "mesa_service" / "model_assets" / "aircraft_support" / "metric-schema.json"
    metric_schema = json.loads(asset.read_text())
    model = module.AircraftSupportModel(
        parameters=_parameters(),
        horizon_days=1,
        warmup_days=0,
        seed=2,
        scenario_fixture=_microcase_fixture(module),
    )
    _run_to_horizon(model)
    snapshot = model.snapshot()
    assert set(metric_schema["required"]) == set(metric_schema["properties"]) == set(snapshot)
    assert metric_schema["additionalProperties"] is False


def test_exported_model_spec_matches_asset() -> None:
    module = _aircraft_module()
    import json
    from pathlib import Path

    asset = Path(__file__).resolve().parents[1] / "src" / "mesa_service" / "model_assets" / "aircraft_support" / "model-spec.json"
    spec_asset = json.loads(asset.read_text())
    assert spec_asset == module.MODEL_SPEC_DEFINITIONS


def test_parameter_schema_required_matches_parameter_ids() -> None:
    module = _aircraft_module()
    import json
    from pathlib import Path

    asset = Path(__file__).resolve().parents[1] / "src" / "mesa_service" / "model_assets" / "aircraft_support" / "parameter-schema.json"
    schema = json.loads(asset.read_text())
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"]) == set(module.PARAMETER_IDS)


def test_package_exports() -> None:
    package = importlib.import_module("mesa_service.models.aircraft_support")
    assert package.AircraftSupportModel is not None
    assert package.ScenarioFixture is not None
    assert package.MODEL_SPEC_DEFINITIONS["model_id"] == "aircraft-support"
