from __future__ import annotations

import importlib
import math
from typing import Any

import pytest


def _wind_module():
    return importlib.import_module("mesa_service.models.wind_turbine_maintenance.model")


def _parameters(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "turbine_count": 3,
        "crew_count": 1,
        "maintenance_period_days": 90,
        "normal_failure_rate_per_day": 0.03,
        "repair_low_hours": 12,
        "repair_mode_hours": 12,
        "repair_high_hours": 12,
        "maintenance_low_hours": 6,
        "maintenance_mode_hours": 6,
        "maintenance_high_hours": 6,
        "replacement_low_hours": 18,
        "replacement_mode_hours": 18,
        "replacement_high_hours": 18,
        "major_replacement_enabled": False,
        "major_replacement_probability": 0.1,
        "farm_width_km": 4,
        "farm_height_km": 1,
        "depot_x_km": 0,
        "depot_y_km": 0,
        "crew_speed_km_per_hour": 1 / 6,
        "daily_revenue_per_operating_turbine": 0,
        "crew_cost_per_day": 10,
        "repair_cost": 100,
        "maintenance_cost": 40,
        "replacement_cost": 500,
        "minimum_availability_fraction": 0.95,
    }
    values.update(overrides)
    return values


def _microcase_fixture(module):
    return module.ScenarioFixture(
        positions_km={
            "turbine-0001": (1.0, 0.0),
            "turbine-0002": (2.0, 0.0),
            "turbine-0003": (3.0, 0.0),
        },
        maintenance_due_times_days={
            "turbine-0001": [0.0],
            "turbine-0002": [0.1],
            "turbine-0003": [1.2],
        },
        failure_times_days={
            "turbine-0001": [10.0],
            "turbine-0002": [0.3, 10.0],
            "turbine-0003": [0.2, 10.0],
        },
        repair_durations_days=[0.5, 0.5],
        maintenance_durations_days=[0.25, 0.25, 0.25],
        replacement_durations_days=[],
        replacement_decisions=[False, False],
    )


def _run_to_horizon(model) -> list[dict[str, Any]]:
    events = list(model.drain_domain_events())
    while model.sim_time_days < model.horizon_days:
        model.step()
        events.extend(model.drain_domain_events())
    return events


def _mechanism_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event for event in events if event["event_type"] != "daily_snapshot"]


def _event_projection(event: dict[str, Any]) -> tuple[float, str, str | None, str | None]:
    return (
        float(event["sim_time_days"]),
        event["event_type"],
        event.get("turbine_id"),
        event.get("crew_id"),
    )


def _snapshot_payload(event: dict[str, Any]) -> dict[str, Any]:
    payload = event["payload"]
    return payload.get("snapshot", payload)


