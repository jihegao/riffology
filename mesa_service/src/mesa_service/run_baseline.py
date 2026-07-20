"""Run the exact reviewed 100/3/1095/365/seed-2 Gate 1 baseline."""

from __future__ import annotations

import argparse
import hashlib
import json
import uuid
from pathlib import Path

from .bundle import materialize_reviewed_bundle
from .verify_run import verify_run
from .wind_contracts import PRESET_ID
from .wind_worker import atomic_json, build_run_request, execute, initial_metadata


def run_baseline(
    *,
    output_dir: str | Path,
    preset_id: str = PRESET_ID,
) -> str:
    if preset_id != PRESET_ID:
        raise ValueError(f"only the reviewed preset {PRESET_ID} is executable")
    output = Path(output_dir).resolve()
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"baseline output directory is not empty: {output}")
    output.mkdir(parents=True, exist_ok=True)

    # Bundle materialization is immutable and idempotent. Keep it outside the
    # run directory so verify_run sees only declared run artifacts.
    bundle_workspace = output.parent / ".gate1-reviewed-bundle"
    materialized = materialize_reviewed_bundle(bundle_workspace)
    run_id = f"run_{uuid.uuid4().hex}"
    request = build_run_request(
        project_id="gate1-baseline",
        run_id=run_id,
        model_revision_id=materialized["model_revision_id"],
        experiment_revision_id=materialized["experiment_revision_id"],
        experiment=materialized["experiment"],
    )
    request_path = output / "request.json"
    atomic_json(request_path, request)
    atomic_json(output / "metadata.json", initial_metadata(request))
    (output / "run.log").write_text("Gate 1 direct reviewed baseline runner\n", encoding="utf-8")
    execute(
        Path(materialized["bundle_dir"]) / "model.py",
        request_path,
        output,
        expected_request_sha256=hashlib.sha256(request_path.read_bytes()).hexdigest(),
        expected_model_revision_id=materialized["model_revision_id"],
        expected_experiment_revision_id=materialized["experiment_revision_id"],
    )
    verify_run(output)
    return str(output)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preset", default=PRESET_ID)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    output = Path(run_baseline(output_dir=args.output_dir, preset_id=args.preset))
    result = verify_run(output)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
