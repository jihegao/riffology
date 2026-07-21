from __future__ import annotations

import base64
import copy
import hashlib
import json
import shutil
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mesa_service.app import create_app
from mesa_service.canonical_v2 import canonical_json_v2_bytes, prefixed_digest, require_canonical_json_v2_bytes, sha256_v2, strict_json_loads_v2
from mesa_service.gate2_contracts import build_v2_worker_request, defaults_digest, downstream_request_digest, validate_experiment_for_run
from mesa_service.gate3_bundle import FRAMED_FILES, framed_manifest, framed_revision_id, framed_runtime_profile, framed_source_bytes, materialize_framed_bundle
from mesa_service.bundle import manifest_entries, model_revision_id
from mesa_service.wind_contracts import MODEL_ID, canonical_json_bytes, runtime_profile
from mesa_service.gate3_contracts import sample_days, sample_days_sha256, validate_framed_parameter_sources
from mesa_service.gate3_activation import RUNTIME_FACT_KEYS
from mesa_service.gate2_project_evidence import ProjectEvidenceError, _read_revision
from mesa_service.service import MesaService, ServiceError
from mesa_service.verify_run import RunVerificationError, verify_run
from mesa_service.verify_bundle import BundleVerificationError, verify_bundle
from mesa_service.wind_contracts import load_json_asset
from mesa_service.wind_worker import _atomic_canonical_v2, execute, import_model, initial_metadata_v2


PROJECT = "project_" + "1" * 32
ACTOR = "actor_" + "2" * 32
BRIEF = "dbr_" + "3" * 64
ALIGNMENT = "amr_" + "4" * 64


def _subject(subject: str) -> dict:
    return {
        "subject_revision_id": subject,
        "effective_attestation_refs": [],
        "human_project_owner_endorsement_attestation_ids": [],
        "human_project_owner_endorsement_count": 0,
        "open_issue_refs": [], "open_issue_ids": [], "open_issue_count": 0,
        "open_blocking_issue_ids": [], "open_blocking_issue_count": 0,
        "open_non_blocking_issue_ids": [], "open_non_blocking_issue_count": 0,
        "policy_satisfied": False,
        "wording": "no_recorded_open_objection",
    }


def _request(*, turbine_count: int, crew_count: int, horizon: int, warmup: int, run_digit: str = "5") -> dict:
    preset = load_json_asset("defaults/wind-turbine-maintenance-demo-v1.json")
    defaults = copy.deepcopy(preset["parameters"])
    parameters = {**defaults, "turbine_count": turbine_count, "crew_count": crew_count}
    execution_defaults = {"horizon_days": 1095, "warmup_days": 365, "seed": 2}
    execution = {"horizon_days": horizon, "warmup_days": warmup, "seed": 2}
    experiment = {
        "schema_id": "riff://evidence-studio/experiment-revision/framed/v1",
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_id": PROJECT,
        "parent_experiment_revision_id": None,
        "operation": "create",
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": framed_manifest()["model_revision_id"],
        "brief_revision_id": BRIEF,
        "alignment_revision_id": ALIGNMENT,
        "preset_id": "wind-turbine-maintenance-demo-v1",
        "defaults_digest": defaults_digest("wind-turbine-maintenance-demo-v1", defaults, execution_defaults),
        "parameter_defaults": defaults,
        "parameters": parameters,
        "parameter_diff": [
            {"parameter_id": key, "default_value": defaults[key], "current_value": parameters[key]}
            for key in sorted(defaults) if defaults[key] != parameters[key]
        ],
        "execution_defaults": execution_defaults,
        "execution_values": execution,
        "execution_diff": [
            {"field": key, "default_value": execution_defaults[key], "current_value": execution[key]}
            for key in ("horizon_days", "warmup_days", "seed") if execution_defaults[key] != execution[key]
        ],
        "runtime_profile": framed_runtime_profile(),
        "copy_migration_rule": "framed_parameter_copy_revalidate_v1",
        "created_by_actor_id": ACTOR,
        "created_at": "2026-07-21T00:00:00.000Z",
    }
    experiment["experiment_revision_id"] = "er_" + hashlib.sha256(canonical_json_v2_bytes(experiment)).hexdigest()
    experiment["experiment_digest"] = "erd_" + hashlib.sha256(canonical_json_v2_bytes(experiment)).hexdigest()
    experiment_sha = hashlib.sha256(canonical_json_v2_bytes(experiment) + b"\n").hexdigest()
    policy = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "policy_snapshot_digest": "",
        "project_id": PROJECT,
        "evaluated_at_snapshot_revision": 1,
        "evaluated_project_event_digest": "pe_" + "6" * 64,
        "alignment": _subject(ALIGNMENT),
        "experiment": _subject(experiment["experiment_revision_id"]),
        "combined_policy_satisfied": False,
        "effective_attestation_ids": [],
        "open_issue_ids": [],
    }
    policy["policy_snapshot_digest"] = prefixed_digest(policy, field="policy_snapshot_digest", prefix="ps_")
    run_id = "run_" + run_digit * 32
    admission = {
        "schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "run_admission_digest": "",
        "project_id": PROJECT, "run_id": run_id, "model_id": "wind-turbine-maintenance",
        "model_revision_id": experiment["model_revision_id"], "brief_revision_id": BRIEF,
        "alignment_revision_id": ALIGNMENT, "experiment_revision_id": experiment["experiment_revision_id"],
        "experiment_sha256": experiment_sha, "policy_snapshot": policy, "policy_snapshot_digest": policy["policy_snapshot_digest"],
        "visibility": "private_draft", "trust_label": "draft_unverified", "workflow_label": "workflow_policy_unmet",
        "admission_base_snapshot_revision": 1, "admission_base_project_event_digest": "pe_" + "6" * 64,
        "created_at": "2026-07-21T00:00:01.000Z",
    }
    admission["run_admission_digest"] = prefixed_digest(admission, field="run_admission_digest", prefix="ra_")
    request_digest = downstream_request_digest(project_id=PROJECT, run_id=run_id, experiment_revision_id=experiment["experiment_revision_id"], experiment_sha256=experiment_sha, run_admission_digest=admission["run_admission_digest"], model_revision_id=experiment["model_revision_id"])
    intent = {
        "schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "run_intent_digest": "",
        "project_id": PROJECT, "run_id": run_id, "command_id": "00000000-0000-4000-8000-000000000001",
        "command_digest": "cmd_" + "7" * 64, "downstream_idempotency_key": "rk_" + "8" * 64,
        "downstream_request_digest": request_digest, "model_id": "wind-turbine-maintenance",
        "model_revision_id": experiment["model_revision_id"], "brief_revision_id": BRIEF,
        "alignment_revision_id": ALIGNMENT, "experiment_revision_id": experiment["experiment_revision_id"],
        "experiment_sha256": experiment_sha, "policy_snapshot_digest": policy["policy_snapshot_digest"],
        "run_admission_digest": admission["run_admission_digest"], "created_at": "2026-07-21T00:00:02.000Z",
    }
    intent["run_intent_digest"] = prefixed_digest(intent, field="run_intent_digest", prefix="ri_")
    return build_v2_worker_request(experiment=experiment, admission=admission, intent=intent)


