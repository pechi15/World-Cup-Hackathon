"""Fail-closed Colab secret loading without secret disclosure."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True, slots=True)
class PerplexityConfiguration:
    configured: bool
    api_key: str | None


def _colab_secret_reader() -> Callable[[str], str | None] | None:
    try:
        from google.colab import userdata  # type: ignore[import-not-found,import-untyped]
    except ImportError:
        return None

    def read(name: str) -> str | None:
        try:
            value = userdata.get(name)
        except Exception:  # Colab raises service-specific errors for missing secrets.
            return None
        return value if isinstance(value, str) and value else None

    return read


def load_perplexity_configuration(
    *,
    secret_reader: Callable[[str], str | None] | None = None,
) -> PerplexityConfiguration:
    enabled = os.getenv("ENABLE_PERPLEXITY_CONTEXT", "").lower() == "true"
    if not enabled:
        return PerplexityConfiguration(configured=False, api_key=None)
    reader = secret_reader or _colab_secret_reader()
    key = reader("PERPLEXITY_API_KEY") if reader is not None else None
    if key is None:
        return PerplexityConfiguration(configured=False, api_key=None)
    return PerplexityConfiguration(configured=True, api_key=key)


def configuration_status(config: PerplexityConfiguration) -> str:
    return f"perplexity_configured={str(config.configured).lower()}"
