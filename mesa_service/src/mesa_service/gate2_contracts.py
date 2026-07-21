"""Strict Gate 2 experiment, admission, intent, receipt, and lifecycle contracts."""

from __future__ import annotations

import hashlib
import re
from copy import deepcopy
from typing import Any, Mapping

from .canonical_v2 import (
    CANONICAL_JSON_VERSION_V2,
    canonical_json_v2_bytes,
    prefixed_digest,
    require_canonical_json_v2_bytes,
    sha256_v2,
)
from .wind_contracts import MODEL_ID, PRESET_ID, runtime_profile, validate_parameters


class Gate2ContractError(ValueError):
    pass


EXPERIMENT_V2_KEYS = {
    "schema_version", "canonical_json_version", "experiment_revision_id", "project_id",
    "parent_experiment_revision_id", "operation", "model_id", "model_revision_id",
    "brief_revision_id", "alignment_revision_id", "preset_id", "defaults_digest",
    "parameter_defaults", "parameters", "parameter_diff", "execution_defaults",
    "execution_values", "execution_diff", "runtime_profile", "created_by_actor_id", "created_at",
}
EXPERIMENT_FRAMED_KEYS = {
    "schema_id", "schema_version", "canonical_json_version", "project_id",
    "parent_experiment_revision_id", "operation", "model_id", "model_revision_id",
    "brief_revision_id", "alignment_revision_id", "preset_id", "defaults_digest",
    "parameter_defaults", "parameters", "parameter_diff", "execution_defaults",
    "execution_values", "execution_diff", "runtime_profile", "copy_migration_rule",
    "created_by_actor_id", "created_at", "experiment_revision_id", "experiment_digest",
}
POLICY_KEYS = {
    "schema_version", "canonical_json_version", "policy_snapshot_digest", "project_id",
    "evaluated_at_snapshot_revision", "evaluated_project_event_digest", "alignment", "experiment",
    "combined_policy_satisfied", "effective_attestation_ids", "open_issue_ids",
}
SUBJECT_POLICY_KEYS = {
    "subject_revision_id", "effective_attestation_refs",
    "human_project_owner_endorsement_attestation_ids", "human_project_owner_endorsement_count",
    "open_issue_refs", "open_issue_ids", "open_issue_count", "open_blocking_issue_ids",
    "open_blocking_issue_count", "open_non_blocking_issue_ids", "open_non_blocking_issue_count",
    "policy_satisfied", "wording",
}
ATTESTATION_REF_KEYS = {
    "attestation_id", "attestation_digest", "actor_id", "actor_type", "declared_role", "scope", "decision",
}
ISSUE_REF_KEYS = {"issue_id", "latest_issue_event_digest", "blocking"}
ADMISSION_KEYS = {
    "schema_version", "canonical_json_version", "run_admission_digest", "project_id", "run_id", "model_id",
    "model_revision_id", "brief_revision_id", "alignment_revision_id", "experiment_revision_id",
    "experiment_sha256", "policy_snapshot", "policy_snapshot_digest", "visibility", "trust_label",
    "workflow_label", "admission_base_snapshot_revision", "admission_base_project_event_digest", "created_at",
}
INTENT_KEYS = {
    "schema_version", "canonical_json_version", "run_intent_digest", "project_id", "run_id", "command_id",
    "command_digest", "downstream_idempotency_key", "downstream_request_digest", "model_id",
    "model_revision_id", "brief_revision_id", "alignment_revision_id", "experiment_revision_id",
    "experiment_sha256", "policy_snapshot_digest", "run_admission_digest", "created_at",
}
RECEIPT_KEYS = {
    "schema_version", "canonical_json_version", "mesa_run_receipt_digest", "downstream_idempotency_key",
    "downstream_request_digest", "project_id", "run_id", "model_id", "model_revision_id",
    "experiment_revision_id", "experiment_sha256", "policy_snapshot_digest", "run_admission_digest",
    "run_intent_digest", "captured_request_sha256", "ownership_epoch", "accepted_at",
}
LIFECYCLE_KEYS = {
    "schema_version", "canonical_json_version", "mesa_lifecycle_digest", "project_id", "run_id", "sequence",
    "previous_mesa_lifecycle_digest", "ownership_epoch", "owner_instance_id", "state", "receipt_digest",
    "run_intent_digest", "run_admission_digest", "policy_snapshot_digest", "experiment_sha256",
    "captured_request_sha256", "child_identity", "evidence_digest", "created_at",
}
LIFECYCLE_STATES = {
    "receipt_committed", "ownership_acquired", "temp_prepared", "spawn_intent", "worker_started",
    "cancel_requested", "worker_exited", "verified_succeeded", "terminal_failed", "terminal_timed_out",
    "terminal_cancelled",
}
CANCEL_TOMBSTONE_KEYS = {
    "schema_version", "canonical_json_version", "cancel_tombstone_digest", "project_id", "run_id",
    "cancel_command_id", "cancel_command_digest", "requested_by_actor_id", "requested_at_snapshot_revision",
    "created_at",
}
V2_IDENTITY_FIELDS = (
    "project_id", "run_id", "model_id", "model_revision_id", "brief_revision_id", "alignment_revision_id",
    "experiment_revision_id", "preset_id", "seed", "visibility", "trust_label", "workflow_label",
    "policy_snapshot_digest", "run_admission_digest",
)