def test_three_turbine_microcase_exact_events_daily_snapshots_and_kpis() -> None:
    module = _wind_module()
    model = module.WindTurbineMaintenanceModel(
        parameters=_parameters(),
        horizon_days=4,
        warmup_days=0,
        seed=2,
        scenario_fixture=_microcase_fixture(module),
    )

    events = _run_to_horizon(model)
    mechanism = _mechanism_events(events)
    assert [_event_projection(event) for event in mechanism] == [
        (0.0, "maintenance_due", "turbine-0001", None),
        (0.0, "request_queued", "turbine-0001", None),
        (0.0, "crew_dispatched", "turbine-0001", "crew-001"),
        (0.1, "maintenance_due", "turbine-0002", None),
        (0.1, "request_queued", "turbine-0002", None),
        (0.2, "failure_occurred", "turbine-0003", None),
        (0.2, "request_queued", "turbine-0003", None),
        (0.25, "crew_arrived", "turbine-0001", "crew-001"),
        (0.25, "maintenance_started", "turbine-0001", "crew-001"),
        (0.3, "failure_occurred", "turbine-0002", None),
        (0.3, "request_superseded", "turbine-0002", None),
        (0.3, "request_queued", "turbine-0002", None),
        (0.5, "maintenance_completed", "turbine-0001", "crew-001"),
        (0.5, "crew_dispatched", "turbine-0003", "crew-001"),
        (1.0, "crew_arrived", "turbine-0003", "crew-001"),
        (1.0, "repair_started", "turbine-0003", "crew-001"),
        (1.2, "maintenance_due", "turbine-0003", None),
        (1.2, "request_suppressed", "turbine-0003", None),
        (1.5, "repair_completed", "turbine-0003", "crew-001"),
        (1.5, "maintenance_started", "turbine-0003", "crew-001"),
        (1.75, "maintenance_completed", "turbine-0003", "crew-001"),
        (1.75, "crew_dispatched", "turbine-0002", "crew-001"),
        (2.0, "crew_arrived", "turbine-0002", "crew-001"),
        (2.0, "repair_started", "turbine-0002", "crew-001"),
        (2.5, "repair_completed", "turbine-0002", "crew-001"),
        (2.5, "maintenance_started", "turbine-0002", "crew-001"),
        (2.75, "maintenance_completed", "turbine-0002", "crew-001"),
        (2.75, "crew_return_started", None, "crew-001"),
        (3.25, "crew_returned", None, "crew-001"),
    ]
    assert [event["sequence"] for event in events] == list(range(1, 35))
    assert len(events) == 34

    # The hand oracle is semantic evidence, not merely an event-name list.
    # Every mechanism row fixes phase, deterministic IDs, lineage, state
    # transition, and payload. Snapshot events account for sequence gaps.
    expected_semantics = [
        (1, 10, None, None, None, None, {}),
        (2, 10, "work-00000001", None, None, None, {"request_kind": "planned"}),
        (3, 40, "work-00000001", None, "idle", "driving_to_work", {"request_kind": "planned", "eta_days": 0.25}),
        (5, 10, None, None, None, None, {}),
        (6, 10, "work-00000002", None, None, None, {"request_kind": "planned"}),
        (7, 10, None, None, "operating", "failed_waiting", {}),
        (8, 10, "work-00000003", None, None, None, {"request_kind": "corrective"}),
        (9, 30, "work-00000001", None, "driving_to_work", "working", {}),
        (10, 30, "work-00000001", None, "operating", "planned_maintenance", {"same_crew": False}),
        (11, 10, None, None, "operating", "failed_waiting", {}),
        (12, 10, "work-00000002", None, None, None, {"request_kind": "planned"}),
        (13, 10, "work-00000004", None, None, None, {"request_kind": "corrective"}),
        (14, 20, "work-00000001", None, "planned_maintenance", "operating", {"cost": 40.0}),
        (15, 40, "work-00000003", None, "idle", "driving_to_work", {"request_kind": "corrective", "eta_days": 1.0}),
        (16, 30, "work-00000003", None, "driving_to_work", "working", {}),
        (17, 30, "work-00000003", None, "failed_waiting", "corrective_repair", {"same_crew": False}),
        (19, 10, None, None, None, None, {}),
        (20, 10, None, "event-00000019", None, None, {"reason": "crew_already_assigned"}),
        (21, 20, "work-00000003", None, "corrective_repair", "planned_maintenance", {"cost": 100.0}),
        (22, 20, "work-00000005", "work-00000003", "corrective_repair", "planned_maintenance", {"same_crew": True}),
        (23, 20, "work-00000005", "work-00000003", "planned_maintenance", "operating", {"cost": 40.0}),
        (24, 40, "work-00000004", None, "idle", "driving_to_work", {"request_kind": "corrective", "eta_days": 2.0}),
        (25, 30, "work-00000004", None, "driving_to_work", "working", {}),
        (26, 30, "work-00000004", None, "failed_waiting", "corrective_repair", {"same_crew": False}),
        (28, 20, "work-00000004", None, "corrective_repair", "planned_maintenance", {"cost": 100.0}),
        (29, 20, "work-00000006", "work-00000004", "corrective_repair", "planned_maintenance", {"same_crew": True}),
        (30, 20, "work-00000006", "work-00000004", "planned_maintenance", "operating", {"cost": 40.0}),
        (31, 20, None, None, "working", "driving_home", {"eta_days": 3.25}),
        (33, 30, None, None, "driving_home", "idle", {}),
    ]
    semantic_keys = {
        "event_id", "sequence", "sim_time_days", "event_type", "phase",
        "turbine_id", "crew_id", "work_order_id", "correlation_id",
        "before_state", "after_state", "payload",
    }
    for event, expected in zip(mechanism, expected_semantics, strict=True):
        sequence, phase, work_order_id, correlation_id, before_state, after_state, payload = expected
        assert set(event) == semantic_keys
        assert event["event_id"] == f"event-{sequence:08d}"
        assert event["sequence"] == sequence
        assert event["phase"] == phase
        assert event["work_order_id"] == work_order_id
        assert event["correlation_id"] == correlation_id
        assert event["before_state"] == before_state
        assert event["after_state"] == after_state
        assert event["payload"] == payload

    suppressed = next(event for event in mechanism if event["event_type"] == "request_suppressed")
    assert suppressed["payload"]["reason"] == "crew_already_assigned"
    same_crew = [
        event
        for event in mechanism
        if event["event_type"] == "maintenance_started" and event["turbine_id"] in {"turbine-0002", "turbine-0003"}
    ]
    assert all(event["payload"]["same_crew"] is True for event in same_crew)

    daily = [event for event in events if event["event_type"] == "daily_snapshot"]
    assert [event["sim_time_days"] for event in daily] == [0, 1, 2, 3, 4]
    expected_daily = [
        (1.0, 0.0, 0.0, 3, 0, 0),
        (1.25 / 3, 1.0, 50.0, 1, 1, 1),
        (2.5 / 6, 1.0, 200.0, 2, 1, 0),
        (4.75 / 9, 1.0, 350.0, 3, 0, 0),
        (7.75 / 12, 3.25 / 4, 360.0, 3, 0, 0),
    ]
    for event, expected in zip(daily, expected_daily, strict=True):
        row = _snapshot_payload(event)
        availability, utilization, cost, operating, repair, corrective_queue = expected
        assert row["availability_fraction"] == pytest.approx(availability)
        assert row["crew_utilization_fraction"] == pytest.approx(utilization)
        assert row["total_maintenance_cost"] == pytest.approx(cost)
        assert row["operating_count"] == operating
        assert row["corrective_repair_count"] == repair
        assert row["corrective_queue_length"] == corrective_queue
        assert sum(row[name] for name in ("operating_count", "failed_waiting_count", "corrective_repair_count", "planned_maintenance_count", "major_replacement_count")) == 3
        assert sum(row[name] for name in ("idle_crew_count", "driving_to_work_crew_count", "working_crew_count", "driving_home_crew_count")) == 1
        assert 0 <= row["availability_fraction"] <= 1
        assert 0 <= row["crew_utilization_fraction"] <= 1
        assert row["corrective_queue_length"] >= 0 and row["planned_queue_length"] >= 0
        assert row["work_cost"] >= 0 and row["crew_cost"] >= 0 and row["total_maintenance_cost"] >= 0

    final = model.snapshot()
    assert final["operating_count"] == 3
    assert final["idle_crew_count"] == 1
    assert final["corrective_queue_length"] == 0
    assert final["planned_queue_length"] == 0
    assert final["operating_turbine_days"] == pytest.approx(7.75)
    assert final["failed_waiting_turbine_days"] == pytest.approx(2.5)
    assert final["corrective_repair_turbine_days"] == pytest.approx(1.0)
    assert final["planned_maintenance_turbine_days"] == pytest.approx(0.75)
    assert final["major_replacement_turbine_days"] == 0
    assert final["idle_crew_days"] == pytest.approx(0.75)
    assert final["crew_driving_days"] == pytest.approx(1.5)
    assert final["crew_working_days"] == pytest.approx(1.75)
    assert final["availability_numerator"] == pytest.approx(7.75)
    assert final["availability_denominator"] == 12
    assert final["crew_utilization_numerator"] == pytest.approx(3.25)
    assert final["crew_utilization_denominator"] == 4
    assert final["corrective_wait_sample_count"] == 2
    assert final["corrective_wait_mean_days"] == pytest.approx(1.25)
    assert final["corrective_wait_p95_days"] == pytest.approx(1.7)
    assert final["maintenance_overdue_sample_count"] == 3
    assert final["maintenance_overdue_mean_days"] == pytest.approx(0.9833333333333333)
    assert final["maintenance_overdue_p95_days"] == pytest.approx(2.4)
    assert final["repair_count"] == 2
    assert final["maintenance_count"] == 3
    assert final["replacement_count"] == 0
    assert final["work_cost"] == 320
    assert final["crew_cost"] == 40
    assert final["total_maintenance_cost"] == 360
    assert all(math.isfinite(value) for value in final.values() if isinstance(value, (int, float)))
    assigned = [order.assigned_crew_id for order in model.work_orders.values() if order.status.value in {"assigned", "in_progress"}]
    assert len(assigned) == len(set(assigned))
    assert all(order.requested_at_days >= 0 for order in model.work_orders.values())


