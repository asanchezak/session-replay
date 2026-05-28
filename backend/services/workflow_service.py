from __future__ import annotations

import logging
import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import NotFoundError, StateTransitionError
from core.models.analysis import (
    OutputSpecification,
    SemanticAction,
    SemanticPhase,
    WorkflowAnalysis,
    WorkflowConnectorBinding,
    WorkflowParameter,
    WorkflowTemplate,
)
from core.models.workflow import Workflow, WorkflowStatus, WorkflowStep, WorkflowType
from services.audit import AppendEvent, AuditService

logger = logging.getLogger(__name__)


class WorkflowService:
    """Service for managing workflow definitions and their steps."""

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
        workflow_type: str = "user",
    ) -> Workflow:
        """Create a new workflow definition."""
        workflow = Workflow(
            name=name,
            description=description,
            prompt=prompt,
            target_url=target_url,
            created_by=created_by,
            status="active",
            workflow_type=workflow_type,
        )
        self.session.add(workflow)
        await self.session.flush()
        return workflow

    async def get(self, workflow_id: str) -> Workflow:
        """Get a workflow by ID."""
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
        self,
        status: str | None = None,
        workflow_type: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Workflow]:
        """List workflows with optional status and type filters."""
        query = select(Workflow)
        if status:
            query = query.where(Workflow.status == status)
        if workflow_type:
            query = query.where(Workflow.workflow_type == workflow_type)
        query = query.order_by(Workflow.created_at.desc()).limit(limit).offset(offset)
        result = await self.session.execute(query)
        return list(result.scalars().all())

    async def promote(self, workflow_id: str) -> Workflow:
        """Promote a user workflow to a system workflow."""
        workflow = await self.get(workflow_id)
        if workflow.workflow_type == WorkflowType.SYSTEM:
            return workflow
        if workflow.status == WorkflowStatus.ARCHIVED:
            raise StateTransitionError("Cannot promote an archived workflow.")
        workflow.workflow_type = WorkflowType.SYSTEM
        await self.session.flush()
        await self.audit.append(AppendEvent(
            event_type="workflow_status_changed",
            payload={"workflow_id": workflow_id, "workflow_type": "system"},
            run_id=workflow_id,
        ))
        return workflow

    async def update_status(self, workflow_id: str, status: str) -> Workflow:
        """Update the status of a workflow."""
        logger.info("Updating workflow status id=%s status=%s", workflow_id, status)
        workflow = await self.get(workflow_id)
        if not WorkflowStatus.valid_transitions(workflow.status, status):
            raise StateTransitionError(
                f"Cannot transition from '{workflow.status}' to '{status}'"
            )
        workflow.status = status
        await self.session.flush()
        await self.audit.append(AppendEvent(
            event_type="workflow_status_changed",
            payload={"workflow_id": workflow_id, "status": status},
            run_id=workflow_id,
        ))
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
        """Add a step to a workflow."""
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
        """Get all steps for a workflow, ordered by step_index."""
        result = await self.session.execute(
            select(WorkflowStep)
            .where(WorkflowStep.workflow_id == workflow_id)
            .order_by(WorkflowStep.step_index)
        )
        return list(result.scalars().all())

    async def count_steps(self, workflow_id: str) -> int:
        """Count the number of steps in a workflow."""
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
        config: dict | None = None,
    ) -> Workflow:
        """Update workflow metadata."""
        workflow = await self.get(workflow_id)
        if name is not None:
            workflow.name = name
        if description is not None:
            workflow.description = description
        if prompt is not None:
            workflow.prompt = prompt
        if target_url is not None:
            workflow.target_url = target_url
        if config is not None:
            # Whole-object replacement. Callers merge upstream when partial.
            merged = dict(workflow.config or {})
            merged.update(config)
            workflow.config = merged
            from sqlalchemy.orm.attributes import flag_modified
            flag_modified(workflow, "config")
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
        """Update a specific step's selectors, intent, or AI hint."""
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

    async def replace_steps(self, workflow_id: str, steps_data: list[dict]) -> list[WorkflowStep]:
        """Atomically replace all steps for a workflow with a new ordered list."""
        await self.session.execute(
            delete(WorkflowStep).where(WorkflowStep.workflow_id == workflow_id)
        )
        new_steps: list[WorkflowStep] = []
        for i, sd in enumerate(steps_data):
            step = WorkflowStep(
                workflow_id=workflow_id,
                step_index=i,
                action_type=sd["action_type"],
                intent=sd.get("intent"),
                selector_chain=sd.get("selector_chain"),
                value=sd.get("value"),
                methods=sd.get("methods"),
                success_condition=sd.get("success_condition"),
                checkpoint=bool(sd.get("checkpoint", False)),
            )
            self.session.add(step)
            new_steps.append(step)
        await self.session.flush()
        return new_steps

    async def delete(self, workflow_id: str) -> None:
        """Delete a workflow and its steps."""
        workflow = await self.get(workflow_id)
        await self._delete_workflow_dependent_records(workflow_id)
        await self.session.delete(workflow)
        await self.session.flush()

    async def delete_all(self, workflow_type: str | None = None) -> dict[str, int]:
        """Delete workflows and their workflow-scoped records.

        When ``workflow_type`` is provided, only workflows of that type and their
        dependent records are removed. The default ``None`` preserves system
        workflows by limiting the wipe to ``user`` workflows — system automations
        must never be deleted by a bulk "delete all" action from the UI.
        """
        effective_type = workflow_type if workflow_type is not None else WorkflowType.USER.value

        ids_result = await self.session.execute(
            select(Workflow.id).where(Workflow.workflow_type == effective_type)
        )
        workflow_ids = [str(row[0]) for row in ids_result]

        counts: dict[str, int] = {}
        if not workflow_ids:
            for key in (
                "semantic_actions", "semantic_phases", "workflow_parameters",
                "workflow_analyses", "workflow_connector_bindings",
                "output_specifications", "workflow_templates",
                "workflow_steps", "workflows",
            ):
                counts[key] = 0
            return counts

        for model, key in [
            (SemanticAction, "semantic_actions"),
            (SemanticPhase, "semantic_phases"),
            (WorkflowParameter, "workflow_parameters"),
            (WorkflowAnalysis, "workflow_analyses"),
            (WorkflowConnectorBinding, "workflow_connector_bindings"),
            (OutputSpecification, "output_specifications"),
            (WorkflowTemplate, "workflow_templates"),
            (WorkflowStep, "workflow_steps"),
        ]:
            resp = await self.session.execute(
                delete(model).where(model.workflow_id.in_(workflow_ids))
            )
            counts[key] = resp.rowcount or 0

        resp = await self.session.execute(
            delete(Workflow).where(Workflow.id.in_([uuid.UUID(i) for i in workflow_ids]))
        )
        counts["workflows"] = resp.rowcount or 0

        await self.session.flush()
        return counts

    async def _delete_workflow_dependent_records(self, workflow_id: str) -> None:
        """Delete records that are scoped to a single workflow."""
        for model in [
            SemanticAction,
            SemanticPhase,
            WorkflowParameter,
            WorkflowAnalysis,
            WorkflowConnectorBinding,
            OutputSpecification,
            WorkflowTemplate,
            WorkflowStep,
        ]:
            await self.session.execute(
                delete(model).where(model.workflow_id == workflow_id)
            )