def _run(tmp_path: Path, request: dict) -> Path:
    bundle = tmp_path / "bundle" / request["model_revision_id"]
    materialize_framed_bundle(bundle)
    output = tmp_path / "run"
    output.mkdir()
    request_path = output / "request.json"
    request_path.write_bytes(canonical_json_v2_bytes(request))
    _atomic_canonical_v2(output / "metadata.json", initial_metadata_v2(request))
    (output / "run.log").write_bytes(b"")
    execute(bundle / "model.py", request_path, output, expected_request_sha256=hashlib.sha256(request_path.read_bytes()).hexdigest(), expected_model_revision_id=request["model_revision_id"], expected_experiment_revision_id=request["experiment_revision_id"])
    (output / "run.log").write_bytes(b"wind-turbine-maintenance run succeeded\n")
    return output


def test_literal_legacy_and_framed_bundle_goldens_are_independent() -> None:
    fixture = json.loads((Path(__file__).parent / "goldens" / "gate3-bundle-goldens.json").read_text())
    legacy_files = manifest_entries()
    legacy_preimage = {"model_id": MODEL_ID, "runtime_profile": runtime_profile(), "files": legacy_files}
    legacy_revision = model_revision_id(legacy_files, runtime_profile())
    legacy_manifest = {"schema_version": 1, "model_id": MODEL_ID, "model_revision_id": legacy_revision, "runtime_profile": runtime_profile(), "files": legacy_files}
    assert canonical_json_bytes(legacy_preimage).decode() == fixture["legacy"]["revision_preimage_utf8"]
    assert legacy_revision == fixture["legacy"]["model_revision_id"] == "mr_d8a62ba22c547c82286f42460dccf80f31f1d224ac8fbe8367bacd470956eb11"
    assert (canonical_json_bytes(legacy_manifest) + b"\n").decode() == fixture["legacy"]["manifest_utf8"]
    framed = framed_manifest()
    framed_preimage = {key: framed[key] for key in ("schema_version", "bundle_protocol", "model_id", "runtime_profile", "files")}
    assert canonical_json_v2_bytes(framed_preimage).decode() == fixture["framed"]["revision_preimage_utf8"]
    assert framed_revision_id(framed["files"]) == fixture["framed"]["model_revision_id"]
    assert (canonical_json_v2_bytes(framed) + b"\n").decode() == fixture["framed"]["manifest_utf8"]
    for name, data in framed_source_bytes().items():
        if name.endswith(".json"):
            assert data.endswith(b"\n") and not data[:-1].endswith(b"\n")
            assert require_canonical_json_v2_bytes(data[:-1]) is not None


def test_framed_model_is_self_contained_and_temp_module_loading_is_clean(tmp_path: Path) -> None:
    bundle = tmp_path / framed_manifest()["model_revision_id"]
    materialize_framed_bundle(bundle)
    source = (bundle / "model.py").read_bytes()
    assert b"mesa_service." not in source and b"from mesa_service" not in source
    before = {name for name in sys.modules if name.startswith("riff_wind_turbine_reviewed_model_")}
    with ThreadPoolExecutor(max_workers=4) as pool:
        classes = list(pool.map(lambda _: import_model(bundle / "model.py", source_bytes=source), range(8)))
    assert all(item.__name__ == "WindTurbineMaintenanceModel" for item in classes)
    assert {name for name in sys.modules if name.startswith("riff_wind_turbine_reviewed_model_")} == before
    with pytest.raises(SyntaxError):
        import_model(bundle / "model.py", source_bytes=b"def broken(:\n")
    assert {name for name in sys.modules if name.startswith("riff_wind_turbine_reviewed_model_")} == before


def test_framed_bundle_rejects_pretty_json_even_when_manifest_hash_is_resealed(tmp_path: Path) -> None:
    bundle = tmp_path / framed_manifest()["model_revision_id"]
    materialize_framed_bundle(bundle)
    relative = "tests/microcase.json"
    target = bundle / relative
    pretty = json.dumps(json.loads(target.read_text()), indent=2, ensure_ascii=False).encode() + b"\n"
    target.write_bytes(pretty)
    manifest_path = bundle / "manifest.json"
    manifest = strict_json_loads_v2(manifest_path.read_bytes()[:-1])
    manifest["files"][relative]["byte_length"] = len(pretty)
    manifest["files"][relative]["sha256"] = hashlib.sha256(pretty).hexdigest()
    manifest_path.write_bytes(canonical_json_v2_bytes(manifest) + b"\n")
    with pytest.raises(BundleVerificationError, match="exact canonical-v2 plus one LF"):
        verify_bundle(bundle)


def test_sampling_golden_and_minimal_framed_run_binary_verifier(tmp_path: Path) -> None:
    days = sample_days(1095, 365)
    assert len(days) == 120
    assert sample_days_sha256(days) == "7a80f485f327f5b83c0d6810819dde4893e0aa55a1d20326b114fd8f99889841"
    output = _run(tmp_path, _request(turbine_count=3, crew_count=1, horizon=3, warmup=1))
    result = verify_run(output)
    assert result == {"valid": True, "branch": "framed", "run_id": "run_" + "5" * 32, "event_count": 4, "kpi_rows": 4, "frame_count": 4, "manifest_kind": "complete", "artifact_bytes": result["artifact_bytes"]}
    replay = strict_json_loads_v2((output / "replay-manifest.json").read_bytes()[:-1])
    assert replay["sample_days"] == [0, 1, 2, 3]
    assert all(frame["identity"] == replay["identity"] for frame in replay["frames"])
    assert [frame["through_event_sequence"] for frame in replay["frames"]] == [1, 2, 3, 4]
    assert sum(item["byte_length"] for item in replay["source_event_ranges"]) == (output / "domain-events.jsonl").stat().st_size