def test_inflight_planned_trip_failure_converts_to_corrective_without_deadlock_and_retains_lineage() -> None:
    module = _wind_module()
    fixture = module.ScenarioFixture(
        positions_km={"turbine-0001": (1.0, 0.0)},
        maintenance_due_times_days={"turbine-0001": [0.0, 10.0]},
        failure_times_days={"turbine-0001": [0.1, 10.0]},
        repair_durations_days=[0.5],
        maintenance_durations_days=[0.25],
        replacement_durations_days=[],
        replacement_decisions=[False],
    )
    model = module.WindTurbineMaintenanceModel(
        parameters=_parameters(turbine_count=1), horizon_days=2, warmup_days=0, seed=2, scenario_fixture=fixture
    )
    events = _mechanism_events(_run_to_horizon(model))
    planned = model.work_orders["work-00000001"]
    corrective = model.work_orders["work-00000002"]
    assert planned.status.value == "superseded"
    assert planned.superseded_by_order_id == corrective.work_order_id
    assert corrective.source_event_id == next(event["event_id"] for event in events if event["event_type"] == "failure_occurred")
    assert corrective.assigned_crew_id == "crew-001"
    assert corrective.status.value == "completed"
    assert any(event["event_type"] == "crew_arrived" and event["work_order_id"] == corrective.work_order_id for event in events)
    assert any(event["event_type"] == "repair_completed" and event["work_order_id"] == corrective.work_order_id for event in events)
    assert model.crews["crew-001"].state.value == "idle"
    assert model.crews["crew-001"].current_work_order_id is None
    assert model.turbines["turbine-0001"].state.value == "operating"
    assert model.snapshot()["corrective_queue_length"] == 0


