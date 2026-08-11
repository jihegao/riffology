/** Server-owned generic batch entry point copied into Project Templates/tests. */
export const PROJECT_ONLY_BATCH_ENTRY_SOURCE = `from __future__ import annotations
import argparse
import importlib
import inspect
import json
import math
import re
import signal
import time
from pathlib import Path

import mesa

def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()

def _json_value(value):
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if hasattr(value, "item"):
        return _json_value(value.item())
    return str(value)

def _model_class(module):
    candidate = getattr(module, "SimulationModel", None)
    if inspect.isclass(candidate) and issubclass(candidate, mesa.Model):
        return candidate
    choices = [value for value in vars(module).values()
               if inspect.isclass(value) and value is not mesa.Model and issubclass(value, mesa.Model)
               and value.__module__ == module.__name__]
    if len(choices) != 1:
        raise ValueError("model.py must define one Mesa Model subclass or SimulationModel")
    return choices[0]

def _construct(model_class, parameters: dict, seed):
    signature = inspect.signature(model_class)
    accepts_extra = any(item.kind == inspect.Parameter.VAR_KEYWORD for item in signature.parameters.values())
    normalized = {_snake(str(key)): value for key, value in parameters.items()}
    kwargs = normalized if accepts_extra else {key: value for key, value in normalized.items() if key in signature.parameters}
    if "seed" in signature.parameters and "seed" not in kwargs:
        kwargs["seed"] = seed
    return model_class(**kwargs)

def _snapshot(model):
    for name in ("snapshot", "summary"):
        method = getattr(model, name, None)
        if callable(method):
            value = method()
            if not isinstance(value, dict):
                raise ValueError(f"{name}() must return a dictionary")
            return _json_value(value)
    collector = getattr(model, "datacollector", None)
    if collector is not None and hasattr(collector, "get_model_vars_dataframe"):
        frame = collector.get_model_vars_dataframe()
        if len(frame.index):
            return _json_value(frame.iloc[-1].to_dict())
    return {key: _json_value(value) for key, value in vars(model).items()
            if not key.startswith("_") and isinstance(value, (str, bool, int, float, type(None)))}

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--riff-input", type=Path)
    parser.add_argument("--riff-output-dir", type=Path)
    parser.add_argument("--riff-cancellation-probe", action="store_true")
    args = parser.parse_args()
    if args.riff_cancellation_probe:
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
        print("RIFF_CANCELLATION_READY", flush=True)
        while True:
            time.sleep(0.05)
    if args.riff_input is None or args.riff_output_dir is None:
        parser.error("--riff-input and --riff-output-dir are required")
    envelope = json.loads(args.riff_input.read_text(encoding="utf-8"))
    required = {"schemaVersion", "runId", "sampleIndex", "sampleId", "parameters", "seed"}
    if not isinstance(envelope, dict) or set(envelope) != required or envelope["schemaVersion"] != 1:
        raise ValueError("input must be a riff-batch-v1 envelope")
    parameters = dict(envelope["parameters"])
    steps = parameters.pop("steps", 100)
    if type(steps) is not int or not 1 <= steps <= 1000:
        raise ValueError("steps must be an integer from 1 through 1000")
    module = importlib.import_module("model")
    model = _construct(_model_class(module), parameters, envelope["seed"])
    completed_steps = 0
    for _ in range(steps):
        if getattr(model, "running", True) is False:
            break
        model.step()
        completed_steps += 1
    output = {
        "schemaVersion": 1,
        "sampleIndex": envelope["sampleIndex"],
        "sampleId": envelope["sampleId"],
        "seed": envelope["seed"],
        "completedSteps": completed_steps,
        "metrics": _snapshot(model),
    }
    args.riff_output_dir.mkdir(parents=True, exist_ok=True)
    (args.riff_output_dir / "summary.json").write_text(
        json.dumps(output, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\\n",
        encoding="utf-8",
    )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
`;
