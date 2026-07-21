"""Project-bound, idempotent Mesa side of the Gate 3 activation protocol."""

from __future__ import annotations

import fcntl
import base64
import hashlib
import os
import re
import shutil
import struct
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import mesa

from .canonical_v2 import canonical_json_v2_bytes, prefixed_digest, require_canonical_json_v2_bytes, sha256_v2
from .gate3_bundle import (
    BUNDLE_PROTOCOL,
    FRAMED_FILES,
    MODEL_PROTOCOL_VERSION,
    actual_runtime_is_framed_compatible,
    framed_manifest,
    framed_runtime_profile,
    materialize_framed_bundle,
    source_descriptor,
)
from .wind_contracts import MODEL_ID, PRESET_ID


UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
DIGEST = re.compile(r"^[a-z]+_[0-9a-f]{64}$")
INTERNAL_ACTIVATION_PROTOCOL = "wind-activation-v1"
INTERNAL_HANDSHAKE_PROTOCOL = "wind-runtime-handshake-v1"


class ActivationProtocolError(RuntimeError):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _write_exact(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _write_record(path: Path, value: dict[str, Any]) -> None:
    _write_exact(path, canonical_json_v2_bytes(value) + b"\n")


def _read_record(path: Path) -> dict[str, Any]:
    try:
        data = path.read_bytes()
        if not data.endswith(b"\n"):
            raise ValueError("missing LF")
        value = require_canonical_json_v2_bytes(data[:-1])
    except Exception as exc:
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored activation evidence is invalid") from exc
    if not isinstance(value, dict):
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored activation evidence is invalid")
    return value


CANDIDATE_RECEIPT_KEYS = {
    "schema_id", "schema_version", "canonical_json_version", "activation_id", "project_id",
    "intent_digest", "expected_old_model_revision_id", "candidate_descriptor_digest",
    "target_model_revision_id", "bundle_protocol", "manifest_sha256", "files",
    "file_map_sha256", "candidate_bytes_digest", "created_at", "candidate_receipt_digest",
}
CAS_REQUEST_KEYS = {
    "schema_id", "schema_version", "canonical_json_version", "activation_id", "project_id",
    "expected_old_model_revision_id", "target_model_revision_id", "candidate_receipt_digest",
    "project_event_digest",
}
SWITCH_RECEIPT_KEYS = {
    "schema_id", "schema_version", "canonical_json_version", "activation_id", "project_id",
    "expected_old_model_revision_id", "target_model_revision_id", "candidate_receipt_digest",
    "project_event_digest", "previous_active_model_revision_id", "active_model_revision_id",
    "switched_at", "switch_receipt_digest",
}
CANDIDATE_DESCRIPTOR_KEYS = {
    "schema_id", "schema_version", "canonical_json_version", "project_id",
    "runtime_handshake_digest", "expected_active_model_revision_id", "candidate_source_revision",
    "model_id", "model_revision_id", "bundle_protocol", "manifest_sha256", "file_map_sha256",
    "runtime_profile", "preset_id", "preset_sha256", "provenance_sha256", "descriptor_digest",
}
RUNTIME_FACT_KEYS = {
    "actual_python_implementation", "actual_python_major_minor", "actual_mesa_version",
    "model_protocol_version", "candidate_source_revision", "candidate_bundle_protocol",
    "candidate_manifest_sha256", "candidate_file_map_sha256", "candidate_source_descriptor_digest",
}
RUNTIME_INSTANCE_EVIDENCE_KEYS = {
    "schema_id", "schema_version", "canonical_json_version", "project_id", "runtime_instance_id",
    *RUNTIME_FACT_KEYS, "recorded_at", "runtime_instance_evidence_digest",
}
AUTHORITATIVE_HANDSHAKE_KEYS = {
    "schema_id", "schema_version", "canonical_json_version", "activation_id", "project_id",
    "materialize_request_sha256", "candidate_descriptor_digest", "runtime_instance_id",
    "runtime_instance_evidence_digest", "runtime_handshake_digest", "active_model_revision_id",
    *RUNTIME_FACT_KEYS, "captured_at", "authoritative_handshake_digest",
}


def _validate_candidate_receipt(value: Any, *, project_id: str, activation_id: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != CANDIDATE_RECEIPT_KEYS:
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored candidate receipt keyset is invalid")
    if (
        value["schema_id"] != "riff://mesa-wind/candidate-receipt/v1"
        or value["schema_version"] != 1
        or value["canonical_json_version"] != "riff-canonical-json-v2"
        or value["project_id"] != project_id
        or value["activation_id"] != activation_id
        or UUID.fullmatch(activation_id) is None
        or re.fullmatch(r"aint_[0-9a-f]{64}", str(value["intent_digest"])) is None
        or re.fullmatch(r"mr_[0-9a-f]{64}", str(value["expected_old_model_revision_id"])) is None
        or re.fullmatch(r"cand_[0-9a-f]{64}", str(value["candidate_descriptor_digest"])) is None
        or re.fullmatch(r"mr_[0-9a-f]{64}", str(value["target_model_revision_id"])) is None
        or value["bundle_protocol"] != BUNDLE_PROTOCOL
        or re.fullmatch(r"[0-9a-f]{64}", str(value["manifest_sha256"])) is None
        or not isinstance(value["files"], dict) or set(value["files"]) != set(FRAMED_FILES)
        or re.fullmatch(r"[0-9a-f]{64}", str(value["file_map_sha256"])) is None
        or re.fullmatch(r"[0-9a-f]{64}", str(value["candidate_bytes_digest"])) is None
        or not isinstance(value["created_at"], str) or not value["created_at"]
        or value["candidate_receipt_digest"] != prefixed_digest(value, field="candidate_receipt_digest", prefix="acand_")
    ):
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored candidate receipt binding is invalid")
    return value


def _validate_candidate_descriptor(value: Any, *, project_id: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != CANDIDATE_DESCRIPTOR_KEYS:
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored candidate descriptor keyset is invalid")
    if (
        value["schema_id"] != "riff://evidence-studio/framed-candidate-descriptor/v1"
        or value["schema_version"] != 1
        or value["canonical_json_version"] != "riff-canonical-json-v2"
        or value["project_id"] != project_id
        or re.fullmatch(r"rh_[0-9a-f]{64}", str(value["runtime_handshake_digest"])) is None
        or re.fullmatch(r"mr_[0-9a-f]{64}", str(value["expected_active_model_revision_id"])) is None
        or re.fullmatch(r"wsrc_[0-9a-f]{64}", str(value["candidate_source_revision"])) is None
        or value["model_id"] != MODEL_ID
        or re.fullmatch(r"mr_[0-9a-f]{64}", str(value["model_revision_id"])) is None
        or value["bundle_protocol"] != BUNDLE_PROTOCOL
        or re.fullmatch(r"[0-9a-f]{64}", str(value["manifest_sha256"])) is None
        or re.fullmatch(r"[0-9a-f]{64}", str(value["file_map_sha256"])) is None
        or value["runtime_profile"] != framed_runtime_profile()
        or value["preset_id"] != PRESET_ID
        or re.fullmatch(r"[0-9a-f]{64}", str(value["preset_sha256"])) is None
        or re.fullmatch(r"[0-9a-f]{64}", str(value["provenance_sha256"])) is None
        or value["descriptor_digest"] != prefixed_digest(value, field="descriptor_digest", prefix="cand_")
    ):
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored candidate descriptor binding is invalid")
    return value


def _validate_runtime_instance_evidence(value: Any, *, project_id: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != RUNTIME_INSTANCE_EVIDENCE_KEYS:
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored runtime instance evidence keyset is invalid")
    if (
        value["schema_id"] != "riff://mesa-wind/runtime-instance-evidence/v1"
        or value["schema_version"] != 1
        or value["canonical_json_version"] != "riff-canonical-json-v2"
        or value["project_id"] != project_id
        or re.fullmatch(r"runtime_[0-9a-f]{32}", str(value["runtime_instance_id"])) is None
        or not all(isinstance(value[key], str) and value[key] for key in RUNTIME_FACT_KEYS)
        or re.fullmatch(r"wsrc_[0-9a-f]{64}", str(value["candidate_source_revision"])) is None
        or value["candidate_bundle_protocol"] != BUNDLE_PROTOCOL
        or any(
            re.fullmatch(r"[0-9a-f]{64}", str(value[key])) is None
            for key in ("candidate_manifest_sha256", "candidate_file_map_sha256")
        )
        or re.fullmatch(r"wsrcd_[0-9a-f]{64}", str(value["candidate_source_descriptor_digest"])) is None
        or not isinstance(value["recorded_at"], str) or not value["recorded_at"]
        or value["runtime_instance_evidence_digest"]
        != prefixed_digest(value, field="runtime_instance_evidence_digest", prefix="rie_")
    ):
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored runtime instance evidence is invalid")
    return value


def _validate_authoritative_handshake(value: Any, *, project_id: str, activation_id: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != AUTHORITATIVE_HANDSHAKE_KEYS:
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored authoritative handshake keyset is invalid")
    if (
        value["schema_id"] != "riff://mesa-wind/materialize-authoritative-handshake/v1"
        or value["schema_version"] != 1
        or value["canonical_json_version"] != "riff-canonical-json-v2"
        or value["project_id"] != project_id
        or value["activation_id"] != activation_id
        or re.fullmatch(r"runtime_[0-9a-f]{32}", str(value["runtime_instance_id"])) is None
        or re.fullmatch(r"rie_[0-9a-f]{64}", str(value["runtime_instance_evidence_digest"])) is None
        or re.fullmatch(r"rh_[0-9a-f]{64}", str(value["runtime_handshake_digest"])) is None
        or re.fullmatch(r"mr_[0-9a-f]{64}", str(value["active_model_revision_id"])) is None
        or re.fullmatch(r"cand_[0-9a-f]{64}", str(value["candidate_descriptor_digest"])) is None
        or re.fullmatch(r"[0-9a-f]{64}", str(value["materialize_request_sha256"])) is None
        or not all(isinstance(value[key], str) and value[key] for key in RUNTIME_FACT_KEYS)
        or re.fullmatch(r"wsrc_[0-9a-f]{64}", str(value["candidate_source_revision"])) is None
        or value["candidate_bundle_protocol"] != BUNDLE_PROTOCOL
        or any(
            re.fullmatch(r"[0-9a-f]{64}", str(value[key])) is None
            for key in ("candidate_manifest_sha256", "candidate_file_map_sha256")
        )
        or re.fullmatch(r"wsrcd_[0-9a-f]{64}", str(value["candidate_source_descriptor_digest"])) is None
        or not isinstance(value["captured_at"], str) or not value["captured_at"]
        or value["authoritative_handshake_digest"]
        != prefixed_digest(value, field="authoritative_handshake_digest", prefix="ahe_")
    ):
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored authoritative handshake is invalid")
    handshake = {
        "schema_id": "riff://mesa-wind/runtime-candidate-handshake/v1",
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_id": project_id,
        "runtime_instance_id": value["runtime_instance_id"],
        **{key: value[key] for key in RUNTIME_FACT_KEYS},
        "active_model_revision_id": value["active_model_revision_id"],
        "handshake_digest": "",
    }
    handshake["handshake_digest"] = prefixed_digest(handshake, field="handshake_digest", prefix="rh_")
    if handshake["handshake_digest"] != value["runtime_handshake_digest"]:
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored authoritative handshake digest is invalid")
    return value


def _validate_cas_record(value: Any, *, project_id: str, activation_id: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != CAS_REQUEST_KEYS:
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored CAS request keyset is invalid")
    if (
        value["schema_id"] != "riff://mesa-wind/active-cas-request/v1"
        or value["schema_version"] != 1
        or value["canonical_json_version"] != "riff-canonical-json-v2"
        or value["project_id"] != project_id
        or value["activation_id"] != activation_id
        or re.fullmatch(r"mr_[0-9a-f]{64}", str(value["expected_old_model_revision_id"])) is None
        or re.fullmatch(r"mr_[0-9a-f]{64}", str(value["target_model_revision_id"])) is None
        or re.fullmatch(r"acand_[0-9a-f]{64}", str(value["candidate_receipt_digest"])) is None
        or re.fullmatch(r"pe_[0-9a-f]{64}", str(value["project_event_digest"])) is None
    ):
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored CAS request binding is invalid")
    return value


def _validate_switch_receipt(value: Any, *, request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != SWITCH_RECEIPT_KEYS:
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored switch receipt keyset is invalid")
    linked = {key: value[key] for key in CAS_REQUEST_KEYS if key not in {"schema_id", "schema_version", "canonical_json_version"}}
    expected_linked = {key: request[key] for key in linked}
    if (
        value["schema_id"] != "riff://mesa-wind/active-switch-receipt/v1"
        or value["schema_version"] != 1
        or value["canonical_json_version"] != "riff-canonical-json-v2"
        or linked != expected_linked
        or value["previous_active_model_revision_id"] != request["expected_old_model_revision_id"]
        or value["active_model_revision_id"] != request["target_model_revision_id"]
        or not isinstance(value["switched_at"], str) or not value["switched_at"]
        or value["switch_receipt_digest"] != prefixed_digest(value, field="switch_receipt_digest", prefix="asw_")
    ):
        raise ActivationProtocolError(500, "mesa_adapter_failure", "stored switch receipt binding is invalid")
    return value


def build_candidate_descriptor(project_id: str, expected_active: str, runtime_handshake_digest: str) -> dict[str, Any]:
    source = source_descriptor()
    manifest = framed_manifest()
    value = {
        "schema_id": "riff://evidence-studio/framed-candidate-descriptor/v1",
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_id": project_id,
        "runtime_handshake_digest": runtime_handshake_digest,
        "expected_active_model_revision_id": expected_active,
        "candidate_source_revision": source["candidate_source_revision"],
        "model_id": MODEL_ID,
        "model_revision_id": manifest["model_revision_id"],
        "bundle_protocol": BUNDLE_PROTOCOL,
        "manifest_sha256": source["candidate_manifest_sha256"],
        "file_map_sha256": source["candidate_file_map_sha256"],
        "runtime_profile": framed_runtime_profile(),
        "preset_id": PRESET_ID,
        "preset_sha256": manifest["files"]["defaults/wind-turbine-maintenance-demo-v1.json"]["sha256"],
        "provenance_sha256": manifest["files"]["provenance.json"]["sha256"],
        "descriptor_digest": "",
    }
    value["descriptor_digest"] = prefixed_digest(value, field="descriptor_digest", prefix="cand_")
    return value


def candidate_bytes_digest(bundle_dir: Path) -> str:
    digest = hashlib.sha256()
    for name in ("manifest.json", *sorted(FRAMED_FILES)):
        path_bytes = name.encode("utf-8")
        content = (bundle_dir / name).read_bytes()
        digest.update(struct.pack(">I", len(path_bytes)))
        digest.update(path_bytes)
        digest.update(struct.pack(">Q", len(content)))
        digest.update(content)
    return digest.hexdigest()


class Gate3ActivationStore:
    def __init__(self, service: Any) -> None:
        self.service = service
        self.runtime_instance_id = f"runtime_{uuid.uuid4().hex}"

    def recover_switches(self) -> None:
        """Finish any receipt-first CAS interrupted before active-pointer replace."""
        for project in sorted(self.service.projects_root.iterdir()):
            receipts = project / "wind" / "switch-receipts"
            if not receipts.is_dir() or receipts.is_symlink():
                continue
            for request_path in sorted(receipts.glob("*.request.json")):
                activation_id = request_path.name.removesuffix(".request.json")
                receipt_path = receipts / f"{activation_id}.json"
                if not receipt_path.is_file():
                    continue
                if UUID.fullmatch(activation_id) is None:
                    raise ActivationProtocolError(500, "mesa_adapter_failure", "stored activation path is invalid")
                request = _validate_cas_record(_read_record(request_path), project_id=project.name, activation_id=activation_id)
                receipt = _validate_switch_receipt(_read_record(receipt_path), request=request)
                _, candidate_path, _ = self._candidate_paths(project, activation_id)
                candidate = _validate_candidate_receipt(
                    _read_record(candidate_path), project_id=request["project_id"], activation_id=activation_id,
                )
                if (
                    candidate["candidate_receipt_digest"] != request["candidate_receipt_digest"]
                    or candidate["expected_old_model_revision_id"] != request["expected_old_model_revision_id"]
                    or candidate["target_model_revision_id"] != request["target_model_revision_id"]
                ):
                    raise ActivationProtocolError(500, "mesa_adapter_failure", "stored recovery links are invalid")
                current = self._active_revision(request["project_id"])
                if current == receipt["active_model_revision_id"]:
                    continue
                if current != request["expected_old_model_revision_id"]:
                    raise ActivationProtocolError(500, "mesa_adapter_failure", "stored switch receipt conflicts with active pointer")
                bundle = self._verify_candidate(project, activation_id, candidate)
                self._install_active_bundle(project, bundle, request["target_model_revision_id"])
                self._replace_active_pointer(project, request, bundle)

    def _project(self, project_id: str) -> Path:
        return self.service._project_dir(project_id)

    def project_for_activation(self, activation_id: str) -> str:
        if UUID.fullmatch(activation_id) is None:
            raise ActivationProtocolError(404, "activation_not_found", "activation not found")
        matches: list[str] = []
        for project in sorted(self.service.projects_root.iterdir()):
            if not project.is_dir() or project.is_symlink():
                continue
            receipt = project / "wind" / "candidates" / activation_id / "candidate-receipt.json"
            if receipt.is_file() and not receipt.is_symlink():
                matches.append(project.name)
        if len(matches) != 1:
            raise ActivationProtocolError(404, "activation_not_found", "activation not found")
        return matches[0]

    def _active_revision(self, project_id: str) -> str:
        project = self._project(project_id)
        pointer = self.service._safe_path(self.service._wind_active_path(project))
        if not pointer.is_file():
            raise ActivationProtocolError(404, "project_not_found", "project not found")
        value = self.service._read_workspace_json(pointer)
        revision = value.get("model_revision_id")
        if not isinstance(revision, str) or re.fullmatch(r"mr_[0-9a-f]{64}", revision) is None:
            raise ActivationProtocolError(500, "mesa_adapter_failure", "active model pointer is invalid")
        return revision

    @contextmanager
    def _lock(self, project: Path) -> Iterator[None]:
        path = self.service._safe_path(project / "wind" / "activation.lock")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a+b") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def handshake(self, project_id: str) -> dict[str, Any]:
        try:
            active = self._active_revision(project_id)
        except ActivationProtocolError:
            raise
        except Exception as exc:
            raise ActivationProtocolError(404, "project_not_found", "project not found") from exc
        source = source_descriptor()
        value = {
            "schema_id": "riff://mesa-wind/runtime-candidate-handshake/v1",
            "schema_version": 1,
            "canonical_json_version": "riff-canonical-json-v2",
            "project_id": project_id,
            "runtime_instance_id": self.runtime_instance_id,
            "actual_python_implementation": __import__("platform").python_implementation(),
            "actual_python_major_minor": ".".join(__import__("platform").python_version_tuple()[:2]),
            "actual_mesa_version": mesa.__version__,
            "model_protocol_version": MODEL_PROTOCOL_VERSION,
            **source,
            "active_model_revision_id": active,
            "handshake_digest": "",
        }
        value.pop("candidate_model_revision_id")
        value["handshake_digest"] = prefixed_digest(value, field="handshake_digest", prefix="rh_")
        return value

    def descriptor(self, project_id: str) -> dict[str, Any]:
        handshake = self.handshake(project_id)
        if not actual_runtime_is_framed_compatible():
            raise ActivationProtocolError(409, "incompatible_framed_runtime", "framed runtime is incompatible")
        return build_candidate_descriptor(project_id, handshake["active_model_revision_id"], handshake["handshake_digest"])

    @staticmethod
    def _runtime_facts(handshake: dict[str, Any]) -> dict[str, str]:
        return {key: handshake[key] for key in RUNTIME_FACT_KEYS}

    def _runtime_instance_evidence(self, project: Path, handshake: dict[str, Any]) -> dict[str, Any]:
        path = self.service._safe_path(
            project / "wind" / "runtime-instances" / f"{handshake['runtime_instance_id']}.json"
        )
        if path.exists():
            value = _validate_runtime_instance_evidence(_read_record(path), project_id=project.name)
            expected = {
                "project_id": project.name,
                "runtime_instance_id": handshake["runtime_instance_id"],
                **self._runtime_facts(handshake),
            }
            if any(value[key] != item for key, item in expected.items()):
                raise ActivationProtocolError(500, "mesa_adapter_failure", "runtime instance evidence drifted")
            return value
        value = {
            "schema_id": "riff://mesa-wind/runtime-instance-evidence/v1",
            "schema_version": 1,
            "canonical_json_version": "riff-canonical-json-v2",
            "project_id": project.name,
            "runtime_instance_id": handshake["runtime_instance_id"],
            **self._runtime_facts(handshake),
            "recorded_at": _now(),
            "runtime_instance_evidence_digest": "",
        }
        value["runtime_instance_evidence_digest"] = prefixed_digest(
            value, field="runtime_instance_evidence_digest", prefix="rie_",
        )
        _write_record(path, value)
        return value

    def _build_authoritative_handshake(
        self,
        project: Path,
        activation_id: str,
        request: dict[str, Any],
        handshake: dict[str, Any],
        runtime_evidence: dict[str, Any],
    ) -> dict[str, Any]:
        value = {
            "schema_id": "riff://mesa-wind/materialize-authoritative-handshake/v1",
            "schema_version": 1,
            "canonical_json_version": "riff-canonical-json-v2",
            "activation_id": activation_id,
            "project_id": project.name,
            "materialize_request_sha256": hashlib.sha256(canonical_json_v2_bytes(request)).hexdigest(),
            "candidate_descriptor_digest": request["candidate_descriptor_digest"],
            "runtime_instance_id": handshake["runtime_instance_id"],
            "runtime_instance_evidence_digest": runtime_evidence["runtime_instance_evidence_digest"],
            "runtime_handshake_digest": handshake["handshake_digest"],
            "active_model_revision_id": handshake["active_model_revision_id"],
            **self._runtime_facts(handshake),
            "captured_at": _now(),
            "authoritative_handshake_digest": "",
        }
        value["authoritative_handshake_digest"] = prefixed_digest(
            value, field="authoritative_handshake_digest", prefix="ahe_",
        )
        return value

    def _verify_authoritative_handshake(
        self,
        project: Path,
        activation_id: str,
        request: dict[str, Any],
        descriptor: dict[str, Any],
        root: Path,
    ) -> dict[str, Any]:
        evidence_path = self.service._safe_path(root / "authoritative-handshake.json")
        evidence = _validate_authoritative_handshake(
            _read_record(evidence_path), project_id=project.name, activation_id=activation_id,
        )
        runtime_path = self.service._safe_path(
            project / "wind" / "runtime-instances" / f"{evidence['runtime_instance_id']}.json"
        )
        try:
            runtime = _validate_runtime_instance_evidence(_read_record(runtime_path), project_id=project.name)
        except ActivationProtocolError as exc:
            raise ActivationProtocolError(
                500, "mesa_adapter_failure", "stored candidate handshake does not bind actual runtime evidence",
            ) from exc
        request_sha256 = hashlib.sha256(canonical_json_v2_bytes(request)).hexdigest()
        live = self.handshake(project.name)
        linked_runtime = {
            "project_id": project.name,
            "runtime_instance_id": evidence["runtime_instance_id"],
            **{key: evidence[key] for key in RUNTIME_FACT_KEYS},
            "runtime_instance_evidence_digest": evidence["runtime_instance_evidence_digest"],
        }
        actual_runtime = {
            "project_id": runtime["project_id"],
            "runtime_instance_id": runtime["runtime_instance_id"],
            **{key: runtime[key] for key in RUNTIME_FACT_KEYS},
            "runtime_instance_evidence_digest": runtime["runtime_instance_evidence_digest"],
        }
        if (
            linked_runtime != actual_runtime
            or evidence["runtime_instance_id"] != live["runtime_instance_id"]
            or any(evidence[key] != live[key] for key in RUNTIME_FACT_KEYS)
            or evidence["materialize_request_sha256"] != request_sha256
            or evidence["candidate_descriptor_digest"] != request["candidate_descriptor_digest"]
            or evidence["active_model_revision_id"] != request["expected_old_model_revision_id"]
            or descriptor["runtime_handshake_digest"] != evidence["runtime_handshake_digest"]
        ):
            raise ActivationProtocolError(
                500, "mesa_adapter_failure", "stored candidate handshake does not bind actual runtime evidence",
            )
        return evidence

    def _validate_materialize(self, raw: Any, activation_id: str) -> dict[str, Any]:
        keys = {"schema_id", "schema_version", "canonical_json_version", "activation_id", "project_id", "expected_old_model_revision_id", "candidate_descriptor_digest", "intent_digest"}
        if not isinstance(raw, dict) or set(raw) != keys:
            raise ActivationProtocolError(422, "invalid_activation_protocol", "materialize request keys are invalid")
        if (
            raw["schema_id"] != "riff://mesa-wind/materialize-candidate-request/v1"
            or raw["schema_version"] != 1
            or raw["canonical_json_version"] != "riff-canonical-json-v2"
            or raw["activation_id"] != activation_id
            or UUID.fullmatch(activation_id) is None
            or re.fullmatch(r"mr_[0-9a-f]{64}", str(raw["expected_old_model_revision_id"])) is None
            or re.fullmatch(r"cand_[0-9a-f]{64}", str(raw["candidate_descriptor_digest"])) is None
            or re.fullmatch(r"aint_[0-9a-f]{64}", str(raw["intent_digest"])) is None
        ):
            raise ActivationProtocolError(422, "invalid_activation_protocol", "materialize request values are invalid")
        return raw

    def materialize(self, raw: Any, activation_id: str) -> tuple[int, dict[str, Any]]:
        request = self._validate_materialize(raw, activation_id)
        project = self._project(request["project_id"])
        with self._lock(project):
            receipt_path = self.service._safe_path(project / "wind" / "candidates" / activation_id / "candidate-receipt.json")
            request_path = self.service._safe_path(project / "wind" / "candidates" / activation_id / "materialize-request.json")
            descriptor_path = self.service._safe_path(project / "wind" / "candidates" / activation_id / "candidate-descriptor.json")
            handshake_path = self.service._safe_path(project / "wind" / "candidates" / activation_id / "authoritative-handshake.json")
            request_digest = hashlib.sha256(canonical_json_v2_bytes(request)).hexdigest()
            if receipt_path.exists():
                existing_request = _read_record(request_path)
                if hashlib.sha256(canonical_json_v2_bytes(existing_request)).hexdigest() != request_digest:
                    raise ActivationProtocolError(409, "idempotency_conflict", "activation ID is bound to different request bytes")
                receipt = _validate_candidate_receipt(
                    _read_record(receipt_path), project_id=request["project_id"], activation_id=activation_id,
                )
                self._verify_candidate(project, activation_id, receipt)
                return 200, receipt
            if not actual_runtime_is_framed_compatible():
                raise ActivationProtocolError(409, "incompatible_framed_runtime", "framed runtime is incompatible")
            if self._active_revision(request["project_id"]) != request["expected_old_model_revision_id"]:
                raise ActivationProtocolError(409, "active_model_mismatch", "active model does not equal expected old revision")
            handshake = self.handshake(request["project_id"])
            descriptor = build_candidate_descriptor(
                request["project_id"], handshake["active_model_revision_id"], handshake["handshake_digest"],
            )
            if descriptor["descriptor_digest"] != request["candidate_descriptor_digest"]:
                raise ActivationProtocolError(409, "candidate_descriptor_mismatch", "candidate descriptor digest is stale or mismatched")
            candidates_root = self.service._safe_path(project / "wind" / "candidates")
            if candidates_root.exists():
                for other in candidates_root.iterdir():
                    if other.name != activation_id and (other / "candidate-receipt.json").is_file() and not (project / "wind" / "switch-receipts" / f"{other.name}.json").is_file():
                        raise ActivationProtocolError(409, "concurrent_activation", "another inactive activation is materialized")
            revision = descriptor["model_revision_id"]
            bundle = self.service._safe_path(project / "wind" / "candidates" / activation_id / revision)
            materialize_framed_bundle(bundle)
            manifest = framed_manifest()
            receipt = {
                "schema_id": "riff://mesa-wind/candidate-receipt/v1",
                "schema_version": 1,
                "canonical_json_version": "riff-canonical-json-v2",
                "activation_id": activation_id,
                "project_id": request["project_id"],
                "intent_digest": request["intent_digest"],
                "expected_old_model_revision_id": request["expected_old_model_revision_id"],
                "candidate_descriptor_digest": request["candidate_descriptor_digest"],
                "target_model_revision_id": revision,
                "bundle_protocol": BUNDLE_PROTOCOL,
                "manifest_sha256": descriptor["manifest_sha256"],
                "files": manifest["files"],
                "file_map_sha256": descriptor["file_map_sha256"],
                "candidate_bytes_digest": candidate_bytes_digest(bundle),
                "created_at": _now(),
                "candidate_receipt_digest": "",
            }
            receipt["candidate_receipt_digest"] = prefixed_digest(receipt, field="candidate_receipt_digest", prefix="acand_")
            runtime_evidence = self._runtime_instance_evidence(project, handshake)
            authoritative_handshake = self._build_authoritative_handshake(
                project, activation_id, request, handshake, runtime_evidence,
            )
            _write_record(request_path, request)
            _write_record(handshake_path, authoritative_handshake)
            _write_record(descriptor_path, descriptor)
            _write_record(receipt_path, receipt)
            return 201, receipt

    def _candidate_paths(self, project: Path, activation_id: str) -> tuple[Path, Path, Path]:
        root = self.service._safe_path(project / "wind" / "candidates" / activation_id)
        return root, self.service._safe_path(root / "candidate-receipt.json"), self.service._safe_path(root / "candidate-descriptor.json")

    def _verify_candidate(self, project: Path, activation_id: str, receipt: dict[str, Any]) -> Path:
        receipt = _validate_candidate_receipt(receipt, project_id=project.name, activation_id=activation_id)
        root, _, descriptor_path = self._candidate_paths(project, activation_id)
        request_path = self.service._safe_path(root / "materialize-request.json")
        try:
            request = self._validate_materialize(_read_record(request_path), activation_id)
        except ActivationProtocolError as exc:
            raise ActivationProtocolError(
                500, "mesa_adapter_failure", "stored materialize request is invalid",
            ) from exc
        descriptor = _validate_candidate_descriptor(_read_record(descriptor_path), project_id=project.name)
        authoritative = self._verify_authoritative_handshake(
            project, activation_id, request, descriptor, root,
        )
        manifest = framed_manifest()
        source = source_descriptor()
        expected_descriptor = build_candidate_descriptor(
            project.name,
            authoritative["active_model_revision_id"],
            authoritative["runtime_handshake_digest"],
        )
        expected_manifest_bytes = canonical_json_v2_bytes(manifest) + b"\n"
        expected_receipt_bundle = {
            "target_model_revision_id": manifest["model_revision_id"],
            "bundle_protocol": BUNDLE_PROTOCOL,
            "manifest_sha256": source["candidate_manifest_sha256"],
            "files": manifest["files"],
            "file_map_sha256": source["candidate_file_map_sha256"],
        }
        if (
            request["project_id"] != project.name
            or descriptor != expected_descriptor
            or descriptor["descriptor_digest"] != request["candidate_descriptor_digest"]
            or descriptor["expected_active_model_revision_id"] != request["expected_old_model_revision_id"]
            or receipt["project_id"] != request["project_id"]
            or receipt["activation_id"] != request["activation_id"]
            or receipt["intent_digest"] != request["intent_digest"]
            or receipt["expected_old_model_revision_id"] != request["expected_old_model_revision_id"]
            or receipt["candidate_descriptor_digest"] != request["candidate_descriptor_digest"]
            or {key: receipt[key] for key in expected_receipt_bundle} != expected_receipt_bundle
            or descriptor["candidate_source_revision"] != source["candidate_source_revision"]
            or descriptor["descriptor_digest"] != receipt["candidate_descriptor_digest"]
            or descriptor["expected_active_model_revision_id"] != receipt["expected_old_model_revision_id"]
            or descriptor["model_revision_id"] != receipt["target_model_revision_id"]
            or descriptor["manifest_sha256"] != receipt["manifest_sha256"]
            or descriptor["file_map_sha256"] != receipt["file_map_sha256"]
        ):
            raise ActivationProtocolError(500, "mesa_adapter_failure", "stored candidate records do not bind the actual framed source")
        bundle = self.service._safe_path(root / receipt["target_model_revision_id"])
        manifest_path = self.service._safe_path(bundle / "manifest.json")
        if not manifest_path.is_file() or manifest_path.read_bytes() != expected_manifest_bytes:
            raise ActivationProtocolError(409, "candidate_bytes_changed", "materialized candidate bytes changed")
        from .verify_bundle import verify_bundle
        try:
            verified = verify_bundle(bundle)
        except Exception as exc:
            raise ActivationProtocolError(409, "candidate_bytes_changed", "materialized candidate bytes changed") from exc
        if (
            verified.get("bundle_branch") != "framed"
            or verified.get("model_revision_id") != receipt.get("target_model_revision_id")
            or receipt.get("candidate_bytes_digest") != candidate_bytes_digest(bundle)
            or receipt.get("candidate_receipt_digest") != prefixed_digest(receipt, field="candidate_receipt_digest", prefix="acand_")
        ):
            raise ActivationProtocolError(409, "candidate_bytes_changed", "materialized candidate bytes changed")
        return bundle

    def capture(self, project_id: str, activation_id: str) -> dict[str, Any]:
        if UUID.fullmatch(activation_id) is None:
            raise ActivationProtocolError(404, "activation_not_found", "activation not found")
        project = self._project(project_id)
        with self._lock(project):
            _, receipt_path, descriptor_path = self._candidate_paths(project, activation_id)
            if not receipt_path.is_file() or not descriptor_path.is_file():
                raise ActivationProtocolError(404, "activation_not_found", "activation not found")
            receipt = _read_record(receipt_path)
            if receipt.get("project_id") != project_id:
                raise ActivationProtocolError(404, "activation_not_found", "activation not found")
            self._verify_candidate(project, activation_id, receipt)
            descriptor = _read_record(descriptor_path)
            return {
                "schema_id": "riff://mesa-wind/candidate-capture-response/v1",
                "schema_version": 1,
                "canonical_json_version": "riff-canonical-json-v2",
                "activation_id": activation_id,
                "candidate_descriptor": descriptor,
                "candidate_receipt": receipt,
                "candidate_bytes_digest": receipt["candidate_bytes_digest"],
            }

    def byte_capture(self, project_id: str, activation_id: str, if_match: str) -> dict[str, Any]:
        """Return the independently verifiable bounded candidate byte snapshot."""

        project = self._project(project_id)
        with self._lock(project):
            _, receipt_path, _ = self._candidate_paths(project, activation_id)
            if not receipt_path.is_file():
                raise ActivationProtocolError(404, "activation_not_found", "activation not found")
            receipt = _read_record(receipt_path)
            if receipt.get("project_id") != project_id:
                raise ActivationProtocolError(404, "activation_not_found", "activation not found")
            if if_match != f'"{receipt["candidate_receipt_digest"]}"':
                raise ActivationProtocolError(409, "candidate_receipt_mismatch", "candidate receipt condition is stale")
            bundle = self._verify_candidate(project, activation_id, receipt)

            def blob(name: str, *, media_type: str) -> dict[str, Any]:
                data = (bundle / name).read_bytes()
                if len(data) > 512 * 1024:
                    raise ActivationProtocolError(409, "candidate_bytes_changed", "candidate blob exceeds capture limit")
                return {
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "byte_length": len(data),
                    "media_type": media_type,
                    "content_encoding": "base64-rfc4648",
                    "content_base64": base64.b64encode(data).decode("ascii"),
                }

            manifest_blob = blob("manifest.json", media_type="application/json")
            file_blobs = {name: blob(name, media_type=receipt["files"][name]["media_type"]) for name in FRAMED_FILES}
            raw_total = manifest_blob["byte_length"] + sum(item["byte_length"] for item in file_blobs.values())
            if raw_total > 4 * 1024 * 1024:
                raise ActivationProtocolError(409, "candidate_bytes_changed", "candidate capture exceeds raw-byte limit")
            value = {
                "schema_id": "riff://mesa-wind/candidate-byte-capture/v1",
                "schema_version": 1,
                "canonical_json_version": "riff-canonical-json-v2",
                "project_id": project_id,
                "activation_id": activation_id,
                "target_model_revision_id": receipt["target_model_revision_id"],
                "candidate_descriptor_digest": receipt["candidate_descriptor_digest"],
                "candidate_receipt_digest": receipt["candidate_receipt_digest"],
                "manifest_sha256": receipt["manifest_sha256"],
                "manifest": manifest_blob,
                "files": file_blobs,
                "file_map_sha256": receipt["file_map_sha256"],
                "candidate_bytes_digest": receipt["candidate_bytes_digest"],
                "capture_digest": "",
            }
            value["capture_digest"] = prefixed_digest(value, field="capture_digest", prefix="cap_")
            if len(canonical_json_v2_bytes(value)) > 6 * 1024 * 1024:
                raise ActivationProtocolError(409, "candidate_bytes_changed", "candidate capture exceeds wire limit")
            return value

    def _install_active_bundle(self, project: Path, bundle: Path, revision: str) -> Path:
        target = self.service._safe_path(project / "models" / MODEL_ID / "revisions" / revision)
        if not target.exists():
            staging = self.service._safe_path(target.parent / f".{revision}.{uuid.uuid4().hex}.tmp")
            staging.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(bundle, staging, symlinks=False)
            os.replace(staging, target)
        from .verify_bundle import verify_bundle
        if verify_bundle(target)["model_revision_id"] != revision:
            raise ActivationProtocolError(409, "candidate_bytes_changed", "active candidate copy is invalid")
        return target

    def cas(self, raw: Any, activation_id: str, if_match: str) -> dict[str, Any]:
        if not isinstance(raw, dict) or set(raw) != CAS_REQUEST_KEYS or raw.get("activation_id") != activation_id or UUID.fullmatch(activation_id) is None:
            raise ActivationProtocolError(422, "invalid_activation_protocol", "CAS request keys are invalid")
        if (
            raw["schema_id"] != "riff://mesa-wind/active-cas-request/v1"
            or raw["schema_version"] != 1
            or raw["canonical_json_version"] != "riff-canonical-json-v2"
            or if_match != f'"{raw["expected_old_model_revision_id"]}"'
            or re.fullmatch(r"mr_[0-9a-f]{64}", str(raw["expected_old_model_revision_id"])) is None
            or re.fullmatch(r"mr_[0-9a-f]{64}", str(raw["target_model_revision_id"])) is None
            or re.fullmatch(r"acand_[0-9a-f]{64}", str(raw["candidate_receipt_digest"])) is None
            or re.fullmatch(r"pe_[0-9a-f]{64}", str(raw["project_event_digest"])) is None
        ):
            raise ActivationProtocolError(422, "invalid_activation_protocol", "CAS request values are invalid")
        project = self._project(raw["project_id"])
        with self._lock(project):
            switch_path = self.service._safe_path(project / "wind" / "switch-receipts" / f"{activation_id}.json")
            cas_path = self.service._safe_path(project / "wind" / "switch-receipts" / f"{activation_id}.request.json")
            if switch_path.exists():
                stored_request = _validate_cas_record(_read_record(cas_path), project_id=raw["project_id"], activation_id=activation_id)
                if stored_request != raw:
                    raise ActivationProtocolError(409, "idempotency_conflict", "activation ID is bound to different CAS bytes")
                receipt = _validate_switch_receipt(_read_record(switch_path), request=stored_request)
                _, receipt_path, _ = self._candidate_paths(project, activation_id)
                candidate = _validate_candidate_receipt(
                    _read_record(receipt_path), project_id=raw["project_id"], activation_id=activation_id,
                )
                if (
                    candidate["candidate_receipt_digest"] != raw["candidate_receipt_digest"]
                    or candidate["expected_old_model_revision_id"] != raw["expected_old_model_revision_id"]
                    or candidate["target_model_revision_id"] != raw["target_model_revision_id"]
                ):
                    raise ActivationProtocolError(500, "mesa_adapter_failure", "stored idempotent CAS links are invalid")
                bundle = self._verify_candidate(project, activation_id, candidate)
                current = self._active_revision(raw["project_id"])
                if current == raw["expected_old_model_revision_id"]:
                    self._install_active_bundle(project, bundle, raw["target_model_revision_id"])
                    self._replace_active_pointer(project, raw, bundle)
                    current = raw["target_model_revision_id"]
                if current != receipt["active_model_revision_id"]:
                    raise ActivationProtocolError(409, "active_model_mismatch", "active pointer differs from stored switch receipt")
                return receipt
            _, receipt_path, _ = self._candidate_paths(project, activation_id)
            if not receipt_path.is_file():
                raise ActivationProtocolError(404, "activation_not_found", "activation not found")
            candidate = _validate_candidate_receipt(
                _read_record(receipt_path), project_id=raw["project_id"], activation_id=activation_id,
            )
            if (
                candidate.get("project_id") != raw["project_id"]
                or candidate.get("expected_old_model_revision_id") != raw["expected_old_model_revision_id"]
                or candidate.get("target_model_revision_id") != raw["target_model_revision_id"]
                or candidate.get("candidate_receipt_digest") != raw["candidate_receipt_digest"]
            ):
                raise ActivationProtocolError(409, "candidate_descriptor_mismatch", "CAS does not bind the candidate receipt")
            current = self._active_revision(raw["project_id"])
            if current != raw["expected_old_model_revision_id"]:
                raise ActivationProtocolError(409, "active_model_mismatch", "active model does not equal CAS expectation")
            bundle = self._verify_candidate(project, activation_id, candidate)
            self._install_active_bundle(project, bundle, raw["target_model_revision_id"])
            receipt = {
                "schema_id": "riff://mesa-wind/active-switch-receipt/v1",
                "schema_version": 1,
                "canonical_json_version": "riff-canonical-json-v2",
                "activation_id": activation_id,
                "project_id": raw["project_id"],
                "expected_old_model_revision_id": raw["expected_old_model_revision_id"],
                "target_model_revision_id": raw["target_model_revision_id"],
                "candidate_receipt_digest": raw["candidate_receipt_digest"],
                "project_event_digest": raw["project_event_digest"],
                "previous_active_model_revision_id": current,
                "active_model_revision_id": raw["target_model_revision_id"],
                "switched_at": _now(),
                "switch_receipt_digest": "",
            }
            receipt["switch_receipt_digest"] = prefixed_digest(receipt, field="switch_receipt_digest", prefix="asw_")
            _write_record(cas_path, raw)
            _write_record(switch_path, receipt)
            self.service._gate3_fault_hook("after_switch_receipt_before_active_pointer")
            self._replace_active_pointer(project, raw, bundle)
            return receipt

    def _replace_active_pointer(self, project: Path, request: dict[str, Any], bundle: Path) -> None:
        active_path = self.service._safe_path(self.service._wind_active_path(project))
        active = self.service._read_workspace_json(active_path)
        active.update({
            "model_id": MODEL_ID,
            "model_revision_id": request["target_model_revision_id"],
            "bundle_protocol": BUNDLE_PROTOCOL,
            "parameter_schema": __import__("json").loads((bundle / "parameter-schema.json").read_text()),
            "metric_schema": __import__("json").loads((bundle / "metric-schema.json").read_text()),
            "claim_labels": ["synthetic_inputs", "single_seed", "behavioral_reproduction_not_runtime_equivalence", "draft_unverified", "no_staffing_recommendation"],
        })
        self.service._write_workspace_bytes(active_path, canonical_json_v2_bytes(active))

    def status(self, project_id: str, activation_id: str) -> dict[str, Any]:
        project = self._project(project_id)
        _, receipt_path, _ = self._candidate_paths(project, activation_id)
        if not receipt_path.is_file():
            raise ActivationProtocolError(404, "activation_not_found", "activation not found")
        candidate = _validate_candidate_receipt(
            _read_record(receipt_path), project_id=project_id, activation_id=activation_id,
        )
        self._verify_candidate(project, activation_id, candidate)
        if candidate.get("project_id") != project_id:
            raise ActivationProtocolError(404, "activation_not_found", "activation not found")
        switch_path = self.service._safe_path(project / "wind" / "switch-receipts" / f"{activation_id}.json")
        if switch_path.is_file():
            cas_path = self.service._safe_path(project / "wind" / "switch-receipts" / f"{activation_id}.request.json")
            request = _validate_cas_record(_read_record(cas_path), project_id=project_id, activation_id=activation_id)
            switch = _validate_switch_receipt(_read_record(switch_path), request=request)
            if request["candidate_receipt_digest"] != candidate["candidate_receipt_digest"]:
                raise ActivationProtocolError(500, "mesa_adapter_failure", "activation status links are invalid")
        else:
            switch = None
        active = self._active_revision(project_id)
        if switch is not None and active != switch["active_model_revision_id"]:
            raise ActivationProtocolError(409, "active_model_mismatch", "active pointer differs from switch receipt")
        return {
            "schema_id": "riff://mesa-wind/activation-status/v1",
            "schema_version": 1,
            "canonical_json_version": "riff-canonical-json-v2",
            "activation_id": activation_id,
            "status": "switched" if switch is not None else "candidate_ready",
            "active_model_revision_id": active,
            "candidate_receipt_digest": candidate["candidate_receipt_digest"],
            "switch_receipt": switch,
        }
