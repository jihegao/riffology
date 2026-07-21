"""Fail-closed verifier for an installed wind model revision bundle."""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import sys
import types
import uuid
from pathlib import Path
from typing import Any

from .bundle import EXPECTED_FILES, model_revision_id
from .canonical_v2 import canonical_json_v2_bytes, require_canonical_json_v2_bytes
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
    manifest_path = root / "manifest.json"
    manifest = _read_object(manifest_path)
    legacy_root = {"schema_version", "model_id", "model_revision_id", "runtime_profile", "files"}
    framed_root = {"schema_version", "bundle_protocol", "model_id", "model_revision_id", "runtime_profile", "files"}
    root_keys = set(manifest)
    if root_keys == legacy_root:
        branch = "legacy"
        expected_bundle_files = EXPECTED_FILES
    elif root_keys == framed_root:
        branch = "framed"
        from .gate3_bundle import FRAMED_FILES
        expected_bundle_files = FRAMED_FILES
    else:
        _fail("manifest keys do not select an exact legacy/framed branch")
    expected_files = {"manifest.json", *expected_bundle_files}
    if actual_files != expected_files:
        _fail(f"bundle files are not exact; missing={sorted(expected_files-actual_files)}, unknown={sorted(actual_files-expected_files)}")

    if manifest["model_id"] != MODEL_ID:
        _fail("manifest model identity is invalid")
    if branch == "legacy":
        if manifest["schema_version"] != 1 or manifest["runtime_profile"] != runtime_profile():
            _fail("legacy manifest runtime/profile identity is invalid")
    else:
        from .gate3_bundle import BUNDLE_PROTOCOL, actual_runtime_is_framed_compatible, framed_runtime_profile
        if (
            manifest["schema_version"] != 2
            or manifest["bundle_protocol"] != BUNDLE_PROTOCOL
            or manifest["runtime_profile"] != framed_runtime_profile()
            or not actual_runtime_is_framed_compatible()
        ):
            _fail("framed manifest runtime/profile identity is invalid")
    files = manifest["files"]
    if not isinstance(files, dict) or set(files) != set(expected_bundle_files):
        _fail("manifest file declarations are not exact")
    for relative in expected_bundle_files:
        declaration = files[relative]
        if not isinstance(declaration, dict) or set(declaration) != {"sha256", "byte_length", "media_type"}:
            _fail(f"manifest declaration is invalid: {relative}")
        data = (root / relative).read_bytes()
        if branch == "framed" and relative.endswith(".json"):
            try:
                if not data.endswith(b"\n") or data[:-1].endswith(b"\n"):
                    raise ValueError("framed JSON must end in exactly one LF")
                require_canonical_json_v2_bytes(data[:-1])
            except Exception as exc:
                raise BundleVerificationError(
                    f"framed JSON is not exact canonical-v2 plus one LF: {relative}",
                ) from exc
        if declaration["byte_length"] != len(data):
            _fail(f"bundle byte length drift: {relative}")
        if declaration["sha256"] != hashlib.sha256(data).hexdigest():
            _fail(f"bundle SHA-256 drift: {relative}")
    if branch == "legacy":
        expected_revision = model_revision_id(files, manifest["runtime_profile"])
    else:
        from .gate3_bundle import framed_revision_id
        expected_revision = framed_revision_id(files)
    if manifest["model_revision_id"] != expected_revision or root.name != expected_revision:
        _fail("model revision identity does not match bundle contents")

    if branch == "legacy":
        core = importlib.import_module("mesa_service.models.wind_turbine_maintenance.model")
        source_bytes = Path(core.__file__).resolve().read_bytes()
    else:
        from .gate3_bundle import framed_source_bytes

        source_bytes = framed_source_bytes()["model.py"]
        module_name = f"riff_verified_framed_bundle_model_{uuid.uuid4().hex}"
        core = types.ModuleType(module_name)
        core.__file__ = str(root / "model.py")
        core.__package__ = ""
        previous = sys.modules.get(module_name)
        sys.modules[module_name] = core
        try:
            exec(compile(source_bytes, str(root / "model.py"), "exec"), core.__dict__)
        except Exception as exc:
            raise BundleVerificationError("framed model.py is not self-contained executable source") from exc
        finally:
            if previous is None:
                sys.modules.pop(module_name, None)
            else:
                sys.modules[module_name] = previous
    if (root / "model.py").read_bytes() != source_bytes:
        _fail("bundled model.py is not the reviewed installed core source")
    installed_spec = _read_object(root / "model-spec.json")
    if getattr(core, "MODEL_SPEC_DEFINITIONS", None) != installed_spec:
        _fail("model-spec.json drifted from code-exported model definitions")
    if getattr(core, "SOURCE_TRANSITION_DISPOSITIONS", None) != load_json_asset("traceability.json"):
        _fail("traceability.json drifted from code-exported source dispositions")
    if branch == "legacy" and installed_spec != load_json_asset("model-spec.json"):
        _fail("installed model spec differs from the reviewed projection")
    if _read_object(root / "traceability.json") != load_json_asset("traceability.json"):
        _fail("installed traceability differs from the reviewed projection")
    if _read_object(root / "provenance.json") != load_json_asset("provenance.json"):
        _fail("installed provenance differs from the reviewed projection")
    validate_experiment_document(_read_object(root / "defaults/wind-turbine-maintenance-demo-v1.json"))
    if branch == "framed":
        from .gate3_contracts import validate_execution_values, validate_framed_parameter_sources
        validate_framed_parameter_sources(
            _read_object(root / "parameter-schema.json"),
            _read_object(root / "defaults/wind-turbine-maintenance-demo-v1.json"),
        )
        execution_schema = _read_object(root / "execution-field-schema.json")
        preset = _read_object(root / "defaults/wind-turbine-maintenance-demo-v1.json")
        validate_execution_values(
            {key: preset[key] for key in ("horizon_days", "warmup_days", "seed")},
            execution_schema,
        )

    # Legacy projections retain their original byte contract. Every framed JSON
    # projection and the manifest have exactly one canonical representation.
    expected_manifest_bytes = (
        canonical_json_bytes(manifest) if branch == "legacy" else canonical_json_v2_bytes(manifest)
    ) + b"\n"
    if manifest_path.read_bytes() != expected_manifest_bytes:
        _fail("manifest is not canonically encoded")
    return {
        "valid": True,
        "model_id": MODEL_ID,
        "model_revision_id": expected_revision,
        "runtime_profile": manifest["runtime_profile"],
        "verified_file_count": len(files),
        "bundle_branch": branch,
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
