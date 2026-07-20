"""Workspace, subprocess, and artifact management for the Mesa API."""

from __future__ import annotations

import csv
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import threading
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass
from contextlib import contextmanager
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
    process: Any
    started_monotonic: float
    timeout_seconds: float
    temporary_dir: Path
    final_dir: Path
    log_handle: Any
    gate2_context: dict[str, Any] | None = None


class AdoptedProcess:
    """Minimal Popen-compatible monitor for a durably identified non-child PID."""

    def __init__(self, pid: int, start_token: str, metadata_path: Path, args: str) -> None:
        self.pid = pid
        self._start_token = start_token
        self._metadata_path = metadata_path
        self.args = args
        self.returncode: int | None = None

    def poll(self) -> int | None:
        if _process_start_token(self.pid) == self._start_token:
            try:
                state = subprocess.check_output(
                    ["ps", "-o", "state=", "-p", str(self.pid)],
                    stderr=subprocess.DEVNULL, text=True, timeout=2,
                ).strip()
            except (OSError, subprocess.SubprocessError):
                state = ""
            if "Z" not in state:
                return None
        if self.returncode is None:
            try:
                status = json.loads(self._metadata_path.read_text(encoding="utf-8")).get("status")
            except Exception:
                status = "failed"
            self.returncode = 0 if status == "succeeded" else 1
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        deadline = None if timeout is None else time.monotonic() + timeout
        while self.poll() is None:
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(str(self.pid), timeout)
            time.sleep(0.01)
        return int(self.returncode)


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


