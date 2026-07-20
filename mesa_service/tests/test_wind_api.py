from __future__ import annotations

import csv
import io
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mesa_service.app import create_app


PRESET_ID = "wind-turbine-maintenance-demo-v1"
ARTIFACTS = {
    "request.json",
    "metadata.json",
    "daily-kpis.csv",
    "domain-events.jsonl",
    "summary.json",
    "replay-manifest.json",
    "derived-views-manifest.json",
    "run.log",
}
CLAIM_LABELS = {
    "synthetic_inputs",
    "single_seed",
    "behavioral_reproduction_not_runtime_equivalence",
    "draft_unverified",
    "no_staffing_recommendation",
}


@pytest.fixture
def client(tmp_path: Path):
    with TestClient(create_app(tmp_path / "workspace", timeout_seconds=180)) as test_client:
        yield test_client


def _load(client: TestClient, project_id: str = "wind_api") -> dict:
    response = client.put(
        f"/v1/projects/{project_id}/models/wind-turbine-maintenance",
        json={"preset_id": PRESET_ID},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _wait(client: TestClient, project_id: str, run_id: str, timeout: float = 190) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/v1/projects/{project_id}/runs/{run_id}")
        assert response.status_code == 200, response.text
        payload = response.json()
        if payload["status"] in {"succeeded", "failed", "cancelled", "timed_out"}:
            return payload
        time.sleep(0.05)
    raise AssertionError("wind run did not reach a terminal state")


def test_wind_load_active_and_run_requests_have_disjoint_strict_schemas(client: TestClient) -> None:
    loaded = _load(client)
    assert loaded["model_id"] == "wind-turbine-maintenance"
    assert loaded["model_revision_id"].startswith("mr_")
    assert loaded["experiment_revision_id"].startswith("er_")
    active = client.get("/v1/projects/wind_api/models/active")
    assert active.status_code == 200
    assert active.json() == loaded

    assert client.put(
        "/v1/projects/extra/models/wind-turbine-maintenance",
        json={"preset_id": PRESET_ID, "extra": True},
    ).status_code == 422
    assert client.put(
        "/v1/projects/unknown/models/wind-turbine-maintenance",
        json={"preset_id": "unknown"},
    ).status_code == 422
    for invalid in (
        {"experiment_revision_id": loaded["experiment_revision_id"], "seed": 2},
        {"model_revision": loaded["model_revision_id"], "steps": 4, "seeds": [2], "parameters": {}},
        {},
    ):
        assert client.post("/v1/projects/wind_api/runs", json=invalid).status_code == 422
    stale = client.post("/v1/projects/wind_api/runs", json={"experiment_revision_id": "er_" + "0" * 64})
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "experiment_revision_not_active"


def test_success_artifacts_identity_nonclaims_and_event_pagination(client: TestClient) -> None:
    project_id = "wind_evidence"
    loaded = _load(client, project_id)
    started = client.post(
        f"/v1/projects/{project_id}/runs",
        json={"experiment_revision_id": loaded["experiment_revision_id"]},
    )
    assert started.status_code == 202, started.text
    run_id = started.json()["run_id"]
    terminal = _wait(client, project_id, run_id)
    assert terminal["status"] == "succeeded", terminal
    assert terminal["model_revision_id"] == loaded["model_revision_id"]
    assert terminal["experiment_revision_id"] == loaded["experiment_revision_id"]

    bodies: dict[str, bytes] = {}
    for name in ARTIFACTS:
        response = client.get(f"/v1/projects/{project_id}/runs/{run_id}/artifacts/{name}")
        assert response.status_code == 200, (name, response.text)
        bodies[name] = response.content
    assert client.get(f"/v1/projects/{project_id}/runs/{run_id}/artifacts/not-declared.json").status_code == 404
    assert client.get(f"/v1/projects/{project_id}/runs/{run_id}/artifacts/%2e%2e%2fmetadata.json").status_code in {400, 404}

    request = json.loads(bodies["request.json"])
    metadata = json.loads(bodies["metadata.json"])
    summary = json.loads(bodies["summary.json"])
    replay = json.loads(bodies["replay-manifest.json"])
    derived = json.loads(bodies["derived-views-manifest.json"])
    identity = {
        "project_id": project_id,
        "run_id": run_id,
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": loaded["model_revision_id"],
        "experiment_revision_id": loaded["experiment_revision_id"],
        "preset_id": PRESET_ID,
        "seed": 2,
    }
    for document in (request, metadata, summary, replay, derived):
        assert {key: document[key] for key in identity} == identity
    assert set(metadata["claim_labels"]) == CLAIM_LABELS
    assert set(summary["claim_labels"]) == CLAIM_LABELS
    assert metadata["limits"]["parent_wall_timeout_seconds"] == 180
    assert metadata["limits"]["processed_scheduled_events"] == 2_000_000
    assert metadata["limits"]["emitted_domain_events"] == 2_000_000
    assert metadata["event_truncated"] is False

    rows = list(csv.DictReader(io.StringIO(bodies["daily-kpis.csv"].decode())))
    assert len(rows) == 1096
    for row in rows:
        assert {key: (int(row[key]) if key == "seed" else row[key]) for key in ("project_id", "run_id", "model_id", "model_revision_id", "experiment_revision_id", "preset_id", "seed")} == identity

    event_lines = [json.loads(line) for line in bodies["domain-events.jsonl"].splitlines()]
    assert event_lines
    assert [event["sequence"] for event in event_lines] == list(range(1, len(event_lines) + 1))
    assert all({key: event[key] for key in identity} == identity for event in event_lines)

    first = client.get(f"/v1/projects/{project_id}/runs/{run_id}/events", params={"after": 0, "limit": 7})
    assert first.status_code == 200
    first_events = first.json()["events"]
    assert [event["sequence"] for event in first_events] == list(range(1, 8))
    second = client.get(
        f"/v1/projects/{project_id}/runs/{run_id}/events",
        params={"after": first_events[-1]["sequence"], "limit": 7},
    )
    assert second.status_code == 200
    assert [event["sequence"] for event in second.json()["events"]] == list(range(8, 15))
    for invalid_limit in (0, 1001):
        assert client.get(
            f"/v1/projects/{project_id}/runs/{run_id}/events", params={"after": 0, "limit": invalid_limit}
        ).status_code == 422


@pytest.mark.parametrize("tamper", ["model_bundle", "experiment"])
def test_post_run_reverifies_content_addressed_inputs_before_worker_spawn(tmp_path: Path, tamper: str) -> None:
    workspace = tmp_path / "workspace"
    project_id = f"tamper_{tamper}"
    app = create_app(workspace, wind_timeout_seconds=5)
    with TestClient(app, raise_server_exceptions=False) as test_client:
        loaded = _load(test_client, project_id)
        project = workspace / "projects" / project_id
        if tamper == "model_bundle":
            target = project / "models" / "wind-turbine-maintenance" / "revisions" / loaded["model_revision_id"] / "model.py"
            target.write_bytes(target.read_bytes() + b"\n# tampered under the same revision id\n")
        else:
            target = project / "experiments" / "revisions" / loaded["experiment_revision_id"] / "experiment.json"
            experiment = json.loads(target.read_text())
            experiment["parameters"]["crew_count"] += 1
            target.write_text(json.dumps(experiment, sort_keys=True, separators=(",", ":")) + "\n")
        response = test_client.post(
            f"/v1/projects/{project_id}/runs",
            json={"experiment_revision_id": loaded["experiment_revision_id"]},
        )
        assert response.status_code in {409, 422, 500}, response.text
        runs = project / "runs"
        assert not runs.exists() or not any(runs.iterdir())


@pytest.mark.parametrize("drift", ["model_py", "request_experiment"])
def test_post_admission_pre_spawn_input_drift_never_publishes_success_under_original_revisions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, drift: str
) -> None:
    service_module = __import__("mesa_service.service", fromlist=["MesaService"])
    original_spawn = service_module.MesaService._spawn

    def inject_after_admission(self, **kwargs):
        command = kwargs["command"]
        if kwargs["model_id"] == "wind-turbine-maintenance":
            if drift == "model_py":
                model_path = Path(command[command.index("--model") + 1])
                model_path.write_bytes(model_path.read_bytes() + b"\n# drift after parent admission\n")
            else:
                request_path = Path(command[command.index("--request") + 1])
                request = json.loads(request_path.read_text())
                request["parameters"]["crew_count"] += 1
                request_path.write_text(json.dumps(request, sort_keys=True, separators=(",", ":")) + "\n")
        return original_spawn(self, **kwargs)

    monkeypatch.setattr(service_module.MesaService, "_spawn", inject_after_admission)
    workspace = tmp_path / "workspace"
    project_id = f"toctou_{drift}"
    with TestClient(create_app(workspace, wind_timeout_seconds=10), raise_server_exceptions=False) as test_client:
        loaded = _load(test_client, project_id)
        started = test_client.post(
            f"/v1/projects/{project_id}/runs",
            json={"experiment_revision_id": loaded["experiment_revision_id"]},
        )
        assert started.status_code == 202, started.text
        run_id = started.json()["run_id"]
        terminal = _wait(test_client, project_id, run_id, timeout=15)
        assert terminal["status"] == "failed", terminal
        assert terminal["model_revision_id"] == loaded["model_revision_id"]
        assert terminal["experiment_revision_id"] == loaded["experiment_revision_id"]
        assert test_client.get(f"/v1/projects/{project_id}/runs/{run_id}/results").status_code == 404
        for name in ("summary.json", "daily-kpis.csv", "domain-events.jsonl"):
            assert test_client.get(f"/v1/projects/{project_id}/runs/{run_id}/artifacts/{name}").status_code == 404


