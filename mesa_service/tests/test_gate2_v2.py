from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import signal
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mesa_service.app import create_app
from mesa_service.bundle import materialize_reviewed_bundle
from mesa_service.canonical_v2 import (
    CanonicalV2Error,
    canonical_json_v2_bytes,
    prefixed_digest,
    strict_json_loads_v2,
)
from mesa_service.gate2_contracts import defaults_digest, downstream_request_digest
from mesa_service.service import MesaService, ServiceError
from mesa_service.wind_contracts import MODEL_ID, PRESET_ID
from mesa_service.wind_worker import (
    _daily_semantic_digest,
    _semantic_event_projection,
    _semantic_without_run_context,
)


PROJECT_ID = "project_" + "1" * 32
RUN_ID = "run_" + "2" * 32
ACTOR_ID = "actor_" + "2" * 32
KEY = "rk_" + "6" * 64


def test_canonical_v2_matches_shared_node_python_golden_fixture() -> None:
    fixture = json.loads((Path(__file__).parents[2] / "contracts" / "canonical-json-v2-golden.json").read_text())
    assert fixture["schema_version"] == 1
    assert fixture["canonical_json_version"] == "riff-canonical-json-v2"
    for item in fixture["accept"]:
        value = strict_json_loads_v2(item["input"])
        encoded = canonical_json_v2_bytes(value)
        assert encoded.hex() == item["canonical_hex"], item["name"]
        assert hashlib.sha256(encoded).hexdigest() == item["sha256"], item["name"]
    for item in fixture["reject"]:
        with pytest.raises(CanonicalV2Error, match="."):
            strict_json_loads_v2(item["input"])


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_json_v2_bytes(value))


def _materialize_wind_fixture(workspace: Path, project_id: str) -> dict:
    project = workspace / "projects" / project_id
    project.mkdir(parents=True, exist_ok=True)
    materialized = materialize_reviewed_bundle(project)
    active = {
        "model_id": MODEL_ID,
        "model_revision_id": materialized["model_revision_id"],
        "experiment_revision_id": materialized["experiment_revision_id"],
        "preset_id": PRESET_ID,
        "parameter_schema": json.loads(
            (Path(materialized["bundle_dir"]) / "parameter-schema.json").read_text()
        ),
        "metric_schema": json.loads(
            (Path(materialized["bundle_dir"]) / "metric-schema.json").read_text()
        ),
        "claim_labels": materialized["experiment"]["claim_labels"],
    }
    _write(project / "models" / "active.json", active)
    return active


def _subject(subject: str, *, endorsed: bool = False) -> dict:
    refs = []
    endorsements = []
    if endorsed:
        attestation_id = "att_" + ("7" if subject.startswith("amr_") else "8") * 32
        refs = [{
            "attestation_id": attestation_id,
            "attestation_digest": "atd_" + "9" * 64,
            "actor_id": ACTOR_ID,
            "actor_type": "human",
            "declared_role": "project_owner",
            "scope": "workflow_progression",
            "decision": "endorse",
        }]
        endorsements = [attestation_id]
    return {
        "subject_revision_id": subject,
        "effective_attestation_refs": refs,
        "human_project_owner_endorsement_attestation_ids": endorsements,
        "human_project_owner_endorsement_count": len(endorsements),
        "open_issue_refs": [],
        "open_issue_ids": [],
        "open_issue_count": 0,
        "open_blocking_issue_ids": [],
        "open_blocking_issue_count": 0,
        "open_non_blocking_issue_ids": [],
        "open_non_blocking_issue_count": 0,
        "policy_satisfied": endorsed,
        "wording": "no_recorded_open_objection",
    }


def _content_id(prefix: str, field: str, value: dict) -> str:
    return prefix + hashlib.sha256(canonical_json_v2_bytes({key: item for key, item in value.items() if key != field})).hexdigest()


def _event(candidate: dict, *, sequence: int, previous: str | None, event_type: str, refs: list[dict], actor_id: str | None, initiator: str) -> dict:
    value = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_id": PROJECT_ID,
        "snapshot_revision": sequence,
        "previous_snapshot_revision": None if sequence == 0 else sequence - 1,
        "previous_event_digest": previous,
        "event_digest": "",
        "command_id": f"00000000-0000-4000-8000-{sequence:012d}",
        "command_digest": "cmd_" + f"{sequence + 1:064x}",
        "initiator": initiator,
        "session_id": None if initiator != "client" else "session_" + "f" * 32,
        "actor_id": actor_id,
        "system_component": None,
        "event_type": event_type,
        "record_refs": refs,
        "state_patch": [{"op": "replace", "path": "", "value": candidate}],
        "response_status": 201 if sequence == 0 else 200,
        "response_projection": {},
        "committed_at": f"2026-07-21T00:00:{sequence:02d}.000Z",
    }
    value["event_digest"] = prefixed_digest(value, field="event_digest", prefix="pe_")
    return value


def _snapshot(event: dict) -> dict:
    unsigned = {**event["state_patch"][0]["value"], "previous_event_digest": event["event_digest"]}
    return {**unsigned, "snapshot_digest": "sd_" + hashlib.sha256(canonical_json_v2_bytes(unsigned)).hexdigest()}


def _append_project_event(workspace: Path, *, event_type: str, refs: list[dict], changes: dict) -> dict:
    project = workspace / "projects" / PROJECT_ID
    paths = sorted((project / "project-events").glob("*.json"))
    prior = json.loads(paths[-1].read_text())
    candidate = copy.deepcopy(prior["state_patch"][0]["value"])
    candidate.update(copy.deepcopy(changes))
    sequence = len(paths)
    candidate["snapshot_revision"] = sequence
    candidate["updated_at"] = f"2026-07-21T00:00:{sequence:02d}.000Z"
    event = _event(
        candidate,
        sequence=sequence,
        previous=prior["event_digest"],
        event_type=event_type,
        refs=refs,
        actor_id=ACTOR_ID,
        initiator="client",
    )
    _write(project / "project-events" / f"{sequence:020d}.json", event)
    _write(project / "project.json", _snapshot(event))
    return event


