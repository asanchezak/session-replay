from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import NotFoundError, StateTransitionError
from core.models.run import ExecutionRun
from core.state_machine import RunStatus, WorkflowStateMachine
from core.utils import to_uuid
from services.audit import AppendEvent, AuditService
from services.workflow_service import WorkflowService

logger = logging.getLogger(__name__)


class ExecutionService:
    """Service for managing execution runs and their state transitions."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.audit = AuditService(session)
        self.workflows = WorkflowService(session)

    async def create_run(self, workflow_id: str, user_id: str | None = None) -> ExecutionRun:
        """Create a new execution run for a workflow."""
        logger.info("Creating run for workflow_id=%s", workflow_id)
        workflow = await self.workflows.get(workflow_id)
        steps = await self.workflows.get_steps(workflow_id)

        WorkflowStateMachine.transition(RunStatus.IDLE, RunStatus.QUEUED)

        run = ExecutionRun(
            workflow_id=workflow_id,
            workflow_snapshot={
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
                    }
                    for s in steps
                ],
            },
            user_id=user_id,
            total_steps=len(steps),
            status="queued",
        )
        self.session.add(run)
        await self.session.flush()

        await self.audit.append(AppendEvent(
            event_type="run_started",
            payload={"workflow_id": workflow_id, "step_count": len(steps)},
            run_id=str(run.id),
        ))
        logger.info("Created run id=%s workflow_id=%s", run.id, workflow_id)
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
        return run

    async def advance_step(self, run_id: str) -> ExecutionRun:
        """Advance the current step index by one."""
        run = await self.get_run(run_id)
        if run.status != RunStatus.RUNNING.value:
            raise StateTransitionError(
                f"Cannot advance step: run is '{run.status}', must be 'running'"
            )
        run.current_step_index += 1
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
