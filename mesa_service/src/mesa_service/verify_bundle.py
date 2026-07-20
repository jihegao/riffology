"""Fail-closed verifier for an installed wind model revision bundle."""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import sys
from pathlib import Path
from typing import Any

from .bundle import EXPECTED_FILES, model_revision_id
from .wind_contracts import MODEL_ID, canonical_json_bytes, load_json_asset, runtime_profile, validate_experiment_document


class BundleVerificationError(ValueError):
    """Installed model evidence does not match the reviewed source bundle."""


def _read_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BundleVerificationError(f"invalid JSON: {path.name}") from exc
    if not isinstance(value, dict):
        raise BundleVerificationError(f"JSON must be an object: {path.name}")
    return value


def _fail(message: str) -> None:
    raise BundleVerificationError(message)


def _absolute_without_resolving(path: str | Path) -> Path:
    """Make a lexical absolute path while preserving every symlink component."""

    return Path(os.path.abspath(os.fspath(path)))


def _reject_symlink_components(path: Path) -> None:
    """Reject symlinks in the bundle path and all existing ancestors."""

    lineage = [path, *path.parents]
    for candidate in reversed(lineage):
        if candidate.is_symlink():
            _fail(f"bundle path or ancestor is a symlink: {candidate}")


def verify_bundle(bundle_dir: str | Path) -> dict[str, Any]:
    """Verify identity, bytes, runtime, core source, and generated projections."""

    root = _absolute_without_resolving(bundle_dir)
    _reject_symlink_components(root)
    if not root.is_dir():
        _fail("bundle directory does not exist")
    linked_entries = [path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_symlink()]
    if linked_entries:
        _fail(f"bundle entries must not be symlinks: {sorted(linked_entries)}")
    actual_files = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file()
    }
    expected_files = {"manifest.json", *EXPECTED_FILES}
    if actual_files != expected_files:
        _fail(f"bundle files are not exact; missing={sorted(expected_files-actual_files)}, unknown={sorted(actual_files-expected_files)}")

    manifest_path = root / "manifest.json"
    manifest = _read_object(manifest_path)
    if set(manifest) != {"schema_version", "model_id", "model_revision_id", "runtime_profile", "files"}:
        _fail("manifest keys are not exact")
    if manifest["schema_version"] != 1 or manifest["model_id"] != MODEL_ID:
        _fail("manifest model identity is invalid")
    if manifest["runtime_profile"] != runtime_profile():
        _fail("manifest runtime profile does not match this execution")
    files = manifest["files"]
    if not isinstance(files, dict) or set(files) != set(EXPECTED_FILES):
        _fail("manifest file declarations are not exact")
    for relative in EXPECTED_FILES:
        declaration = files[relative]
        if not isinstance(declaration, dict) or set(declaration) != {"sha256", "byte_length", "media_type"}:
            _fail(f"manifest declaration is invalid: {relative}")
        data = (root / relative).read_bytes()
        if declaration["byte_length"] != len(data):
            _fail(f"bundle byte length drift: {relative}")
        if declaration["sha256"] != hashlib.sha256(data).hexdigest():
            _fail(f"bundle SHA-256 drift: {relative}")
    expected_revision = model_revision_id(files, manifest["runtime_profile"])
    if manifest["model_revision_id"] != expected_revision or root.name != expected_revision:
        _fail("model revision identity does not match bundle contents")

    core = importlib.import_module("mesa_service.models.wind_turbine_maintenance.model")
    source_bytes = Path(core.__file__).resolve().read_bytes()
    if (root / "model.py").read_bytes() != source_bytes:
        _fail("bundled model.py is not the reviewed installed core source")
    if getattr(core, "MODEL_SPEC_DEFINITIONS", None) != load_json_asset("model-spec.json"):
        _fail("model-spec.json drifted from code-exported model definitions")
    if getattr(core, "SOURCE_TRANSITION_DISPOSITIONS", None) != load_json_asset("traceability.json"):
        _fail("traceability.json drifted from code-exported source dispositions")
    if _read_object(root / "model-spec.json") != load_json_asset("model-spec.json"):
        _fail("installed model spec differs from the reviewed projection")
    if _read_object(root / "traceability.json") != load_json_asset("traceability.json"):
        _fail("installed traceability differs from the reviewed projection")
    if _read_object(root / "provenance.json") != load_json_asset("provenance.json"):
        _fail("installed provenance differs from the reviewed projection")
    validate_experiment_document(_read_object(root / "defaults/wind-turbine-maintenance-demo-v1.json"))

    # Canonical bytes are not required for copied source projections, but the
    # manifest itself has exactly one representation to avoid signature drift.
    if manifest_path.read_bytes() != canonical_json_bytes(manifest) + b"\n":
        _fail("manifest is not canonically encoded")
    return {
        "valid": True,
        "model_id": MODEL_ID,
        "model_revision_id": expected_revision,
        "runtime_profile": manifest["runtime_profile"],
        "verified_file_count": len(files),
    }


def main(argv: list[str] | None = None) -> int:
    """Verify one bundle from the command line and emit machine-readable JSON."""

    arguments = sys.argv[1:] if argv is None else argv
    if len(arguments) != 1:
        print("usage: python -m mesa_service.verify_bundle <bundle_dir>", file=sys.stderr)
        return 2
    try:
        result = verify_bundle(arguments[0])
    except (BundleVerificationError, OSError, ValueError, RuntimeError) as exc:
        print(f"bundle verification failed: {exc}", file=sys.stderr)
        return 1
    print(canonical_json_bytes(result).decode("utf-8"))
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised through subprocess
    raise SystemExit(main())
