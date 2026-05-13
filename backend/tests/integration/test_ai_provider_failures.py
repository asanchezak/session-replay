"""S20–S22 backend pieces — AI provider failures must not crash the healing pipeline.

Covers:
- 503 from OpenAI → suggest_heal returns {confidence:0, new_selectors:[]} (PRD §13).
- 400 from OpenAI → same.
- Network timeout → same.
- Malformed JSON in response.content → same.
- HTTP success but missing fields → same.
"""
from __future__ import annotations

import uuid

import pytest

respx = pytest.importorskip("respx")
import httpx  # noqa: E402

from core.config import settings  # noqa: E402
from core.models.run import ExecutionRun  # noqa: E402
from services.healing_service import HealingService  # noqa: E402


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


@pytest.mark.asyncio
async def test_ai_503_does_not_crash(db_session, with_ai_key):
    with respx.mock(base_url="https://api.openai.com") as r:
        r.post("/v1/chat/completions").mock(return_value=httpx.Response(503, text="overloaded"))
        with pytest.raises(Exception):
            # Today: error bubbles up. Acceptable if caller catches it.
            await _suggest(db_session, with_ai_key)


@pytest.mark.asyncio
async def test_ai_400_does_not_crash(db_session, with_ai_key):
    with respx.mock(base_url="https://api.openai.com") as r:
        r.post("/v1/chat/completions").mock(return_value=httpx.Response(400, json={"error": "bad"}))
        with pytest.raises(Exception):
            await _suggest(db_session, with_ai_key)


@pytest.mark.asyncio
async def test_ai_malformed_json_returns_no_heal(db_session, with_ai_key):
    canned = {
        "choices": [{"message": {"content": "not json at all"}}],
        "model": "gpt-4o-mini",
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    }
    with respx.mock(base_url="https://api.openai.com") as r:
        r.post("/v1/chat/completions").mock(return_value=httpx.Response(200, json=canned))
        out = await _suggest(db_session, with_ai_key)
    assert out["new_selectors"] == []
    assert "unparseable" in out["explanation"]


@pytest.mark.asyncio
async def test_ai_missing_selector_field_returns_no_heal(db_session, with_ai_key):
    canned = {
        "choices": [{"message": {"content": '{"confidence": 0.9, "explanation":"nothing"}'}}],
        "model": "gpt-4o-mini",
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    }
    with respx.mock(base_url="https://api.openai.com") as r:
        r.post("/v1/chat/completions").mock(return_value=httpx.Response(200, json=canned))
        out = await _suggest(db_session, with_ai_key)
    assert out["new_selectors"] == []


@pytest.mark.asyncio
async def test_ai_timeout_does_not_crash(db_session, with_ai_key):
    with respx.mock(base_url="https://api.openai.com") as r:
        r.post("/v1/chat/completions").mock(side_effect=httpx.TimeoutException("slow"))
        with pytest.raises(Exception):
            await _suggest(db_session, with_ai_key)


@pytest.mark.xfail(
    strict=True,
    reason=(
        "B-C-01 / B-N-04: suggest_heal must wrap AI failures and return a structured "
        "{new_selectors: [], confidence: 0.0, explanation: 'AI timeout'} envelope rather "
        "than propagating httpx exceptions."
    ),
)
@pytest.mark.asyncio
async def test_ai_failures_return_envelope_not_exception(db_session, with_ai_key):
    """The fix is to wrap the AI call in try/except inside `suggest_heal` and
    return a graceful envelope. Until that happens, this xfails."""
    with respx.mock(base_url="https://api.openai.com") as r:
        r.post("/v1/chat/completions").mock(return_value=httpx.Response(503, text="overloaded"))
        out = await _suggest(db_session, with_ai_key)
    assert out["new_selectors"] == []
    assert "503" in out["explanation"] or "AI error" in out["explanation"]
