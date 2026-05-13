"""Unit tests for the AI provider abstraction.

Pins B-N-05 (hardcoded confidence 0.0) — the test documents this as an xfail
to be flipped once OpenAIProvider returns a meaningful confidence (e.g., parsed
from a structured JSON response).
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


@pytest.mark.xfail(
    strict=True,
    reason="B-N-05: OpenAIProvider hardcodes confidence=0.0 instead of parsing it from the response.",
)
@pytest.mark.asyncio
async def test_openai_provider_parses_confidence_from_response(monkeypatch):
    """If the AI replies with a JSON-shaped content that contains `confidence`,
    AIResponse.confidence should reflect it — not be hardcoded 0.0.
    """
    respx = pytest.importorskip("respx")
    import httpx

    canned = {
        "choices": [{"message": {"content": '{"selector":"#x","confidence":0.91,"explanation":"ok"}'}}],
        "model": "gpt-4o-mini",
        "usage": {"prompt_tokens": 10, "completion_tokens": 20},
    }
    with respx.mock(base_url="https://api.openai.com") as r:
        r.post("/v1/chat/completions").mock(return_value=httpx.Response(200, json=canned))
        p = OpenAIProvider(api_key="sk-x")
        out = await p.generate("test")
    assert out.confidence == pytest.approx(0.91)


@pytest.mark.asyncio
async def test_openai_provider_propagates_http_error():
    respx = pytest.importorskip("respx")
    import httpx

    with respx.mock(base_url="https://api.openai.com") as r:
        r.post("/v1/chat/completions").mock(return_value=httpx.Response(503, text="overloaded"))
        p = OpenAIProvider(api_key="sk-x")
        with pytest.raises(httpx.HTTPStatusError):
            await p.generate("test")