def _prepare(workspace: Path, *, run_id: str = RUN_ID, key: str = KEY, endorsed: bool = False) -> dict:
    active = _materialize_wind_fixture(workspace, PROJECT_ID)
    project = workspace / "projects" / PROJECT_ID
    v1_experiment = json.loads(
        (project / "experiments" / "revisions" / active["experiment_revision_id"] / "experiment.json").read_text()
    )
    execution_defaults = {
        "horizon_days": v1_experiment["horizon_days"],
        "warmup_days": v1_experiment["warmup_days"],
        "seed": v1_experiment["seed"],
    }
    actor = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "actor_id": ACTOR_ID,
        "actor_type": "human",
        "display_name": "Gate 2 owner",
        "declared_role": "project_owner",
        "identity_assurance": "declared_unauthenticated_local",
        "created_at": "2026-07-21T00:00:00.000Z",
    }
    actor_digest = "adr_" + hashlib.sha256(canonical_json_v2_bytes(actor)).hexdigest()
    brief = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "decision_brief_revision_id": "",
        "project_id": PROJECT_ID,
        "parent_decision_brief_revision_id": None,
        "operation": "create",
        "question": "How should the wind farm be maintained?",
        "decision_owner": "Local owner",
        "objective": "Exercise the Gate 2 execution contract",
        "constraints": [],
        "assumptions": [],
        "non_goals": [],
        "sources": [],
        "created_by_actor_id": ACTOR_ID,
        "created_at": "2026-07-21T00:00:00.000Z",
    }
    brief["decision_brief_revision_id"] = _content_id("dbr_", "decision_brief_revision_id", brief)
    alignment = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "alignment_map_revision_id": "",
        "project_id": PROJECT_ID,
        "parent_alignment_map_revision_id": None,
        "operation": "create",
        "decision_brief_revision_id": brief["decision_brief_revision_id"],
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": active["model_revision_id"],
        "entries": [],
        "known_gaps": [],
        "created_by_actor_id": ACTOR_ID,
        "created_at": "2026-07-21T00:00:01.000Z",
    }
    alignment["alignment_map_revision_id"] = _content_id("amr_", "alignment_map_revision_id", alignment)
    experiment = {
        "schema_version": 2,
        "canonical_json_version": "riff-canonical-json-v2",
        "experiment_revision_id": "",
        "project_id": PROJECT_ID,
        "parent_experiment_revision_id": None,
        "operation": "create",
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": active["model_revision_id"],
        "brief_revision_id": brief["decision_brief_revision_id"],
        "alignment_revision_id": alignment["alignment_map_revision_id"],
        "preset_id": "wind-turbine-maintenance-demo-v1",
        "defaults_digest": defaults_digest(
            "wind-turbine-maintenance-demo-v1", v1_experiment["parameters"], execution_defaults
        ),
        "parameter_defaults": v1_experiment["parameters"],
        "parameters": v1_experiment["parameters"],
        "parameter_diff": [],
        "execution_defaults": execution_defaults,
        "execution_values": execution_defaults,
        "execution_diff": [],
        "runtime_profile": v1_experiment["runtime_profile"],
        "created_by_actor_id": ACTOR_ID,
        "created_at": "2026-07-21T00:00:00.000Z",
    }
    experiment["experiment_revision_id"] = "er_" + __import__("hashlib").sha256(
        canonical_json_v2_bytes({key: value for key, value in experiment.items() if key != "experiment_revision_id"})
    ).hexdigest()
    experiment_bytes = canonical_json_v2_bytes(experiment)
    experiment_sha = __import__("hashlib").sha256(experiment_bytes).hexdigest()

    _write(project / "actors" / f"{ACTOR_ID}.json", actor)
    _write(project / "alignment" / "decision-brief" / "revisions" / brief["decision_brief_revision_id"] / "revision.json", brief)
    _write(project / "alignment" / "requirement-map" / "revisions" / alignment["alignment_map_revision_id"] / "revision.json", alignment)
    _write(project / "experiments" / "revisions" / experiment["experiment_revision_id"] / "experiment.json", experiment)
    base0 = {
        "schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "project_id": PROJECT_ID,
        "display_name": "Gate 2 test", "snapshot_revision": 0, "phase": "brief",
        "current": {"decision_brief_revision_id": None, "alignment_map_revision_id": None, "model_revision_id": None, "experiment_revision_id": None, "run_id": None},
        "actor_ids": [ACTOR_ID], "issue_index": [], "attestation_index": [], "run_index": [],
        "created_at": "2026-07-21T00:00:00.000Z", "updated_at": "2026-07-21T00:00:00.000Z",
    }
    event0 = _event(base0, sequence=0, previous=None, event_type="project.created", refs=[{"kind": "actor", "id": ACTOR_ID, "digest": actor_digest}], actor_id=ACTOR_ID, initiator="workspace_create")
    creation_response = {
        "project": {"project_id": PROJECT_ID, "display_name": base0["display_name"], "snapshot_revision": 0},
        "initial_actor": actor,
    }
    event0["response_projection"] = creation_response
    event0["event_digest"] = ""
    event0["event_digest"] = prefixed_digest(event0, field="event_digest", prefix="pe_")
    _write(project / "project-events" / "00000000000000000000.json", event0)
    configured = copy.deepcopy(base0)
    configured.update({
        "snapshot_revision": 1, "phase": "review", "updated_at": "2026-07-21T00:00:01.000Z",
        "current": {
            "decision_brief_revision_id": brief["decision_brief_revision_id"],
            "alignment_map_revision_id": alignment["alignment_map_revision_id"],
            "model_revision_id": active["model_revision_id"],
            "experiment_revision_id": experiment["experiment_revision_id"],
            "run_id": None,
        },
    })
    event1 = _event(configured, sequence=1, previous=event0["event_digest"], event_type="experiment.revision_created", refs=[
        {"kind": "decision_brief_revision", "id": brief["decision_brief_revision_id"], "digest": brief["decision_brief_revision_id"]},
        {"kind": "alignment_map_revision", "id": alignment["alignment_map_revision_id"], "digest": alignment["alignment_map_revision_id"]},
        {"kind": "experiment_revision", "id": experiment["experiment_revision_id"], "digest": experiment["experiment_revision_id"]},
    ], actor_id=ACTOR_ID, initiator="client")
    _write(project / "project-events" / "00000000000000000001.json", event1)
    snapshot0 = _snapshot(event0)
    workspace_event_base = {
        "schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "workspace_revision": 0,
        "previous_event_digest": None, "command_id": event0["command_id"], "command_digest": event0["command_digest"],
        "project_id": PROJECT_ID, "project_event_zero_digest": event0["event_digest"],
        "project_snapshot_zero_digest": snapshot0["snapshot_digest"], "initial_actor_id": ACTOR_ID,
        "initial_actor_digest": actor_digest, "response_status": 201, "response_projection": creation_response,
        "committed_at": "2026-07-21T00:00:00.000Z",
    }
    workspace_event = {**workspace_event_base, "event_digest": "we_" + hashlib.sha256(canonical_json_v2_bytes(workspace_event_base)).hexdigest()}
    _write(workspace / "workspace-create-events" / "00000000000000000000.json", workspace_event)
    _write(workspace / "workspace.json", {"schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "project_ids": [PROJECT_ID], "corrupt_project_ids": [], "workspace_revision": 0})

    alignment_policy = _subject(alignment["alignment_map_revision_id"], endorsed=endorsed)
    experiment_policy = _subject(experiment["experiment_revision_id"], endorsed=endorsed)
    effective_ids = sorted({ref["attestation_id"] for subject in (alignment_policy, experiment_policy) for ref in subject["effective_attestation_refs"]})
    policy = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "policy_snapshot_digest": "",
        "project_id": PROJECT_ID,
        "evaluated_at_snapshot_revision": 1,
        "evaluated_project_event_digest": event1["event_digest"],
        "alignment": alignment_policy,
        "experiment": experiment_policy,
        "combined_policy_satisfied": endorsed,
        "effective_attestation_ids": effective_ids,
        "open_issue_ids": [],
    }
    policy["policy_snapshot_digest"] = prefixed_digest(policy, field="policy_snapshot_digest", prefix="ps_")
    admission = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "run_admission_digest": "",
        "project_id": PROJECT_ID,
        "run_id": run_id,
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": active["model_revision_id"],
        "brief_revision_id": brief["decision_brief_revision_id"],
        "alignment_revision_id": alignment["alignment_map_revision_id"],
        "experiment_revision_id": experiment["experiment_revision_id"],
        "experiment_sha256": experiment_sha,
        "policy_snapshot": policy,
        "policy_snapshot_digest": policy["policy_snapshot_digest"],
        "visibility": "private_draft",
        "trust_label": "draft_unverified",
        "workflow_label": "workflow_policy_met" if endorsed else "workflow_policy_unmet",
        "admission_base_snapshot_revision": 1,
        "admission_base_project_event_digest": event1["event_digest"],
        "created_at": "2026-07-21T00:00:01.000Z",
    }
    admission["run_admission_digest"] = prefixed_digest(admission, field="run_admission_digest", prefix="ra_")
    request_digest = downstream_request_digest(
        project_id=PROJECT_ID,
        run_id=run_id,
        experiment_revision_id=experiment["experiment_revision_id"],
        experiment_sha256=experiment_sha,
        run_admission_digest=admission["run_admission_digest"],
        model_revision_id=active["model_revision_id"],
    )
    intent = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "run_intent_digest": "",
        "project_id": PROJECT_ID,
        "run_id": run_id,
        "command_id": "00000000-0000-4000-8000-000000000001",
        "command_digest": "cmd_" + "b" * 64,
        "downstream_idempotency_key": key,
        "downstream_request_digest": request_digest,
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": active["model_revision_id"],
        "brief_revision_id": brief["decision_brief_revision_id"],
        "alignment_revision_id": alignment["alignment_map_revision_id"],
        "experiment_revision_id": experiment["experiment_revision_id"],
        "experiment_sha256": experiment_sha,
        "policy_snapshot_digest": policy["policy_snapshot_digest"],
        "run_admission_digest": admission["run_admission_digest"],
        "created_at": "2026-07-21T00:00:02.000Z",
    }
    intent["run_intent_digest"] = prefixed_digest(intent, field="run_intent_digest", prefix="ri_")
    intent_dir = project / "run-intents" / run_id
    _write(intent_dir / "policy-snapshot.json", policy)
    _write(intent_dir / "admission.json", admission)
    _write(intent_dir / "intent.json", intent)
    run_ref = {
        "project_id": PROJECT_ID, "run_id": run_id, "model_id": "wind-turbine-maintenance",
        "model_revision_id": active["model_revision_id"], "brief_revision_id": experiment["brief_revision_id"],
        "alignment_revision_id": experiment["alignment_revision_id"], "experiment_revision_id": experiment["experiment_revision_id"],
        "preset_id": experiment["preset_id"], "seed": experiment["execution_values"]["seed"],
        "visibility": "private_draft", "trust_label": "draft_unverified", "workflow_label": admission["workflow_label"],
        "policy_snapshot_digest": policy["policy_snapshot_digest"], "run_admission_digest": admission["run_admission_digest"],
        "run_intent_digest": intent["run_intent_digest"], "reference_kind": "pending", "status": "dispatch_pending",
    }
    event2 = _append_project_event(workspace, event_type="run.intent_committed", refs=[
        {"kind": "policy_snapshot", "id": policy["policy_snapshot_digest"], "digest": policy["policy_snapshot_digest"]},
        {"kind": "run_admission", "id": admission["run_admission_digest"], "digest": admission["run_admission_digest"]},
        {"kind": "run_intent", "id": intent["run_intent_digest"], "digest": intent["run_intent_digest"]},
    ], changes={"phase": "run", "current": {**configured["current"], "run_id": run_id}, "run_index": [run_ref]})
    return {
        "active": active, "experiment": experiment, "admission": admission, "intent": intent,
        "request_digest": request_digest, "key": key, "run_id": run_id,
        "brief_id": brief["decision_brief_revision_id"], "alignment_id": alignment["alignment_map_revision_id"],
        "base_event": event1, "run_event": event2,
    }


