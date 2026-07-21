# Framed replay appendix.  Gate3 bundles concatenate this reviewed appendix to
# the complete immutable Gate1 model source, yielding one self-contained
# twelve-file model revision.  It deliberately imports no riff/mesa_service
# executable code.

import json as _framed_json


def _framed_utf16_key(value: str) -> bytes:
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ValueError("lone surrogate is not valid canonical JSON")
    return value.encode("utf-16-be")


def _framed_number(value: float) -> str:
    if not math.isfinite(value):
        raise ValueError("non-finite number")
    if value == 0:
        return "0"
    negative = value < 0
    absolute = -value if negative else value
    rendered = repr(absolute).lower()
    if "e" in rendered:
        coefficient, exponent_text = rendered.split("e", 1)
        exponent = int(exponent_text)
        digits = coefficient.replace(".", "").rstrip("0") or "0"
        decimal_position = 1 + exponent
        if 1e-6 <= absolute < 1e21:
            if decimal_position <= 0:
                rendered = "0." + ("0" * -decimal_position) + digits
            elif decimal_position >= len(digits):
                rendered = digits + ("0" * (decimal_position - len(digits)))
            else:
                rendered = digits[:decimal_position] + "." + digits[decimal_position:]
        else:
            coefficient = digits[0] + (("." + digits[1:]) if len(digits) > 1 else "")
            normalized_exponent = decimal_position - 1
            rendered = f"{coefficient}e{'+' if normalized_exponent >= 0 else ''}{normalized_exponent}"
    elif rendered.endswith(".0"):
        rendered = rendered[:-2]
    return ("-" if negative else "") + rendered


def _framed_canonical(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if not -9_007_199_254_740_991 <= value <= 9_007_199_254_740_991:
            raise ValueError("integer outside canonical safe range")
        return str(value)
    if isinstance(value, float):
        return _framed_number(value)
    if isinstance(value, str):
        if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
            raise ValueError("lone surrogate is not valid canonical JSON")
        return _framed_json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(_framed_canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) or key in {"__proto__", "prototype", "constructor"} for key in value):
            raise ValueError("invalid canonical object key")
        return "{" + ",".join(
            f"{_framed_canonical(key)}:{_framed_canonical(value[key])}"
            for key in sorted(value, key=_framed_utf16_key)
        ) + "}"
    raise ValueError("unsupported canonical value")


def _framed_canonical_bytes(value: Any) -> bytes:
    return _framed_canonical(value).encode("utf-8")


_LegacyWindModel = WindTurbineMaintenanceModel
_LEGACY_MODEL_SPEC = MODEL_SPEC_DEFINITIONS

# Keep the inherited ``MODEL_PROTOCOL_VERSION`` at v1 because the reviewed
# mechanics use it as part of every named RNG stream seed.  The delivered
# model-spec advertises the framed protocol separately without perturbing a
# single stochastic transition.
FRAMED_MODEL_PROTOCOL_VERSION = "wind-turbine-maintenance-v2-framed-replay"

_INITIAL_STATES = {"turbine": "operating", "crew": "idle", "work_order": "queued"}
_TRANSITION_EVENTS = [
    {"event_type": "failure_occurred", "entity": "turbine", "from_state": "operating", "to_state": "failed_waiting", "lane": "turbine"},
    {"event_type": "maintenance_due", "entity": "system", "from_state": None, "to_state": None, "lane": "system"},
    {"event_type": "request_queued", "entity": "work_order", "from_state": None, "to_state": "queued", "lane": "queue"},
    {"event_type": "request_superseded", "entity": "work_order", "from_state": "queued", "to_state": "superseded", "lane": "queue"},
    {"event_type": "request_suppressed", "entity": "system", "from_state": None, "to_state": None, "lane": "queue"},
    {"event_type": "crew_dispatched", "entity": "crew", "from_state": "idle", "to_state": "driving_to_work", "lane": "crew"},
    {"event_type": "crew_arrived", "entity": "crew", "from_state": "driving_to_work", "to_state": "working", "lane": "crew"},
    {"event_type": "repair_started", "entity": "turbine", "from_state": "failed_waiting", "to_state": "corrective_repair", "lane": "turbine"},
    {"event_type": "repair_completed", "entity": "turbine", "from_state": "corrective_repair", "to_state": "operating", "lane": "turbine"},
    {"event_type": "maintenance_started", "entity": "turbine", "from_state": None, "to_state": "planned_maintenance", "lane": "turbine"},
    {"event_type": "maintenance_completed", "entity": "turbine", "from_state": "planned_maintenance", "to_state": "operating", "lane": "turbine"},
    {"event_type": "replacement_started", "entity": "turbine", "from_state": "failed_waiting", "to_state": "major_replacement", "lane": "turbine"},
    {"event_type": "replacement_completed", "entity": "turbine", "from_state": "major_replacement", "to_state": "operating", "lane": "turbine"},
    {"event_type": "crew_return_started", "entity": "crew", "from_state": "working", "to_state": "driving_home", "lane": "crew"},
    {"event_type": "crew_returned", "entity": "crew", "from_state": "driving_home", "to_state": "idle", "lane": "crew"},
    {"event_type": "daily_snapshot", "entity": "system", "from_state": None, "to_state": None, "lane": "system"},
]