def _atomic_bytes(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("wb") as handle:
        handle.write(data)
        handle.flush()
        _fsync(handle.fileno())
    temporary.replace(path)
    try:
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            _fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError:
        pass


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ServiceError(500, "corrupt_workspace", "workspace JSON is not an object")
    return payload


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _process_start_token(pid: int) -> str | None:
    try:
        value = subprocess.check_output(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return hashlib.sha256(value.encode()).hexdigest() if value else None


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
        owner_lease_seconds: float = 10.0,
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
        self.owner_lease_seconds = max(0.25, float(owner_lease_seconds))
        self.owner_instance_id = f"mesa_owner_{uuid.uuid4().hex}"
        self.active_runs: dict[str, ActiveRun] = {}
        self._poll_lock = threading.Lock()
        self.projects_root.mkdir(parents=True, exist_ok=True)
        self._safe_path(self.projects_root)
        self._recover_indexed_gate2_receipts()

    def _recover_indexed_gate2_receipts(self) -> None:
        """Reconcile only projects named by the backend's durable workspace cache."""

        from .canonical_v2 import require_canonical_json_v2_bytes

        workspace_path = self._safe_path(self.workspace_root / "workspace.json")
        if not workspace_path.exists():
            return
        try:
            workspace = require_canonical_json_v2_bytes(workspace_path.read_bytes())
        except Exception as exc:
            raise ServiceError(500, "workspace_index_corrupt", "workspace index bytes are invalid") from exc
        if (
            not isinstance(workspace, dict)
            or set(workspace) != {"schema_version", "canonical_json_version", "project_ids", "corrupt_project_ids", "workspace_revision"}
            or workspace.get("schema_version") != 1
            or workspace.get("canonical_json_version") != "riff-canonical-json-v2"
            or not isinstance(workspace.get("project_ids"), list)
            or workspace["project_ids"] != sorted(set(workspace["project_ids"]))
            or not isinstance(workspace.get("corrupt_project_ids"), list)
            or workspace["corrupt_project_ids"] != sorted(set(workspace["corrupt_project_ids"]))
        ):
            raise ServiceError(500, "workspace_index_corrupt", "workspace index schema is invalid")
        for project_id in workspace["project_ids"]:
            if project_id in workspace["corrupt_project_ids"]:
                continue
            if not isinstance(project_id, str) or re.fullmatch(r"project_[0-9a-f]{32}", project_id) is None:
                raise ServiceError(500, "workspace_index_corrupt", "workspace index contains an invalid project")
            project_dir = self._project_dir(project_id)
            receipt_dir = self._safe_path(project_dir / "mesa-run-receipts")
            if not receipt_dir.exists():
                continue
            self._safe_tree(receipt_dir)
            for receipt_path in sorted(receipt_dir.iterdir()):
                receipt = self._read_gate2_receipt(receipt_path)
                if receipt is None or receipt_path.name != f"{receipt['downstream_idempotency_key']}.json":
                    raise ServiceError(500, "mesa_run_corrupt", "Mesa receipt path is invalid")
                self.start_wind_run_v2(
                    project_id,
                    {"experiment_revision_id": receipt["experiment_revision_id"]},
                    downstream_key=receipt["downstream_idempotency_key"],
                    run_id=receipt["run_id"],
                    downstream_digest=receipt["downstream_request_digest"],
                )

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

    def _write_workspace_bytes(self, path: str | Path, data: bytes) -> None:
        candidate = self._safe_path(path)
        self._safe_path(candidate.parent)
        _atomic_bytes(candidate, data)

    @contextmanager
    def _run_lock(self, project_dir: Path, run_id: str):
        lock_dir = self._safe_path(project_dir / "mesa-run-locks")
        lock_dir.mkdir(parents=True, exist_ok=True)
        lock_path = self._safe_path(lock_dir / f"{run_id}.lock")
        with lock_path.open("a+b") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

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

    def load_wind_model_v2(self, project_id: str, payload: object) -> dict[str, Any]:
        try:
            from .gate2_project_evidence import verify_indexed_project

            verify_indexed_project(self.workspace_root, project_id)
        except Exception as exc:
            raise ServiceError(422, "project_not_indexed", "Gate 2 bootstrap requires a committed indexed project") from exc
        return self.load_wind_model(project_id, payload)

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
            # Any explicitly imported ASGI app remains rooted in the shared
            # workspace, never the worker's private output directory. Package
            # import itself is deliberately side-effect free.
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
        gate2_context: dict[str, Any] | None = None,
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
            gate2_context,
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

    def _gate2_fault_hook(self, _: str) -> None:
        """Monkeypatch-only crash hook used to prove durable ordering."""

    def _gate2_paths(self, project_dir: Path, run_id: str, downstream_key: str) -> dict[str, Path]:
        return {
            "receipt": self._safe_path(project_dir / "mesa-run-receipts" / f"{downstream_key}.json"),
            "lifecycle": self._safe_path(project_dir / "mesa-run-lifecycle" / run_id / "events"),
            "lease": self._safe_path(project_dir / "mesa-run-lifecycle" / run_id / "owner-lease.json"),
            "pending": self._safe_path(project_dir / ".pending" / run_id),
            "final": self._safe_path(project_dir / "runs" / run_id),
        }

    def _read_gate2_owner_lease(self, path: Path, receipt: dict[str, Any]) -> dict[str, Any] | None:
        from .canonical_v2 import prefixed_digest, require_canonical_json_v2_bytes

        if not path.exists():
            return None
        try:
            lease = require_canonical_json_v2_bytes(path.read_bytes())
        except Exception as exc:
            raise ServiceError(500, "mesa_run_corrupt", "owner lease bytes are invalid") from exc
        keys = {
            "schema_version", "canonical_json_version", "owner_lease_digest", "project_id", "run_id",
            "receipt_digest", "owner_instance_id", "ownership_epoch", "original_started_at_unix_ms",
            "deadline_at_unix_ms", "renewed_at_unix_ms", "expires_at_unix_ms",
        }
        if (
            not isinstance(lease, dict) or set(lease) != keys
            or lease.get("schema_version") != 1
            or lease.get("canonical_json_version") != "riff-canonical-json-v2"
            or lease.get("owner_lease_digest") != prefixed_digest(lease, field="owner_lease_digest", prefix="mol_")
            or lease.get("project_id") != receipt["project_id"]
            or lease.get("run_id") != receipt["run_id"]
            or lease.get("receipt_digest") != receipt["mesa_run_receipt_digest"]
            or not isinstance(lease.get("owner_instance_id"), str)
            or re.fullmatch(r"mesa_owner_[0-9a-f]{32}", lease["owner_instance_id"]) is None
            or any(not isinstance(lease.get(key), int) or isinstance(lease.get(key), bool) for key in (
                "ownership_epoch", "original_started_at_unix_ms", "deadline_at_unix_ms",
                "renewed_at_unix_ms", "expires_at_unix_ms",
            ))
            or lease["ownership_epoch"] < 1
            or lease["original_started_at_unix_ms"] > lease["renewed_at_unix_ms"]
            or lease["renewed_at_unix_ms"] >= lease["expires_at_unix_ms"]
            or lease["original_started_at_unix_ms"] >= lease["deadline_at_unix_ms"]
        ):
            raise ServiceError(500, "mesa_run_corrupt", "owner lease schema or binding is invalid")
        return lease

    def _write_gate2_owner_lease(
        self,
        path: Path,
        receipt: dict[str, Any],
        *,
        ownership_epoch: int,
        prior: dict[str, Any] | None,
        lease_seconds: float | None = None,
    ) -> dict[str, Any]:
        from .canonical_v2 import canonical_json_v2_bytes, prefixed_digest

        now = int(time.time() * 1000)
        started = prior["original_started_at_unix_ms"] if prior else now
        deadline = prior["deadline_at_unix_ms"] if prior else now + int(self.wind_timeout_seconds * 1000)
        lease = {
            "schema_version": 1,
            "canonical_json_version": "riff-canonical-json-v2",
            "owner_lease_digest": "",
            "project_id": receipt["project_id"],
            "run_id": receipt["run_id"],
            "receipt_digest": receipt["mesa_run_receipt_digest"],
            "owner_instance_id": self.owner_instance_id,
            "ownership_epoch": ownership_epoch,
            "original_started_at_unix_ms": started,
            "deadline_at_unix_ms": deadline,
            "renewed_at_unix_ms": now,
            "expires_at_unix_ms": now + int((lease_seconds or self.owner_lease_seconds) * 1000),
        }
        lease["owner_lease_digest"] = prefixed_digest(lease, field="owner_lease_digest", prefix="mol_")
        path.parent.mkdir(parents=True, exist_ok=True)
        self._write_workspace_bytes(path, canonical_json_v2_bytes(lease))
        return lease

    def _claim_gate2_owner_lease(
        self,
        paths: dict[str, Path],
        receipt: dict[str, Any],
        *,
        ownership_epoch: int,
    ) -> dict[str, Any] | None:
        prior = self._read_gate2_owner_lease(paths["lease"], receipt)
        now = int(time.time() * 1000)
        if prior is not None and prior["owner_instance_id"] != self.owner_instance_id and prior["expires_at_unix_ms"] > now:
            return None
        return self._write_gate2_owner_lease(
            paths["lease"], receipt, ownership_epoch=ownership_epoch, prior=prior,
        )

    def _assert_gate2_owner_lease(self, active: ActiveRun, *, require_live_child: bool) -> dict[str, Any]:
        context = active.gate2_context
        if context is None:
            return {}
        lease_path = self._safe_path(context["project_dir"] / "mesa-run-lifecycle" / active.run_id / "owner-lease.json")
        lease = self._read_gate2_owner_lease(lease_path, context["receipt"])
        now = int(time.time() * 1000)
        if (
            lease is None or lease["owner_instance_id"] != self.owner_instance_id
            or lease["ownership_epoch"] != context["ownership_epoch"]
            or lease["expires_at_unix_ms"] <= now
        ):
            raise ServiceError(409, "mesa_owner_fenced", "Mesa owner lease is absent, expired, or fenced")
        records = self._read_gate2_lifecycle(context["lifecycle"], context["receipt"])
        worker_record = next((record for record in reversed(records) if record["state"] == "worker_started"), None)
        if worker_record is not None:
            child = worker_record["child_identity"]
            if (
                child["pid"] != active.process.pid
                or child["request_sha256"] != context["receipt"]["captured_request_sha256"]
                or child["executable_sha256"] != hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest()
            ):
                raise ServiceError(500, "mesa_run_corrupt", "active process does not match durable child identity")
            if require_live_child and not self._gate2_child_is_active(child, context["captured"], records):
                raise ServiceError(409, "mesa_owner_fenced", "durable worker identity is no longer live")
            args = getattr(active.process, "args", None)
            if args is not None:
                command = args if isinstance(args, str) else " ".join(str(value) for value in args)
                captured = context["captured"]
                handshake_path, barrier_path = self._gate2_worker_protocol_paths(active.temporary_dir, child["spawn_nonce"])
                required = (
                    "mesa_service.wind_worker", child["spawn_nonce"], child["request_sha256"],
                    str(captured["bundle_dir"] / "model.py"), str(active.temporary_dir / "request.json"),
                    str(active.temporary_dir), str(handshake_path), str(barrier_path),
                    context["receipt"]["mesa_run_receipt_digest"], str(self.workspace_root),
                    str(captured["cancel_path"]),
                )
                if not all(value in command for value in required):
                    raise ServiceError(500, "mesa_run_corrupt", "active worker argv identity is invalid")
        return lease

    def _renew_gate2_owner_lease(self, active: ActiveRun) -> bool:
        context = active.gate2_context
        if context is None:
            return True
        with self._run_lock(context["project_dir"], active.run_id):
            lease_path = self._safe_path(context["project_dir"] / "mesa-run-lifecycle" / active.run_id / "owner-lease.json")
            lease = self._read_gate2_owner_lease(lease_path, context["receipt"])
            now = int(time.time() * 1000)
            if lease is None or (lease["owner_instance_id"] != self.owner_instance_id and lease["expires_at_unix_ms"] > now):
                self._close_log(active)
                self.active_runs.pop(active.run_id, None)
                return False
            if lease["expires_at_unix_ms"] <= now or lease["ownership_epoch"] != context["ownership_epoch"]:
                records = self._read_gate2_lifecycle(context["lifecycle"], context["receipt"])
                epoch = records[-1]["ownership_epoch"] + 1
                self._append_gate2_lifecycle(
                    context["lifecycle"], context["receipt"], "ownership_acquired", ownership_epoch=epoch,
                )
                context["ownership_epoch"] = epoch
            renewed = self._write_gate2_owner_lease(
                lease_path,
                context["receipt"], ownership_epoch=context["ownership_epoch"], prior=lease,
            )
            context["deadline_at_unix_ms"] = renewed["deadline_at_unix_ms"]
            return True

    def _read_gate2_canonical(self, path: Path, validator: Any, name: str) -> tuple[dict[str, Any], bytes]:
        from .gate2_contracts import Gate2ContractError, validate_v2_record_bytes

        candidate = self._safe_path(path)
        if not candidate.is_file():
            raise ServiceError(422, "run_admission_mismatch", f"{name} is unavailable")
        data = candidate.read_bytes()
        try:
            value = validate_v2_record_bytes(data, validator)
        except Gate2ContractError as exc:
            raise ServiceError(422, "run_admission_mismatch", f"{name} is invalid: {exc}") from exc
        return value, data

    def _capture_gate2_inputs(
        self,
        project_id: str,
        raw_request: object,
        *,
        downstream_key: str,
        run_id: str,
        downstream_digest: str,
    ) -> dict[str, Any]:
        from .canonical_v2 import canonical_json_v2_bytes
        from .gate2_contracts import (
            Gate2ContractError,
            build_v2_worker_request,
            downstream_request_digest,
            validate_experiment_v2,
            validate_policy_snapshot,
            validate_run_admission,
            validate_run_intent,
        )
        from .verify_bundle import verify_bundle

        if not isinstance(raw_request, dict) or set(raw_request) != {"experiment_revision_id"}:
            raise ServiceError(422, "invalid_run_request", "v2 wind run body accepts exactly experiment_revision_id")
        if re.fullmatch(r"project_[0-9a-f]{32}", project_id) is None:
            raise ServiceError(404, "project_not_found", "project not found")
        if re.fullmatch(r"run_[0-9a-f]{32}", run_id) is None:
            raise ServiceError(422, "invalid_run_identity", "X-Riff-Run-Id is invalid")
        if re.fullmatch(r"rk_[0-9a-f]{64}", downstream_key) is None:
            raise ServiceError(422, "invalid_downstream_key", "Idempotency-Key is invalid")
        if re.fullmatch(r"rq_[0-9a-f]{64}", downstream_digest) is None:
            raise ServiceError(422, "invalid_downstream_digest", "X-Riff-Request-Digest is invalid")
        experiment_revision_id = raw_request.get("experiment_revision_id")
        if not isinstance(experiment_revision_id, str) or re.fullmatch(r"er_[0-9a-f]{64}", experiment_revision_id) is None:
            raise ServiceError(422, "invalid_run_request", "experiment_revision_id is invalid")

        project_dir = self._project_dir(project_id)
        bundle_dir, _, active_model, _ = self._active_wind(project_id)
        active_path = self._safe_path(self._wind_active_path(project_dir))
        active_bytes = active_path.read_bytes()
        try:
            verified_bundle = verify_bundle(bundle_dir)
        except Exception as exc:
            raise ServiceError(500, "active_model_revision_drift", "active model bundle verification failed") from exc
        model_revision_id = active_model.get("model_revision_id")
        if verified_bundle.get("model_revision_id") != model_revision_id:
            raise ServiceError(500, "active_model_revision_drift", "active model pointer does not match bundle bytes")

        experiment_path = self._safe_path(
            project_dir / "experiments" / "revisions" / experiment_revision_id / "experiment.json"
        )
        intent_dir = self._safe_path(project_dir / "run-intents" / run_id)
        experiment, experiment_bytes = self._read_gate2_canonical(experiment_path, validate_experiment_v2, "experiment revision")
        admission, admission_bytes = self._read_gate2_canonical(intent_dir / "admission.json", validate_run_admission, "run admission")
        intent, intent_bytes = self._read_gate2_canonical(intent_dir / "intent.json", validate_run_intent, "run intent")
        policy, policy_bytes = self._read_gate2_canonical(intent_dir / "policy-snapshot.json", validate_policy_snapshot, "policy snapshot")
        experiment_sha256 = hashlib.sha256(experiment_bytes).hexdigest()
        if canonical_json_v2_bytes(admission["policy_snapshot"]) != policy_bytes or policy != admission["policy_snapshot"]:
            raise ServiceError(422, "run_admission_mismatch", "standalone and embedded policy snapshot bytes differ")
        identity_keys = (
            "project_id", "run_id", "model_id", "model_revision_id", "brief_revision_id",
            "alignment_revision_id", "experiment_revision_id", "experiment_sha256",
            "policy_snapshot_digest", "run_admission_digest",
        )
        if any(intent.get(key) != admission.get(key) for key in identity_keys):
            raise ServiceError(422, "run_admission_mismatch", "run intent and admission bindings differ")
        if (
            experiment["project_id"] != project_id
            or experiment["experiment_revision_id"] != experiment_revision_id
            or experiment["model_revision_id"] != model_revision_id
            or experiment["brief_revision_id"] != admission["brief_revision_id"]
            or experiment["alignment_revision_id"] != admission["alignment_revision_id"]
            or admission["experiment_sha256"] != experiment_sha256
            or admission["run_id"] != run_id
            or intent["downstream_idempotency_key"] != downstream_key
        ):
            raise ServiceError(422, "run_admission_mismatch", "v2 experiment/admission/intent identity mismatch")
        expected_downstream = downstream_request_digest(
            project_id=project_id,
            run_id=run_id,
            experiment_revision_id=experiment_revision_id,
            experiment_sha256=experiment_sha256,
            run_admission_digest=admission["run_admission_digest"],
            model_revision_id=model_revision_id,
        )
        if intent["downstream_request_digest"] != expected_downstream or downstream_digest != expected_downstream:
            raise ServiceError(409, "downstream_key_conflict", "downstream request digest does not match exact admitted bytes")
        try:
            from .gate2_project_evidence import derive_policy_from_committed_events

            derive_policy_from_committed_events(
                self.workspace_root,
                project_id,
                policy,
                run_intent_digest=intent["run_intent_digest"],
                run_admission_digest=admission["run_admission_digest"],
            )
        except Exception as exc:
            raise ServiceError(422, "run_admission_mismatch", f"committed project policy evidence is invalid: {exc}") from exc
        try:
            request = build_v2_worker_request(experiment=experiment, admission=admission, intent=intent)
            request_bytes = canonical_json_v2_bytes(request)
        except Gate2ContractError as exc:
            raise ServiceError(422, "run_admission_mismatch", str(exc)) from exc
        return {
            "project_dir": project_dir,
            "bundle_dir": bundle_dir,
            "active_path": active_path,
            "active_bytes": active_bytes,
            "model_revision_id": model_revision_id,
            "experiment_path": experiment_path,
            "experiment": experiment,
            "experiment_bytes": experiment_bytes,
            "experiment_sha256": experiment_sha256,
            "admission_path": intent_dir / "admission.json",
            "admission": admission,
            "admission_bytes": admission_bytes,
            "intent_path": intent_dir / "intent.json",
            "intent": intent,
            "intent_bytes": intent_bytes,
            "policy_path": intent_dir / "policy-snapshot.json",
            "policy_bytes": policy_bytes,
            "cancel_path": intent_dir / "cancel-tombstone.json",
            "request": request,
            "request_bytes": request_bytes,
            "captured_request_sha256": hashlib.sha256(request_bytes).hexdigest(),
        }

    def _read_gate2_lifecycle(self, events_dir: Path, receipt: dict[str, Any]) -> list[dict[str, Any]]:
        from .canonical_v2 import require_canonical_json_v2_bytes
        from .gate2_contracts import LIFECYCLE_KEYS, lifecycle_digest, validate_lifecycle_chain

        if not events_dir.exists():
            return []
        self._safe_tree(events_dir)
        paths = sorted(events_dir.iterdir())
        records: list[dict[str, Any]] = []
        previous = None
        for sequence, path in enumerate(paths):
            if path.name != f"{sequence:020d}.json" or path.is_symlink() or not path.is_file():
                raise ServiceError(500, "mesa_run_corrupt", "Mesa lifecycle sequence is invalid")
            try:
                record = require_canonical_json_v2_bytes(path.read_bytes())
            except Exception as exc:
                raise ServiceError(500, "mesa_run_corrupt", "Mesa lifecycle bytes are invalid") from exc
            if not isinstance(record, dict) or set(record) != LIFECYCLE_KEYS:
                raise ServiceError(500, "mesa_run_corrupt", "Mesa lifecycle schema is invalid")
            if (
                record.get("mesa_lifecycle_digest") != lifecycle_digest(record)
                or record.get("sequence") != sequence
                or record.get("previous_mesa_lifecycle_digest") != previous
                or record.get("project_id") != receipt["project_id"]
                or record.get("run_id") != receipt["run_id"]
                or record.get("receipt_digest") != receipt["mesa_run_receipt_digest"]
                or record.get("run_intent_digest") != receipt["run_intent_digest"]
                or record.get("run_admission_digest") != receipt["run_admission_digest"]
                or record.get("policy_snapshot_digest") != receipt["policy_snapshot_digest"]
                or record.get("experiment_sha256") != receipt["experiment_sha256"]
                or record.get("captured_request_sha256") != receipt["captured_request_sha256"]
            ):
                raise ServiceError(500, "mesa_run_corrupt", "Mesa lifecycle binding or digest is invalid")
            previous = record["mesa_lifecycle_digest"]
            records.append(record)
        try:
            validate_lifecycle_chain(records, receipt)
        except Exception as exc:
            raise ServiceError(500, "mesa_run_corrupt", f"Mesa lifecycle state machine is invalid: {exc}") from exc
        return records

    def _append_gate2_lifecycle(
        self,
        events_dir: Path,
        receipt: dict[str, Any],
        state: str,
        *,
        ownership_epoch: int,
        child_identity: dict[str, Any] | None = None,
        evidence_digest: str | None = None,
    ) -> dict[str, Any]:
        from .canonical_v2 import CANONICAL_JSON_VERSION_V2, canonical_json_v2_bytes
        from .gate2_contracts import LIFECYCLE_STATES, lifecycle_digest

        if state not in LIFECYCLE_STATES:
            raise ServiceError(500, "mesa_run_corrupt", "unsupported lifecycle transition")
        events_dir.mkdir(parents=True, exist_ok=True)
        records = self._read_gate2_lifecycle(events_dir, receipt)
        if records and records[-1]["state"] in {"verified_succeeded", "terminal_failed", "terminal_timed_out", "terminal_cancelled"}:
            return records[-1]
        record = {
            "schema_version": 1,
            "canonical_json_version": CANONICAL_JSON_VERSION_V2,
            "mesa_lifecycle_digest": "",
            "project_id": receipt["project_id"],
            "run_id": receipt["run_id"],
            "sequence": len(records),
            "previous_mesa_lifecycle_digest": records[-1]["mesa_lifecycle_digest"] if records else None,
            "ownership_epoch": ownership_epoch,
            "owner_instance_id": self.owner_instance_id,
            "state": state,
            "receipt_digest": receipt["mesa_run_receipt_digest"],
            "run_intent_digest": receipt["run_intent_digest"],
            "run_admission_digest": receipt["run_admission_digest"],
            "policy_snapshot_digest": receipt["policy_snapshot_digest"],
            "experiment_sha256": receipt["experiment_sha256"],
            "captured_request_sha256": receipt["captured_request_sha256"],
            "child_identity": child_identity,
            "evidence_digest": evidence_digest,
            "created_at": _utc_now(),
        }
        record["mesa_lifecycle_digest"] = lifecycle_digest(record)
        self._write_workspace_bytes(events_dir / f"{len(records):020d}.json", canonical_json_v2_bytes(record))
        return record

    def _read_gate2_receipt(self, path: Path) -> dict[str, Any] | None:
        from .canonical_v2 import require_canonical_json_v2_bytes
        from .gate2_contracts import validate_receipt

        if not path.exists():
            return None
        try:
            value = require_canonical_json_v2_bytes(path.read_bytes())
        except Exception as exc:
            raise ServiceError(500, "mesa_run_corrupt", "Mesa receipt bytes are invalid") from exc
        try:
            return validate_receipt(value)
        except Exception as exc:
            raise ServiceError(500, "mesa_run_corrupt", f"Mesa receipt schema or digest is invalid: {exc}") from exc

    def _recheck_gate2_sources(self, captured: dict[str, Any]) -> None:
        sources = (
            (captured["active_path"], captured["active_bytes"], "active_model_revision_drift"),
            (captured["experiment_path"], captured["experiment_bytes"], "experiment_revision_drift"),
            (captured["admission_path"], captured["admission_bytes"], "run_admission_mismatch"),
            (captured["intent_path"], captured["intent_bytes"], "run_admission_mismatch"),
            (captured["policy_path"], captured["policy_bytes"], "run_admission_mismatch"),
        )
        for path, expected, code in sources:
            candidate = self._safe_path(path)
            if not candidate.is_file() or candidate.read_bytes() != expected:
                raise ServiceError(409, code, "admitted source bytes drifted before spawn")

    def _gate2_cancel_tombstone(self, captured: dict[str, Any]) -> dict[str, Any] | None:
        from .gate2_contracts import validate_cancel_tombstone

        path = self._safe_path(captured["cancel_path"])
        if not path.exists():
            return None
        tombstone, _ = self._read_gate2_canonical(path, validate_cancel_tombstone, "cancel tombstone")
        if tombstone["project_id"] != captured["admission"]["project_id"] or tombstone["run_id"] != captured["admission"]["run_id"]:
            raise ServiceError(422, "run_admission_mismatch", "cancel tombstone does not bind the admitted run")
        try:
            from .gate2_project_evidence import verify_cancel_tombstone_committed

            verify_cancel_tombstone_committed(
                self.workspace_root, tombstone["project_id"], tombstone["run_id"], tombstone,
            )
        except Exception as exc:
            raise ServiceError(409, "cancel_tombstone_uncommitted", f"cancel tombstone is not committed: {exc}") from exc
        return tombstone

    def _gate2_worker_protocol_paths(self, pending: Path, nonce: str) -> tuple[Path, Path]:
        return (
            self._safe_path(pending / f".worker-handshake-{nonce}.json"),
            self._safe_path(pending / f".worker-start-barrier-{nonce}.json"),
        )

    def _read_gate2_worker_handshake(
        self,
        captured: dict[str, Any],
        receipt: dict[str, Any],
        nonce: str,
        *,
        wait_seconds: float = 0,
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        from .canonical_v2 import canonical_json_v2_bytes, require_canonical_json_v2_bytes

        handshake_path, barrier_path = self._gate2_worker_protocol_paths(
            self._gate2_paths(captured["project_dir"], receipt["run_id"], receipt["downstream_idempotency_key"])["pending"],
            nonce,
        )
        deadline = time.monotonic() + wait_seconds
        while not handshake_path.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        if not handshake_path.exists():
            return None
        try:
            handshake = require_canonical_json_v2_bytes(handshake_path.read_bytes())
        except Exception as exc:
            raise ServiceError(500, "mesa_run_corrupt", "worker handshake bytes are invalid") from exc
        keys = {
            "schema_version", "canonical_json_version", "project_id", "run_id", "receipt_digest",
            "spawn_ownership_epoch", "spawn_nonce", "pid", "process_start_token", "executable_sha256",
            "request_sha256", "model_path", "request_path", "output_dir", "barrier_path", "handshake_sha256",
        }
        if not isinstance(handshake, dict) or set(handshake) != keys:
            raise ServiceError(500, "mesa_run_corrupt", "worker handshake schema is invalid")
        projection = {key: value for key, value in handshake.items() if key != "handshake_sha256"}
        expected_paths = {
            "model_path": str((captured["bundle_dir"] / "model.py").resolve()),
            "request_path": str((handshake_path.parent / "request.json").resolve()),
            "output_dir": str(handshake_path.parent.resolve()),
            "barrier_path": str(barrier_path.resolve()),
        }
        if (
            handshake["schema_version"] != 1
            or handshake["canonical_json_version"] != "riff-canonical-json-v2"
            or handshake["project_id"] != receipt["project_id"]
            or handshake["run_id"] != receipt["run_id"]
            or handshake["receipt_digest"] != receipt["mesa_run_receipt_digest"]
            or handshake["spawn_nonce"] != nonce
            or handshake["request_sha256"] != receipt["captured_request_sha256"]
            or any(handshake[key] != value for key, value in expected_paths.items())
            or handshake["handshake_sha256"] != hashlib.sha256(canonical_json_v2_bytes(projection)).hexdigest()
        ):
            raise ServiceError(500, "mesa_run_corrupt", "worker handshake binding is invalid")
        child = {
            "pid": handshake["pid"],
            "process_start_token": handshake["process_start_token"],
            "spawn_nonce": nonce,
            "executable_sha256": handshake["executable_sha256"],
            "request_sha256": handshake["request_sha256"],
        }
        return handshake, child

    def _publish_gate2_worker_barrier(
        self,
        captured: dict[str, Any],
        receipt: dict[str, Any],
        handshake: dict[str, Any],
        *,
        grant_epoch: int,
        worker_started_digest: str,
    ) -> None:
        from .canonical_v2 import canonical_json_v2_bytes

        _, barrier_path = self._gate2_worker_protocol_paths(
            self._gate2_paths(captured["project_dir"], receipt["run_id"], receipt["downstream_idempotency_key"])["pending"],
            handshake["spawn_nonce"],
        )
        barrier = {
            "schema_version": 1,
            "canonical_json_version": "riff-canonical-json-v2",
            "project_id": receipt["project_id"],
            "run_id": receipt["run_id"],
            "receipt_digest": receipt["mesa_run_receipt_digest"],
            "spawn_ownership_epoch": handshake["spawn_ownership_epoch"],
            "grant_ownership_epoch": grant_epoch,
            "spawn_nonce": handshake["spawn_nonce"],
            "captured_request_sha256": receipt["captured_request_sha256"],
            "handshake_sha256": handshake["handshake_sha256"],
            "worker_started_lifecycle_digest": worker_started_digest,
        }
        self._write_workspace_bytes(barrier_path, canonical_json_v2_bytes(barrier))

    def _adopt_gate2_worker(
        self,
        captured: dict[str, Any],
        paths: dict[str, Path],
        receipt: dict[str, Any],
        child: dict[str, Any],
        ownership_epoch: int,
    ) -> None:
        log_handle = self._safe_path(paths["pending"] / "run.log").open("ab")
        lease = self._read_gate2_owner_lease(paths["lease"], receipt)
        if lease is None or lease["owner_instance_id"] != self.owner_instance_id:
            raise ServiceError(409, "mesa_owner_fenced", "worker adoption requires the active owner lease")
        try:
            adopted_args = subprocess.check_output(
                ["ps", "-o", "command=", "-p", str(child["pid"])],
                stderr=subprocess.DEVNULL, text=True, timeout=2,
            ).strip()
        except (OSError, subprocess.SubprocessError) as exc:
            log_handle.close()
            raise ServiceError(500, "mesa_run_corrupt", "adopted worker argv is unavailable") from exc
        self.active_runs[receipt["run_id"]] = ActiveRun(
            receipt["project_id"], receipt["run_id"], WIND_MODEL_ID,
            AdoptedProcess(child["pid"], child["process_start_token"], paths["pending"] / "metadata.json", adopted_args),
            time.monotonic(), self.wind_timeout_seconds, paths["pending"], paths["final"], log_handle,
            {
                "receipt": receipt, "lifecycle": paths["lifecycle"], "ownership_epoch": ownership_epoch,
                "project_dir": captured["project_dir"], "captured": captured,
                "deadline_at_unix_ms": lease["deadline_at_unix_ms"],
            },
        )

    def _gate2_child_is_active(self, child: object, captured: dict[str, Any], records: list[dict[str, Any]]) -> bool:
        if not isinstance(child, dict) or set(child) != {
            "pid", "process_start_token", "spawn_nonce", "executable_sha256", "request_sha256"
        }:
            raise ServiceError(500, "mesa_run_corrupt", "worker child identity is invalid")
        pid = child["pid"]
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            raise ServiceError(500, "mesa_run_corrupt", "worker PID identity is invalid")
        if child["request_sha256"] != captured["captured_request_sha256"]:
            raise ServiceError(500, "mesa_run_corrupt", "worker request identity drifted")
        expected_executable = hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest()
        if child["executable_sha256"] != expected_executable:
            raise ServiceError(500, "mesa_run_corrupt", "worker executable identity drifted")
        nonce = child["spawn_nonce"]
        if not isinstance(nonce, str) or not any(
            record["state"] == "spawn_intent" and record["evidence_digest"] == "nonce_" + nonce
            for record in records
        ):
            raise ServiceError(500, "mesa_run_corrupt", "worker spawn nonce is not durable")
        actual_token = _process_start_token(pid)
        if actual_token is None or actual_token != child["process_start_token"]:
            return False
        try:
            command = subprocess.check_output(
                ["ps", "-o", "command=", "-p", str(pid)], stderr=subprocess.DEVNULL, text=True, timeout=2,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        required = (
            "mesa_service.wind_worker", str(captured["bundle_dir"] / "model.py"),
            str(self._gate2_paths(captured["project_dir"], child.get("run_id", captured["admission"]["run_id"]), captured["intent"]["downstream_idempotency_key"])["pending"] / "request.json"),
            str(self.workspace_root), str(captured["cancel_path"]),
            child["spawn_nonce"], captured["captured_request_sha256"],
        )
        return all(token in command for token in required)

    def _recover_gate2_dead_worker(
        self,
        *,
        captured: dict[str, Any],
        paths: dict[str, Path],
        receipt: dict[str, Any],
        ownership_epoch: int,
    ) -> dict[str, Any]:
        pending = paths["pending"]
        final = paths["final"]
        promoted = final.is_dir() and not pending.exists()
        if not promoted and (not pending.is_dir() or final.exists()):
            raise ServiceError(500, "mesa_run_corrupt", "dead worker output location is invalid")
        evidence_root = final if promoted else pending
        metadata_path = self._safe_path(evidence_root / "metadata.json")
        metadata = self._read_workspace_json(metadata_path)
        status = metadata.get("status")
        if status == "succeeded":
            try:
                from .gate2_project_evidence import derive_policy_from_committed_events
                from .verify_run import verify_run

                derive_policy_from_committed_events(
                    self.workspace_root, receipt["project_id"], captured["admission"]["policy_snapshot"],
                    run_intent_digest=captured["intent"]["run_intent_digest"],
                    run_admission_digest=captured["admission"]["run_admission_digest"],
                )
                self._finalize_gate2_success_metadata(evidence_root)
                verify_run(evidence_root)
            except Exception as exc:
                status = "failed"
                self._write_metadata(
                    evidence_root, status="failed", finished_at=time.time(),
                    error={"code": "artifact_verification_failed", "message": str(exc)},
                )
        if status not in {"succeeded", "failed", "timed_out", "cancelled"}:
            status = "failed"
            self._write_metadata(
                evidence_root, status="failed", finished_at=time.time(),
                error={"code": "worker_exited", "message": "verified worker exited without terminal evidence"},
            )
        tombstone = self._gate2_cancel_tombstone(captured)
        if tombstone is not None:
            self._write_metadata(
                evidence_root,
                cancel_outcome={
                    "succeeded": "completed_before_cancel_effect",
                    "failed": "failed_before_cancel_effect",
                    "timed_out": "timed_out_before_cancel_effect",
                    "cancelled": "cancelled_by_worker",
                }[status],
            )
        if status != "succeeded":
            for child_path in list(evidence_root.iterdir()):
                if child_path.name not in {"request.json", "metadata.json", "run.log"}:
                    if child_path.is_dir():
                        shutil.rmtree(child_path)
                    else:
                        child_path.unlink(missing_ok=True)
        self._append_gate2_lifecycle(
            paths["lifecycle"], receipt, "worker_exited", ownership_epoch=ownership_epoch,
            evidence_digest="tm_" + hashlib.sha256(metadata_path.read_bytes()).hexdigest(),
        )
        state = {
            "succeeded": "verified_succeeded", "failed": "terminal_failed",
            "timed_out": "terminal_timed_out", "cancelled": "terminal_cancelled",
        }[status]
        last = self._append_gate2_lifecycle(
            paths["lifecycle"], receipt, state, ownership_epoch=ownership_epoch,
            evidence_digest="tm_" + hashlib.sha256(metadata_path.read_bytes()).hexdigest(),
        )
        if not promoted:
            lease = self._read_gate2_owner_lease(paths["lease"], receipt)
            if (
                lease is None or lease["owner_instance_id"] != self.owner_instance_id
                or lease["ownership_epoch"] != ownership_epoch
                or lease["expires_at_unix_ms"] <= int(time.time() * 1000)
            ):
                raise ServiceError(409, "mesa_owner_fenced", "recovery owner lost its promotion lease")
            final.parent.mkdir(parents=True, exist_ok=True)
            pending.replace(final)
        return {
            "run_id": receipt["run_id"], "status": status,
            "mesa_run_receipt_digest": receipt["mesa_run_receipt_digest"],
            "mesa_lifecycle_digest": last["mesa_lifecycle_digest"],
        }

    def _complete_gate2_cancel_before_spawn(
        self,
        *,
        captured: dict[str, Any],
        paths: dict[str, Path],
        receipt: dict[str, Any],
        ownership_epoch: int,
        tombstone: dict[str, Any],
    ) -> dict[str, Any]:
        from .wind_worker import initial_metadata_v2

        pending = paths["pending"]
        final = paths["final"]
        final.parent.mkdir(parents=True, exist_ok=True)
        if final.exists():
            raise ServiceError(500, "mesa_run_corrupt", "cancelled run output already exists")
        if not pending.exists():
            pending.mkdir(parents=True)
            self._write_workspace_bytes(pending / "request.json", captured["request_bytes"])
            metadata = initial_metadata_v2(captured["request"])
            self._write_workspace_json(pending / "metadata.json", metadata)
        self._write_metadata(
            pending,
            status="cancelled", finished_at=time.time(), worker_exit_code=None,
            cancel_outcome="cancelled_before_dispatch",
            error={"code": "cancelled", "message": "cancel tombstone existed before worker spawn"},
        )
        (pending / "run.log").touch(exist_ok=True)
        self._append_gate2_lifecycle(
            paths["lifecycle"], receipt, "cancel_requested", ownership_epoch=ownership_epoch,
            evidence_digest=tombstone["cancel_tombstone_digest"],
        )
        metadata_digest = "tm_" + hashlib.sha256((pending / "metadata.json").read_bytes()).hexdigest()
        pending.replace(final)
        last = self._append_gate2_lifecycle(
            paths["lifecycle"], receipt, "terminal_cancelled", ownership_epoch=ownership_epoch,
            evidence_digest=metadata_digest,
        )
        return {
            "run_id": receipt["run_id"], "status": "cancelled",
            "mesa_run_receipt_digest": receipt["mesa_run_receipt_digest"],
            "mesa_lifecycle_digest": last["mesa_lifecycle_digest"],
        }

    def _complete_gate2_failure_before_spawn(
        self,
        *,
        captured: dict[str, Any],
        paths: dict[str, Path],
        receipt: dict[str, Any],
        ownership_epoch: int,
        code: str,
        message: str,
    ) -> dict[str, Any]:
        from .wind_worker import initial_metadata_v2

        pending = paths["pending"]
        final = paths["final"]
        final.parent.mkdir(parents=True, exist_ok=True)
        if not pending.exists():
            pending.mkdir(parents=True)
            self._write_workspace_bytes(pending / "request.json", captured["request_bytes"])
            self._write_workspace_json(pending / "metadata.json", initial_metadata_v2(captured["request"]))
        self._write_metadata(
            pending, status="failed", finished_at=time.time(), worker_exit_code=None,
            cancel_outcome=None, error={"code": code, "message": message},
        )
        (pending / "run.log").touch(exist_ok=True)
        metadata_digest = "tm_" + hashlib.sha256((pending / "metadata.json").read_bytes()).hexdigest()
        pending.replace(final)
        last = self._append_gate2_lifecycle(
            paths["lifecycle"], receipt, "terminal_failed", ownership_epoch=ownership_epoch,
            evidence_digest=metadata_digest,
        )
        return {
            "run_id": receipt["run_id"], "status": "failed",
            "mesa_run_receipt_digest": receipt["mesa_run_receipt_digest"],
            "mesa_lifecycle_digest": last["mesa_lifecycle_digest"],
        }

    def start_wind_run_v2(
        self,
        project_id: str,
        raw_request: object,
        *,
        downstream_key: str,
        run_id: str,
        downstream_digest: str,
    ) -> dict[str, Any]:
        from .canonical_v2 import CANONICAL_JSON_VERSION_V2, canonical_json_v2_bytes
        from .gate2_contracts import receipt_digest
        from .wind_worker import initial_metadata_v2

        self.poll()
        captured = self._capture_gate2_inputs(
            project_id,
            raw_request,
            downstream_key=downstream_key,
            run_id=run_id,
            downstream_digest=downstream_digest,
        )
        paths = self._gate2_paths(captured["project_dir"], run_id, downstream_key)
        with self._run_lock(captured["project_dir"], run_id):
            receipt = self._read_gate2_receipt(paths["receipt"])
            if receipt is not None:
                expected = {
                    "downstream_idempotency_key": downstream_key,
                    "downstream_request_digest": downstream_digest,
                    "project_id": project_id,
                    "run_id": run_id,
                    "model_revision_id": captured["model_revision_id"],
                    "experiment_revision_id": captured["experiment"]["experiment_revision_id"],
                    "experiment_sha256": captured["experiment_sha256"],
                    "policy_snapshot_digest": captured["admission"]["policy_snapshot_digest"],
                    "run_admission_digest": captured["admission"]["run_admission_digest"],
                    "run_intent_digest": captured["intent"]["run_intent_digest"],
                    "captured_request_sha256": captured["captured_request_sha256"],
                }
                if any(receipt.get(key) != value for key, value in expected.items()):
                    raise ServiceError(409, "downstream_key_conflict", "downstream key is already bound to different bytes")
                records = self._read_gate2_lifecycle(paths["lifecycle"], receipt)
                if not records:
                    self._append_gate2_lifecycle(
                        paths["lifecycle"], receipt, "receipt_committed",
                        ownership_epoch=receipt["ownership_epoch"],
                    )
                    records = self._read_gate2_lifecycle(paths["lifecycle"], receipt)
                if records and records[-1]["state"] in {"verified_succeeded", "terminal_failed", "terminal_timed_out", "terminal_cancelled"}:
                    status = {
                        "verified_succeeded": "succeeded", "terminal_failed": "failed",
                        "terminal_timed_out": "timed_out", "terminal_cancelled": "cancelled",
                    }[records[-1]["state"]]
                    return {"run_id": run_id, "status": status, "mesa_run_receipt_digest": receipt["mesa_run_receipt_digest"], "mesa_lifecycle_digest": records[-1]["mesa_lifecycle_digest"]}
                if run_id in self.active_runs:
                    last = records[-1]
                    return {"run_id": run_id, "status": "running", "mesa_run_receipt_digest": receipt["mesa_run_receipt_digest"], "mesa_lifecycle_digest": last["mesa_lifecycle_digest"]}
                lease = self._read_gate2_owner_lease(paths["lease"], receipt)
                if (
                    lease is not None
                    and lease["owner_instance_id"] != self.owner_instance_id
                    and lease["expires_at_unix_ms"] > int(time.time() * 1000)
                ):
                    return {
                        "run_id": run_id, "status": "running",
                        "mesa_run_receipt_digest": receipt["mesa_run_receipt_digest"],
                        "mesa_lifecycle_digest": records[-1]["mesa_lifecycle_digest"],
                    }
                if records and records[-1]["state"] == "worker_started":
                    child = records[-1]["child_identity"]
                    if self._gate2_child_is_active(child, captured, records):
                        epoch = max(record["ownership_epoch"] for record in records) + 1
                        last = self._append_gate2_lifecycle(
                            paths["lifecycle"], receipt, "ownership_acquired", ownership_epoch=epoch,
                        )
                        if self._claim_gate2_owner_lease(paths, receipt, ownership_epoch=epoch) is None:
                            raise ServiceError(409, "mesa_owner_fenced", "another live Mesa owner holds the run lease")
                        protocol = self._read_gate2_worker_handshake(
                            captured, receipt, child["spawn_nonce"], wait_seconds=0,
                        )
                        if protocol is not None:
                            handshake, _ = protocol
                            worker_started = next(
                                record for record in reversed(records) if record["state"] == "worker_started"
                            )
                            self._publish_gate2_worker_barrier(
                                captured, receipt, handshake, grant_epoch=epoch,
                                worker_started_digest=worker_started["mesa_lifecycle_digest"],
                            )
                        self._adopt_gate2_worker(captured, paths, receipt, child, epoch)
                        return {
                            "run_id": run_id, "status": "running",
                            "mesa_run_receipt_digest": receipt["mesa_run_receipt_digest"],
                            "mesa_lifecycle_digest": last["mesa_lifecycle_digest"],
                        }
                    epoch = max(record["ownership_epoch"] for record in records) + 1
                    if self._claim_gate2_owner_lease(paths, receipt, ownership_epoch=epoch) is None:
                        raise ServiceError(409, "mesa_owner_fenced", "another live Mesa owner holds the run lease")
                    return self._recover_gate2_dead_worker(
                        captured=captured, paths=paths, receipt=receipt, ownership_epoch=epoch,
                    )
                if records and records[-1]["state"] == "spawn_intent":
                    nonce = records[-1]["evidence_digest"].removeprefix("nonce_")
                    protocol = self._read_gate2_worker_handshake(captured, receipt, nonce, wait_seconds=2)
                    if protocol is not None:
                        handshake, child = protocol
                        if not self._gate2_child_is_active(child, captured, records):
                            raise ServiceError(500, "mesa_run_corrupt", "durable worker handshake does not identify a live worker")
                        ownership_epoch = max(record["ownership_epoch"] for record in records) + 1
                        self._append_gate2_lifecycle(
                            paths["lifecycle"], receipt, "ownership_acquired", ownership_epoch=ownership_epoch,
                        )
                        if self._claim_gate2_owner_lease(paths, receipt, ownership_epoch=ownership_epoch) is None:
                            raise ServiceError(409, "mesa_owner_fenced", "another live Mesa owner holds the run lease")
                        last = self._append_gate2_lifecycle(
                            paths["lifecycle"], receipt, "worker_started", ownership_epoch=ownership_epoch,
                            child_identity=child,
                        )
                        self._publish_gate2_worker_barrier(
                            captured, receipt, handshake, grant_epoch=ownership_epoch,
                            worker_started_digest=last["mesa_lifecycle_digest"],
                        )
                        self._adopt_gate2_worker(captured, paths, receipt, child, ownership_epoch)
                        return {
                            "run_id": run_id, "status": "running",
                            "mesa_run_receipt_digest": receipt["mesa_run_receipt_digest"],
                            "mesa_lifecycle_digest": last["mesa_lifecycle_digest"],
                        }
                ownership_epoch = max((record["ownership_epoch"] for record in records), default=0) + 1
                self._append_gate2_lifecycle(paths["lifecycle"], receipt, "ownership_acquired", ownership_epoch=ownership_epoch)
                if self._claim_gate2_owner_lease(paths, receipt, ownership_epoch=ownership_epoch) is None:
                    raise ServiceError(409, "mesa_owner_fenced", "another live Mesa owner holds the run lease")
            else:
                receipt = {
                    "schema_version": 1,
                    "canonical_json_version": CANONICAL_JSON_VERSION_V2,
                    "mesa_run_receipt_digest": "",
                    "downstream_idempotency_key": downstream_key,
                    "downstream_request_digest": downstream_digest,
                    "project_id": project_id,
                    "run_id": run_id,
                    "model_id": WIND_MODEL_ID,
                    "model_revision_id": captured["model_revision_id"],
                    "experiment_revision_id": captured["experiment"]["experiment_revision_id"],
                    "experiment_sha256": captured["experiment_sha256"],
                    "policy_snapshot_digest": captured["admission"]["policy_snapshot_digest"],
                    "run_admission_digest": captured["admission"]["run_admission_digest"],
                    "run_intent_digest": captured["intent"]["run_intent_digest"],
                    "captured_request_sha256": captured["captured_request_sha256"],
                    "ownership_epoch": 1,
                    "accepted_at": _utc_now(),
                }
                receipt["mesa_run_receipt_digest"] = receipt_digest(receipt)
                paths["receipt"].parent.mkdir(parents=True, exist_ok=True)
                self._write_workspace_bytes(paths["receipt"], canonical_json_v2_bytes(receipt))
                self._gate2_fault_hook("after_receipt")
                ownership_epoch = 1
                self._append_gate2_lifecycle(paths["lifecycle"], receipt, "receipt_committed", ownership_epoch=1)
                self._append_gate2_lifecycle(paths["lifecycle"], receipt, "ownership_acquired", ownership_epoch=1)
                if self._claim_gate2_owner_lease(paths, receipt, ownership_epoch=1) is None:
                    raise ServiceError(409, "mesa_owner_fenced", "another live Mesa owner holds the run lease")

            if len(self.active_runs) >= self.worker_limit:
                records = self._read_gate2_lifecycle(paths["lifecycle"], receipt)
                return {"run_id": run_id, "status": "accepted", "mesa_run_receipt_digest": receipt["mesa_run_receipt_digest"], "mesa_lifecycle_digest": records[-1]["mesa_lifecycle_digest"]}
            if any(run.project_id == project_id and run.run_id != run_id for run in self.active_runs.values()):
                raise ServiceError(409, "run_already_active", "a run is already active for this project")

            pending = paths["pending"]
            final = paths["final"]
            final.parent.mkdir(parents=True, exist_ok=True)
            tombstone = self._gate2_cancel_tombstone(captured)
            if tombstone is not None:
                return self._complete_gate2_cancel_before_spawn(
                    captured=captured, paths=paths, receipt=receipt,
                    ownership_epoch=ownership_epoch, tombstone=tombstone,
                )
            if final.exists():
                raise ServiceError(500, "mesa_run_corrupt", "run output exists without terminal lifecycle")
            if pending.exists():
                allowed = {"request.json", "metadata.json", "run.log"}
                actual = {path.name for path in pending.iterdir()}
                protocol_files = {
                    name for name in actual
                    if re.fullmatch(r"\.worker-(?:handshake|start-barrier)-[0-9a-f]{32}\.json", name)
                }
                if not actual <= allowed | protocol_files or (pending / "request.json").read_bytes() != captured["request_bytes"]:
                    raise ServiceError(500, "mesa_run_corrupt", "pending run scaffold drifted")
            else:
                pending.mkdir(parents=True)
                self._write_workspace_bytes(pending / "request.json", captured["request_bytes"])
                metadata = initial_metadata_v2(captured["request"])
                metadata["limits"]["parent_wall_timeout_seconds"] = int(self.wind_timeout_seconds)
                self._write_workspace_json(pending / "metadata.json", metadata)
            self._append_gate2_lifecycle(paths["lifecycle"], receipt, "temp_prepared", ownership_epoch=ownership_epoch)
            self._gate2_fault_hook("after_temp_prepared")
            spawn_nonce = uuid.uuid4().hex
            self._append_gate2_lifecycle(paths["lifecycle"], receipt, "spawn_intent", ownership_epoch=ownership_epoch, evidence_digest="nonce_" + spawn_nonce)
            self._gate2_fault_hook("after_spawn_intent")
            try:
                self._recheck_gate2_sources(captured)
            except ServiceError as exc:
                if exc.code not in {"experiment_revision_drift", "active_model_revision_drift", "run_admission_mismatch"}:
                    raise
                return self._complete_gate2_failure_before_spawn(
                    captured=captured, paths=paths, receipt=receipt, ownership_epoch=ownership_epoch,
                    code=exc.code, message=exc.message,
                )
            tombstone = self._gate2_cancel_tombstone(captured)
            if tombstone is not None:
                return self._complete_gate2_cancel_before_spawn(
                    captured=captured, paths=paths, receipt=receipt,
                    ownership_epoch=ownership_epoch, tombstone=tombstone,
                )
            command = [
                sys.executable, "-m", "mesa_service.wind_worker", "--model", str(captured["bundle_dir"] / "model.py"),
                "--request", str(pending / "request.json"), "--output-dir", str(pending),
                "--expected-request-sha256", captured["captured_request_sha256"],
                "--expected-model-revision-id", captured["model_revision_id"],
                "--expected-experiment-revision-id", captured["experiment"]["experiment_revision_id"],
                "--spawn-nonce", spawn_nonce,
                "--worker-start-barrier", str(self._gate2_worker_protocol_paths(pending, spawn_nonce)[1]),
                "--worker-handshake", str(self._gate2_worker_protocol_paths(pending, spawn_nonce)[0]),
                "--receipt-digest", receipt["mesa_run_receipt_digest"],
                "--ownership-epoch", str(ownership_epoch),
                "--workspace-root", str(self.workspace_root),
                "--cancel-tombstone", str(captured["cancel_path"]),
                "--delay-per-day", str(self.worker_delay_seconds),
            ]
            active = self._spawn(
                project_id=project_id, run_id=run_id, model_id=WIND_MODEL_ID, command=command,
                temporary_dir=pending, final_dir=final, timeout_seconds=self.wind_timeout_seconds,
                gate2_context={
                    "receipt": receipt, "lifecycle": paths["lifecycle"], "ownership_epoch": ownership_epoch,
                    "project_dir": captured["project_dir"], "captured": captured,
                    "deadline_at_unix_ms": self._read_gate2_owner_lease(paths["lease"], receipt)["deadline_at_unix_ms"],
                },
            )
            self._gate2_fault_hook("after_process_spawn")
            protocol = self._read_gate2_worker_handshake(captured, receipt, spawn_nonce, wait_seconds=5)
            if protocol is None:
                self._terminate(active, "failed", "worker process identity could not be established", gate2_lock_held=True)
                raise ServiceError(500, "mesa_run_corrupt", "worker handshake is unavailable")
            handshake, child_identity = protocol
            if child_identity["pid"] != active.process.pid or not self._gate2_child_is_active(child_identity, captured, self._read_gate2_lifecycle(paths["lifecycle"], receipt)):
                self._terminate(active, "failed", "worker process identity could not be established", gate2_lock_held=True)
                raise ServiceError(500, "mesa_run_corrupt", "worker process identity is invalid")
            last = self._append_gate2_lifecycle(paths["lifecycle"], receipt, "worker_started", ownership_epoch=ownership_epoch, child_identity=child_identity)
            self._gate2_fault_hook("after_worker_started_before_barrier")
            self._publish_gate2_worker_barrier(
                captured, receipt, handshake, grant_epoch=ownership_epoch,
                worker_started_digest=last["mesa_lifecycle_digest"],
            )
            self._gate2_fault_hook("after_worker_started")
            return {
                "run_id": run_id,
                "status": "queued",
                "model_revision_id": captured["model_revision_id"],
                "experiment_revision_id": captured["experiment"]["experiment_revision_id"],
                "mesa_run_receipt_digest": receipt["mesa_run_receipt_digest"],
                "mesa_lifecycle_digest": last["mesa_lifecycle_digest"],
            }

    def get_wind_run_receipt_v2(self, project_id: str, downstream_key: str) -> dict[str, Any]:
        if re.fullmatch(r"project_[0-9a-f]{32}", project_id) is None or re.fullmatch(r"rk_[0-9a-f]{64}", downstream_key) is None:
            raise ServiceError(404, "receipt_not_found", "Mesa receipt not found")
        project_dir = self._project_dir(project_id)
        path = self._safe_path(project_dir / "mesa-run-receipts" / f"{downstream_key}.json")
        receipt = self._read_gate2_receipt(path)
        if receipt is None or receipt["project_id"] != project_id:
            raise ServiceError(404, "receipt_not_found", "Mesa receipt not found")
        events_dir = self._safe_path(project_dir / "mesa-run-lifecycle" / receipt["run_id"] / "events")
        records = self._read_gate2_lifecycle(events_dir, receipt)
        return {
            "receipt": receipt,
            "lifecycle_records": records,
            "latest_lifecycle": records[-1] if records else None,
        }

    def _close_log(self, active: ActiveRun) -> None:
        if not active.log_handle.closed:
            active.log_handle.flush()
            _fsync(active.log_handle.fileno())
            active.log_handle.close()

    def _promote(self, active: ActiveRun) -> None:
        if active.gate2_context is not None:
            self._assert_gate2_owner_lease(active, require_live_child=False)
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

    def _append_gate2_terminal_for_active(self, active: ActiveRun, status: str) -> None:
        context = active.gate2_context
        if context is None:
            return
        state = {
            "succeeded": "verified_succeeded",
            "failed": "terminal_failed",
            "timed_out": "terminal_timed_out",
            "cancelled": "terminal_cancelled",
        }[status]
        metadata_root = active.temporary_dir if active.temporary_dir.exists() else active.final_dir
        metadata_path = self._safe_path(metadata_root / "metadata.json")
        evidence = "tm_" + hashlib.sha256(metadata_path.read_bytes()).hexdigest() if metadata_path.is_file() else None
        records = self._read_gate2_lifecycle(context["lifecycle"], context["receipt"])
        tombstone = self._gate2_cancel_tombstone(context["captured"])
        if tombstone is not None and not any(record["state"] == "cancel_requested" for record in records):
            self._append_gate2_lifecycle(
                context["lifecycle"], context["receipt"], "cancel_requested",
                ownership_epoch=context["ownership_epoch"],
                evidence_digest=tombstone["cancel_tombstone_digest"],
            )
            records = self._read_gate2_lifecycle(context["lifecycle"], context["receipt"])
        if (
            evidence is not None
            and any(record["state"] == "worker_started" for record in records)
            and records[-1]["state"] != "worker_exited"
        ):
            self._append_gate2_lifecycle(
                context["lifecycle"], context["receipt"], "worker_exited",
                ownership_epoch=context["ownership_epoch"], evidence_digest=evidence,
            )
        self._append_gate2_lifecycle(
            context["lifecycle"], context["receipt"], state,
            ownership_epoch=context["ownership_epoch"], evidence_digest=evidence,
        )

    def _terminate(self, active: ActiveRun, status: str, message: str, *, gate2_lock_held: bool = False) -> None:
        if active.gate2_context is not None and not gate2_lock_held:
            with self._run_lock(active.gate2_context["project_dir"], active.run_id):
                self._terminate(active, status, message, gate2_lock_held=True)
            return
        if active.gate2_context is not None and not active.temporary_dir.exists() and active.final_dir.is_dir():
            self._close_log(active)
            self.active_runs.pop(active.run_id, None)
            return
        if active.gate2_context is not None:
            self._assert_gate2_owner_lease(active, require_live_child=active.process.poll() is None)
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
        updates: dict[str, Any] = {
            "status": status,
            "finished_at": time.time(),
            "worker_exit_code": active.process.returncode,
            "error": {"code": status, "message": message},
        }
        if active.gate2_context is not None:
            tombstone = self._gate2_cancel_tombstone(active.gate2_context["captured"])
            if tombstone is not None and status == "cancelled":
                updates["cancel_outcome"] = "cancelled_by_worker"
            elif tombstone is not None and status == "timed_out":
                updates["cancel_outcome"] = "timed_out_before_cancel_effect"
        self._write_metadata(
            active.temporary_dir,
            **updates,
        )
        if active.model_id == WIND_MODEL_ID:
            self._retain_failure_evidence(active)
        if active.gate2_context is not None:
            self._promote(active)
            self._append_gate2_terminal_for_active(active, status)
        else:
            self._append_gate2_terminal_for_active(active, status)
            self._promote(active)

    def _wind_success_is_valid(self, active: ActiveRun) -> bool:
        try:
            from .verify_run import verify_run

            if active.gate2_context is not None:
                self._replay_gate2_frozen_admission(active)
                self._apply_gate2_cancel_outcome(active, "succeeded")
                self._finalize_gate2_success_metadata(active.temporary_dir)
            verify_run(active.temporary_dir)
            return True
        except Exception as exc:
            code = exc.code if isinstance(exc, ServiceError) else "artifact_verification_failed"
            self._write_metadata(
                active.temporary_dir,
                status="failed",
                finished_at=time.time(),
                worker_exit_code=active.process.returncode,
                error={"code": code, "message": str(exc)},
            )
            self._retain_failure_evidence(active)
            return False

    def _replay_gate2_frozen_admission(self, active: ActiveRun) -> None:
        context = active.gate2_context
        if context is None:
            return
        captured = context["captured"]
        try:
            from .gate2_project_evidence import derive_policy_from_committed_events

            derive_policy_from_committed_events(
                self.workspace_root,
                active.project_id,
                captured["admission"]["policy_snapshot"],
                run_intent_digest=captured["intent"]["run_intent_digest"],
                run_admission_digest=captured["admission"]["run_admission_digest"],
            )
        except Exception as exc:
            raise ServiceError(
                500, "terminal_policy_evidence_drift",
                f"frozen admission evidence no longer replays exactly: {exc}",
            ) from exc

    def _apply_gate2_cancel_outcome(self, active: ActiveRun, status: str) -> None:
        context = active.gate2_context
        if context is None or self._gate2_cancel_tombstone(context["captured"]) is None:
            return
        outcome = {
            "succeeded": "completed_before_cancel_effect",
            "failed": "failed_before_cancel_effect",
            "timed_out": "timed_out_before_cancel_effect",
            "cancelled": "cancelled_by_worker",
        }.get(status)
        if outcome is not None:
            self._write_metadata(active.temporary_dir, cancel_outcome=outcome)

    def _finalize_gate2_success_metadata(self, run_dir: Path) -> None:
        """Seal parent-owned run.log plus all eight exact successful artifacts."""

        from .canonical_v2 import canonical_json_v2_bytes

        names = {
            "request.json", "metadata.json", "daily-kpis.csv", "domain-events.jsonl",
            "summary.json", "replay-manifest.json", "derived-views-manifest.json", "run.log",
        }
        if {path.name for path in run_dir.iterdir()} != names:
            raise ServiceError(500, "mesa_run_corrupt", "Gate 2 successful artifact set is not exact")
        metadata = self._read_workspace_json(run_dir / "metadata.json")
        digests = metadata.get("digests")
        if not isinstance(digests, dict):
            raise ServiceError(500, "mesa_run_corrupt", "Gate 2 metadata digest map is unavailable")
        artifact_sha256 = {
            name: hashlib.sha256((run_dir / name).read_bytes()).hexdigest()
            for name in sorted(names - {"metadata.json"})
        }
        artifact_sha256["metadata.json"] = ""
        digests["run_log_sha256"] = artifact_sha256["run.log"]
        digests["artifact_sha256"] = artifact_sha256
        for _ in range(8):
            metadata["artifact_bytes"] = {
                name: (run_dir / name).stat().st_size for name in sorted(names)
            }
            projection = json.loads(json.dumps(metadata))
            projection["digests"]["artifact_sha256"]["metadata.json"] = ""
            artifact_sha256["metadata.json"] = hashlib.sha256(canonical_json_v2_bytes(projection)).hexdigest()
            self._write_workspace_bytes(run_dir / "metadata.json", canonical_json_v2_bytes(metadata))
            if metadata["artifact_bytes"]["metadata.json"] == (run_dir / "metadata.json").stat().st_size:
                break
        else:
            raise ServiceError(500, "mesa_run_corrupt", "Gate 2 metadata size seal did not stabilize")

    def poll(self) -> None:
        if not self._poll_lock.acquire(blocking=False):
            return
        try:
            self._poll_unlocked()
        finally:
            self._poll_lock.release()

    def _poll_unlocked(self) -> None:
        for active in list(self.active_runs.values()):
            if active.gate2_context is not None and not self._renew_gate2_owner_lease(active):
                continue
            timed_out = (
                int(time.time() * 1000) >= active.gate2_context["deadline_at_unix_ms"]
                if active.gate2_context is not None
                else time.monotonic() - active.started_monotonic > active.timeout_seconds
            )
            if active.process.poll() is None and timed_out:
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
            if active.gate2_context is not None:
                context = active.gate2_context
                with self._run_lock(context["project_dir"], active.run_id):
                    lease = self._assert_gate2_owner_lease(active, require_live_child=False)
                    self._write_gate2_owner_lease(
                        self._safe_path(context["project_dir"] / "mesa-run-lifecycle" / active.run_id / "owner-lease.json"),
                        context["receipt"], ownership_epoch=context["ownership_epoch"], prior=lease,
                        lease_seconds=max(60.0, self.owner_lease_seconds),
                    )
            self._close_log(active)
            metadata = self._read_workspace_json(active.temporary_dir / "metadata.json")
            status = metadata.get("status")
            if active.model_id == WIND_MODEL_ID:
                success = return_code == 0 and status == "succeeded"
                if success and self._wind_success_is_valid(active):
                    if active.gate2_context is not None:
                        with self._run_lock(active.gate2_context["project_dir"], active.run_id):
                            self._promote(active)
                            self._append_gate2_terminal_for_active(active, "succeeded")
                    else:
                        self._append_gate2_terminal_for_active(active, "succeeded")
                        self._promote(active)
                    continue
                status = self._read_workspace_json(active.temporary_dir / "metadata.json").get("status")
                if status not in TERMINAL or status == "succeeded":
                    self._write_metadata(
                        active.temporary_dir,
                        status="failed",
                        finished_at=time.time(),
                        worker_exit_code=return_code,
                        error={"code": "worker_failed", "message": "wind worker exited without verified artifacts"},
                    )
                terminal_status = self._read_workspace_json(active.temporary_dir / "metadata.json").get("status")
                if terminal_status not in {"failed", "timed_out", "cancelled"}:
                    terminal_status = "failed"
                if active.gate2_context is not None:
                    self._apply_gate2_cancel_outcome(active, terminal_status)
                self._retain_failure_evidence(active)
                if active.gate2_context is not None:
                    with self._run_lock(active.gate2_context["project_dir"], active.run_id):
                        self._promote(active)
                        self._append_gate2_terminal_for_active(active, terminal_status)
                else:
                    self._append_gate2_terminal_for_active(active, terminal_status)
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
        project_dir = self._project_dir(project_id)
        final = self._safe_path(project_dir / "runs" / run_id)
        if not final.exists():
            receipt_dir = self._safe_path(project_dir / "mesa-run-receipts")
            if receipt_dir.is_dir():
                receipt = next(
                    (
                        item for item in (self._read_gate2_receipt(path) for path in sorted(receipt_dir.iterdir()))
                        if item is not None and item["run_id"] == run_id
                    ),
                    None,
                )
                if receipt is not None:
                    self.start_wind_run_v2(
                        project_id, {"experiment_revision_id": receipt["experiment_revision_id"]},
                        downstream_key=receipt["downstream_idempotency_key"], run_id=run_id,
                        downstream_digest=receipt["downstream_request_digest"],
                    )
                    active = self.active_runs.get(run_id)
                    pending = self._safe_path(project_dir / ".pending" / run_id / "metadata.json")
                    if active is not None or pending.is_file():
                        metadata = self._read_workspace_json(active.temporary_dir / "metadata.json" if active else pending)
                        return {**metadata, "status": "running"}
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
        if active.gate2_context is not None:
            context = active.gate2_context
            with self._run_lock(context["project_dir"], run_id):
                tombstone = self._gate2_cancel_tombstone(context["captured"])
                if tombstone is None:
                    raise ServiceError(409, "cancel_tombstone_required", "a committed backend cancel tombstone is required")
                records = self._read_gate2_lifecycle(context["lifecycle"], context["receipt"])
                if records[-1]["ownership_epoch"] != context["ownership_epoch"] or records[-1]["owner_instance_id"] != self.owner_instance_id:
                    context["ownership_epoch"] = records[-1]["ownership_epoch"] + 1
                    self._append_gate2_lifecycle(
                        context["lifecycle"], context["receipt"], "ownership_acquired",
                        ownership_epoch=context["ownership_epoch"],
                    )
                    records = self._read_gate2_lifecycle(context["lifecycle"], context["receipt"])
                if not any(record["state"] == "cancel_requested" for record in records):
                    self._append_gate2_lifecycle(
                        context["lifecycle"], context["receipt"], "cancel_requested",
                        ownership_epoch=context["ownership_epoch"],
                        evidence_digest=tombstone["cancel_tombstone_digest"],
                    )
                if active.process.poll() is not None:
                    # A natural terminal outcome wins a cancellation race.
                    pass
                else:
                    self._terminate(active, "cancelled", "simulation cancelled", gate2_lock_held=True)
        else:
            self._terminate(active, "cancelled", "simulation cancelled")
        self.poll()
        return self._metadata(project_id, run_id)

    def cancel_wind_run_v2(self, project_id: str, run_id: str) -> dict[str, Any]:
        self.poll()
        project_dir = self._project_dir(project_id)
        receipt_dir = self._safe_path(project_dir / "mesa-run-receipts")
        if not receipt_dir.is_dir():
            raise ServiceError(404, "run_not_found", "Gate 2 run receipt not found")
        receipts = [self._read_gate2_receipt(path) for path in sorted(receipt_dir.iterdir())]
        receipt = next((item for item in receipts if item is not None and item["run_id"] == run_id), None)
        if receipt is None:
            raise ServiceError(404, "run_not_found", "Gate 2 run receipt not found")
        captured = self._capture_gate2_inputs(
            project_id, {"experiment_revision_id": receipt["experiment_revision_id"]},
            downstream_key=receipt["downstream_idempotency_key"], run_id=run_id,
            downstream_digest=receipt["downstream_request_digest"],
        )
        if self._gate2_cancel_tombstone(captured) is None:
            raise ServiceError(409, "cancel_tombstone_required", "a committed backend cancel tombstone is required")
        active = self.active_runs.get(run_id)
        if active is None:
            try:
                return self._metadata(project_id, run_id)
            except ServiceError as exc:
                if exc.code != "run_not_found":
                    raise
            # Receipt-only accepted work converges through the normal idempotent dispatcher.
            self.start_wind_run_v2(
                project_id, {"experiment_revision_id": receipt["experiment_revision_id"]},
                downstream_key=receipt["downstream_idempotency_key"], run_id=run_id,
                downstream_digest=receipt["downstream_request_digest"],
            )
            if run_id not in self.active_runs:
                return self._metadata(project_id, run_id)
        return self.cancel_run(project_id, run_id)

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
            if active.gate2_context is not None and self._gate2_cancel_tombstone(active.gate2_context["captured"]) is None:
                self._terminate(active, "failed", "service shutdown before terminal evidence")
            else:
                self._terminate(active, "cancelled", "service shutdown")
