from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mesa_service.app import create_app


PARAMETERS = {
    "arrival_rate": 6,
    "service_capacity": 2,
    "service_time": 1,
    "initial_backlog": 0,
}


def wait_terminal(client: TestClient, project_id: str, run_id: str, timeout: float = 8) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/v1/projects/{project_id}/runs/{run_id}")
        assert response.status_code == 200, response.text
        payload = response.json()
        if payload["status"] in {"succeeded", "failed", "cancelled", "timed_out"}:
            return payload
        time.sleep(0.03)
    raise AssertionError("run did not reach a terminal state")


@pytest.fixture
def client(tmp_path: Path):
    with TestClient(create_app(tmp_path / "workspace", timeout_seconds=3)) as test_client:
        yield test_client


def load_model(client: TestClient, project_id: str = "project_demo") -> dict:
    response = client.put(f"/v1/projects/{project_id}/model", json={"model_id": "queue-network-v1"})
    assert response.status_code == 200, response.text
    return response.json()


def smoke_request(revision: str) -> dict:
    return {"model_revision": revision, "steps": 12, "seeds": [20260719], "parameters": PARAMETERS}


def test_model_load_parameters_and_seeded_worker_artifacts(client: TestClient) -> None:
    model = load_model(client)
    parameters = client.get("/v1/projects/project_demo/parameters")
    assert parameters.status_code == 200
    assert parameters.json()["model_revision"] == model["model_revision"]
    started = client.post("/v1/projects/project_demo/runs", json=smoke_request(model["model_revision"]))
    assert started.status_code == 202, started.text
    run_id = started.json()["run_id"]
    terminal = wait_terminal(client, "project_demo", run_id)
    assert terminal["status"] == "succeeded"
    results = client.get(f"/v1/projects/project_demo/runs/{run_id}/results")
    assert results.status_code == 200, results.text
    payload = results.json()
    assert payload["summary"]["seeds"] == [20260719]
    assert len(payload["timeseries"]) == 13
    csv_artifact = client.get(f"/v1/projects/project_demo/runs/{run_id}/artifacts/timeseries.csv")
    assert csv_artifact.status_code == 200
    assert csv_artifact.text.splitlines()[0] == "seed,tick,queue_length,completed_jobs,mean_wait_time"


def test_stale_revision_and_invalid_parameter_do_not_start_worker(client: TestClient) -> None:
    model = load_model(client)
    stale = client.post("/v1/projects/project_demo/runs", json=smoke_request("mr_stale"))
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "model_revision_not_active"
    invalid = client.post(
        "/v1/projects/project_demo/runs",
        json={**smoke_request(model["model_revision"]), "parameters": {**PARAMETERS, "service_capacity": 2.5}},
    )
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "invalid_run_request"


def test_cancelled_run_is_terminal_and_has_no_successful_results(tmp_path: Path) -> None:
    app = create_app(tmp_path / "workspace", timeout_seconds=5, worker_delay_seconds=0.3)
    with TestClient(app) as client:
        model = load_model(client)
        started = client.post("/v1/projects/project_demo/runs", json={**smoke_request(model["model_revision"]), "steps": 50})
        run_id = started.json()["run_id"]
        cancelled = client.post(f"/v1/projects/project_demo/runs/{run_id}/cancel")
        assert cancelled.status_code == 202, cancelled.text
        assert cancelled.json()["status"] == "cancelled"
        assert client.get(f"/v1/projects/project_demo/runs/{run_id}/results").status_code == 404
        assert client.get(f"/v1/projects/project_demo/runs/{run_id}/artifacts/metadata.json").status_code == 200


def test_timeout_stays_distinct_and_terminal(tmp_path: Path) -> None:
    app = create_app(tmp_path / "workspace", timeout_seconds=0.08, worker_delay_seconds=0.2)
    with TestClient(app) as client:
        model = load_model(client)
        started = client.post("/v1/projects/project_demo/runs", json={**smoke_request(model["model_revision"]), "steps": 50})
        run_id = started.json()["run_id"]
        terminal = wait_terminal(client, "project_demo", run_id)
        assert terminal["status"] == "timed_out"
        assert client.get(f"/v1/projects/project_demo/runs/{run_id}/results").status_code == 404
        assert client.get(f"/v1/projects/project_demo/runs/{run_id}/artifacts/metadata.json").status_code == 200
