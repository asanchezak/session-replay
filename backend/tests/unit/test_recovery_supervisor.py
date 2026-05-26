"""Phase 3: recovery supervisor auto-resumes stalled runs."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from core.config import settings
from core.models.event import EventLog
from core.models.workflow import Workflow
from services.execution_service import ExecutionService
from services.recovery_supervisor import (
    MAX_AUTO_RESUMES_PER_RUN,
    RecoverySupervisor,
    _reset_auto_resume_counters,
)


def _step(idx: int, action: str = "click") -> dict:
    return {
        "step_index": idx,
        "action_type": action,
        "intent": f"step {idx}",
        "selector_chain": [{"type": "css", "value": f"#s{idx}"}],
        "value": None,
        "methods": [],
    }


def _snapshot(steps: list[dict]) -> dict:
    return {"workflow": {"id": "wf-1", "name": "T", "version": 1}, "steps": steps}


@pytest.fixture
def with_ai(monkeypatch):
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)


@pytest.fixture(autouse=True)
def reset_counters():
    _reset_auto_resume_counters()
    yield
    _reset_auto_resume_counters()


@pytest.mark.asyncio
async def test_supervisor_resumes_with_navigate_plan_update(db_session, with_ai):
    """Stuck run → supervisor calls AI → AI suggests navigate → run goes
    back to running with a modified step."""
    svc = ExecutionService(db_session)
    wf = Workflow(name="Stuck WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0), _step(1)])
    run.total_steps = 2
    run.status = "waiting_for_user"
    run.pause_reason = "Element not found"
    await db_session.flush()

    supervisor = RecoverySupervisor(db_session)

    async def fake_analyze(_run, _step_idx, _err, error_context=None, last_chance=False, trigger="heal"):
        return {
            "likely_cause": "stale selector",
            "analysis": "navigate directly to the target",
            "suggested_action": "navigate",
            "suggested_value": "https://example.com/target",
            "suggested_selectors": [],
            "confidence": 0.8,
            "should_retry": False,
            "should_skip": False,
        }
    supervisor.agent._analyze_failure = AsyncMock(side_effect=fake_analyze)

    resumed = await supervisor.attempt_resume(run, forced=True)
    assert resumed is True
    await db_session.refresh(run)
    assert run.status == "running"

    # Step 0 should now be a navigate to the suggested URL
    step0 = run.workflow_snapshot["steps"][0]
    assert step0["action_type"] == "navigate"
    assert step0["value"] == "https://example.com/target"

    # run_auto_resumed event written
    result = await db_session.execute(
        select(EventLog).where(EventLog.run_id == run.id, EventLog.event_type == "run_auto_resumed")
    )
    events = result.scalars().all()
    assert len(events) == 1
    assert events[0].payload["attempt"] == 1


@pytest.mark.asyncio
async def test_supervisor_caps_auto_resumes(db_session, with_ai):
    """After MAX_AUTO_RESUMES_PER_RUN unforced attempts, no more auto-resume."""
    svc = ExecutionService(db_session)
    wf = Workflow(name="Cap WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0)])
    run.total_steps = 1
    run.status = "waiting_for_user"
    await db_session.flush()

    supervisor = RecoverySupervisor(db_session)

    async def fake_analyze(*_args, **_kwargs):
        return {
            "suggested_action": "navigate",
            "suggested_value": "https://example.com",
            "suggested_selectors": [],
            "confidence": 0.8,
            "should_skip": False,
        }
    supervisor.agent._analyze_failure = AsyncMock(side_effect=fake_analyze)

    # Repeatedly call up to the cap
    for _ in range(MAX_AUTO_RESUMES_PER_RUN):
        # Mark run as waiting again so each attempt is valid
        run.status = "waiting_for_user"
        await db_session.flush()
        ok = await supervisor.attempt_resume(run, forced=False)
        assert ok is True

    # The (cap + 1)th attempt should refuse
    run.status = "waiting_for_user"
    await db_session.flush()
    refused = await supervisor.attempt_resume(run, forced=False)
    assert refused is False


@pytest.mark.asyncio
async def test_supervisor_skip_when_ai_recommends_skip(db_session, with_ai):
    """If the AI says should_skip=True, supervisor REMOVEs the step."""
    svc = ExecutionService(db_session)
    wf = Workflow(name="Skip WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0, "click"), _step(1, "click")])
    run.total_steps = 2
    run.status = "waiting_for_user"
    await db_session.flush()

    supervisor = RecoverySupervisor(db_session)

    async def fake_analyze(*_args, **_kwargs):
        return {
            "suggested_selectors": [],
            "confidence": 0.7,
            "should_skip": True,
        }
    supervisor.agent._analyze_failure = AsyncMock(side_effect=fake_analyze)

    resumed = await supervisor.attempt_resume(run, forced=True)
    assert resumed is True
    await db_session.refresh(run)
    assert len(run.workflow_snapshot["steps"]) == 1


@pytest.mark.asyncio
async def test_supervisor_returns_false_when_ai_has_no_advice(db_session, with_ai):
    svc = ExecutionService(db_session)
    wf = Workflow(name="No Advice WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0)])
    run.total_steps = 1
    run.status = "waiting_for_user"
    await db_session.flush()

    supervisor = RecoverySupervisor(db_session)

    async def fake_analyze(*_args, **_kwargs):
        return {
            "suggested_selectors": [],
            "suggested_action": None,
            "suggested_value": None,
            "confidence": 0.0,
            "should_skip": False,
        }
    supervisor.agent._analyze_failure = AsyncMock(side_effect=fake_analyze)

    resumed = await supervisor.attempt_resume(run, forced=True)
    assert resumed is False
    await db_session.refresh(run)
    assert run.status == "waiting_for_user"


@pytest.mark.asyncio
async def test_supervisor_completes_running_run_with_empty_snapshot(db_session):
    """A run with no remaining steps must not stay running forever."""
    svc = ExecutionService(db_session)
    wf = Workflow(name="Empty Ghost WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([])
    run.total_steps = 0
    run.status = "running"
    await db_session.flush()

    supervisor = RecoverySupervisor(db_session)
    resumed = await supervisor.attempt_resume(run, forced=False)

    assert resumed is True
    await db_session.refresh(run)
    assert run.status == "completed"
    assert run.total_steps == 0

    result = await db_session.execute(
        select(EventLog).where(
            EventLog.run_id == run.id,
            EventLog.event_type == "run_auto_completed",
        )
    )
    assert result.scalar_one_or_none() is not None


@pytest.mark.asyncio
async def test_supervisor_defers_stale_recovery_check_during_grace_period(db_session):
    """A fresh run_auto_resumed must not immediately pause the run — anti-bot
    cadence can legitimately produce ~140s of quiet between events, so the
    supervisor gives the extension POST_RECOVERY_GRACE_SECONDS to act."""
    svc = ExecutionService(db_session)
    wf = Workflow(name="Fresh Recovery WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0), _step(1)])
    run.total_steps = 2
    run.status = "running"
    await db_session.flush()

    from services.audit import AppendEvent, AuditService

    await AuditService(db_session).append(AppendEvent(
        event_type="run_auto_resumed",
        payload={"step_index": 0, "attempt": 1},
        run_id=str(run.id),
    ))

    supervisor = RecoverySupervisor(db_session)
    supervisor.agent._analyze_failure = AsyncMock()

    resumed = await supervisor.attempt_resume(run, forced=False)

    assert resumed is False
    await db_session.refresh(run)
    # Within the grace period: run is still running, NOT paused.
    assert run.status == "running"
    assert run.pause_reason is None
    supervisor.agent._analyze_failure.assert_not_awaited()


@pytest.mark.asyncio
async def test_supervisor_pauses_running_run_after_stale_auto_resume(db_session):
    """After POST_RECOVERY_GRACE_SECONDS elapse with no extension follow-up
    activity, the supervisor pauses the run to waiting_for_user so it doesn't
    keep mutating steps on every supervisor tick."""
    from datetime import UTC, datetime, timedelta

    svc = ExecutionService(db_session)
    wf = Workflow(name="Stale Recovery WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0), _step(1)])
    run.total_steps = 2
    run.status = "running"
    await db_session.flush()

    from services.audit import AppendEvent, AuditService

    await AuditService(db_session).append(AppendEvent(
        event_type="run_auto_resumed",
        payload={"step_index": 0, "attempt": 1},
        run_id=str(run.id),
    ))

    # Backdate the event so it falls outside the grace window.
    result = await db_session.execute(
        select(EventLog)
        .where(EventLog.run_id == run.id, EventLog.event_type == "run_auto_resumed")
    )
    ev = result.scalar_one()
    ev.created_at = datetime.now(UTC) - timedelta(seconds=400)
    await db_session.flush()

    supervisor = RecoverySupervisor(db_session)
    supervisor.agent._analyze_failure = AsyncMock()

    resumed = await supervisor.attempt_resume(run, forced=False)

    assert resumed is False
    await db_session.refresh(run)
    assert run.status == "waiting_for_user"
    assert "extension did not report progress" in (run.pause_reason or "")
    assert len(run.workflow_snapshot["steps"]) == 2
    supervisor.agent._analyze_failure.assert_not_awaited()


@pytest.mark.asyncio
async def test_supervisor_does_not_auto_resume_terminal_run(db_session, with_ai):
    svc = ExecutionService(db_session)
    wf = Workflow(name="Terminal Supervisor Guard", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0)])
    run.total_steps = 1
    run.status = "completed"
    await db_session.flush()

    supervisor = RecoverySupervisor(db_session)
    supervisor.agent._analyze_failure = AsyncMock(return_value={"should_skip": True})

    resumed = await supervisor.attempt_resume(run, forced=True)
    assert resumed is False

    result = await db_session.execute(
        select(EventLog)
        .where(EventLog.run_id == run.id)
        .where(EventLog.event_type == "run_auto_resumed")
    )
    assert result.scalar_one_or_none() is None
    supervisor.agent._analyze_failure.assert_not_awaited()
