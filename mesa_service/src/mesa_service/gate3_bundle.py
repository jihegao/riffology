"""Strict Gate 3 framed bundle materialization and source descriptors."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import tempfile
from pathlib import Path
from typing import Any

import mesa

from .canonical_v2 import canonical_json_v2_bytes, sha256_v2, strict_json_loads_v2
from .wind_contracts import ASSET_ROOT, MODEL_ID, PRESET_ID


BUNDLE_PROTOCOL = "wind-turbine-maintenance-bundle-v2-framed"
MODEL_PROTOCOL_VERSION = "wind-turbine-maintenance-v2-framed-replay"
FRAMED_ASSET_ROOT = Path(__file__).resolve().parent / "model_assets" / "wind_turbine_maintenance_framed"
FRAMED_FILES = (
    "model.py", "model-spec.json", "parameter-schema.json", "execution-field-schema.json",
    "metric-schema.json", "visualization.json", "traceability.json", "provenance.json",
    "defaults/source-field-service-reference.json", "defaults/wind-turbine-maintenance-demo-v1.json",
    "tests/microcase.json", "tests/source-transition-disposition.json",
)


def framed_runtime_profile() -> dict[str, str]:
    return {
        "canonical_json_version": "riff-canonical-json-v2",
        "mesa_version": "3.5.1",
        "model_protocol_version": MODEL_PROTOCOL_VERSION,
        "python_implementation": "CPython",
        "python_major_minor": "3.12",
    }


def actual_runtime_is_framed_compatible() -> bool:
    return (
        platform.python_implementation() == "CPython"
        and f"{platform.python_version_tuple()[0]}.{platform.python_version_tuple()[1]}" == "3.12"
        and mesa.__version__ == "3.5.1"
    )


def framed_source_files() -> dict[str, Path]:
    common = {
        relative: ASSET_ROOT / relative
        for relative in FRAMED_FILES
        if relative not in {"model.py", "model-spec.json", "parameter-schema.json", "execution-field-schema.json"}
    }
    common.update({
        # This is an appendix, not the delivered model by itself.  The exact
        # delivered bytes are produced by ``framed_source_bytes`` below.
        "model.py": Path(__file__).resolve().parent / "models" / "wind_turbine_maintenance" / "framed_model.py",
        "model-spec.json": FRAMED_ASSET_ROOT / "model-spec.json",
        "parameter-schema.json": FRAMED_ASSET_ROOT / "parameter-schema.json",
        "execution-field-schema.json": FRAMED_ASSET_ROOT / "execution-field-schema.json",
    })
    missing = sorted(name for name, path in common.items() if not path.is_file())
    if missing:
        raise FileNotFoundError(f"framed source files are missing: {missing}")
    return {name: common[name] for name in FRAMED_FILES}


def framed_source_bytes() -> dict[str, bytes]:
    """Return the exact self-contained twelve-file candidate source set."""

    paths = framed_source_files()
    legacy_model = Path(__file__).resolve().parent / "models" / "wind_turbine_maintenance" / "model.py"
    model_bytes = legacy_model.read_bytes()
    appendix = paths["model.py"].read_bytes()
    if not model_bytes.endswith(b"\n"):
        raise RuntimeError("legacy model source must end with LF")
    if b"mesa_service." in appendix or b"from mesa_service" in appendix or b"import mesa_service" in appendix:
        raise RuntimeError("framed appendix has an undeclared installed-package dependency")
    result: dict[str, bytes] = {}
    for name, path in paths.items():
        if name == "model.py":
            continue
        value = strict_json_loads_v2(path.read_bytes())
        result[name] = canonical_json_v2_bytes(value) + b"\n"
    result["model.py"] = model_bytes + b"\n" + appendix
    return {name: result[name] for name in FRAMED_FILES}


def _media_type(name: str) -> str:
    return "text/x-python" if name == "model.py" else "application/json"


def framed_file_map() -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for name, data in framed_source_bytes().items():
        result[name] = {"sha256": hashlib.sha256(data).hexdigest(), "byte_length": len(data), "media_type": _media_type(name)}
    return result


def framed_revision_id(files: dict[str, dict[str, Any]] | None = None) -> str:
    preimage = {
        "schema_version": 2,
        "bundle_protocol": BUNDLE_PROTOCOL,
        "model_id": MODEL_ID,
        "runtime_profile": framed_runtime_profile(),
        "files": files or framed_file_map(),
    }
    return "mr_" + hashlib.sha256(canonical_json_v2_bytes(preimage)).hexdigest()


def framed_manifest() -> dict[str, Any]:
    files = framed_file_map()
    return {
        "schema_version": 2,
        "bundle_protocol": BUNDLE_PROTOCOL,
        "model_id": MODEL_ID,
        "model_revision_id": framed_revision_id(files),
        "runtime_profile": framed_runtime_profile(),
        "files": files,
    }


def source_descriptor() -> dict[str, Any]:
    manifest = framed_manifest()
    files = manifest["files"]
    core = {
        "candidate_source_revision": "wsrc_" + sha256_v2({"manifest": manifest, "source_contract": "gate3-reviewed-framed-v1"}),
        "candidate_bundle_protocol": BUNDLE_PROTOCOL,
        "candidate_manifest_sha256": hashlib.sha256(canonical_json_v2_bytes(manifest) + b"\n").hexdigest(),
        "candidate_file_map_sha256": hashlib.sha256(canonical_json_v2_bytes(files)).hexdigest(),
        "candidate_model_revision_id": manifest["model_revision_id"],
    }
    return {**core, "candidate_source_descriptor_digest": "wsrcd_" + sha256_v2(core)}


def materialize_framed_bundle(target: Path) -> dict[str, Any]:
    if not actual_runtime_is_framed_compatible():
        raise RuntimeError("incompatible_framed_runtime")
    manifest = framed_manifest()
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        staging = Path(tempfile.mkdtemp(prefix=".wind-framed-bundle-", dir=target.parent))
        try:
            for relative, data in framed_source_bytes().items():
                destination = staging / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
            (staging / "manifest.json").write_bytes(canonical_json_v2_bytes(manifest) + b"\n")
            os.replace(staging, target)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    from .verify_bundle import verify_bundle
    verified = verify_bundle(target)
    if verified["model_revision_id"] != manifest["model_revision_id"]:
        raise RuntimeError("framed materialization revision mismatch")
    return {"bundle_dir": str(target), "manifest": manifest, "model_revision_id": manifest["model_revision_id"], "preset_id": PRESET_ID}


def load_framed_json_source(name: str) -> Any:
    if name not in FRAMED_FILES or not name.endswith(".json"):
        raise KeyError(name)
    return json.loads(framed_source_bytes()[name])
