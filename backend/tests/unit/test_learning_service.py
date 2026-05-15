"""Phase 5: outcome-driven learning — selector stability evolves across runs."""
from __future__ import annotations

import pytest

from core.models.analysis import WorkflowParameter
from core.models.workflow import Workflow, WorkflowStep
from services.audit import AppendEvent, AuditService
from services.execution_service import ExecutionService
from services.learning_service import LearningService


def _selector_chain(idx: int) -> list[dict]:
    return [{"type": "css", "value": f"#x{idx}"}]


async def _make_workflow(db_session, n_steps: int = 2) -> Workflow:
    wf = Workflow(name="Learning WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    for i in range(n_steps):
        step = WorkflowStep(
            workflow_id=str(wf.id),
            step_index=i,
            action_type="click",
            selector_chain=_selector_chain(i),
        )
        db_session.add(step)
    await db_session.flush()
    return wf


@pytest.mark.asyncio
async def test_healed_step_loses_stability(db_session):
    wf = await _make_workflow(db_session)
    svc = ExecutionService(db_session)
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = {"workflow": {"id": str(wf.id)}, "steps": [
        {"step_index": i, "action_type": "click", "selector_chain": _selector_chain(i)}
        for i in range(2)
    ]}
    run.total_steps = 2
    await db_session.flush()

    audit = AuditService(db_session)
    # Step 0 succeeded
    await audit.append(AppendEvent(
        event_type="step_executed",
        payload={"step_index": 0, "action_type": "click", "success": True},
        run_id=str(run.id),
    ))
    # Step 1 needed recovery_attempt
    await audit.append(AppendEvent(
        event_type="recovery_attempt",
        payload={"step_index": 1, "confidence": 0.7},
        run_id=str(run.id),
    ))
    # Mark run completed (so the learning callback runs)
    run.status = "completed"

    learn = LearningService(db_session)
    summary = await learn.record_run_outcome(run)
    assert summary["steps_updated"] == 2

    # Refetch the steps to see the updated stability
    from sqlalchemy import select
    res = await db_session.execute(
        select(WorkflowStep).where(WorkflowStep.workflow_id == str(wf.id)).order_by(WorkflowStep.step_index)
    )
    steps = res.scalars().all()
    # Step 0 (executed cleanly) should have stability_score > 0.5 (the default base)
    assert steps[0].selector_stability_score is not None
    assert steps[0].selector_stability_score > 0.5
    # Step 1 (healed) should have stability_score < 0.5
    assert steps[1].selector_stability_score is not None
    assert steps[1].selector_stability_score < 0.5
    # And heal_count should be 1
    assert steps[1].heal_count == 1


@pytest.mark.asyncio
async def test_parameter_counts_increment(db_session):
    wf = await _make_workflow(db_session)
    # Two parameters
    p1 = WorkflowParameter(
        workflow_id=str(wf.id), parameter_key="search_query", parameter_type="string",
        default_value="indeed", confidence=0.7,
    )
    p2 = WorkflowParameter(
        workflow_id=str(wf.id), parameter_key="location", parameter_type="string",
        default_value="Heredia", confidence=0.7,
    )
    db_session.add_all([p1, p2])
    await db_session.flush()

    svc = ExecutionService(db_session)
    run = await svc.create_run(workflow_id=str(wf.id))
    run.status = "completed"  # so success_count gets bumped
    await db_session.flush()

    learn = LearningService(db_session)
    await learn.record_run_outcome(run)

    await db_session.refresh(p1)
    await db_session.refresh(p2)
    assert p1.validation_count == 1
    assert p1.success_count == 1
    assert p1.last_validated_at is not None
    assert p2.validation_count == 1
    assert p2.success_count == 1


@pytest.mark.asyncio
async def test_stability_compounds_across_runs(db_session):
    """Two runs in a row: stable step should approach 1.0; healed step stays low."""
    wf = await _make_workflow(db_session)
    svc = ExecutionService(db_session)
    audit = AuditService(db_session)

    for _ in range(3):
        run = await svc.create_run(workflow_id=str(wf.id))
        run.workflow_snapshot = {"workflow": {"id": str(wf.id)}, "steps": [
            {"step_index": 0, "action_type": "click", "selector_chain": _selector_chain(0)},
            {"step_index": 1, "action_type": "click", "selector_chain": _selector_chain(1)},
        ]}
        run.total_steps = 2
        await db_session.flush()

        await audit.append(AppendEvent(
            event_type="step_executed",
            payload={"step_index": 0, "action_type": "click", "success": True},
            run_id=str(run.id),
        ))
        await audit.append(AppendEvent(
            event_type="recovery_attempt",
            payload={"step_index": 1, "confidence": 0.6},
            run_id=str(run.id),
        ))
        run.status = "completed"

        await LearningService(db_session).record_run_outcome(run)

    from sqlalchemy import select
    res = await db_session.execute(
        select(WorkflowStep).where(WorkflowStep.workflow_id == str(wf.id)).order_by(WorkflowStep.step_index)
    )
    steps = res.scalars().all()
    # After 3 successes, step 0 should be higher than after 1.
    assert steps[0].selector_stability_score is not None
    assert steps[0].selector_stability_score > 0.7
    # Step 1 healed 3 times → heal_count == 3
    assert steps[1].heal_count == 3
