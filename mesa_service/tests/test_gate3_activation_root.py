from __future__ import annotations

import copy
import hashlib
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from mesa_service.canonical_v2 import canonical_json_v2_bytes, prefixed_digest, sha256_v2
from mesa_service.gate2_contracts import defaults_digest
from mesa_service.gate2_project_evidence import ProjectEvidenceError, verify_framed_activation_root
from mesa_service.gate3_activation import build_candidate_descriptor, candidate_bytes_digest
from mesa_service.gate3_bundle import BUNDLE_PROTOCOL, framed_manifest, framed_runtime_profile, materialize_framed_bundle
from mesa_service.wind_contracts import load_json_asset


PROJECT = "project_" + "1" * 32
ACTOR = "actor_" + "2" * 32
BRIEF = "dbr_" + "3" * 64
ALIGNMENT = "amr_" + "4" * 64
MODEL = framed_manifest()["model_revision_id"]


def _write(path: Path, value: dict, *, lf: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_json_v2_bytes(value) + (b"\n" if lf else b""))


def _root(*, digit: str = "1", brief_id: str = BRIEF, alignment_id: str = ALIGNMENT) -> dict:
    preset = load_json_asset("defaults/wind-turbine-maintenance-demo-v1.json")
    defaults = copy.deepcopy(preset["parameters"])
    execution_defaults = {"horizon_days": 1095, "warmup_days": 365, "seed": 2}
    value = {
        "schema_id": "riff://evidence-studio/experiment-revision/framed/v1",
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_id": PROJECT,
        "parent_experiment_revision_id": None,
        "operation": "create",
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": MODEL,
        "brief_revision_id": brief_id,
        "alignment_revision_id": alignment_id,
        "preset_id": "wind-turbine-maintenance-demo-v1",
        "defaults_digest": defaults_digest("wind-turbine-maintenance-demo-v1", defaults, execution_defaults),
        "parameter_defaults": defaults,
        "parameters": {**defaults, "crew_count": 1 + int(digit)},
        "parameter_diff": [{"parameter_id": "crew_count", "default_value": defaults["crew_count"], "current_value": 1 + int(digit)}],
        "execution_defaults": execution_defaults,
        "execution_values": {**execution_defaults, "seed": int(digit)},
        "execution_diff": [{"field": "seed", "default_value": 2, "current_value": int(digit)}] if int(digit) != 2 else [],
        "runtime_profile": framed_runtime_profile(),
        "copy_migration_rule": "framed_parameter_copy_revalidate_v1",
        "created_by_actor_id": ACTOR,
        "created_at": f"2026-07-21T00:00:0{digit}.000Z",
    }
    value["experiment_revision_id"] = "er_" + sha256_v2(value)
    value["experiment_digest"] = "erd_" + sha256_v2(value)
    return value


def _candidate(snapshot_revision: int, current: dict) -> dict:
    return {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_id": PROJECT,
        "display_name": "Activation root fixture",
        "snapshot_revision": snapshot_revision,
        "phase": "brief" if snapshot_revision == 0 else "review",
        "current": current,
        "actor_ids": [ACTOR],
        "issue_index": [],
        "attestation_index": [],
        "run_index": [],
        "created_at": "2026-07-21T00:00:00.000Z",
        "updated_at": f"2026-07-21T00:00:0{snapshot_revision}.000Z",
    }


def _event(
    candidate: dict,
    *,
    sequence: int,
    previous: str | None,
    command_id: str,
    command_digest: str,
    event_type: str,
    refs: list[dict],
    response: dict,
) -> dict:
    initial = sequence == 0
    value = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_id": PROJECT,
        "snapshot_revision": sequence,
        "previous_snapshot_revision": None if initial else sequence - 1,
        "previous_event_digest": previous,
        "event_digest": "",
        "command_id": command_id,
        "command_digest": command_digest,
        "initiator": "workspace_create" if initial else "system",
        "session_id": None,
        "actor_id": ACTOR if initial else None,
        "system_component": None if initial else "backend_model_reconciler",
        "event_type": event_type,
        "record_refs": refs,
        "state_patch": [{"op": "replace", "path": "", "value": candidate}],
        "response_status": 201 if initial else 200,
        "response_projection": response,
        "committed_at": f"2026-07-21T00:00:0{sequence}.000Z",
    }
    value["event_digest"] = prefixed_digest(value, field="event_digest", prefix="pe_")
    return value


