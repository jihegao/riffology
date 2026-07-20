"""Workspace, subprocess, and artifact management for the Mesa API."""

from __future__ import annotations

import csv
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
from .wind_worker import (
    IDENTITY_FIELDS,
    LIMITS as WIND_LIMITS,
    MODEL_ID as WIND_MODEL_ID,
    REQUIRED_SUCCESS_ARTIFACTS as WIND_ARTIFACTS,
    build_run_request,
    initial_metadata,
)

SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
TERMINAL = {"succeeded", "failed", "cancelled", "timed_out"}
WIND_PRESET_ID = "wind-turbine-maintenance-demo-v1"
LEGACY_ARTIFACTS = {"request.json", "metadata.json", "summary.json", "timeseries.csv", "run.log"}


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
    model_id: str
    process: subprocess.Popen[bytes]
    started_monotonic: float
    timeout_seconds: float
    temporary_dir: Path
    final_dir: Path
    log_handle: Any


def _json_digest(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _fsync(file_descriptor: int) -> None:
    try:
        os.fsync(file_descriptor)
    except OSError:
        pass


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True, allow_nan=False)
        handle.write("\n")
        handle.flush()
        _fsync(handle.fileno())
    temporary.replace(path)


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ServiceError(500, "corrupt_workspace", "workspace JSON is not an object")
    return payload


