from __future__ import annotations

import csv
import hashlib
import importlib
import importlib.metadata
import json
import math
import shutil
from pathlib import Path
from typing import Any

import pytest


PRESET_ID = "wind-turbine-maintenance-demo-v1"
CLAIM_LABELS = {
    "synthetic_inputs",
    "single_seed",
    "behavioral_reproduction_not_runtime_equivalence",
    "draft_unverified",
    "no_staffing_recommendation",
}


def _load(path: Path, name: str) -> dict[str, Any]:
    return json.loads((path / name).read_text())


def _baseline_api():
    runner = importlib.import_module("mesa_service.run_baseline")
    verifier = importlib.import_module("mesa_service.verify_run")
    return runner.run_baseline, verifier.verify_run, verifier.RunVerificationError


def _assert_finite(value: Any) -> None:
    if isinstance(value, dict):
        for nested in value.values():
            _assert_finite(nested)
    elif isinstance(value, list):
        for nested in value:
            _assert_finite(nested)
    elif isinstance(value, float):
        assert math.isfinite(value)


def _write_canonical(path: Path, value: dict[str, Any]) -> None:
    worker = importlib.import_module("mesa_service.wind_worker")
    path.write_bytes(worker.canonical_json_bytes(value) + b"\n")


def _reseal_mutated_run(run_dir: Path) -> None:
    """Refresh every dependent digest so schema tests cannot pass via hash drift."""

    worker = importlib.import_module("mesa_service.wind_worker")
    metadata = _load(run_dir, "metadata.json")
    profile = metadata["runtime_profile"]
    events = [json.loads(line) for line in (run_dir / "domain-events.jsonl").read_text().splitlines()]
    semantic_events = hashlib.sha256()
    for event in events:
        semantic_events.update(worker.canonical_json_bytes(worker._semantic_event_projection(event, profile)))
    canonical_event = semantic_events.hexdigest()
    daily_semantic = worker._daily_semantic_digest(run_dir / "daily-kpis.csv")
    summary = _load(run_dir, "summary.json")
    summary_semantic = worker.sha256_bytes(worker.canonical_json_bytes(worker._semantic_without_run_context(summary)))

    replay = _load(run_dir, "replay-manifest.json")
    replay["source_sha256"] = worker.sha256_file(run_dir / "domain-events.jsonl")
    replay["canonical_event_sha256"] = canonical_event
    replay["event_count"] = len(events)
    _write_canonical(run_dir / "replay-manifest.json", replay)
    derived = _load(run_dir, "derived-views-manifest.json")
    derived["inputs"]["canonical_event_sha256"] = canonical_event
    derived["inputs"]["daily_kpis_semantic_sha256"] = daily_semantic
    derived["inputs"]["summary_semantic_sha256"] = summary_semantic
    _write_canonical(run_dir / "derived-views-manifest.json", derived)

    metadata["emitted_domain_event_count"] = len(events)
    metadata["digests"].update(
        {
            "domain_events_sha256": worker.sha256_file(run_dir / "domain-events.jsonl"),
            "canonical_event_sha256": canonical_event,
            "daily_kpis_sha256": worker.sha256_file(run_dir / "daily-kpis.csv"),
            "daily_kpis_semantic_sha256": daily_semantic,
            "summary_sha256": worker.sha256_file(run_dir / "summary.json"),
            "summary_semantic_sha256": summary_semantic,
            "replay_manifest_sha256": worker.sha256_file(run_dir / "replay-manifest.json"),
            "derived_views_manifest_sha256": worker.sha256_file(run_dir / "derived-views-manifest.json"),
        }
    )
    _write_canonical(run_dir / "metadata.json", metadata)


