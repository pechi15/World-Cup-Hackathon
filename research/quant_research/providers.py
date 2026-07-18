"""Structured model providers for offline agents only."""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, TypeVar, cast

from pydantic import BaseModel


ResponseT = TypeVar("ResponseT", bound=BaseModel)


class ProviderDisabled(RuntimeError):
    pass


class ProviderResponseError(RuntimeError):
    pass


def _agent_api_schema(model: type[BaseModel]) -> dict[str, Any]:
    raw = model.model_json_schema()
    definitions = raw.get("$defs", {})

    def transform(node: Any, stack: tuple[str, ...] = ()) -> Any:
        if isinstance(node, list):
            return [transform(item, stack) for item in node]
        if not isinstance(node, dict):
            return node
        reference = node.get("$ref")
        if reference:
            name = reference.rsplit("/", 1)[-1]
            if name in stack:
                raise ValueError("Perplexity structured output does not support recursive schemas")
            if name not in definitions:
                raise ValueError(f"unresolved schema reference {reference}")
            merged = {**definitions[name], **{key: value for key, value in node.items() if key != "$ref"}}
            return transform(merged, (*stack, name))
        transformed = {
            key: transform(value, stack)
            for key, value in node.items()
            if key != "$defs"
        }
        if transformed.get("type") == "object" or "properties" in transformed:
            properties = transformed.get("properties", {})
            if transformed.get("additionalProperties") is True:
                raise ValueError("unconstrained mapping schemas are not supported")
            if "additionalProperties" not in transformed:
                transformed["additionalProperties"] = False
            transformed["required"] = list(properties)
        return transformed

    transformed = transform(raw)
    if not isinstance(transformed, dict):
        raise TypeError("top-level response schema must be an object")
    return cast(dict[str, Any], transformed)


class PerplexityAgentProvider:
    """Perplexity Agent API adapter using strict Pydantic JSON schemas.

    It is disabled when ``PERPLEXITY_API_KEY`` is absent and is intentionally
    not imported by the live TypeScript controller.
    """

    endpoint = "https://api.perplexity.ai/v1/agent"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        timeout_seconds: float = 60.0,
        enable_context: bool | None = None,
    ) -> None:
        self._api_key = api_key if api_key is not None else os.getenv("PERPLEXITY_API_KEY")
        self._model: str = model or os.getenv("PERPLEXITY_MODEL") or "openai/gpt-5.6-sol"
        self._timeout_seconds = timeout_seconds
        self._enable_context = (
            enable_context
            if enable_context is not None
            else os.getenv("ENABLE_PERPLEXITY_CONTEXT", "").lower() == "true"
        )

    @property
    def enabled(self) -> bool:
        return self._enable_context and bool(self._api_key)

    @property
    def model_identifier(self) -> str:
        return self._model if self.enabled else "DISABLED"

    def generate(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        response_model: type[ResponseT],
        schema_name: str,
    ) -> ResponseT:
        if not self.enabled:
            raise ProviderDisabled("Perplexity context is not configured")
        safe_name = re.sub(r"[^A-Za-z0-9]", "", schema_name)[:64]
        if not safe_name:
            raise ValueError("schema_name must contain an alphanumeric character")
        payload = {
            "model": self._model,
            "instructions": system_prompt,
            "input": user_prompt,
            "store": False,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": safe_name,
                    "strict": True,
                    "schema": _agent_api_schema(response_model),
                },
            },
        }
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_seconds) as response:
                body = json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            raise ProviderResponseError(f"Perplexity Agent API returned HTTP {error.code}: {detail}") from error
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise ProviderResponseError(f"Perplexity Agent API request failed: {error}") from error
        output_text = _extract_output_text(body)
        try:
            return response_model.model_validate_json(output_text)
        except ValueError as error:
            raise ProviderResponseError("Perplexity output failed Pydantic validation") from error


def _extract_output_text(body: dict[str, Any]) -> str:
    direct = body.get("output_text")
    if isinstance(direct, str):
        return direct
    for output in body.get("output", []):
        if not isinstance(output, dict):
            continue
        for content in output.get("content", []):
            if not isinstance(content, dict):
                continue
            text = content.get("text")
            if isinstance(text, str) and content.get("type") in ("output_text", "text"):
                return text
    raise ProviderResponseError("Perplexity response did not contain output_text")
