import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import NotFoundError, StateTransitionError
from core.models.workflow import Workflow
from core.state_machine import RunStatus
from services.execution_service import ExecutionService


@pytest.mark.asyncio
async def test_create_run(db_session: AsyncSession):
    svc = ExecutionService(db_session)

    workflow = Workflow(name="Test WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    assert run.status == "queued"
    assert run.total_steps == 0
    assert run.current_step_index == 0


@pytest.mark.asyncio
async def test_get_run_not_found(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    with pytest.raises(NotFoundError):
        await svc.get_run("nonexistent")


@pytest.mark.asyncio
async def test_transition_valid(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Test WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    updated = await svc.transition(str(run.id), RunStatus.RUNNING)
    assert updated.status == "running"


@pytest.mark.asyncio
async def test_transition_illegal(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Test WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    await svc.transition(str(run.id), RunStatus.RUNNING)
    await svc.transition(str(run.id), RunStatus.COMPLETED)
    with pytest.raises(StateTransitionError):
        await svc.transition(str(run.id), RunStatus.RUNNING)


@pytest.mark.asyncio
async def test_pause_resume(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Test WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    await svc.transition(str(run.id), RunStatus.RUNNING)
    paused = await svc.pause(str(run.id), reason="CAPTCHA detected")
    assert paused.status == "waiting_for_user"
    assert paused.pause_reason == "CAPTCHA detected"

    resumed = await svc.resume(str(run.id))
    assert resumed.status == "running"


@pytest.mark.asyncio
async def test_advance_step_requires_running(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Test WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    with pytest.raises(StateTransitionError):
        await svc.advance_step(str(run.id))


@pytest.mark.asyncio
async def test_fail_run(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Test WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    await svc.transition(str(run.id), RunStatus.RUNNING)
    failed = await svc.fail(str(run.id), error="Element not found")
    assert failed.status == "failed"
    assert failed.error_summary == "Element not found"


@pytest.mark.asyncio
async def test_complete_run(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Test WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    await svc.transition(str(run.id), RunStatus.RUNNING)
    completed = await svc.complete(str(run.id))
    assert completed.status == "completed"
    assert completed.ended_at is not None


@pytest.mark.asyncio
async def test_cancel_run(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Test WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    canceled = await svc.cancel(str(run.id))
    assert canceled.status == "canceled"


@pytest.mark.asyncio
async def test_list_runs(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Test WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    await svc.create_run(workflow_id=wf_id)
    await svc.create_run(workflow_id=wf_id)

    runs = await svc.list_runs(workflow_id=wf_id)
    assert len(runs) == 2

    runs_all = await svc.list_runs()
    assert len(runs_all) >= 2


@pytest.mark.asyncio
async def test_audit_log_from_status_differs_from_to_status(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Test WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    await svc.transition(str(run.id), RunStatus.RUNNING)
    await svc.pause(str(run.id), reason="CAPTCHA")

    from sqlalchemy import select

    from core.models.event import EventLog
    result = await db_session.execute(
        select(EventLog)
        .where(EventLog.run_id == run.id)
        .order_by(EventLog.created_at)
    )
    events = result.scalars().all()

    state_events = [
        e for e in events
        if e.event_type.startswith("run_") and e.event_type != "run_started"
    ]
    for event in state_events:
        from_status = event.payload.get("from_status")
        to_status = event.payload.get("to_status")
        assert from_status is not None, f"from_status missing in {event.event_type}"
        assert to_status is not None, f"to_status missing in {event.event_type}"
        assert from_status != to_status, (
            f"from_status ({from_status}) should differ from to_status ({to_status}) "
            f"for event {event.event_type}"
        )
