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

Each write is wrapped in a savepoint (`session.begin_nested()`). On failure,
only the savepoint rolls back — the outer transaction and any pre-existing
session objects (e.g. the `run` loaded by `AgentService.poll()`) are left
intact and un-expired. This prevents the MissingGreenlet crash that occurred
when a full `session.rollback()` expired `run` mid-request, and preserves
audit log writes (from `AuditService.append`) that precede telemetry calls.

History:
- 2026-05-15: `resolved_at` fixed to `DateTime(timezone=True)` in the model
- 2026-05-15: switched from full rollback to savepoints to prevent session
  object expiry (#d892bf0a — greenlet_spawn crash on poll() after missing
  migration columns triggered record_decision failure)
"""
from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.ai_decision_outcome import AIDecisionOutcome
from core.models.ai_reasoning_chain import AIReasoningChain
from core.models.page_state_snapshot import PageStateSnapshot
from core.models.recovery_attempt_trace import RecoveryAttemptTrace
from core.models.run import ExecutionRun
from core.models.run_summary import RunSummary
from core.utils import to_uuid

logger = logging.getLogger(__name__)


class AIOutcomeService:
    """Records and resolves AI decision outcomes.

    All public write methods are fail-open: any DB error is caught, only the
    savepoint rolls back (outer transaction stays intact), and None is returned.
    The caller's request continues unaffected and session objects are not expired.
    """

    def __init__(self, session: AsyncSession):
        self.session = session

    async def load_run_memory(
        self,
        run_id: str,
        decisions_limit: int = 10,
        traces_limit: int = 5,
    ) -> dict[str, list[dict[str, Any]]]:
        """Load a bounded summary of prior AI decisions and recovery traces."""
        uid = to_uuid(run_id) if "-" in run_id else run_id
        memory: dict[str, list[dict[str, Any]]] = {"decisions": [], "traces": []}
        try:
            decision_rows = await self.session.execute(
                select(AIDecisionOutcome)
                .where(AIDecisionOutcome.run_id == str(uid))
                .order_by(AIDecisionOutcome.created_at.desc())
                .limit(decisions_limit)
            )
            for row in reversed(list(decision_rows.scalars().all())):
                memory["decisions"].append({
                    "step": row.step_index,
                    "decision": row.decision,
                    "confidence": row.confidence or 0.0,
                    "outcome": row.actual_outcome,
                    "summary": (row.reasoning or "")[:120],
                })

            trace_rows = await self.session.execute(
                select(RecoveryAttemptTrace)
                .where(RecoveryAttemptTrace.run_id == str(uid))
                .order_by(RecoveryAttemptTrace.created_at.desc())
                .limit(traces_limit)
            )
            for row in reversed(list(trace_rows.scalars().all())):
                memory["traces"].append({
                    "step": row.step_index,
                    "trigger": row.trigger,
                    "error": (row.error_message or "")[:100],
                    "suggested_action": row.suggested_action,
                    "outcome": row.outcome,
                })
        except Exception as exc:
            logger.warning("AIOutcomeService.load_run_memory failed: %s", exc)
        return memory

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
        thinking_steps: list | None = None,
        decision_context: dict | None = None,
        screenshot_meta: dict | None = None,
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
                thinking_steps=thinking_steps,
                decision_context=decision_context,
                screenshot_meta=screenshot_meta,
            )
            async with self.session.begin_nested():
                self.session.add(row)
                await self.session.flush()
            return row
        except Exception as exc:
            logger.warning("AIOutcomeService.record_decision failed: %s", exc)
            return None

    async def resolve_latest(
        self,
        run_id: str,
        step_index: int,
        actual_outcome: str,
    ) -> None:
        row = None
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
            # Expire only the modified row to clear dirty state without a full
            # session rollback that would expire pre-existing identity-map objects.
            if row is not None:
                try:
                    self.session.expire(row)
                except Exception:
                    pass

    async def record_reasoning_chain(
        self,
        run_id: str,
        step_index: int,
        decision: str,
        thinking_steps: list | None,
        full_reasoning: str | None = None,
        invocation_type: str = "step_decision",
        prompt_summary: str | None = None,
        context_snapshot: dict | None = None,
        model: str | None = None,
        latency_ms: int | None = None,
    ) -> AIReasoningChain | None:
        try:
            row = AIReasoningChain(
                run_id=run_id,
                step_index=step_index,
                decision=decision,
                thinking_steps=thinking_steps or [],
                full_reasoning=full_reasoning,
                prompt_summary=prompt_summary,
                context_snapshot=context_snapshot,
                invocation_type=invocation_type,
                model=model,
                latency_ms=latency_ms,
            )
            async with self.session.begin_nested():
                self.session.add(row)
                await self.session.flush()
            return row
        except Exception as exc:
            logger.warning("AIOutcomeService.record_reasoning_chain failed: %s", exc)
            return None

    async def record_page_snapshot(
        self,
        run_id: str,
        step_index: int,
        trigger: str,
        ctx: Any,
    ) -> PageStateSnapshot | None:
        try:
            dom_snippet = getattr(ctx, "dom_snippet", "") or ""
            dom_snippet_hash = hashlib.sha256(dom_snippet.encode()).hexdigest()[:32] if dom_snippet else None

            visible_text = getattr(ctx, "visible_text", "") or ""
            visible_elements = getattr(ctx, "visible_elements", None)
            blocking_type = getattr(ctx, "blocking_type", None)
            blocking_type_val = blocking_type.value if hasattr(blocking_type, "value") else str(blocking_type) if blocking_type else None

            row = PageStateSnapshot(
                run_id=run_id,
                step_index=step_index,
                trigger=trigger,
                url=getattr(ctx, "url", None),
                title=getattr(ctx, "title", None),
                visible_text_excerpt=visible_text[:2000] if visible_text else None,
                element_count=len(visible_elements) if visible_elements else None,
                blocking_type=blocking_type_val,
                is_blocking=bool(getattr(ctx, "is_blocking", False)),
                visible_elements=(visible_elements[:20] if visible_elements else None),
                dom_snippet_hash=dom_snippet_hash,
                captured_at=datetime.now(UTC),
            )
            async with self.session.begin_nested():
                self.session.add(row)
                await self.session.flush()
            return row
        except Exception as exc:
            logger.warning("AIOutcomeService.record_page_snapshot failed: %s", exc)
            return None

    async def record_recovery_trace(
        self,
        run_id: str,
        step_index: int,
        attempt_number: int,
        trigger: str,
        error: str | None,
        analysis_result: dict | None,
        outcome: str | None = None,
        model: str | None = None,
        latency_ms: int | None = None,
    ) -> RecoveryAttemptTrace | None:
        try:
            ar = analysis_result or {}
            row = RecoveryAttemptTrace(
                run_id=run_id,
                step_index=step_index,
                attempt_number=attempt_number,
                trigger=trigger,
                error_message=error,
                likely_cause=ar.get("likely_cause"),
                analysis_text=ar.get("analysis"),
                suggested_action=ar.get("suggested_action"),
                suggested_value=ar.get("suggested_value"),
                suggested_selectors=ar.get("suggested_selectors"),
                should_retry=bool(ar.get("should_retry", False)),
                should_skip=bool(ar.get("should_skip", False)),
                confidence=ar.get("confidence"),
                outcome=outcome,
                ai_invoked=True,
                model=model,
                latency_ms=latency_ms,
            )
            async with self.session.begin_nested():
                self.session.add(row)
                await self.session.flush()
            return row
        except Exception as exc:
            logger.warning("AIOutcomeService.record_recovery_trace failed: %s", exc)
            return None

    async def finalize_run_summary(self, run: ExecutionRun) -> RunSummary | None:
        try:
            run_id_str = str(run.id)
            workflow_id_str = str(run.workflow_id)

            # Count decisions from DB — more reliable than in-process dicts.
            decision_counts: dict[str, int] = {}
            for decision_val in (
                "ADAPT", "RETRY", "PAUSE", "HEAL", "SKIP", "EXECUTE",
                "COMPLETED", "WAIT", "RESTART", "ROLLBACK",
            ):
                result = await self.session.execute(
                    select(func.count(AIDecisionOutcome.id)).where(
                        AIDecisionOutcome.run_id == run_id_str,
                        AIDecisionOutcome.decision == decision_val,
                    )
                )
                decision_counts[decision_val] = result.scalar() or 0

            # Total AI latency
            latency_result = await self.session.execute(
                select(func.sum(AIDecisionOutcome.latency_ms)).where(
                    AIDecisionOutcome.run_id == run_id_str,
                    AIDecisionOutcome.latency_ms.isnot(None),
                )
            )
            total_latency = latency_result.scalar()

            # Supervisor resume count from recovery traces
            sup_result = await self.session.execute(
                select(func.count(RecoveryAttemptTrace.id)).where(
                    RecoveryAttemptTrace.run_id == run_id_str,
                    RecoveryAttemptTrace.trigger == "supervisor",
                )
            )
            supervisor_resumes = sup_result.scalar() or 0

            # Healed steps: recovery traces with trigger=heal and outcome=applied
            healed_result = await self.session.execute(
                select(func.count(RecoveryAttemptTrace.id)).where(
                    RecoveryAttemptTrace.run_id == run_id_str,
                    RecoveryAttemptTrace.trigger == "heal",
                    RecoveryAttemptTrace.outcome == "applied",
                )
            )
            steps_healed = healed_result.scalar() or 0

            duration_seconds = None
            if run.started_at and run.ended_at:
                # Normalize to naive UTC for subtraction — SQLite returns naive
                # datetimes even when the column is declared with timezone=True.
                start = run.started_at.replace(tzinfo=None) if run.started_at.tzinfo else run.started_at
                end = run.ended_at.replace(tzinfo=None) if run.ended_at.tzinfo else run.ended_at
                duration_seconds = (end - start).total_seconds()

            row = RunSummary(
                run_id=run_id_str,
                workflow_id=workflow_id_str,
                status=run.status,
                total_steps=run.total_steps,
                steps_completed=run.current_step_index,
                steps_skipped=decision_counts.get("SKIP", 0),
                steps_healed=steps_healed,
                steps_failed=decision_counts.get("HEAL", 0),
                adapt_count=decision_counts.get("ADAPT", 0),
                retry_count=decision_counts.get("RETRY", 0),
                pause_count=decision_counts.get("PAUSE", 0),
                supervisor_resumes=supervisor_resumes,
                ai_invocations=sum(decision_counts.values()),
                total_ai_latency_ms=int(total_latency) if total_latency else None,
                started_at=run.started_at,
                ended_at=run.ended_at,
                duration_seconds=duration_seconds,
                error_summary=run.error_summary,
                goal_progress_final=run.goal_progress,
            )
            async with self.session.begin_nested():
                self.session.add(row)
                await self.session.flush()
            return row
        except Exception as exc:
            logger.warning("AIOutcomeService.finalize_run_summary failed: %s", exc)
            return None
