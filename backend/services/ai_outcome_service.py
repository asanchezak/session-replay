"""Phase 4: per-decision telemetry — records decisions and resolves them.

For every agent decision we want to know:
- what was decided (EXECUTE/ADAPT/SKIP/HEAL/PAUSE)
- how confident the model was
- what actually happened (success / failure / timeout)
- round-trip latency

Used by:
- Phase 5 `learning_service` (which decisions led to selector heals → low stability score)
- Frontend AIDecisionTrace (per-step explanation)
- Analytics page (confidence vs. outcome calibration)

The 2026-05-15 ghost-run incident exposed two bugs:
- `resolved_at` was created as `TIMESTAMP WITHOUT TZ` but writes were tz-aware
  → fixed in `core/models/ai_decision_outcome.py` (now `DateTime(timezone=True)`)
- a telemetry write failure poisoned the request's SQLAlchemy session, taking
  `report_result` down with it → mitigated below by explicit rollback on
  failure so the parent request can continue, and by the recovery supervisor
  now catching idle `running` runs too.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.ai_decision_outcome import AIDecisionOutcome
from core.utils import to_uuid

logger = logging.getLogger(__name__)


class AIOutcomeService:
    """Records and resolves AI decision outcomes.

    All public methods are fail-open: any DB error is logged and swallowed,
    and the session is rolled back to a usable state so the caller's request
    can continue. This is critical — the parent `report_result` must NEVER
    fail because of a telemetry hiccup.
    """

    def __init__(self, session: AsyncSession):
        self.session = session

    async def _recover_session(self) -> None:
        """Rollback the session so it stays usable after a write failure."""
        try:
            await self.session.rollback()
        except Exception:
            pass

    async def record_decision(
        self,
        run_id: str,
        step_index: int,
        decision: str,
        confidence: float | None,
        reasoning: str | None = None,
        model: str | None = None,
        prompt: str | None = None,
        latency_ms: int | None = None,
    ) -> AIDecisionOutcome | None:
        try:
            prompt_hash = None
            if prompt:
                prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:32]
            row = AIDecisionOutcome(
                run_id=run_id,
                step_index=step_index,
                decision=decision,
                confidence=confidence,
                reasoning=(reasoning or "")[:2000],
                model=model,
                prompt_hash=prompt_hash,
                latency_ms=latency_ms,
            )
            self.session.add(row)
            await self.session.flush()
            return row
        except Exception as exc:
            logger.warning("AIOutcomeService.record_decision failed: %s", exc)
            await self._recover_session()
            return None

    async def resolve_latest(
        self,
        run_id: str,
        step_index: int,
        actual_outcome: str,
    ) -> None:
        try:
            uid = to_uuid(run_id) if "-" in run_id else run_id
            result = await self.session.execute(
                select(AIDecisionOutcome)
                .where(AIDecisionOutcome.run_id == str(uid))
                .where(AIDecisionOutcome.step_index == step_index)
                .where(AIDecisionOutcome.actual_outcome.is_(None))
                .order_by(AIDecisionOutcome.created_at.desc())
                .limit(1)
            )
            row = result.scalar_one_or_none()
            if row:
                row.actual_outcome = actual_outcome
                row.resolved_at = datetime.now(UTC)
                await self.session.flush()
        except Exception as exc:
            logger.warning("AIOutcomeService.resolve_latest failed: %s", exc)
            await self._recover_session()
