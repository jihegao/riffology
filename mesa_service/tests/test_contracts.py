from __future__ import annotations

import pytest

from mesa_service.contracts import ContractError, MODEL_SCHEMA, validate_parameters, validate_run_request
from mesa_service.models.queue_network import QueueNetworkModel


def smoke_parameters() -> dict[str, int | float]:
    return {item["name"]: item["default"] for item in MODEL_SCHEMA["parameters"]}


def series(seed: int) -> list[dict[str, int | float]]:
    model = QueueNetworkModel(seed=seed, **smoke_parameters())
    values = [model.snapshot()]
    for _ in range(12):
        model.step()
        values.append(model.snapshot())
    return values


def test_bundled_model_is_seed_reproducible_and_numeric() -> None:
    assert series(20260719) == series(20260719)
    assert len(series(20260719)) == 13
    for snapshot in series(20260719):
        assert set(snapshot) == {"queue_length", "completed_jobs", "mean_wait_time"}
        assert all(isinstance(value, (int, float)) for value in snapshot.values())


def test_parameter_contract_rejects_unknown_float_integer_and_bounds() -> None:
    valid = smoke_parameters()
    assert validate_parameters(valid) == valid
    with pytest.raises(ContractError, match="exactly"):
        validate_parameters({**valid, "unexpected": 1})
    with pytest.raises(ContractError, match="integer"):
        validate_parameters({**valid, "service_capacity": 2.0})
    with pytest.raises(ContractError, match="between"):
        validate_parameters({**valid, "arrival_rate": 0})


def test_normalized_run_request_requires_explicit_active_revision_and_seeds() -> None:
    request = {"model_revision": "mr_1", "steps": 12, "seeds": [20260719], "parameters": smoke_parameters()}
    assert validate_run_request(request, "mr_1") == request
    with pytest.raises(ContractError, match="revision"):
        validate_run_request({**request, "model_revision": "mr_old"}, "mr_1")
    with pytest.raises(ContractError, match="unique"):
        validate_run_request({**request, "seeds": [1, 1]}, "mr_1")
