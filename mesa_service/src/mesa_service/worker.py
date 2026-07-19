"""Subprocess entry point that runs exactly one normalized Mesa experiment."""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import math
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from .contracts import CSV_HEADER, METRICS


class CancelledRun(RuntimeError):
    """Raised when the parent asks the worker to stop between simulation ticks."""


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def import_model(model_path: Path) -> type[Any]:
    spec = importlib.util.spec_from_file_location("riff_demo_active_model", model_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not create model import spec")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model_class = getattr(module, "QueueNetworkModel", None)
    if model_class is None:
        raise RuntimeError("model revision does not export QueueNetworkModel")
    return model_class


def finite_snapshot(snapshot: object) -> dict[str, int | float]:
    if not isinstance(snapshot, dict) or set(snapshot) != set(METRICS):
        raise RuntimeError("snapshot does not contain the required metrics")
    normalized: dict[str, int | float] = {}
    for metric in METRICS:
        value = snapshot[metric]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise RuntimeError(f"snapshot metric {metric} is not finite numeric data")
        normalized[metric] = value
    return normalized


def execute(model_path: Path, request_path: Path, output_dir: Path, delay_per_step: float) -> None:
    request = read_json(request_path)
    metadata_path = output_dir / "metadata.json"
    metadata = read_json(metadata_path)
    metadata["status"] = "running"
    atomic_json(metadata_path, metadata)

    model_class = import_model(model_path)
    cancel_marker = output_dir / "cancel_requested"
    final_by_seed: list[dict[str, int | float]] = []
    rows_written = 0
    with (output_dir / "timeseries.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_HEADER)
        writer.writeheader()
        for seed in request["seeds"]:
            model = model_class(seed=seed, **request["parameters"])
            snapshot = finite_snapshot(model.snapshot())
            writer.writerow({"seed": seed, "tick": 0, **snapshot})
            rows_written += 1
            for tick in range(1, request["steps"] + 1):
                if cancel_marker.exists():
                    raise CancelledRun("cancel marker observed")
                if delay_per_step:
                    time.sleep(delay_per_step)
                model.step()
                snapshot = finite_snapshot(model.snapshot())
                writer.writerow({"seed": seed, "tick": tick, **snapshot})
                rows_written += 1
            final_by_seed.append({"seed": seed, **snapshot})

    aggregate_final = {
        metric: {
            "mean": sum(float(item[metric]) for item in final_by_seed) / len(final_by_seed),
            "min": min(float(item[metric]) for item in final_by_seed),
            "max": max(float(item[metric]) for item in final_by_seed),
        }
        for metric in METRICS
    }
    summary = {
        "model_id": "queue-network-v1",
        "model_revision": request["model_revision"],
        "steps": request["steps"],
        "seeds": request["seeds"],
        "metrics": list(METRICS),
        "final_by_seed": final_by_seed,
        "aggregate_final": aggregate_final,
        "rows_written": rows_written,
    }
    atomic_json(output_dir / "summary.json", summary)
    metadata = read_json(metadata_path)
    metadata.update({"status": "succeeded", "finished_at": time.time(), "worker_exit_code": 0})
    atomic_json(metadata_path, metadata)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--delay-per-step", type=float, default=0.0)
    args = parser.parse_args(argv)
    try:
        execute(args.model, args.request, args.output_dir, args.delay_per_step)
        return 0
    except CancelledRun as exc:
        metadata_path = args.output_dir / "metadata.json"
        if metadata_path.exists():
            metadata = read_json(metadata_path)
            metadata.update({"status": "cancelled", "finished_at": time.time(), "error": {"code": "cancelled", "message": str(exc)}})
            atomic_json(metadata_path, metadata)
        return 2
    except Exception as exc:  # worker errors must become a persisted terminal record
        traceback.print_exc()
        metadata_path = args.output_dir / "metadata.json"
        if metadata_path.exists():
            metadata = read_json(metadata_path)
            metadata.update({"status": "failed", "finished_at": time.time(), "error": {"code": "worker_failed", "message": str(exc)}})
            atomic_json(metadata_path, metadata)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
