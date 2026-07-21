"""Strict framed bundle, replay, and derived-evidence contract helpers."""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any, Mapping

from .canonical_v2 import canonical_json_v2_bytes, prefixed_digest


CLAIM_LABELS = [
    "synthetic_inputs", "single_seed", "behavioral_reproduction_not_runtime_equivalence",
    "draft_unverified", "no_staffing_recommendation",
]
NON_CLAIMS = [
    "not_anylogic_runtime_or_numerical_equivalence",
    "not_calibrated_to_a_real_wind_farm",
    "single_seed_is_not_uncertainty_analysis",
    "no_staffing_recommendation",
]
EMPTY_ARRAY_SHA256 = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"


class Gate3ContractError(ValueError):
    pass


def _exact(value: Any, keys: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise Gate3ContractError(f"{name} keys are not exact")
    return value


def sample_days(horizon_days: int, warmup_days: int) -> list[int]:
    if isinstance(horizon_days, bool) or not isinstance(horizon_days, int) or horizon_days < 1:
        raise Gate3ContractError("horizon_days must be a positive integer")
    if isinstance(warmup_days, bool) or not isinstance(warmup_days, int) or not 0 <= warmup_days < horizon_days:
        raise Gate3ContractError("warmup_days must be below horizon_days")
    count = min(120, horizon_days + 1)
    result = [(index * horizon_days) // (count - 1) for index in range(count)]
    if 0 < warmup_days < horizon_days and warmup_days not in result:
        candidates = [(abs(day - warmup_days), day, index) for index, day in enumerate(result[1:-1], 1)]
        _, _, selected = min(candidates)
        result[selected] = warmup_days
    return sorted(set(result))


def sample_days_sha256(days: list[int]) -> str:
    return hashlib.sha256(canonical_json_v2_bytes(days)).hexdigest()


def validate_execution_values(value: Any, schema: Any) -> dict[str, int]:
    _exact(schema, {"schema_id", "schema_version", "canonical_json_version", "type", "additionalProperties", "required", "properties", "invariants"}, "execution schema")
    if (
        schema["schema_id"] != "riff://wind-turbine-maintenance/execution-fields/v1"
        or schema["schema_version"] != 1
        or schema["canonical_json_version"] != "riff-canonical-json-v2"
        or schema["type"] != "object"
        or schema["additionalProperties"] is not False
        or schema["required"] != ["horizon_days", "warmup_days", "seed"]
        or schema["invariants"] != [{"rule": "warmup_days < horizon_days"}]
    ):
        raise Gate3ContractError("execution schema metadata is invalid")
    result = _exact(value, {"horizon_days", "warmup_days", "seed"}, "execution values")
    for name, minimum, maximum in (
        ("horizon_days", 1, 3660), ("warmup_days", 0, 3659), ("seed", -2147483648, 2147483647),
    ):
        item = result[name]
        if isinstance(item, bool) or not isinstance(item, int) or not minimum <= item <= maximum:
            raise Gate3ContractError(f"{name} is outside its exact integer range")
    if result["warmup_days"] >= result["horizon_days"]:
        raise Gate3ContractError("warmup_days must be below horizon_days")
    return dict(result)


def validate_framed_parameter_sources(schema: Any, preset: Any) -> dict[str, Any]:
    _exact(schema, {"schema_id", "schema_version", "canonical_json_version", "type", "additionalProperties", "required", "properties"}, "parameter schema")
    if (
        schema["schema_id"] != "riff://wind-turbine-maintenance/parameters/v2"
        or schema["schema_version"] != 2
        or schema["canonical_json_version"] != "riff-canonical-json-v2"
        or schema["type"] != "object"
        or schema["additionalProperties"] is not False
        or schema["required"] != sorted(schema["properties"])
        or len(schema["properties"]) != 26
    ):
        raise Gate3ContractError("parameter schema metadata is invalid")
    parameters = preset.get("parameters") if isinstance(preset, dict) else None
    if not isinstance(parameters, dict) or set(parameters) != set(schema["properties"]):
        raise Gate3ContractError("preset parameter set differs from schema")
    groups: dict[str, set[str]] = {}
    for name, prop in schema["properties"].items():
        if not isinstance(prop, dict) or prop.get("type") not in {"boolean", "integer", "number"}:
            raise Gate3ContractError(f"parameter type is outside the exact union: {name}")
        base = {"type", "display_name", "section_id", "display_order", "unit", "provenance", "distribution_group_id", "distribution_family", "distribution_role"}
        if prop.get("type") != "boolean":
            base |= {"minimum", "maximum"}
        _exact(prop, base, f"parameter property {name}")
        _exact(prop["provenance"], {"source_id", "source_locator", "disposition"}, f"parameter provenance {name}")
        value = parameters[name]
        if prop["type"] == "boolean":
            if not isinstance(value, bool):
                raise Gate3ContractError(f"boolean default is invalid: {name}")
        else:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) or not prop["minimum"] <= value <= prop["maximum"]:
                raise Gate3ContractError(f"numeric default is invalid: {name}")
            if prop["type"] == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
                raise Gate3ContractError(f"integer default is invalid: {name}")
        group = prop["distribution_group_id"]
        if group is None:
            if prop["distribution_family"] is not None or prop["distribution_role"] is not None:
                raise Gate3ContractError(f"scalar distribution metadata is invalid: {name}")
        else:
            if prop["distribution_family"] != "triangular" or prop["distribution_role"] not in {"low", "mode", "high"}:
                raise Gate3ContractError(f"triangular metadata is invalid: {name}")
            groups.setdefault(group, set()).add(prop["distribution_role"])
    if any(roles != {"low", "mode", "high"} for roles in groups.values()):
        raise Gate3ContractError("triangular groups must have low/mode/high")
    return dict(parameters)


def frame_state_digest(preimage: Mapping[str, Any]) -> str:
    expected = {
        "schema_id", "schema_version", "canonical_json_version", "model_id", "model_revision_id",
        "experiment_revision_id", "preset_id", "seed", "day", "phase", "depot", "turbines", "crews",
        "queues", "daily_metrics",
    }
    _exact(preimage, expected, "frame-state preimage")
    return "fs_" + hashlib.sha256(canonical_json_v2_bytes(dict(preimage))).hexdigest()


def metadata_core_digest(projection: Mapping[str, Any]) -> str:
    return "mcore_" + hashlib.sha256(canonical_json_v2_bytes(dict(projection))).hexdigest()


def validate_prefixed(value: str, prefix: str) -> None:
    if not isinstance(value, str) or re.fullmatch(re.escape(prefix) + r"[0-9a-f]{64}", value) is None:
        raise Gate3ContractError(f"invalid {prefix} digest")


def terminal_metadata_digest(record: dict[str, Any]) -> str:
    return prefixed_digest(record, field="terminal_metadata_digest", prefix="tm_")
