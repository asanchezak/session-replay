"""Phase 5: outcome-driven learning — close the loop after each run.

After a run transitions to a terminal state (completed/failed/canceled) this
service:
1. Walks the run's audit events to find which steps needed healing/recovery.
2. Updates the corresponding `WorkflowStep.selector_stability_score` and
   `heal_count` so future runs (and the runtime AI consult) know which
   selectors are fragile.
3. Updates `WorkflowParameter.validation_count` and `success_count`.

Designed to be fire-and-forget — failures here MUST NOT block run termination.
Hooked from `ExecutionService.transition` when entering a terminal state.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.analysis import WorkflowParameter
from core.models.event import EventLog
from core.models.run import ExecutionRun
from core.models.workflow import WorkflowStep
from core.utils import to_uuid

logger = logging.getLogger(__name__)

# Exponential moving average factor. Each successful uneventful run nudges the
# stability score toward 1.0; each healed step nudges it down.
EMA_ALPHA = 0.25
HEAL_PENALTY = 0.4
SUCCESS_REWARD = 1.0


class LearningService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def record_run_outcome(self, run: ExecutionRun) -> dict[str, int]:
        """Update selector stability + parameter validation counts based on
        what happened in this run. Returns a small summary for logging."""
        try:
            async with self.session.begin_nested():
                run_uuid = run.id
                healed_steps = await self._healed_step_indices(run_uuid)
                executed_steps = await self._executed_step_indices(run_uuid)

                steps_touched = await self._update_step_stability(
                    workflow_id=run.workflow_id,
                    healed=healed_steps,
                    executed=executed_steps,
                )
                params_touched = await self._update_parameter_counts(
                    workflow_id=run.workflow_id,
                    run_succeeded=(run.status == "completed"),
                )
                await self.session.flush()
            return {
                "steps_updated": steps_touched,
                "params_updated": params_touched,
            }
        except Exception as exc:
            logger.warning("LearningService.record_run_outcome failed: %s", exc)
            return {"steps_updated": 0, "params_updated": 0, "error": str(exc)}

    async def _healed_step_indices(self, run_uuid) -> set[int]:
        result = await self.session.execute(
            select(EventLog)
            .where(EventLog.run_id == run_uuid)
            .where(EventLog.event_type.in_(["recovery_attempt", "recovery_success", "plan_update"]))
        )
        healed: set[int] = set()
        for e in result.scalars().all():
            p = e.payload or {}
            idx = p.get("step_index")
            if isinstance(idx, int):
                healed.add(idx)
            elif e.event_type == "plan_update":
                for op in (p.get("ops") or []):
                    op_idx = op.get("step_index")
                    if isinstance(op_idx, int):
                        healed.add(op_idx)
        return healed

    async def _executed_step_indices(self, run_uuid) -> set[int]:
        result = await self.session.execute(
            select(EventLog)
            .where(EventLog.run_id == run_uuid)
            .where(EventLog.event_type == "step_executed")
        )
        executed: set[int] = set()
        for e in result.scalars().all():
            p = e.payload or {}
            if p.get("success") is True and isinstance(p.get("step_index"), int):
                executed.add(p["step_index"])
        return executed

    async def _update_step_stability(
        self, *, workflow_id: str, healed: set[int], executed: set[int],
    ) -> int:
        if not workflow_id:
            return 0
        result = await self.session.execute(
            select(WorkflowStep).where(WorkflowStep.workflow_id == workflow_id)
        )
        steps = result.scalars().all()
        touched = 0
        for s in steps:
            old = s.selector_stability_score
            base = 0.5 if old is None else old
            if s.step_index in healed:
                target = max(0.0, base - HEAL_PENALTY * EMA_ALPHA)
                s.heal_count = (s.heal_count or 0) + 1
            elif s.step_index in executed:
                target = base + (SUCCESS_REWARD - base) * EMA_ALPHA
            else:
                continue  # step not touched this run — leave score alone
            s.selector_stability_score = round(min(1.0, max(0.0, target)), 3)
            touched += 1
        return touched

    async def _update_parameter_counts(
        self, *, workflow_id: str, run_succeeded: bool,
    ) -> int:
        if not workflow_id:
            return 0
        result = await self.session.execute(
            select(WorkflowParameter).where(WorkflowParameter.workflow_id == workflow_id)
        )
        params = result.scalars().all()
        # workflow_parameters.last_validated_at is stored as TIMESTAMP WITHOUT
        # TIME ZONE in PostgreSQL today, so persist a naive UTC value.
        now = datetime.now(UTC).replace(tzinfo=None)
        for p in params:
            p.validation_count = (p.validation_count or 0) + 1
            if run_succeeded:
                p.success_count = (p.success_count or 0) + 1
            p.last_validated_at = now
        return len(params)
