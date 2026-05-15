"""Phase 1: AI can issue PlanUpdate ops (INSERT/REMOVE/MODIFY/REORDER)."""
from __future__ import annotations

import pytest
from sqlalchemy import select

from core.models.event import EventLog
from core.models.workflow import Workflow
from services.execution_service import ExecutionService
from services.healing_service import HealingService


def _step(idx: int, action: str = "click", intent: str | None = None) -> dict:
    return {
        "step_index": idx,
        "action_type": action,
        "intent": intent or f"step {idx}",
        "selector_chain": [{"type": "css", "value": f"#s{idx}"}],
        "value": None,
        "methods": [],
    }


def _snapshot(steps: list[dict]) -> dict:
    return {
        "workflow": {"id": "wf-1", "name": "T", "version": 1},
        "steps": steps,
    }


@pytest.mark.asyncio
async def test_apply_plan_update_modify(db_session):
    svc = ExecutionService(db_session)
    wf = Workflow(name="Modify WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0), _step(1)])
    run.total_steps = 2
    await db_session.flush()

    healer = HealingService(db_session)
    await healer.apply_plan_update(run, [{
        "operation": "MODIFY", "step_index": 0,
        "new_step": {"selector_chain": [{"type": "text", "value": "Hello"}]},
        "reason": "use stable text",
    }])

    assert run.workflow_snapshot["steps"][0]["selector_chain"] == [
        {"type": "text", "value": "Hello"},
    ]
    # MODIFY does not change step count
    assert run.total_steps == 2


@pytest.mark.asyncio
async def test_apply_plan_update_insert_pushes_right(db_session):
    svc = ExecutionService(db_session)
    wf = Workflow(name="Insert WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0, intent="recorded 0"), _step(1, intent="recorded 1")])
    run.total_steps = 2
    await db_session.flush()

    healer = HealingService(db_session)
    await healer.apply_plan_update(run, [{
        "operation": "INSERT", "step_index": 0,
        "new_step": {
            "action_type": "click",
            "selector_chain": [{"type": "text", "value": "Accept cookies"}],
            "value": "Accept cookies",
            "intent": "dismiss cookie banner",
        },
        "reason": "cookie banner blocking interaction",
    }])

    steps = run.workflow_snapshot["steps"]
    assert len(steps) == 3
    assert run.total_steps == 3
    assert steps[0]["intent"] == "dismiss cookie banner"
    assert steps[1]["intent"] == "recorded 0"
    assert steps[2]["intent"] == "recorded 1"
    # step_index fields are renumbered
    assert [s["step_index"] for s in steps] == [0, 1, 2]


@pytest.mark.asyncio
async def test_apply_plan_update_remove(db_session):
    svc = ExecutionService(db_session)
    wf = Workflow(name="Remove WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([
        _step(0, intent="keep"), _step(1, intent="drop"), _step(2, intent="keep"),
    ])
    run.total_steps = 3
    await db_session.flush()

    healer = HealingService(db_session)
    await healer.apply_plan_update(run, [{
        "operation": "REMOVE", "step_index": 1,
        "reason": "no longer needed",
    }])

    steps = run.workflow_snapshot["steps"]
    assert len(steps) == 2
    assert run.total_steps == 2
    assert [s["intent"] for s in steps] == ["keep", "keep"]
    assert [s["step_index"] for s in steps] == [0, 1]


@pytest.mark.asyncio
async def test_apply_plan_update_reorder(db_session):
    svc = ExecutionService(db_session)
    wf = Workflow(name="Reorder WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0, intent="A"), _step(1, intent="B"), _step(2, intent="C")])
    run.total_steps = 3
    await db_session.flush()

    healer = HealingService(db_session)
    await healer.apply_plan_update(run, [{
        "operation": "REORDER", "step_index": 0,
        "new_step": {"swap_with": 2},
        "reason": "page requires C before A",
    }])

    steps = run.workflow_snapshot["steps"]
    assert [s["intent"] for s in steps] == ["C", "B", "A"]


@pytest.mark.asyncio
async def test_apply_plan_update_writes_audit_event(db_session):
    svc = ExecutionService(db_session)
    wf = Workflow(name="Audit WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0), _step(1)])
    run.total_steps = 2
    await db_session.flush()

    healer = HealingService(db_session)
    await healer.apply_plan_update(run, [{
        "operation": "REMOVE", "step_index": 0, "reason": "obsolete",
    }])

    result = await db_session.execute(
        select(EventLog).where(EventLog.run_id == run.id, EventLog.event_type == "plan_update")
    )
    events = result.scalars().all()
    assert len(events) == 1
    payload = events[0].payload
    assert payload["new_step_count"] == 1
    assert payload["ops"][0]["operation"] == "REMOVE"


@pytest.mark.asyncio
async def test_apply_plan_update_ignores_unknown_ops(db_session):
    svc = ExecutionService(db_session)
    wf = Workflow(name="Unknown Op WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0)])
    run.total_steps = 1
    await db_session.flush()

    healer = HealingService(db_session)
    await healer.apply_plan_update(run, [{
        "operation": "TELEPORT", "step_index": 0, "reason": "nonsense",
    }])
    # Unchanged
    assert len(run.workflow_snapshot["steps"]) == 1
    # No audit event written since nothing was applied
    result = await db_session.execute(
        select(EventLog).where(EventLog.run_id == run.id, EventLog.event_type == "plan_update")
    )
    assert len(result.scalars().all()) == 0
