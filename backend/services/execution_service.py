from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import NotFoundError, StateTransitionError
from core.models.run import ExecutionRun
from core.state_machine import RunStatus, WorkflowStateMachine
from services.audit import AuditService
from services.workflow_service import WorkflowService


def _to_uuid(id_str: str) -> uuid.UUID:
    try:
        return uuid.UUID(id_str)
    except ValueError:
        raise NotFoundError(f"Invalid UUID: {id_str}") from None


class ExecutionService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.audit = AuditService(session)
        self.workflows = WorkflowService(session)

    async def create_run(self, workflow_id: str, user_id: str | None = None) -> ExecutionRun:
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

        await self.audit.append(
            event_type="run_started",
            payload={"workflow_id": workflow_id, "step_count": len(steps)},
            run_id=str(run.id),
        )
        return run

    async def get_run(self, run_id: str) -> ExecutionRun:
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
        run = await self.get_run(run_id)

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

        await self.session.flush()

        await self.audit.append(
            event_type=f"run_{new_status.value}",
            payload={
                "from_status": old_status,
                "to_status": new_status.value,
                "current_step": run.current_step_index,
            },
            run_id=run_id,
        )
        return run

    async def advance_step(self, run_id: str) -> ExecutionRun:
        run = await self.get_run(run_id)
        if run.status != RunStatus.RUNNING.value:
            raise StateTransitionError(
                f"Cannot advance step: run is '{run.status}', must be 'running'"
            )
        run.current_step_index += 1
        await self.session.flush()
        return run

    async def pause(self, run_id: str, reason: str) -> ExecutionRun:
        run = await self.transition(run_id, RunStatus.WAITING_FOR_USER)
        run.pause_reason = reason
        await self.session.flush()

        await self.audit.append(
            event_type="run_paused",
            payload={
                "reason": reason,
                "from_status": RunStatus.RUNNING.value,
                "to_status": RunStatus.WAITING_FOR_USER.value,
            },
            run_id=run_id,
        )
        return run

    async def resume(self, run_id: str) -> ExecutionRun:
        return await self.transition(run_id, RunStatus.RUNNING)

    async def fail(self, run_id: str, error: str) -> ExecutionRun:
        run = await self.transition(run_id, RunStatus.FAILED)
        run.error_summary = error
        await self.session.flush()
        return run

    async def complete(self, run_id: str) -> ExecutionRun:
        return await self.transition(run_id, RunStatus.COMPLETED)

    async def cancel(self, run_id: str) -> ExecutionRun:
        return await self.transition(run_id, RunStatus.CANCELED)

    async def list_runs(
        self, workflow_id: str | None = None, status: str | None = None,
        limit: int = 50, offset: int = 0,
    ) -> list[ExecutionRun]:
        query = select(ExecutionRun)
        if workflow_id:
            query = query.where(ExecutionRun.workflow_id == workflow_id)
        if status:
            query = query.where(ExecutionRun.status == status)
        query = query.order_by(ExecutionRun.created_at.desc()).limit(limit).offset(offset)
        result = await self.session.execute(query)
        return list(result.scalars().all())
