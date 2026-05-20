"""Unit tests for the AI provider abstraction.

Pins B-N-05 (hardcoded confidence 0.0) — now fixed: OpenAIProvider parses
confidence from the JSON response content when available.
"""
from __future__ import annotations

import pytest

from ai.client import (
    AIResponse,
    MockProvider,
    OpenAIProvider,
    get_ai_provider,
)
from core.config import settings


@pytest.mark.asyncio
async def test_get_ai_provider_returns_mock_without_key(monkeypatch):
    monkeypatch.setattr(settings, "ai_api_key", "", raising=False)
    monkeypatch.setattr(settings, "ai_provider", "openai", raising=False)
    p = get_ai_provider()
    assert isinstance(p, MockProvider)


@pytest.mark.asyncio
async def test_get_ai_provider_with_override_returns_openai(monkeypatch):
    monkeypatch.setattr(settings, "ai_api_key", "", raising=False)
    monkeypatch.setattr(settings, "ai_provider", "openai", raising=False)
    p = get_ai_provider(api_key_override="sk-fake")
    assert isinstance(p, OpenAIProvider)


@pytest.mark.asyncio
async def test_mock_provider_generate_returns_canned():
    p = MockProvider()
    r = await p.generate("anything")
    assert isinstance(r, AIResponse)
    assert r.content == '{"result": "mock_success", "confidence": 0.85}'
    assert r.confidence == 0.85


@pytest.mark.asyncio
async def test_mock_provider_embed_returns_fixed_size():
    p = MockProvider()
    v = await p.embed("text")
    assert len(v) == 384
    assert all(x == 0.0 for x in v)


@pytest.mark.asyncio
async def test_openai_provider_parses_confidence_from_response():
    """OpenAIProvider parses confidence from the JSON response content."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    fake_resp = SimpleNamespace(
        model="gpt-4o-mini",
        choices=[SimpleNamespace(
            message=SimpleNamespace(
                content='{"selector":"#x","confidence":0.91,"explanation":"ok"}',
                tool_calls=None,
            ),
            finish_reason="stop",
        )],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=20),
    )
    p = OpenAIProvider(api_key="sk-x")
    p._client.chat.completions.create = AsyncMock(return_value=fake_resp)  # type: ignore[assignment]
    out = await p.generate("test")
    assert out.confidence == pytest.approx(0.91)


@pytest.mark.asyncio
async def test_openai_provider_propagates_http_error():
    """API errors from the SDK bubble up to the caller."""
    from unittest.mock import AsyncMock

    from openai import APIError

    p = OpenAIProvider(api_key="sk-x")
    p._client.chat.completions.create = AsyncMock(  # type: ignore[assignment]
        side_effect=APIError("overloaded", request=None, body=None),
    )
    with pytest.raises(APIError):
        await p.generate("test")
