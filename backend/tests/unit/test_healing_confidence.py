"""Pins B-C-01 — healing confidence threshold is never enforced.

PRD §13: "The system should never silently execute a low-confidence recovery."
Today: `HealingService.suggest_heal` returns whatever the AI reports (often 0.0
because OpenAI hardcodes confidence to 0.0). The caller in `/v1/runs/{id}/heal-step`
hands it to the extension which uses its own `> 0.3` cutoff. There is no
backend-side gate.

This test asserts the corrected behavior:
- if `confidence < settings.ai_confidence_threshold`, `suggest_heal` must
  return `new_selectors=[]` AND set `below_threshold=True` in the explanation
  (or via a dedicated field).
"""
from __future__ import annotations

import uuid

import pytest

from ai.client import AIProvider, AIResponse
from core.config import settings
from core.models.run import ExecutionRun
from services.healing_service import HealingService


class _FixedConfidenceProvider(AIProvider):
    def __init__(self, content: str, confidence: float = 0.0):
        self._content = content
        self._conf = confidence

    async def generate(self, prompt, system=None, max_tokens=1024):
        return AIResponse(content=self._content, model="fake", confidence=self._conf)

    async def embed(self, text):
        return [0.0] * 384


@pytest.fixture
def low_threshold(monkeypatch):
    monkeypatch.setattr(settings, "ai_confidence_threshold", 0.85, raising=False)
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)


@pytest.mark.asyncio
async def test_low_confidence_heal_is_rejected(db_session, monkeypatch, low_threshold):
    """Confidence 0.4 with threshold 0.85 → must return empty new_selectors and an explicit below_threshold flag."""

    def _provider_factory(api_key_override=None):
        return _FixedConfidenceProvider(
            '{"selector": "#x", "confidence": 0.4, "explanation": "guess"}',
            confidence=0.4,
        )

    import services.healing_service as hs
    monkeypatch.setattr(hs, "get_ai_provider", _provider_factory)

    run = ExecutionRun(id=uuid.uuid4(), workflow_id="w", status="recovering", total_steps=1)
    svc = HealingService(db_session)
    out = await svc.suggest_heal(
        run=run, step_index=0, dom_snippet="<html><body></body></html>",
        old_selectors=["#missing"], intent="click submit",
    )

    assert out["new_selectors"] == [], "Low-confidence heals must not be returned"
    assert out.get("below_threshold") is True or out["confidence"] < 0.85


@pytest.mark.asyncio
async def test_no_ai_key_short_circuits(db_session, monkeypatch):
    """No AI key configured → returns explanation, never calls a provider."""
    monkeypatch.setattr(settings, "ai_api_key", "", raising=False)
    run = ExecutionRun(id=uuid.uuid4(), workflow_id="w", status="recovering", total_steps=1)
    svc = HealingService(db_session)
    out = await svc.suggest_heal(
        run=run, step_index=0, dom_snippet="<html/>", old_selectors=[], intent=None,
    )
    assert out["new_selectors"] == []
    assert "AI not configured" in out["explanation"]
    assert out["confidence"] == 0.0


@pytest.mark.asyncio
async def test_high_confidence_heal_is_applied(db_session, monkeypatch, low_threshold):
    """Confidence 0.95 with threshold 0.85 → selector is returned."""

    def _provider_factory(api_key_override=None):
        return _FixedConfidenceProvider(
            '{"selector": {"type":"css","value":"#login"}, "confidence": 0.95, "explanation": "matched"}',
            confidence=0.95,
        )

    import services.healing_service as hs
    monkeypatch.setattr(hs, "get_ai_provider", _provider_factory)

    run = ExecutionRun(id=uuid.uuid4(), workflow_id="w", status="recovering", total_steps=1)
    svc = HealingService(db_session)
    out = await svc.suggest_heal(
        run=run, step_index=0, dom_snippet="<button id='login'/>",
        old_selectors=["#login-old"], intent="click login",
    )
    assert out["new_selectors"], "High-confidence heal must return selectors"


@pytest.mark.asyncio
async def test_malformed_ai_response_is_caught(db_session, monkeypatch, low_threshold):
    """AI returns invalid JSON → no exception, returns explanation with prefix."""

    def _provider_factory(api_key_override=None):  # noqa: ARG001
        return _FixedConfidenceProvider("not json at all", confidence=0.5)

    import services.healing_service as hs
    monkeypatch.setattr(hs, "get_ai_provider", _provider_factory)

    run = ExecutionRun(id=uuid.uuid4(), workflow_id="w", status="recovering", total_steps=1)
    svc = HealingService(db_session)
    out = await svc.suggest_heal(
        run=run, step_index=0, dom_snippet="<html/>", old_selectors=[], intent=None,
    )
    assert out["new_selectors"] == []
    assert "unparseable" in out["explanation"]
