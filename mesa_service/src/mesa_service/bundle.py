"""Materialize the reviewed wind model as content-addressed local evidence."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from .wind_contracts import (
    ASSET_ROOT,
    MODEL_ID,
    PRESET_ID,
    build_experiment_document,
    canonical_json_bytes,
    runtime_profile,
)


ASSET_FILES = (
    "model-spec.json",
    "parameter-schema.json",
    "metric-schema.json",
    "visualization.json",
    "traceability.json",
    "provenance.json",
    "defaults/source-field-service-reference.json",
    "defaults/wind-turbine-maintenance-demo-v1.json",
    "tests/microcase.json",
    "tests/source-transition-disposition.json",
)
EXPECTED_FILES = ("model.py", *ASSET_FILES)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _media_type(relative: str) -> str:
    return "text/x-python" if relative.endswith(".py") else "application/json"


def _core_model_path() -> Path:
    return Path(__file__).resolve().parent / "models" / "wind_turbine_maintenance" / "model.py"


def reviewed_source_files() -> dict[str, Path]:
    """Resolve the exact reviewed source set; arbitrary caller paths are impossible."""

    sources = {relative: ASSET_ROOT / relative for relative in ASSET_FILES}
    sources["model.py"] = _core_model_path()
    missing = [relative for relative, path in sources.items() if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"reviewed wind bundle sources are missing: {sorted(missing)}")
    return {relative: sources[relative] for relative in EXPECTED_FILES}


def manifest_entries() -> dict[str, dict[str, Any]]:
    entries: dict[str, dict[str, Any]] = {}
    for relative, source in reviewed_source_files().items():
        data = source.read_bytes()
        entries[relative] = {
            "sha256": _sha256(data),
            "byte_length": len(data),
            "media_type": _media_type(relative),
        }
    return entries


def model_revision_id(files: dict[str, dict[str, Any]], profile: dict[str, str]) -> str:
    digest_input = {"model_id": MODEL_ID, "runtime_profile": profile, "files": files}
    return "mr_" + _sha256(canonical_json_bytes(digest_input))


def experiment_revision_id(document: dict[str, Any]) -> str:
    return "er_" + _sha256(canonical_json_bytes(document))


def _write_canonical_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_json_bytes(value) + b"\n")


def _absolute_without_resolving(path: str | Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _reject_symlink_components(path: Path) -> None:
    for candidate in reversed([path, *path.parents]):
        if candidate.is_symlink():
            raise RuntimeError(f"bundle workspace path or ancestor is a symlink: {candidate}")


def _install_bundle(target: Path, manifest: dict[str, Any], sources: dict[str, Path]) -> None:
    _reject_symlink_components(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    _reject_symlink_components(target)
    if target.exists():
        return
    staging = Path(tempfile.mkdtemp(prefix=".wind-bundle-", dir=target.parent))
    try:
        for relative, source in sources.items():
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        _write_canonical_json(staging / "manifest.json", manifest)
        try:
            os.replace(staging, target)
        except OSError:
            if not target.exists():
                raise
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def materialize_reviewed_bundle(workspace_root: str | Path) -> dict[str, Any]:
    """Install and verify one immutable model and experiment revision."""

    root = _absolute_without_resolving(workspace_root)
    _reject_symlink_components(root)
    sources = reviewed_source_files()
    files = manifest_entries()
    profile = runtime_profile()
    revision_id = model_revision_id(files, profile)
    manifest = {
        "schema_version": 1,
        "model_id": MODEL_ID,
        "model_revision_id": revision_id,
        "runtime_profile": profile,
        "files": files,
    }
    bundle_dir = root / "models" / MODEL_ID / "revisions" / revision_id
    _install_bundle(bundle_dir, manifest, sources)

    # Import lazily to avoid a bundle<->verifier import cycle at module load.
    from .verify_bundle import verify_bundle

    verify_bundle(bundle_dir)
    experiment = build_experiment_document(revision_id)
    experiment_id = experiment_revision_id(experiment)
    experiment_dir = root / "experiments" / "revisions" / experiment_id
    experiment_path = experiment_dir / "experiment.json"
    _reject_symlink_components(experiment_path)
    if experiment_path.exists():
        existing = json.loads(experiment_path.read_text(encoding="utf-8"))
        if existing != experiment:
            raise RuntimeError("content-addressed experiment revision contains different data")
    else:
        experiment_dir.mkdir(parents=True, exist_ok=True)
        _reject_symlink_components(experiment_path)
        _write_canonical_json(experiment_path, experiment)

    return {
        "model_id": MODEL_ID,
        "model_revision_id": revision_id,
        "experiment_revision_id": experiment_id,
        "preset_id": PRESET_ID,
        "bundle_dir": str(bundle_dir),
        "experiment_dir": str(experiment_dir),
        "manifest": manifest,
        "experiment": experiment,
        "runtime_profile": profile,
    }