def test_full_fixed_baseline_twice_has_stable_canonical_evidence_and_no_reduction(tmp_path: Path) -> None:
    run_baseline, verify_run, _ = _baseline_api()
    first = Path(run_baseline(output_dir=tmp_path / "first", preset_id=PRESET_ID))
    second = Path(run_baseline(output_dir=tmp_path / "second", preset_id=PRESET_ID))
    assert verify_run(first)["valid"] is True
    assert verify_run(second)["valid"] is True

    first_request = _load(first, "request.json")
    first_metadata = _load(first, "metadata.json")
    first_summary = _load(first, "summary.json")
    second_metadata = _load(second, "metadata.json")
    second_summary = _load(second, "summary.json")

    assert first_request["preset_id"] == PRESET_ID
    assert first_request["parameters"]["turbine_count"] == 100
    assert first_request["parameters"]["crew_count"] == 3
    assert first_request["horizon_days"] == 1095
    assert first_request["warmup_days"] == 365
    assert first_request["seed"] == 2
    assert first_metadata["status"] == second_metadata["status"] == "succeeded"
    assert first_metadata["run_id"] != second_metadata["run_id"]
    assert first_metadata["model_revision_id"] == second_metadata["model_revision_id"]
    assert first_metadata["experiment_revision_id"] == second_metadata["experiment_revision_id"]
    assert first_metadata["runtime_profile"] == second_metadata["runtime_profile"]
    assert first_metadata["runtime_profile"]["python_implementation"] == "CPython"
    assert first_metadata["runtime_profile"]["python_major_minor"] == "3.12"
    assert first_metadata["runtime_profile"]["mesa_version"] == importlib.metadata.version("mesa")
    assert first_metadata["digests"]["canonical_event_sha256"] == second_metadata["digests"]["canonical_event_sha256"]
    assert first_metadata["digests"]["daily_kpis_semantic_sha256"] == second_metadata["digests"]["daily_kpis_semantic_sha256"]
    assert first_metadata["digests"]["summary_semantic_sha256"] == second_metadata["digests"]["summary_semantic_sha256"]
    assert len(first_metadata["digests"]["canonical_event_sha256"]) == 64
    assert first_metadata["event_truncated"] is False
    assert first_metadata["processed_scheduled_event_count"] <= first_metadata["limits"]["processed_scheduled_events"]
    assert first_metadata["emitted_domain_event_count"] <= first_metadata["limits"]["emitted_domain_events"]
    assert first_metadata["limits"]["parent_wall_timeout_seconds"] == 180

    with (first / "daily-kpis.csv").open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 1096
    assert [float(row["sim_time_days"]) for row in rows] == list(range(1096))
    assert all(int(row["turbine_count"]) == 100 for row in rows)
    assert all(int(row["crew_count"]) == 3 for row in rows)
    assert all(int(row["seed"]) == 2 for row in rows)
    assert rows[365]["measurement_window_elapsed_days"] == "0"
    assert rows[365]["measurement_window_observed"] == "0"
    assert rows[-1]["measurement_window_elapsed_days"] == "730"
    assert rows[-1]["measurement_window_observed"] == "1"

    assert set(first_summary["claim_labels"]) == CLAIM_LABELS
    assert set(second_summary["claim_labels"]) == CLAIM_LABELS
    assert first_summary["staffing_recommendation"] is None
    assert first_summary["minimum_availability_fraction"] == 0.95
    assert isinstance(first_summary["minimum_availability_met"], bool)
    assert first_summary["measurement_window_days"] == 730
    assert first_summary["seed_count"] == 1
    assert first_summary["seed"] == 2
    metrics = first_summary["metrics"]
    assert first_summary["annualized_operating_revenue"] == pytest.approx(metrics["operating_revenue"] * 365 / 730)
    assert first_summary["annualized_maintenance_expense"] == pytest.approx(metrics["total_maintenance_cost"] * 365 / 730)
    assert first_summary["annualized_profit"] == pytest.approx(
        first_summary["annualized_operating_revenue"] - first_summary["annualized_maintenance_expense"]
    )
    _assert_finite(first_summary)
    _assert_finite(second_summary)


def test_run_verifier_rejects_identity_mutation(tmp_path: Path) -> None:
    run_baseline, verify_run, run_verification_error = _baseline_api()
    original = Path(run_baseline(output_dir=tmp_path / "original", preset_id=PRESET_ID))
    assert verify_run(original)["valid"] is True
    mutated = tmp_path / "mutated"
    shutil.copytree(original, mutated)
    summary_path = mutated / "summary.json"
    summary = json.loads(summary_path.read_text())
    summary["experiment_revision_id"] = "er_" + "0" * 64
    summary_path.write_text(json.dumps(summary, sort_keys=True, separators=(",", ":")) + "\n")
    with pytest.raises(run_verification_error):
        verify_run(mutated)


@pytest.fixture(scope="module")
def verifier_baseline(tmp_path_factory: pytest.TempPathFactory) -> Path:
    run_baseline, verify_run, _ = _baseline_api()
    root = tmp_path_factory.mktemp("wind-verifier")
    original = Path(run_baseline(output_dir=root / "original", preset_id=PRESET_ID))
    assert verify_run(original)["valid"] is True
    return original


@pytest.mark.parametrize("mutation", ["extra_file", "event_schema", "metric_schema"])
def test_run_verifier_rejects_extra_files_and_schema_invalid_but_digest_consistent_evidence(
    tmp_path: Path, verifier_baseline: Path, mutation: str
) -> None:
    _, verify_run, run_verification_error = _baseline_api()
    mutated = tmp_path / mutation
    shutil.copytree(verifier_baseline, mutated)
    if mutation == "extra_file":
        (mutated / "undeclared.txt").write_text("must fail exact artifact contract\n")
        error_pattern = "extra|unknown|exact"
    elif mutation == "event_schema":
        event_path = mutated / "domain-events.jsonl"
        events = [json.loads(line) for line in event_path.read_text().splitlines()]
        events[0].pop("payload")
        event_path.write_text("".join(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n" for event in events))
        _reseal_mutated_run(mutated)
        error_pattern = "event.*schema|payload|required"
    else:
        kpi_path = mutated / "daily-kpis.csv"
        with kpi_path.open(newline="") as handle:
            rows = list(csv.DictReader(handle))
        fieldnames = [*rows[0], "undeclared_metric"]
        with kpi_path.open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows([{**row, "undeclared_metric": "0"} for row in rows])
        _reseal_mutated_run(mutated)
        error_pattern = "metric.*schema|column|unknown|exact"
    with pytest.raises(run_verification_error, match=error_pattern):
        verify_run(mutated)