def _prepare_framed(workspace: Path, *, run_id: str = RUN_ID, key: str = KEY, endorsed: bool = False) -> dict:
    from test_gate3_activation_root import _fixture as activation_ready_fixture

    fixture_workspace, experiment, _ = activation_ready_fixture(workspace.parent)
    assert fixture_workspace == workspace
    project = workspace / "projects" / PROJECT_ID
    active = json.loads((project / "models" / "active.json").read_text())
    brief_id = experiment["brief_revision_id"]
    alignment_id = experiment["alignment_revision_id"]
    experiment_bytes = canonical_json_v2_bytes(experiment) + b"\n"
    experiment_sha = hashlib.sha256(experiment_bytes).hexdigest()
    latest = json.loads(sorted((project / "project-events").glob("*.json"))[-1].read_text())

    alignment_policy = _subject(alignment_id, endorsed=endorsed)
    experiment_policy = _subject(experiment["experiment_revision_id"], endorsed=endorsed)
    effective_ids = sorted({
        ref["attestation_id"]
        for subject in (alignment_policy, experiment_policy)
        for ref in subject["effective_attestation_refs"]
    })
    policy = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "policy_snapshot_digest": "",
        "project_id": PROJECT_ID,
        "evaluated_at_snapshot_revision": latest["snapshot_revision"],
        "evaluated_project_event_digest": latest["event_digest"],
        "alignment": alignment_policy,
        "experiment": experiment_policy,
        "combined_policy_satisfied": endorsed,
        "effective_attestation_ids": effective_ids,
        "open_issue_ids": [],
    }
    policy["policy_snapshot_digest"] = prefixed_digest(policy, field="policy_snapshot_digest", prefix="ps_")
    admission = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "run_admission_digest": "",
        "project_id": PROJECT_ID,
        "run_id": run_id,
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": active["model_revision_id"],
        "brief_revision_id": brief_id,
        "alignment_revision_id": alignment_id,
        "experiment_revision_id": experiment["experiment_revision_id"],
        "experiment_sha256": experiment_sha,
        "policy_snapshot": policy,
        "policy_snapshot_digest": policy["policy_snapshot_digest"],
        "visibility": "private_draft",
        "trust_label": "draft_unverified",
        "workflow_label": "workflow_policy_met" if endorsed else "workflow_policy_unmet",
        "admission_base_snapshot_revision": latest["snapshot_revision"],
        "admission_base_project_event_digest": latest["event_digest"],
        "created_at": "2026-07-21T00:00:03.000Z",
    }
    admission["run_admission_digest"] = prefixed_digest(admission, field="run_admission_digest", prefix="ra_")
    request_digest = downstream_request_digest(
        project_id=PROJECT_ID,
        run_id=run_id,
        experiment_revision_id=experiment["experiment_revision_id"],
        experiment_sha256=experiment_sha,
        run_admission_digest=admission["run_admission_digest"],
        model_revision_id=active["model_revision_id"],
    )
    intent = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "run_intent_digest": "",
        "project_id": PROJECT_ID,
        "run_id": run_id,
        "command_id": "00000000-0000-4000-8000-000000000001",
        "command_digest": "cmd_" + "b" * 64,
        "downstream_idempotency_key": key,
        "downstream_request_digest": request_digest,
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": active["model_revision_id"],
        "brief_revision_id": brief_id,
        "alignment_revision_id": alignment_id,
        "experiment_revision_id": experiment["experiment_revision_id"],
        "experiment_sha256": experiment_sha,
        "policy_snapshot_digest": policy["policy_snapshot_digest"],
        "run_admission_digest": admission["run_admission_digest"],
        "created_at": "2026-07-21T00:00:04.000Z",
    }
    intent["run_intent_digest"] = prefixed_digest(intent, field="run_intent_digest", prefix="ri_")
    intent_dir = project / "run-intents" / run_id
    _write(intent_dir / "policy-snapshot.json", policy)
    _write(intent_dir / "admission.json", admission)
    _write(intent_dir / "intent.json", intent)
    prior = latest["state_patch"][0]["value"]
    run_ref = {
        "project_id": PROJECT_ID, "run_id": run_id, "model_id": "wind-turbine-maintenance",
        "model_revision_id": active["model_revision_id"], "brief_revision_id": brief_id,
        "alignment_revision_id": alignment_id, "experiment_revision_id": experiment["experiment_revision_id"],
        "preset_id": experiment["preset_id"], "seed": experiment["execution_values"]["seed"],
        "visibility": "private_draft", "trust_label": "draft_unverified",
        "workflow_label": admission["workflow_label"], "policy_snapshot_digest": policy["policy_snapshot_digest"],
        "run_admission_digest": admission["run_admission_digest"], "run_intent_digest": intent["run_intent_digest"],
        "reference_kind": "pending", "status": "dispatch_pending",
    }
    run_event = _append_project_event(
        workspace,
        event_type="run.intent_committed",
        refs=[
            {"kind": "policy_snapshot", "id": policy["policy_snapshot_digest"], "digest": policy["policy_snapshot_digest"]},
            {"kind": "run_admission", "id": admission["run_admission_digest"], "digest": admission["run_admission_digest"]},
            {"kind": "run_intent", "id": intent["run_intent_digest"], "digest": intent["run_intent_digest"]},
        ],
        changes={"phase": "run", "current": {**prior["current"], "run_id": run_id}, "run_index": [run_ref]},
    )
    return {
        "active": active, "experiment": experiment, "admission": admission, "intent": intent,
        "request_digest": request_digest, "key": key, "run_id": run_id,
        "brief_id": brief_id, "alignment_id": alignment_id, "base_event": latest, "run_event": run_event,
    }


_prepare = _prepare_framed


def _start(client: TestClient, prepared: dict):
    return client.post(
        f"/v2/projects/{PROJECT_ID}/runs",
        json={"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        headers={
            "Idempotency-Key": prepared["key"],
            "X-Riff-Run-Id": prepared["run_id"],
            "X-Riff-Request-Digest": prepared["request_digest"],
        },
    )


def _commit_cancel(workspace: Path, prepared: dict, *, commit_event: bool = True) -> dict:
    project = workspace / "projects" / PROJECT_ID
    latest = json.loads(sorted((project / "project-events").glob("*.json"))[-1].read_text())
    next_sequence = latest["snapshot_revision"] + 1
    tombstone = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "cancel_tombstone_digest": "",
        "project_id": PROJECT_ID,
        "run_id": prepared["run_id"],
        "cancel_command_id": f"00000000-0000-4000-8000-{next_sequence:012d}",
        "cancel_command_digest": "cmd_" + f"{next_sequence + 1:064x}",
        "requested_by_actor_id": ACTOR_ID,
        "requested_at_snapshot_revision": latest["snapshot_revision"],
        "created_at": "2026-07-21T00:00:05.000Z",
    }
    tombstone["cancel_tombstone_digest"] = prefixed_digest(tombstone, field="cancel_tombstone_digest", prefix="ct_")
    _write(project / "run-intents" / prepared["run_id"] / "cancel-tombstone.json", tombstone)
    if not commit_event:
        return tombstone
    runs = copy.deepcopy(latest["state_patch"][0]["value"].get("run_index", []))
    for run in runs:
        if run.get("run_id") == prepared["run_id"]:
            run["status"] = "cancellation_requested"
    _append_project_event(
        workspace,
        event_type="cancellation_requested",
        refs=[{
            "kind": "cancel_tombstone",
            "id": tombstone["cancel_tombstone_digest"],
            "digest": tombstone["cancel_tombstone_digest"],
        }],
        changes={"run_index": runs},
    )
    return tombstone


def _clone_run(workspace: Path, prepared: dict, *, run_id: str, key: str, endorsed: bool) -> dict:
    project = workspace / "projects" / PROJECT_ID
    experiment = prepared["experiment"]
    admission = copy.deepcopy(prepared["admission"])
    policy = copy.deepcopy(prepared["admission"]["policy_snapshot"])
    attestation_summaries = []
    attestation_refs: dict[str, dict] = {}
    attestation_record_refs = []
    if endorsed:
        for subject, digit in ((prepared["alignment_id"], "7"), (experiment["experiment_revision_id"], "8")):
            attestation_id = "att_" + digit * 32
            record = {
                "schema_version": 1, "canonical_json_version": "riff-canonical-json-v2",
                "attestation_id": attestation_id, "attestation_digest": "",
                "attestation_batch_id": "attb_" + "a" * 32, "project_id": PROJECT_ID,
                "actor_id": ACTOR_ID, "actor_type": "human", "declared_role": "project_owner",
                "identity_assurance": "declared_unauthenticated_local", "subject_revision_id": subject,
                "scope": "workflow_progression", "decision": "endorse", "rationale": "Reviewed",
                "issue_ids": [], "supersedes_attestation_id": None, "created_at": "2026-07-21T00:00:03.000Z",
            }
            record["attestation_digest"] = prefixed_digest(record, field="attestation_digest", prefix="atd_")
            _write(project / "attestations" / f"{attestation_id}.json", record)
            summary = {key: record[key] for key in (
                "attestation_id", "attestation_digest", "actor_id", "actor_type", "declared_role",
                "subject_revision_id", "scope", "decision", "supersedes_attestation_id",
            )}
            attestation_summaries.append(summary)
            attestation_refs[subject] = {key: record[key] for key in (
                "attestation_id", "attestation_digest", "actor_id", "actor_type", "declared_role", "scope", "decision",
            )}
            attestation_record_refs.append({"kind": "attestation", "id": attestation_id, "digest": record["attestation_digest"]})
        review_event = _append_project_event(
            workspace,
            event_type="attestation.batch_created",
            refs=attestation_record_refs,
            changes={"attestation_index": sorted(attestation_summaries, key=lambda item: item["attestation_id"])},
        )
    else:
        review_event = prepared["run_event"]
    policy["alignment"] = _subject(prepared["alignment_id"], endorsed=False)
    policy["experiment"] = _subject(experiment["experiment_revision_id"], endorsed=False)
    if endorsed:
        for item in (policy["alignment"], policy["experiment"]):
            ref = attestation_refs[item["subject_revision_id"]]
            item["effective_attestation_refs"] = [ref]
            item["human_project_owner_endorsement_attestation_ids"] = [ref["attestation_id"]]
            item["human_project_owner_endorsement_count"] = 1
            item["policy_satisfied"] = True
    policy["combined_policy_satisfied"] = endorsed
    policy["effective_attestation_ids"] = sorted({
        ref["attestation_id"]
        for subject in (policy["alignment"], policy["experiment"])
        for ref in subject["effective_attestation_refs"]
    })
    policy["evaluated_at_snapshot_revision"] = review_event["snapshot_revision"]
    policy["evaluated_project_event_digest"] = review_event["event_digest"]
    policy["policy_snapshot_digest"] = ""
    policy["policy_snapshot_digest"] = prefixed_digest(policy, field="policy_snapshot_digest", prefix="ps_")
    admission.update({
        "run_id": run_id,
        "policy_snapshot": policy,
        "policy_snapshot_digest": policy["policy_snapshot_digest"],
        "workflow_label": "workflow_policy_met" if endorsed else "workflow_policy_unmet",
        "admission_base_snapshot_revision": review_event["snapshot_revision"],
        "admission_base_project_event_digest": review_event["event_digest"],
        "run_admission_digest": "",
        "created_at": "2026-07-21T00:00:03.000Z",
    })
    admission["run_admission_digest"] = prefixed_digest(admission, field="run_admission_digest", prefix="ra_")
    request_digest = downstream_request_digest(
        project_id=PROJECT_ID,
        run_id=run_id,
        experiment_revision_id=experiment["experiment_revision_id"],
        experiment_sha256=admission["experiment_sha256"],
        run_admission_digest=admission["run_admission_digest"],
        model_revision_id=admission["model_revision_id"],
    )
    intent = copy.deepcopy(prepared["intent"])
    intent.update({
        "run_id": run_id,
        "downstream_idempotency_key": key,
        "downstream_request_digest": request_digest,
        "policy_snapshot_digest": policy["policy_snapshot_digest"],
        "run_admission_digest": admission["run_admission_digest"],
        "run_intent_digest": "",
        "created_at": "2026-07-21T00:00:04.000Z",
    })
    intent["run_intent_digest"] = prefixed_digest(intent, field="run_intent_digest", prefix="ri_")
    intent_dir = project / "run-intents" / run_id
    _write(intent_dir / "policy-snapshot.json", policy)
    _write(intent_dir / "admission.json", admission)
    _write(intent_dir / "intent.json", intent)
    previous_snapshot = json.loads(sorted((project / "project-events").glob("*.json"))[-1].read_text())["state_patch"][0]["value"]
    prior_runs = previous_snapshot.get("run_index", [])
    run_ref = {
        "project_id": PROJECT_ID, "run_id": run_id, "model_id": "wind-turbine-maintenance",
        "model_revision_id": experiment["model_revision_id"], "brief_revision_id": experiment["brief_revision_id"],
        "alignment_revision_id": experiment["alignment_revision_id"], "experiment_revision_id": experiment["experiment_revision_id"],
        "preset_id": experiment["preset_id"], "seed": experiment["execution_values"]["seed"],
        "visibility": "private_draft", "trust_label": "draft_unverified", "workflow_label": admission["workflow_label"],
        "policy_snapshot_digest": policy["policy_snapshot_digest"], "run_admission_digest": admission["run_admission_digest"],
        "run_intent_digest": intent["run_intent_digest"], "reference_kind": "pending", "status": "dispatch_pending",
    }
    run_event = _append_project_event(workspace, event_type="run.intent_committed", refs=[
        {"kind": "policy_snapshot", "id": policy["policy_snapshot_digest"], "digest": policy["policy_snapshot_digest"]},
        {"kind": "run_admission", "id": admission["run_admission_digest"], "digest": admission["run_admission_digest"]},
        {"kind": "run_intent", "id": intent["run_intent_digest"], "digest": intent["run_intent_digest"]},
    ], changes={"current": {**previous_snapshot["current"], "run_id": run_id}, "run_index": [*prior_runs, run_ref]})
    return {
        **prepared,
        "admission": admission,
        "intent": intent,
        "request_digest": request_digest,
        "key": key,
        "run_id": run_id,
        "run_event": run_event,
    }


