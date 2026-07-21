from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from mesa_service.app import create_app
from mesa_service.service import MesaService


def _path(*parts: str) -> str:
    return "/" + "/".join(parts)


def test_retired_model_and_generic_run_routes_are_absent_from_runtime_and_openapi(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    with TestClient(create_app(workspace), raise_server_exceptions=False) as client:
        project = _path("v1", "projects", "removed")
        run = _path("v1", "projects", "removed", "runs", "run_removed")
        retired = [
            ("PUT", f"{project}/model", {"model_id": "removed"}),
            ("GET", f"{project}/model", None),
            ("GET", f"{project}/parameters", None),
            ("PUT", f"{project}/models/wind-turbine-maintenance", {"preset_id": "wind-turbine-maintenance-demo-v1"}),
            ("GET", f"{project}/models/active", None),
            ("POST", f"{project}/runs", {}),
            ("GET", run, None),
            ("POST", f"{run}/cancel", None),
            ("GET", f"{run}/results", None),
        ]
        for method, path, body in retired:
            response = client.request(method, path, json=body)
            assert response.status_code == 404, (method, path, response.text)

        paths = client.get("/openapi.json").json()["paths"]
        for _, path, _ in retired:
            assert path not in paths
        descriptor_route = _path(
            "internal", "projects", "{project_id}", "wind", "framed-candidate-descriptor", "v1"
        )
        assert descriptor_route not in paths
        assert client.get(descriptor_route.replace("{project_id}", "removed")).status_code == 404
        assert _path("v2", "projects", "{project_id}", "models", "wind-turbine-maintenance") in paths
        retired_status_route = _path("v2", "projects", "{project_id}", "runs", "{run_id}")
        assert retired_status_route not in paths
        assert client.get(retired_status_route.replace("{project_id}", "removed").replace("{run_id}", "run_removed")).status_code == 404
        assert _path("v1", "projects", "{project_id}", "runs", "{run_id}", "events") in paths
        assert _path("v1", "projects", "{project_id}", "runs", "{run_id}", "artifacts", "{name}") in paths

    for name in (
        "load_model", "get_model", "get_parameters", "start_run", "get_results",
        "load_wind_model", "load_wind_model_v2", "get_active_wind_model", "get_wind_run_v2",
    ):
        assert not hasattr(MesaService, name)


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
    with TestClient(create_app(workspace), raise_server_exceptions=False) as client:
        response = client.get(f"/v1/projects/{project_id}/runs/{run_id}/artifacts/summary.json")
        assert response.status_code == 404
    assert outside.read_text() == '{"secret":"unchanged"}\n'
