"""Workspace, subprocess, and artifact management for the Mesa API."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .contracts import EXPERIMENT_SCHEMA, MODEL_ID, MODEL_SCHEMA, ContractError, validate_run_request

SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
TERMINAL = {"succeeded", "failed", "cancelled", "timed_out"}


class ServiceError(RuntimeError):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


@dataclass
class ActiveRun:
    project_id: str
    run_id: str
    process: subprocess.Popen[bytes]
    started_monotonic: float
    temporary_dir: Path
    final_dir: Path
    log_handle: Any


def _json_digest(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


class MesaService:
    def __init__(self, workspace_root: str | Path, *, timeout_seconds: float = 30, worker_limit: int = 2, worker_delay_seconds: float = 0) -> None:
        self.workspace_root = Path(workspace_root).resolve()
        self.projects_root = self.workspace_root / "projects"
        self.timeout_seconds = timeout_seconds
        self.worker_limit = worker_limit
        self.worker_delay_seconds = worker_delay_seconds  # test-only hook, not an HTTP input
        self.active_runs: dict[str, ActiveRun] = {}
        self.projects_root.mkdir(parents=True, exist_ok=True)

    def _validate_id(self, value: str, kind: str) -> str:
        if not SAFE_ID.fullmatch(value):
            raise ServiceError(404, f"unknown_{kind}", f"unknown {kind}")
        return value

    def _project_dir(self, project_id: str, *, create: bool = False) -> Path:
        self._validate_id(project_id, "project")
        directory = self.projects_root / project_id
        if create:
            directory.mkdir(parents=True, exist_ok=True)
        if not directory.exists():
            raise ServiceError(404, "project_not_found", "project not found")
        return directory

    def _active_revision(self, project_id: str) -> tuple[Path, dict[str, Any]]:
        project_dir = self._project_dir(project_id)
        active_path = project_dir / "model" / "active.json"
        if not active_path.exists():
            raise ServiceError(404, "model_not_loaded", "no model has been loaded")
        active = _read_json(active_path)
        revision = active["model_revision"]
        revision_dir = project_dir / "model" / "revisions" / revision
        if not revision_dir.exists():
            raise ServiceError(404, "model_revision_not_found", "active model revision not found")
        return revision_dir, active

    def _run_dir(self, project_id: str, run_id: str) -> Path:
        self._validate_id(run_id, "run")
        project_dir = self._project_dir(project_id)
        final_dir = project_dir / "runs" / run_id
        temporary_dir = project_dir / "runs" / f"{run_id}.tmp"
        if final_dir.exists():
            return final_dir
        if temporary_dir.exists():
            return temporary_dir
        raise ServiceError(404, "run_not_found", "run not found")

    def _metadata(self, project_id: str, run_id: str) -> dict[str, Any]:
        return _read_json(self._run_dir(project_id, run_id) / "metadata.json")

    def _write_metadata(self, run_dir: Path, **updates: Any) -> dict[str, Any]:
        path = run_dir / "metadata.json"
        metadata = _read_json(path)
        metadata.update(updates)
        _atomic_json(path, metadata)
        return metadata

    def load_model(self, project_id: str, payload: object) -> dict[str, Any]:
        self.poll()
        if not isinstance(payload, dict) or set(payload) != {"model_id"} or payload.get("model_id") != MODEL_ID:
            raise ServiceError(422, "unsupported_model", "only queue-network-v1 is supported")
        if any(run.project_id == project_id for run in self.active_runs.values()):
            raise ServiceError(409, "run_already_active", "cannot replace model while a run is active")
        project_dir = self._project_dir(project_id, create=True)
        revision = f"mr_{uuid.uuid4().hex}"
        revision_dir = project_dir / "model" / "revisions" / revision
        revision_dir.mkdir(parents=True)
        source_model = Path(__file__).with_name("models") / "queue_network.py"
        destination_model = revision_dir / "model.py"
        shutil.copy2(source_model, destination_model)
        _atomic_json(revision_dir / "model_schema.json", MODEL_SCHEMA)
        _atomic_json(revision_dir / "experiment_schema.json", EXPERIMENT_SCHEMA)
        manifest = {
            "model_id": MODEL_ID,
            "model_class": MODEL_SCHEMA["model_class"],
            "protocol_version": MODEL_SCHEMA["protocol_version"],
            "sha256": hashlib.sha256(destination_model.read_bytes()).hexdigest(),
        }
        _atomic_json(revision_dir / "manifest.json", manifest)
        active = {"model_revision": revision, "model_id": MODEL_ID, "manifest_sha256": _json_digest(manifest)}
        active_path = project_dir / "model" / "active.json"
        active_path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_json(active_path, active)
        return {"model_revision": revision, "model_schema": MODEL_SCHEMA, "manifest": manifest}

    def get_model(self, project_id: str) -> dict[str, Any]:
        revision_dir, active = self._active_revision(project_id)
        return {"model_revision": active["model_revision"], "model_schema": _read_json(revision_dir / "model_schema.json"), "manifest": _read_json(revision_dir / "manifest.json")}

    def get_parameters(self, project_id: str) -> dict[str, Any]:
        model = self.get_model(project_id)
        schema = model["model_schema"]
        return {
            "model_revision": model["model_revision"],
            "parameters": schema["parameters"],
            "default_steps": schema["default_steps"],
            "maximum_steps": schema["maximum_steps"],
        }

    def start_run(self, project_id: str, raw_request: object) -> dict[str, Any]:
        self.poll()
        if any(run.project_id == project_id for run in self.active_runs.values()):
            raise ServiceError(409, "run_already_active", "a run is already active for this project")
        if len(self.active_runs) >= self.worker_limit:
            raise ServiceError(409, "worker_limit_reached", "the service worker limit has been reached")
        revision_dir, active = self._active_revision(project_id)
        try:
            request = validate_run_request(raw_request, active["model_revision"])
        except ContractError as exc:
            code = "model_revision_not_active" if "revision" in str(exc) else "invalid_run_request"
            status = 409 if code == "model_revision_not_active" else 422
            raise ServiceError(status, code, str(exc)) from exc
        run_id = f"run_{uuid.uuid4().hex}"
        project_dir = self._project_dir(project_id)
        runs_dir = project_dir / "runs"
        runs_dir.mkdir(parents=True, exist_ok=True)
        temporary_dir = runs_dir / f"{run_id}.tmp"
        final_dir = runs_dir / run_id
        temporary_dir.mkdir()
        _atomic_json(temporary_dir / "request.json", request)
        manifest = _read_json(revision_dir / "manifest.json")
        metadata = {
            "run_id": run_id,
            "status": "queued",
            "created_at": time.time(),
            "timeout_seconds": self.timeout_seconds,
            "request_digest": _json_digest(request),
            "model_manifest_digest": _json_digest(manifest),
        }
        _atomic_json(temporary_dir / "metadata.json", metadata)
        log_handle = (temporary_dir / "run.log").open("wb")
        package_src = str(Path(__file__).resolve().parents[1])
        environment = {"PATH": os.environ.get("PATH", ""), "PYTHONPATH": package_src, "PYTHONUNBUFFERED": "1"}
        command = [
            sys.executable,
            "-m",
            "mesa_service.worker",
            "--model",
            str(revision_dir / "model.py"),
            "--request",
            str(temporary_dir / "request.json"),
            "--output-dir",
            str(temporary_dir),
            "--delay-per-step",
            str(self.worker_delay_seconds),
        ]
        try:
            process = subprocess.Popen(command, cwd=temporary_dir, env=environment, stdout=log_handle, stderr=subprocess.STDOUT, start_new_session=True)
        except Exception:
            log_handle.close()
            shutil.rmtree(temporary_dir, ignore_errors=True)
            raise
        self._write_metadata(temporary_dir, status="running", started_at=time.time())
        self.active_runs[run_id] = ActiveRun(project_id, run_id, process, time.monotonic(), temporary_dir, final_dir, log_handle)
        return {"run_id": run_id, "status": "queued", "model_revision": active["model_revision"]}

    def _promote(self, active: ActiveRun) -> None:
        active.log_handle.close()
        if active.temporary_dir.exists() and not active.final_dir.exists():
            active.temporary_dir.replace(active.final_dir)
        self.active_runs.pop(active.run_id, None)

    def _terminate(self, active: ActiveRun, status: str, message: str) -> None:
        marker = active.temporary_dir / "cancel_requested"
        marker.touch(exist_ok=True)
        if active.process.poll() is None:
            try:
                os.killpg(active.process.pid, signal.SIGTERM)
                active.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(active.process.pid, signal.SIGKILL)
                active.process.wait(timeout=5)
            except ProcessLookupError:
                pass
        self._write_metadata(
            active.temporary_dir,
            status=status,
            finished_at=time.time(),
            worker_exit_code=active.process.returncode,
            error={"code": status, "message": message},
        )
        self._promote(active)

    def poll(self) -> None:
        for active in list(self.active_runs.values()):
            if active.process.poll() is None and time.monotonic() - active.started_monotonic > self.timeout_seconds:
                self._terminate(active, "timed_out", "simulation exceeded the configured timeout")
                continue
            return_code = active.process.poll()
            if return_code is None:
                continue
            metadata = self._metadata(active.project_id, active.run_id)
            status = metadata.get("status")
            success_files = (active.temporary_dir / "timeseries.csv").exists() and (active.temporary_dir / "summary.json").exists()
            if return_code == 0 and status == "succeeded" and success_files:
                self._promote(active)
                continue
            if status not in TERMINAL or status == "succeeded":
                self._write_metadata(
                    active.temporary_dir,
                    status="failed",
                    finished_at=time.time(),
                    worker_exit_code=return_code,
                    error={"code": "worker_failed", "message": "worker exited without successful artifacts"},
                )
            self._promote(active)

    def get_run(self, project_id: str, run_id: str) -> dict[str, Any]:
        self.poll()
        return self._metadata(project_id, run_id)

    def cancel_run(self, project_id: str, run_id: str) -> dict[str, Any]:
        self.poll()
        metadata = self._metadata(project_id, run_id)
        if metadata["status"] in TERMINAL:
            return metadata
        active = self.active_runs.get(run_id)
        if active is None or active.project_id != project_id:
            raise ServiceError(409, "run_not_active", "run is no longer active")
        self._terminate(active, "cancelled", "simulation cancelled")
        return self._metadata(project_id, run_id)

    def get_results(self, project_id: str, run_id: str) -> dict[str, Any]:
        self.poll()
        run_dir = self._run_dir(project_id, run_id)
        metadata = _read_json(run_dir / "metadata.json")
        if metadata["status"] not in TERMINAL:
            raise ServiceError(409, "run_not_complete", "run is not complete")
        if metadata["status"] != "succeeded":
            raise ServiceError(404, "successful_results_not_found", "successful results do not exist for this run")
        import csv

        with (run_dir / "timeseries.csv").open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        return {"run_id": run_id, "summary": _read_json(run_dir / "summary.json"), "timeseries": rows}

    def get_artifact(self, project_id: str, run_id: str, name: str) -> tuple[Path, str]:
        self.poll()
        allowed = {"request.json", "metadata.json", "summary.json", "timeseries.csv", "run.log"}
        if name not in allowed:
            raise ServiceError(404, "artifact_not_found", "artifact not found")
        path = self._run_dir(project_id, run_id) / name
        if not path.exists():
            raise ServiceError(404, "artifact_not_found", "artifact not found")
        media_type = "text/plain" if name in {"run.log", "timeseries.csv"} else "application/json"
        return path, media_type

    def shutdown(self) -> None:
        for active in list(self.active_runs.values()):
            self._terminate(active, "cancelled", "service shutdown")
