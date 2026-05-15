"""Recovery supervisor — keeps the system autonomous.

Watches for runs that have stalled in `waiting_for_user` or `recovering` with
no extension activity, and gives the LLM one more shot at producing a
PlanUpdate (e.g., navigate to a known URL, skip the offending step) to
unstick them.

Companion to `AgentService._last_chance_recovery` — that one fires when the
extension's own polling exhausts retries+heals; this one fires when the run
has been parked for a long time with no extension activity (e.g., user closed
the tab, extension lost its service worker).

Safety: per-run cap on auto-resume attempts (`max_auto_resumes_per_run`).
After the cap, the run stays in `waiting_for_user` and a human must intervene.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core.models.event import EventLog
from core.models.run import ExecutionRun
from core.state_machine import RunStatus
from services.agent_models import SAFETY_LIMITS
from services.agent_service import AgentService
from services.audit import AppendEvent, AuditService

logger = logging.getLogger(__name__)

# Per-run counter of auto-resume attempts, kept in process memory.
_auto_resume_count: dict[str, int] = {}

MAX_AUTO_RESUMES_PER_RUN = 5
STUCK_THRESHOLD_SECONDS = 300  # 5 minutes
SUPERVISOR_POLL_INTERVAL = 30


class RecoverySupervisor:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.agent = AgentService(session)
        self.audit = AuditService(session)

    async def find_stuck_runs(self) -> list[ExecutionRun]:
        """Return runs that look stalled.

        Catches three flavours of stuck:
        - `waiting_for_user` runs — paused for a human that never arrived
        - `recovering` runs — recovery loop stalled
        - `running` runs with no event for `STUCK_THRESHOLD_SECONDS` — extension
          died, lost focus, SW restarted, or a 500 broke the polling loop.
          The 2026-05-15 ghost-run incident exposed this: a 500 on
          `/agent/.../result` left the run state RUNNING with the extension no
          longer polling. Without this branch, the supervisor never noticed.
        """
        cutoff = datetime.now(UTC) - timedelta(seconds=STUCK_THRESHOLD_SECONDS)
        # Don't reach back forever. Old running runs from previous deploys are
        # zombies, not legitimate work. The supervisor only resumes runs
        # created within the last 24h.
        recent_cutoff = datetime.now(UTC) - timedelta(hours=24)
        result = await self.session.execute(
            select(ExecutionRun).where(
                ExecutionRun.status.in_([
                    RunStatus.WAITING_FOR_USER.value,
                    RunStatus.RECOVERING.value,
                    RunStatus.RUNNING.value,
                ]),
                ExecutionRun.created_at >= recent_cutoff,
            )
        )
        candidates = list(result.scalars().all())
        stuck: list[ExecutionRun] = []
        for run in candidates:
            # Find the most recent event on this run; if older than cutoff,
            # treat as stuck.
            ev = await self.session.execute(
                select(EventLog.created_at)
                .where(EventLog.run_id == run.id)
                .order_by(EventLog.sequence_number.desc())
                .limit(1)
            )
            last_at = ev.scalar_one_or_none()
            if last_at is None or last_at < cutoff:
                stuck.append(run)
        return stuck

    async def attempt_resume(self, run: ExecutionRun, *, forced: bool = False) -> bool:
        """Ask the LLM for any actionable recovery and apply it.

        Returns True if the run was successfully kicked back into motion.
        """
        run_id = str(run.id)
        prior = _auto_resume_count.get(run_id, 0)
        if not forced and prior >= MAX_AUTO_RESUMES_PER_RUN:
            logger.info("Run %s already at auto-resume cap (%d)", run_id, prior)
            return False

        # Find the most recent failure to use as recovery context
        ev = await self.session.execute(
            select(EventLog)
            .where(EventLog.run_id == run.id)
            .where(EventLog.event_type.in_(["recovery_failure", "step_executed", "run_paused"]))
            .order_by(EventLog.sequence_number.desc())
            .limit(1)
        )
        last_failure = ev.scalar_one_or_none()
        payload = (last_failure.payload if last_failure else {}) or {}
        step_index = int(payload.get("step_index", run.current_step_index))
        error = str(payload.get("error") or run.pause_reason or "stalled run")

        analysis = await self.agent._analyze_failure(
            run, step_index, error, error_context=None, last_chance=True,
        )

        if not analysis:
            logger.info("Supervisor: no AI analysis for run %s", run_id)
            return False

        # Apply any plan_updates the analyst suggested
        suggested_selectors = analysis.get("suggested_selectors") or []
        suggested_action = analysis.get("suggested_action")
        suggested_value = analysis.get("suggested_value")
        should_skip = analysis.get("should_skip", False)

        ops: list[dict] = []
        if should_skip:
            ops.append({"operation": "REMOVE", "step_index": step_index, "reason": "supervisor skip"})
        elif suggested_action == "navigate" and suggested_value:
            ops.append({
                "operation": "MODIFY", "step_index": step_index,
                "new_step": {
                    "action_type": "navigate",
                    "value": suggested_value,
                    "intent": f"navigate to {suggested_value}",
                    "selector_chain": [],
                },
                "reason": "supervisor navigate",
            })
        elif suggested_selectors:
            ops.append({
                "operation": "MODIFY", "step_index": step_index,
                "new_step": {"selector_chain": suggested_selectors},
                "reason": "supervisor heal",
            })
        else:
            logger.info("Supervisor: AI had no actionable advice for run %s", run_id)
            return False

        await self.agent.healing.apply_plan_update(run, ops)

        # Reset transient retry/heal counters so the agent loop gets a fresh budget
        from services.agent_service import _run_heal_attempts, _run_retries
        _run_retries[run_id] = 0
        _run_heal_attempts[run_id] = 0

        # Transition back to running so the extension will pick it up on next
        # poll. If the run is ALREADY running (idle ghost case), skip — there's
        # nothing to transition; the plan_update + audit event are sufficient
        # for the next poll cycle to pick up the new snapshot.
        if run.status != RunStatus.RUNNING.value:
            try:
                await self.agent.execution.transition(run_id, RunStatus.RUNNING)
            except Exception:
                logger.warning("Supervisor could not transition run %s to running", run_id)
                return False

        _auto_resume_count[run_id] = prior + 1
        await self.audit.append(AppendEvent(
            event_type="run_auto_resumed",
            payload={
                "step_index": step_index,
                "ops": ops,
                "attempt": prior + 1,
                "max_attempts": MAX_AUTO_RESUMES_PER_RUN,
                "forced": forced,
            },
            run_id=run_id,
        ))
        logger.info("Supervisor auto-resumed run %s (attempt %d)", run_id, prior + 1)
        return True

    @staticmethod
    def start_supervisor(app) -> asyncio.Task:
        """Wire into FastAPI's lifespan — mirrors OutboxService.start_processor."""
        from core.database import async_session_factory
        task = asyncio.create_task(_run_supervisor_loop(async_session_factory))
        app.state.recovery_supervisor = task
        logger.info("Recovery supervisor background task started")
        return task


async def _run_supervisor_loop(session_factory: async_sessionmaker[AsyncSession]):
    logger.info("Recovery supervisor loop started")
    while True:
        try:
            async with session_factory() as session:
                supervisor = RecoverySupervisor(session)
                stuck = await supervisor.find_stuck_runs()
                for run in stuck:
                    try:
                        await supervisor.attempt_resume(run)
                        await session.commit()
                    except Exception:
                        logger.exception(
                            "Supervisor attempt failed for run %s", run.id,
                        )
                        await session.rollback()
        except Exception:
            logger.exception("Recovery supervisor error")
        await asyncio.sleep(SUPERVISOR_POLL_INTERVAL)


# Safety helper for tests
def _reset_auto_resume_counters() -> None:
    _auto_resume_count.clear()
