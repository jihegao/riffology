"""Strict, stable contracts for the reviewed wind-turbine model bundle."""

from __future__ import annotations

import importlib.metadata
import json
import math
import platform
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any, Mapping


MODEL_ID = "wind-turbine-maintenance"
PRESET_ID = "wind-turbine-maintenance-demo-v1"
MODEL_PROTOCOL_VERSION = "wind-turbine-maintenance-v1"
CANONICAL_JSON_VERSION = "rfc8259-sort-keys-compact-v1"

ASSET_ROOT = Path(__file__).resolve().parent / "model_assets" / "wind_turbine_maintenance"

CLAIM_LABELS = frozenset(
    {
        "synthetic_inputs",
        "single_seed",
        "behavioral_reproduction_not_runtime_equivalence",
        "draft_unverified",
        "no_staffing_recommendation",
    }
)


class ContractValidationError(ValueError):
    """A wind model document violates its exact reviewed contract."""


def canonical_json_bytes(value: object) -> bytes:
    """Return the single canonical byte representation used by all digests."""

    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def load_json_asset(relative_path: str) -> dict[str, Any]:
    """Load one declared JSON projection without permitting path traversal."""

    candidate = (ASSET_ROOT / relative_path).resolve()
    try:
        candidate.relative_to(ASSET_ROOT)
    except ValueError as exc:
        raise ContractValidationError("asset path leaves the reviewed asset root") from exc
    if candidate.suffix != ".json" or not candidate.is_file():
        raise ContractValidationError(f"unknown reviewed JSON asset: {relative_path}")
    try:
        value = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractValidationError(f"invalid reviewed JSON asset: {relative_path}") from exc
    if not isinstance(value, dict):
        raise ContractValidationError(f"reviewed JSON asset must be an object: {relative_path}")
    return value


def runtime_profile() -> dict[str, str]:
    """Return the concrete runtime identity locked into content revisions."""

    try:
        mesa_version = importlib.metadata.version("mesa")
    except importlib.metadata.PackageNotFoundError as exc:  # pragma: no cover - install error
        raise RuntimeError("Mesa must be installed to identify a reviewed bundle") from exc
    return {
        "python_implementation": platform.python_implementation(),
        "python_major_minor": f"{sys.version_info.major}.{sys.version_info.minor}",
        "mesa_version": mesa_version,
        "model_protocol_version": MODEL_PROTOCOL_VERSION,
        "canonical_json_version": CANONICAL_JSON_VERSION,
    }


def _is_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _finite_number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractValidationError(f"{field} must be a number")
    result = float(value)
    if not math.isfinite(result):
        raise ContractValidationError(f"{field} must be finite")
    return result


def validate_parameters(raw: object) -> dict[str, int | float | bool]:
    """Validate the exact editable parameter object, including cross-fields."""

    if not isinstance(raw, Mapping):
        raise ContractValidationError("parameters must be an object")
    schema = load_json_asset("parameter-schema.json")
    definitions = schema["properties"]
    expected = set(definitions)
    if set(raw) != expected:
        raise ContractValidationError(
            f"parameters must contain exactly the reviewed keys; "
            f"missing={sorted(expected - set(raw))}, unknown={sorted(set(raw) - expected)}"
        )

    validated: dict[str, int | float | bool] = {}
    for name, definition in definitions.items():
        value = raw[name]
        kind = definition["type"]
        if kind == "boolean":
            if not isinstance(value, bool):
                raise ContractValidationError(f"{name} must be a boolean")
            validated[name] = value
            continue
        if kind == "integer":
            if not _is_integer(value):
                raise ContractValidationError(f"{name} must be an integer")
            candidate: int | float = int(value)
        elif kind == "number":
            candidate = _finite_number(value, name)
        else:  # pragma: no cover - committed schema guard
            raise ContractValidationError(f"unsupported parameter type for {name}")
        if candidate < definition["minimum"] or candidate > definition["maximum"]:
            raise ContractValidationError(
                f"{name} must be between {definition['minimum']} and {definition['maximum']}"
            )
        validated[name] = candidate

    for family in ("repair", "maintenance", "replacement"):
        low = float(validated[f"{family}_low_hours"])
        mode = float(validated[f"{family}_mode_hours"])
        high = float(validated[f"{family}_high_hours"])
        if not low <= mode <= high:
            raise ContractValidationError(f"{family} duration must satisfy low <= mode <= high")
    if float(validated["depot_x_km"]) > float(validated["farm_width_km"]):
        raise ContractValidationError("depot_x_km must be inside the farm")
    if float(validated["depot_y_km"]) > float(validated["farm_height_km"]):
        raise ContractValidationError("depot_y_km must be inside the farm")
    return validated