def test_completion_cannot_schedule_request_trigger_into_already_finished_same_time_phase() -> None:
    module = _wind_module()
    fixture = module.ScenarioFixture(
        positions_km={"turbine-0001": (0.0, 0.0)},
        maintenance_due_times_days={"turbine-0001": [10.0]},
        failure_times_days={"turbine-0001": [0.1, 0.2]},
        repair_durations_days=[0.1],
        maintenance_durations_days=[],
        replacement_durations_days=[],
        replacement_decisions=[False],
    )
    model = module.WindTurbineMaintenanceModel(
        parameters=_parameters(turbine_count=1), horizon_days=1, warmup_days=0, seed=2, scenario_fixture=fixture
    )
    with pytest.raises(RuntimeError, match="already-finished.*phase|finished lower phase"):
        model.step()


def test_zero_operation_duration_fixture_fails_instead_of_creating_same_time_phase_loop() -> None:
    module = _wind_module()
    fixture = module.ScenarioFixture(
        positions_km={"turbine-0001": (0.0, 0.0)},
        maintenance_due_times_days={"turbine-0001": [0.0]},
        failure_times_days={"turbine-0001": [10.0]},
        repair_durations_days=[],
        maintenance_durations_days=[0.0],
        replacement_durations_days=[],
        replacement_decisions=[],
    )
    with pytest.raises(ValueError, match="positive"):
        module.WindTurbineMaintenanceModel(
            parameters=_parameters(turbine_count=1), horizon_days=1, warmup_days=0, seed=2, scenario_fixture=fixture
        )


def test_snapshot_exactly_matches_metric_schema_and_reports_right_censoring_and_crew_fractions() -> None:
    module = _wind_module()
    contracts = importlib.import_module("mesa_service.wind_contracts")
    metric_schema = contracts.load_json_asset("metric-schema.json")
    fixture = module.ScenarioFixture(
        positions_km={"turbine-0001": (4.0, 0.0)},
        maintenance_due_times_days={"turbine-0001": [10.0]},
        failure_times_days={"turbine-0001": [0.5]},
        repair_durations_days=[0.5],
        maintenance_durations_days=[],
        replacement_durations_days=[],
        replacement_decisions=[False],
    )
    model = module.WindTurbineMaintenanceModel(
        parameters=_parameters(turbine_count=1), horizon_days=1, warmup_days=0, seed=2, scenario_fixture=fixture
    )
    _run_to_horizon(model)
    snapshot = model.snapshot()
    assert set(metric_schema["required"]) == set(metric_schema["properties"]) == set(snapshot)
    assert metric_schema["additionalProperties"] is False
    assert snapshot["corrective_wait_sample_count"] == 0
    assert snapshot["corrective_wait_censored_count"] == 1
    assert snapshot["maintenance_overdue_sample_count"] == 0
    assert snapshot["maintenance_overdue_censored_count"] == 0
    assert snapshot["availability_fraction"] == pytest.approx(0.5)
    assert snapshot["crew_driving_fraction"] == pytest.approx(0.5)
    assert snapshot["crew_working_fraction"] == 0
    assert snapshot["crew_returning_fraction"] == 0


