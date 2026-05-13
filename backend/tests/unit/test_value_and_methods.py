"""Tests for value and methods schema: snapshot, API, and legacy compat."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.workflow import Workflow, WorkflowStep
from services.execution_service import ExecutionService


class TestSnapshotIncludesValueAndMethods:
    @pytest.mark.asyncio
    async def test_snapshot_includes_new_fields(self, db_session: AsyncSession):
        """create_run serializes value and methods into workflow_snapshot."""
        svc = ExecutionService(db_session)
        workflow = Workflow(name="Snapshot Test", status="draft")
        db_session.add(workflow)
        await db_session.flush()

        step = WorkflowStep(
            workflow_id=str(workflow.id),
            step_index=0,
            action_type="type",
            intent="Type search",
            selector_chain={"type": "css", "value": "#search"},
            value="hello world",
            methods=[
                {
                    "action_type": "type",
                    "selector_chain": [{"type": "css", "value": "#search-input"}],
                    "value": "hello world",
                }
            ],
        )
        db_session.add(step)
        await db_session.flush()

        run = await svc.create_run(workflow_id=str(workflow.id))
        snapshot = run.workflow_snapshot
        assert snapshot is not None
        steps = snapshot.get("steps", [])
        assert len(steps) == 1
        assert steps[0]["value"] == "hello world"
        assert steps[0]["methods"] is not None
        assert len(steps[0]["methods"]) == 1
        assert steps[0]["methods"][0]["action_type"] == "type"

    @pytest.mark.asyncio
    async def test_legacy_step_null_methods(self, db_session: AsyncSession):
        """Steps without methods default to None in snapshot."""
        svc = ExecutionService(db_session)
        workflow = Workflow(name="Legacy Test", status="draft")
        db_session.add(workflow)
        await db_session.flush()

        step = WorkflowStep(
            workflow_id=str(workflow.id),
            step_index=0,
            action_type="click",
            intent="Click button",
            selector_chain={"type": "css", "value": "#btn"},
            value=None,
            methods=None,
        )
        db_session.add(step)
        await db_session.flush()

        run = await svc.create_run(workflow_id=str(workflow.id))
        steps = run.workflow_snapshot["steps"]
        assert steps[0]["value"] is None
        assert steps[0]["methods"] is None

    @pytest.mark.asyncio
    async def test_snapshot_mixed_steps(self, db_session: AsyncSession):
        """Workflow with both method-having and legacy steps."""
        svc = ExecutionService(db_session)
        workflow = Workflow(name="Mixed Test", status="draft")
        db_session.add(workflow)
        await db_session.flush()
        wf_id = str(workflow.id)

        step0 = WorkflowStep(
            workflow_id=wf_id,
            step_index=0,
            action_type="click",
            methods=None,
        )
        step1 = WorkflowStep(
            workflow_id=wf_id,
            step_index=1,
            action_type="type",
            value="hello",
            methods=[
                {"action_type": "type", "selector_chain": [{"type": "css", "value": "#input"}]}
            ],
        )
        db_session.add_all([step0, step1])
        await db_session.flush()

        run = await svc.create_run(workflow_id=wf_id)
        steps = run.workflow_snapshot["steps"]
        assert steps[0]["value"] is None
        assert steps[0]["methods"] is None
        assert steps[1]["value"] == "hello"
        assert steps[1]["methods"] is not None
        assert len(steps[1]["methods"]) == 1
