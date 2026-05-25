"""S20–S22 backend pieces — AI provider failures must not crash the healing pipeline.

Covers:
- 5xx / 4xx from OpenAI → suggest_heal returns {confidence:0, new_selectors:[]} (PRD §13).
- Network timeout → same.
- Malformed JSON in response.content → same.
- HTTP success but missing fields → same.

After the Workstream C cutover, OpenAIProvider uses the openai SDK. We mock
the SDK's chat.completions.create entry point directly instead of httpx.
"""
from __future__ import annotations

import uuid

import pytest
from openai import APIError, APITimeoutError

from ai.client import AIProvider, AIResponse
from core.config import settings
from core.models.run import ExecutionRun
from services.healing_service import HealingService


@pytest.fixture
def with_ai_key(monkeypatch):
    monkeypatch.setattr(settings, "ai_api_key", "sk-test", raising=False)
    monkeypatch.setattr(settings, "ai_provider", "openai", raising=False)
    monkeypatch.setattr(settings, "ai_confidence_threshold", 0.85, raising=False)


async def _suggest(db_session, with_ai_key):
    svc = HealingService(db_session)
    run = ExecutionRun(id=uuid.uuid4(), workflow_id="w", status="recovering", total_steps=1)
    return await svc.suggest_heal(
        run=run, step_index=0, dom_snippet="<button id='x'/>",
        old_selectors=["#missing"], intent="click",
    )


def _install_provider(monkeypatch, *, exc: Exception | None = None, content: str | None = None) -> None:
    """Inject a stub AIProvider into get_ai_provider so the healing path runs
    against a controllable failure mode without needing respx/httpx."""

    class _Stub(AIProvider):
        async def generate(self, prompt, system=None, max_tokens=1024, images=None):
            if exc is not None:
                raise exc
            return AIResponse(content=content or "", model="gpt-4o-mini",
                              usage={"prompt_tokens": 1, "completion_tokens": 1})

        async def embed(self, text):
            return [0.0] * 384

    monkeypatch.setattr("services.healing_service.get_ai_provider", lambda **_: _Stub())


@pytest.mark.asyncio
async def test_ai_503_does_not_crash(db_session, with_ai_key, monkeypatch):
    # The healing service catches any provider exception generically and
    # returns the no-heal envelope. We don't need the precise SDK error type.
    _install_provider(monkeypatch, exc=APIError("overloaded (503)", request=None, body=None))  # type: ignore[arg-type]
    out = await _suggest(db_session, with_ai_key)
    assert out["new_selectors"] == []
    assert out["confidence"] == 0.0
    assert "AI provider error" in out["explanation"] or "503" in out["explanation"] or "overloaded" in out["explanation"]


@pytest.mark.asyncio
async def test_ai_400_does_not_crash(db_session, with_ai_key, monkeypatch):
    _install_provider(monkeypatch, exc=APIError("bad request (400)", request=None, body=None))  # type: ignore[arg-type]
    out = await _suggest(db_session, with_ai_key)
    assert out["new_selectors"] == []
    assert out["confidence"] == 0.0


@pytest.mark.asyncio
async def test_ai_malformed_json_returns_no_heal(db_session, with_ai_key, monkeypatch):
    _install_provider(monkeypatch, content="not json at all")
    out = await _suggest(db_session, with_ai_key)
    assert out["new_selectors"] == []
    assert "unparseable" in out["explanation"]


@pytest.mark.asyncio
async def test_ai_missing_selector_field_returns_no_heal(db_session, with_ai_key, monkeypatch):
    _install_provider(monkeypatch, content='{"confidence": 0.9, "explanation":"nothing"}')
    out = await _suggest(db_session, with_ai_key)
    assert out["new_selectors"] == []


@pytest.mark.asyncio
async def test_ai_timeout_does_not_crash(db_session, with_ai_key, monkeypatch):
    err = APITimeoutError(request=None)  # type: ignore[arg-type]
    _install_provider(monkeypatch, exc=err)
    out = await _suggest(db_session, with_ai_key)
    assert out["new_selectors"] == []
    assert out["confidence"] == 0.0


@pytest.mark.asyncio
async def test_ai_failures_return_envelope_not_exception(db_session, with_ai_key, monkeypatch):
    """suggest_heal wraps AI failures and returns a structured envelope."""
    err = APIError("overloaded", request=None, body=None)  # type: ignore[arg-type]
    _install_provider(monkeypatch, exc=err)
    out = await _suggest(db_session, with_ai_key)
    assert out["new_selectors"] == []
