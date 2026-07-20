"""RFC 8785/JCS primitives used by Gate 2 records.

Gate 1 intentionally continues to use ``wind_contracts.canonical_json_bytes``.
This module is a separate implementation so importing Gate 2 code cannot
change any delivered v1 byte or digest.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any


CANONICAL_JSON_VERSION_V2 = "riff-canonical-json-v2"
MAX_SAFE_INTEGER = 9_007_199_254_740_991


class CanonicalV2Error(ValueError):
    """A value cannot be represented by the Gate 2 JCS contract."""


def _validate_unicode(value: str) -> None:
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise CanonicalV2Error("lone surrogate is not valid canonical JSON")


def _utf16_key(value: str) -> bytes:
    _validate_unicode(value)
    return value.encode("utf-16-be")


def _serialize_string(value: str) -> str:
    _validate_unicode(value)
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _serialize_float(value: float) -> str:
    if not math.isfinite(value):
        raise CanonicalV2Error("non-finite numbers are not valid canonical JSON")
    if value == 0:
        return "0"
    negative = value < 0
    absolute = -value if negative else value
    rendered = repr(absolute).lower()
    if "e" in rendered:
        coefficient, exponent_text = rendered.split("e", 1)
        exponent = int(exponent_text)
        digits = coefficient.replace(".", "")
        digits = digits.rstrip("0") or "0"
        decimal_position = 1 + exponent
        if 1e-6 <= absolute < 1e21:
            if decimal_position <= 0:
                rendered = "0." + ("0" * -decimal_position) + digits
            elif decimal_position >= len(digits):
                rendered = digits + ("0" * (decimal_position - len(digits)))
            else:
                rendered = digits[:decimal_position] + "." + digits[decimal_position:]
        else:
            coefficient = digits[0]
            if len(digits) > 1:
                coefficient += "." + digits[1:]
            normalized_exponent = decimal_position - 1
            rendered = f"{coefficient}e{'+' if normalized_exponent >= 0 else ''}{normalized_exponent}"
    elif rendered.endswith(".0"):
        rendered = rendered[:-2]
    return ("-" if negative else "") + rendered


def _serialize(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if not -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
            raise CanonicalV2Error("integer is outside the JCS safe range")
        return str(value)
    if isinstance(value, float):
        return _serialize_float(value)
    if isinstance(value, str):
        return _serialize_string(value)
    if isinstance(value, list):
        return "[" + ",".join(_serialize(item) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise CanonicalV2Error("canonical JSON object keys must be strings")
        keys = sorted(value, key=_utf16_key)
        return "{" + ",".join(f"{_serialize_string(key)}:{_serialize(value[key])}" for key in keys) + "}"
    raise CanonicalV2Error(f"unsupported canonical JSON type: {type(value).__name__}")


def canonical_json_v2_bytes(value: Any) -> bytes:
    return _serialize(value).encode("utf-8")


def sha256_v2(value: Any) -> str:
    return hashlib.sha256(canonical_json_v2_bytes(value)).hexdigest()


def prefixed_digest(value: dict[str, Any], *, field: str, prefix: str) -> str:
    if field not in value:
        raise CanonicalV2Error(f"digest field is missing: {field}")
    projected = {key: nested for key, nested in value.items() if key != field}
    return prefix + sha256_v2(projected)


def strict_json_loads_v2(data: bytes | str) -> Any:
    text = data.decode("utf-8") if isinstance(data, bytes) else data

    def pairs_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise CanonicalV2Error(f"duplicate JSON key: {key}")
            _validate_unicode(key)
            result[key] = value
        return result

    try:
        value = json.loads(
            text,
            object_pairs_hook=pairs_hook,
            parse_constant=lambda token: (_ for _ in ()).throw(CanonicalV2Error(f"invalid numeric token: {token}")),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CanonicalV2Error("invalid UTF-8 JSON") from exc
    canonical_json_v2_bytes(value)
    return value


def require_canonical_json_v2_bytes(data: bytes) -> Any:
    value = strict_json_loads_v2(data)
    if canonical_json_v2_bytes(value) != data:
        raise CanonicalV2Error("record bytes are not exact riff-canonical-json-v2")
    return value
