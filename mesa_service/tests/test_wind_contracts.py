from __future__ import annotations

import hashlib
import importlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


SOURCE_SHA256 = "2153fbf23348ece013f7d72bf0064e5d01ac52273bebf560520bb35047734755"
CLAIM_LABELS = {
    "synthetic_inputs",
    "single_seed",
    "behavioral_reproduction_not_runtime_equivalence",
    "draft_unverified",
    "no_staffing_recommendation",
}
PARAMETER_KEYS = {
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
}


def _contracts():
    return importlib.import_module("mesa_service.wind_contracts")


def _bundle():
    return importlib.import_module("mesa_service.bundle")


def _verifier():
    return importlib.import_module("mesa_service.verify_bundle")


def _canonical_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def test_exported_spec_covers_source_dispositions_adaptation_and_exclusions() -> None:
    contracts = _contracts()
    spec = contracts.load_json_asset("model-spec.json")
    traceability = contracts.load_json_asset("traceability.json")
    provenance = contracts.load_json_asset("provenance.json")

    assert provenance["source"]["sha256"] == SOURCE_SHA256
    assert provenance["source"]["declared_anylogic_version"] == "8.4.0.qualifier"
    assert provenance["source"]["package_version"] == "8.9.0.202404161223"
    assert provenance["copied_source_code"] is False
    assert set(provenance["excluded_assets"]) >= {"java", "images", "logo", "3d_assets"}

    equipment = {row["source_transition"]: row["disposition"] for row in traceability["equipment_transitions"]}
    crew = {row["source_transition"]: row["disposition"] for row in traceability["crew_transitions"]}
    assert set(equipment) == {
        "Failure",
        "SCArrivedForRepair",
        "FinishRepair",
        "StartReplacement",
        "FinishReplacement",
        "FinishMaintenance",
        "SCArrivedForMtce",
        "StartRepair",
        "transition",
        "MaintenanceDue",
        "PlannedReplacement",
        "StartMaintenance",
    }
    assert set(crew) == {
        "CheckRequestQueue",
        "Arrived",
        "Finished",
        "ArrivedHome",
        "RequestsWaiting",
        "NoRequests",
        "IAmOK",
        "IAmLaidOff",
        "CheckIfLaidOff",
    }
    assert equipment["PlannedReplacement"] == "deferred"
    assert crew["IAmLaidOff"] == "deferred"
    assert crew["CheckIfLaidOff"] == "deferred"
    assert traceability["simultaneous_event_rule"]["disposition"] == "adapted"
    assert "corrective" in traceability["simultaneous_event_rule"]["reason"].lower()
    assert spec["model_id"] == "wind-turbine-maintenance"
    assert spec["event_ordering"]["heap_key"] == ["sim_time_days", "phase", "negative_schedule_sequence"]
    assert spec["distribution_families"] == {
        "failure": "exponential",
        "repair": "triangular",
        "maintenance": "triangular",
        "replacement": "triangular",
    }
    assert spec["proactive_age_replacement"] == "excluded"


def test_parameter_metric_and_preset_schemas_are_exact_and_strict() -> None:
    contracts = _contracts()
    parameter_schema = contracts.load_json_asset("parameter-schema.json")
    metric_schema = contracts.load_json_asset("metric-schema.json")
    demo = contracts.load_json_asset("defaults/wind-turbine-maintenance-demo-v1.json")
    source = contracts.load_json_asset("defaults/source-field-service-reference.json")

    assert parameter_schema["additionalProperties"] is False
    assert set(parameter_schema["properties"]) == PARAMETER_KEYS
    assert set(parameter_schema["required"]) == PARAMETER_KEYS
    assert demo["preset_id"] == "wind-turbine-maintenance-demo-v1"
    assert demo["parameters"]["turbine_count"] == 100
    assert demo["parameters"]["crew_count"] == 3
    assert demo["horizon_days"] == 1095
    assert demo["warmup_days"] == 365
    assert demo["seed"] == 2
    assert set(demo["claim_labels"]) == CLAIM_LABELS
    assert source["executable"] is False
    assert source["seed"] == 2
    assert source["horizon_days"] == 18250
    assert source["proactive_replacement_enabled"] is False
    assert source["mtce_periods_to_replace"] == 5

    required_metrics = {
        "availability_fraction",
        "availability_numerator",
        "availability_denominator",
        "crew_utilization_fraction",
        "crew_utilization_numerator",
        "crew_utilization_denominator",
        "measurement_window_elapsed_days",
        "measurement_window_observed",
        "corrective_wait_mean_days",
        "corrective_wait_p95_days",
        "maintenance_overdue_mean_days",
        "maintenance_overdue_p95_days",
        "work_cost",
        "crew_cost",
        "total_maintenance_cost",
        "operating_revenue",
    }
    assert required_metrics <= set(metric_schema["properties"])
    assert metric_schema["additionalProperties"] is False

    contracts.validate_experiment_document(demo)
    for patch in (
        {"seed": [2]},
        {"seed": 2, "extra": True},
        {"horizon_days": 3661},
        {"horizon_days": 365, "warmup_days": 365},
    ):
        invalid = {**demo, **patch}
        with pytest.raises(contracts.ContractValidationError):
            contracts.validate_experiment_document(invalid)

    invalid_parameters = json.loads(json.dumps(demo))
    invalid_parameters["parameters"]["repair_low_hours"] = 13
    invalid_parameters["parameters"]["repair_mode_hours"] = 12
    with pytest.raises(contracts.ContractValidationError):
        contracts.validate_experiment_document(invalid_parameters)