def _terminal_status(records: list[dict]) -> str | None:
    if not records:
        return None
    return {
        "verified_succeeded": "succeeded",
        "terminal_failed": "failed",
        "terminal_timed_out": "timed_out",
        "terminal_cancelled": "cancelled",
    }.get(records[-1]["state"])


def _wait(client: TestClient, prepared: dict) -> dict:
    deadline = time.monotonic() + 190
    while time.monotonic() < deadline:
        response = client.get(f"/v2/projects/{PROJECT_ID}/run-receipts/{prepared['key']}")
        if response.status_code == 200:
            status = _terminal_status(response.json()["lifecycle_records"])
            if status is not None:
                return {"status": status, "evidence": response.json()}
        replay = _start(client, prepared)
        assert replay.status_code == 202, replay.text
        time.sleep(0.05)
    raise AssertionError("v2 run did not finish")


def _service_status(service: MesaService, run_id: str = RUN_ID) -> tuple[str | None, dict]:
    service.poll()
    evidence = service.get_wind_run_evidence_v2(PROJECT_ID, run_id)
    return _terminal_status(evidence["lifecycle_records"]), evidence


def _rewrite_lifecycle(events_dir: Path, records: list[dict]) -> None:
    for path in events_dir.glob("*.json"):
        path.unlink()
    previous = None
    for sequence, record in enumerate(records):
        record["sequence"] = sequence
        record["previous_mesa_lifecycle_digest"] = previous
        record["mesa_lifecycle_digest"] = ""
        record["mesa_lifecycle_digest"] = prefixed_digest(
            record, field="mesa_lifecycle_digest", prefix="mlr_",
        )
        _write(events_dir / f"{sequence:020d}.json", record)
        previous = record["mesa_lifecycle_digest"]


def test_canonical_v2_number_unicode_and_rejection_contract() -> None:
    assert canonical_json_v2_bytes({"b": 1.0, "a": -0.0, "x": 1e-6, "y": 1e-7}) == b'{"a":0,"b":1,"x":0.000001,"y":1e-7}'
    assert canonical_json_v2_bytes({"\ue000": 1, "\U00010000": 2}) == '{"𐀀":2,"":1}'.encode()
    assert canonical_json_v2_bytes({"nfc": "é", "nfd": "e\u0301"}) != canonical_json_v2_bytes({"nfc": "e\u0301", "nfd": "é"})
    with pytest.raises(CanonicalV2Error):
        strict_json_loads_v2('{"a":1,"a":2}')
    with pytest.raises(CanonicalV2Error):
        canonical_json_v2_bytes(float("nan"))
    with pytest.raises(CanonicalV2Error):
        canonical_json_v2_bytes("\ud800")
    golden = {
        "€": 1, "\r": 2, "דּ": 3, "1": 4, "😀": 5, "\u0080": 6, "ö": 7,
        "negative_zero": -0.0, "integral_float": 1.0, "threshold": 1e-7,
        "nfc": "é", "nfd": "e\u0301", "quote": "\\\"\n",
    }
    encoded = canonical_json_v2_bytes(golden)
    assert encoded.hex() == "7b225c72223a322c2231223a342c22696e74656772616c5f666c6f6174223a312c226e656761746976655f7a65726f223a302c226e6663223a22c3a9222c226e6664223a2265cc81222c2271756f7465223a225c5c5c225c6e222c227468726573686f6c64223a31652d372c22c280223a362c22c3b6223a372c22e282ac223a312c22f09f9880223a352c22efacb3223a337d"
    assert hashlib.sha256(encoded).hexdigest() == "da413b173e894cec0284f4401e3e86448b83d81efd38789392152380891df010"