def test_frame_and_range_tampering_fail_closed(tmp_path: Path) -> None:
    output = _run(tmp_path, _request(turbine_count=3, crew_count=1, horizon=2, warmup=1))
    replay_path = output / "replay-manifest.json"
    replay = strict_json_loads_v2(replay_path.read_bytes()[:-1])
    replay["frames"][0]["turbines"][0]["x_km"] += 0.01
    replay_path.write_bytes(canonical_json_v2_bytes(replay) + b"\n")
    with pytest.raises(RunVerificationError, match="frame-state digest|artifact DAG edge"):
        verify_run(output)


@pytest.mark.parametrize("field,value", [
    ("event_count", 2), ("first_sequence", 2), ("last_sequence", 2),
])
def test_range_declarations_must_match_actual_event_terminals(tmp_path: Path, field: str, value: int) -> None:
    output = _run(tmp_path, _request(turbine_count=3, crew_count=1, horizon=2, warmup=1))
    path = output / "replay-manifest.json"
    replay = strict_json_loads_v2(path.read_bytes()[:-1])
    replay["source_event_ranges"][0][field] = value
    path.write_bytes(canonical_json_v2_bytes(replay) + b"\n")
    with pytest.raises(RunVerificationError, match="range|sequence"):
        verify_run(output)


def test_framed_verifier_rejects_mutation_of_each_artifact(tmp_path: Path) -> None:
    names = sorted({"request.json", "metadata.json", "summary.json", "daily-kpis.csv", "domain-events.jsonl", "replay-manifest.json", "derived-views-manifest.json", "run.log"})
    for index, name in enumerate(names):
        output = _run(tmp_path / str(index), _request(turbine_count=2, crew_count=1, horizon=1, warmup=0, run_digit=hex(index + 1)[2:]))
        path = output / name
        path.write_bytes(path.read_bytes() + b"X")
        with pytest.raises(RunVerificationError):
            verify_run(output)


def test_framed_verifier_rejects_garbage_kpi_and_undeclared_event(tmp_path: Path) -> None:
    kpi_output = _run(tmp_path / "kpi", _request(turbine_count=2, crew_count=1, horizon=1, warmup=0, run_digit="a"))
    kpi_path = kpi_output / "daily-kpis.csv"
    lines = kpi_path.read_text().splitlines()
    cells = lines[1].split(",")
    metric_index = lines[0].split(",").index("availability_fraction")
    cells[metric_index] = "garbage"
    kpi_path.write_text("\n".join([lines[0], ",".join(cells), *lines[2:]]) + "\n")
    with pytest.raises(RunVerificationError, match="metric|numeric|finite"):
        verify_run(kpi_output)

    event_output = _run(tmp_path / "event", _request(turbine_count=2, crew_count=1, horizon=1, warmup=0, run_digit="b"))
    events_path = event_output / "domain-events.jsonl"
    events = [json.loads(line) for line in events_path.read_text().splitlines()]
    events[0]["event_type"] = "undeclared_event"
    events_path.write_bytes(b"".join(canonical_json_v2_bytes(event) + b"\n" for event in events))
    with pytest.raises(RunVerificationError, match="event schema"):
        verify_run(event_output)


def test_population_limit_branch_is_explicit_and_empty(tmp_path: Path) -> None:
    output = _run(tmp_path, _request(turbine_count=101, crew_count=1, horizon=1, warmup=0, run_digit="9"))
    result = verify_run(output)
    assert result["manifest_kind"] == "unavailable_population_limit"
    replay = strict_json_loads_v2((output / "replay-manifest.json").read_bytes()[:-1])
    assert replay["sample_days"] == replay["frames"] == replay["source_event_ranges"] == []


def test_full_size_100_turbine_baseline_has_exact_complete_replay(tmp_path: Path) -> None:
    output = _run(tmp_path, _request(turbine_count=100, crew_count=3, horizon=1095, warmup=365))
    result = verify_run(output)
    replay = strict_json_loads_v2((output / "replay-manifest.json").read_bytes()[:-1])
    assert result["event_count"] == 38_730
    assert result["kpi_rows"] == 1_096
    assert result["frame_count"] == 120
    assert replay["sample_days_sha256"] == "7a80f485f327f5b83c0d6810819dde4893e0aa55a1d20326b114fd8f99889841"
    assert all(len(frame["turbines"]) == 100 and len(frame["crews"]) == 3 for frame in replay["frames"])
    assert (output / "replay-manifest.json").stat().st_size <= 4 * 1024 * 1024
    assert sum(path.stat().st_size for path in output.iterdir()) <= 304 * 1024 * 1024


def test_framed_http_reads_exact_artifact_set_and_events_from_metadata_projection(tmp_path: Path) -> None:
    request = _request(turbine_count=3, crew_count=1, horizon=2, warmup=1)
    output = _run(tmp_path / "source", request)
    workspace = tmp_path / "workspace"
    run_dir = workspace / "projects" / PROJECT / "runs" / request["run_id"]
    run_dir.parent.mkdir(parents=True)
    shutil.copytree(output, run_dir)

    with TestClient(create_app(workspace)) as client:
        for name in sorted({
            "request.json", "metadata.json", "daily-kpis.csv", "domain-events.jsonl",
            "summary.json", "replay-manifest.json", "derived-views-manifest.json", "run.log",
        }):
            response = client.get(f"/v1/projects/{PROJECT}/runs/{request['run_id']}/artifacts/{name}")
            assert response.status_code == 200
            assert response.content == (run_dir / name).read_bytes()
        assert client.get(
            f"/v1/projects/{PROJECT}/runs/{request['run_id']}/artifacts/timeseries.csv"
        ).status_code == 404

        expected_events = [json.loads(line) for line in (run_dir / "domain-events.jsonl").read_text().splitlines()]
        response = client.get(
            f"/v1/projects/{PROJECT}/runs/{request['run_id']}/events",
            params={"after": 0, "limit": 1000},
        )
        assert response.status_code == 200
        assert response.json() == {"events": expected_events, "next_after": expected_events[-1]["sequence"]}

        metadata_path = run_dir / "metadata.json"
        metadata = strict_json_loads_v2(metadata_path.read_bytes()[:-1])
        metadata["metadata_core_projection"]["undeclared"] = True
        metadata_path.write_bytes(canonical_json_v2_bytes(metadata) + b"\n")
        assert client.get(
            f"/v1/projects/{PROJECT}/runs/{request['run_id']}/artifacts/summary.json"
        ).status_code == 500
        assert client.get(
            f"/v1/projects/{PROJECT}/runs/{request['run_id']}/events"
        ).status_code == 500