def test_forced_major_replacement_exact_edge_oracle_and_resampling() -> None:
    module = _wind_module()
    fixture = module.ScenarioFixture(
        positions_km={"turbine-0001": (1.0, 0.0)},
        maintenance_due_times_days={"turbine-0001": [10.0]},
        failure_times_days={"turbine-0001": [0.1, 10.0]},
        repair_durations_days=[],
        maintenance_durations_days=[],
        replacement_durations_days=[0.75],
        replacement_decisions=[True],
    )
    model = module.WindTurbineMaintenanceModel(
        parameters=_parameters(turbine_count=1, major_replacement_enabled=True, major_replacement_probability=1.0),
        horizon_days=2,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )

    events = _mechanism_events(_run_to_horizon(model))
    assert [_event_projection(event) for event in events] == [
        (0.1, "failure_occurred", "turbine-0001", None),
        (0.1, "request_queued", "turbine-0001", None),
        (0.1, "crew_dispatched", "turbine-0001", "crew-001"),
        (0.35, "crew_arrived", "turbine-0001", "crew-001"),
        (0.35, "replacement_started", "turbine-0001", "crew-001"),
        (1.1, "replacement_completed", "turbine-0001", "crew-001"),
        (1.1, "crew_return_started", None, "crew-001"),
        (1.35, "crew_returned", None, "crew-001"),
    ]
    assert not {"repair_started", "repair_completed"} & {event["event_type"] for event in events}
    final = model.snapshot()
    assert final["operating_turbine_days"] == pytest.approx(1.0)
    assert final["failed_waiting_turbine_days"] == pytest.approx(0.25)
    assert final["major_replacement_turbine_days"] == pytest.approx(0.75)
    assert final["availability_fraction"] == pytest.approx(0.5)
    assert final["crew_driving_days"] == pytest.approx(0.5)
    assert final["crew_working_days"] == pytest.approx(0.75)
    assert final["idle_crew_days"] == pytest.approx(0.75)
    assert final["crew_utilization_fraction"] == pytest.approx(0.625)
    assert final["work_cost"] == 500
    assert final["crew_cost"] == 20
    assert final["total_maintenance_cost"] == 520
    assert final["replacement_count"] == 1
    assert final["failure_delay_sample_count"] == 2
    turbine = model.turbines["turbine-0001"]
    assert turbine.time_last_maintenance_days == pytest.approx(1.1)
    assert turbine.time_last_replacement_days == pytest.approx(1.1)
    assert turbine.maintenance_due_at_days == pytest.approx(91.1)


def test_maintenance_due_during_replacement_is_suppressed_then_reset_without_censoring() -> None:
    module = _wind_module()
    fixture = module.ScenarioFixture(
        positions_km={"turbine-0001": (0.0, 0.0)},
        maintenance_due_times_days={"turbine-0001": [0.3]},
        failure_times_days={"turbine-0001": [0.1, 10.0]},
        repair_durations_days=[],
        maintenance_durations_days=[],
        replacement_durations_days=[0.5],
        replacement_decisions=[True],
    )
    model = module.WindTurbineMaintenanceModel(
        parameters=_parameters(
            turbine_count=1,
            major_replacement_enabled=True,
            major_replacement_probability=1.0,
        ),
        horizon_days=1,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )

    events = _mechanism_events(_run_to_horizon(model))
    suppressed = [event for event in events if event["event_type"] == "request_suppressed"]
    assert len(suppressed) == 1
    assert suppressed[0]["sim_time_days"] == pytest.approx(0.3)
    assert suppressed[0]["payload"] == {"reason": "crew_already_assigned"}
    assert any(event["event_type"] == "replacement_started" and event["sim_time_days"] == pytest.approx(0.1) for event in events)
    assert any(event["event_type"] == "replacement_completed" and event["sim_time_days"] == pytest.approx(0.6) for event in events)
    assert not any(event["event_type"] == "maintenance_started" for event in events)

    turbine = model.turbines["turbine-0001"]
    assert turbine.state.value == "operating"
    assert turbine.active_planned_order_id is None
    assert turbine.maintenance_due_at_days == pytest.approx(90.6)
    assert turbine.time_last_maintenance_days == pytest.approx(0.6)
    assert turbine.time_last_replacement_days == pytest.approx(0.6)
    final = model.snapshot()
    assert final["replacement_count"] == 1
    assert final["maintenance_overdue_sample_count"] == 0
    assert final["maintenance_overdue_censored_count"] == 0


