"""Run a direct framed 100/3/1095/365/seed-2 diagnostic baseline."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import uuid
from pathlib import Path

from .canonical_v2 import canonical_json_v2_bytes, prefixed_digest, sha256_v2
from .gate2_contracts import build_v2_worker_request, defaults_digest, downstream_request_digest
from .gate3_bundle import framed_manifest, framed_runtime_profile, load_framed_json_source, materialize_framed_bundle
from .verify_run import verify_run
from .wind_contracts import PRESET_ID
from .wind_worker import atomic_json, execute, initial_metadata_v2


def _subject(revision_id: str) -> dict:
    return {
        "subject_revision_id": revision_id,
        "effective_attestation_refs": [],
        "human_project_owner_endorsement_attestation_ids": [],
        "human_project_owner_endorsement_count": 0,
        "open_issue_refs": [],
        "open_issue_ids": [],
        "open_issue_count": 0,
        "open_blocking_issue_ids": [],
        "open_blocking_issue_count": 0,
        "open_non_blocking_issue_ids": [],
        "open_non_blocking_issue_count": 0,
        "policy_satisfied": False,
        "wording": "no_recorded_open_objection",
    }


def _framed_request(run_id: str) -> dict:
    project_id = "project_" + "0" * 32
    actor_id = "actor_" + "1" * 32
    brief_id = "dbr_" + "2" * 64
    alignment_id = "amr_" + "3" * 64
    model_revision_id = framed_manifest()["model_revision_id"]
    preset = load_framed_json_source("defaults/wind-turbine-maintenance-demo-v1.json")
    parameters = copy.deepcopy(preset["parameters"])
    execution = {"horizon_days": 1095, "warmup_days": 365, "seed": 2}
    experiment = {
        "schema_id": "riff://evidence-studio/experiment-revision/framed/v1",
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "project_id": project_id,
        "parent_experiment_revision_id": None,
        "operation": "create",
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": model_revision_id,
        "brief_revision_id": brief_id,
        "alignment_revision_id": alignment_id,
        "preset_id": PRESET_ID,
        "defaults_digest": defaults_digest(PRESET_ID, parameters, execution),
        "parameter_defaults": parameters,
        "parameters": parameters,
        "parameter_diff": [],
        "execution_defaults": execution,
        "execution_values": execution,
        "execution_diff": [],
        "runtime_profile": framed_runtime_profile(),
        "copy_migration_rule": "framed_parameter_copy_revalidate_v1",
        "created_by_actor_id": actor_id,
        "created_at": "2026-07-21T00:00:00.000Z",
    }
    experiment["experiment_revision_id"] = "er_" + sha256_v2(experiment)
    experiment["experiment_digest"] = "erd_" + sha256_v2(experiment)
    experiment_bytes = canonical_json_v2_bytes(experiment) + b"\n"
    policy = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "policy_snapshot_digest": "",
        "project_id": project_id,
        "evaluated_at_snapshot_revision": 0,
        "evaluated_project_event_digest": "pe_" + "4" * 64,
        "alignment": _subject(alignment_id),
        "experiment": _subject(experiment["experiment_revision_id"]),
        "combined_policy_satisfied": False,
        "effective_attestation_ids": [],
        "open_issue_ids": [],
    }
    policy["policy_snapshot_digest"] = prefixed_digest(policy, field="policy_snapshot_digest", prefix="ps_")
    admission = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "run_admission_digest": "",
        "project_id": project_id,
        "run_id": run_id,
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": model_revision_id,
        "brief_revision_id": brief_id,
        "alignment_revision_id": alignment_id,
        "experiment_revision_id": experiment["experiment_revision_id"],
        "experiment_sha256": hashlib.sha256(experiment_bytes).hexdigest(),
        "policy_snapshot": policy,
        "policy_snapshot_digest": policy["policy_snapshot_digest"],
        "visibility": "private_draft",
        "trust_label": "draft_unverified",
        "workflow_label": "workflow_policy_unmet",
        "admission_base_snapshot_revision": 0,
        "admission_base_project_event_digest": "pe_" + "4" * 64,
        "created_at": "2026-07-21T00:00:01.000Z",
    }
    admission["run_admission_digest"] = prefixed_digest(admission, field="run_admission_digest", prefix="ra_")
    request_digest = downstream_request_digest(
        project_id=project_id,
        run_id=run_id,
        experiment_revision_id=experiment["experiment_revision_id"],
        experiment_sha256=admission["experiment_sha256"],
        run_admission_digest=admission["run_admission_digest"],
        model_revision_id=model_revision_id,
    )
    intent = {
        "schema_version": 1,
        "canonical_json_version": "riff-canonical-json-v2",
        "run_intent_digest": "",
        "project_id": project_id,
        "run_id": run_id,
        "command_id": "00000000-0000-4000-8000-000000000001",
        "command_digest": "cmd_" + "5" * 64,
        "downstream_idempotency_key": "rk_" + "6" * 64,
        "downstream_request_digest": request_digest,
        "model_id": "wind-turbine-maintenance",
        "model_revision_id": model_revision_id,
        "brief_revision_id": brief_id,
        "alignment_revision_id": alignment_id,
        "experiment_revision_id": experiment["experiment_revision_id"],
        "experiment_sha256": admission["experiment_sha256"],
        "policy_snapshot_digest": policy["policy_snapshot_digest"],
        "run_admission_digest": admission["run_admission_digest"],
        "created_at": "2026-07-21T00:00:02.000Z",
    }
    intent["run_intent_digest"] = prefixed_digest(intent, field="run_intent_digest", prefix="ri_")
    return build_v2_worker_request(experiment=experiment, admission=admission, intent=intent)


def run_baseline(*, output_dir: str | Path, preset_id: str = PRESET_ID) -> str:
    if preset_id != PRESET_ID:
        raise ValueError(f"only the reviewed preset {PRESET_ID} is executable")
    output = Path(output_dir).resolve()
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"baseline output directory is not empty: {output}")
    output.mkdir(parents=True, exist_ok=True)
    manifest = framed_manifest()
    bundle_dir = output.parent / ".framed-reviewed-bundle" / manifest["model_revision_id"]
    materialize_framed_bundle(bundle_dir)
    request = _framed_request(f"run_{uuid.uuid4().hex}")
    request_path = output / "request.json"
    request_path.write_bytes(canonical_json_v2_bytes(request))
    atomic_json(output / "metadata.json", initial_metadata_v2(request))
    (output / "run.log").write_bytes(b"")
    execute(
        bundle_dir / "model.py",
        request_path,
        output,
        expected_request_sha256=hashlib.sha256(request_path.read_bytes()).hexdigest(),
        expected_model_revision_id=manifest["model_revision_id"],
        expected_experiment_revision_id=request["experiment_revision_id"],
    )
    (output / "run.log").write_bytes(b"wind-turbine-maintenance run succeeded\n")
    verify_run(output)
    return str(output)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preset", default=PRESET_ID)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    result = verify_run(Path(run_baseline(output_dir=args.output_dir, preset_id=args.preset)))
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