def _exact_mapping(value: object, keys: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != keys:
        actual = set(value) if isinstance(value, Mapping) else set()
        raise Gate2ContractError(f"{name} keys are not exact; missing={sorted(keys-actual)}, unknown={sorted(actual-keys)}")
    return dict(value)


def _id(value: object, prefix: str, hex_length: int, name: str) -> str:
    if not isinstance(value, str) or re.fullmatch(re.escape(prefix) + rf"[0-9a-f]{{{hex_length}}}", value) is None:
        raise Gate2ContractError(f"invalid {name}")
    return value


def _nonempty(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise Gate2ContractError(f"invalid {name}")
    return value


def _sorted_unique(values: object, name: str) -> list[str]:
    if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
        raise Gate2ContractError(f"{name} must be a string array")
    if values != sorted(set(values)):
        raise Gate2ContractError(f"{name} must be sorted and unique")
    return values


def validate_experiment_v2(raw: object) -> dict[str, Any]:
    value = _exact_mapping(raw, EXPERIMENT_V2_KEYS, "v2 experiment")
    if value["schema_version"] != 2 or value["canonical_json_version"] != CANONICAL_JSON_VERSION_V2:
        raise Gate2ContractError("unsupported_experiment_schema")
    _id(value["experiment_revision_id"], "er_", 64, "experiment_revision_id")
    _id(value["project_id"], "project_", 32, "project_id")
    if value["parent_experiment_revision_id"] is not None:
        _id(value["parent_experiment_revision_id"], "er_", 64, "parent_experiment_revision_id")
    if value["operation"] not in {"create", "edit", "reset_defaults"}:
        raise Gate2ContractError("invalid experiment operation")
    if value["model_id"] != MODEL_ID or value["preset_id"] != PRESET_ID:
        raise Gate2ContractError("v2 experiment does not bind the reviewed wind preset")
    _id(value["model_revision_id"], "mr_", 64, "model_revision_id")
    _id(value["brief_revision_id"], "dbr_", 64, "brief_revision_id")
    _id(value["alignment_revision_id"], "amr_", 64, "alignment_revision_id")
    _id(value["defaults_digest"], "dd_", 64, "defaults_digest")
    defaults = validate_parameters(value["parameter_defaults"])
    parameters = validate_parameters(value["parameters"])
    execution_defaults = _validate_execution(value["execution_defaults"], "execution_defaults")
    execution_values = _validate_execution(value["execution_values"], "execution_values")
    expected_defaults = defaults_digest(PRESET_ID, defaults, execution_defaults)
    if value["defaults_digest"] != expected_defaults:
        raise Gate2ContractError("defaults_digest does not match reviewed defaults")
    expected_parameter_diff = [
        {"parameter_id": key, "default_value": defaults[key], "current_value": parameters[key]}
        for key in sorted(defaults)
        if canonical_json_v2_bytes(defaults[key]) != canonical_json_v2_bytes(parameters[key])
    ]
    if value["parameter_diff"] != expected_parameter_diff:
        raise Gate2ContractError("parameter_diff is not the exact canonical diff")
    expected_execution_diff = [
        {"field": key, "default_value": execution_defaults[key], "current_value": execution_values[key]}
        for key in ("horizon_days", "warmup_days", "seed")
        if execution_defaults[key] != execution_values[key]
    ]
    if value["execution_diff"] != expected_execution_diff:
        raise Gate2ContractError("execution_diff is not the exact canonical diff")
    from .bundle import manifest_entries, model_revision_id
    from .gate3_bundle import framed_manifest

    legacy_revision = model_revision_id(manifest_entries(), runtime_profile())
    if value["model_revision_id"] == framed_manifest()["model_revision_id"]:
        raise Gate2ContractError("legacy experiment schema cannot bind the framed model revision")
    if value["model_revision_id"] == legacy_revision and value["runtime_profile"] != runtime_profile():
        raise Gate2ContractError("legacy experiment runtime profile does not match its model revision")
    if value["runtime_profile"] != runtime_profile():
        raise Gate2ContractError("legacy experiment runtime profile is invalid")
    _id(value["created_by_actor_id"], "actor_", 32, "created_by_actor_id")
    _nonempty(value["created_at"], "created_at")
    value["parameter_defaults"] = defaults
    value["parameters"] = parameters
    value["execution_defaults"] = execution_defaults
    value["execution_values"] = execution_values
    computed = "er_" + sha256_v2({key: nested for key, nested in value.items() if key != "experiment_revision_id"})
    if computed != value["experiment_revision_id"]:
        raise Gate2ContractError("v2 experiment revision ID does not match canonical bytes")
    return deepcopy(value)


def validate_experiment_framed(raw: object) -> dict[str, Any]:
    """Validate one exact immutable framed experiment record."""

    value = _exact_mapping(raw, EXPERIMENT_FRAMED_KEYS, "framed experiment")
    if (
        value["schema_id"] != "riff://evidence-studio/experiment-revision/framed/v1"
        or value["schema_version"] != 1
        or value["canonical_json_version"] != CANONICAL_JSON_VERSION_V2
        or value["model_id"] != MODEL_ID
        or value["preset_id"] != PRESET_ID
        or value["copy_migration_rule"] != "framed_parameter_copy_revalidate_v1"
    ):
        raise Gate2ContractError("unsupported framed experiment schema")
    operation = value["operation"]
    parent_id = value["parent_experiment_revision_id"]
    if operation == "create":
        if parent_id is not None:
            raise Gate2ContractError("framed create must not declare a parent")
    elif operation in {"edit", "reset_defaults"}:
        _id(parent_id, "er_", 64, "parent_experiment_revision_id")
    else:
        raise Gate2ContractError("invalid framed experiment operation")
    _id(value["project_id"], "project_", 32, "project_id")
    _id(value["model_revision_id"], "mr_", 64, "model_revision_id")
    _id(value["brief_revision_id"], "dbr_", 64, "brief_revision_id")
    _id(value["alignment_revision_id"], "amr_", 64, "alignment_revision_id")
    _id(value["experiment_revision_id"], "er_", 64, "experiment_revision_id")
    _id(value["experiment_digest"], "erd_", 64, "experiment_digest")
    _id(value["defaults_digest"], "dd_", 64, "defaults_digest")
    _id(value["created_by_actor_id"], "actor_", 32, "created_by_actor_id")
    _nonempty(value["created_at"], "created_at")

    from .gate3_bundle import framed_manifest, framed_runtime_profile, load_framed_json_source
    from .gate3_contracts import validate_framed_parameter_sources

    manifest = framed_manifest()
    if value["model_revision_id"] != manifest["model_revision_id"] or value["runtime_profile"] != framed_runtime_profile():
        raise Gate2ContractError("framed experiment model/runtime branch is mixed or stale")
    schema = load_framed_json_source("parameter-schema.json")
    preset = load_framed_json_source("defaults/wind-turbine-maintenance-demo-v1.json")
    defaults = validate_framed_parameter_sources(schema, {"parameters": value["parameter_defaults"]})
    parameters = validate_framed_parameter_sources(schema, {"parameters": value["parameters"]})
    execution_defaults = _validate_execution(value["execution_defaults"], "execution_defaults")
    execution_values = _validate_execution(value["execution_values"], "execution_values")
    reviewed_execution_defaults = {
        key: preset[key] for key in ("horizon_days", "warmup_days", "seed")
    }
    if (
        preset.get("preset_id") != PRESET_ID
        or canonical_json_v2_bytes(defaults) != canonical_json_v2_bytes(preset.get("parameters"))
        or execution_defaults != reviewed_execution_defaults
    ):
        raise Gate2ContractError("framed defaults do not match the verified preset")
    if value["defaults_digest"] != defaults_digest(PRESET_ID, defaults, execution_defaults):
        raise Gate2ContractError("framed defaults_digest does not match exact defaults")
    expected_parameter_diff = [
        {"parameter_id": key, "default_value": defaults[key], "current_value": parameters[key]}
        for key in sorted(defaults)
        if canonical_json_v2_bytes(defaults[key]) != canonical_json_v2_bytes(parameters[key])
    ]
    expected_execution_diff = [
        {"field": key, "default_value": execution_defaults[key], "current_value": execution_values[key]}
        for key in ("horizon_days", "warmup_days", "seed")
        if execution_defaults[key] != execution_values[key]
    ]
    if value["parameter_diff"] != expected_parameter_diff or value["execution_diff"] != expected_execution_diff:
        raise Gate2ContractError("framed experiment diff is not exact")
    if operation == "reset_defaults" and (
        canonical_json_v2_bytes(parameters) != canonical_json_v2_bytes(defaults)
        or execution_values != execution_defaults
        or value["parameter_diff"] != []
        or value["execution_diff"] != []
    ):
        raise Gate2ContractError("framed reset must restore exact defaults with empty diffs")
    id_preimage = {key: nested for key, nested in value.items() if key not in {"experiment_revision_id", "experiment_digest"}}
    expected_id = "er_" + sha256_v2(id_preimage)
    digest_preimage = {key: nested for key, nested in value.items() if key != "experiment_digest"}
    expected_digest = "erd_" + sha256_v2(digest_preimage)
    if value["experiment_revision_id"] != expected_id or value["experiment_digest"] != expected_digest:
        raise Gate2ContractError("framed experiment ID or digest does not match canonical bytes")
    value["parameter_defaults"] = defaults
    value["parameters"] = parameters
    value["execution_defaults"] = execution_defaults
    value["execution_values"] = execution_values
    return deepcopy(value)


def validate_framed_experiment_transition(raw: object, parent_raw: object | None) -> dict[str, Any]:
    """Validate the immutable create/edit/reset union and its immediate parent edge."""

    value = validate_experiment_framed(raw)
    if value["operation"] == "create":
        if parent_raw is not None:
            raise Gate2ContractError("framed create cannot have a parent record")
        return value
    if parent_raw is None:
        raise Gate2ContractError("framed successor parent record is unavailable")
    parent = validate_experiment_framed(parent_raw)
    if value["parent_experiment_revision_id"] != parent["experiment_revision_id"]:
        raise Gate2ContractError("framed successor does not bind the exact parent revision")
    inherited = (
        "project_id", "model_id", "model_revision_id", "brief_revision_id", "alignment_revision_id",
        "preset_id", "defaults_digest", "parameter_defaults", "execution_defaults", "runtime_profile",
        "copy_migration_rule",
    )
    if any(canonical_json_v2_bytes(value[key]) != canonical_json_v2_bytes(parent[key]) for key in inherited):
        raise Gate2ContractError("framed successor changed its inherited activation tuple")
    if value["operation"] == "edit" and (
        canonical_json_v2_bytes(value["parameters"]) == canonical_json_v2_bytes(parent["parameters"])
        and value["execution_values"] == parent["execution_values"]
    ):
        raise Gate2ContractError("framed edit has no effective change from its parent")
    return value


def validate_experiment_for_run(raw: object) -> dict[str, Any]:
    if isinstance(raw, Mapping) and raw.get("schema_id") == "riff://evidence-studio/experiment-revision/framed/v1":
        return validate_experiment_framed(raw)
    return validate_experiment_v2(raw)


def _validate_execution(raw: object, name: str) -> dict[str, int]:
    value = _exact_mapping(raw, {"horizon_days", "warmup_days", "seed"}, name)
    for key in value:
        if not isinstance(value[key], int) or isinstance(value[key], bool):
            raise Gate2ContractError(f"{name}.{key} must be an integer")
    if not 1 <= value["horizon_days"] <= 3660:
        raise Gate2ContractError(f"{name}.horizon_days is outside the reviewed range")
    if not 0 <= value["warmup_days"] < value["horizon_days"]:
        raise Gate2ContractError(f"{name}.warmup_days must be below horizon")
    if not -(2**31) <= value["seed"] <= 2**31 - 1:
        raise Gate2ContractError(f"{name}.seed is outside signed 32-bit range")
    return {key: int(value[key]) for key in ("horizon_days", "warmup_days", "seed")}


def defaults_digest(preset_id: str, parameter_defaults: Mapping[str, Any], execution_defaults: Mapping[str, Any]) -> str:
    return "dd_" + sha256_v2({
        "preset_id": preset_id,
        "parameter_defaults": dict(parameter_defaults),
        "execution_defaults": dict(execution_defaults),
    })


def validate_policy_snapshot(raw: object) -> dict[str, Any]:
    value = _exact_mapping(raw, POLICY_KEYS, "policy snapshot")
    if value["schema_version"] != 1 or value["canonical_json_version"] != CANONICAL_JSON_VERSION_V2:
        raise Gate2ContractError("invalid policy snapshot version")
    _id(value["project_id"], "project_", 32, "project_id")
    if not isinstance(value["evaluated_at_snapshot_revision"], int) or isinstance(value["evaluated_at_snapshot_revision"], bool) or value["evaluated_at_snapshot_revision"] < 0:
        raise Gate2ContractError("invalid evaluated_at_snapshot_revision")
    _nonempty(value["evaluated_project_event_digest"], "evaluated_project_event_digest")
    alignment = _validate_subject_policy(value["alignment"], "alignment")
    experiment = _validate_subject_policy(value["experiment"], "experiment")
    if value["combined_policy_satisfied"] is not (alignment["policy_satisfied"] and experiment["policy_satisfied"]):
        raise Gate2ContractError("combined policy result is inconsistent")
    effective = _sorted_unique(value["effective_attestation_ids"], "effective_attestation_ids")
    issues = _sorted_unique(value["open_issue_ids"], "open_issue_ids")
    expected_effective = sorted({ref["attestation_id"] for subject in (alignment, experiment) for ref in subject["effective_attestation_refs"]})
    expected_issues = sorted(set(alignment["open_issue_ids"]) | set(experiment["open_issue_ids"]))
    if effective != expected_effective or issues != expected_issues:
        raise Gate2ContractError("top-level policy unions are inconsistent")
    value["alignment"] = alignment
    value["experiment"] = experiment
    _id(value["policy_snapshot_digest"], "ps_", 64, "policy_snapshot_digest")
    if value["policy_snapshot_digest"] != prefixed_digest(value, field="policy_snapshot_digest", prefix="ps_"):
        raise Gate2ContractError("policy snapshot digest mismatch")
    return deepcopy(value)


def _validate_subject_policy(raw: object, name: str) -> dict[str, Any]:
    value = _exact_mapping(raw, SUBJECT_POLICY_KEYS, f"{name} policy")
    _nonempty(value["subject_revision_id"], f"{name}.subject_revision_id")
    refs = value["effective_attestation_refs"]
    if not isinstance(refs, list):
        raise Gate2ContractError(f"{name}.effective_attestation_refs must be an array")
    normalized_refs = []
    for ref in refs:
        item = _exact_mapping(ref, ATTESTATION_REF_KEYS, "attestation ref")
        _id(item["attestation_id"], "att_", 32, "attestation_id")
        _nonempty(item["attestation_digest"], "attestation_digest")
        _id(item["actor_id"], "actor_", 32, "actor_id")
        if item["actor_type"] not in {"human", "agent"} or item["decision"] not in {"endorse", "object", "abstain"}:
            raise Gate2ContractError("invalid attestation ref vocabulary")
        _nonempty(item["declared_role"], "declared_role")
        _nonempty(item["scope"], "scope")
        normalized_refs.append(item)
    if normalized_refs != sorted(normalized_refs, key=lambda item: item["attestation_id"]) or len({item["attestation_id"] for item in normalized_refs}) != len(normalized_refs):
        raise Gate2ContractError("attestation refs must be sorted and unique")
    issue_refs = value["open_issue_refs"]
    if not isinstance(issue_refs, list):
        raise Gate2ContractError("open_issue_refs must be an array")
    normalized_issue_refs = []
    for ref in issue_refs:
        item = _exact_mapping(ref, ISSUE_REF_KEYS, "issue ref")
        _id(item["issue_id"], "issue_", 32, "issue_id")
        _nonempty(item["latest_issue_event_digest"], "latest_issue_event_digest")
        if not isinstance(item["blocking"], bool):
            raise Gate2ContractError("issue blocking must be boolean")
        normalized_issue_refs.append(item)
    if normalized_issue_refs != sorted(normalized_issue_refs, key=lambda item: item["issue_id"]) or len({item["issue_id"] for item in normalized_issue_refs}) != len(normalized_issue_refs):
        raise Gate2ContractError("issue refs must be sorted and unique")
    endorsements = _sorted_unique(value["human_project_owner_endorsement_attestation_ids"], "endorsement IDs")
    expected_endorsements = sorted(
        ref["attestation_id"] for ref in normalized_refs
        if ref["actor_type"] == "human" and ref["declared_role"] == "project_owner"
        and ref["scope"] == "workflow_progression" and ref["decision"] == "endorse"
    )
    issue_ids = _sorted_unique(value["open_issue_ids"], "open issue IDs")
    blocking_ids = _sorted_unique(value["open_blocking_issue_ids"], "open blocking issue IDs")
    nonblocking_ids = _sorted_unique(value["open_non_blocking_issue_ids"], "open nonblocking issue IDs")
    expected_issue_ids = [ref["issue_id"] for ref in normalized_issue_refs]
    expected_blocking = [ref["issue_id"] for ref in normalized_issue_refs if ref["blocking"]]
    expected_nonblocking = [ref["issue_id"] for ref in normalized_issue_refs if not ref["blocking"]]
    counts = {
        "human_project_owner_endorsement_count": len(endorsements), "open_issue_count": len(issue_ids),
        "open_blocking_issue_count": len(blocking_ids), "open_non_blocking_issue_count": len(nonblocking_ids),
    }
    if endorsements != expected_endorsements or issue_ids != expected_issue_ids or blocking_ids != expected_blocking or nonblocking_ids != expected_nonblocking:
        raise Gate2ContractError("subject policy references are inconsistent")
    if any(value[key] != count for key, count in counts.items()):
        raise Gate2ContractError("subject policy counts are inconsistent")
    satisfied = len(endorsements) >= 1 and not blocking_ids
    if value["policy_satisfied"] is not satisfied:
        raise Gate2ContractError("subject policy result is inconsistent")
    expected_wording = "no_recorded_open_objection" if not issue_ids else "recorded_open_objection"
    if value["wording"] != expected_wording:
        raise Gate2ContractError("subject policy wording is inconsistent")
    value["effective_attestation_refs"] = normalized_refs
    value["open_issue_refs"] = normalized_issue_refs
    return value


def validate_run_admission(raw: object) -> dict[str, Any]:
    value = _exact_mapping(raw, ADMISSION_KEYS, "run admission")
    if value["schema_version"] != 1 or value["canonical_json_version"] != CANONICAL_JSON_VERSION_V2:
        raise Gate2ContractError("invalid run admission version")
    for key, prefix, length in (("project_id", "project_", 32), ("run_id", "run_", 32), ("model_revision_id", "mr_", 64), ("brief_revision_id", "dbr_", 64), ("alignment_revision_id", "amr_", 64), ("experiment_revision_id", "er_", 64), ("policy_snapshot_digest", "ps_", 64), ("run_admission_digest", "ra_", 64)):
        _id(value[key], prefix, length, key)
    if value["model_id"] != MODEL_ID or re.fullmatch(r"[0-9a-f]{64}", value["experiment_sha256"] or "") is None:
        raise Gate2ContractError("invalid admission model/experiment identity")
    policy = validate_policy_snapshot(value["policy_snapshot"])
    if policy["policy_snapshot_digest"] != value["policy_snapshot_digest"] or policy["project_id"] != value["project_id"]:
        raise Gate2ContractError("admission policy binding mismatch")
    if value["visibility"] != "private_draft" or value["trust_label"] != "draft_unverified":
        raise Gate2ContractError("Gate 2 admission labels are immutable")
    expected_workflow = "workflow_policy_met" if policy["combined_policy_satisfied"] else "workflow_policy_unmet"
    if value["workflow_label"] != expected_workflow:
        raise Gate2ContractError("admission workflow label does not match policy")
    if value["admission_base_snapshot_revision"] != policy["evaluated_at_snapshot_revision"] or value["admission_base_project_event_digest"] != policy["evaluated_project_event_digest"]:
        raise Gate2ContractError("admission policy base mismatch")
    _nonempty(value["created_at"], "created_at")
    if value["run_admission_digest"] != prefixed_digest(value, field="run_admission_digest", prefix="ra_"):
        raise Gate2ContractError("run admission digest mismatch")
    value["policy_snapshot"] = policy
    return deepcopy(value)


def validate_run_intent(raw: object) -> dict[str, Any]:
    value = _exact_mapping(raw, INTENT_KEYS, "run intent")
    if value["schema_version"] != 1 or value["canonical_json_version"] != CANONICAL_JSON_VERSION_V2:
        raise Gate2ContractError("invalid run intent version")
    for key, prefix, length in (("project_id", "project_", 32), ("run_id", "run_", 32), ("model_revision_id", "mr_", 64), ("brief_revision_id", "dbr_", 64), ("alignment_revision_id", "amr_", 64), ("experiment_revision_id", "er_", 64), ("policy_snapshot_digest", "ps_", 64), ("run_admission_digest", "ra_", 64), ("run_intent_digest", "ri_", 64), ("downstream_idempotency_key", "rk_", 64), ("downstream_request_digest", "rq_", 64)):
        _id(value[key], prefix, length, key)
    if value["model_id"] != MODEL_ID or re.fullmatch(r"[0-9a-f]{64}", value["experiment_sha256"] or "") is None:
        raise Gate2ContractError("invalid intent model/experiment identity")
    _nonempty(value["command_id"], "command_id")
    _nonempty(value["command_digest"], "command_digest")
    _nonempty(value["created_at"], "created_at")
    if value["run_intent_digest"] != prefixed_digest(value, field="run_intent_digest", prefix="ri_"):
        raise Gate2ContractError("run intent digest mismatch")
    return deepcopy(value)


def downstream_request_digest(*, project_id: str, run_id: str, experiment_revision_id: str, experiment_sha256: str, run_admission_digest: str, model_revision_id: str) -> str:
    return "rq_" + sha256_v2({
        "project_id": project_id, "run_id": run_id, "body": {"experiment_revision_id": experiment_revision_id},
        "experiment_sha256": experiment_sha256, "run_admission_digest": run_admission_digest,
        "model_revision_id": model_revision_id,
    })


def validate_v2_record_bytes(data: bytes, validator: Any) -> dict[str, Any]:
    try:
        value = require_canonical_json_v2_bytes(data)
        return validator(value)
    except Exception as exc:
        if isinstance(exc, Gate2ContractError):
            raise
        raise Gate2ContractError(str(exc)) from exc


def build_v2_worker_request(*, experiment: dict[str, Any], admission: dict[str, Any], intent: dict[str, Any]) -> dict[str, Any]:
    identity = {
        "project_id": admission["project_id"], "run_id": admission["run_id"], "model_id": MODEL_ID,
        "model_revision_id": admission["model_revision_id"], "brief_revision_id": admission["brief_revision_id"],
        "alignment_revision_id": admission["alignment_revision_id"], "experiment_revision_id": admission["experiment_revision_id"],
        "preset_id": experiment["preset_id"], "seed": experiment["execution_values"]["seed"],
        "visibility": admission["visibility"], "trust_label": admission["trust_label"],
        "workflow_label": admission["workflow_label"], "policy_snapshot_digest": admission["policy_snapshot_digest"],
        "run_admission_digest": admission["run_admission_digest"],
    }
    return {
        **identity,
        "experiment_sha256": admission["experiment_sha256"],
        "run_intent_digest": intent["run_intent_digest"],
        "downstream_request_digest": intent["downstream_request_digest"],
        "experiment_document": experiment,
        "run_admission": admission,
        "parameters": experiment["parameters"],
        "horizon_days": experiment["execution_values"]["horizon_days"],
        "warmup_days": experiment["execution_values"]["warmup_days"],
        "runtime_profile": experiment["runtime_profile"],
        "claim_labels": [
            "synthetic_inputs", "single_seed", "behavioral_reproduction_not_runtime_equivalence",
            "draft_unverified", "no_staffing_recommendation",
        ],
    }


def receipt_digest(receipt: dict[str, Any]) -> str:
    return prefixed_digest(receipt, field="mesa_run_receipt_digest", prefix="mrr_")


def lifecycle_digest(record: dict[str, Any]) -> str:
    return prefixed_digest(record, field="mesa_lifecycle_digest", prefix="mlr_")


def validate_receipt(raw: object) -> dict[str, Any]:
    value = _exact_mapping(raw, RECEIPT_KEYS, "Mesa run receipt")
    if value["schema_version"] != 1 or value["canonical_json_version"] != CANONICAL_JSON_VERSION_V2:
        raise Gate2ContractError("invalid Mesa receipt version")
    for key, prefix, length in (
        ("mesa_run_receipt_digest", "mrr_", 64),
        ("downstream_idempotency_key", "rk_", 64),
        ("downstream_request_digest", "rq_", 64),
        ("project_id", "project_", 32),
        ("run_id", "run_", 32),
        ("model_revision_id", "mr_", 64),
        ("experiment_revision_id", "er_", 64),
        ("policy_snapshot_digest", "ps_", 64),
        ("run_admission_digest", "ra_", 64),
        ("run_intent_digest", "ri_", 64),
    ):
        _id(value[key], prefix, length, key)
    if value["model_id"] != MODEL_ID:
        raise Gate2ContractError("Mesa receipt model is invalid")
    for key in ("experiment_sha256", "captured_request_sha256"):
        if not isinstance(value[key], str) or re.fullmatch(r"[0-9a-f]{64}", value[key]) is None:
            raise Gate2ContractError(f"invalid {key}")
    if not isinstance(value["ownership_epoch"], int) or isinstance(value["ownership_epoch"], bool) or value["ownership_epoch"] < 1:
        raise Gate2ContractError("invalid receipt ownership epoch")
    _nonempty(value["accepted_at"], "accepted_at")
    if value["mesa_run_receipt_digest"] != receipt_digest(value):
        raise Gate2ContractError("Mesa receipt digest mismatch")
    return deepcopy(value)


def validate_lifecycle_chain(
    records: list[dict[str, Any]],
    receipt: dict[str, Any],
    cancel_tombstone: dict[str, Any] | None = None,
    *,
    require_complete_cancel_binding: bool = False,
) -> None:
    terminal = {"verified_succeeded", "terminal_failed", "terminal_timed_out", "terminal_cancelled"}
    allowed: dict[str, set[str]] = {
        "receipt_committed": {"ownership_acquired"},
        "ownership_acquired": {"ownership_acquired", "temp_prepared", "worker_started", "cancel_requested", "worker_exited", "terminal_failed", "terminal_cancelled"},
        "temp_prepared": {"ownership_acquired", "spawn_intent", "cancel_requested", "terminal_failed", "terminal_cancelled"},
        "spawn_intent": {"worker_started", "ownership_acquired", "cancel_requested", "terminal_failed", "terminal_cancelled"},
        "worker_started": {"ownership_acquired", "cancel_requested", "worker_exited"},
        "cancel_requested": {"ownership_acquired", "worker_exited", "terminal_cancelled", "terminal_failed"},
        "worker_exited": terminal,
    }
    owner_by_epoch: dict[int, str] = {}
    spawn_nonces: set[str] = set()
    cancel_records: list[dict[str, Any]] = []
    previous: dict[str, Any] | None = None
    terminal_count = 0
    for sequence, record in enumerate(records):
        value = _exact_mapping(record, LIFECYCLE_KEYS, "Mesa lifecycle record")
        if value["schema_version"] != 1 or value["canonical_json_version"] != CANONICAL_JSON_VERSION_V2:
            raise Gate2ContractError("invalid Mesa lifecycle version")
        if value["state"] not in LIFECYCLE_STATES or value["sequence"] != sequence:
            raise Gate2ContractError("invalid Mesa lifecycle state or sequence")
        if value["mesa_lifecycle_digest"] != lifecycle_digest(value):
            raise Gate2ContractError("Mesa lifecycle digest mismatch")
        expected_previous = previous["mesa_lifecycle_digest"] if previous else None
        if value["previous_mesa_lifecycle_digest"] != expected_previous:
            raise Gate2ContractError("Mesa lifecycle chain is broken")
        for key, receipt_key in (
            ("project_id", "project_id"), ("run_id", "run_id"),
            ("receipt_digest", "mesa_run_receipt_digest"), ("run_intent_digest", "run_intent_digest"),
            ("run_admission_digest", "run_admission_digest"), ("policy_snapshot_digest", "policy_snapshot_digest"),
            ("experiment_sha256", "experiment_sha256"), ("captured_request_sha256", "captured_request_sha256"),
        ):
            if value[key] != receipt[receipt_key]:
                raise Gate2ContractError(f"Mesa lifecycle {key} binding mismatch")
        epoch = value["ownership_epoch"]
        owner = value["owner_instance_id"]
        if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < receipt["ownership_epoch"]:
            raise Gate2ContractError("invalid lifecycle ownership epoch")
        if not isinstance(owner, str) or re.fullmatch(r"mesa_owner_[0-9a-f]{32}", owner) is None:
            raise Gate2ContractError("invalid lifecycle owner")
        if epoch in owner_by_epoch and owner_by_epoch[epoch] != owner:
            raise Gate2ContractError("two owners claim the same lifecycle epoch")
        owner_by_epoch[epoch] = owner
        if previous:
            previous_epoch = previous["ownership_epoch"]
            if epoch < previous_epoch or epoch > previous_epoch + 1:
                raise Gate2ContractError("lifecycle ownership epoch skipped or rolled back")
            if value["state"] == "ownership_acquired":
                initial_claim = previous["state"] == "receipt_committed" and sequence == 1 and epoch == previous_epoch
                if not initial_claim and epoch != previous_epoch + 1:
                    raise Gate2ContractError("ownership acquisition must advance the epoch")
            elif epoch != previous_epoch:
                raise Gate2ContractError("only ownership acquisition may advance the epoch")
            if value["state"] not in allowed.get(previous["state"], set()):
                raise Gate2ContractError(f"illegal lifecycle transition {previous['state']} -> {value['state']}")
        elif value["state"] != "receipt_committed" or epoch != receipt["ownership_epoch"]:
            raise Gate2ContractError("lifecycle must begin with receipt_committed")
        child = value["child_identity"]
        evidence = value["evidence_digest"]
        if value["state"] == "worker_started":
            if not isinstance(child, dict) or set(child) != {"pid", "process_start_token", "spawn_nonce", "executable_sha256", "request_sha256"}:
                raise Gate2ContractError("worker_started child identity is invalid")
            if not isinstance(child["pid"], int) or isinstance(child["pid"], bool) or child["pid"] <= 0:
                raise Gate2ContractError("worker_started PID is invalid")
            for key in ("process_start_token", "executable_sha256", "request_sha256"):
                if not isinstance(child[key], str) or re.fullmatch(r"[0-9a-f]{64}", child[key]) is None:
                    raise Gate2ContractError(f"worker_started {key} is invalid")
            if not isinstance(child["spawn_nonce"], str) or child["spawn_nonce"] not in spawn_nonces:
                raise Gate2ContractError("worker_started nonce lacks a prior spawn intent")
        elif child is not None:
            raise Gate2ContractError("child identity is only valid on worker_started")
        if value["state"] == "spawn_intent":
            if not isinstance(evidence, str) or re.fullmatch(r"nonce_[0-9a-f]{32}", evidence) is None:
                raise Gate2ContractError("spawn intent nonce is invalid")
            spawn_nonces.add(evidence.removeprefix("nonce_"))
        elif value["state"] == "cancel_requested":
            if not isinstance(evidence, str) or re.fullmatch(r"ct_[0-9a-f]{64}", evidence) is None:
                raise Gate2ContractError("cancel lifecycle lacks an exact tombstone digest")
            cancel_records.append(value)
        elif value["state"] in terminal | {"worker_exited"}:
            if not isinstance(evidence, str) or re.fullmatch(r"tm_[0-9a-f]{64}", evidence) is None:
                raise Gate2ContractError("terminal lifecycle evidence is invalid")
        elif evidence is not None:
            raise Gate2ContractError("unexpected lifecycle evidence")
        if not isinstance(value["created_at"], str) or not value["created_at"]:
            raise Gate2ContractError("invalid lifecycle timestamp")
        if value["state"] in terminal:
            terminal_count += 1
        previous = value
    if terminal_count > 1 or (terminal_count and records[-1]["state"] not in terminal):
        raise Gate2ContractError("invalid terminal lifecycle placement")
    if cancel_tombstone is None:
        if cancel_records:
            raise Gate2ContractError("cancel lifecycle has no verified committed tombstone")
    else:
        tombstone = validate_cancel_tombstone(cancel_tombstone)
        if tombstone["project_id"] != receipt["project_id"] or tombstone["run_id"] != receipt["run_id"]:
            raise Gate2ContractError("cancel tombstone does not bind the lifecycle run")
        if len(cancel_records) > 1:
            raise Gate2ContractError("cancel lifecycle contains duplicate cancel_requested records")
        if cancel_records and cancel_records[0]["evidence_digest"] != tombstone["cancel_tombstone_digest"]:
            raise Gate2ContractError("cancel lifecycle digest differs from the committed tombstone")
        if require_complete_cancel_binding and len(cancel_records) != 1:
            raise Gate2ContractError("terminal lifecycle lacks one cancel_requested record")


def validate_cancel_tombstone(raw: object) -> dict[str, Any]:
    value = _exact_mapping(raw, CANCEL_TOMBSTONE_KEYS, "cancel tombstone")
    if value["schema_version"] != 1 or value["canonical_json_version"] != CANONICAL_JSON_VERSION_V2:
        raise Gate2ContractError("invalid cancel tombstone version")
    _id(value["cancel_tombstone_digest"], "ct_", 64, "cancel_tombstone_digest")
    _id(value["project_id"], "project_", 32, "project_id")
    _id(value["run_id"], "run_", 32, "run_id")
    _nonempty(value["cancel_command_id"], "cancel_command_id")
    _nonempty(value["cancel_command_digest"], "cancel_command_digest")
    _id(value["requested_by_actor_id"], "actor_", 32, "requested_by_actor_id")
    if not isinstance(value["requested_at_snapshot_revision"], int) or isinstance(value["requested_at_snapshot_revision"], bool) or value["requested_at_snapshot_revision"] < 0:
        raise Gate2ContractError("invalid cancel snapshot revision")
    _nonempty(value["created_at"], "created_at")
    if value["cancel_tombstone_digest"] != prefixed_digest(value, field="cancel_tombstone_digest", prefix="ct_"):
        raise Gate2ContractError("cancel tombstone digest mismatch")
    return deepcopy(value)