def test_internal_byte_capture_is_bounded_exact_and_idempotent(tmp_path: Path) -> None:
    project = "capture_project"
    with TestClient(create_app(tmp_path / "workspace")) as client:
        active = client.put(f"/v1/projects/{project}/models/wind-turbine-maintenance", json={"preset_id": "wind-turbine-maintenance-demo-v1"}).json()
        handshake_headers = {"Accept": "application/json", "X-Riff-Internal-Protocol": "wind-runtime-handshake-v1"}
        descriptor = client.get(f"/internal/projects/{project}/wind/framed-candidate-descriptor/v1", headers=handshake_headers).json()
        activation_id = str(uuid.uuid4())
        request = {"schema_id": "riff://mesa-wind/materialize-candidate-request/v1", "schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "activation_id": activation_id, "project_id": project, "expected_old_model_revision_id": active["model_revision_id"], "candidate_descriptor_digest": descriptor["descriptor_digest"], "intent_digest": "aint_" + "a" * 64}
        headers = {"Content-Type": "application/json", "X-Riff-Internal-Protocol": "wind-activation-v1", "Idempotency-Key": activation_id}
        materialized = client.post("/internal/wind/framed-candidates/materialize", headers=headers, content=canonical_json_v2_bytes(request))
        assert materialized.status_code == 201
        receipt = materialized.json()
        capture_headers = {"Accept": "application/json", "X-Riff-Internal-Protocol": "wind-activation-v1", "Idempotency-Key": activation_id, "If-Match": f'"{receipt["candidate_receipt_digest"]}"'}
        route = f"/internal/projects/{project}/wind/framed-candidates/{activation_id}/byte-capture/v1"
        first = client.get(route, headers=capture_headers); second = client.get(route, headers=capture_headers)
        assert first.status_code == 200 and first.content == second.content and not first.content.endswith(b"\n")
        capture = strict_json_loads_v2(first.content)
        assert set(capture["files"]) == set(FRAMED_FILES)
        assert capture["capture_digest"] == prefixed_digest(capture, field="capture_digest", prefix="cap_")
        for blob in [capture["manifest"], *capture["files"].values()]:
            raw = base64.b64decode(blob["content_base64"], validate=True)
            assert blob["content_encoding"] == "base64-rfc4648" and len(raw) == blob["byte_length"]
            assert hashlib.sha256(raw).hexdigest() == blob["sha256"]
        for name, blob in capture["files"].items():
            if name.endswith(".json"):
                raw = base64.b64decode(blob["content_base64"], validate=True)
                assert raw.endswith(b"\n") and not raw[:-1].endswith(b"\n")
                assert require_canonical_json_v2_bytes(raw[:-1]) is not None
        stale = client.get(route, headers={**capture_headers, "If-Match": '"acand_' + "0" * 64 + '"'})
        assert stale.status_code == 409
        assert stale.json()["error"]["code"] == "candidate_receipt_mismatch"
        assert stale.headers["content-type"] == "application/json" and not stale.content.endswith(b"\n")


def test_internal_protocol_failure_matrix_and_materialize_idempotency(tmp_path: Path) -> None:
    project = "failure_matrix"
    with TestClient(create_app(tmp_path / "workspace")) as client:
        active = client.put(f"/v1/projects/{project}/models/wind-turbine-maintenance", json={"preset_id": "wind-turbine-maintenance-demo-v1"}).json()
        hh = {"Accept": "application/json", "X-Riff-Internal-Protocol": "wind-runtime-handshake-v1"}
        descriptor = client.get(f"/internal/projects/{project}/wind/framed-candidate-descriptor/v1", headers=hh).json()
        assert not (tmp_path / "workspace" / "projects" / project / "wind" / "candidates").exists()
        activation_id = str(uuid.uuid4())
        request = {"schema_id": "riff://mesa-wind/materialize-candidate-request/v1", "schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "activation_id": activation_id, "project_id": project, "expected_old_model_revision_id": active["model_revision_id"], "candidate_descriptor_digest": descriptor["descriptor_digest"], "intent_digest": "aint_" + "b" * 64}
        headers = {"Content-Type": "application/json", "X-Riff-Internal-Protocol": "wind-activation-v1", "Idempotency-Key": activation_id}
        first = client.post("/internal/wind/framed-candidates/materialize", headers=headers, content=canonical_json_v2_bytes(request))
        second = client.post("/internal/wind/framed-candidates/materialize", headers=headers, content=canonical_json_v2_bytes(request))
        assert first.status_code == 201 and second.status_code == 200 and first.json() == second.json()
        assert client.post("/internal/wind/framed-candidates/materialize", headers={**headers, "X-Riff-Internal-Protocol": "wrong"}, content=canonical_json_v2_bytes(request)).status_code == 422
        assert client.post("/internal/wind/framed-candidates/materialize?x=1", headers=headers, content=canonical_json_v2_bytes(request)).status_code == 422
        assert client.post("/internal/wind/framed-candidates/materialize", headers=headers, content=json.dumps(request, indent=2).encode()).status_code == 422
        conflicting = {**request, "intent_digest": "aint_" + "c" * 64}
        assert client.post("/internal/wind/framed-candidates/materialize", headers=headers, content=canonical_json_v2_bytes(conflicting)).status_code == 409
        receipt = first.json()
        byte_headers = {"Accept": "application/json", "X-Riff-Internal-Protocol": "wind-activation-v1", "Idempotency-Key": activation_id, "If-Match": f'"{receipt["candidate_receipt_digest"]}"'}
        assert client.get(f"/internal/projects/other/wind/framed-candidates/{activation_id}/byte-capture/v1", headers=byte_headers).status_code == 404
        model_path = tmp_path / "workspace" / "projects" / project / "wind" / "candidates" / activation_id / receipt["target_model_revision_id"] / "model.py"
        model_path.write_bytes(model_path.read_bytes() + b"\n")
        assert client.get(f"/internal/projects/{project}/wind/framed-candidates/{activation_id}/byte-capture/v1", headers=byte_headers).status_code == 409
        for response in (
            client.get("/internal/not-a-route"),
            client.put(f"/internal/wind/activations/{activation_id}/status"),
        ):
            assert response.status_code in {404, 405}
            assert response.headers["content-type"] == "application/json"
            assert not response.content.endswith(b"\n")
            assert set(strict_json_loads_v2(response.content)) == {"error"}


def test_resealed_candidate_records_cannot_replace_actual_framed_source_facts(tmp_path: Path) -> None:
    project = "resealed_candidate"
    workspace = tmp_path / "workspace"
    with TestClient(create_app(workspace)) as client:
        active = client.put(
            f"/v1/projects/{project}/models/wind-turbine-maintenance",
            json={"preset_id": "wind-turbine-maintenance-demo-v1"},
        ).json()
        handshake_headers = {
            "Accept": "application/json",
            "X-Riff-Internal-Protocol": "wind-runtime-handshake-v1",
        }
        descriptor = client.get(
            f"/internal/projects/{project}/wind/framed-candidate-descriptor/v1",
            headers=handshake_headers,
        ).json()
        activation_id = str(uuid.uuid4())
        request = {
            "schema_id": "riff://mesa-wind/materialize-candidate-request/v1",
            "schema_version": 1,
            "canonical_json_version": "riff-canonical-json-v2",
            "activation_id": activation_id,
            "project_id": project,
            "expected_old_model_revision_id": active["model_revision_id"],
            "candidate_descriptor_digest": descriptor["descriptor_digest"],
            "intent_digest": "aint_" + "c" * 64,
        }
        materialized = client.post(
            "/internal/wind/framed-candidates/materialize",
            headers={
                "Content-Type": "application/json",
                "X-Riff-Internal-Protocol": "wind-activation-v1",
                "Idempotency-Key": activation_id,
            },
            content=canonical_json_v2_bytes(request),
        )
        assert materialized.status_code == 201
        status_headers = {
            "Accept": "application/json",
            "X-Riff-Internal-Protocol": "wind-activation-v1",
            "Idempotency-Key": activation_id,
        }
        assert client.get(
            f"/internal/wind/activations/{activation_id}/status", headers=status_headers,
        ).json()["status"] == "candidate_ready"
        assert client.post(
            "/internal/wind/framed-candidates/materialize",
            headers={
                "Content-Type": "application/json",
                "X-Riff-Internal-Protocol": "wind-activation-v1",
                "Idempotency-Key": activation_id,
            },
            content=canonical_json_v2_bytes(request),
        ).status_code == 200
        store = client.app.state.mesa_service.gate3_activation
        original_runtime_instance_id = store.runtime_instance_id
        store.runtime_instance_id = "runtime_" + "e" * 32
        mismatched_instance = client.get(
            f"/internal/wind/activations/{activation_id}/status", headers=status_headers,
        )
        assert mismatched_instance.status_code == 500
        assert mismatched_instance.json()["error"]["message"] == (
            "stored candidate handshake does not bind actual runtime evidence"
        )
        store.runtime_instance_id = original_runtime_instance_id
        assert client.get(
            f"/internal/wind/activations/{activation_id}/status", headers=status_headers,
        ).status_code == 200

        candidate_root = workspace / "projects" / project / "wind" / "candidates" / activation_id
        descriptor_path = candidate_root / "candidate-descriptor.json"
        receipt_path = candidate_root / "candidate-receipt.json"
        handshake_path = candidate_root / "authoritative-handshake.json"
        authoritative = strict_json_loads_v2(handshake_path.read_bytes()[:-1])
        runtime_path = (
            workspace / "projects" / project / "wind" / "runtime-instances"
            / f"{authoritative['runtime_instance_id']}.json"
        )
        runtime_evidence = strict_json_loads_v2(runtime_path.read_bytes()[:-1])
        assert handshake_path.read_bytes().endswith(b"\n") and runtime_path.read_bytes().endswith(b"\n")
        assert authoritative["runtime_instance_evidence_digest"] == runtime_evidence["runtime_instance_evidence_digest"]
        assert authoritative["authoritative_handshake_digest"] == prefixed_digest(
            authoritative, field="authoritative_handshake_digest", prefix="ahe_",
        )
        stored_descriptor = strict_json_loads_v2(descriptor_path.read_bytes()[:-1])
        stored_receipt = strict_json_loads_v2(receipt_path.read_bytes()[:-1])
        pristine_descriptor = copy.deepcopy(stored_descriptor)
        pristine_receipt = copy.deepcopy(stored_receipt)
        original_descriptor = copy.deepcopy(stored_descriptor)
        original_receipt = copy.deepcopy(stored_receipt)
        stored_descriptor["manifest_sha256"] = "f" * 64
        stored_descriptor["descriptor_digest"] = prefixed_digest(
            stored_descriptor, field="descriptor_digest", prefix="cand_",
        )
        stored_receipt["manifest_sha256"] = "f" * 64
        stored_receipt["candidate_descriptor_digest"] = stored_descriptor["descriptor_digest"]
        stored_receipt["candidate_receipt_digest"] = prefixed_digest(
            stored_receipt, field="candidate_receipt_digest", prefix="acand_",
        )
        descriptor_path.write_bytes(canonical_json_v2_bytes(stored_descriptor) + b"\n")
        receipt_path.write_bytes(canonical_json_v2_bytes(stored_receipt) + b"\n")

        status = client.get(
            f"/internal/wind/activations/{activation_id}/status",
            headers=status_headers,
        )
        assert status.status_code == 500
        assert status.json()["error"] == {
            "code": "mesa_adapter_failure",
            "message": "stored candidate records do not bind the actual framed source",
            "details": {},
        }
        idempotent_retry = client.post(
            "/internal/wind/framed-candidates/materialize",
            headers={
                "Content-Type": "application/json",
                "X-Riff-Internal-Protocol": "wind-activation-v1",
                "Idempotency-Key": activation_id,
            },
            content=canonical_json_v2_bytes(request),
        )
        assert idempotent_retry.status_code == 500
        assert idempotent_retry.json()["error"]["code"] == "mesa_adapter_failure"

        original_descriptor["runtime_handshake_digest"] = "rh_" + "f" * 64
        original_descriptor["descriptor_digest"] = prefixed_digest(
            original_descriptor, field="descriptor_digest", prefix="cand_",
        )
        original_receipt["candidate_descriptor_digest"] = original_descriptor["descriptor_digest"]
        original_receipt["candidate_receipt_digest"] = prefixed_digest(
            original_receipt, field="candidate_receipt_digest", prefix="acand_",
        )
        descriptor_path.write_bytes(canonical_json_v2_bytes(original_descriptor) + b"\n")
        receipt_path.write_bytes(canonical_json_v2_bytes(original_receipt) + b"\n")
        assert client.get(
            f"/internal/wind/activations/{activation_id}/status", headers=status_headers,
        ).status_code == 500
        assert client.post(
            "/internal/wind/framed-candidates/materialize",
            headers={
                "Content-Type": "application/json",
                "X-Riff-Internal-Protocol": "wind-activation-v1",
                "Idempotency-Key": activation_id,
            },
            content=canonical_json_v2_bytes(request),
        ).status_code == 500

        descriptor_path.write_bytes(canonical_json_v2_bytes(pristine_descriptor) + b"\n")
        receipt_path.write_bytes(canonical_json_v2_bytes(pristine_receipt) + b"\n")
        request_path = candidate_root / "materialize-request.json"
        pristine_request = strict_json_loads_v2(request_path.read_bytes()[:-1])
        pristine_authoritative = copy.deepcopy(authoritative)

        forged_descriptor = copy.deepcopy(pristine_descriptor)
        forged_receipt = copy.deepcopy(pristine_receipt)
        forged_request = copy.deepcopy(pristine_request)
        forged_authoritative = copy.deepcopy(pristine_authoritative)
        forged_authoritative["runtime_instance_id"] = "runtime_" + "f" * 32
        forged_handshake = {
            "schema_id": "riff://mesa-wind/runtime-candidate-handshake/v1",
            "schema_version": 1,
            "canonical_json_version": "riff-canonical-json-v2",
            "project_id": project,
            "runtime_instance_id": forged_authoritative["runtime_instance_id"],
            **{key: forged_authoritative[key] for key in RUNTIME_FACT_KEYS},
            "active_model_revision_id": forged_authoritative["active_model_revision_id"],
            "handshake_digest": "",
        }
        forged_handshake["handshake_digest"] = prefixed_digest(
            forged_handshake, field="handshake_digest", prefix="rh_",
        )
        forged_authoritative["runtime_handshake_digest"] = forged_handshake["handshake_digest"]
        forged_descriptor["runtime_handshake_digest"] = forged_handshake["handshake_digest"]
        forged_descriptor["descriptor_digest"] = prefixed_digest(
            forged_descriptor, field="descriptor_digest", prefix="cand_",
        )
        forged_request["candidate_descriptor_digest"] = forged_descriptor["descriptor_digest"]
        forged_authoritative["candidate_descriptor_digest"] = forged_descriptor["descriptor_digest"]
        forged_authoritative["materialize_request_sha256"] = hashlib.sha256(
            canonical_json_v2_bytes(forged_request)
        ).hexdigest()
        forged_authoritative["authoritative_handshake_digest"] = prefixed_digest(
            forged_authoritative, field="authoritative_handshake_digest", prefix="ahe_",
        )
        forged_receipt["candidate_descriptor_digest"] = forged_descriptor["descriptor_digest"]
        forged_receipt["candidate_receipt_digest"] = prefixed_digest(
            forged_receipt, field="candidate_receipt_digest", prefix="acand_",
        )
        request_path.write_bytes(canonical_json_v2_bytes(forged_request) + b"\n")
        handshake_path.write_bytes(canonical_json_v2_bytes(forged_authoritative) + b"\n")
        descriptor_path.write_bytes(canonical_json_v2_bytes(forged_descriptor) + b"\n")
        receipt_path.write_bytes(canonical_json_v2_bytes(forged_receipt) + b"\n")
        for drift_response in (
            client.get(f"/internal/wind/activations/{activation_id}/status", headers=status_headers),
            client.get(f"/internal/wind/framed-candidates/{activation_id}", headers=status_headers),
            client.post(
                "/internal/wind/framed-candidates/materialize",
                headers={
                    "Content-Type": "application/json",
                    "X-Riff-Internal-Protocol": "wind-activation-v1",
                    "Idempotency-Key": activation_id,
                },
                content=canonical_json_v2_bytes(forged_request),
            ),
        ):
            assert drift_response.status_code == 500
            assert drift_response.json()["error"]["message"] == (
                "stored candidate handshake does not bind actual runtime evidence"
            )

        request_path.write_bytes(canonical_json_v2_bytes(pristine_request) + b"\n")
        handshake_path.write_bytes(canonical_json_v2_bytes(pristine_authoritative) + b"\n")
        descriptor_path.write_bytes(canonical_json_v2_bytes(pristine_descriptor) + b"\n")
        receipt_path.write_bytes(canonical_json_v2_bytes(pristine_receipt) + b"\n")
        stored_request = strict_json_loads_v2(request_path.read_bytes()[:-1])
        stored_request["undeclared"] = True
        request_path.write_bytes(canonical_json_v2_bytes(stored_request) + b"\n")
        invalid_request_status = client.get(
            f"/internal/wind/activations/{activation_id}/status", headers=status_headers,
        )
        assert invalid_request_status.status_code == 500
        assert invalid_request_status.json()["error"]["message"] == "stored materialize request is invalid"


def test_parameter_property_validation_is_type_driven_not_name_driven() -> None:
    root = Path(__file__).parents[1] / "src" / "mesa_service" / "model_assets"
    schema = json.loads((root / "wind_turbine_maintenance_framed" / "parameter-schema.json").read_text())
    preset = load_json_asset("defaults/wind-turbine-maintenance-demo-v1.json")
    assert validate_framed_parameter_sources(schema, preset)["major_replacement_enabled"] is True
    mutated_schema = copy.deepcopy(schema); mutated_preset = copy.deepcopy(preset)
    prop = mutated_schema["properties"]["repair_cost"]
    prop["type"] = "boolean"; prop.pop("minimum"); prop.pop("maximum")
    mutated_preset["parameters"]["repair_cost"] = False
    assert validate_framed_parameter_sources(mutated_schema, mutated_preset)["repair_cost"] is False
    for bad in ("3", 3.5, True):
        invalid = copy.deepcopy(preset)
        invalid["parameters"]["crew_count"] = bad
        with pytest.raises(ValueError, match="default is invalid"):
            validate_framed_parameter_sources(schema, invalid)
    unknown_type = copy.deepcopy(schema)
    unknown_type["properties"]["repair_cost"]["type"] = "string"
    with pytest.raises(ValueError, match="exact union"):
        validate_framed_parameter_sources(unknown_type, preset)


def test_experiment_schema_and_runtime_profile_must_match_model_branch() -> None:
    framed = copy.deepcopy(_request(turbine_count=2, crew_count=1, horizon=1, warmup=0)["experiment_document"])
    framed["runtime_profile"] = runtime_profile()
    framed.pop("experiment_digest")
    framed.pop("experiment_revision_id")
    framed["experiment_revision_id"] = "er_" + hashlib.sha256(canonical_json_v2_bytes(framed)).hexdigest()
    framed["experiment_digest"] = "erd_" + hashlib.sha256(canonical_json_v2_bytes(framed)).hexdigest()
    with pytest.raises(ValueError, match="branch|mixed|stale"):
        validate_experiment_for_run(framed)

    legacy = copy.deepcopy(_request(turbine_count=2, crew_count=1, horizon=1, warmup=0)["experiment_document"])
    legacy.pop("schema_id"); legacy.pop("copy_migration_rule"); legacy.pop("experiment_digest")
    legacy["schema_version"] = 2
    legacy["experiment_revision_id"] = ""
    legacy["runtime_profile"] = runtime_profile()
    legacy["experiment_revision_id"] = "er_" + hashlib.sha256(canonical_json_v2_bytes({key: value for key, value in legacy.items() if key != "experiment_revision_id"})).hexdigest()
    with pytest.raises(ValueError, match="legacy experiment schema cannot bind"):
        validate_experiment_for_run(legacy)


def test_framed_activation_records_require_one_lf_while_legacy_requires_none(tmp_path: Path) -> None:
    service = MesaService(tmp_path / "workspace")
    framed_experiment = _request(
        turbine_count=2, crew_count=1, horizon=1, warmup=0,
    )["experiment_document"]
    framed_path = service.workspace_root / "framed-experiment.json"
    framed_bytes = canonical_json_v2_bytes(framed_experiment)
    framed_path.write_bytes(framed_bytes + b"\n")
    value, captured = service._read_gate2_canonical(
        framed_path,
        validate_experiment_for_run,
        "experiment revision",
        framed_final_lf=True,
    )
    assert value == framed_experiment and captured == framed_bytes + b"\n"
    for invalid in (framed_bytes, framed_bytes + b"\n\n"):
        framed_path.write_bytes(invalid)
        with pytest.raises(ServiceError, match="exactly one LF"):
            service._read_gate2_canonical(
                framed_path,
                validate_experiment_for_run,
                "experiment revision",
                framed_final_lf=True,
            )

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
        "created_at": "2026-07-21T00:00:00.000Z",
        "decision_brief_revision_id": "",
        "decision_brief_digest": "",
    }
    brief_id_preimage = {
        key: nested for key, nested in brief.items()
        if key not in {"decision_brief_revision_id", "decision_brief_digest"}
    }
    brief["decision_brief_revision_id"] = "dbr_" + sha256_v2(brief_id_preimage)
    brief["decision_brief_digest"] = "dbrd_" + sha256_v2({
        key: nested for key, nested in brief.items() if key != "decision_brief_digest"
    })
    alignment = {
        "schema_id": "riff://evidence-studio/alignment-map/framed/v1",
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_id": PROJECT,
        "parent_alignment_revision_id": None,
        "brief_revision_id": brief["decision_brief_revision_id"],
        "model_revision_id": framed_manifest()["model_revision_id"],
        "migration_rule": "framed_alignment_rebind_v1",
        "mappings": [],
        "gaps": [],
        "source_refs": [],
        "created_by_actor_id": ACTOR,
        "created_at": "2026-07-21T00:00:00.000Z",
        "alignment_revision_id": "",
        "alignment_digest": "",
    }
    alignment_id_preimage = {
        key: nested for key, nested in alignment.items()
        if key not in {"alignment_revision_id", "alignment_digest"}
    }
    alignment["alignment_revision_id"] = "amr_" + sha256_v2(alignment_id_preimage)
    alignment["alignment_digest"] = "amd_" + sha256_v2({
        key: nested for key, nested in alignment.items() if key != "alignment_digest"
    })
    lineage_cases = (
        (brief, "decision_brief_revision_id", "dbr_", "decision_brief_digest", "dbrd_"),
        (alignment, "alignment_revision_id", "amr_", "alignment_digest", "amd_"),
    )
    for index, (record, id_field, id_prefix, digest_field, digest_prefix) in enumerate(lineage_cases):
        path = service.workspace_root / f"lineage-{index}.json"
        encoded = canonical_json_v2_bytes(record)
        path.write_bytes(encoded + b"\n")
        assert service._read_framed_activation_lineage(
            path,
            keys=set(record),
            id_field=id_field,
            id_prefix=id_prefix,
            digest_field=digest_field,
            digest_prefix=digest_prefix,
        ) == record
        path.write_bytes(encoded)
        with pytest.raises(ServiceError, match="bytes are invalid"):
            service._read_framed_activation_lineage(
                path,
                keys=set(record),
                id_field=id_field,
                id_prefix=id_prefix,
                digest_field=digest_field,
                digest_prefix=digest_prefix,
            )

    for index, record in enumerate((brief, alignment, framed_experiment)):
        path = service.workspace_root / f"committed-framed-revision-{index}.json"
        encoded = canonical_json_v2_bytes(record)
        path.write_bytes(encoded + b"\n")
        assert _read_revision(path) == record
        path.write_bytes(encoded)
        with pytest.raises(ProjectEvidenceError, match="framed committed revision encoding"):
            _read_revision(path)

    legacy_revision = {"schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "legacy": True}
    legacy_revision_path = service.workspace_root / "committed-legacy-revision.json"
    legacy_revision_bytes = canonical_json_v2_bytes(legacy_revision)
    legacy_revision_path.write_bytes(legacy_revision_bytes)
    assert _read_revision(legacy_revision_path) == legacy_revision
    legacy_revision_path.write_bytes(legacy_revision_bytes + b"\n")
    with pytest.raises(ProjectEvidenceError, match="legacy committed revision encoding"):
        _read_revision(legacy_revision_path)

    legacy_workspace = tmp_path / "legacy-workspace"
    legacy_app = create_app(legacy_workspace)
    with TestClient(legacy_app) as client:
        active = client.put(
            "/v1/projects/legacy_encoding/models/wind-turbine-maintenance",
            json={"preset_id": "wind-turbine-maintenance-demo-v1"},
        ).json()
    legacy = copy.deepcopy(framed_experiment)
    legacy.pop("schema_id")
    legacy.pop("copy_migration_rule")
    legacy.pop("experiment_digest")
    legacy["schema_version"] = 2
    legacy["model_revision_id"] = active["model_revision_id"]
    legacy["runtime_profile"] = runtime_profile()
    legacy["experiment_revision_id"] = ""
    legacy["experiment_revision_id"] = "er_" + sha256_v2({
        key: nested for key, nested in legacy.items() if key != "experiment_revision_id"
    })
    legacy_path = legacy_app.state.mesa_service.workspace_root / "legacy-experiment.json"
    legacy_bytes = canonical_json_v2_bytes(legacy)
    legacy_path.write_bytes(legacy_bytes)
    legacy_value, captured = legacy_app.state.mesa_service._read_gate2_canonical(
        legacy_path, validate_experiment_for_run, "experiment revision",
    )
    assert legacy_value == legacy
    assert captured == legacy_bytes and not legacy_bytes.endswith(b"\n")
    legacy_path.write_bytes(legacy_bytes + b"\n")
    with pytest.raises(ServiceError, match="record bytes are not exact"):
        legacy_app.state.mesa_service._read_gate2_canonical(
            legacy_path, validate_experiment_for_run, "experiment revision",
        )


def test_receipt_first_cas_recovers_in_instance_and_restart_rejects_old_candidate_authority(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    project = "cas_recovery"
    app = create_app(workspace)
    with TestClient(app) as client:
        active = client.put(f"/v1/projects/{project}/models/wind-turbine-maintenance", json={"preset_id": "wind-turbine-maintenance-demo-v1"}).json()
        hh = {"Accept": "application/json", "X-Riff-Internal-Protocol": "wind-runtime-handshake-v1"}
        descriptor = client.get(f"/internal/projects/{project}/wind/framed-candidate-descriptor/v1", headers=hh).json()
        activation_id = str(uuid.uuid4())
        materialize_request = {"schema_id": "riff://mesa-wind/materialize-candidate-request/v1", "schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "activation_id": activation_id, "project_id": project, "expected_old_model_revision_id": active["model_revision_id"], "candidate_descriptor_digest": descriptor["descriptor_digest"], "intent_digest": "aint_" + "d" * 64}
        _, receipt = app.state.mesa_service.gate3_activation.materialize(materialize_request, activation_id)
        cas_request = {"schema_id": "riff://mesa-wind/active-cas-request/v1", "schema_version": 1, "canonical_json_version": "riff-canonical-json-v2", "activation_id": activation_id, "project_id": project, "expected_old_model_revision_id": active["model_revision_id"], "target_model_revision_id": receipt["target_model_revision_id"], "candidate_receipt_digest": receipt["candidate_receipt_digest"], "project_event_digest": "pe_" + "e" * 64}
        app.state.mesa_service._gate3_fault_hook = lambda stage: (_ for _ in ()).throw(RuntimeError(stage))
        with pytest.raises(RuntimeError, match="after_switch_receipt"):
            app.state.mesa_service.gate3_activation.cas(cas_request, activation_id, f'"{active["model_revision_id"]}"')
        app.state.mesa_service._gate3_fault_hook = lambda _stage: None
        in_instance = app.state.mesa_service.gate3_activation.cas(
            cas_request, activation_id, f'"{active["model_revision_id"]}"',
        )
        assert in_instance["active_model_revision_id"] == receipt["target_model_revision_id"]
    recovered = MesaService(workspace)
    assert recovered.gate3_activation._active_revision(project) == receipt["target_model_revision_id"]
    with pytest.raises(Exception, match="actual runtime evidence"):
        recovered.gate3_activation.status(project, activation_id)
    with pytest.raises(Exception, match="actual runtime evidence"):
        recovered.gate3_activation.materialize(materialize_request, activation_id)
    switch_path = workspace / "projects" / project / "wind" / "switch-receipts" / f"{activation_id}.json"
    corrupted = strict_json_loads_v2(switch_path.read_bytes()[:-1])
    corrupted["unexpected"] = True
    switch_path.write_bytes(canonical_json_v2_bytes(corrupted) + b"\n")
    with pytest.raises(Exception, match="keyset"):
        MesaService(workspace)


def test_framed_terminal_record_closes_one_way_dag(tmp_path: Path) -> None:
    request = _request(turbine_count=3, crew_count=1, horizon=2, warmup=1)
    source = _run(tmp_path / "source", request)
    service = MesaService(tmp_path / "service")
    project = service._project_dir(PROJECT, create=True)
    run_dir = project / "runs" / request["run_id"]
    run_dir.parent.mkdir(parents=True)
    shutil.copytree(source, run_dir)
    receipt = {"project_id": PROJECT, "run_id": request["run_id"]}
    terminal = service._gate2_terminal_metadata(project_dir=project, receipt=receipt, status="succeeded", run_dir=run_dir)
    assert terminal["terminal_metadata_kind"] == "framed_verified_success"
    assert set(terminal["artifacts"]) == {path.name for path in run_dir.iterdir()}
    assert service._gate2_terminal_metadata(project_dir=project, receipt=receipt, status="succeeded", run_dir=run_dir) == terminal
    record = service._read_gate2_terminal_metadata(project, receipt, [{"state": "verified_succeeded", "evidence_digest": terminal["terminal_metadata_digest"]}])
    assert record == terminal