def _absolute_path(path: str | Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _reject_symlink_components(path: str | Path) -> Path:
    """Reject every existing symlink component without resolving through it."""

    candidate = _absolute_path(path)
    current = Path(candidate.anchor)
    for part in candidate.parts[1:]:
        current /= part
        if current.is_symlink():
            raise ServiceError(500, "unsafe_workspace_path", "workspace paths must not contain symlinks")
    return candidate


class MesaService:
    def __init__(
        self,
        workspace_root: str | Path,
        *,
        timeout_seconds: float = 30,
        wind_timeout_seconds: float = 180,
        worker_limit: int = 2,
        worker_delay_seconds: float = 0,
    ) -> None:
        requested_root = _reject_symlink_components(workspace_root)
        requested_root.mkdir(parents=True, exist_ok=True)
        _reject_symlink_components(requested_root)
        self.workspace_root = requested_root.resolve(strict=True)
        self.projects_root = self.workspace_root / "projects"
        self.timeout_seconds = timeout_seconds
        self.wind_timeout_seconds = wind_timeout_seconds
        self.worker_limit = worker_limit
        self.worker_delay_seconds = worker_delay_seconds  # test-only hook, not an HTTP input
        self.active_runs: dict[str, ActiveRun] = {}
        self.projects_root.mkdir(parents=True, exist_ok=True)
        self._safe_path(self.projects_root)

    def _safe_path(self, path: str | Path) -> Path:
        candidate = _reject_symlink_components(path)
        try:
            candidate.relative_to(self.workspace_root)
        except ValueError as exc:
            raise ServiceError(500, "unsafe_workspace_path", "workspace path escapes the configured root") from exc
        return candidate

    def _safe_tree(self, root: str | Path) -> Path:
        directory = self._safe_path(root)
        if not directory.is_dir():
            raise ServiceError(500, "corrupt_workspace", "workspace directory is unavailable")
        for child in directory.rglob("*"):
            self._safe_path(child)
        return directory

    def _read_workspace_json(self, path: str | Path) -> dict[str, Any]:
        candidate = self._safe_path(path)
        if not candidate.is_file():
            raise ServiceError(500, "corrupt_workspace", "workspace JSON is unavailable")
        return _read_json(candidate)

    def _write_workspace_json(self, path: str | Path, payload: dict[str, Any]) -> None:
        candidate = self._safe_path(path)
        self._safe_path(candidate.parent)
        _atomic_json(candidate, payload)

    def _validate_id(self, value: str, kind: str) -> str:
        if not SAFE_ID.fullmatch(value):
            raise ServiceError(404, f"unknown_{kind}", f"unknown {kind}")
        return value

    def _project_dir(self, project_id: str, *, create: bool = False) -> Path:
        self._validate_id(project_id, "project")
        directory = self._safe_path(self.projects_root / project_id)
        if create:
            directory.mkdir(parents=True, exist_ok=True)
            self._safe_path(directory)
        if not directory.exists() or not directory.is_dir():
            raise ServiceError(404, "project_not_found", "project not found")
        return directory

    def _wind_active_path(self, project_dir: Path) -> Path:
        return project_dir / "models" / "active.json"

    def _legacy_active_path(self, project_dir: Path) -> Path:
        return project_dir / "model" / "active.json"

    def _active_revision(self, project_id: str) -> tuple[Path, dict[str, Any]]:
        """Resolve only the legacy singular queue model contract."""
        project_dir = self._project_dir(project_id)
        wind_active_path = self._safe_path(self._wind_active_path(project_dir))
        if wind_active_path.exists():
            raise ServiceError(409, "legacy_model_not_active", "the wind model is active; use the plural model API")
        active_path = self._legacy_active_path(project_dir)
        self._safe_path(active_path)
        if not active_path.exists():
            raise ServiceError(404, "model_not_loaded", "no model has been loaded")
        active = self._read_workspace_json(active_path)
        revision = active["model_revision"]
        revision_dir = self._safe_path(project_dir / "model" / "revisions" / revision)
        if not revision_dir.exists() or not revision_dir.is_dir():
            raise ServiceError(404, "model_revision_not_found", "active model revision not found")
        return revision_dir, active

    def _active_wind(self, project_id: str) -> tuple[Path, Path, dict[str, Any], dict[str, Any]]:
        project_dir = self._project_dir(project_id)
        active_path = self._wind_active_path(project_dir)
        self._safe_path(active_path)
        if not active_path.exists() or not active_path.is_file():
            raise ServiceError(404, "wind_model_not_loaded", "wind-turbine-maintenance is not active")
        active = self._read_workspace_json(active_path)
        if active.get("model_id") != WIND_MODEL_ID:
            raise ServiceError(500, "corrupt_active_model", "active wind model identity is invalid")
        revision = active.get("model_revision_id")
        experiment_revision = active.get("experiment_revision_id")
        if not isinstance(revision, str) or not isinstance(experiment_revision, str):
            raise ServiceError(500, "corrupt_active_model", "active wind revision identity is invalid")
        bundle_dir = self._safe_path(project_dir / "models" / WIND_MODEL_ID / "revisions" / revision)
        experiment_path = self._safe_path(
            project_dir / "experiments" / "revisions" / experiment_revision / "experiment.json"
        )
        if not bundle_dir.is_dir() or not experiment_path.is_file():
            raise ServiceError(500, "corrupt_active_model", "active wind revision files are unavailable")
        self._safe_tree(bundle_dir)
        experiment = self._read_workspace_json(experiment_path)
        return bundle_dir, experiment_path, active, experiment

    def _run_dir(self, project_id: str, run_id: str) -> Path:
        self._validate_id(run_id, "run")
        project_dir = self._project_dir(project_id)
        final_dir = self._safe_path(project_dir / "runs" / run_id)
        if final_dir.exists() and final_dir.is_dir():
            return final_dir
        raise ServiceError(404, "run_not_found", "run not found")

    def _metadata(self, project_id: str, run_id: str) -> dict[str, Any]:
        path = self._run_dir(project_id, run_id) / "metadata.json"
        self._safe_path(path)
        if not path.is_file():
            raise ServiceError(500, "corrupt_run", "run metadata is unavailable")
        return self._read_workspace_json(path)

    def _write_metadata(self, run_dir: Path, **updates: Any) -> dict[str, Any]:
        path = self._safe_path(run_dir / "metadata.json")
        metadata = self._read_workspace_json(path)
        metadata.update(updates)
        self._write_workspace_json(path, metadata)
        return metadata

    # Legacy singular queue path. It remains unchanged for backend/web callers
    # until Gate 4 removes it after the integrated wind cutover.
    def load_model(self, project_id: str, payload: object) -> dict[str, Any]:
        self.poll()
        if not isinstance(payload, dict) or set(payload) != {"model_id"} or payload.get("model_id") != MODEL_ID:
            raise ServiceError(422, "unsupported_model", "only queue-network-v1 is supported by the legacy route")
        if any(run.project_id == project_id for run in self.active_runs.values()):
            raise ServiceError(409, "run_already_active", "cannot replace model while a run is active")
        project_dir = self._project_dir(project_id, create=True)
        wind_pointer = self._wind_active_path(project_dir)
        self._safe_path(wind_pointer)
        if wind_pointer.exists():
            wind_pointer.unlink()
        revision = f"mr_{uuid.uuid4().hex}"
        revision_dir = self._safe_path(project_dir / "model" / "revisions" / revision)
        revision_dir.mkdir(parents=True)
        source_model = Path(__file__).with_name("models") / "queue_network.py"
        destination_model = revision_dir / "model.py"
        shutil.copy2(source_model, destination_model)
        self._write_workspace_json(revision_dir / "model_schema.json", MODEL_SCHEMA)
        self._write_workspace_json(revision_dir / "experiment_schema.json", EXPERIMENT_SCHEMA)
        manifest = {
            "model_id": MODEL_ID,
            "model_class": MODEL_SCHEMA["model_class"],
            "protocol_version": MODEL_SCHEMA["protocol_version"],
            "sha256": hashlib.sha256(destination_model.read_bytes()).hexdigest(),
        }
        self._write_workspace_json(revision_dir / "manifest.json", manifest)
        active = {"model_revision": revision, "model_id": MODEL_ID, "manifest_sha256": _json_digest(manifest)}
        active_path = self._legacy_active_path(project_dir)
        self._safe_path(active_path)
        active_path.parent.mkdir(parents=True, exist_ok=True)
        self._write_workspace_json(active_path, active)
        return {"model_revision": revision, "model_schema": MODEL_SCHEMA, "manifest": manifest}

    def load_wind_model(self, project_id: str, payload: object) -> dict[str, Any]:
        self.poll()
        if not isinstance(payload, dict) or set(payload) != {"preset_id"} or payload.get("preset_id") != WIND_PRESET_ID:
            raise ServiceError(422, "invalid_wind_preset", "the reviewed wind demo preset is required")
        if any(run.project_id == project_id for run in self.active_runs.values()):
            raise ServiceError(409, "run_already_active", "cannot replace model while a run is active")
        from .bundle import materialize_reviewed_bundle

        project_dir = self._project_dir(project_id, create=True)
        self._safe_path(project_dir / "models")
        self._safe_path(project_dir / "experiments")
        materialized = materialize_reviewed_bundle(project_dir)
        if materialized["model_id"] != WIND_MODEL_ID:
            raise ServiceError(500, "invalid_reviewed_bundle", "reviewed bundle returned the wrong model")
        public = {
            "model_id": WIND_MODEL_ID,
            "model_revision_id": materialized["model_revision_id"],
            "experiment_revision_id": materialized["experiment_revision_id"],
            "preset_id": WIND_PRESET_ID,
            "parameter_schema": self._read_workspace_json(Path(materialized["bundle_dir"]) / "parameter-schema.json"),
            "metric_schema": self._read_workspace_json(Path(materialized["bundle_dir"]) / "metric-schema.json"),
            "claim_labels": materialized["experiment"]["claim_labels"],
        }
        legacy_pointer = self._legacy_active_path(project_dir)
        self._safe_path(legacy_pointer)
        if legacy_pointer.exists():
            legacy_pointer.unlink()
        active_path = self._wind_active_path(project_dir)
        self._safe_path(active_path)
        active_path.parent.mkdir(parents=True, exist_ok=True)
        self._write_workspace_json(active_path, public)
        return public

    def get_active_wind_model(self, project_id: str) -> dict[str, Any]:
        _, _, active, _ = self._active_wind(project_id)
        return active

    def get_model(self, project_id: str) -> dict[str, Any]:
        revision_dir, active = self._active_revision(project_id)
        return {
            "model_revision": active["model_revision"],
            "model_schema": self._read_workspace_json(revision_dir / "model_schema.json"),
            "manifest": self._read_workspace_json(revision_dir / "manifest.json"),
        }

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
        project_dir = self._project_dir(project_id)
        wind_active = self._safe_path(self._wind_active_path(project_dir))
        if wind_active.exists():
            return self._start_wind_run(project_id, raw_request)
        return self._start_legacy_run(project_id, raw_request)

    def _new_run_dirs(self, project_id: str) -> tuple[str, Path, Path]:
        run_id = f"run_{uuid.uuid4().hex}"
        project_dir = self._project_dir(project_id)
        runs_dir = self._safe_path(project_dir / "runs")
        runs_dir.mkdir(parents=True, exist_ok=True)
        self._safe_path(runs_dir)
        temporary_dir = self._safe_path(runs_dir / f"{run_id}.tmp")
        final_dir = self._safe_path(runs_dir / run_id)
        temporary_dir.mkdir()
        return run_id, temporary_dir, final_dir

    def _worker_environment(self) -> dict[str, str]:
        package_src = str(Path(__file__).resolve().parents[1])
        return {
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": package_src,
            "PYTHONUNBUFFERED": "1",
            # Importing the package exposes the ASGI app. Keep that module-level
            # default service rooted in the existing workspace, never the
            # worker's private output directory.
            "WORKSPACE_ROOT": str(self.workspace_root),
        }

    def _spawn(
        self,
        *,
        project_id: str,
        run_id: str,
        model_id: str,
        command: list[str],
        temporary_dir: Path,
        final_dir: Path,
        timeout_seconds: float,
    ) -> ActiveRun:
        temporary_dir = self._safe_path(temporary_dir)
        final_dir = self._safe_path(final_dir)
        log_path = self._safe_path(temporary_dir / "run.log")
        log_handle = log_path.open("wb")
        try:
            process = subprocess.Popen(
                command,
                cwd=temporary_dir,
                env=self._worker_environment(),
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except Exception:
            log_handle.close()
            shutil.rmtree(temporary_dir, ignore_errors=True)
            raise
        active = ActiveRun(
            project_id,
            run_id,
            model_id,
            process,
            time.monotonic(),
            timeout_seconds,
            temporary_dir,
            final_dir,
            log_handle,
        )
        self.active_runs[run_id] = active
        self._write_metadata(temporary_dir, status="running", started_at=time.time())
        return active

    def _start_legacy_run(self, project_id: str, raw_request: object) -> dict[str, Any]:
        revision_dir, active_model = self._active_revision(project_id)
        try:
            request = validate_run_request(raw_request, active_model["model_revision"])
        except ContractError as exc:
            code = "model_revision_not_active" if "revision" in str(exc) else "invalid_run_request"
            status = 409 if code == "model_revision_not_active" else 422
            raise ServiceError(status, code, str(exc)) from exc
        run_id, temporary_dir, final_dir = self._new_run_dirs(project_id)
        self._write_workspace_json(temporary_dir / "request.json", request)
        manifest = self._read_workspace_json(revision_dir / "manifest.json")
        metadata = {
            "run_id": run_id,
            "model_id": MODEL_ID,
            "status": "queued",
            "created_at": time.time(),
            "timeout_seconds": self.timeout_seconds,
            "request_digest": _json_digest(request),
            "model_manifest_digest": _json_digest(manifest),
        }
        self._write_workspace_json(temporary_dir / "metadata.json", metadata)
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
        self._spawn(
            project_id=project_id,
            run_id=run_id,
            model_id=MODEL_ID,
            command=command,
            temporary_dir=temporary_dir,
            final_dir=final_dir,
            timeout_seconds=self.timeout_seconds,
        )
        return {"run_id": run_id, "status": "queued", "model_revision": active_model["model_revision"]}

    def _start_wind_run(self, project_id: str, raw_request: object) -> dict[str, Any]:
        if not isinstance(raw_request, dict) or set(raw_request) != {"experiment_revision_id"}:
            raise ServiceError(422, "invalid_run_request", "wind run request accepts exactly experiment_revision_id")
        bundle_dir, experiment_path, active_model, experiment = self._active_wind(project_id)
        requested_revision = raw_request.get("experiment_revision_id")
        if not isinstance(requested_revision, str) or not re.fullmatch(r"er_[0-9a-f]{64}", requested_revision):
            raise ServiceError(422, "invalid_run_request", "experiment_revision_id is invalid")
        if requested_revision != active_model["experiment_revision_id"]:
            raise ServiceError(409, "experiment_revision_not_active", "experiment revision is not active")

        # Admission re-establishes both content-addressed identities immediately
        # before spawning. Loading a revision earlier is not durable proof that
        # its bytes are still the reviewed bytes now.
        try:
            from .bundle import experiment_revision_id as compute_experiment_revision_id
            from .verify_bundle import verify_bundle
            from .wind_contracts import validate_experiment_document

            self._safe_tree(bundle_dir)
            verified_bundle = verify_bundle(bundle_dir)
            validated_experiment = validate_experiment_document(experiment)
            computed_experiment_revision = compute_experiment_revision_id(validated_experiment)
        except Exception as exc:
            raise ServiceError(
                500,
                "reviewed_input_verification_failed",
                f"reviewed wind inputs failed admission verification: {exc}",
            ) from exc
        if verified_bundle.get("model_revision_id") != active_model["model_revision_id"]:
            raise ServiceError(500, "model_revision_identity_mismatch", "active model revision no longer matches its bytes")
        if validated_experiment.get("model_revision_id") != active_model["model_revision_id"]:
            raise ServiceError(500, "experiment_model_identity_mismatch", "experiment does not bind the active model")
        if computed_experiment_revision != requested_revision or experiment_path.parent.name != requested_revision:
            raise ServiceError(
                409,
                "experiment_revision_identity_mismatch",
                "experiment revision no longer matches its content",
            )
        run_id, temporary_dir, final_dir = self._new_run_dirs(project_id)
        request = build_run_request(
            project_id=project_id,
            run_id=run_id,
            model_revision_id=active_model["model_revision_id"],
            experiment_revision_id=active_model["experiment_revision_id"],
            experiment=validated_experiment,
        )
        self._write_workspace_json(temporary_dir / "request.json", request)
        expected_request_sha256 = hashlib.sha256((temporary_dir / "request.json").read_bytes()).hexdigest()
        metadata = initial_metadata(request)
        metadata["limits"]["parent_wall_timeout_seconds"] = int(self.wind_timeout_seconds)
        self._write_workspace_json(temporary_dir / "metadata.json", metadata)
        command = [
            sys.executable,
            "-m",
            "mesa_service.wind_worker",
            "--model",
            str(bundle_dir / "model.py"),
            "--request",
            str(temporary_dir / "request.json"),
            "--output-dir",
            str(temporary_dir),
            "--expected-request-sha256",
            expected_request_sha256,
            "--expected-model-revision-id",
            active_model["model_revision_id"],
            "--expected-experiment-revision-id",
            active_model["experiment_revision_id"],
            "--delay-per-day",
            str(self.worker_delay_seconds),
        ]
        self._spawn(
            project_id=project_id,
            run_id=run_id,
            model_id=WIND_MODEL_ID,
            command=command,
            temporary_dir=temporary_dir,
            final_dir=final_dir,
            timeout_seconds=self.wind_timeout_seconds,
        )
        return {
            "run_id": run_id,
            "status": "queued",
            "model_revision_id": active_model["model_revision_id"],
            "experiment_revision_id": active_model["experiment_revision_id"],
        }

    def _close_log(self, active: ActiveRun) -> None:
        if not active.log_handle.closed:
            active.log_handle.flush()
            _fsync(active.log_handle.fileno())
            active.log_handle.close()

    def _promote(self, active: ActiveRun) -> None:
        self._close_log(active)
        temporary_dir = self._safe_path(active.temporary_dir)
        final_dir = self._safe_path(active.final_dir)
        if not temporary_dir.is_dir() or final_dir.exists():
            raise ServiceError(500, "unsafe_run_promotion", "run cannot be atomically promoted")
        temporary_dir.replace(final_dir)
        try:
            directory_fd = os.open(final_dir.parent, os.O_RDONLY)
            try:
                _fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
        self.active_runs.pop(active.run_id, None)

    def _retain_failure_evidence(self, active: ActiveRun) -> None:
        temporary_dir = self._safe_path(active.temporary_dir)
        for child in temporary_dir.iterdir():
            if child.is_symlink():
                child.unlink(missing_ok=True)
                continue
            self._safe_path(child)
            if child.name not in {"request.json", "metadata.json", "run.log"}:
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink(missing_ok=True)

    def _terminate(self, active: ActiveRun, status: str, message: str) -> None:
        marker = self._safe_path(active.temporary_dir / "cancel_requested")
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
        self._close_log(active)
        self._write_metadata(
            active.temporary_dir,
            status=status,
            finished_at=time.time(),
            worker_exit_code=active.process.returncode,
            error={"code": status, "message": message},
        )
        if active.model_id == WIND_MODEL_ID:
            self._retain_failure_evidence(active)
        self._promote(active)

    def _wind_success_is_valid(self, active: ActiveRun) -> bool:
        try:
            from .verify_run import verify_run

            verify_run(active.temporary_dir)
            return True
        except Exception as exc:
            self._write_metadata(
                active.temporary_dir,
                status="failed",
                finished_at=time.time(),
                worker_exit_code=active.process.returncode,
                error={"code": "artifact_verification_failed", "message": str(exc)},
            )
            self._retain_failure_evidence(active)
            return False

    def poll(self) -> None:
        for active in list(self.active_runs.values()):
            if active.process.poll() is None and time.monotonic() - active.started_monotonic > active.timeout_seconds:
                self._terminate(active, "timed_out", "simulation exceeded the configured timeout")
                continue
            if active.model_id == WIND_MODEL_ID and active.process.poll() is None:
                log_path = self._safe_path(active.temporary_dir / "run.log")
                if log_path.exists() and log_path.stat().st_size > WIND_LIMITS["run_log_bytes"]:
                    self._terminate(active, "failed", "wind worker exceeded the run log limit")
                    continue
            return_code = active.process.poll()
            if return_code is None:
                continue
            self._close_log(active)
            metadata = self._read_workspace_json(active.temporary_dir / "metadata.json")
            status = metadata.get("status")
            if active.model_id == WIND_MODEL_ID:
                success = return_code == 0 and status == "succeeded"
                if success and self._wind_success_is_valid(active):
                    self._promote(active)
                    continue
                if status not in TERMINAL or status == "succeeded":
                    self._write_metadata(
                        active.temporary_dir,
                        status="failed",
                        finished_at=time.time(),
                        worker_exit_code=return_code,
                        error={"code": "worker_failed", "message": "wind worker exited without verified artifacts"},
                    )
                self._retain_failure_evidence(active)
                self._promote(active)
                continue
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
        self._validate_id(run_id, "run")
        active = self.active_runs.get(run_id)
        if active is not None and active.project_id == project_id:
            metadata = self._read_workspace_json(active.temporary_dir / "metadata.json")
            # Worker terminal claims are private child state until the parent
            # has observed exit, verified evidence, and atomically promoted.
            if metadata.get("status") not in {"queued", "running"}:
                metadata = {**metadata, "status": "running"}
            return metadata
        return self._metadata(project_id, run_id)

    def cancel_run(self, project_id: str, run_id: str) -> dict[str, Any]:
        self.poll()
        self._validate_id(run_id, "run")
        active = self.active_runs.get(run_id)
        if active is None or active.project_id != project_id:
            metadata = self._metadata(project_id, run_id)
            if metadata["status"] in TERMINAL:
                return metadata
            raise ServiceError(409, "run_not_active", "run is no longer active")
        self._terminate(active, "cancelled", "simulation cancelled")
        return self._metadata(project_id, run_id)

    def get_results(self, project_id: str, run_id: str) -> dict[str, Any]:
        self.poll()
        run_dir = self._run_dir(project_id, run_id)
        metadata = self._read_workspace_json(run_dir / "metadata.json")
        if metadata["status"] not in TERMINAL:
            raise ServiceError(409, "run_not_complete", "run is not complete")
        if metadata["status"] != "succeeded":
            raise ServiceError(404, "successful_results_not_found", "successful results do not exist for this run")
        filename = "daily-kpis.csv" if metadata.get("model_id") == WIND_MODEL_ID else "timeseries.csv"
        data_path = self._safe_path(run_dir / filename)
        if not data_path.is_file():
            raise ServiceError(500, "corrupt_run", "run result artifact is unavailable")
        with data_path.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        return {"run_id": run_id, "summary": self._read_workspace_json(run_dir / "summary.json"), "timeseries": rows}

    def get_events(self, project_id: str, run_id: str, *, after: int, limit: int) -> dict[str, Any]:
        self.poll()
        if not isinstance(after, int) or isinstance(after, bool) or after < 0:
            raise ServiceError(422, "invalid_event_cursor", "after must be a non-negative integer")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 1000:
            raise ServiceError(422, "invalid_event_limit", "limit must be between 1 and 1000")
        run_dir = self._run_dir(project_id, run_id)
        metadata = self._read_workspace_json(run_dir / "metadata.json")
        if metadata.get("model_id") != WIND_MODEL_ID:
            raise ServiceError(404, "events_not_found", "domain events are unavailable for this run")
        path = self._safe_path(run_dir / "domain-events.jsonl")
        if not path.is_file():
            raise ServiceError(404, "events_not_found", "domain events are unavailable for this run")
        events: list[dict[str, Any]] = []
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                event = json.loads(line)
                sequence = event.get("sequence")
                if isinstance(sequence, int) and sequence > after:
                    events.append(event)
                    if len(events) == limit:
                        break
        return {"events": events, "next_after": events[-1]["sequence"] if events else after}

    def get_artifact(self, project_id: str, run_id: str, name: str) -> tuple[Path, str]:
        self.poll()
        run_dir = self._run_dir(project_id, run_id)
        metadata = self._read_workspace_json(run_dir / "metadata.json")
        allowed = WIND_ARTIFACTS if metadata.get("model_id") == WIND_MODEL_ID else LEGACY_ARTIFACTS
        if name not in allowed:
            raise ServiceError(404, "artifact_not_found", "artifact not found")
        try:
            path = self._safe_path(run_dir / name)
        except ServiceError as exc:
            raise ServiceError(404, "artifact_not_found", "artifact not found") from exc
        if not path.is_file() or path.parent != run_dir:
            raise ServiceError(404, "artifact_not_found", "artifact not found")
        media_type = "text/plain" if name in {"run.log", "timeseries.csv", "daily-kpis.csv", "domain-events.jsonl"} else "application/json"
        return path, media_type

    def shutdown(self) -> None:
        for active in list(self.active_runs.values()):
            self._terminate(active, "cancelled", "service shutdown")
