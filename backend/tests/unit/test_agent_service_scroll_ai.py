from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from services.agent_models import PageContext
from services.agent_service import AgentService


def test_should_not_consult_ai_for_selectorless_scroll_step(
    db_session: AsyncSession,
    monkeypatch,
):
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "deterministic_only", False, raising=False)

    agent = AgentService(db_session)

    assert agent._should_consult_ai(
        "run-1",
        {
            "action_type": "scroll",
            "selector_chain": None,
            "value": "0",
        },
        PageContext(url="https://example.com", title="Example"),
    ) is False