_PRESET_KEYS = {
    "preset_id",
    "executable",
    "parameters",
    "parameter_provenance",
    "horizon_days",
    "warmup_days",
    "seed",
    "claim_labels",
}
_REVISION_KEYS = {
    "model_id",
    "model_revision_id",
    "brief_revision_id",
    "alignment_revision_id",
    "workflow_policy",
    "trust_label",
    "runtime_profile",
}


def validate_experiment_document(raw: object) -> dict[str, Any]:
    """Validate a reviewed preset or its immutable revision expansion."""

    if not isinstance(raw, Mapping):
        raise ContractValidationError("experiment must be an object")
    keys = set(raw)
    if keys not in (_PRESET_KEYS, _PRESET_KEYS | _REVISION_KEYS):
        raise ContractValidationError(
            f"experiment keys are not exact; unknown={sorted(keys - (_PRESET_KEYS | _REVISION_KEYS))}, "
            f"missing={sorted(_PRESET_KEYS - keys)}"
        )
    if raw["preset_id"] != PRESET_ID or raw["executable"] is not True:
        raise ContractValidationError("experiment must use the executable reviewed demo preset")
    parameters = validate_parameters(raw["parameters"])
    if not _is_integer(raw["horizon_days"]) or not 1 <= raw["horizon_days"] <= 3660:
        raise ContractValidationError("horizon_days must be an integer between 1 and 3660")
    if not _is_integer(raw["warmup_days"]) or not 0 <= raw["warmup_days"] < raw["horizon_days"]:
        raise ContractValidationError("warmup_days must be an integer below horizon_days")
    if not _is_integer(raw["seed"]) or not -(2**31) <= raw["seed"] <= 2**31 - 1:
        raise ContractValidationError("seed must be one signed 32-bit integer")
    labels = raw["claim_labels"]
    if not isinstance(labels, list) or len(labels) != len(set(labels)) or set(labels) != CLAIM_LABELS:
        raise ContractValidationError("claim_labels must be the exact Gate 1 non-claim set")
    provenance = raw["parameter_provenance"]
    if not isinstance(provenance, Mapping) or set(provenance) != set(parameters):
        raise ContractValidationError("parameter_provenance must cover every parameter exactly")
    allowed_provenance = {"synthetic_assumption", "source_seeded_synthetic_assumption", "user_declared_demo_target"}
    if any(value not in allowed_provenance for value in provenance.values()):
        raise ContractValidationError("parameter_provenance contains an unsupported label")

    validated = deepcopy(dict(raw))
    validated["parameters"] = parameters
    if keys == _PRESET_KEYS | _REVISION_KEYS:
        if raw["model_id"] != MODEL_ID:
            raise ContractValidationError("experiment model_id is not the reviewed wind model")
        revision = raw["model_revision_id"]
        if not isinstance(revision, str) or len(revision) != 67 or not revision.startswith("mr_"):
            raise ContractValidationError("model_revision_id must be a full SHA-256 revision")
        try:
            int(revision[3:], 16)
        except ValueError as exc:
            raise ContractValidationError("model_revision_id must contain lowercase hexadecimal") from exc
        if revision[3:] != revision[3:].lower():
            raise ContractValidationError("model_revision_id must contain lowercase hexadecimal")
        if raw["brief_revision_id"] is not None or raw["alignment_revision_id"] is not None:
            raise ContractValidationError("Gate 1 project bindings must be null")
        if raw["workflow_policy"] != "workflow_policy_unmet" or raw["trust_label"] != "draft_unverified":
            raise ContractValidationError("Gate 1 workflow and trust labels are immutable")
        if raw["runtime_profile"] != runtime_profile():
            raise ContractValidationError("experiment runtime profile does not match this execution")
    return validated


def build_experiment_document(model_revision_id: str) -> dict[str, Any]:
    """Expand the demo preset into the immutable Gate 1 experiment payload."""

    preset = load_json_asset("defaults/wind-turbine-maintenance-demo-v1.json")
    document = {
        **preset,
        "model_id": MODEL_ID,
        "model_revision_id": model_revision_id,
        "brief_revision_id": None,
        "alignment_revision_id": None,
        "workflow_policy": "workflow_policy_unmet",
        "trust_label": "draft_unverified",
        "runtime_profile": runtime_profile(),
    }
    return validate_experiment_document(document)