def test_v2_bootstrap_rejects_unindexed_project(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    with TestClient(create_app(workspace)) as client:
        response = client.put(
            f"/v2/projects/{PROJECT_ID}/models/wind-turbine-maintenance",
            json={"preset_id": "wind-turbine-maintenance-demo-v1"},
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "project_not_indexed"


def test_v2_run_rejects_nonframed_active_before_receipt_or_worker(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    active = _materialize_wind_fixture(workspace, PROJECT_ID)
    app = create_app(workspace)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post(
            f"/v2/projects/{PROJECT_ID}/runs",
            json={"experiment_revision_id": active["experiment_revision_id"]},
            headers={
                "Idempotency-Key": KEY,
                "X-Riff-Run-Id": RUN_ID,
                "X-Riff-Request-Digest": "rq_" + "4" * 64,
            },
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "run_admission_mismatch"
        assert app.state.mesa_service.active_runs == {}

    project = workspace / "projects" / PROJECT_ID
    assert not (project / "mesa-run-receipts").exists()
    assert not (project / ".pending").exists()
    assert not (project / "runs").exists()


def test_v2_run_rejects_workspace_index_cache_event_mismatch(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    _write(workspace / "workspace.json", {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_ids": [],
        "corrupt_project_ids": [],
        "workspace_revision": 0,
    })
    with TestClient(create_app(workspace), raise_server_exceptions=False) as client:
        response = _start(client, prepared)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "run_admission_mismatch"


@pytest.mark.parametrize("layer", ["models", "experiments", "runs"])
def test_v2_nested_workspace_symlink_fails_closed_without_writing_outside(
    tmp_path: Path,
    layer: str,
) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    project = workspace / "projects" / PROJECT_ID
    outside = tmp_path / f"outside-{layer}"
    outside.mkdir()
    target = project / layer
    app = create_app(workspace)
    if target.exists():
        shutil.rmtree(target)
    target.symlink_to(outside, target_is_directory=True)

    with TestClient(app, raise_server_exceptions=False) as client:
        if layer == "runs":
            response = _start(client, prepared)
        else:
            response = client.put(
                f"/v2/projects/{PROJECT_ID}/models/wind-turbine-maintenance",
                json={"preset_id": "wind-turbine-maintenance-demo-v1"},
            )
        assert response.status_code in {400, 404, 409, 422, 500}, response.text

    assert list(outside.iterdir()) == []


@pytest.mark.parametrize("tamper", ["extra", "provenance", "digest", "patch", "refs"])
def test_v2_bootstrap_rejects_strict_event_zero_tamper(tmp_path: Path, tamper: str) -> None:
    workspace = tmp_path / "workspace"
    _prepare(workspace)
    event_path = workspace / "projects" / PROJECT_ID / "project-events" / "00000000000000000000.json"
    event = json.loads(event_path.read_text())
    if tamper == "extra":
        event["unexpected"] = True
    elif tamper == "provenance":
        event["initiator"] = "client"
        event["session_id"] = "session_" + "f" * 32
    elif tamper == "digest":
        event["event_digest"] = "pe_" + "0" * 64
    elif tamper == "patch":
        event["state_patch"] = [{"op": "add", "path": "/phase", "value": "brief"}]
    else:
        event["record_refs"] = []
    if tamper not in {"extra", "digest"}:
        event["event_digest"] = ""
        event["event_digest"] = prefixed_digest(event, field="event_digest", prefix="pe_")
    _write(event_path, event)
    with TestClient(create_app(workspace), raise_server_exceptions=False) as client:
        response = client.put(
            f"/v2/projects/{PROJECT_ID}/models/wind-turbine-maintenance",
            json={"preset_id": "wind-turbine-maintenance-demo-v1"},
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "project_not_indexed"


def test_committed_ref_cannot_forge_human_owner_policy_without_records(tmp_path: Path) -> None:
    from mesa_service.gate2_contracts import validate_policy_snapshot
    from mesa_service.gate2_project_evidence import ProjectEvidenceError, derive_policy_from_committed_events

    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    forged = copy.deepcopy(prepared["admission"]["policy_snapshot"])
    forged["alignment"] = _subject(prepared["alignment_id"], endorsed=True)
    forged["experiment"] = _subject(prepared["experiment"]["experiment_revision_id"], endorsed=True)
    forged["combined_policy_satisfied"] = True
    forged["effective_attestation_ids"] = sorted(
        ref["attestation_id"]
        for subject in (forged["alignment"], forged["experiment"])
        for ref in subject["effective_attestation_refs"]
    )
    forged["policy_snapshot_digest"] = ""
    forged["policy_snapshot_digest"] = prefixed_digest(forged, field="policy_snapshot_digest", prefix="ps_")
    validate_policy_snapshot(forged)
    event_path = (
        workspace / "projects" / PROJECT_ID / "project-events"
        / f"{prepared['run_event']['snapshot_revision']:020d}.json"
    )
    event = json.loads(event_path.read_text())
    event["record_refs"][0] = {
        "kind": "policy_snapshot", "id": forged["policy_snapshot_digest"], "digest": forged["policy_snapshot_digest"],
    }
    event["event_digest"] = ""
    event["event_digest"] = prefixed_digest(event, field="event_digest", prefix="pe_")
    _write(event_path, event)
    _write(workspace / "projects" / PROJECT_ID / "project.json", _snapshot(event))
    with pytest.raises(ProjectEvidenceError):
        derive_policy_from_committed_events(
            workspace, PROJECT_ID, forged,
            run_intent_digest=prepared["intent"]["run_intent_digest"],
            run_admission_digest=prepared["admission"]["run_admission_digest"],
        )


def test_v2_exact_admission_receipt_lifecycle_artifacts_and_duplicate(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    with TestClient(create_app(workspace, wind_timeout_seconds=180)) as client:
        first = _start(client, prepared)
        assert first.status_code == 202, first.text
        duplicate = _start(client, prepared)
        assert duplicate.status_code == 202, duplicate.text
        assert duplicate.json()["run_id"] == RUN_ID
        receipt_projection = client.get(f"/v2/projects/{PROJECT_ID}/run-receipts/{KEY}")
        assert receipt_projection.status_code == 200, receipt_projection.text
        assert receipt_projection.json()["receipt"]["run_id"] == RUN_ID
        terminal = _wait(client, prepared)
        assert terminal["status"] == "succeeded", terminal
        terminal_receipt = client.get(f"/v2/projects/{PROJECT_ID}/run-receipts/{KEY}")
        assert terminal_receipt.status_code == 200, terminal_receipt.text
        assert terminal_receipt.json()["latest_lifecycle"]["state"] == "verified_succeeded"
        assert terminal_receipt.json()["lifecycle_records"][-1] == terminal_receipt.json()["latest_lifecycle"]
        terminal_metadata = terminal_receipt.json()["terminal_metadata"]
        assert terminal_metadata["terminal_metadata_digest"] == terminal_receipt.json()["latest_lifecycle"]["evidence_digest"]
        assert terminal_metadata["terminal_metadata_kind"] == "framed_verified_success"
        assert terminal_metadata["metadata_core_projection"]["terminal_status"] == "succeeded"
        assert len(terminal_metadata["artifacts"]) == 8
        assert set(terminal_metadata["artifacts"]) == {
            "request.json", "metadata.json", "daily-kpis.csv", "domain-events.jsonl", "summary.json",
            "replay-manifest.json", "derived-views-manifest.json", "run.log",
        }
        evidence = client.get(f"/v2/projects/{PROJECT_ID}/runs/{RUN_ID}/evidence")
        assert evidence.status_code == 200, evidence.text
        assert evidence.json() == {
            "receipt": terminal_receipt.json()["receipt"],
            "lifecycle_records": terminal_receipt.json()["lifecycle_records"],
            "terminal_metadata": terminal_metadata,
            "cancel_outcome": None,
        }
    project = workspace / "projects" / PROJECT_ID
    receipts = list((project / "mesa-run-receipts").glob("*.json"))
    assert len(receipts) == 1
    lifecycle = sorted((project / "mesa-run-lifecycle" / RUN_ID / "events").glob("*.json"))
    states = [json.loads(path.read_text())["state"] for path in lifecycle]
    assert states[:5] == ["receipt_committed", "ownership_acquired", "temp_prepared", "spawn_intent", "worker_started"]
    assert states[-1] == "verified_succeeded"
    run = project / "runs" / RUN_ID
    assert {path.name for path in run.iterdir()} == {
        "request.json", "metadata.json", "daily-kpis.csv", "domain-events.jsonl", "summary.json",
        "replay-manifest.json", "derived-views-manifest.json", "run.log",
    }
    request = json.loads((run / "request.json").read_text())
    assert request["run_id"] == RUN_ID
    assert request["experiment_document"] == prepared["experiment"]
    assert request["run_admission"] == prepared["admission"]
    replay = json.loads((run / "replay-manifest.json").read_text())
    assert replay["schema_id"] == "riff://wind-turbine-maintenance/replay-manifest/framed/v1"
    assert replay["manifest_kind"] == "complete"
    assert replay["frame_count"] == len(replay["frames"]) > 0
    assert "frame_policy" not in replay
    from mesa_service.verify_run import RunVerificationError, verify_run

    assert verify_run(run)["valid"] is True
    for name in sorted(path.name for path in run.iterdir()):
        path = run / name
        original = path.read_bytes()
        path.write_bytes(original + b" ")
        with pytest.raises(RunVerificationError):
            verify_run(run)
        path.write_bytes(original)


@pytest.mark.parametrize("crash_point", ["after_receipt", "after_temp_prepared", "after_spawn_intent"])
def test_v2_crash_points_recover_one_receipt_one_worker_one_terminal(tmp_path: Path, crash_point: str) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    service = MesaService(workspace, wind_timeout_seconds=180, owner_lease_seconds=0.25)

    def crash(label: str) -> None:
        if label == crash_point:
            raise RuntimeError(f"injected {label}")

    service._gate2_fault_hook = crash  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="injected"):
        service.start_wind_run_v2(
            PROJECT_ID,
            {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
            downstream_key=prepared["key"],
            run_id=prepared["run_id"],
            downstream_digest=prepared["request_digest"],
        )
    assert not service.active_runs
    _write(workspace / "workspace.json", {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_ids": [PROJECT_ID],
        "corrupt_project_ids": [],
        "workspace_revision": 0,
    })
    with TestClient(create_app(workspace, wind_timeout_seconds=180, owner_lease_seconds=0.25)) as client:
        assert _wait(client, prepared)["status"] == "succeeded"
    project = workspace / "projects" / PROJECT_ID
    assert len(list((project / "mesa-run-receipts").glob("*.json"))) == 1
    lifecycle_records = [
        json.loads(path.read_text())
        for path in sorted((project / "mesa-run-lifecycle" / RUN_ID / "events").glob("*.json"))
    ]
    states = [record["state"] for record in lifecycle_records]
    assert states.count("receipt_committed") == 1
    assert states.count("worker_started") == 1
    assert states.count("verified_succeeded") == 1
    assert max(record["ownership_epoch"] for record in lifecycle_records) >= 2


@pytest.mark.parametrize("crash_point", ["after_process_spawn", "after_worker_started_before_barrier"])
def test_v2_spawn_window_crash_adopts_exactly_one_live_worker(tmp_path: Path, crash_point: str) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    crashed = MesaService(workspace, wind_timeout_seconds=180, owner_lease_seconds=0.25)

    def crash(label: str) -> None:
        if label == crash_point:
            raise RuntimeError(f"injected {label}")

    crashed._gate2_fault_hook = crash  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="injected"):
        crashed.start_wind_run_v2(
            PROJECT_ID,
            {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
            downstream_key=prepared["key"], run_id=prepared["run_id"],
            downstream_digest=prepared["request_digest"],
        )
    original = crashed.active_runs[RUN_ID]
    lease_path = workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "owner-lease.json"
    original_lease = json.loads(lease_path.read_text())
    try:
        with TestClient(create_app(workspace, wind_timeout_seconds=180, owner_lease_seconds=0.25)) as client:
            terminal = _wait(client, prepared)
            assert terminal["status"] == "succeeded", terminal
    finally:
        original.process.wait(timeout=5)
        crashed._close_log(original)
    events = [
        json.loads(path.read_text())
        for path in sorted((workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "events").glob("*.json"))
    ]
    assert len({event["child_identity"]["pid"] for event in events if event["state"] == "worker_started"}) == 1
    assert sum(event["state"] == "worker_started" for event in events) == 1
    assert sum(event["state"] == "verified_succeeded" for event in events) == 1
    recovered_lease = json.loads(lease_path.read_text())
    assert recovered_lease["original_started_at_unix_ms"] == original_lease["original_started_at_unix_ms"]
    assert recovered_lease["deadline_at_unix_ms"] == original_lease["deadline_at_unix_ms"]


def test_v2_second_owner_loss_readopts_same_live_worker_without_spawn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    first = MesaService(
        workspace, wind_timeout_seconds=180, owner_lease_seconds=0.2, worker_delay_seconds=0.02,
    )
    assert first.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "queued"
    original = first.active_runs[RUN_ID]
    time.sleep(0.25)
    second = MesaService(workspace, wind_timeout_seconds=180, owner_lease_seconds=0.2)
    assert second.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "running"
    second_active = second.active_runs[RUN_ID]
    assert second_active.process.pid == original.process.pid
    first.poll()
    assert not (workspace / "projects" / PROJECT_ID / "runs" / RUN_ID).exists()
    time.sleep(0.25)
    third = MesaService(workspace, wind_timeout_seconds=180, owner_lease_seconds=0.2)

    def duplicate_spawn_forbidden(**_: object) -> None:
        raise AssertionError("recovery attempted a duplicate worker spawn")

    monkeypatch.setattr(third, "_spawn", duplicate_spawn_forbidden)
    try:
        assert third.start_wind_run_v2(
            PROJECT_ID,
            {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
            downstream_key=prepared["key"], run_id=prepared["run_id"],
            downstream_digest=prepared["request_digest"],
        )["status"] == "running"
        assert third.active_runs[RUN_ID].process.pid == original.process.pid
        records = third.get_wind_run_evidence_v2(PROJECT_ID, RUN_ID)["lifecycle_records"]
        assert sum(record["state"] == "worker_started" for record in records) == 1
        assert sum(record["state"] == "ownership_acquired" for record in records) == 3
        assert records[-1]["state"] == "ownership_acquired"
        second.poll()
        assert not (workspace / "projects" / PROJECT_ID / "runs" / RUN_ID).exists()
    finally:
        third.shutdown()
        original.process.wait(timeout=5)
        first._close_log(original)
        second._close_log(second_active)


@pytest.mark.parametrize(
    ("terminal", "expected_status", "expected_state"),
    [("success", "succeeded", "verified_succeeded"), ("failure", "failed", "terminal_failed")],
)
def test_v2_second_owner_loss_converges_dead_worker_terminal_without_spawn(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    terminal: str,
    expected_status: str,
    expected_state: str,
) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    first = MesaService(
        workspace, wind_timeout_seconds=180, owner_lease_seconds=0.2, worker_delay_seconds=0.002,
    )
    assert first.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "queued"
    original = first.active_runs[RUN_ID]
    original_lease = json.loads((
        workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "owner-lease.json"
    ).read_text())
    time.sleep(0.25)
    second = MesaService(workspace, wind_timeout_seconds=180, owner_lease_seconds=0.2)
    assert second.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "running"
    assert second.active_runs[RUN_ID].process.pid == original.process.pid
    if terminal == "failure":
        os.killpg(original.process.pid, signal.SIGTERM)
    original.process.wait(timeout=30)
    time.sleep(0.25)
    third = MesaService(workspace, wind_timeout_seconds=180, owner_lease_seconds=0.2)

    def duplicate_spawn_forbidden(**_: object) -> None:
        raise AssertionError("recovery attempted a duplicate worker spawn")

    monkeypatch.setattr(third, "_spawn", duplicate_spawn_forbidden)
    try:
        result = third.start_wind_run_v2(
            PROJECT_ID,
            {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
            downstream_key=prepared["key"], run_id=prepared["run_id"],
            downstream_digest=prepared["request_digest"],
        )
        assert result["status"] == expected_status
        assert RUN_ID not in third.active_runs
        records = third.get_wind_run_evidence_v2(PROJECT_ID, RUN_ID)["lifecycle_records"]
        assert sum(record["state"] == "worker_started" for record in records) == 1
        assert records[-2]["state"] == "worker_exited"
        assert records[-1]["state"] == expected_state
        recovered_lease = json.loads((
            workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "owner-lease.json"
        ).read_text())
        assert recovered_lease["deadline_at_unix_ms"] == original_lease["deadline_at_unix_ms"]
        assert recovered_lease["expires_at_unix_ms"] <= recovered_lease["deadline_at_unix_ms"]
    finally:
        first._close_log(original)
        second._close_log(second.active_runs[RUN_ID])
        third.shutdown()


def test_v2_cancel_tombstone_before_spawn_never_starts_worker(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    _commit_cancel(workspace, prepared)
    with TestClient(create_app(workspace, wind_timeout_seconds=180)) as client:
        response = _start(client, prepared)
        assert response.status_code == 202, response.text
        assert response.json()["status"] == "cancelled"
        receipt_evidence = client.get(f"/v2/projects/{PROJECT_ID}/run-receipts/{KEY}").json()
        assert _terminal_status(receipt_evidence["lifecycle_records"]) == "cancelled"
        terminal = receipt_evidence["terminal_metadata"]
        assert terminal["cancel_outcome"] == "cancelled_before_dispatch"
    project = workspace / "projects" / PROJECT_ID
    states = [json.loads(path.read_text())["state"] for path in sorted((project / "mesa-run-lifecycle" / RUN_ID / "events").glob("*.json"))]
    assert "worker_started" not in states
    assert states[-2:] == ["cancel_requested", "terminal_cancelled"]
    assert {path.name for path in (project / "runs" / RUN_ID).iterdir()} == {"request.json", "metadata.json", "run.log"}


def test_v2_uncommitted_cancel_tombstone_cannot_signal_or_cancel(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    _commit_cancel(workspace, prepared, commit_event=False)
    with TestClient(create_app(workspace, wind_timeout_seconds=180), raise_server_exceptions=False) as client:
        response = _start(client, prepared)
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "cancel_tombstone_uncommitted"
    project = workspace / "projects" / PROJECT_ID
    assert not (project / "runs" / RUN_ID).exists()
    assert not (project / ".pending" / RUN_ID / "domain-events.jsonl").exists()


def test_v2_cancel_committed_after_barrier_without_rpc_is_projected_and_terminal(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    service = MesaService(workspace, wind_timeout_seconds=180, worker_delay_seconds=0.01)
    committed = False

    def commit_in_barrier_window(label: str) -> None:
        nonlocal committed
        if label == "after_worker_started" and not committed:
            _commit_cancel(workspace, prepared)
            committed = True

    service._gate2_fault_hook = commit_in_barrier_window  # type: ignore[method-assign]
    try:
        assert service.start_wind_run_v2(
            PROJECT_ID,
            {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
            downstream_key=prepared["key"], run_id=prepared["run_id"],
            downstream_digest=prepared["request_digest"],
        )["status"] == "queued"
        deadline = time.monotonic() + 10
        while RUN_ID in service.active_runs and time.monotonic() < deadline:
            service.poll()
            time.sleep(0.01)
        assert committed is True
        assert _service_status(service)[0] == "cancelled"
    finally:
        service.shutdown()
    records = [
        json.loads(path.read_text())
        for path in sorted((workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "events").glob("*.json"))
    ]
    assert [record["state"] for record in records][-4:] == [
        "worker_started", "cancel_requested", "worker_exited", "terminal_cancelled",
    ]
    cancel_record = next(record for record in records if record["state"] == "cancel_requested")
    tombstone = json.loads((
        workspace / "projects" / PROJECT_ID / "run-intents" / RUN_ID / "cancel-tombstone.json"
    ).read_text())
    assert cancel_record["evidence_digest"] == tombstone["cancel_tombstone_digest"]


@pytest.mark.parametrize("tamper", ["wrong_digest", "duplicate", "missing", "uncommitted"])
def test_v2_terminal_lifecycle_requires_exact_committed_cancel_binding(
    tmp_path: Path, tamper: str,
) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    _commit_cancel(workspace, prepared)
    service = MesaService(workspace, wind_timeout_seconds=180)
    assert service.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "cancelled"

    project = workspace / "projects" / PROJECT_ID
    events_dir = project / "mesa-run-lifecycle" / RUN_ID / "events"
    records = [json.loads(path.read_text()) for path in sorted(events_dir.glob("*.json"))]
    cancel_index = next(index for index, record in enumerate(records) if record["state"] == "cancel_requested")
    if tamper == "wrong_digest":
        records[cancel_index]["evidence_digest"] = "ct_" + "f" * 64
    elif tamper == "duplicate":
        records.insert(cancel_index + 1, copy.deepcopy(records[cancel_index]))
    elif tamper == "missing":
        records.pop(cancel_index)
    else:
        tombstone_path = project / "run-intents" / RUN_ID / "cancel-tombstone.json"
        tombstone = json.loads(tombstone_path.read_text())
        tombstone["created_at"] = "2026-07-21T00:00:06.000Z"
        tombstone["cancel_tombstone_digest"] = ""
        tombstone["cancel_tombstone_digest"] = prefixed_digest(
            tombstone, field="cancel_tombstone_digest", prefix="ct_",
        )
        _write(tombstone_path, tombstone)
        records[cancel_index]["evidence_digest"] = tombstone["cancel_tombstone_digest"]
    _rewrite_lifecycle(events_dir, records)

    with pytest.raises(ServiceError) as raised:
        service.get_wind_run_evidence_v2(PROJECT_ID, RUN_ID)
    assert raised.value.code == "mesa_run_corrupt"


def test_v2_restart_owner_projects_rpc_missed_committed_cancel(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    first = MesaService(
        workspace, wind_timeout_seconds=180, owner_lease_seconds=0.25, worker_delay_seconds=0.05,
    )
    first.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )
    original = first.active_runs[RUN_ID]
    model_execution_artifact = original.temporary_dir / "daily-kpis.csv"
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if model_execution_artifact.is_file():
            break
        time.sleep(0.01)
    else:
        raise AssertionError("worker did not pass its one-time pre-execution tombstone check")
    _commit_cancel(workspace, prepared)
    time.sleep(0.3)
    recovered = MesaService(
        workspace, wind_timeout_seconds=180, owner_lease_seconds=0.25, worker_delay_seconds=0.01,
    )
    try:
        deadline = time.monotonic() + 10
        while RUN_ID in recovered.active_runs and time.monotonic() < deadline:
            recovered.poll()
            time.sleep(0.01)
        assert _service_status(recovered)[0] == "cancelled"
    finally:
        original.process.wait(timeout=5)
        first._close_log(original)
        recovered.shutdown()
    records = [
        json.loads(path.read_text())
        for path in sorted((workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "events").glob("*.json"))
    ]
    assert sum(record["state"] == "cancel_requested" for record in records) == 1
    assert records[-1]["state"] == "terminal_cancelled"


def test_v2_dispatch_in_flight_committed_tombstone_stops_before_model_events(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    service = MesaService(workspace, wind_timeout_seconds=180)

    def commit_between_worker_started_and_barrier(label: str) -> None:
        if label == "after_worker_started_before_barrier":
            _commit_cancel(workspace, prepared)

    service._gate2_fault_hook = commit_between_worker_started_and_barrier  # type: ignore[method-assign]
    result = service.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )
    assert result["status"] == "queued"
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        status, terminal_evidence = _service_status(service)
        if status in {"cancelled", "failed"}:
            break
        time.sleep(0.02)
    else:
        raise AssertionError("dispatch-in-flight cancellation did not terminate")
    assert status == "cancelled"
    assert terminal_evidence["cancel_outcome"] == "cancelled_by_worker"
    assert terminal_evidence["terminal_metadata"]["cancel_outcome"] == "cancelled_by_worker"
    run = workspace / "projects" / PROJECT_ID / "runs" / RUN_ID
    assert {path.name for path in run.iterdir()} == {"request.json", "metadata.json", "run.log"}
    assert not (run / "domain-events.jsonl").exists()


@pytest.mark.parametrize(
    ("race", "expected_status", "expected_outcome"),
    [
        ("success", "succeeded", "completed_before_cancel_effect"),
        ("failure", "failed", "failed_before_cancel_effect"),
        ("timeout", "timed_out", "timed_out_before_cancel_effect"),
    ],
)
def test_v2_late_cancel_records_exact_quantitative_outcome(
    tmp_path: Path, race: str, expected_status: str, expected_outcome: str,
) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    timeout = 0.35 if race == "timeout" else 180
    delay = 0.05 if race in {"failure", "timeout"} else 0
    service = MesaService(
        workspace, wind_timeout_seconds=timeout, worker_delay_seconds=delay,
        owner_lease_seconds=10,
    )
    assert service.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "queued"
    active = service.active_runs[RUN_ID]
    if race == "success":
        active.process.wait(timeout=30)
        _commit_cancel(workspace, prepared)
    elif race == "failure":
        os.killpg(active.process.pid, signal.SIGTERM)
        active.process.wait(timeout=5)
        _commit_cancel(workspace, prepared)
    else:
        events_path = workspace / "projects" / PROJECT_ID / ".pending" / RUN_ID / "domain-events.jsonl"
        entry_deadline = time.monotonic() + 5
        while time.monotonic() < entry_deadline and (not events_path.exists() or events_path.stat().st_size == 0):
            time.sleep(0.01)
        _commit_cancel(workspace, prepared)
        time.sleep(0.4)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        status, evidence = _service_status(service)
        if status is not None:
            break
        time.sleep(0.02)
    else:
        raise AssertionError("late-cancel race did not terminate")
    assert status == expected_status
    assert evidence["cancel_outcome"] == expected_outcome
    assert any(record["state"] == "cancel_requested" for record in evidence["lifecycle_records"])
    if race == "success":
        assert evidence["lifecycle_records"][-1]["state"] == "verified_succeeded"
        assert evidence["terminal_metadata"]["terminal_metadata_kind"] == "framed_verified_success"
        assert evidence["terminal_metadata"]["metadata_core_projection"]["terminal_status"] == "succeeded"
    else:
        assert evidence["terminal_metadata"]["cancel_outcome"] == expected_outcome


@pytest.mark.parametrize("mode", ["digest", "identity"])
def test_v2_terminal_cancel_outcome_digest_and_identity_tamper_fail_closed(tmp_path: Path, mode: str) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    _commit_cancel(workspace, prepared)
    service = MesaService(workspace, wind_timeout_seconds=180)
    assert service.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "cancelled"
    project = workspace / "projects" / PROJECT_ID
    terminal_path = project / "mesa-run-lifecycle" / RUN_ID / "terminal-metadata.json"
    terminal = json.loads(terminal_path.read_text())
    terminal["cancel_outcome"] = "cancelled_by_worker"
    if mode == "identity":
        terminal["terminal_metadata_digest"] = ""
        terminal["terminal_metadata_digest"] = prefixed_digest(terminal, field="terminal_metadata_digest", prefix="tm_")
        event_path = sorted((project / "mesa-run-lifecycle" / RUN_ID / "events").glob("*.json"))[-1]
        event = json.loads(event_path.read_text())
        event["evidence_digest"] = terminal["terminal_metadata_digest"]
        event["mesa_lifecycle_digest"] = ""
        event["mesa_lifecycle_digest"] = prefixed_digest(event, field="mesa_lifecycle_digest", prefix="mlr_")
        _write(event_path, event)
    _write(terminal_path, terminal)
    with pytest.raises(ServiceError) as raised:
        service.get_wind_run_evidence_v2(PROJECT_ID, RUN_ID)
    assert raised.value.code == "mesa_run_corrupt"


def test_two_service_instances_duplicate_start_never_double_spawns(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    first = MesaService(workspace, wind_timeout_seconds=180, worker_delay_seconds=0.05)
    second = MesaService(workspace, wind_timeout_seconds=180, worker_delay_seconds=0.05)
    arguments = (
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
    )
    keywords = {
        "downstream_key": prepared["key"],
        "run_id": prepared["run_id"],
        "downstream_digest": prepared["request_digest"],
    }
    try:
        assert first.start_wind_run_v2(*arguments, **keywords)["status"] == "queued"
        assert second.start_wind_run_v2(*arguments, **keywords)["status"] == "running"
        assert not second.active_runs
        lease = json.loads((workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "owner-lease.json").read_text())
        assert lease["owner_instance_id"] == first.owner_instance_id
        _commit_cancel(workspace, prepared)
        assert first.cancel_wind_run_v2(PROJECT_ID, RUN_ID)["status"] == "cancelled"
    finally:
        first.shutdown()
        second.shutdown()
    states = [
        json.loads(path.read_text())["state"]
        for path in sorted((workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "events").glob("*.json"))
    ]
    assert states.count("worker_started") == 1
    assert states.count("terminal_cancelled") == 1


def test_owner_lease_short_timeout_caps_long_lease_and_converges_timeout(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    service = MesaService(
        workspace,
        wind_timeout_seconds=0.1,
        owner_lease_seconds=10,
        worker_delay_seconds=0.01,
    )
    result = service.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )
    assert result["status"] == "queued"
    lease_path = workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "owner-lease.json"
    lease = json.loads(lease_path.read_text())
    assert lease["renewed_at_unix_ms"] < lease["expires_at_unix_ms"] <= lease["deadline_at_unix_ms"]
    time.sleep(0.12)
    service.poll()
    evidence = service.get_wind_run_evidence_v2(PROJECT_ID, RUN_ID)
    assert _terminal_status(evidence["lifecycle_records"]) == "timed_out"
    assert sum(record["state"] == "worker_started" for record in evidence["lifecycle_records"]) == 1
    assert evidence["lifecycle_records"][-1]["state"] == "terminal_timed_out"
    service.shutdown()


def test_owner_lease_near_deadline_adopt_and_renew_stay_capped_without_duplicate_spawn(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    second = MesaService(workspace, wind_timeout_seconds=1.2, owner_lease_seconds=10)
    first = MesaService(
        workspace,
        wind_timeout_seconds=1.2,
        owner_lease_seconds=0.2,
        worker_delay_seconds=0.02,
    )
    assert first.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "queued"
    original = first.active_runs[RUN_ID]
    time.sleep(0.9)
    try:
        assert second.start_wind_run_v2(
            PROJECT_ID,
            {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
            downstream_key=prepared["key"], run_id=prepared["run_id"],
            downstream_digest=prepared["request_digest"],
        )["status"] == "running"
        adopted = second.active_runs[RUN_ID]
        assert adopted.process.pid == original.process.pid
        lease_path = workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "owner-lease.json"
        adopted_lease = json.loads(lease_path.read_text())
        assert adopted_lease["expires_at_unix_ms"] == adopted_lease["deadline_at_unix_ms"]
        second.poll()
        renewed = json.loads(lease_path.read_text())
        assert renewed["deadline_at_unix_ms"] == adopted_lease["deadline_at_unix_ms"]
        assert renewed["renewed_at_unix_ms"] < renewed["expires_at_unix_ms"] <= renewed["deadline_at_unix_ms"]
        first.poll()
        assert not (workspace / "projects" / PROJECT_ID / "runs" / RUN_ID).exists()
        records = second.get_wind_run_evidence_v2(PROJECT_ID, RUN_ID)["lifecycle_records"]
        assert sum(record["state"] == "worker_started" for record in records) == 1
    finally:
        remaining = (adopted_lease["deadline_at_unix_ms"] - int(time.time() * 1000)) / 1000
        if remaining > 0:
            time.sleep(remaining + 0.01)
        second.poll()
        second.shutdown()
        original.process.wait(timeout=5)
        first._close_log(original)


@pytest.mark.parametrize("tamper", ["expires_after_deadline", "deadline_drift", "deadline_missing"])
def test_owner_lease_tamper_fails_closed_without_spawn_or_promotion(tmp_path: Path, tamper: str) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    first = MesaService(workspace, wind_timeout_seconds=180, worker_delay_seconds=0.02)
    assert first.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "queued"
    original = first.active_runs[RUN_ID]
    lease_path = workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "owner-lease.json"
    original_bytes = lease_path.read_bytes()
    lease = json.loads(original_bytes)
    if tamper == "expires_after_deadline":
        lease["expires_at_unix_ms"] = lease["deadline_at_unix_ms"] + 1
    elif tamper == "deadline_drift":
        lease["deadline_at_unix_ms"] += 1_000
    else:
        lease.pop("deadline_at_unix_ms")
    lease["owner_lease_digest"] = ""
    lease["owner_lease_digest"] = prefixed_digest(lease, field="owner_lease_digest", prefix="mol_")
    _write(lease_path, lease)
    try:
        with pytest.raises(ServiceError) as raised:
            first.poll()
        assert raised.value.code == "mesa_run_corrupt"
        records = [
            json.loads(path.read_text())
            for path in sorted((
                workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "events"
            ).glob("*.json"))
        ]
        assert sum(record["state"] == "worker_started" for record in records) == 1
        assert not (workspace / "projects" / PROJECT_ID / "runs" / RUN_ID).exists()
    finally:
        lease_path.write_bytes(original_bytes)
        first.shutdown()
        original.process.wait(timeout=5)


def test_owner_lease_deadline_passed_fences_restore_then_original_owner_times_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    restoring = MesaService(workspace, wind_timeout_seconds=0.2, owner_lease_seconds=10)
    original = MesaService(
        workspace,
        wind_timeout_seconds=0.2,
        owner_lease_seconds=10,
        worker_delay_seconds=0.02,
    )
    assert original.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "queued"
    active = original.active_runs[RUN_ID]
    time.sleep(0.22)

    def duplicate_spawn_forbidden(**_: object) -> None:
        raise AssertionError("deadline-passed restore attempted a duplicate spawn")

    monkeypatch.setattr(restoring, "_spawn", duplicate_spawn_forbidden)
    with pytest.raises(ServiceError) as raised:
        restoring.start_wind_run_v2(
            PROJECT_ID,
            {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
            downstream_key=prepared["key"], run_id=prepared["run_id"],
            downstream_digest=prepared["request_digest"],
        )
    assert raised.value.code == "mesa_run_timed_out"
    original.poll()
    evidence = original.get_wind_run_evidence_v2(PROJECT_ID, RUN_ID)
    assert _terminal_status(evidence["lifecycle_records"]) == "timed_out"
    assert sum(record["state"] == "worker_started" for record in evidence["lifecycle_records"]) == 1
    assert restoring.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "timed_out"
    active.process.wait(timeout=5)
    original.shutdown()


def test_owner_claim_crash_before_lifecycle_replays_without_duplicate_spawn(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    crashed = MesaService(workspace, wind_timeout_seconds=180, owner_lease_seconds=0.2)
    first = MesaService(
        workspace, wind_timeout_seconds=180, owner_lease_seconds=0.2, worker_delay_seconds=0.02,
    )
    assert first.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "queued"
    original = first.active_runs[RUN_ID]
    time.sleep(0.25)

    def fail_after_claim(label: str) -> None:
        if label == "after_owner_lease_claim_before_lifecycle":
            raise RuntimeError("injected owner claim crash")

    crashed._gate2_fault_hook = fail_after_claim  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="owner claim crash"):
        crashed.start_wind_run_v2(
            PROJECT_ID,
            {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
            downstream_key=prepared["key"], run_id=prepared["run_id"],
            downstream_digest=prepared["request_digest"],
        )
    project = workspace / "projects" / PROJECT_ID
    before = [
        json.loads(path.read_text())
        for path in sorted((project / "mesa-run-lifecycle" / RUN_ID / "events").glob("*.json"))
    ]
    claimed = json.loads((project / "mesa-run-lifecycle" / RUN_ID / "owner-lease.json").read_text())
    assert before[-1]["state"] == "worker_started"
    assert claimed["ownership_epoch"] == before[-1]["ownership_epoch"] + 1
    assert sum(record["state"] == "worker_started" for record in before) == 1
    time.sleep(0.25)
    recovered = MesaService(workspace, wind_timeout_seconds=180, owner_lease_seconds=0.2)
    try:
        assert recovered.start_wind_run_v2(
            PROJECT_ID,
            {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
            downstream_key=prepared["key"], run_id=prepared["run_id"],
            downstream_digest=prepared["request_digest"],
        )["status"] == "running"
        assert recovered.active_runs[RUN_ID].process.pid == original.process.pid
        after = recovered.get_wind_run_evidence_v2(PROJECT_ID, RUN_ID)["lifecycle_records"]
        assert after[-1]["state"] == "ownership_acquired"
        assert after[-1]["ownership_epoch"] == claimed["ownership_epoch"]
        assert sum(record["state"] == "worker_started" for record in after) == 1
    finally:
        recovered.shutdown()
        original.process.wait(timeout=5)
        first._close_log(original)


def test_same_service_concurrent_duplicate_start_keeps_one_owner_epoch_and_barrier(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    service = MesaService(workspace, wind_timeout_seconds=180, worker_delay_seconds=0.05)
    arguments = (
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
    )
    keywords = {
        "downstream_key": prepared["key"],
        "run_id": prepared["run_id"],
        "downstream_digest": prepared["request_digest"],
    }
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(service.start_wind_run_v2, *arguments, **keywords) for _ in range(2)]
            results = [future.result(timeout=15) for future in futures]
        assert sorted(result["status"] for result in results) == ["queued", "running"]
        _commit_cancel(workspace, prepared)
        deadline = time.monotonic() + 10
        while RUN_ID in service.active_runs and time.monotonic() < deadline:
            service.poll()
            time.sleep(0.01)
        assert _service_status(service)[0] == "cancelled"
    finally:
        service.shutdown()
    records = [
        json.loads(path.read_text())
        for path in sorted((workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "events").glob("*.json"))
    ]
    assert [record["state"] for record in records].count("ownership_acquired") == 1
    assert [record["state"] for record in records].count("worker_started") == 1
    assert {record["ownership_epoch"] for record in records} == {1}


def test_v2_post_admission_source_drift_is_durable_terminal_without_worker(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    service = MesaService(workspace, wind_timeout_seconds=180)
    experiment_path = (
        workspace / "projects" / PROJECT_ID / "experiments" / "revisions"
        / prepared["experiment"]["experiment_revision_id"] / "experiment.json"
    )

    def mutate(label: str) -> None:
        if label == "after_spawn_intent":
            experiment_path.write_bytes(experiment_path.read_bytes() + b" ")

    service._gate2_fault_hook = mutate  # type: ignore[method-assign]
    result = service.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )
    assert result["status"] == "failed"
    assert not service.active_runs
    run = workspace / "projects" / PROJECT_ID / "runs" / RUN_ID
    metadata = json.loads((run / "metadata.json").read_text())
    assert metadata["error"]["code"] == "experiment_revision_drift"
    assert {path.name for path in run.iterdir()} == {"request.json", "metadata.json", "run.log"}
    states = [json.loads(path.read_text())["state"] for path in sorted((workspace / "projects" / PROJECT_ID / "mesa-run-lifecycle" / RUN_ID / "events").glob("*.json"))]
    assert "worker_started" not in states
    assert states[-1] == "terminal_failed"


def test_v2_terminal_replay_rejects_historical_policy_evidence_drift(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    service = MesaService(workspace, wind_timeout_seconds=180)
    actor_path = workspace / "projects" / PROJECT_ID / "actors" / f"{ACTOR_ID}.json"

    def drift_after_worker_release(label: str) -> None:
        if label == "after_worker_started":
            actor = json.loads(actor_path.read_text())
            actor["display_name"] = "tampered after admission"
            _write(actor_path, actor)

    service._gate2_fault_hook = drift_after_worker_release  # type: ignore[method-assign]
    assert service.start_wind_run_v2(
        PROJECT_ID,
        {"experiment_revision_id": prepared["experiment"]["experiment_revision_id"]},
        downstream_key=prepared["key"], run_id=prepared["run_id"],
        downstream_digest=prepared["request_digest"],
    )["status"] == "queued"
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        status, _ = _service_status(service)
        if status in {"failed", "succeeded"}:
            break
        time.sleep(0.02)
    else:
        raise AssertionError("drifted run did not terminate")
    assert status == "failed"
    metadata = json.loads((workspace / "projects" / PROJECT_ID / "runs" / RUN_ID / "metadata.json").read_text())
    assert metadata["error"]["code"] == "terminal_policy_evidence_drift"
    run = workspace / "projects" / PROJECT_ID / "runs" / RUN_ID
    assert {path.name for path in run.iterdir()} == {"request.json", "metadata.json", "run.log"}


def test_v2_embedded_admission_mutation_after_parent_capture_fails_worker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    original_spawn = MesaService._spawn

    def mutate_request(self, **kwargs):
        if kwargs.get("gate2_context") is not None:
            request_path = kwargs["temporary_dir"] / "request.json"
            request = json.loads(request_path.read_text())
            request["run_admission"]["workflow_label"] = "workflow_policy_met"
            request_path.write_bytes(canonical_json_v2_bytes(request))
        return original_spawn(self, **kwargs)

    monkeypatch.setattr(MesaService, "_spawn", mutate_request)
    with TestClient(create_app(workspace, wind_timeout_seconds=20), raise_server_exceptions=False) as client:
        response = _start(client, prepared)
        assert response.status_code == 202, response.text
        terminal = _wait(client, prepared)
        assert terminal["status"] == "failed"
    run = workspace / "projects" / PROJECT_ID / "runs" / RUN_ID
    assert {path.name for path in run.iterdir()} == {"request.json", "metadata.json", "run.log"}


@pytest.mark.parametrize("mutation", ["experiment", "admission", "mixed"])
def test_v2_drift_and_mixed_shapes_fail_before_domain_evidence(tmp_path: Path, mutation: str) -> None:
    workspace = tmp_path / "workspace"
    prepared = _prepare(workspace)
    project = workspace / "projects" / PROJECT_ID
    if mutation == "experiment":
        path = project / "experiments" / "revisions" / prepared["experiment"]["experiment_revision_id"] / "experiment.json"
        value = copy.deepcopy(prepared["experiment"])
        value["parameters"]["crew_count"] += 1
        _write(path, value)
    elif mutation == "admission":
        path = project / "run-intents" / RUN_ID / "admission.json"
        value = copy.deepcopy(prepared["admission"])
        value["workflow_label"] = "workflow_policy_met"
        _write(path, value)
    else:
        path = project / "experiments" / "revisions" / prepared["experiment"]["experiment_revision_id"] / "experiment.json"
        value = copy.deepcopy(prepared["experiment"])
        value["workflow_policy"] = "workflow_policy_unmet"
        _write(path, value)
    with TestClient(create_app(workspace), raise_server_exceptions=False) as client:
        response = _start(client, prepared)
        assert response.status_code in {409, 422}, response.text
    assert not (project / "runs" / RUN_ID).exists()
    assert not (project / ".pending" / RUN_ID / "domain-events.jsonl").exists()


def test_same_experiment_different_policy_has_same_behavioral_digests(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    first = _prepare(workspace, endorsed=False)
    second = _clone_run(
        workspace,
        first,
        run_id="run_" + "c" * 32,
        key="rk_" + "d" * 64,
        endorsed=True,
    )
    with TestClient(create_app(workspace, wind_timeout_seconds=180)) as client:
        assert _start(client, first).status_code == 202
        assert _wait(client, first)["status"] == "succeeded"
        assert _start(client, second).status_code == 202
        assert _wait(client, second)["status"] == "succeeded"
    first_dir = workspace / "projects" / PROJECT_ID / "runs" / first["run_id"]
    second_dir = workspace / "projects" / PROJECT_ID / "runs" / second["run_id"]
    first_metadata = json.loads((first_dir / "metadata.json").read_text())
    second_metadata = json.loads((second_dir / "metadata.json").read_text())
    first_core = first_metadata["metadata_core_projection"]
    second_core = second_metadata["metadata_core_projection"]
    assert first_core["workflow_label"] == "workflow_policy_unmet"
    assert second_core["workflow_label"] == "workflow_policy_met"
    assert first_core["policy_snapshot_digest"] != second_core["policy_snapshot_digest"]

    def behavioral_digests(run_dir: Path, runtime_profile: dict) -> tuple[str, str, str]:
        event_digest = hashlib.sha256()
        for line in (run_dir / "domain-events.jsonl").read_text().splitlines():
            event_digest.update(canonical_json_v2_bytes(
                _semantic_event_projection(json.loads(line), runtime_profile)
            ))
        summary = json.loads((run_dir / "summary.json").read_text())
        return (
            event_digest.hexdigest(),
            _daily_semantic_digest(run_dir / "daily-kpis.csv"),
            hashlib.sha256(canonical_json_v2_bytes(_semantic_without_run_context(summary))).hexdigest(),
        )

    assert behavioral_digests(first_dir, first_core["runtime_profile"]) == behavioral_digests(
        second_dir, second_core["runtime_profile"]
    )
    assert (first_dir / "request.json").read_bytes() != (second_dir / "request.json").read_bytes()
