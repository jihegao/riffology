"""Stable schema and validation helpers for the one supported Mesa model."""

from __future__ import annotations

import math
from typing import Any

MODEL_ID = "queue-network-v1"
MODEL_CLASS = "QueueNetworkModel"
METRICS = ("queue_length", "completed_jobs", "mean_wait_time")
CSV_HEADER = ("seed", "tick", *METRICS)

MODEL_SCHEMA: dict[str, Any] = {
    "protocol_version": "mesa-model-v1",
    "model_id": MODEL_ID,
    "model_class": MODEL_CLASS,
    "title": "Service queue",
    "parameters": [
        {"name": "arrival_rate", "type": "number", "minimum": 0.1, "maximum": 100, "default": 6},
        {"name": "service_capacity", "type": "integer", "minimum": 1, "maximum": 50, "default": 2},
        {"name": "service_time", "type": "number", "minimum": 0.1, "maximum": 100, "default": 1},
        {"name": "initial_backlog", "type": "integer", "minimum": 0, "maximum": 1000, "default": 0},
    ],
    "metrics": list(METRICS),
    "default_steps": 40,
    "maximum_steps": 500,
}

EXPERIMENT_SCHEMA: dict[str, Any] = {
    "model_revision": {"type": "string", "required": True},
    "steps": {"type": "integer", "minimum": 1, "maximum": 500, "required": True},
    "seeds": {"type": "array", "item_type": "integer", "minimum_items": 1, "maximum_items": 5, "required": True},
    "parameters": MODEL_SCHEMA["parameters"],
}


class ContractError(ValueError):
    """A caller supplied data outside the public Mesa contract."""


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractError(f"{name} must be a number")
    value = float(value)
    if not math.isfinite(value):
        raise ContractError(f"{name} must be finite")
    return value


def validate_parameters(raw: object) -> dict[str, int | float]:
    if not isinstance(raw, dict):
        raise ContractError("parameters must be an object")
    definitions = {item["name"]: item for item in MODEL_SCHEMA["parameters"]}
    if set(raw) != set(definitions):
        missing = sorted(set(definitions) - set(raw))
        unknown = sorted(set(raw) - set(definitions))
        raise ContractError(f"parameters must contain exactly {sorted(definitions)}; missing={missing}, unknown={unknown}")
    validated: dict[str, int | float] = {}
    for name, definition in definitions.items():
        value = raw[name]
        if definition["type"] == "integer":
            if not _is_int(value):
                raise ContractError(f"{name} must be an integer")
            candidate: int | float = int(value)
        else:
            candidate = _number(value, name)
        if candidate < definition["minimum"] or candidate > definition["maximum"]:
            raise ContractError(f"{name} must be between {definition['minimum']} and {definition['maximum']}")
        validated[name] = candidate
    return validated


def validate_run_request(raw: object, active_revision: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ContractError("run request must be an object")
    expected = {"model_revision", "steps", "seeds", "parameters"}
    if set(raw) != expected:
        raise ContractError(f"run request must contain exactly {sorted(expected)}")
    if raw["model_revision"] != active_revision:
        raise ContractError("model revision is not active")
    if not _is_int(raw["steps"]) or not 1 <= raw["steps"] <= MODEL_SCHEMA["maximum_steps"]:
        raise ContractError("steps must be an integer between 1 and 500")
    seeds = raw["seeds"]
    if not isinstance(seeds, list) or not 1 <= len(seeds) <= 5 or not all(_is_int(seed) for seed in seeds):
        raise ContractError("seeds must contain one to five integers")
    if len(set(seeds)) != len(seeds) or any(seed < -(2**31) or seed > 2**31 - 1 for seed in seeds):
        raise ContractError("seeds must be unique signed 32-bit integers")
    return {
        "model_revision": active_revision,
        "steps": raw["steps"],
        "seeds": seeds,
        "parameters": validate_parameters(raw["parameters"]),
    }