def _fixture(tmp_path: Path, *, mutation: str | None = None, ready: bool = True) -> tuple[Path, dict, str]:
    workspace = tmp_path / "workspace"
    project = workspace / "projects" / PROJECT
    activation_id = str(uuid.uuid4())
    actor = {
        "schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "actor_id": ACTOR,
        "actor_type": "human", "display_name": "Owner", "declared_role": "project_owner",
        "identity_assurance": "declared_unauthenticated_local", "created_at": "2026-07-21T00:00:00.000Z",
    }
    actor_digest = "adr_" + sha256_v2(actor)
    brief = {
        "schema_id": "riff://evidence-studio/decision-brief/activation-v1",
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_id": PROJECT,
        "parent_brief_revision_id": None,
        "source_brief_revision_id": "dbr_" + "1" * 64,
        "operation": "activation_copy",
        "copy_rule": "exact_content_activation_copy_v1",
        "content": {"question": "Synthetic maintenance question"},
        "created_by_actor_id": ACTOR,
        "created_at": "2026-07-21T00:00:01.000Z",
        "decision_brief_revision_id": "",
        "decision_brief_digest": "",
    }
    brief["decision_brief_revision_id"] = "dbr_" + sha256_v2({
        key: value for key, value in brief.items()
        if key not in {"decision_brief_revision_id", "decision_brief_digest"}
    })
    brief["decision_brief_digest"] = "dbrd_" + sha256_v2({
        key: value for key, value in brief.items() if key != "decision_brief_digest"
    })
    alignment = {
        "schema_id": "riff://evidence-studio/alignment-map/framed/v1",
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_id": PROJECT,
        "parent_alignment_revision_id": None,
        "brief_revision_id": brief["decision_brief_revision_id"],
        "model_revision_id": MODEL,
        "migration_rule": "framed_alignment_rebind_v1",
        "mappings": [],
        "gaps": [],
        "source_refs": [],
        "created_by_actor_id": ACTOR,
        "created_at": "2026-07-21T00:00:01.000Z",
        "alignment_revision_id": "",
        "alignment_digest": "",
    }
    alignment["alignment_revision_id"] = "amr_" + sha256_v2({
        key: value for key, value in alignment.items()
        if key not in {"alignment_revision_id", "alignment_digest"}
    })
    alignment["alignment_digest"] = "amd_" + sha256_v2({
        key: value for key, value in alignment.items() if key != "alignment_digest"
    })
    root = _root(
        digit="1",
        brief_id=brief["decision_brief_revision_id"],
        alignment_id=alignment["alignment_revision_id"],
    )
    old_model_revision = "mr_" + "7" * 64
    descriptor = build_candidate_descriptor(PROJECT, old_model_revision, "rh_" + "4" * 64)
    candidate_bundle = project / "wind" / "candidates" / activation_id / MODEL
    materialize_framed_bundle(candidate_bundle)
    candidate_receipt = {
        "schema_id": "riff://mesa-wind/candidate-receipt/v1",
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "activation_id": activation_id,
        "project_id": PROJECT,
        "intent_digest": "aint_" + "8" * 64,
        "expected_old_model_revision_id": old_model_revision,
        "candidate_descriptor_digest": descriptor["descriptor_digest"],
        "target_model_revision_id": MODEL,
        "bundle_protocol": BUNDLE_PROTOCOL,
        "manifest_sha256": descriptor["manifest_sha256"],
        "files": framed_manifest()["files"],
        "file_map_sha256": descriptor["file_map_sha256"],
        "candidate_bytes_digest": candidate_bytes_digest(candidate_bundle),
        "created_at": "2026-07-21T00:00:01.000Z",
        "candidate_receipt_digest": "",
    }
    candidate_receipt["candidate_receipt_digest"] = prefixed_digest(
        candidate_receipt, field="candidate_receipt_digest", prefix="acand_"
    )
    empty_current = {
        "decision_brief_revision_id": None, "alignment_map_revision_id": None,
        "model_revision_id": None, "experiment_revision_id": None, "run_id": None,
    }
    target = {
        "model_revision_id": MODEL, "brief_revision_id": brief["decision_brief_revision_id"],
        "alignment_revision_id": alignment["alignment_revision_id"], "experiment_revision_id": root["experiment_revision_id"],
    }
    target_current = {
        "decision_brief_revision_id": brief["decision_brief_revision_id"],
        "alignment_map_revision_id": alignment["alignment_revision_id"],
        "model_revision_id": MODEL, "experiment_revision_id": root["experiment_revision_id"], "run_id": None,
    }
    creation_response = {
        "project": {"project_id": PROJECT, "display_name": "Activation root fixture", "snapshot_revision": 0},
        "initial_actor": actor,
    }
    event0 = _event(
        _candidate(0, empty_current), sequence=0, previous=None,
        command_id="00000000-0000-4000-8000-000000000000", command_digest="cmd_" + "0" * 64,
        event_type="project.created", refs=[{"kind": "actor", "id": ACTOR, "digest": actor_digest}],
        response=creation_response,
    )
    _write(project / "actors" / f"{ACTOR}.json", actor)
    _write(
        project / "alignment" / "decision-brief" / "revisions" / brief["decision_brief_revision_id"] / "revision.json",
        brief,
        lf=True,
    )
    _write(
        project / "alignment" / "requirement-map" / "revisions" / alignment["alignment_revision_id"] / "revision.json",
        alignment,
        lf=True,
    )
    _write(project / "experiments" / "revisions" / root["experiment_revision_id"] / "experiment.json", root, lf=True)

    brief_bytes = canonical_json_v2_bytes(brief) + b"\n"
    alignment_bytes = canonical_json_v2_bytes(alignment) + b"\n"
    root_bytes = canonical_json_v2_bytes(root) + b"\n"
    staged = {
        "brief": {"project_id": PROJECT, "record_id": brief["decision_brief_revision_id"], "record_digest": brief["decision_brief_digest"], "canonical_bytes_sha256": hashlib.sha256(brief_bytes).hexdigest(), "byte_length": len(brief_bytes), "created_at": brief["created_at"], "created_by_actor_id": ACTOR, "record_kind": "decision_brief", "record_schema_id": brief["schema_id"], "record_schema_version": 1},
        "alignment": {"project_id": PROJECT, "record_id": alignment["alignment_revision_id"], "record_digest": alignment["alignment_digest"], "canonical_bytes_sha256": hashlib.sha256(alignment_bytes).hexdigest(), "byte_length": len(alignment_bytes), "created_at": alignment["created_at"], "created_by_actor_id": ACTOR, "record_kind": "alignment_map", "record_schema_id": alignment["schema_id"], "record_schema_version": 1},
        "experiment": {"project_id": PROJECT, "record_id": root["experiment_revision_id"], "record_digest": root["experiment_digest"], "canonical_bytes_sha256": hashlib.sha256(root_bytes).hexdigest(), "byte_length": len(root_bytes), "created_at": root["created_at"], "created_by_actor_id": ACTOR, "record_kind": "experiment_revision", "record_schema_id": root["schema_id"], "record_schema_version": 1},
    }
    if mutation == "ref_id": staged["experiment"]["record_id"] = "er_" + "a" * 64
    if mutation == "ref_digest": staged["experiment"]["record_digest"] = "erd_" + "a" * 64
    if mutation == "ref_sha": staged["experiment"]["canonical_bytes_sha256"] = "a" * 64
    if mutation == "ref_length": staged["experiment"]["byte_length"] += 1
    binding = {
        "schema_id": "riff://evidence-studio/activation-target-binding/v1", "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2", "activation_id": activation_id,
        "project_id": PROJECT, "source": {**target, "model_revision_id": old_model_revision},
        "target": target, "base_snapshot_revision": 0, "base_project_event_digest": event0["event_digest"],
        "intent_digest": "aint_" + "8" * 64, "staging_manifest_digest": "astage_" + "9" * 64,
        "staged_record_refs": staged, "candidate_receipt_digest": candidate_receipt["candidate_receipt_digest"],
        "captured_candidate_bytes_digest": "b" * 64, "target_binding_digest": "",
    }
    if mutation == "cross_project": binding["project_id"] = "project_" + "f" * 32
    if mutation == "cross_activation": binding["activation_id"] = str(uuid.uuid4())
    if mutation == "binding_base": binding["base_project_event_digest"] = "pe_" + "f" * 64
    binding["target_binding_digest"] = prefixed_digest(binding, field="target_binding_digest", prefix="atb_")
    expected_refs = [
        {"kind": "activation_target_binding", "id": activation_id, "digest": binding["target_binding_digest"]},
        {"kind": "decision_brief_revision", "id": brief["decision_brief_revision_id"], "digest": staged["brief"]["record_digest"]},
        {"kind": "alignment_map_revision", "id": alignment["alignment_revision_id"], "digest": staged["alignment"]["record_digest"]},
        {"kind": "experiment_revision", "id": root["experiment_revision_id"], "digest": staged["experiment"]["record_digest"]},
    ]
    commit_refs = list(reversed(expected_refs)) if mutation == "commit_refs" else expected_refs
    commit_current = {**target_current, "experiment_revision_id": "er_" + "e" * 64} if mutation == "commit_state" else target_current
    command_digest = "cmd_" + "c" * 64
    commit = _event(
        _candidate(1, commit_current), sequence=1, previous=event0["event_digest"], command_id=activation_id,
        command_digest=command_digest, event_type="model.activation_committed", refs=commit_refs,
        response={"activation_id": activation_id, "status": "mesa_switch_pending"},
    )
    cas = {
        "schema_id": "riff://mesa-wind/active-cas-request/v1", "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2", "activation_id": activation_id, "project_id": PROJECT,
        "expected_old_model_revision_id": binding["source"]["model_revision_id"], "target_model_revision_id": MODEL,
        "candidate_receipt_digest": (
            "acand_" + "d" * 64
            if mutation == "switch"
            else candidate_receipt["candidate_receipt_digest"]
        ),
        "project_event_digest": commit["event_digest"],
    }
    switch = {
        **cas, "schema_id": "riff://mesa-wind/active-switch-receipt/v1",
        "previous_active_model_revision_id": cas["expected_old_model_revision_id"],
        "active_model_revision_id": MODEL, "switched_at": "2026-07-21T00:00:02.000Z", "switch_receipt_digest": "",
    }
    switch["switch_receipt_digest"] = prefixed_digest(switch, field="switch_receipt_digest", prefix="asw_")
    marker = {
        "schema_id": "riff://evidence-studio/activation-reconcile-marker/v1", "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2", "activation_id": activation_id, "project_id": PROJECT,
        "target_binding_digest": binding["target_binding_digest"], "base_project_event_digest": commit["event_digest"],
        "base_snapshot_revision": 1, "switch_receipt_digest": switch["switch_receipt_digest"],
        "verified_project_target_model_revision_id": MODEL, "verified_mesa_active_model_revision_id": MODEL,
        "reconciled_at": "2026-07-21T00:00:02.000Z", "reconcile_digest": "",
    }
    marker["reconcile_digest"] = prefixed_digest(marker, field="reconcile_digest", prefix="arec_")
    ready_event = _event(
        _candidate(2, target_current), sequence=2, previous=commit["event_digest"], command_id=activation_id,
        command_digest=command_digest, event_type="model.activation_reconciled",
        refs=[{"kind": "activation_reconcile_marker", "id": activation_id, "digest": marker["reconcile_digest"]}],
        response={"activation_id": activation_id, "status": "ready"},
    )

    for index, event in enumerate([event0, commit] + ([ready_event] if ready else [])):
        _write(project / "project-events" / f"{index:020d}.json", event)
    snapshot0 = {**event0["state_patch"][0]["value"], "previous_event_digest": event0["event_digest"]}
    snapshot0_digest = "sd_" + sha256_v2(snapshot0)
    workspace_event = {
        "schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "workspace_revision": 0,
        "previous_event_digest": None, "command_id": event0["command_id"], "command_digest": event0["command_digest"],
        "project_id": PROJECT, "project_event_zero_digest": event0["event_digest"],
        "project_snapshot_zero_digest": snapshot0_digest, "initial_actor_id": ACTOR, "initial_actor_digest": actor_digest,
        "response_status": 201, "response_projection": creation_response, "committed_at": event0["committed_at"],
        "event_digest": "",
    }
    workspace_event["event_digest"] = prefixed_digest(workspace_event, field="event_digest", prefix="we_")
    _write(workspace / "workspace-create-events" / "00000000000000000000.json", workspace_event)
    _write(workspace / "workspace.json", {"schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "project_ids": [PROJECT], "corrupt_project_ids": [], "workspace_revision": 0})
    _write(project / "activations" / activation_id / "target-binding.json", binding, lf=True)
    if ready:
        _write(project / "activations" / activation_id / "reconcile.json", marker, lf=True)
    _write(project / "wind" / "switch-receipts" / f"{activation_id}.request.json", cas, lf=True)
    _write(project / "wind" / "switch-receipts" / f"{activation_id}.json", switch, lf=True)
    _write(project / "wind" / "candidates" / activation_id / "candidate-receipt.json", candidate_receipt, lf=True)
    bundle_dir = project / "models" / "wind-turbine-maintenance" / "revisions" / MODEL
    materialize_framed_bundle(bundle_dir)
    _write(project / "models" / "active.json", {
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": MODEL,
        "experiment_revision_id": root["experiment_revision_id"],
        "preset_id": "wind-turbine-maintenance-demo-v1",
    })
    return workspace, root, activation_id


def test_ready_activation_root_ignores_legacy_active_experiment_pointer(tmp_path: Path) -> None:
    workspace, root, activation_id = _fixture(tmp_path)
    assert verify_framed_activation_root(workspace, PROJECT, root)["activation_id"] == activation_id


def test_framed_root_without_activation_is_rejected(tmp_path: Path) -> None:
    workspace, root, activation_id = _fixture(tmp_path)
    (workspace / "projects" / PROJECT / "activations" / activation_id / "target-binding.json").unlink()
    with pytest.raises(ProjectEvidenceError, match="one exact activation"):
        verify_framed_activation_root(workspace, PROJECT, root)


@pytest.mark.parametrize("mutation", ["cross_project", "cross_activation", "ref_id", "ref_digest", "ref_sha", "ref_length", "binding_base"])
def test_activation_binding_and_root_ref_mismatches_are_rejected(tmp_path: Path, mutation: str) -> None:
    workspace, root, _ = _fixture(tmp_path, mutation=mutation)
    with pytest.raises(ProjectEvidenceError):
        verify_framed_activation_root(workspace, PROJECT, root)


@pytest.mark.parametrize("mutation", ["commit_refs", "commit_state"])
def test_activation_commit_ordered_refs_and_target_state_are_required(tmp_path: Path, mutation: str) -> None:
    workspace, root, _ = _fixture(tmp_path, mutation=mutation)
    with pytest.raises(ProjectEvidenceError, match="committed model activation"):
        verify_framed_activation_root(workspace, PROJECT, root)


def test_switch_mismatch_and_unreconciled_activation_are_rejected(tmp_path: Path) -> None:
    switched, root, _ = _fixture(tmp_path / "switch", mutation="switch")
    with pytest.raises(ProjectEvidenceError, match="switch"):
        verify_framed_activation_root(switched, PROJECT, root)
    unreconciled, root, _ = _fixture(tmp_path / "unreconciled", ready=False)
    with pytest.raises(ProjectEvidenceError, match="reconcile"):
        verify_framed_activation_root(unreconciled, PROJECT, root)


def test_two_same_model_roots_select_exact_experiment_target(tmp_path: Path) -> None:
    workspace, root, activation_id = _fixture(tmp_path)
    project = workspace / "projects" / PROJECT
    other = _root(digit="2")
    _write(project / "experiments" / "revisions" / other["experiment_revision_id"] / "experiment.json", other, lf=True)
    other_id = str(uuid.uuid4())
    other_binding = copy.deepcopy(__import__("json").loads((project / "activations" / activation_id / "target-binding.json").read_text()))
    other_binding["activation_id"] = other_id
    other_binding["target"]["experiment_revision_id"] = other["experiment_revision_id"]
    other_binding["staged_record_refs"]["experiment"].update({
        "record_id": other["experiment_revision_id"], "record_digest": other["experiment_digest"],
        "canonical_bytes_sha256": hashlib.sha256(canonical_json_v2_bytes(other) + b"\n").hexdigest(),
        "byte_length": len(canonical_json_v2_bytes(other) + b"\n"), "created_at": other["created_at"],
    })
    other_binding["target_binding_digest"] = prefixed_digest(other_binding, field="target_binding_digest", prefix="atb_")
    _write(project / "activations" / other_id / "target-binding.json", other_binding, lf=True)
    assert verify_framed_activation_root(workspace, PROJECT, root)["activation_id"] == activation_id


def test_activation_root_verification_survives_fresh_process_restart(tmp_path: Path) -> None:
    workspace, root, activation_id = _fixture(tmp_path)
    script = """
import sys
from pathlib import Path
from mesa_service.canonical_v2 import require_canonical_json_v2_bytes
from mesa_service.gate2_project_evidence import verify_framed_activation_root
workspace = Path(sys.argv[1])
project_id, root_id = sys.argv[2], sys.argv[3]
data = (workspace / 'projects' / project_id / 'experiments' / 'revisions' / root_id / 'experiment.json').read_bytes()
root = require_canonical_json_v2_bytes(data[:-1])
print(verify_framed_activation_root(workspace, project_id, root)['activation_id'])
"""
    restarted = subprocess.run(
        [sys.executable, "-c", script, str(workspace), PROJECT, root["experiment_revision_id"]],
        check=True, capture_output=True, text=True,
    )
    assert restarted.stdout.strip() == activation_id