@pytest.mark.parametrize("layer", ["models", "experiments", "runs"])
def test_nested_workspace_symlink_fails_closed_without_writing_outside(tmp_path: Path, layer: str) -> None:
    workspace = tmp_path / "workspace"
    project_id = f"symlink_{layer}"
    project = workspace / "projects" / project_id
    project.mkdir(parents=True)
    outside = tmp_path / f"outside_{layer}"
    outside.mkdir()
    app = create_app(workspace, wind_timeout_seconds=5)
    with TestClient(app, raise_server_exceptions=False) as test_client:
        if layer == "runs":
            loaded = _load(test_client, project_id)
            (project / "runs").symlink_to(outside, target_is_directory=True)
            response = test_client.post(
                f"/v1/projects/{project_id}/runs",
                json={"experiment_revision_id": loaded["experiment_revision_id"]},
            )
        else:
            (project / layer).symlink_to(outside, target_is_directory=True)
            response = test_client.put(
                f"/v1/projects/{project_id}/models/wind-turbine-maintenance",
                json={"preset_id": PRESET_ID},
            )
        assert response.status_code in {400, 404, 409, 422, 500}, response.text
        assert list(outside.iterdir()) == []


def test_artifact_symlink_is_never_followed(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    project_id = "artifact_symlink"
    run_id = "run_fake"
    run_dir = workspace / "projects" / project_id / "runs" / run_id
    run_dir.mkdir(parents=True)
    (run_dir / "metadata.json").write_text(json.dumps({"status": "succeeded", "model_id": "wind-turbine-maintenance"}))
    outside = tmp_path / "outside-summary.json"
    outside.write_text('{"secret":"unchanged"}\n')
    (run_dir / "summary.json").symlink_to(outside)
    with TestClient(create_app(workspace), raise_server_exceptions=False) as test_client:
        response = test_client.get(f"/v1/projects/{project_id}/runs/{run_id}/artifacts/summary.json")
        assert response.status_code == 404
    assert outside.read_text() == '{"secret":"unchanged"}\n'


def test_temporary_unverified_success_is_not_public_until_atomic_promotion(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    project_id = "unverified"
    run_id = "run_unverified"
    temporary = workspace / "projects" / project_id / "runs" / f"{run_id}.tmp"
    temporary.mkdir(parents=True)
    (temporary / "metadata.json").write_text(json.dumps({"status": "succeeded", "model_id": "wind-turbine-maintenance"}))
    (temporary / "summary.json").write_text("{}\n")
    (temporary / "daily-kpis.csv").write_text("sim_time_days\n0\n")
    with TestClient(create_app(workspace), raise_server_exceptions=False) as test_client:
        status = test_client.get(f"/v1/projects/{project_id}/runs/{run_id}")
        assert status.status_code in {404, 409} or status.json().get("status") != "succeeded"
        results = test_client.get(f"/v1/projects/{project_id}/runs/{run_id}/results")
        assert results.status_code in {404, 409}


def _assert_minimal_terminal(workspace: Path, project_id: str, run_id: str, expected_status: str) -> None:
    run_dir = workspace / "projects" / project_id / "runs" / run_id
    assert run_dir.is_dir() and not run_dir.is_symlink()
    assert {path.name for path in run_dir.iterdir()} == {"request.json", "metadata.json", "run.log"}
    metadata = json.loads((run_dir / "metadata.json").read_text())
    assert metadata["status"] == expected_status
    assert not (run_dir.parent / f"{run_id}.tmp").exists()


def test_cancelled_wind_run_retains_only_bounded_minimal_evidence(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    project_id = "cancel_wind"
    with TestClient(create_app(workspace, wind_timeout_seconds=5, worker_delay_seconds=0.05)) as test_client:
        loaded = _load(test_client, project_id)
        started = test_client.post(
            f"/v1/projects/{project_id}/runs", json={"experiment_revision_id": loaded["experiment_revision_id"]}
        )
        run_id = started.json()["run_id"]
        cancelled = test_client.post(f"/v1/projects/{project_id}/runs/{run_id}/cancel")
        assert cancelled.status_code == 202
        assert cancelled.json()["status"] == "cancelled"
        _assert_minimal_terminal(workspace, project_id, run_id, "cancelled")


def test_timed_out_wind_run_retains_only_bounded_minimal_evidence(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    project_id = "timeout_wind"
    with TestClient(create_app(workspace, wind_timeout_seconds=0.02, worker_delay_seconds=0.05)) as test_client:
        loaded = _load(test_client, project_id)
        started = test_client.post(
            f"/v1/projects/{project_id}/runs", json={"experiment_revision_id": loaded["experiment_revision_id"]}
        )
        run_id = started.json()["run_id"]
        terminal = _wait(test_client, project_id, run_id, timeout=5)
        assert terminal["status"] == "timed_out"
        _assert_minimal_terminal(workspace, project_id, run_id, "timed_out")


def test_resource_failed_wind_run_retains_only_bounded_minimal_evidence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    service_module = __import__("mesa_service.service", fromlist=["WIND_LIMITS"])
    monkeypatch.setitem(service_module.WIND_LIMITS, "run_log_bytes", 0)
    workspace = tmp_path / "workspace"
    project_id = "resource_wind"
    with TestClient(create_app(workspace, wind_timeout_seconds=10, worker_delay_seconds=0.001)) as test_client:
        loaded = _load(test_client, project_id)
        started = test_client.post(
            f"/v1/projects/{project_id}/runs", json={"experiment_revision_id": loaded["experiment_revision_id"]}
        )
        run_id = started.json()["run_id"]
        terminal = _wait(test_client, project_id, run_id, timeout=15)
        assert terminal["status"] == "failed"
        _assert_minimal_terminal(workspace, project_id, run_id, "failed")
