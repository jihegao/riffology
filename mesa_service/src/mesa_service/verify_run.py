"""Fail-closed verification for completed wind run evidence."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
from pathlib import Path
from typing import Any

from .wind_worker import (
    IDENTITY_FIELDS,
    MODEL_ID,
    REQUIRED_CLAIM_LABELS,
    REQUIRED_SUCCESS_ARTIFACTS,
    _semantic_event_projection,
    _semantic_without_run_context,
    _parse_metric_csv_row,
    _validate_domain_event,
    canonical_json_bytes,
    sha256_bytes,
    sha256_file,
)
from .wind_contracts import load_json_asset


class RunVerificationError(ValueError):
    """Run artifacts are incomplete, inconsistent, or digest-invalid."""


def _json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RunVerificationError(f"invalid JSON artifact: {path.name}") from exc
    if not isinstance(payload, dict):
        raise RunVerificationError(f"JSON artifact is not an object: {path.name}")
    _finite_json(payload, path.name)
    return payload


def _finite_json(value: object, context: str) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise RunVerificationError(f"non-finite value in {context}")
    if isinstance(value, dict):
        for nested in value.values():
            _finite_json(nested, context)
    elif isinstance(value, list):
        for nested in value:
            _finite_json(nested, context)


def _identity(document: dict[str, Any]) -> dict[str, Any]:
    try:
        return {key: document[key] for key in IDENTITY_FIELDS}
    except KeyError as exc:
        raise RunVerificationError(f"artifact is missing identity field {exc.args[0]}") from exc


def _assert_identity(document: dict[str, Any], expected: dict[str, Any], name: str) -> None:
    if _identity(document) != expected:
        raise RunVerificationError(f"{name} identity does not match request.json")


def _daily_semantic_digest(
    path: Path,
    expected: dict[str, Any],
    metric_schema: dict[str, Any],
) -> tuple[str, int, dict[str, int | float]]:
    digest = hashlib.sha256()
    row_count = 0
    last_metrics: dict[str, int | float] = {}
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None:
                raise RunVerificationError("daily-kpis.csv has no header")
            expected_columns = {*IDENTITY_FIELDS, *metric_schema["properties"]}
            if len(reader.fieldnames) != len(set(reader.fieldnames)) or set(reader.fieldnames) != expected_columns:
                raise RunVerificationError("daily KPI columns do not exactly match the metric schema")
            for row in reader:
                if not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", row.get("seed", "")):
                    raise RunVerificationError("daily-kpis.csv seed identity is not an integer")
                row_identity = {key: int(row[key]) if key == "seed" else row[key] for key in IDENTITY_FIELDS}
                if row_identity != expected:
                    raise RunVerificationError("daily-kpis.csv row identity does not match request.json")
                metric_row = {key: row[key] for key in metric_schema["properties"]}
                try:
                    last_metrics = _parse_metric_csv_row(
                        metric_row,
                        metric_schema,
                        context="daily KPI metric schema",
                    )
                except RuntimeError as exc:
                    raise RunVerificationError(str(exc)) from exc
                if float(last_metrics["sim_time_days"]) != row_count:
                    raise RunVerificationError("daily KPI sim_time_days is not contiguous from day zero")
                semantic = {key: value for key, value in row.items() if key not in {"project_id", "run_id"}}
                digest.update(canonical_json_bytes(semantic))
                row_count += 1
    except OSError as exc:
        raise RunVerificationError("daily-kpis.csv is unreadable") from exc
    return digest.hexdigest(), row_count, last_metrics


def _event_semantic_digest(
    path: Path,
    expected: dict[str, Any],
    profile: dict[str, str],
) -> tuple[str, int]:
    digest = hashlib.sha256()
    count = 0
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise RunVerificationError("domain-events.jsonl contains invalid JSON") from exc
                if not isinstance(event, dict):
                    raise RunVerificationError("domain event is not an object")
                _finite_json(event, "domain-events.jsonl")
                try:
                    _validate_domain_event(event, expected)
                except RuntimeError as exc:
                    raise RunVerificationError(f"domain event schema is invalid: {exc}") from exc
                count += 1
                if event.get("sequence") != count:
                    raise RunVerificationError("domain event sequence is not contiguous from one")
                digest.update(canonical_json_bytes(_semantic_event_projection(event, profile)))
    except OSError as exc:
        raise RunVerificationError("domain-events.jsonl is unreadable") from exc
    if count == 0:
        raise RunVerificationError("domain event log is empty")
    return digest.hexdigest(), count


def _reject_symlink_ancestors(path: str | Path) -> Path:
    candidate = Path(os.path.abspath(os.fspath(path)))
    current = Path(candidate.anchor)
    for part in candidate.parts[1:]:
        current /= part
        if current.is_symlink():
            raise RunVerificationError("run path contains a symlink ancestor")
    return candidate


def verify_run(run_dir: str | Path) -> dict[str, Any]:
    candidate = _reject_symlink_ancestors(run_dir)
    root = candidate.resolve()
    if not root.is_dir():
        raise RunVerificationError("run directory is unavailable or unsafe")
    entries = list(root.iterdir())
    names = {path.name for path in entries}
    if names != REQUIRED_SUCCESS_ARTIFACTS or len(entries) != len(REQUIRED_SUCCESS_ARTIFACTS):
        raise RunVerificationError(
            "successful run artifact set is not exact; "
            f"missing={sorted(REQUIRED_SUCCESS_ARTIFACTS - names)}, extra={sorted(names - REQUIRED_SUCCESS_ARTIFACTS)}"
        )
    if any(path.is_symlink() or not path.is_file() for path in entries):
        raise RunVerificationError("successful run contains a symlink or non-file artifact")

    request = _json(root / "request.json")
    metadata = _json(root / "metadata.json")
    summary = _json(root / "summary.json")
    replay = _json(root / "replay-manifest.json")
    derived = _json(root / "derived-views-manifest.json")
    expected = _identity(request)
    if expected["model_id"] != MODEL_ID:
        raise RunVerificationError("run does not belong to wind-turbine-maintenance")
    for name, document in (
        ("metadata.json", metadata),
        ("summary.json", summary),
        ("replay-manifest.json", replay),
        ("derived-views-manifest.json", derived),
    ):
        _assert_identity(document, expected, name)
    if metadata.get("status") != "succeeded" or metadata.get("event_truncated") is not False:
        raise RunVerificationError("run metadata is not a complete untruncated success")
    if set(metadata.get("claim_labels", [])) != set(REQUIRED_CLAIM_LABELS):
        raise RunVerificationError("metadata claim boundary is incomplete")
    if set(summary.get("claim_labels", [])) != set(REQUIRED_CLAIM_LABELS):
        raise RunVerificationError("summary claim boundary is incomplete")
    if summary.get("staffing_recommendation", object()) is not None:
        raise RunVerificationError("Gate 1 summary must not contain a staffing recommendation")
    profile = metadata.get("runtime_profile")
    if not isinstance(profile, dict) or profile != request.get("runtime_profile"):
        raise RunVerificationError("runtime profile identity is inconsistent")

    metric_schema = load_json_asset("metric-schema.json")
    metrics = summary.get("metrics")
    try:
        from .wind_worker import _validate_metric_mapping

        validated_summary_metrics = _validate_metric_mapping(
            metrics,
            metric_schema,
            context="summary metric schema",
        )
    except RuntimeError as exc:
        raise RunVerificationError(str(exc)) from exc

    event_semantic, event_count = _event_semantic_digest(root / "domain-events.jsonl", expected, profile)
    daily_semantic, daily_count, final_daily_metrics = _daily_semantic_digest(
        root / "daily-kpis.csv",
        expected,
        metric_schema,
    )
    if final_daily_metrics != validated_summary_metrics:
        raise RunVerificationError("summary metrics do not exactly match the final daily KPI row")
    measurement_days = request.get("horizon_days", 0) - request.get("warmup_days", 0)
    if measurement_days <= 0:
        raise RunVerificationError("measurement window is invalid")
    annualized_revenue = float(validated_summary_metrics["operating_revenue"]) * 365 / measurement_days
    annualized_expense = float(validated_summary_metrics["total_maintenance_cost"]) * 365 / measurement_days
    annualized_fields = {
        "annualized_operating_revenue": annualized_revenue,
        "annualized_maintenance_expense": annualized_expense,
        "annualized_profit": annualized_revenue - annualized_expense,
        "annualized_maintenance_cost": annualized_expense,
    }
    for key, expected_value in annualized_fields.items():
        actual = summary.get(key)
        if isinstance(actual, bool) or not isinstance(actual, (int, float)) or not math.isfinite(actual):
            raise RunVerificationError(f"summary {key} is unavailable or non-finite")
        if not math.isclose(float(actual), expected_value, rel_tol=1e-12, abs_tol=1e-9):
            raise RunVerificationError(f"summary {key} does not match source metrics")
    summary_semantic = sha256_bytes(canonical_json_bytes(_semantic_without_run_context(summary)))
    digests = metadata.get("digests")
    if not isinstance(digests, dict):
        raise RunVerificationError("metadata digest map is unavailable")
    expected_digests = {
        "request_sha256": sha256_file(root / "request.json"),
        "domain_events_sha256": sha256_file(root / "domain-events.jsonl"),
        "canonical_event_sha256": event_semantic,
        "daily_kpis_sha256": sha256_file(root / "daily-kpis.csv"),
        "daily_kpis_semantic_sha256": daily_semantic,
        "summary_sha256": sha256_file(root / "summary.json"),
        "summary_semantic_sha256": summary_semantic,
        "replay_manifest_sha256": sha256_file(root / "replay-manifest.json"),
        "derived_views_manifest_sha256": sha256_file(root / "derived-views-manifest.json"),
    }
    for key, value in expected_digests.items():
        if digests.get(key) != value:
            raise RunVerificationError(f"artifact digest mismatch: {key}")
    if replay.get("canonical_event_sha256") != event_semantic or replay.get("event_count") != event_count:
        raise RunVerificationError("replay manifest does not bind the complete event log")
    inputs = derived.get("inputs")
    if not isinstance(inputs, dict) or inputs.get("canonical_event_sha256") != event_semantic:
        raise RunVerificationError("derived views do not bind the canonical event log")
    if inputs.get("daily_kpis_semantic_sha256") != daily_semantic or inputs.get("summary_semantic_sha256") != summary_semantic:
        raise RunVerificationError("derived views do not bind KPI and summary evidence")
    for key in ("model_spec_sha256", "traceability_sha256"):
        value = inputs.get(key)
        if not isinstance(value, str) or len(value) != 64:
            raise RunVerificationError(f"derived views do not bind {key}")
    if metadata.get("emitted_domain_event_count") != event_count:
        raise RunVerificationError("metadata event count does not match the complete log")
    limits = metadata.get("limits")
    if not isinstance(limits, dict):
        raise RunVerificationError("run limits are unavailable")
    if event_count > limits.get("emitted_domain_events", -1):
        raise RunVerificationError("event count exceeds its recorded limit")
    if metadata.get("processed_scheduled_event_count", -1) > limits.get("processed_scheduled_events", -1):
        raise RunVerificationError("processed event count exceeds its recorded limit")
    if (root / "domain-events.jsonl").stat().st_size > limits.get("domain_event_bytes", -1):
        raise RunVerificationError("event artifact exceeds its recorded limit")
    if (root / "daily-kpis.csv").stat().st_size > limits.get("daily_kpi_bytes", -1):
        raise RunVerificationError("KPI artifact exceeds its recorded limit")
    if (root / "run.log").stat().st_size > limits.get("run_log_bytes", -1):
        raise RunVerificationError("run log exceeds its recorded limit")
    total_size = sum((root / name).stat().st_size for name in REQUIRED_SUCCESS_ARTIFACTS)
    if total_size > limits.get("total_success_artifact_bytes", -1):
        raise RunVerificationError("successful artifact set exceeds its recorded limit")
    horizon = request.get("horizon_days")
    if not isinstance(horizon, int) or daily_count != horizon + 1:
        raise RunVerificationError("daily KPI row count does not cover day zero through the horizon")

    return {
        "valid": True,
        "run_id": expected["run_id"],
        "model_revision_id": expected["model_revision_id"],
        "experiment_revision_id": expected["experiment_revision_id"],
        "canonical_event_sha256": event_semantic,
        "event_count": event_count,
        "daily_kpi_row_count": daily_count,
        "artifact_bytes": total_size,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args(argv)
    print(json.dumps(verify_run(args.run_dir), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