MODEL_SPEC_DEFINITIONS = copy.deepcopy(_LEGACY_MODEL_SPEC)
MODEL_SPEC_DEFINITIONS["model_protocol_version"] = FRAMED_MODEL_PROTOCOL_VERSION
for _entity_name, _initial_state in _INITIAL_STATES.items():
    MODEL_SPEC_DEFINITIONS["entities"][_entity_name]["initial_state"] = _initial_state
MODEL_SPEC_DEFINITIONS["transition_events"] = _TRANSITION_EVENTS


def _phase_for_day(day: int, warmup_days: int, horizon_days: int) -> str:
    if day == horizon_days:
        return "horizon_end"
    return "warmup" if day < warmup_days else "measurement"


class WindTurbineMaintenanceModel(_LegacyWindModel):
    """Legacy-reviewed mechanics plus an exact model-owned replay seam."""

    def __init__(
        self,
        *,
        parameters: Mapping[str, Any],
        horizon_days: int,
        warmup_days: int,
        seed: int,
        scenario_fixture: ScenarioFixture | None = None,
        event_sink: Callable[[dict[str, Any]], None] | None = None,
        identity: Mapping[str, Any] | None = None,
        replay_sample_days: set[int] | frozenset[int] | None = None,
        replay_sink: Callable[[dict[str, Any], int], None] | None = None,
        replay_identity: Mapping[str, Any] | None = None,
    ) -> None:
        self._replay_sample_days = frozenset(replay_sample_days or ())
        self._replay_sink = replay_sink
        self._replay_identity = dict(replay_identity or {})
        super().__init__(parameters=parameters, horizon_days=horizon_days, warmup_days=warmup_days, seed=seed,
                         scenario_fixture=scenario_fixture, event_sink=event_sink, identity=identity)

    def _replay_projection(self, daily_metrics: dict[str, int | float]) -> dict[str, Any]:
        day = int(self.sim_time_days)
        phase = _phase_for_day(day, self.warmup_days, self.horizon_days)
        return {
            "schema_id": "riff://wind-turbine-maintenance/replay-frame-state/v1", "schema_version": 1,
            "canonical_json_version": "riff-canonical-json-v2", "model_id": MODEL_ID,
            "model_revision_id": self._replay_identity["model_revision_id"],
            "experiment_revision_id": self._replay_identity["experiment_revision_id"],
            "preset_id": self._replay_identity["preset_id"], "seed": self.seed, "day": day, "phase": phase,
            "depot": {"x_km": float(self.parameters["depot_x_km"]), "y_km": float(self.parameters["depot_y_km"])},
            "turbines": [
                {"turbine_id": item.turbine_id, "x_km": item.x_km, "y_km": item.y_km, "state": item.state.value}
                for item in sorted(self.turbines.values(), key=lambda item: item.turbine_id)
            ],
            "crews": [
                {"crew_id": item.crew_id, "x_km": item.x_km, "y_km": item.y_km, "state": item.state.value,
                 "turbine_id": item.destination_turbine_id, "work_order_id": item.current_work_order_id}
                for item in sorted(self.crews.values(), key=lambda item: item.crew_id)
            ],
            "queues": {"corrective": int(daily_metrics["corrective_queue_length"]),
                       "planned": int(daily_metrics["planned_queue_length"])},
            "daily_metrics": dict(daily_metrics),
        }

    def _emit_daily_snapshot(self) -> None:
        daily_metrics = self.snapshot()
        day = int(self.sim_time_days)
        if day not in self._replay_sample_days:
            self._emit("daily_snapshot", PHASE_DAILY_SNAPSHOT, payload={"snapshot": daily_metrics})
            return
        if self._replay_sink is None:
            raise RuntimeError("sampled replay day requires a replay callback")
        preimage = self._replay_projection(daily_metrics)
        state_digest = "fs_" + hashlib.sha256(_framed_canonical_bytes(preimage)).hexdigest()
        event = self._emit("daily_snapshot", PHASE_DAILY_SNAPSHOT,
                           payload={"snapshot": daily_metrics, "frame_state_sha256": state_digest})
        frame = {key: preimage[key] for key in
                 ("day", "phase", "depot", "turbines", "crews", "queues", "daily_metrics")}
        frame["frame_state_sha256"] = state_digest
        self._replay_sink(frame, int(event["sequence"]))
