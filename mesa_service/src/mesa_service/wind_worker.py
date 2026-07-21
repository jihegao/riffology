"""Isolated worker for one reviewed wind-turbine maintenance experiment."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import sys
import time
import traceback
import types
import uuid
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .canonical_v2 import canonical_json_v2_bytes
from .wind_contracts import canonical_json_bytes as _contract_canonical_json_bytes
from .wind_contracts import load_json_asset
from .wind_contracts import runtime_profile as _contract_runtime_profile
from .workspace_lifecycle import WorkspaceLifecycle, WorkspaceLifecycleError


MODEL_ID = "wind-turbine-maintenance"
REQUIRED_CLAIM_LABELS = (
    "synthetic_inputs",
    "single_seed",
    "behavioral_reproduction_not_runtime_equivalence",
    "draft_unverified",
    "no_staffing_recommendation",
)
IDENTITY_FIELDS = (
    "project_id",
    "run_id",
    "model_id",
    "model_revision_id",
    "experiment_revision_id",
    "preset_id",
    "seed",
)
V2_IDENTITY_FIELDS = (
    "project_id",
    "run_id",
    "model_id",
    "model_revision_id",
    "brief_revision_id",
    "alignment_revision_id",
    "experiment_revision_id",
    "preset_id",
    "seed",
    "visibility",
    "trust_label",
    "workflow_label",
    "policy_snapshot_digest",
    "run_admission_digest",
)
LIMITS: dict[str, int] = {
    "parent_wall_timeout_seconds": 180,
    "processed_scheduled_events": 2_000_000,
    "emitted_domain_events": 2_000_000,
    "pending_scheduler_events": 4_096,
    "domain_event_bytes": 256 * 1024 * 1024,
    "daily_kpi_bytes": 16 * 1024 * 1024,
    "run_log_bytes": 4 * 1024 * 1024,
    "total_success_artifact_bytes": 300 * 1024 * 1024,
}
FRAMED_LIMITS: dict[str, int] = {
    **LIMITS,
    "replay_manifest_bytes": 4 * 1024 * 1024,
    "total_success_artifact_bytes": 304 * 1024 * 1024,
}
REQUIRED_SUCCESS_ARTIFACTS = {
    "request.json",
    "metadata.json",
    "daily-kpis.csv",
    "domain-events.jsonl",
    "summary.json",
    "replay-manifest.json",
    "derived-views-manifest.json",
    "run.log",
}


def _process_start_token(pid: int) -> str:
    value = subprocess.check_output(
        ["ps", "-o", "lstart=", "-p", str(pid)],
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=2,
    ).strip()
    if not value:
        raise RuntimeError("worker process start token is unavailable")
    return hashlib.sha256(value.encode()).hexdigest()


def _atomic_canonical_v2(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    data = canonical_json_v2_bytes(payload)
    with temporary.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _atomic_canonical_v2_lf(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    data = canonical_json_v2_bytes(payload) + b"\n"
    with temporary.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)
RAW_EVENT_FIELDS = {
    "event_id",
    "sequence",
    "sim_time_days",
    "event_type",
    "phase",
    "turbine_id",
    "crew_id",
    "work_order_id",
    "correlation_id",
    "before_state",
    "after_state",
    "payload",
}
EVENT_FIELDS = RAW_EVENT_FIELDS | set(IDENTITY_FIELDS)
EVENT_PHASES: dict[str, frozenset[int]] = {
    "failure_occurred": frozenset({10}),
    "maintenance_due": frozenset({10}),
    "request_queued": frozenset({10}),
    "request_superseded": frozenset({10}),
    "request_suppressed": frozenset({10}),
    "repair_completed": frozenset({20}),
    "maintenance_completed": frozenset({20}),
    "replacement_completed": frozenset({20}),
    "crew_return_started": frozenset({20}),
    "crew_arrived": frozenset({30, 40}),
    "repair_started": frozenset({30, 40}),
    "maintenance_started": frozenset({20, 30, 40}),
    "replacement_started": frozenset({30, 40}),
    "crew_returned": frozenset({30}),
    "crew_dispatched": frozenset({40}),
    "daily_snapshot": frozenset({50}),
}
STATE_VOCABULARY = {
    "operating",
    "failed_waiting",
    "corrective_repair",
    "planned_maintenance",
    "major_replacement",
    "idle",
    "driving_to_work",
    "working",
    "driving_home",
}


class CancelledRun(RuntimeError):
    """The parent requested cancellation at a bounded worker checkpoint."""


class WorkerLimitError(RuntimeError):
    """A finite worker limit was reached; evidence is never truncated."""


def canonical_json_bytes(value: object) -> bytes:
    return _contract_canonical_json_bytes(value)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def runtime_profile() -> dict[str, str]:
    return _contract_runtime_profile()


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    data = json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n"
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(data)
        handle.flush()
        _fsync(handle.fileno())
    temporary.replace(path)


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path.name} must contain a JSON object")
    return value


def _fsync(file_descriptor: int) -> None:
    try:
        import os

        os.fsync(file_descriptor)
    except OSError:
        # Some test filesystems do not provide durable fsync. Atomic replacement
        # still applies; the service records the actual runtime environment.
        pass


def _reject_symlink_components(path: str | Path) -> Path:
    candidate = Path(os.path.abspath(os.fspath(path)))
    current = Path(candidate.anchor)
    for part in candidate.parts[1:]:
        current /= part
        if current.is_symlink():
            raise RuntimeError("worker path contains a symlink component")
    return candidate


def import_model(model_path: Path, *, source_bytes: bytes | None = None) -> type[Any]:
    if model_path.name != "model.py" or model_path.is_symlink() or not model_path.is_file():
        raise RuntimeError("reviewed wind bundle model.py is unavailable")
    module_name = f"riff_wind_turbine_reviewed_model_{uuid.uuid4().hex}"
    module = types.ModuleType(module_name)
    module.__file__ = str(model_path)
    module.__package__ = ""
    previous = sys.modules.get(module_name)
    sys.modules[module_name] = module
    try:
        # Execute verified source bytes directly. Importlib's source loader
        # writes __pycache__ beside model.py, which would mutate an immutable
        # content-addressed bundle and make its next verification fail.
        source = model_path.read_bytes() if source_bytes is None else source_bytes
        exec(compile(source, str(model_path), "exec"), module.__dict__)
    finally:
        if previous is None:
            sys.modules.pop(module_name, None)
        else:
            sys.modules[module_name] = previous
    model_class = getattr(module, "WindTurbineMaintenanceModel", None)
    if model_class is None:
        raise RuntimeError("model revision does not export WindTurbineMaintenanceModel")
    return model_class


def _capture_verified_bundle(bundle_dir: Path, expected_revision_id: str) -> tuple[dict[str, Any], dict[str, bytes]]:
    """Capture one verified immutable bundle snapshot for actual execution."""

    from .gate3_bundle import FRAMED_FILES, framed_revision_id
    from .verify_bundle import verify_bundle

    verified = verify_bundle(bundle_dir)
    if verified.get("model_revision_id") != expected_revision_id:
        raise RuntimeError("worker bundle verification returned the wrong model revision")
    if verified.get("bundle_branch") != "framed":
        raise RuntimeError("wind worker accepts only the exact framed reviewed bundle")
    expected_bundle_files = FRAMED_FILES
    expected_paths = {"manifest.json", *expected_bundle_files}
    actual_paths = {
        path.relative_to(bundle_dir).as_posix()
        for path in bundle_dir.rglob("*")
        if path.is_file()
    }
    if actual_paths != expected_paths:
        raise RuntimeError("worker bundle file set changed during verification")
    captured: dict[str, bytes] = {}
    for relative in expected_paths:
        path = _reject_symlink_components(bundle_dir / relative)
        if not path.is_file():
            raise RuntimeError(f"worker bundle input is unavailable: {relative}")
        captured[relative] = path.read_bytes()
    try:
        manifest = json.loads(captured["manifest.json"])
    except json.JSONDecodeError as exc:
        raise RuntimeError("worker captured an invalid bundle manifest") from exc
    expected_manifest_keys = {
        "schema_version", "bundle_protocol", "model_id", "model_revision_id", "runtime_profile", "files"
    }
    if not isinstance(manifest, dict) or set(manifest) != expected_manifest_keys:
        raise RuntimeError("worker captured a non-canonical bundle manifest contract")
    files = manifest["files"]
    if not isinstance(files, dict) or set(files) != set(expected_bundle_files):
        raise RuntimeError("worker captured an invalid bundle file declaration set")
    for relative in expected_bundle_files:
        declaration = files[relative]
        data = captured[relative]
        if (
            not isinstance(declaration, dict)
            or declaration.get("sha256") != sha256_bytes(data)
            or declaration.get("byte_length") != len(data)
        ):
            raise RuntimeError(f"worker bundle input drifted during capture: {relative}")
    computed_revision = framed_revision_id(files)
    if (
        manifest.get("model_id") != MODEL_ID
        or manifest.get("model_revision_id") != expected_revision_id
        or computed_revision != expected_revision_id
        or bundle_dir.name != expected_revision_id
    ):
        raise RuntimeError("worker captured bundle bytes do not match the expected model revision")
    return manifest, captured


def initial_metadata_v2(request: dict[str, Any], *, status: str = "queued") -> dict[str, Any]:
    validate_request_v2(request)
    identity = {key: request[key] for key in V2_IDENTITY_FIELDS}
    return {
        **identity,
        "status": status,
        "created_at": time.time(),
        "claim_labels": request["claim_labels"],
        "experiment_sha256": request["experiment_sha256"],
        "run_intent_digest": request["run_intent_digest"],
        "downstream_request_digest": request["downstream_request_digest"],
        "runtime_profile": request["runtime_profile"],
        "limits": dict(FRAMED_LIMITS),
        "event_truncated": False,
        "processed_scheduled_event_count": 0,
        "emitted_domain_event_count": 0,
        "digests": {"request_sha256": sha256_bytes(canonical_json_v2_bytes(request))},
    }


def validate_request(request: object) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise RuntimeError("wind worker request must be an object")
    required = {
        *IDENTITY_FIELDS,
        "parameters",
        "horizon_days",
        "warmup_days",
        "claim_labels",
        "brief_revision_id",
        "alignment_revision_id",
        "workflow_policy",
        "trust_label",
        "runtime_profile",
    }
    if set(request) != required:
        raise RuntimeError(f"wind worker request keys do not match the reviewed contract: {sorted(request)}")
    if request["model_id"] != MODEL_ID:
        raise RuntimeError("wind worker request has the wrong model identity")
    for key, prefix in (("model_revision_id", "mr_"), ("experiment_revision_id", "er_")):
        value = request[key]
        if not isinstance(value, str) or len(value) != 67 or not value.startswith(prefix):
            raise RuntimeError(f"invalid {key}")
        try:
            int(value[3:], 16)
        except ValueError as exc:
            raise RuntimeError(f"invalid {key}") from exc
    for key in ("project_id", "run_id", "preset_id"):
        if not isinstance(request[key], str) or not request[key]:
            raise RuntimeError(f"invalid {key}")
    if not isinstance(request["seed"], int) or isinstance(request["seed"], bool):
        raise RuntimeError("seed must be one integer")
    horizon = request["horizon_days"]
    warmup = request["warmup_days"]
    if not isinstance(horizon, int) or isinstance(horizon, bool) or not 1 <= horizon <= 3660:
        raise RuntimeError("horizon_days is outside the reviewed limit")
    if not isinstance(warmup, int) or isinstance(warmup, bool) or not 0 <= warmup < horizon:
        raise RuntimeError("warmup_days must be lower than horizon_days")
    if not isinstance(request["parameters"], dict):
        raise RuntimeError("parameters must be an object")
    if set(request["claim_labels"]) != set(REQUIRED_CLAIM_LABELS):
        raise RuntimeError("claim boundary labels do not match the reviewed preset")
    if request["workflow_policy"] != "workflow_policy_unmet" or request["trust_label"] != "draft_unverified":
        raise RuntimeError("Gate 1 wind runs must retain draft policy labels")
    actual_profile = runtime_profile()
    if request["runtime_profile"] != actual_profile:
        raise RuntimeError("runtime profile does not match the reviewed experiment revision")
    canonical_json_bytes(request)
    return request


def validate_request_v2(request: object) -> dict[str, Any]:
    from .canonical_v2 import canonical_json_v2_bytes
    from .gate2_contracts import V2_IDENTITY_FIELDS as CONTRACT_IDENTITY_FIELDS
    from .gate2_contracts import validate_experiment_for_run, validate_run_admission
    from .wind_contracts import validate_parameters

    if not isinstance(request, dict):
        raise RuntimeError("v2 wind worker request must be an object")
    required = {
        *CONTRACT_IDENTITY_FIELDS,
        "experiment_sha256", "run_intent_digest", "downstream_request_digest",
        "experiment_document", "run_admission", "parameters", "horizon_days", "warmup_days",
        "runtime_profile", "claim_labels",
    }
    if set(request) != required:
        raise RuntimeError("v2 wind worker request keys do not match the exact contract")
    try:
        experiment = validate_experiment_for_run(request["experiment_document"])
        admission = validate_run_admission(request["run_admission"])
        parameters = validate_parameters(request["parameters"])
    except Exception as exc:
        raise RuntimeError(f"v2 embedded document is invalid: {exc}") from exc
    framed_schema = experiment.get("schema_id") == "riff://evidence-studio/experiment-revision/framed/v1"
    experiment_bytes = canonical_json_v2_bytes(experiment) + (b"\n" if framed_schema else b"")
    if sha256_bytes(experiment_bytes) != request["experiment_sha256"]:
        raise RuntimeError("embedded experiment SHA does not match exact canonical bytes")
    if parameters != experiment["parameters"]:
        raise RuntimeError("worker parameters differ from embedded experiment")
    identity = {key: request[key] for key in V2_IDENTITY_FIELDS}
    expected_identity = {
        "project_id": admission["project_id"], "run_id": admission["run_id"], "model_id": admission["model_id"],
        "model_revision_id": admission["model_revision_id"], "brief_revision_id": admission["brief_revision_id"],
        "alignment_revision_id": admission["alignment_revision_id"], "experiment_revision_id": admission["experiment_revision_id"],
        "preset_id": experiment["preset_id"], "seed": experiment["execution_values"]["seed"],
        "visibility": admission["visibility"], "trust_label": admission["trust_label"],
        "workflow_label": admission["workflow_label"], "policy_snapshot_digest": admission["policy_snapshot_digest"],
        "run_admission_digest": admission["run_admission_digest"],
    }
    if identity != expected_identity:
        raise RuntimeError("v2 request identity differs from embedded admission/experiment")
    if (
        request["experiment_sha256"] != admission["experiment_sha256"]
        or request["horizon_days"] != experiment["execution_values"]["horizon_days"]
        or request["warmup_days"] != experiment["execution_values"]["warmup_days"]
        or request["runtime_profile"] != experiment["runtime_profile"]
        or not isinstance(request["run_intent_digest"], str)
        or re.fullmatch(r"ri_[0-9a-f]{64}", request["run_intent_digest"]) is None
        or not isinstance(request["downstream_request_digest"], str)
        or re.fullmatch(r"rq_[0-9a-f]{64}", request["downstream_request_digest"]) is None
        or set(request["claim_labels"]) != set(REQUIRED_CLAIM_LABELS)
    ):
        raise RuntimeError("v2 request bindings are inconsistent")
    framed_protocol = request["runtime_profile"].get("model_protocol_version") == "wind-turbine-maintenance-v2-framed-replay"
    if not framed_schema or not framed_protocol:
        raise RuntimeError("v2 wind worker accepts only framed experiment/runtime evidence")
    canonical_json_v2_bytes(request)
    return request


def _validate_request_experiment_binding(
    request: dict[str, Any],
    *,
    expected_model_revision_id: str,
    expected_experiment_revision_id: str,
) -> dict[str, Any]:
    if "experiment_document" not in request:
        raise RuntimeError("worker request lacks the framed experiment document")
    experiment = request["experiment_document"]
    if request["model_revision_id"] != expected_model_revision_id:
        raise RuntimeError("request model revision does not match the parent-admitted revision")
    if request["experiment_revision_id"] != expected_experiment_revision_id:
        raise RuntimeError("request experiment revision does not match the parent-admitted revision")
    if (
        experiment["model_revision_id"] != expected_model_revision_id
        or experiment["experiment_revision_id"] != expected_experiment_revision_id
    ):
        raise RuntimeError("embedded experiment identity differs from parent admission")
    return experiment


def _metric_contract(schema: object) -> dict[str, dict[str, Any]]:
    if not isinstance(schema, dict):
        raise RuntimeError("metric schema must be an object")
    properties = schema.get("properties")
    required = schema.get("required")
    if (
        schema.get("type") != "object"
        or schema.get("additionalProperties") is not False
        or not isinstance(properties, dict)
        or not isinstance(required, list)
        or len(required) != len(set(required))
        or set(required) != set(properties)
    ):
        raise RuntimeError("metric schema must declare one exact required property set")
    return properties


def _validate_metric_mapping(
    value: object,
    schema: object,
    *,
    context: str,
) -> dict[str, int | float]:
    if not isinstance(value, dict):
        raise RuntimeError(f"{context} must be an object")
    properties = _metric_contract(schema)
    if set(value) != set(properties):
        raise RuntimeError(
            f"{context} keys do not exactly match metric schema; "
            f"missing={sorted(set(properties) - set(value))}, unknown={sorted(set(value) - set(properties))}"
        )
    normalized: dict[str, int | float] = {}
    for key in properties:
        item = value[key]
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item):
            raise RuntimeError(f"{context}.{key} must be finite numeric data")
        definition = properties[key]
        if not isinstance(definition, dict) or definition.get("type") not in {"integer", "number"}:
            raise RuntimeError(f"metric schema definition is unsupported: {key}")
        if definition["type"] == "integer" and not isinstance(item, int):
            raise RuntimeError(f"{context}.{key} must be an integer")
        if "enum" in definition and item not in definition["enum"]:
            raise RuntimeError(f"{context}.{key} is outside the metric schema vocabulary")
        # Canonical CSV evidence uses integer spelling for mathematically
        # integral values (notably empty-window 0 and final elapsed days).
        normalized[key] = int(item) if isinstance(item, float) and item.is_integer() else item
    return normalized


def _parse_metric_csv_row(
    row: dict[str, str],
    schema: object,
    *,
    context: str,
) -> dict[str, int | float]:
    properties = _metric_contract(schema)
    if set(row) != set(properties):
        raise RuntimeError(f"{context} columns do not exactly match metric schema")
    parsed: dict[str, int | float] = {}
    for key, definition in properties.items():
        value = row[key]
        if definition["type"] == "integer":
            if not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value or ""):
                raise RuntimeError(f"{context}.{key} must use integer encoding")
            parsed_value: int | float = int(value)
        else:
            try:
                parsed_value = float(value)
            except (TypeError, ValueError) as exc:
                raise RuntimeError(f"{context}.{key} must be numeric") from exc
            if not math.isfinite(parsed_value):
                raise RuntimeError(f"{context}.{key} must be finite")
        if "enum" in definition and parsed_value not in definition["enum"]:
            raise RuntimeError(f"{context}.{key} is outside the metric schema vocabulary")
        parsed[key] = parsed_value
    return parsed


def _identity_fields(request: dict[str, Any]) -> tuple[str, ...]:
    return V2_IDENTITY_FIELDS if "workflow_label" in request else IDENTITY_FIELDS


def _identity(request: dict[str, Any]) -> dict[str, Any]:
    return {key: request[key] for key in _identity_fields(request)}


def _validate_domain_event(event: object, expected_identity: dict[str, Any] | None = None) -> dict[str, Any]:
    identity_fields = tuple(expected_identity) if expected_identity is not None else IDENTITY_FIELDS
    if not isinstance(event, dict) or set(event) != RAW_EVENT_FIELDS | set(identity_fields):
        raise RuntimeError("domain event schema keys are not exact")
    sequence = event["sequence"]
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
        raise RuntimeError("domain event sequence must be a positive integer")
    if event["event_id"] != f"event-{sequence:08d}":
        raise RuntimeError("domain event ID does not match its sequence")
    sim_time = event["sim_time_days"]
    if isinstance(sim_time, bool) or not isinstance(sim_time, (int, float)) or not math.isfinite(sim_time) or sim_time < 0:
        raise RuntimeError("domain event time must be finite and non-negative")
    event_type = event["event_type"]
    if event_type not in EVENT_PHASES:
        raise RuntimeError("domain event type is outside the reviewed vocabulary")
    phase = event["phase"]
    if not isinstance(phase, int) or isinstance(phase, bool) or phase not in EVENT_PHASES[event_type]:
        raise RuntimeError(f"domain event phase is invalid for {event_type}")
    patterns = {
        "turbine_id": r"turbine-[0-9]{4}",
        "crew_id": r"crew-[0-9]{3}",
        "work_order_id": r"work-[0-9]{8}",
    }
    for key, pattern in patterns.items():
        value = event[key]
        if value is not None and (not isinstance(value, str) or re.fullmatch(pattern, value) is None):
            raise RuntimeError(f"domain event {key} is invalid")
    correlation = event["correlation_id"]
    if correlation is not None and not isinstance(correlation, str):
        raise RuntimeError("domain event correlation_id is invalid")
    for key in ("before_state", "after_state"):
        value = event[key]
        if value is not None and value not in STATE_VOCABULARY:
            raise RuntimeError(f"domain event {key} is outside the reviewed state vocabulary")
    if not isinstance(event["payload"], dict):
        raise RuntimeError("domain event payload must be an object")
    identity = {key: event[key] for key in identity_fields}
    if expected_identity is not None and identity != expected_identity:
        raise RuntimeError("domain event identity does not match the run request")
    canonical_json_bytes(event)
    return event


def _enrich_event(raw: object, request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) != RAW_EVENT_FIELDS:
        raise RuntimeError("model event schema keys are not exact")
    event = {**raw, **_identity(request)}
    return _validate_domain_event(event, _identity(request))


def _semantic_event_projection(event: dict[str, Any], profile: dict[str, str]) -> dict[str, Any]:
    fields = (
        "sequence",
        "sim_time_days",
        "event_type",
        "phase",
        "turbine_id",
        "crew_id",
        "work_order_id",
        "correlation_id",
        "before_state",
        "after_state",
        "payload",
        "model_id",
        "model_revision_id",
        "experiment_revision_id",
        "preset_id",
        "seed",
    )
    return {**{key: event.get(key) for key in fields}, "runtime_profile": profile}


def _semantic_without_run_context(value: object) -> object:
    is_v2 = isinstance(value, dict) and "workflow_label" in value
    excluded = {"project_id", "run_id", "created_at", "started_at", "finished_at", "worker_pid", "path"}
    if is_v2:
        excluded |= {
            "brief_revision_id", "alignment_revision_id", "visibility", "trust_label", "workflow_label",
            "policy_snapshot_digest", "run_admission_digest", "run_intent_digest", "downstream_request_digest",
            "experiment_sha256",
        }

    def project(item: object) -> object:
        if isinstance(item, list):
            return [project(nested) for nested in item]
        if isinstance(item, dict):
            return {key: project(nested) for key, nested in item.items() if key not in excluded}
        return item

    return project(value)


def _write_event_batch(
    events: Iterable[object],
    *,
    request: dict[str, Any],
    event_handle: Any,
    kpi_state: dict[str, Any],
    semantic_event_digest: Any,
    expected_sequence: int,
    emitted_bytes: int,
) -> tuple[int, int, int]:
    emitted = 0
    for raw in events:
        event = _enrich_event(raw, request)
        if event["sequence"] != expected_sequence:
            raise RuntimeError(f"domain event sequence gap: expected {expected_sequence}, got {event['sequence']}")
        if expected_sequence > LIMITS["emitted_domain_events"]:
            raise WorkerLimitError("emitted domain event limit reached; output was not truncated")
        encoded = canonical_json_bytes(event) + b"\n"
        emitted_bytes += len(encoded)
        if emitted_bytes > LIMITS["domain_event_bytes"]:
            raise WorkerLimitError("domain event byte limit reached; output was not truncated")
        event_handle.write(encoded)
        projection = _semantic_event_projection(event, request["runtime_profile"])
        semantic_event_digest.update(
            canonical_json_v2_bytes(projection) if "workflow_label" in request else canonical_json_bytes(projection)
        )
        if event["event_type"] == "daily_snapshot":
            payload = event["payload"]
            snapshot = payload.get("snapshot", payload) if isinstance(payload, dict) else payload
            row = _validate_metric_mapping(snapshot, kpi_state["metric_schema"], context="daily snapshot")
            if kpi_state.get("writer") is None:
                fieldnames = [*_identity_fields(request), *row.keys()]
                if len(fieldnames) != len(set(fieldnames)):
                    raise RuntimeError("snapshot keys collide with run identity fields")
                writer = csv.DictWriter(kpi_state["handle"], fieldnames=fieldnames)
                writer.writeheader()
                kpi_state["writer"] = writer
                kpi_state["snapshot_keys"] = tuple(row)
            elif tuple(row) != kpi_state["snapshot_keys"]:
                raise RuntimeError("daily snapshot fields changed during the run")
            kpi_state["writer"].writerow({**_identity(request), **row})
        expected_sequence += 1
        emitted += 1
    return expected_sequence, emitted_bytes, emitted


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _framed_artifact_id(run_id: str, name: str, digest: str) -> str:
    from .canonical_v2 import sha256_v2
    return "artifact_" + sha256_v2({"run_id": run_id, "name": name, "sha256": digest})


def _framed_event_ranges(
    path: Path,
    frames: list[dict[str, Any]],
    profile: dict[str, str],
) -> tuple[list[dict[str, Any]], str, int]:
    """Build exact contiguous raw/semantic partitions through sampled events."""

    ranges: list[dict[str, Any]] = []
    targets = {int(frame["through_event_sequence"]): index for index, frame in enumerate(frames)}
    start_offset = 0
    current_raw = bytearray()
    current_semantic = hashlib.sha256()
    first_sequence = 1
    final_sequence = 0
    offset = 0
    whole_semantic = hashlib.sha256()
    with path.open("rb") as handle:
        for line in handle:
            if not line.endswith(b"\n"):
                raise RuntimeError("framed event source lacks a final newline")
            try:
                event = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RuntimeError("framed event source contains invalid JSON") from exc
            sequence = event.get("sequence")
            if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence != final_sequence + 1:
                raise RuntimeError("framed event source sequence is not gap-free")
            semantic = canonical_json_v2_bytes(_semantic_event_projection(event, profile))
            whole_semantic.update(semantic)
            current_semantic.update(semantic)
            current_raw.extend(line)
            final_sequence = sequence
            offset += len(line)
            if sequence in targets:
                frame_index = targets[sequence]
                frame = frames[frame_index]
                event_payload = event.get("payload")
                if (
                    event.get("event_type") != "daily_snapshot"
                    or event.get("phase") != 50
                    or int(event.get("sim_time_days", -1)) != frame["day"]
                    or not isinstance(event_payload, dict)
                    or event_payload.get("frame_state_sha256") != frame["frame_state_sha256"]
                ):
                    raise RuntimeError("sampled frame does not bind its phase-50 event")
                value = {
                    "range_index": len(ranges),
                    "event_count": sequence - first_sequence + 1,
                    "first_sequence": first_sequence,
                    "last_sequence": sequence,
                    "byte_offset": start_offset,
                    "byte_length": len(current_raw),
                    "raw_range_sha256": hashlib.sha256(current_raw).hexdigest(),
                    "semantic_range_sha256": current_semantic.hexdigest(),
                }
                ranges.append(value)
                frame["source_event_range_index"] = value["range_index"]
                current_raw.clear()
                current_semantic = hashlib.sha256()
                start_offset = offset
                first_sequence = sequence + 1
    if current_raw or not frames or len(ranges) != len(frames) or start_offset != path.stat().st_size:
        raise RuntimeError("sampled frame ranges do not partition the event source")
    return ranges, whole_semantic.hexdigest(), final_sequence


def _framed_source_set_digest(manifest_files: dict[str, Any]) -> str:
    from .canonical_v2 import sha256_v2
    names = (
        "model-spec.json", "parameter-schema.json", "execution-field-schema.json",
        "metric-schema.json", "visualization.json", "traceability.json",
        "defaults/wind-turbine-maintenance-demo-v1.json", "provenance.json",
    )
    return "viewsrc_" + sha256_v2({name: manifest_files[name]["sha256"] for name in names})


def execute(
    model_path: Path,
    request_path: Path,
    output_dir: Path,
    delay_per_day: float = 0.0,
    *,
    expected_request_sha256: str,
    expected_model_revision_id: str,
    expected_experiment_revision_id: str,
) -> dict[str, Any]:
    model_path = _reject_symlink_components(model_path)
    request_path = _reject_symlink_components(request_path)
    output_dir = _reject_symlink_components(output_dir)
    for bundle_entry in model_path.parent.rglob("*"):
        _reject_symlink_components(bundle_entry)
    if re.fullmatch(r"[0-9a-f]{64}", expected_request_sha256) is None:
        raise RuntimeError("parent-admitted request digest is invalid")
    if re.fullmatch(r"mr_[0-9a-f]{64}", expected_model_revision_id) is None:
        raise RuntimeError("parent-admitted model revision is invalid")
    if re.fullmatch(r"er_[0-9a-f]{64}", expected_experiment_revision_id) is None:
        raise RuntimeError("parent-admitted experiment revision is invalid")

    manifest, captured_bundle = _capture_verified_bundle(model_path.parent, expected_model_revision_id)
    request_bytes = request_path.read_bytes()
    if sha256_bytes(request_bytes) != expected_request_sha256:
        raise RuntimeError("request bytes drifted after parent admission")
    try:
        request_payload = json.loads(request_bytes)
    except json.JSONDecodeError as exc:
        raise RuntimeError("request bytes are not valid JSON") from exc
    if not isinstance(request_payload, dict) or "experiment_document" not in request_payload:
        raise RuntimeError("wind worker accepts only a framed v2 request")
    if request_bytes != canonical_json_v2_bytes(request_payload):
        raise RuntimeError("captured request bytes are not exact riff-canonical-json-v2")
    request = validate_request_v2(request_payload)
    _validate_request_experiment_binding(
        request,
        expected_model_revision_id=expected_model_revision_id,
        expected_experiment_revision_id=expected_experiment_revision_id,
    )
    if manifest.get("model_id") != MODEL_ID or manifest.get("model_revision_id") != request["model_revision_id"]:
        raise RuntimeError("reviewed model manifest identity does not match the run request")
    manifest_files = manifest.get("files")
    if not isinstance(manifest_files, dict):
        raise RuntimeError("reviewed model manifest file declarations are unavailable")
    metric_schema = json.loads(captured_bundle["metric-schema.json"])
    _metric_contract(metric_schema)
    if request["runtime_profile"].get("model_protocol_version") != "wind-turbine-maintenance-v2-framed-replay":
        raise RuntimeError("framed bundle requires the exact framed runtime profile")
    output_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = output_dir / "metadata.json"
    metadata = read_json(metadata_path) if metadata_path.exists() else initial_metadata_v2(request)
    if _identity(metadata) != _identity(request):
        raise RuntimeError("worker metadata identity does not match the admitted request")
    recorded_request_digest = metadata.get("digests", {}).get("request_sha256")
    canonical_request = canonical_json_v2_bytes(request)
    if recorded_request_digest != sha256_bytes(canonical_request):
        raise RuntimeError("worker metadata does not bind the admitted request content")
    started_at_text = _iso_now()
    metadata.update({"status": "running", "started_at": time.time(), "started_at_iso": started_at_text})
    atomic_json(metadata_path, metadata)

    cancel_marker = output_dir / "cancel_requested"
    expected_sequence = 1
    emitted_count = 0
    emitted_bytes = 0
    semantic_event_digest = hashlib.sha256()
    events_path = output_dir / "domain-events.jsonl"
    kpis_path = output_dir / "daily-kpis.csv"
    with events_path.open("wb") as event_handle, kpis_path.open("w", newline="", encoding="utf-8") as kpi_handle:
        kpi_state: dict[str, Any] = {
            "handle": kpi_handle,
            "writer": None,
            "metric_schema": metric_schema,
        }

        def stream_event(raw: dict[str, Any]) -> None:
            nonlocal expected_sequence, emitted_bytes, emitted_count
            expected_sequence, emitted_bytes, emitted = _write_event_batch(
                (raw,),
                request=request,
                event_handle=event_handle,
                kpi_state=kpi_state,
                semantic_event_digest=semantic_event_digest,
                expected_sequence=expected_sequence,
                emitted_bytes=emitted_bytes,
            )
            emitted_count += emitted
            if emitted_count % 100 == 0 and cancel_marker.exists():
                raise CancelledRun("cancel marker observed")

        model_class = import_model(model_path, source_bytes=captured_bundle["model.py"])
        replay_frames: list[dict[str, Any]] = []
        framed_sample_days: list[int] = []
        if int(request["parameters"]["turbine_count"]) <= 100 and int(request["parameters"]["crew_count"]) <= 50:
            from .gate3_contracts import sample_days
            framed_sample_days = sample_days(request["horizon_days"], request["warmup_days"])
            worst_case = len(framed_sample_days) * (
                6_000 + 140 * int(request["parameters"]["turbine_count"]) + 180 * int(request["parameters"]["crew_count"])
            )
            if worst_case > FRAMED_LIMITS["replay_manifest_bytes"]:
                raise WorkerLimitError("framed replay manifest preflight limit reached")

        def capture_replay(raw_frame: dict[str, Any], through_sequence: int) -> None:
            frame = dict(raw_frame)
            frame["identity"] = {key: request[key] for key in V2_IDENTITY_FIELDS}
            frame["through_event_sequence"] = through_sequence
            replay_frames.append(frame)

        model_kwargs: dict[str, Any] = {
            "parameters": request["parameters"],
            "horizon_days": request["horizon_days"],
            "warmup_days": request["warmup_days"],
            "seed": request["seed"],
            "event_sink": stream_event,
        }
        model_kwargs.update({
            "replay_sample_days": set(framed_sample_days),
            "replay_sink": capture_replay if framed_sample_days else None,
            "replay_identity": {
                "model_revision_id": request["model_revision_id"],
                "experiment_revision_id": request["experiment_revision_id"],
                "preset_id": request["preset_id"],
            },
        })
        model = model_class(
            **model_kwargs,
        )
        if kpi_state["writer"] is None:
            raise RuntimeError("model initialization did not emit the required day-zero snapshot")
        while True:
            snapshot = _validate_metric_mapping(model.snapshot(), metric_schema, context="model snapshot")
            processed = int(snapshot.get("processed_scheduled_event_count", emitted_count))
            pending = int(snapshot.get("pending_scheduled_event_count", 0))
            if processed > LIMITS["processed_scheduled_events"]:
                raise WorkerLimitError("processed scheduled event limit reached")
            if pending > LIMITS["pending_scheduler_events"]:
                raise WorkerLimitError("pending scheduler event limit reached")
            if cancel_marker.exists():
                raise CancelledRun("cancel marker observed")
            if float(model.sim_time_days) >= request["horizon_days"]:
                break
            if delay_per_day:
                time.sleep(delay_per_day)
            model.step()
        event_handle.flush()
        _fsync(event_handle.fileno())
        kpi_handle.flush()
        _fsync(kpi_handle.fileno())

    if kpis_path.stat().st_size > LIMITS["daily_kpi_bytes"]:
        raise WorkerLimitError("daily KPI byte limit reached")
    final_snapshot = _validate_metric_mapping(model.snapshot(), metric_schema, context="final model snapshot")
    measurement_days = request["horizon_days"] - request["warmup_days"]
    minimum_availability = float(request["parameters"]["minimum_availability_fraction"])
    annualized_operating_revenue = float(final_snapshot["operating_revenue"]) * 365 / measurement_days
    annualized_maintenance_expense = float(final_snapshot["total_maintenance_cost"]) * 365 / measurement_days
    summary = {
        **_identity(request),
        "claim_labels": request["claim_labels"],
        "measurement_window_days": measurement_days,
        "seed_count": 1,
        "minimum_availability_fraction": minimum_availability,
        "minimum_availability_met": bool(final_snapshot["availability_fraction"] >= minimum_availability),
        "staffing_recommendation": None,
        "metrics": final_snapshot,
        "annualized_maintenance_cost": annualized_maintenance_expense,
        "annualized_operating_revenue": annualized_operating_revenue,
        "annualized_maintenance_expense": annualized_maintenance_expense,
        "annualized_profit": annualized_operating_revenue - annualized_maintenance_expense,
        "non_claims": [
            "not_anylogic_runtime_or_numerical_equivalence",
            "not_calibrated_to_a_real_wind_farm",
            "single_seed_is_not_uncertainty_analysis",
            "no_staffing_recommendation",
        ],
    }
    summary_path = output_dir / "summary.json"
    _atomic_canonical_v2_lf(summary_path, summary)

    canonical_event_sha = semantic_event_digest.hexdigest()
    if manifest.get("bundle_protocol") == "wind-turbine-maintenance-bundle-v2-framed":
        from .gate3_contracts import CLAIM_LABELS, EMPTY_ARRAY_SHA256, NON_CLAIMS, sample_days_sha256
        replay_identity = {key: request[key] for key in V2_IDENTITY_FIELDS}
        event_source = {
            "logical_name": "domain-events.jsonl",
            "byte_length": events_path.stat().st_size,
            "event_count": emitted_count,
            "raw_sha256": sha256_file(events_path),
            "semantic_sha256": canonical_event_sha,
            "final_newline": True,
        }
        if framed_sample_days:
            if len(replay_frames) != len(framed_sample_days):
                raise RuntimeError("model did not capture every required sampled day")
            replay_frames.sort(key=lambda item: item["day"])
            for index, frame in enumerate(replay_frames):
                frame["frame_index"] = index
            ranges, range_semantic, range_count = _framed_event_ranges(events_path, replay_frames, request["runtime_profile"])
            if range_semantic != canonical_event_sha or range_count != emitted_count:
                raise RuntimeError("framed range semantic digest differs from complete event source")
            replay = {
                "schema_id": "riff://wind-turbine-maintenance/replay-manifest/framed/v1",
                "schema_version": 1,
                "canonical_json_version": "riff-canonical-json-v2",
                "manifest_kind": "complete",
                "identity": replay_identity,
                "generator_version": "wind-worker-sampled-replay-v1",
                "sampling_algorithm": "wind-replay-sample-days-v1",
                "declared_population": {"turbine_count": request["parameters"]["turbine_count"], "crew_count": request["parameters"]["crew_count"]},
                "event_source": event_source,
                "sample_days": framed_sample_days,
                "sample_days_sha256": sample_days_sha256(framed_sample_days),
                "frame_count": len(replay_frames),
                "source_event_ranges": ranges,
                "frames": replay_frames,
                "claim_labels": CLAIM_LABELS,
                "non_claims": NON_CLAIMS,
            }
        else:
            replay = {
                "schema_id": "riff://wind-turbine-maintenance/replay-manifest/framed/v1",
                "schema_version": 1,
                "canonical_json_version": "riff-canonical-json-v2",
                "manifest_kind": "unavailable_population_limit",
                "identity": replay_identity,
                "generator_version": "wind-worker-sampled-replay-v1",
                "sampling_algorithm": "wind-replay-sample-days-v1",
                "declared_population": {"turbine_count": request["parameters"]["turbine_count"], "crew_count": request["parameters"]["crew_count"]},
                "event_source": event_source,
                "unavailable_reason": "population_exceeds_frame_contract",
                "sample_days": [],
                "sample_days_sha256": EMPTY_ARRAY_SHA256,
                "frame_count": 0,
                "source_event_ranges": [],
                "frames": [],
                "claim_labels": CLAIM_LABELS,
                "non_claims": NON_CLAIMS,
            }
    replay_path = output_dir / "replay-manifest.json"
    _atomic_canonical_v2_lf(replay_path, replay)

    derived_path = output_dir / "derived-views-manifest.json"
    if manifest.get("bundle_protocol") == "wind-turbine-maintenance-bundle-v2-framed":
        from .canonical_v2 import sha256_v2
        from .gate3_contracts import CLAIM_LABELS, NON_CLAIMS, metadata_core_digest
        completed_at_text = _iso_now()
        core_projection = {
            "schema_id": "riff://wind-turbine-maintenance/metadata-core-projection/v1",
            "schema_version": 1,
            "canonical_json_version": "riff-canonical-json-v2",
            **{key: request[key] for key in V2_IDENTITY_FIELDS},
            "run_intent_digest": request["run_intent_digest"],
            "request_digest": sha256_file(request_path),
            "experiment_digest": request["experiment_sha256"],
            "runtime_profile": request["runtime_profile"],
            "terminal_status": "succeeded",
            "started_at": started_at_text,
            "completed_at": completed_at_text,
        }
        core_digest = metadata_core_digest(core_projection)
        metadata_artifact = {
            "schema_id": "riff://wind-turbine-maintenance/metadata/framed/v1",
            "schema_version": 1,
            "canonical_json_version": "riff-canonical-json-v2",
            "metadata_kind": "framed_terminal_core",
            "metadata_core_projection": core_projection,
            "metadata_core_digest": core_digest,
        }
        _atomic_canonical_v2_lf(metadata_path, metadata_artifact)
        input_paths = {
            "request.json": request_path,
            "daily-kpis.csv": kpis_path,
            "domain-events.jsonl": events_path,
            "summary.json": summary_path,
            "replay-manifest.json": replay_path,
        }
        artifacts_input = {}
        for name, path in input_paths.items():
            digest = sha256_file(path)
            artifacts_input[name] = {"artifact_id": _framed_artifact_id(request["run_id"], name, digest), "sha256": digest}
        event_projection = {
            "projection_kind": "filtered_domain_events", "projection_schema_version": 1,
            "run_id": request["run_id"], "domain_events_sha256": artifacts_input["domain-events.jsonl"]["sha256"], "event_count": emitted_count,
        }
        kpi_projection = {
            "projection_kind": "daily_kpis", "projection_schema_version": 1, "run_id": request["run_id"],
            "daily_kpis_sha256": artifacts_input["daily-kpis.csv"]["sha256"], "summary_sha256": artifacts_input["summary.json"]["sha256"],
        }
        replay_projection = {
            "projection_kind": "sampled_replay", "projection_schema_version": 1, "run_id": request["run_id"],
            "replay_manifest_sha256": artifacts_input["replay-manifest.json"]["sha256"], "manifest_kind": replay["manifest_kind"], "frame_count": replay["frame_count"],
        }
        label_projection = {
            "projection_kind": "run_labels", "projection_schema_version": 1, "run_id": request["run_id"],
            "summary_sha256": artifacts_input["summary.json"]["sha256"], "replay_manifest_sha256": artifacts_input["replay-manifest.json"]["sha256"],
            "claim_labels": CLAIM_LABELS, "non_claims": NON_CLAIMS,
        }
        derived = {
            "schema_id": "riff://wind-turbine-maintenance/derived-views-manifest/framed/v1",
            "schema_version": 1,
            "canonical_json_version": "riff-canonical-json-v2",
            "manifest_kind": "framed_evidence_views",
            "identity": replay_identity,
            "generator": {"generator_id": "wind-evidence-derived-views", "generator_version": "wind-evidence-derived-views-v1"},
            "inputs": {
                "metadata_core": {"metadata_core_digest": core_digest},
                "model_sources": {"model_revision_id": request["model_revision_id"], "source_set_digest": _framed_source_set_digest(manifest_files)},
                "artifacts": artifacts_input,
            },
            "claim_labels": CLAIM_LABELS,
            "non_claims": NON_CLAIMS,
            "projection_digests": {
                "event_projection_sha256": sha256_v2(event_projection),
                "kpi_projection_sha256": sha256_v2(kpi_projection),
                "replay_projection_sha256": sha256_v2(replay_projection),
                "label_projection_sha256": sha256_v2(label_projection),
            },
        }
        _atomic_canonical_v2_lf(derived_path, derived)
    entries = list(output_dir.iterdir())
    entry_names = {path.name for path in entries}
    if entry_names != REQUIRED_SUCCESS_ARTIFACTS or len(entries) != len(REQUIRED_SUCCESS_ARTIFACTS):
        raise RuntimeError(
            "successful worker artifact set is not exact; "
            f"missing={sorted(REQUIRED_SUCCESS_ARTIFACTS - entry_names)}, "
            f"extra={sorted(entry_names - REQUIRED_SUCCESS_ARTIFACTS)}"
        )
    if any(path.is_symlink() or not path.is_file() for path in entries):
        raise RuntimeError("successful worker artifact set contains an unsafe entry")
    total_size = sum((output_dir / name).stat().st_size for name in REQUIRED_SUCCESS_ARTIFACTS)
    if replay_path.stat().st_size > FRAMED_LIMITS["replay_manifest_bytes"]:
        raise WorkerLimitError("replay manifest byte limit reached")
    if total_size > FRAMED_LIMITS["total_success_artifact_bytes"]:
        raise WorkerLimitError("total successful artifact byte limit reached")
    return summary


def _daily_semantic_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        v2 = bool(reader.fieldnames and "workflow_label" in reader.fieldnames)
        excluded = {"project_id", "run_id"}
        if v2:
            excluded |= {
                "brief_revision_id", "alignment_revision_id", "visibility", "trust_label", "workflow_label",
                "policy_snapshot_digest", "run_admission_digest",
            }
        for row in reader:
            semantic = {key: value for key, value in row.items() if key not in excluded}
            digest.update(canonical_json_v2_bytes(semantic) if v2 else canonical_json_bytes(semantic))
    return digest.hexdigest()


def _record_terminal_error(output_dir: Path, status: str, code: str, message: str) -> None:
    metadata_path = output_dir / "metadata.json"
    if not metadata_path.exists():
        return
    metadata = read_json(metadata_path)
    metadata.update(
        {
            "status": status,
            "finished_at": time.time(),
            "error": {"code": code, "message": message},
        }
    )
    atomic_json(metadata_path, metadata)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--expected-request-sha256", required=True)
    parser.add_argument("--expected-model-revision-id", required=True)
    parser.add_argument("--expected-experiment-revision-id", required=True)
    parser.add_argument("--spawn-nonce")
    parser.add_argument("--worker-start-barrier", type=Path)
    parser.add_argument("--worker-handshake", type=Path)
    parser.add_argument("--receipt-digest")
    parser.add_argument("--ownership-epoch", type=int)
    parser.add_argument("--workspace-root", type=Path)
    parser.add_argument("--cancel-tombstone", type=Path)
    parser.add_argument("--delay-per-day", type=float, default=0.0)
    args = parser.parse_args(argv)
    lifecycle = None
    if args.workspace_root is not None:
        try:
            lifecycle = WorkspaceLifecycle(args.workspace_root)
        except WorkspaceLifecycleError as exc:
            print(f"workspace admission failed: {exc.code}", file=sys.stderr, flush=True)
            return 1
    try:
        if args.spawn_nonce is not None and re.fullmatch(r"[0-9a-f]{32}", args.spawn_nonce) is None:
            raise RuntimeError("spawn nonce is invalid")
        gate2_values = (
            args.spawn_nonce, args.worker_start_barrier, args.worker_handshake,
            args.receipt_digest, args.ownership_epoch,
            args.workspace_root, args.cancel_tombstone,
        )
        if any(value is not None for value in gate2_values) and not all(value is not None for value in gate2_values):
            raise RuntimeError("Gate 2 worker ownership arguments must be supplied together")
        if args.worker_start_barrier is not None:
            barrier = _reject_symlink_components(args.worker_start_barrier)
            handshake_path = _reject_symlink_components(args.worker_handshake)
            request_document = read_json(args.request)
            handshake = {
                "schema_version": 1,
                "canonical_json_version": "riff-canonical-json-v2",
                "project_id": request_document["project_id"],
                "run_id": request_document["run_id"],
                "receipt_digest": args.receipt_digest,
                "spawn_ownership_epoch": args.ownership_epoch,
                "spawn_nonce": args.spawn_nonce,
                "pid": os.getpid(),
                "process_start_token": _process_start_token(os.getpid()),
                "executable_sha256": hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest(),
                "request_sha256": args.expected_request_sha256,
                "model_path": str(args.model.resolve()),
                "request_path": str(args.request.resolve()),
                "output_dir": str(args.output_dir.resolve()),
                "barrier_path": str(barrier.resolve()),
            }
            handshake["handshake_sha256"] = hashlib.sha256(canonical_json_v2_bytes(handshake)).hexdigest()
            _atomic_canonical_v2(handshake_path, handshake)
            deadline = time.monotonic() + 10
            while not barrier.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            if not barrier.is_file() or barrier.is_symlink():
                raise RuntimeError("parent did not durably publish worker_started")
            barrier_document = read_json(barrier)
            expected_barrier = {
                "schema_version": 1,
                "canonical_json_version": "riff-canonical-json-v2",
                "project_id": handshake["project_id"],
                "run_id": handshake["run_id"],
                "receipt_digest": args.receipt_digest,
                "spawn_ownership_epoch": args.ownership_epoch,
                "grant_ownership_epoch": barrier_document.get("grant_ownership_epoch"),
                "spawn_nonce": args.spawn_nonce,
                "captured_request_sha256": args.expected_request_sha256,
                "handshake_sha256": handshake["handshake_sha256"],
                "worker_started_lifecycle_digest": barrier_document.get("worker_started_lifecycle_digest"),
            }
            if not isinstance(expected_barrier["grant_ownership_epoch"], int) or expected_barrier["grant_ownership_epoch"] < args.ownership_epoch:
                raise RuntimeError("worker-start barrier ownership epoch is invalid")
            if barrier.read_bytes() != canonical_json_v2_bytes(barrier_document) or barrier_document != expected_barrier:
                raise RuntimeError("worker-start barrier is not the exact durable ownership grant")
            barrier.unlink()
            handshake_path.unlink()
            tombstone_path = _reject_symlink_components(args.cancel_tombstone)
            if tombstone_path.exists():
                from .canonical_v2 import require_canonical_json_v2_bytes
                from .gate2_contracts import validate_cancel_tombstone
                from .gate2_project_evidence import verify_cancel_tombstone_committed

                tombstone = validate_cancel_tombstone(require_canonical_json_v2_bytes(tombstone_path.read_bytes()))
                if tombstone["project_id"] != handshake["project_id"] or tombstone["run_id"] != handshake["run_id"]:
                    raise RuntimeError("cancel tombstone does not bind this worker")
                verify_cancel_tombstone_committed(
                    _reject_symlink_components(args.workspace_root),
                    handshake["project_id"], handshake["run_id"], tombstone,
                )
                raise CancelledRun("exact committed cancel tombstone observed before model execution")
        execute(
            args.model,
            args.request,
            args.output_dir,
            args.delay_per_day,
            expected_request_sha256=args.expected_request_sha256,
            expected_model_revision_id=args.expected_model_revision_id,
            expected_experiment_revision_id=args.expected_experiment_revision_id,
        )
        print("wind-turbine-maintenance run succeeded", flush=True)
        return 0
    except CancelledRun as exc:
        _record_terminal_error(args.output_dir, "cancelled", "cancelled", str(exc))
        return 2
    except Exception as exc:  # persisted bounded failure evidence is part of the protocol
        traceback.print_exc()
        _record_terminal_error(args.output_dir, "failed", "worker_failed", str(exc))
        return 1
    finally:
        if lifecycle is not None:
            lifecycle.close()


if __name__ == "__main__":
    raise SystemExit(main())
