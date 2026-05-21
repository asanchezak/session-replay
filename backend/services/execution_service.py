from __future__ import annotations

import logging
import uuid
from copy import deepcopy
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from core.exceptions import NotFoundError, StateTransitionError
from core.models.run import ExecutionRun
from core.state_machine import RunStatus, WorkflowStateMachine
from core.utils import to_uuid
from services.audit import AppendEvent, AuditService
from services.log_service import get_logger
from services.workflow_service import WorkflowService

logger = logging.getLogger(__name__)
log = get_logger()


class ExecutionService:
    """Service for managing execution runs and their state transitions."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.audit = AuditService(session)
        self.workflows = WorkflowService(session)

    async def create_run(
        self,
        workflow_id: str,
        user_id: str | None = None,
        execution_plan: dict | None = None,
        execution_goal: str | None = None,
    ) -> ExecutionRun:
        """Create a new execution run for a workflow."""
        logger.info("Creating run for workflow_id=%s", workflow_id)
        workflow = await self.workflows.get(workflow_id)
        steps = await self.workflows.get_steps(workflow_id)

        WorkflowStateMachine.transition(RunStatus.IDLE, RunStatus.QUEUED)

        snapshot: dict = {
            "workflow": {
                "id": str(workflow.id),
                "name": workflow.name,
                "version": workflow.version,
                "target_url": workflow.target_url,
            },
            "steps": [
                {
                    "step_index": s.step_index,
                    "action_type": s.action_type,
                    "intent": s.intent,
                    "selector_chain": s.selector_chain,
                    "value": s.value,
                    "methods": s.methods,
                    "success_condition": s.success_condition,
                    # Phase 5: selector stability from EMA learning (None = no history yet)
                    "selector_stability_score": s.selector_stability_score,
                }
                for s in steps
            ],
        }
        snapshot["original_steps"] = deepcopy(snapshot["steps"])

        analysis_data = await self._load_analysis(workflow_id)
        if analysis_data:
            snapshot["analysis"] = analysis_data

        # Phase 6: seed goal_progress from the workflow analysis (if any).
        # phases come from semantic analysis; intents come from each step's
        # recorded intent so the LLM can see "what still needs to happen."
        goal_progress = _seed_goal_progress(analysis_data, snapshot["steps"])

        run = ExecutionRun(
            workflow_id=workflow_id,
            workflow_snapshot=snapshot,
            user_id=user_id,
            total_steps=len(steps),
            status="queued",
            goal_progress=goal_progress,
        )
        self.session.add(run)
        await self.session.flush()

        if execution_plan or execution_goal:
            await self.apply_execution_plan(run, execution_plan or {}, execution_goal)

        await self.audit.append(AppendEvent(
            event_type="run_started",
            payload={"workflow_id": workflow_id, "step_count": run.total_steps},
            run_id=str(run.id),
        ))
        logger.info("Created run id=%s workflow_id=%s", run.id, workflow_id)
        return run

    async def apply_execution_plan(
        self,
        run: ExecutionRun,
        execution_plan: dict,
        execution_goal: str | None = None,
    ) -> ExecutionRun:
        snapshot = deepcopy(run.workflow_snapshot or {})
        analysis = dict(snapshot.get("analysis") or {})
        planned_steps = execution_plan.get("steps")

        if isinstance(planned_steps, list) and planned_steps:
            snapshot["steps"] = [
                {
                    "step_index": i,
                    "action_type": step.get("action_type"),
                    "intent": step.get("intent"),
                    "selector_chain": step.get("selector_chain"),
                    "value": step.get("value"),
                    "methods": step.get("methods"),
                    "success_condition": step.get("success_condition"),
                }
                for i, step in enumerate(planned_steps)
            ]
            run.total_steps = len(snapshot["steps"])
        snapshot["original_steps"] = deepcopy(snapshot.get("steps", []))

        if execution_goal:
            analysis["workflow_goal"] = execution_goal
        if execution_plan:
            analysis["execution_plan"] = {
                "strategy": execution_plan.get("strategy"),
                "mode": execution_plan.get("mode"),
            }
        if analysis:
            snapshot["analysis"] = analysis

        run.workflow_snapshot = snapshot
        run.goal_progress = _seed_goal_progress(snapshot.get("analysis"), snapshot.get("steps", []))
        if execution_plan.get("mode") == "confirmation_required" and isinstance(run.goal_progress, dict):
            run.goal_progress["confirmation_required"] = True

        flag_modified(run, "workflow_snapshot")
        flag_modified(run, "goal_progress")
        await self.session.flush()
        return run

    async def reset_to_start(self, run_id: str) -> ExecutionRun:
        """Reset a run to its original executable snapshot and step 0."""
        run = await self.get_run(run_id)
        snapshot = deepcopy(run.workflow_snapshot or {})
        original_steps = deepcopy(snapshot.get("original_steps") or snapshot.get("steps") or [])
        snapshot["steps"] = original_steps
        for i, step in enumerate(snapshot.get("steps", [])):
            step["step_index"] = i
        run.workflow_snapshot = snapshot
        run.current_step_index = 0
        run.total_steps = len(snapshot.get("steps", []))
        run.goal_progress = _seed_goal_progress(snapshot.get("analysis"), snapshot.get("steps", []))
        flag_modified(run, "workflow_snapshot")
        flag_modified(run, "goal_progress")
        await self.session.flush()
        await self.audit.append(AppendEvent(
            event_type="run_restarted",
            payload={"current_step_index": 0, "total_steps": run.total_steps},
            run_id=run_id,
        ))
        return run

    async def get_run(self, run_id: str) -> ExecutionRun:
        """Get a run by ID."""
        try:
            uid = uuid.UUID(run_id)
        except ValueError:
            raise NotFoundError(f"Run {run_id} not found") from None
        result = await self.session.execute(
            select(ExecutionRun).where(ExecutionRun.id == uid)
        )
        run = result.scalar_one_or_none()
        if not run:
            raise NotFoundError(f"Run {run_id} not found")
        return run

    async def transition(self, run_id: str, target_status: RunStatus) -> ExecutionRun:
        """Transition a run to a new status."""
        uid = to_uuid(run_id)
        result = await self.session.execute(
            select(ExecutionRun).where(ExecutionRun.id == uid).with_for_update()
        )
        run = result.scalar_one_or_none()
        if not run:
            raise NotFoundError(f"Run {run_id} not found")

        old_status = run.status
        try:
            new_status = WorkflowStateMachine.transition(
                RunStatus(old_status), target_status
            )
        except ValueError:
            raise StateTransitionError(
                f"Invalid status: {target_status}"
            ) from None

        run.status = new_status.value

        now = datetime.now(UTC)
        if new_status == RunStatus.RUNNING and not run.started_at:
            run.started_at = now
        if new_status in (RunStatus.FAILED, RunStatus.COMPLETED, RunStatus.CANCELED):
            run.ended_at = now

        try:
            await self.session.flush()
            logger.info("Run %s transitioned %s -> %s", run_id, old_status, new_status.value)
            log.backend("execution", "run_transition", status="success", details={
                "run_id": run_id,
                "from_status": old_status,
                "to_status": new_status.value,
                "current_step": run.current_step_index,
            })
            await self.audit.append(AppendEvent(
                event_type=f"run_{new_status.value}",
                payload={
                    "from_status": old_status,
                    "to_status": new_status.value,
                    "current_step": run.current_step_index,
                },
                run_id=run_id,
            ))
        except Exception:
            await self.session.rollback()
            raise

        # Phase 5: on terminal state, fold this run's outcome back into the
        # workflow's stability scores. Best-effort; learning failures must
        # not block run termination.
        if new_status in (RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELED):
            try:
                from services.learning_service import LearningService
                summary = await LearningService(self.session).record_run_outcome(run)
                logger.info(
                    "Learning recorded for run %s: steps=%d params=%d",
                    run_id, summary.get("steps_updated", 0),
                    summary.get("params_updated", 0),
                )
            except Exception:
                logger.exception("Learning service failed for run %s", run_id)

            try:
                from services.ai_outcome_service import AIOutcomeService
                await AIOutcomeService(self.session).finalize_run_summary(run)
            except Exception:
                logger.exception("RunSummary finalization failed for run %s", run_id)

        return run

    async def advance_step(self, run_id: str) -> ExecutionRun:
        """Advance the current step index by one."""
        run = await self.get_run(run_id)
        if run.status != RunStatus.RUNNING.value:
            raise StateTransitionError(
                f"Cannot advance step: run is '{run.status}', must be 'running'"
            )
        run.current_step_index += 1
        # Phase 6: keep goal_progress in sync with the cursor
        if run.goal_progress:
            run.goal_progress = _advance_goal_progress(
                run.goal_progress, run.current_step_index,
            )
            from sqlalchemy.orm.attributes import flag_modified
            flag_modified(run, "goal_progress")
        if run.current_step_index >= run.total_steps:
            return await self.complete(run_id)
        await self.session.flush()
        logger.info("Advanced step run=%s step=%d", run_id, run.current_step_index)
        return run

    async def pause(self, run_id: str, reason: str) -> ExecutionRun:
        """Pause a run and set the pause reason."""
        run = await self.transition(run_id, RunStatus.WAITING_FOR_USER)
        run.pause_reason = reason
        await self.session.flush()

        await self.audit.append(AppendEvent(
            event_type="run_paused",
            payload={
                "reason": reason,
                "from_status": RunStatus.RUNNING.value,
                "to_status": RunStatus.WAITING_FOR_USER.value,
            },
            run_id=run_id,
        ))
        return run

    async def resume(self, run_id: str) -> ExecutionRun:
        """Resume a paused run."""
        logger.info("Resuming run=%s", run_id)
        return await self.transition(run_id, RunStatus.RUNNING)

    async def fail(self, run_id: str, error: str) -> ExecutionRun:
        """Mark a run as failed."""
        logger.warning("Failing run=%s error=%s", run_id, error)
        run = await self.get_run(run_id)
        run.error_summary = error
        return await self.transition(run_id, RunStatus.FAILED)

    async def complete(self, run_id: str) -> ExecutionRun:
        """Mark a run as completed."""
        logger.info("Completing run=%s", run_id)
        return await self.transition(run_id, RunStatus.COMPLETED)

    async def cancel(self, run_id: str) -> ExecutionRun:
        """Cancel a run."""
        logger.info("Canceling run=%s", run_id)
        return await self.transition(run_id, RunStatus.CANCELED)

    async def _load_analysis(self, workflow_id: str) -> dict | None:
        """Load workflow analysis for the execution snapshot."""
        from services.semantic_analysis_service import SemanticAnalysisService
        try:
            svc = SemanticAnalysisService(self.session)
            phases = await svc.get_phases(workflow_id)
            parameters = await svc.get_parameters(workflow_id)
            analysis = await svc.get_analysis(workflow_id)
            if not analysis and not phases:
                return None
            result: dict = {}
            if analysis:
                result["workflow_goal"] = analysis.workflow_goal
                result["domain_context"] = analysis.domain_context
                result["replay_strategy"] = analysis.replay_strategy
                result["confidence_overall"] = analysis.confidence_overall
                result["goal_predicate"] = analysis.goal_predicate
            if phases:
                result["phases"] = [
                    {
                        "name": p.phase_name,
                        "goal": p.phase_goal,
                        "start_step": p.start_step_index,
                        "end_step": p.end_step_index,
                    }
                    for p in phases
                ]
            if parameters:
                result["parameters"] = [
                    {
                        "key": p.parameter_key,
                        "type": p.parameter_type,
                        "default": p.default_value,
                        "step_index": p.inferred_from_step,
                        "description": p.description,
                    }
                    for p in parameters
                ]
            return result
        except Exception:
            logger.debug("No analysis available for workflow_id=%s", workflow_id)
            return None

    async def list_runs(
        self, workflow_id: str | None = None, status: str | None = None,
        limit: int = 50, offset: int = 0,
    ) -> list[dict]:
        """List runs with optional filters."""
        logger.info("Listing runs workflow_id=%s status=%s", workflow_id, status)
        query = select(ExecutionRun)
        if workflow_id:
            query = query.where(ExecutionRun.workflow_id == workflow_id)
        if status:
            query = query.where(ExecutionRun.status == status)
        query = query.order_by(ExecutionRun.created_at.desc()).limit(limit).offset(offset)
        result = await self.session.execute(query)
        runs = list(result.scalars().all())
        # Detach ORM objects — return dicts
        return [
            {
                "id": str(r.id),
                "workflow_id": r.workflow_id,
                "status": r.status,
                "current_step_index": r.current_step_index,
                "total_steps": r.total_steps,
                "pause_reason": r.pause_reason,
                "error_summary": r.error_summary,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "ended_at": r.ended_at.isoformat() if r.ended_at else None,
                "created_at": r.created_at.isoformat(),
            }
            for r in runs
        ]


# ── Phase 6: goal-first cursor helpers ─────────────────────────────────────

def _seed_goal_progress(
    analysis: dict | None,
    steps: list[dict],
) -> dict:
    """Build the initial goal_progress payload from semantic analysis.

    Always returns a usable structure even when analysis is missing — the
    intents list is derived from each step's recorded `intent`, so the AI
    can see what every step is supposed to accomplish.
    """
    intents = [
        {"step_index": s.get("step_index", i), "intent": s.get("intent") or "", "status": "pending"}
        for i, s in enumerate(steps)
    ]
    phases: list[dict] = []
    if analysis and isinstance(analysis, dict):
        for raw_phase in (analysis.get("phases") or []):
            phases.append({
                "name": raw_phase.get("name", "phase"),
                "goal": raw_phase.get("goal", ""),
                "start_step": int(raw_phase.get("start_step", 0)),
                "end_step": int(raw_phase.get("end_step", 0)),
                "status": "pending",
            })
    # Mark the first phase active so the LLM sees state from poll 1.
    if phases:
        phases[0]["status"] = "active"
    return {
        "workflow_goal": (analysis or {}).get("workflow_goal") if analysis else None,
        "phases": phases,
        "intents": intents,
    }


def _advance_goal_progress(progress: dict, new_step_index: int) -> dict:
    """Update phase + intent statuses after the cursor moves forward."""
    if not isinstance(progress, dict):
        return progress
    intents = list(progress.get("intents") or [])
    for it in intents:
        idx = it.get("step_index")
        if isinstance(idx, int):
            if idx < new_step_index and it.get("status") != "satisfied":
                it["status"] = "satisfied"
            elif idx == new_step_index:
                it["status"] = "active"
            elif idx > new_step_index and it.get("status") not in {"satisfied", "skipped"}:
                it["status"] = "pending"

    phases = list(progress.get("phases") or [])
    for ph in phases:
        start = ph.get("start_step", 0)
        end = ph.get("end_step", 0)
        if new_step_index > end:
            ph["status"] = "done"
        elif start <= new_step_index <= end:
            ph["status"] = "active"
        elif new_step_index < start:
            ph["status"] = "pending"

    return {**progress, "intents": intents, "phases": phases}
