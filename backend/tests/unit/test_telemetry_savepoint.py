"""Regression: telemetry writes must NEVER poison the parent session.

The 2026-05-15 incident:
- ai_decision_outcomes.resolved_at was created as TIMESTAMP WITHOUT TIME ZONE
  but the writer passed a tz-aware datetime
- asyncpg raised DataError
- the entire SQLAlchemy session rolled back
- AgentService.report_result couldn't load workflow_snapshot → 500
- the extension stopped polling → run sat in `running` forever

Wrapping telemetry writes in a SAVEPOINT (begin_nested) means a failing
telemetry write rolls back ONLY its own savepoint and the parent session
stays usable.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from sqlalchemy import select

from core.models.ai_decision_outcome import AIDecisionOutcome
from services.ai_outcome_service import AIOutcomeService


@pytest.mark.asyncio
async def test_resolve_latest_swallows_errors(db_session):
    """If resolve_latest hits an error, it must NOT raise and the parent
    session must remain usable for subsequent queries."""
    svc = AIOutcomeService(db_session)

    # Patch execute to simulate an error inside the savepoint
    real_execute = db_session.execute
    call_count = {"n": 0}

    async def flaky_execute(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("simulated DB error")
        return await real_execute(*args, **kwargs)

    # Sabotage the first call only
    with patch.object(db_session, "execute", side_effect=flaky_execute):
        # Must not raise
        await svc.resolve_latest(
            "00000000-0000-0000-0000-000000000099", 0, "success",
        )

    # The session must still be usable
    res = await db_session.execute(select(AIDecisionOutcome))
    rows = res.scalars().all()
    assert isinstance(rows, list)


@pytest.mark.asyncio
async def test_record_decision_swallows_errors(db_session):
    """Same guarantee for record_decision."""
    svc = AIOutcomeService(db_session)

    with patch.object(
        db_session, "flush", side_effect=RuntimeError("simulated"),
    ):
        row = await svc.record_decision(
            run_id="00000000-0000-0000-0000-000000000098",
            step_index=0,
            decision="EXECUTE",
            confidence=0.9,
        )
    assert row is None

    # Session is still usable
    res = await db_session.execute(select(AIDecisionOutcome))
    assert isinstance(res.scalars().all(), list)
