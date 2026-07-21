from __future__ import annotations

import json
from pathlib import Path

import pytest

from mesa_service.run_baseline import run_baseline
from mesa_service.verify_run import RunVerificationError, verify_run
from mesa_service.wind_contracts import PRESET_ID


@pytest.fixture(scope="module")
def framed_baseline(tmp_path_factory: pytest.TempPathFactory) -> Path:
    output = tmp_path_factory.mktemp("framed-baseline") / "run"
    return Path(run_baseline(output_dir=output, preset_id=PRESET_ID))


def test_direct_baseline_publishes_only_framed_replay_evidence(framed_baseline: Path) -> None:
    assert verify_run(framed_baseline)["valid"] is True
    request = json.loads((framed_baseline / "request.json").read_text())
    metadata = json.loads((framed_baseline / "metadata.json").read_text())
    replay = json.loads((framed_baseline / "replay-manifest.json").read_text())
    assert request["experiment_document"]["schema_id"] == "riff://evidence-studio/experiment-revision/framed/v1"
    assert metadata["schema_id"] == "riff://wind-turbine-maintenance/metadata/framed/v1"
    assert replay["schema_id"] == "riff://wind-turbine-maintenance/replay-manifest/framed/v1"
    assert replay["manifest_kind"] == "complete"
    assert replay["frame_count"] == len(replay["frames"]) > 0
    assert "frame_policy" not in replay


def test_direct_baseline_rejects_unknown_preset_and_nonempty_output(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="only the reviewed preset"):
        run_baseline(output_dir=tmp_path / "unknown", preset_id="unknown")
    occupied = tmp_path / "occupied"
    occupied.mkdir()
    (occupied / "keep.txt").write_text("keep")
    with pytest.raises(FileExistsError, match="not empty"):
        run_baseline(output_dir=occupied)
    assert (occupied / "keep.txt").read_text() == "keep"


def test_framed_baseline_verifier_rejects_artifact_tamper(framed_baseline: Path) -> None:
    path = framed_baseline / "replay-manifest.json"
    original = path.read_bytes()
    path.write_bytes(original + b" ")
    try:
        with pytest.raises(RunVerificationError):
            verify_run(framed_baseline)
    finally:
        path.write_bytes(original)
