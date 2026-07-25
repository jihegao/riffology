from __future__ import annotations

import argparse
import csv
import json
import math
import signal
import time
from pathlib import Path
from typing import Any

from model import WindTurbineMaintenanceModel


CLAIM_LABELS = [
    "synthetic_inputs",
    "single_seed",
    "behavioral_reproduction_not_runtime_equivalence",
    "draft_unverified",
    "no_staffing_recommendation",
]
NON_CLAIMS = [
    "not_anylogic_runtime_or_numerical_equivalence",
    "not_calibrated_to_a_real_wind_farm",
    "single_seed_is_not_uncertainty_analysis",
    "no_staffing_recommendation",
    "no_weather_or_road_gis",
    "no_spare_parts_or_crew_skills",
    "no_proactive_age_replacement",
    "no_mid_run_hiring_or_layoff",
]


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("JSON object keys must be unique")
        value[key] = item
    return value


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number {value} is unavailable")


def _assert_bounded_json(value: Any) -> None:
    if value is None or isinstance(value, (str, bool)):
        return
    if type(value) is int:
        if abs(value) > 9_007_199_254_740_991:
            raise ValueError("JSON integer is outside the safe range")
        return
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("JSON number must be finite")
        return
    if isinstance(value, list):
        for item in value:
            _assert_bounded_json(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"__proto__", "prototype", "constructor"}:
                raise ValueError("dangerous JSON key is unavailable")
            _assert_bounded_json(item)
        return
    raise ValueError("input contains an unsupported JSON value")


def _read_input(path: Path) -> tuple[dict[str, Any], int, int, int]:
    value = json.loads(
        path.read_text(encoding="utf-8"),
        object_pairs_hook=_strict_object,
        parse_constant=_reject_constant,
    )
    _assert_bounded_json(value)
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion",
        "runId",
        "sampleIndex",
        "sampleId",
        "parameters",
        "seed",
    }:
        raise ValueError("input must be an exact riff-batch-v1 envelope")
    run_id = value["runId"]
    sample_index = value["sampleIndex"]
    sample_id = value["sampleId"]
    supplied_seed = value["seed"]
    if (
        value["schemaVersion"] != 1
        or not isinstance(run_id, str)
        or not 3 <= len(run_id) <= 128
        or any(ord(character) < 32 or ord(character) == 127 for character in run_id)
        or type(sample_index) is not int
        or sample_index < 0
        or not isinstance(sample_id, str)
        or len(sample_id) != 64
        or any(character not in "0123456789abcdef" for character in sample_id)
        or not isinstance(value["parameters"], dict)
        or (
            supplied_seed is not None
            and (
                type(supplied_seed) is not int
                or abs(supplied_seed) > 9_007_199_254_740_991
            )
        )
    ):
        raise ValueError("input envelope is invalid")
    parameters = dict(value["parameters"])
    horizon_days = parameters.pop("horizon_days")
    warmup_days = parameters.pop("warmup_days")
    seed = 2 if supplied_seed is None else supplied_seed
    if type(horizon_days) is not int or type(warmup_days) is not int or type(seed) is not int:
        raise ValueError("horizon_days, warmup_days, and seed must be integers")
    if not 1 <= horizon_days <= 3660 or not 0 <= warmup_days < horizon_days:
        raise ValueError("the measurement horizon is invalid")
    return parameters, horizon_days, warmup_days, seed


def _canonical_line(value: object) -> str:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _write_json(path: Path, value: object) -> None:
    path.write_text(_canonical_line(value) + "\n", encoding="utf-8")


def _cancellation_probe() -> None:
    signal.signal(signal.SIGTERM, lambda _signum, _frame: raise_exit())
    print("RIFF_CANCELLATION_READY", flush=True)
    while True:
        time.sleep(0.05)


def raise_exit() -> None:
    raise SystemExit(0)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--riff-input", type=Path)
    parser.add_argument("--riff-output-dir", type=Path)
    parser.add_argument("--riff-cancellation-probe", action="store_true")
    args = parser.parse_args()
    if args.riff_cancellation_probe:
        _cancellation_probe()
    if args.riff_input is None or args.riff_output_dir is None:
        parser.error("--riff-input and --riff-output-dir are required")

    parameters, horizon_days, warmup_days, seed = _read_input(args.riff_input)
    args.riff_output_dir.mkdir(parents=True, exist_ok=True)
    event_path = args.riff_output_dir / "domain-events.ndjson"
    daily_path = args.riff_output_dir / "daily-kpis.csv"

    event_handle = event_path.open("w", encoding="utf-8", newline="")
    daily_handle = daily_path.open("w", encoding="utf-8", newline="")
    daily_writer: csv.DictWriter[str] | None = None

    def emit(raw: dict[str, Any]) -> None:
        nonlocal daily_writer
        event_type = raw.get("event_type")
        if not isinstance(event_type, str):
            raise ValueError("the Model emitted an event without an event_type")
        payload = {key: value for key, value in raw.items() if key != "event_type"}
        event_handle.write(_canonical_line({"type": event_type, "payload": payload}) + "\n")
        if event_type == "daily_snapshot":
            snapshot = raw.get("payload", {}).get("snapshot")
            if not isinstance(snapshot, dict):
                raise ValueError("daily_snapshot has no metric mapping")
            if daily_writer is None:
                daily_writer = csv.DictWriter(
                    daily_handle,
                    fieldnames=sorted(snapshot),
                    lineterminator="\n",
                )
                daily_writer.writeheader()
            daily_writer.writerow(snapshot)

    try:
        model = WindTurbineMaintenanceModel(
            parameters=parameters,
            horizon_days=horizon_days,
            warmup_days=warmup_days,
            seed=seed,
            event_sink=emit,
        )
        while model.sim_time_days < horizon_days:
            model.step()
        metrics = model.snapshot()
    finally:
        event_handle.close()
        daily_handle.close()

    measurement_days = horizon_days - warmup_days
    annualized_revenue = float(metrics["operating_revenue"]) * 365 / measurement_days
    annualized_expense = float(metrics["total_maintenance_cost"]) * 365 / measurement_days
    _write_json(args.riff_output_dir / "summary.json", {
        "claim_labels": CLAIM_LABELS,
        "measurement_window_days": measurement_days,
        "seed": seed,
        "seed_count": 1,
        "minimum_availability_fraction": parameters["minimum_availability_fraction"],
        "minimum_availability_met": (
            metrics["availability_fraction"]
            >= parameters["minimum_availability_fraction"]
        ),
        "staffing_recommendation": None,
        "metrics": metrics,
        "annualized_maintenance_cost": annualized_expense,
        "annualized_operating_revenue": annualized_revenue,
        "annualized_maintenance_expense": annualized_expense,
        "annualized_profit": annualized_revenue - annualized_expense,
        "non_claims": NON_CLAIMS,
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
