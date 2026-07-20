"""Mesa execution service for the local Riff demo.

Keep application construction lazy: subprocess workers import this package and
must never instantiate a second service owner as an import side effect.
"""

from typing import Any


def create_app(*args: Any, **kwargs: Any) -> Any:
    from .app import create_app as factory

    return factory(*args, **kwargs)


__all__ = ["create_app"]
