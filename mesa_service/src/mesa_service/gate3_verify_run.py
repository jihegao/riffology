"""Strict binary/semantic verification for Gate 3 framed wind evidence."""

from __future__ import annotations

import csv
import hashlib
import json
import math
from pathlib import Path
from typing import Any

from .canonical_v2 import canonical_json_v2_bytes, require_canonical_json_v2_bytes, sha256_v2
from .gate3_bundle import framed_manifest
from .gate3_contracts import CLAIM_LABELS, EMPTY_ARRAY_SHA256, NON_CLAIMS, frame_state_digest, metadata_core_digest, sample_days, sample_days_sha256
from .verify_run import RunVerificationError, _daily_semantic_digest, _event_semantic_digest
from .wind_contracts import load_json_asset
from .wind_worker import FRAMED_LIMITS, REQUIRED_SUCCESS_ARTIFACTS, V2_IDENTITY_FIELDS, _semantic_event_projection, _validate_metric_mapping, validate_request_v2


class FramedRunVerificationError(ValueError):
    pass


def _fail(message: str) -> None:
    raise FramedRunVerificationError(message)


def _exact(value: Any, keys: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        _fail(f"{name} keys are not exact")
    return value


def _v2(path: Path, lf: bool) -> dict[str, Any]:
    data = path.read_bytes()
    if lf:
        if not data.endswith(b"\n") or data.endswith(b"\n\n"):
            _fail(f"{path.name} final LF is invalid")
        data = data[:-1]
    try:
        value = require_canonical_json_v2_bytes(data)
    except Exception as exc:
        raise FramedRunVerificationError(f"{path.name} is not canonical-v2") from exc
    if not isinstance(value, dict):
        _fail(f"{path.name} is not an object")
    return value


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _aid(run_id: str, name: str, digest: str) -> str:
    return "artifact_" + sha256_v2({"run_id": run_id, "name": name, "sha256": digest})


def _identity(request: dict[str, Any]) -> dict[str, Any]:
    return {key: request[key] for key in V2_IDENTITY_FIELDS}


def _verify_frame(frame: dict[str, Any], event: dict[str, Any], request: dict[str, Any], index: int) -> None:
    _exact(frame, {"frame_index", "identity", "day", "phase", "through_event_sequence", "source_event_range_index", "frame_state_sha256", "depot", "turbines", "crews", "queues", "daily_metrics"}, "frame")
    if frame["frame_index"] != index or frame["source_event_range_index"] != index:
        _fail("frame indexes are invalid")
    if frame["identity"] != _identity(request):
        _fail("frame identity is invalid")
    phase = "horizon_end" if frame["day"] == request["horizon_days"] else ("warmup" if frame["day"] < request["warmup_days"] else "measurement")
    if frame["phase"] != phase:
        _fail("frame phase is invalid")
    _exact(frame["depot"], {"x_km", "y_km"}, "depot")
    _exact(frame["queues"], {"corrective", "planned"}, "queues")
    turbines, crews = frame["turbines"], frame["crews"]
    if len(turbines) != request["parameters"]["turbine_count"] or len(crews) != request["parameters"]["crew_count"]:
        _fail("frame population is incomplete")
    turbine_ids, crew_ids = [], []
    turbine_states = {"operating", "failed_waiting", "corrective_repair", "planned_maintenance", "major_replacement"}
    crew_states = {"idle", "driving_to_work", "working", "driving_home"}
    for item in turbines:
        _exact(item, {"turbine_id", "x_km", "y_km", "state"}, "turbine")
        turbine_ids.append(item["turbine_id"])
        if item["state"] not in turbine_states or not 0 <= item["x_km"] <= request["parameters"]["farm_width_km"] or not 0 <= item["y_km"] <= request["parameters"]["farm_height_km"]:
            _fail("turbine frame value is invalid")
    for item in crews:
        _exact(item, {"crew_id", "x_km", "y_km", "state", "turbine_id", "work_order_id"}, "crew")
        crew_ids.append(item["crew_id"])
        if item["state"] not in crew_states or not 0 <= item["x_km"] <= request["parameters"]["farm_width_km"] or not 0 <= item["y_km"] <= request["parameters"]["farm_height_km"]:
            _fail("crew frame value is invalid")
    if turbine_ids != sorted(set(turbine_ids)) or crew_ids != sorted(set(crew_ids)):
        _fail("frame IDs are not sorted unique")
    payload = event.get("payload")
    if event.get("event_type") != "daily_snapshot" or event.get("phase") != 50 or not isinstance(payload, dict) or payload.get("snapshot") != frame["daily_metrics"] or payload.get("frame_state_sha256") != frame["frame_state_sha256"]:
        _fail("frame does not bind its phase-50 snapshot")
    if frame["queues"] != {"corrective": frame["daily_metrics"]["corrective_queue_length"], "planned": frame["daily_metrics"]["planned_queue_length"]}:
        _fail("frame queue aggregates differ")
    state_metrics = {"operating": "operating_count", "failed_waiting": "failed_waiting_count", "corrective_repair": "corrective_repair_count", "planned_maintenance": "planned_maintenance_count", "major_replacement": "major_replacement_count"}
    crew_metrics = {"idle": "idle_crew_count", "driving_to_work": "driving_to_work_crew_count", "working": "working_crew_count", "driving_home": "driving_home_crew_count"}
    if any(sum(item["state"] == state for item in turbines) != frame["daily_metrics"][metric] for state, metric in state_metrics.items()) or any(sum(item["state"] == state for item in crews) != frame["daily_metrics"][metric] for state, metric in crew_metrics.items()):
        _fail("frame entity aggregates differ")
    preimage = {"schema_id": "riff://wind-turbine-maintenance/replay-frame-state/v1", "schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "model_id": request["model_id"], "model_revision_id": request["model_revision_id"], "experiment_revision_id": request["experiment_revision_id"], "preset_id": request["preset_id"], "seed": request["seed"], "day": frame["day"], "phase": frame["phase"], "depot": frame["depot"], "turbines": turbines, "crews": crews, "queues": frame["queues"], "daily_metrics": frame["daily_metrics"]}
    if frame_state_digest(preimage) != frame["frame_state_sha256"]:
        _fail("frame-state digest mismatch")


def verify_framed_run(run_dir: str | Path) -> dict[str, Any]:
    root = Path(run_dir)
    entries = list(root.iterdir())
    if {p.name for p in entries} != REQUIRED_SUCCESS_ARTIFACTS or any(p.is_symlink() or not p.is_file() for p in entries):
        _fail("framed artifact set is not exact")
    total = sum(p.stat().st_size for p in entries)
    if total > FRAMED_LIMITS["total_success_artifact_bytes"] or (root / "replay-manifest.json").stat().st_size > FRAMED_LIMITS["replay_manifest_bytes"]:
        _fail("framed artifact budget exceeded")
    if (root / "run.log").read_bytes() != b"wind-turbine-maintenance run succeeded\n":
        _fail("successful framed run log is not the exact worker completion record")
    request = _v2(root / "request.json", False)
    try:
        validate_request_v2(request)
    except Exception as exc:
        raise FramedRunVerificationError(str(exc)) from exc
    if request["runtime_profile"].get("model_protocol_version") != "wind-turbine-maintenance-v2-framed-replay":
        _fail("request is not framed")
    identity = _identity(request)
    metadata = _v2(root / "metadata.json", True)
    _exact(metadata, {"schema_id", "schema_version", "canonical_json_version", "metadata_kind", "metadata_core_projection", "metadata_core_digest"}, "metadata")
    core = _exact(metadata["metadata_core_projection"], {"schema_id", "schema_version", "canonical_json_version", *V2_IDENTITY_FIELDS, "run_intent_digest", "request_digest", "experiment_digest", "runtime_profile", "terminal_status", "started_at", "completed_at"}, "metadata core")
    if metadata["schema_id"] != "riff://wind-turbine-maintenance/metadata/framed/v1" or metadata["metadata_kind"] != "framed_terminal_core" or {k: core[k] for k in V2_IDENTITY_FIELDS} != identity or core["terminal_status"] != "succeeded" or core["request_digest"] != _sha(root / "request.json") or core["experiment_digest"] != request["experiment_sha256"] or core["run_intent_digest"] != request["run_intent_digest"] or core["runtime_profile"] != request["runtime_profile"] or metadata["metadata_core_digest"] != metadata_core_digest(core):
        _fail("metadata core binding is invalid")
    summary = _v2(root / "summary.json", True)
    summary_keys = {
        *V2_IDENTITY_FIELDS, "claim_labels", "measurement_window_days", "seed_count",
        "minimum_availability_fraction", "minimum_availability_met", "staffing_recommendation",
        "metrics", "annualized_maintenance_cost", "annualized_operating_revenue",
        "annualized_maintenance_expense", "annualized_profit", "non_claims",
    }
    _exact(summary, summary_keys, "summary")
    if summary["claim_labels"] != CLAIM_LABELS or summary["non_claims"] != NON_CLAIMS or {k: summary[k] for k in V2_IDENTITY_FIELDS} != identity:
        _fail("summary identity or labels are invalid")
    metric_schema = load_json_asset("metric-schema.json")
    try:
        summary_metrics = _validate_metric_mapping(summary["metrics"], metric_schema, context="summary metric schema")
        event_semantic, validated_event_count = _event_semantic_digest(root / "domain-events.jsonl", identity, request["runtime_profile"])
        kpi_semantic, kpi_count, final_kpi_metrics = _daily_semantic_digest(root / "daily-kpis.csv", identity, metric_schema)
    except (RuntimeError, RunVerificationError) as exc:
        raise FramedRunVerificationError(str(exc)) from exc
    measurement_days = request["horizon_days"] - request["warmup_days"]
    if (
        summary["measurement_window_days"] != measurement_days
        or summary["seed_count"] != 1
        or summary["minimum_availability_fraction"] != request["parameters"]["minimum_availability_fraction"]
        or summary["minimum_availability_met"] is not bool(summary_metrics["availability_fraction"] >= summary["minimum_availability_fraction"])
        or summary["staffing_recommendation"] is not None
        or summary_metrics != final_kpi_metrics
        or kpi_count != request["horizon_days"] + 1
    ):
        _fail("summary/KPI agreement is invalid")
    annual_revenue = float(summary_metrics["operating_revenue"]) * 365 / measurement_days
    annual_expense = float(summary_metrics["total_maintenance_cost"]) * 365 / measurement_days
    annual = {
        "annualized_operating_revenue": annual_revenue,
        "annualized_maintenance_expense": annual_expense,
        "annualized_maintenance_cost": annual_expense,
        "annualized_profit": annual_revenue - annual_expense,
    }
    for key, expected in annual.items():
        actual = summary[key]
        if isinstance(actual, bool) or not isinstance(actual, (int, float)) or not math.isfinite(float(actual)) or not math.isclose(float(actual), expected, rel_tol=1e-12, abs_tol=1e-9):
            _fail(f"summary {key} is not recomputed from the terminal KPI")
    replay = _v2(root / "replay-manifest.json", True)
    common = {"schema_id", "schema_version", "canonical_json_version", "manifest_kind", "identity", "generator_version", "sampling_algorithm", "declared_population", "event_source", "sample_days", "sample_days_sha256", "frame_count", "source_event_ranges", "frames", "claim_labels", "non_claims"}
    kind = replay.get("manifest_kind")
    _exact(replay, common | ({"unavailable_reason"} if kind == "unavailable_population_limit" else set()), "replay")
    if replay["schema_id"] != "riff://wind-turbine-maintenance/replay-manifest/framed/v1" or replay["identity"] != identity or replay["generator_version"] != "wind-worker-sampled-replay-v1" or replay["sampling_algorithm"] != "wind-replay-sample-days-v1" or replay["claim_labels"] != CLAIM_LABELS or replay["non_claims"] != NON_CLAIMS or replay["declared_population"] != {"turbine_count": request["parameters"]["turbine_count"], "crew_count": request["parameters"]["crew_count"]}:
        _fail("replay identity or labels are invalid")
    event_source = _exact(replay["event_source"], {"logical_name", "byte_length", "event_count", "raw_sha256", "semantic_sha256", "final_newline"}, "event source")
    events_path = root / "domain-events.jsonl"; raw = events_path.read_bytes()
    if not raw.endswith(b"\n") or event_source["logical_name"] != "domain-events.jsonl" or event_source["byte_length"] != len(raw) or event_source["raw_sha256"] != hashlib.sha256(raw).hexdigest() or event_source["final_newline"] is not True:
        _fail("event source bytes are invalid")
    events = [json.loads(line) for line in raw.splitlines()]; semantic = hashlib.sha256()
    for index, event in enumerate(events, 1):
        if event.get("sequence") != index or {k: event.get(k) for k in V2_IDENTITY_FIELDS} != identity:
            _fail("event sequence or identity is invalid")
        semantic.update(canonical_json_v2_bytes(_semantic_event_projection(event, request["runtime_profile"])))
    if event_source["event_count"] != len(events) or event_source["event_count"] != validated_event_count or event_source["semantic_sha256"] != semantic.hexdigest() or event_source["semantic_sha256"] != event_semantic:
        _fail("event semantic digest is invalid")
    if kind == "complete":
        days = sample_days(request["horizon_days"], request["warmup_days"])
        if request["parameters"]["turbine_count"] > 100 or request["parameters"]["crew_count"] > 50 or replay["sample_days"] != days or replay["sample_days_sha256"] != sample_days_sha256(days) or replay["frame_count"] != len(days) or len(replay["frames"]) != len(days) or len(replay["source_event_ranges"]) != len(days):
            _fail("complete replay sample contract is invalid")
        offset, first = 0, 1
        for index, (decl, frame) in enumerate(zip(replay["source_event_ranges"], replay["frames"], strict=True)):
            _exact(decl, {"range_index", "event_count", "first_sequence", "last_sequence", "byte_offset", "byte_length", "raw_range_sha256", "semantic_range_sha256"}, "range")
            if decl["range_index"] != index or decl["byte_offset"] != offset or decl["first_sequence"] != first or decl["event_count"] != decl["last_sequence"] - first + 1 or decl["event_count"] < 1:
                _fail("event range continuity is invalid")
            end = offset + decl["byte_length"]; segment = raw[offset:end]
            if not segment.endswith(b"\n") or hashlib.sha256(segment).hexdigest() != decl["raw_range_sha256"]:
                _fail("raw range digest is invalid")
            range_events = [json.loads(line) for line in segment.splitlines()]; sd = hashlib.sha256()
            for event in range_events: sd.update(canonical_json_v2_bytes(_semantic_event_projection(event, request["runtime_profile"])))
            if len(range_events) != decl["event_count"] or range_events[0].get("sequence") != decl["first_sequence"] or range_events[-1].get("sequence") != decl["last_sequence"]:
                _fail("declared range sequences differ from actual events")
            if sd.hexdigest() != decl["semantic_range_sha256"] or frame["through_event_sequence"] != range_events[-1]["sequence"] or frame["through_event_sequence"] != decl["last_sequence"] or frame["day"] != days[index]:
                _fail("semantic range/frame edge is invalid")
            _verify_frame(frame, range_events[-1], request, index)
            offset, first = end, decl["last_sequence"] + 1
        if offset != len(raw) or replay["frames"][-1]["through_event_sequence"] != len(events):
            _fail("ranges do not partition event bytes")
    elif kind == "unavailable_population_limit":
        if request["parameters"]["turbine_count"] <= 100 and request["parameters"]["crew_count"] <= 50 or replay.get("unavailable_reason") != "population_exceeds_frame_contract" or replay["sample_days"] != [] or replay["source_event_ranges"] != [] or replay["frames"] != [] or replay["frame_count"] != 0 or replay["sample_days_sha256"] != EMPTY_ARRAY_SHA256:
            _fail("population-limit replay is invalid")
    else: _fail("unknown replay kind")
    derived = _v2(root / "derived-views-manifest.json", True)
    _exact(derived, {"schema_id", "schema_version", "canonical_json_version", "manifest_kind", "identity", "generator", "inputs", "claim_labels", "non_claims", "projection_digests"}, "derived")
    if derived["schema_id"] != "riff://wind-turbine-maintenance/derived-views-manifest/framed/v1" or derived["manifest_kind"] != "framed_evidence_views" or derived["identity"] != identity or derived["claim_labels"] != CLAIM_LABELS or derived["non_claims"] != NON_CLAIMS or derived["generator"] != {"generator_id": "wind-evidence-derived-views", "generator_version": "wind-evidence-derived-views-v1"}:
        _fail("derived identity is invalid")
    inputs = _exact(derived["inputs"], {"metadata_core", "model_sources", "artifacts"}, "derived inputs")
    if inputs["metadata_core"] != {"metadata_core_digest": metadata["metadata_core_digest"]}:
        _fail("metadata DAG edge is invalid")
    files = framed_manifest()["files"]; source_names = ("model-spec.json","parameter-schema.json","execution-field-schema.json","metric-schema.json","visualization.json","traceability.json","defaults/wind-turbine-maintenance-demo-v1.json","provenance.json")
    source_set = "viewsrc_" + sha256_v2({name: files[name]["sha256"] for name in source_names})
    if inputs["model_sources"] != {"model_revision_id": request["model_revision_id"], "source_set_digest": source_set}:
        _fail("model-source DAG edge is invalid")
    names = {"request.json","daily-kpis.csv","domain-events.jsonl","summary.json","replay-manifest.json"}; _exact(inputs["artifacts"], names, "derived artifacts")
    for name in names:
        digest=_sha(root/name)
        if inputs["artifacts"][name] != {"artifact_id":_aid(request["run_id"],name,digest),"sha256":digest}: _fail("artifact DAG edge is invalid")
    projections={"event_projection_sha256":{"projection_kind":"filtered_domain_events","projection_schema_version":1,"run_id":request["run_id"],"domain_events_sha256":_sha(events_path),"event_count":len(events)},"kpi_projection_sha256":{"projection_kind":"daily_kpis","projection_schema_version":1,"run_id":request["run_id"],"daily_kpis_sha256":_sha(root/'daily-kpis.csv'),"summary_sha256":_sha(root/'summary.json')},"replay_projection_sha256":{"projection_kind":"sampled_replay","projection_schema_version":1,"run_id":request["run_id"],"replay_manifest_sha256":_sha(root/'replay-manifest.json'),"manifest_kind":kind,"frame_count":replay["frame_count"]},"label_projection_sha256":{"projection_kind":"run_labels","projection_schema_version":1,"run_id":request["run_id"],"summary_sha256":_sha(root/'summary.json'),"replay_manifest_sha256":_sha(root/'replay-manifest.json'),"claim_labels":CLAIM_LABELS,"non_claims":NON_CLAIMS}}
    if derived["projection_digests"] != {k:sha256_v2(v) for k,v in projections.items()}: _fail("projection digest map is invalid")
    return {"valid":True,"branch":"framed","run_id":request["run_id"],"event_count":len(events),"kpi_rows":kpi_count,"frame_count":replay["frame_count"],"manifest_kind":kind,"artifact_bytes":total}
