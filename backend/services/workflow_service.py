from __future__ import annotations

import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import NotFoundError
from core.models.workflow import Workflow, WorkflowStep
from services.audit import AuditService


class WorkflowService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.audit = AuditService(session)

    async def create(
        self,
        name: str,
        description: str | None = None,
        prompt: str | None = None,
        target_url: str | None = None,
        created_by: str | None = None,
    ) -> Workflow:
        workflow = Workflow(
            name=name,
            description=description,
            prompt=prompt,
            target_url=target_url,
            created_by=created_by,
            status="draft",
        )
        self.session.add(workflow)
        await self.session.flush()
        return workflow

    async def get(self, workflow_id: str) -> Workflow:
        try:
            uid = uuid.UUID(workflow_id)
        except ValueError:
            raise NotFoundError(f"Workflow {workflow_id} not found") from None
        result = await self.session.execute(
            select(Workflow).where(Workflow.id == uid)
        )
        workflow = result.scalar_one_or_none()
        if not workflow:
            raise NotFoundError(f"Workflow {workflow_id} not found")
        return workflow

    async def list(
        self, status: str | None = None, limit: int = 50, offset: int = 0
    ) -> list[Workflow]:
        query = select(Workflow)
        if status:
            query = query.where(Workflow.status == status)
        query = query.order_by(Workflow.created_at.desc()).limit(limit).offset(offset)
        result = await self.session.execute(query)
        return list(result.scalars().all())

    async def update_status(self, workflow_id: str, status: str) -> Workflow:
        workflow = await self.get(workflow_id)
        workflow.status = status
        await self.session.flush()
        await self.audit.append(
            event_type="checkpoint",
            payload={"workflow_id": workflow_id, "status": status},
            run_id=workflow_id,
        )
        return workflow

    async def add_step(
        self,
        workflow_id: str,
        step_index: int,
        action_type: str,
        intent: str | None = None,
        selector_chain: dict | None = None,
        **kwargs,
    ) -> WorkflowStep:
        step = WorkflowStep(
            workflow_id=workflow_id,
            step_index=step_index,
            action_type=action_type,
            intent=intent,
            selector_chain=selector_chain,
            **kwargs,
        )
        self.session.add(step)
        await self.session.flush()
        return step

    async def get_steps(self, workflow_id: str) -> list[WorkflowStep]:
        result = await self.session.execute(
            select(WorkflowStep)
            .where(WorkflowStep.workflow_id == workflow_id)
            .order_by(WorkflowStep.step_index)
        )
        return list(result.scalars().all())

    async def count_steps(self, workflow_id: str) -> int:
        from sqlalchemy import func
        result = await self.session.execute(
            select(func.count(WorkflowStep.id))
            .where(WorkflowStep.workflow_id == workflow_id)
        )
        return result.scalar() or 0

    async def update_workflow(
        self,
        workflow_id: str,
        name: str | None = None,
        description: str | None = None,
        prompt: str | None = None,
        target_url: str | None = None,
    ) -> Workflow:
        workflow = await self.get(workflow_id)
        if name is not None:
            workflow.name = name
        if description is not None:
            workflow.description = description
        if prompt is not None:
            workflow.prompt = prompt
        if target_url is not None:
            workflow.target_url = target_url
        await self.session.flush()
        return workflow

    async def update_step(
        self,
        workflow_id: str,
        step_index: int,
        selector_chain: list | None = None,
        intent: str | None = None,
        ai_hint: str | None = None,
    ) -> WorkflowStep:
        await self.get(workflow_id)
        steps = await self.get_steps(workflow_id)
        for step in steps:
            if step.step_index == step_index:
                if selector_chain is not None:
                    step.selector_chain = selector_chain
                if intent is not None:
                    step.intent = intent
                if ai_hint is not None:
                    step.ai_hint = ai_hint
                await self.session.flush()
                return step
        raise NotFoundError(f"Step {step_index} not found in workflow {workflow_id}")

    async def delete(self, workflow_id: str) -> None:
        workflow = await self.get(workflow_id)
        await self.session.delete(workflow)
        await self.session.execute(
            update(WorkflowStep)
            .where(WorkflowStep.workflow_id == workflow_id)
            .values(workflow_id=None)
        )