def test_simultaneous_phase_order_lifo_within_phase_and_stable_crew_assignment() -> None:
    module = _wind_module()
    fixture = module.ScenarioFixture(
        positions_km={"turbine-0001": (0.0, 0.0), "turbine-0002": (0.0, 0.0)},
        maintenance_due_times_days={"turbine-0001": [10.0], "turbine-0002": [10.0]},
        failure_times_days={"turbine-0001": [0.1], "turbine-0002": [0.1]},
        repair_durations_days=[0.5, 0.5],
        maintenance_durations_days=[],
        replacement_durations_days=[],
        replacement_decisions=[False, False],
    )
    model = module.WindTurbineMaintenanceModel(
        parameters=_parameters(turbine_count=2, crew_count=2),
        horizon_days=1,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )

    events = _mechanism_events(_run_to_horizon(model))
    at_failure_time = [event for event in events if event["sim_time_days"] == pytest.approx(0.1)]
    assert [event["phase"] for event in at_failure_time] == sorted(event["phase"] for event in at_failure_time)
    failures = [event for event in at_failure_time if event["event_type"] == "failure_occurred"]
    assert [event["turbine_id"] for event in failures] == ["turbine-0002", "turbine-0001"]
    dispatches = [event for event in at_failure_time if event["event_type"] == "crew_dispatched"]
    assert [(event["crew_id"], event["turbine_id"]) for event in dispatches] == [
        ("crew-001", "turbine-0002"),
        ("crew-002", "turbine-0001"),
    ]
    arrivals = [event for event in at_failure_time if event["event_type"] == "crew_arrived"]
    assert len(arrivals) == 2  # zero-distance dispatch executes arrival inline in phase 40
    assert len({event["work_order_id"] for event in dispatches}) == 2
    assert len({event["crew_id"] for event in dispatches}) == 2


def test_failure_is_sampled_on_operating_entry_and_stale_generation_token_is_silent() -> None:
    module = _wind_module()
    fixture = module.ScenarioFixture(
        positions_km={"turbine-0001": (0.0, 0.0)},
        maintenance_due_times_days={"turbine-0001": [0.0]},
        failure_times_days={"turbine-0001": [0.2, 10.0]},
        repair_durations_days=[],
        maintenance_durations_days=[0.15],
        replacement_durations_days=[],
        replacement_decisions=[],
    )
    model = module.WindTurbineMaintenanceModel(
        parameters=_parameters(turbine_count=1),
        horizon_days=1,
        warmup_days=0,
        seed=2,
        scenario_fixture=fixture,
    )

    events = _mechanism_events(_run_to_horizon(model))
    assert [event for event in events if event["event_type"] == "failure_occurred"] == []
    assert [event["event_type"] for event in events[:5]] == [
        "maintenance_due",
        "request_queued",
        "crew_dispatched",
        "crew_arrived",
        "maintenance_started",
    ]
    final = model.snapshot()
    assert final["failure_delay_sample_count"] == 2
    assert final["stale_scheduled_event_count"] == 1
    assert final["failure_count"] == 0
    assert final["operating_count"] == 1


@pytest.mark.parametrize(
    ("overrides", "message_fragment"),
    [
        ({"repair_low_hours": 13, "repair_mode_hours": 12}, "repair"),
        ({"maintenance_mode_hours": 7, "maintenance_high_hours": 6}, "maintenance"),
        ({"depot_x_km": 5}, "depot"),
        ({"normal_failure_rate_per_day": math.inf}, "finite"),
    ],
)
def test_model_rejects_invalid_cross_field_and_nonfinite_parameters(overrides: dict[str, Any], message_fragment: str) -> None:
    module = _wind_module()
    with pytest.raises((TypeError, ValueError), match=message_fragment):
        module.WindTurbineMaintenanceModel(
            parameters=_parameters(**overrides),
            horizon_days=4,
            warmup_days=0,
            seed=2,
        )