def test_content_addressed_bundle_and_experiment_revisions_are_idempotent(tmp_path: Path) -> None:
    bundle = _bundle()
    first = bundle.materialize_reviewed_bundle(tmp_path / "workspace")
    second = bundle.materialize_reviewed_bundle(tmp_path / "workspace")

    assert first["model_id"] == "wind-turbine-maintenance"
    assert first["model_revision_id"] == second["model_revision_id"]
    assert first["experiment_revision_id"] == second["experiment_revision_id"]
    assert first["model_revision_id"].startswith("mr_")
    assert len(first["model_revision_id"]) == 67
    assert first["experiment_revision_id"].startswith("er_")
    assert len(first["experiment_revision_id"]) == 67
    assert first["experiment"]["brief_revision_id"] is None
    assert first["experiment"]["alignment_revision_id"] is None
    assert first["experiment"]["workflow_policy"] == "workflow_policy_unmet"
    assert first["experiment"]["trust_label"] == "draft_unverified"

    bundle_dir = Path(first["bundle_dir"])
    manifest = json.loads((bundle_dir / "manifest.json").read_text())
    expected_files = {
        "model.py",
        "model-spec.json",
        "parameter-schema.json",
        "metric-schema.json",
        "visualization.json",
        "traceability.json",
        "provenance.json",
        "defaults/source-field-service-reference.json",
        "defaults/wind-turbine-maintenance-demo-v1.json",
        "tests/microcase.json",
        "tests/source-transition-disposition.json",
    }
    assert set(manifest["files"]) == expected_files
    for relative, declaration in manifest["files"].items():
        data = (bundle_dir / relative).read_bytes()
        assert len(data) == declaration["byte_length"]
        assert hashlib.sha256(data).hexdigest() == declaration["sha256"]


def test_spec_or_traceability_drift_and_manifest_tampering_fail_closed(tmp_path: Path) -> None:
    bundle = _bundle()
    verifier = _verifier()
    materialized = bundle.materialize_reviewed_bundle(tmp_path / "source")
    pristine = Path(materialized["bundle_dir"])
    assert verifier.verify_bundle(pristine)["valid"] is True

    for relative in ("model-spec.json", "traceability.json", "model.py"):
        drifted = tmp_path / relative.replace("/", "-")
        shutil.copytree(pristine, drifted)
        target = drifted / relative
        target.write_bytes(target.read_bytes() + b"\n")
        with pytest.raises(verifier.BundleVerificationError):
            verifier.verify_bundle(drifted)

    linked = tmp_path / "linked-bundle"
    linked.symlink_to(pristine, target_is_directory=True)
    with pytest.raises(verifier.BundleVerificationError):
        verifier.verify_bundle(linked)


def test_verify_bundle_module_cli_verifies_pristine_and_fails_tampering(tmp_path: Path) -> None:
    bundle = _bundle()
    materialized = bundle.materialize_reviewed_bundle(tmp_path / "source")
    pristine = Path(materialized["bundle_dir"])
    verified = subprocess.run(
        [sys.executable, "-m", "mesa_service.verify_bundle", str(pristine)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert verified.returncode == 0, verified.stderr
    assert json.loads(verified.stdout)["valid"] is True

    drifted_parent = tmp_path / "drifted"
    drifted = drifted_parent / pristine.name
    shutil.copytree(pristine, drifted)
    spec = drifted / "model-spec.json"
    spec.write_bytes(spec.read_bytes() + b"\n")
    rejected = subprocess.run(
        [sys.executable, "-m", "mesa_service.verify_bundle", str(drifted)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert rejected.returncode != 0
    assert "drift" in rejected.stderr.lower() or "verification" in rejected.stderr.lower()


def test_canonical_json_rejects_nonfinite_and_is_order_stable() -> None:
    contracts = _contracts()
    left = {"b": 2, "a": {"z": 1.0, "x": "wind"}}
    right = {"a": {"x": "wind", "z": 1.0}, "b": 2}
    assert contracts.canonical_json_bytes(left) == contracts.canonical_json_bytes(right)
    assert contracts.canonical_json_bytes(left) == _canonical_bytes(left)
    with pytest.raises((TypeError, ValueError)):
        contracts.canonical_json_bytes({"bad": float("nan")})
