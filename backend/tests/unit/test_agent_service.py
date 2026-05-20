from __future__ import annotations

import types
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.workflow import Workflow
from services.agent_models import (
    SAFETY_LIMITS,
    PageContext,
    PollRequest,
    ResultRequest,
)
from services.agent_service import (
    AgentService,
    _run_adapt_count,
    _run_active_step,
    _run_restart_count,
    _run_step_recovery_started_at,
)
from services.execution_service import ExecutionService
from core.config import settings


@pytest.fixture(autouse=True)
def no_ai(monkeypatch):
    monkeypatch.setattr(settings, "ai_api_key", "", raising=False)


def _make_run_snapshot(steps: list[dict]) -> dict:
    return {
        "workflow": {"id": "wf-1", "name": "Test WF", "version": 1, "target_url": "https://example.com"},
        "steps": steps,
    }


def _make_step(index: int, action_type: str = "click", **extra) -> dict:
    return {
        "step_index": index,
        "action_type": action_type,
        "intent": extra.get("intent", f"Step {index}"),
        "selector_chain": extra.get("selector_chain", [{"type": "css", "value": f"#step-{index}"}]),
        "value": extra.get("value"),
        "methods": extra.get("methods", []),
    }


def _make_context(url: str = "https://example.com", title: str = "Test Page") -> PageContext:
    return PageContext(url=url, title=title)


@pytest.mark.asyncio
async def test_poll_returns_execute_for_first_step(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Agent Test WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([
        _make_step(0, "navigate", value="https://example.com"),
        _make_step(1, "click", intent="Click login"),
        _make_step(2, "type", value="user@example.com"),
    ])
    run.total_steps = 3
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)
    response = await agent.poll(
        run_id,
        PollRequest(page_context=_make_context(), current_step_index=0),
    )

    assert response.decision == "EXECUTE"
    assert response.confidence == 0.99
    assert response.command is not None
    assert response.command.action.value == "navigate"
    assert response.command.value == "https://example.com"
    assert response.next_step_index == 0


@pytest.mark.asyncio
async def test_poll_returns_completed_after_all_steps(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Done WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([
        _make_step(0, "click"),
    ])
    run.total_steps = 1
    run.current_step_index = 1
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)
    response = await agent.poll(
        run_id,
        PollRequest(page_context=_make_context(), current_step_index=1),
    )

    assert response.decision == "COMPLETED"


@pytest.mark.asyncio
async def test_poll_pauses_on_blocking_challenge(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Blocked WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "scroll")])
    run.total_steps = 1
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)
    response = await agent.poll(
        run_id,
        PollRequest(
            page_context=PageContext(
                url="https://example.com",
                title="Blocked",
                is_blocking=True,
                blocking_type="captcha",
            ),
            current_step_index=0,
        ),
    )

    assert response.decision == "PAUSE"
    assert response.requires_human is True
    assert "captcha" in (response.pause_reason or "").lower()


@pytest.mark.asyncio
async def test_result_success_advances_step(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Advance WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([
        _make_step(0, "click"),
        _make_step(1, "click"),
    ])
    run.total_steps = 2
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)
    result = await agent.report_result(
        run_id,
        ResultRequest(step_index=0, success=True),
    )

    assert result.accepted is True
    assert result.next_step_index == 1
    assert result.decision is None


@pytest.mark.asyncio
async def test_result_success_resets_recovery_window_state(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Recovery Reset WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click"), _make_step(1, "click")])
    run.total_steps = 2
    run.status = "running"
    await db_session.flush()
    run_id = str(run.id)

    _run_active_step[run_id] = 0
    _run_step_recovery_started_at[(run_id, 0)] = datetime.now(UTC) - timedelta(seconds=10)

    agent = AgentService(db_session)
    result = await agent.report_result(
        run_id,
        ResultRequest(step_index=0, success=True),
    )

    assert result.accepted is True
    assert run_id not in _run_active_step
    assert all(key[0] != run_id for key in _run_step_recovery_started_at)


@pytest.mark.asyncio
async def test_result_success_with_via_method_index_audit(db_session: AsyncSession):
    from sqlalchemy import select
    from core.models.event import EventLog

    svc = ExecutionService(db_session)
    workflow = Workflow(name="Via Method WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "scroll")])
    run.total_steps = 1
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)
    result = await agent.report_result(
        run_id,
        ResultRequest(step_index=0, success=True, via_method_index=1),
    )
    assert result.accepted is True

    events = (
        await db_session.execute(
            select(EventLog)
            .where(EventLog.run_id == run.id)
            .where(EventLog.event_type == "step_executed")
        )
    ).scalars().all()
    assert any(ev.payload.get("via_method_index") == 1 for ev in events)


@pytest.mark.asyncio
async def test_result_success_omits_via_method_index_when_not_provided(db_session: AsyncSession):
    from sqlalchemy import select
    from core.models.event import EventLog

    svc = ExecutionService(db_session)
    workflow = Workflow(name="No Via Method WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "scroll")])
    run.total_steps = 1
    await db_session.flush()

    agent = AgentService(db_session)
    await agent.report_result(
        str(run.id),
        ResultRequest(step_index=0, success=True),
    )
    events = (
        await db_session.execute(
            select(EventLog)
            .where(EventLog.run_id == run.id)
            .where(EventLog.event_type == "step_executed")
        )
    ).scalars().all()
    for ev in events:
        assert "via_method_index" not in ev.payload


@pytest.mark.asyncio
async def test_result_success_from_recovering_transitions_then_advances(
    db_session: AsyncSession,
):
    """An adapted/healed command can report success while the run is recovering."""
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Recover Advance WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([
        _make_step(0, "click"),
        _make_step(1, "click"),
    ])
    run.total_steps = 2
    run.status = "recovering"
    run.pause_reason = "old pause"
    run.error_summary = "old error"
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)
    result = await agent.report_result(
        run_id,
        ResultRequest(step_index=0, success=True),
    )

    assert result.accepted is True
    assert result.next_step_index == 1
    await db_session.refresh(run)
    assert run.status == "running"
    assert run.current_step_index == 1
    assert run.pause_reason is None
    assert run.error_summary is None


@pytest.mark.asyncio
async def test_result_failure_requests_repoll(db_session: AsyncSession, no_ai):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="FailLoop WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click")])
    run.total_steps = 1
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)

    result = await agent.report_result(
        run_id,
        ResultRequest(step_index=0, success=False, error="Not found"),
    )
    assert result.accepted is True
    assert result.should_poll is True
    assert result.decision is None


@pytest.mark.asyncio
async def test_result_success_after_failure_advances_cleanly(db_session: AsyncSession, no_ai):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Reset WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([
        _make_step(0, "click"),
        _make_step(1, "type"),
    ])
    run.total_steps = 2
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)

    await agent.report_result(run_id, ResultRequest(step_index=0, success=False, error="Fail 1"))
    await agent.report_result(run_id, ResultRequest(step_index=0, success=True))

    result = await agent.report_result(
        run_id, ResultRequest(step_index=1, success=False, error="New step fail"),
    )
    assert result.should_poll is True
    assert result.decision is None


@pytest.mark.asyncio
async def test_agent_poll_transitions_run_to_running(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Transition WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click")])
    run.total_steps = 1
    await db_session.flush()
    run_id = str(run.id)
    assert run.status == "queued"

    agent = AgentService(db_session)
    await agent.poll(run_id, PollRequest(page_context=_make_context(), current_step_index=0))

    await db_session.refresh(run)
    assert run.status == "running"


@pytest.mark.asyncio
async def test_agent_decision_audited(db_session: AsyncSession):
    from sqlalchemy import select

    from core.models.event import EventLog

    svc = ExecutionService(db_session)
    workflow = Workflow(name="Audit WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click")])
    run.total_steps = 1
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)
    await agent.poll(run_id, PollRequest(page_context=_make_context(), current_step_index=0))

    result = await db_session.execute(
        select(EventLog).where(EventLog.run_id == run.id, EventLog.event_type == "agent_decision")
    )
    decisions = result.scalars().all()
    assert len(decisions) >= 1
    assert decisions[0].payload["decision"] == "EXECUTE"
    assert decisions[0].actor_type == "ai"


@pytest.mark.asyncio
async def test_poll_returns_wait_keeps_run_running(
    db_session: AsyncSession,
    monkeypatch,
):
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)

    svc = ExecutionService(db_session)
    workflow = Workflow(name="Wait WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click")])
    run.total_steps = 1
    run.status = "running"
    await db_session.flush()

    agent = AgentService(db_session)

    async def fake_consult(*_args, **_kwargs):
        return {
            "decision": "WAIT",
            "confidence": 0.55,
            "reasoning": "Results page still loading",
            "wait_ms": 1800,
            "thinking_steps": [],
            "decision_context": {"attempt": 1, "strategy": "primary"},
        }

    monkeypatch.setattr(agent, "_consult_ai_for_step", fake_consult)

    response = await agent.poll(
        str(run.id),
        PollRequest(page_context=_make_context(), current_step_index=0),
    )

    await db_session.refresh(run)
    assert response.decision == "WAIT"
    assert response.wait_ms == 1800
    assert run.status == "running"


@pytest.mark.asyncio
async def test_consecutive_waits_escalate_to_autonomous_recovery(
    db_session: AsyncSession,
    monkeypatch,
):
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)

    svc = ExecutionService(db_session)
    workflow = Workflow(name="Wait Budget WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click")])
    run.total_steps = 1
    run.status = "running"
    await db_session.flush()

    agent = AgentService(db_session)

    async def fake_consult(*_args, **_kwargs):
        return {
            "decision": "WAIT",
            "confidence": 0.55,
            "reasoning": "Still loading",
            "wait_ms": 1500,
            "thinking_steps": [],
            "decision_context": {"attempt": 1, "strategy": "primary"},
        }

    monkeypatch.setattr(agent, "_consult_ai_for_step", fake_consult)

    response = None
    for _ in range(SAFETY_LIMITS["max_consecutive_waits_per_step"] + 1):
        response = await agent.poll(
            str(run.id),
            PollRequest(page_context=_make_context(), current_step_index=0),
        )
    assert response is not None
    assert response.decision == "WAIT"
    assert response.requires_human is False


@pytest.mark.asyncio
async def test_ai_unusable_output_stays_autonomous_not_waiting_for_user(
    db_session: AsyncSession,
    monkeypatch,
):
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)

    svc = ExecutionService(db_session)
    workflow = Workflow(name="AI Unusable WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "scroll")])
    run.total_steps = 1
    run.status = "running"
    await db_session.flush()

    agent = AgentService(db_session)
    monkeypatch.setattr(agent, "_consult_ai_for_step", AsyncMock(return_value=None))

    resp = await agent.poll(
        str(run.id),
        PollRequest(page_context=_make_context(url="https://example.com/unstable"), current_step_index=0),
    )
    await db_session.refresh(run)

    assert resp.decision == "WAIT"
    assert resp.requires_human is False
    assert run.status == "running"


@pytest.mark.asyncio
async def test_recovery_window_timeout_fails_run_with_no_human_pause(
    db_session: AsyncSession,
    monkeypatch,
):
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "ai_step_recovery_window_seconds", 30, raising=False)

    svc = ExecutionService(db_session)
    workflow = Workflow(name="Timeout WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click")])
    run.total_steps = 1
    run.status = "running"
    await db_session.flush()
    run_id = str(run.id)

    _run_active_step[run_id] = 0
    _run_step_recovery_started_at[(run_id, 0)] = datetime.now(UTC) - timedelta(seconds=90)

    agent = AgentService(db_session)
    monkeypatch.setattr(agent, "_consult_ai_for_step", AsyncMock(return_value=None))

    resp = await agent.poll(
        run_id,
        PollRequest(page_context=_make_context(url="https://example.com/stuck"), current_step_index=0),
    )
    await db_session.refresh(run)

    assert resp.decision == "PAUSE"
    assert resp.requires_human is False
    assert run.status == "failed"
    assert "window expired" in (run.error_summary or "").lower()

@pytest.mark.asyncio
async def test_poll_restart_restores_original_snapshot(
    db_session: AsyncSession,
    monkeypatch,
):
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)

    svc = ExecutionService(db_session)
    workflow = Workflow(name="Restart WF", status="draft", target_url="https://example.com")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = {
        **_make_run_snapshot([_make_step(0, "click"), _make_step(1, "type", value="x")]),
        "original_steps": [_make_step(0, "click"), _make_step(1, "type", value="x")],
    }
    run.workflow_snapshot["steps"][0]["intent"] = "mutated step"
    run.current_step_index = 1
    run.total_steps = 2
    run.status = "running"
    await db_session.flush()

    agent = AgentService(db_session)

    async def fake_consult(*_args, **_kwargs):
        return {
            "decision": "RESTART",
            "confidence": 0.8,
            "reasoning": "Start over from target url",
            "thinking_steps": [],
            "decision_context": {"attempt": 1, "strategy": "primary"},
        }

    monkeypatch.setattr(agent, "_consult_ai_for_step", fake_consult)

    response = await agent.poll(
        str(run.id),
        PollRequest(page_context=_make_context(), current_step_index=1),
    )

    await db_session.refresh(run)
    assert response.decision == "RESTART"
    assert response.next_step_index == 0
    assert run.current_step_index == 0
    assert run.workflow_snapshot["steps"][0]["intent"] == "Step 0"


@pytest.mark.asyncio
async def test_handle_restart_uses_recorded_navigate_not_metadata_target(
    db_session: AsyncSession,
):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Restart URL WF", status="draft", target_url="https://www.google.com")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = {
        "workflow": {"id": str(workflow.id), "target_url": "https://www.google.com"},
        "steps": [
            _make_step(0, "navigate", value="https://www.speedtest.net/es"),
            _make_step(1, "click", intent="Click Iniciar"),
        ],
    }
    run.current_step_index = 1
    run.total_steps = 2
    run.status = "running"
    await db_session.flush()

    run_id = str(run.id)
    _run_restart_count.pop(run_id, None)
    agent = AgentService(db_session)
    response = await agent._handle_restart_decision(
        run,
        1,
        {
            "confidence": 0.8,
            "reasoning": "Restart flow",
            "command": {"action": "navigate", "value": "https://www.google.com/"},
        },
        _make_context(url="https://accounts.google.com"),
    )

    await db_session.refresh(run)
    assert response.decision == "RESTART"
    assert response.command is not None
    assert response.command.value == "https://www.speedtest.net/es"
    assert run.current_step_index == 0


@pytest.mark.asyncio
async def test_handle_restart_falls_back_to_ai_command_when_no_navigate_steps(
    db_session: AsyncSession,
):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Restart URL Fallback WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = {
        "workflow": {"id": str(workflow.id), "target_url": None},
        "steps": [_make_step(0, "click", intent="Click submit")],
    }
    run.current_step_index = 0
    run.total_steps = 1
    run.status = "running"
    await db_session.flush()

    run_id = str(run.id)
    _run_restart_count.pop(run_id, None)
    agent = AgentService(db_session)
    response = await agent._handle_restart_decision(
        run,
        0,
        {
            "confidence": 0.8,
            "reasoning": "Restart flow",
            "command": {"action": "navigate", "value": "https://example.org/restart"},
        },
        _make_context(url="https://broken.example"),
    )

    assert response.decision == "RESTART"
    assert response.command is not None
    assert response.command.value == "https://example.org/restart"


@pytest.mark.asyncio
async def test_poll_rollback_to_checkpoint(
    db_session: AsyncSession,
    monkeypatch,
):
    from services.audit import AppendEvent, AuditService

    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)

    svc = ExecutionService(db_session)
    workflow = Workflow(name="Rollback WF", status="draft", target_url="https://example.com")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([
        {**_make_step(0, "click"), "checkpoint": True},
        _make_step(1, "type", value="x"),
        _make_step(2, "click"),
    ])
    run.current_step_index = 2
    run.total_steps = 3
    run.status = "running"
    await db_session.flush()

    audit = AuditService(db_session)
    await audit.append(AppendEvent(
        event_type="checkpoint",
        payload={"step_index": 0, "page_url": "https://example.com/checkpoint"},
        run_id=str(run.id),
    ))

    agent = AgentService(db_session)

    async def fake_consult(*_args, **_kwargs):
        return {
            "decision": "ROLLBACK",
            "confidence": 0.78,
            "reasoning": "Return to known-good checkpoint",
            "rollback_to": 0,
            "thinking_steps": [],
            "decision_context": {"attempt": 1, "strategy": "primary"},
        }

    monkeypatch.setattr(agent, "_consult_ai_for_step", fake_consult)

    response = await agent.poll(
        str(run.id),
        PollRequest(page_context=_make_context(), current_step_index=2),
    )

    await db_session.refresh(run)
    assert response.decision == "ROLLBACK"
    assert response.next_step_index == 0
    assert response.command is not None
    assert response.command.value == "https://example.com/checkpoint"
    assert run.current_step_index == 0


@pytest.mark.asyncio
async def test_agent_not_found(db_session: AsyncSession):
    agent = AgentService(db_session)
    from core.exceptions import NotFoundError
    with pytest.raises(NotFoundError):
        await agent.poll(str(uuid.uuid4()), PollRequest(page_context=_make_context()))


@pytest.mark.asyncio
async def test_push_action_stores_pending(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Action WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)
    resp = await agent.push_action(run_id, "continue")
    assert resp["accepted"] is True
    assert resp["pending_action"] == "continue"


@pytest.mark.asyncio
async def test_poll_with_current_step_index_parameter(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Index WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([
        _make_step(0, "click"),
        _make_step(1, "type", value="hello"),
    ])
    run.total_steps = 2
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)
    response = await agent.poll(
        run_id,
        PollRequest(page_context=_make_context(), current_step_index=1),
    )

    assert response.decision == "EXECUTE"
    assert response.command.action.value == "type"
    assert response.command.value == "hello"


@pytest.mark.asyncio
async def test_poll_ignores_stale_client_cursor_for_completion(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Cursor Drift WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([
        _make_step(0, "click"),
        _make_step(1, "type", value="hello"),
    ])
    run.total_steps = 2
    run.current_step_index = 0
    await db_session.flush()

    agent = AgentService(db_session)
    response = await agent.poll(
        str(run.id),
        PollRequest(page_context=_make_context(), current_step_index=999),
    )

    assert response.decision == "EXECUTE"
    assert response.next_step_index == 0


@pytest.mark.asyncio
async def test_report_result_rejects_step_index_mismatch(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Result Guard WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([
        _make_step(0, "click"),
        _make_step(1, "type", value="hello"),
    ])
    run.total_steps = 2
    run.current_step_index = 0
    run.status = "running"
    await db_session.flush()

    agent = AgentService(db_session)
    result = await agent.report_result(
        str(run.id),
        ResultRequest(step_index=1, success=True),
    )
    await db_session.refresh(run)

    assert result.accepted is False
    assert result.next_step_index == 0
    assert run.current_step_index == 0


def test_selectors_look_fragile_detects_session_ids():
    """Recorded css ids that look session-generated (Google's `#_IvMFav...`,
    hash-suffixed ids) should be treated as fragile so the agent consults AI
    proactively instead of clicking blindly."""
    assert AgentService._selectors_look_fragile([]) is True

    google_chain = [
        {"type": "css", "value": "#_IvMFavSHKoOzqtsP4p6usQs_40", "score": 0.8},
        {"type": "text", "value": "Buscar empleo en Indeed Costa Rica", "score": 0.7},
        {"type": "xpath", "value": "/html/body/div[3]/div", "score": 0.2},
    ]
    # Text score 0.7 saves it — stable anchor available
    assert AgentService._selectors_look_fragile(google_chain) is False

    only_session = [
        {"type": "css", "value": "#_IvMFavSHKoOzqtsP4p6usQs_40", "score": 0.8},
        {"type": "xpath", "value": "/html/body/div[3]/div", "score": 0.2},
    ]
    # No stable anchor — fragile
    assert AgentService._selectors_look_fragile(only_session) is True

    stable = [
        {"type": "css", "value": "button.submit", "score": 0.9},
        {"type": "accessibility", "value": '["button","Submit"]', "score": 0.85},
    ]
    assert AgentService._selectors_look_fragile(stable) is False


@pytest.mark.asyncio
async def test_last_chance_recovery_adapts_instead_of_pausing(
    db_session: AsyncSession, monkeypatch,
):
    """When retries+heals exhaust, the AI gets a last-chance shot. If it
    suggests selectors, the run ADAPTs rather than pausing for a human."""
    from unittest.mock import AsyncMock

    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)

    svc = ExecutionService(db_session)
    workflow = Workflow(name="Last Chance WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click")])
    run.total_steps = 1
    run.status = "running"
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)

    # Stub the AI: return nothing-actionable on normal calls, return a real
    # adaptation only when last_chance=True.
    async def fake_analyze(_run, _step_idx, _err, _ctx=None, last_chance=False):
        if last_chance:
            return {
                "likely_cause": "selector stale",
                "analysis": "use the visible button instead",
                "suggested_action": None,
                "suggested_value": None,
                "suggested_selectors": [
                    {"type": "text", "value": "Submit", "score": 0.9},
                ],
                "confidence": 0.85,
                "should_retry": False,
                "should_skip": False,
            }
        return {
            "likely_cause": "unclear",
            "analysis": "no idea",
            "suggested_action": None,
            "suggested_value": None,
            "suggested_selectors": [],
            "confidence": 0.0,
            "should_retry": False,
            "should_skip": False,
        }

    agent._analyze_failure = AsyncMock(side_effect=fake_analyze)

    final = await agent._last_chance_recovery(
        run,
        0,
        "final",
        None,
        0,
    )

    assert agent._analyze_failure.await_count >= 1
    last_call = agent._analyze_failure.await_args_list[-1]
    assert last_call.kwargs.get("last_chance") is True
    assert final.decision in ("ADAPT", "SKIP")


@pytest.mark.asyncio
async def test_load_previous_failures_reads_from_event_log(db_session: AsyncSession):
    """The planner must see previous failures so it doesn't repeat them."""
    from services.audit import AppendEvent, AuditService

    svc = ExecutionService(db_session)
    workflow = Workflow(name="Failure Log WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click"), _make_step(1, "click")])
    run.total_steps = 2
    await db_session.flush()

    audit = AuditService(db_session)
    await audit.append(AppendEvent(
        event_type="step_executed",
        payload={"step_index": 1, "action_type": "click", "success": False, "error": "Element not found"},
        run_id=str(run.id),
    ))
    await audit.append(AppendEvent(
        event_type="recovery_failure",
        payload={"step_index": 1, "error": "Low confidence heal"},
        run_id=str(run.id),
    ))

    agent = AgentService(db_session)
    failures = await agent._load_previous_failures(run, current_step_index=1)
    assert failures is not None
    assert len(failures) == 2
    errors = [f["error"] for f in failures]
    assert "Element not found" in errors
    assert "Low confidence heal" in errors


@pytest.mark.asyncio
async def test_analyze_failure_and_classify_blockage_branches(db_session: AsyncSession, monkeypatch):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="AI Failure Branches", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click", value="v")])
    run.total_steps = 1
    await db_session.flush()

    agent = AgentService(db_session)
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(
        agent,
        "_load_previous_failures",
        AsyncMock(return_value=[{"step_index": 0, "action": "click", "error": "old"}]),
    )

    class _Provider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(
                content='{"likely_cause":"stale","analysis":"use text","suggested_action":"navigate","suggested_value":"https://x","suggested_selectors":[{"type":"text","value":"Go","score":0.9}],"confidence":0.8,"should_retry":false,"should_skip":false,"thinking_steps":[{"question":"q","observation":"o","conclusion":"c"}]}'
            )

    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_kwargs: _Provider())
    ok = await agent._analyze_failure(
        run,
        step_index=0,
        error="not found",
        error_context="DOM",
        last_chance=True,
    )
    assert ok is not None
    assert ok["suggested_action"] == "navigate"

    class _BadJsonProvider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(content="not-json")

    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_kwargs: _BadJsonProvider())
    bad_json = await agent._analyze_failure(run, 0, "oops", None)
    assert bad_json is not None
    assert bad_json["confidence"] == 0.0

    class _CrashProvider:
        async def generate(self, *_args, **_kwargs):
            raise RuntimeError("down")

    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_kwargs: _CrashProvider())
    crashed = await agent._analyze_failure(run, 0, "oops", None)
    assert crashed is None

    monkeypatch.setattr(settings, "ai_api_key", "", raising=False)
    assert await agent._analyze_failure(run, 0, "oops", None) is None
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    assert await agent._analyze_failure(run, 9, "oops", None) is None

    ctx_empty = types.SimpleNamespace(visible_text="", dom_snippet="")
    assert await agent._classify_blockage(run, ctx_empty) is None

    class _ClassifyProvider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(content='{"classification":"captcha","confidence":0.9,"reason":"challenge","suggested_action":"pause"}')

    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_kwargs: _ClassifyProvider())
    classified = await agent._classify_blockage(
        run, types.SimpleNamespace(visible_text="verify human", dom_snippet="<iframe></iframe>")
    )
    assert classified is not None
    assert classified["classification"] == "captcha"

    class _ClassifyBadJsonProvider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(content="oops")

    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_kwargs: _ClassifyBadJsonProvider())
    assert await agent._classify_blockage(run, types.SimpleNamespace(visible_text="x", dom_snippet="y")) is None

    class _ClassifyCrashProvider:
        async def generate(self, *_args, **_kwargs):
            raise RuntimeError("fail")

    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_kwargs: _ClassifyCrashProvider())
    assert await agent._classify_blockage(run, types.SimpleNamespace(visible_text="x", dom_snippet="y")) is None


@pytest.mark.asyncio
async def test_agent_plan_update_phase_and_parse_helpers(db_session: AsyncSession, monkeypatch):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Plan Update Helpers", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click"), _make_step(1, "click")])
    run.total_steps = 2
    await db_session.flush()

    agent = AgentService(db_session)
    applied: list[dict] = []

    async def _apply(_run, ops):
        applied.extend(ops)

    monkeypatch.setattr(agent.healing, "apply_plan_update", _apply)
    out = await agent._apply_plan_updates_from_ai(
        run,
        [
            {"operation": "MODIFY", "step_index": 0, "new_step": {"selector_chain": [{"type": "css", "value": "#x"}]}},
            {"operation": "INVALID", "step_index": 0},
            "bad-op",
        ],
    )
    assert len(out) == 1
    assert applied[0]["operation"] == "MODIFY"

    assert agent._get_current_phase({"phases": []}, 0) is None
    assert agent._get_current_phase({"phases": [{"start_step": 0, "end_step": 1, "name": "A"}]}, 0) == "A"
    assert agent._get_current_phase({"phases": [{"start_step": 2, "end_step": 3, "name": "B"}]}, 0) is None

    cmd = agent._parse_adapted_command({"action": "click", "selector_chain": ["#x", {"type": "text", "value": "Go"}], "value": "v"})
    assert cmd is not None
    assert cmd.selector_chain[0]["value"] == "#x"
    assert agent._parse_adapted_command({}) is None


@pytest.mark.asyncio
async def test_last_chance_recovery_and_report_result_terminal_branches(db_session: AsyncSession, monkeypatch):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Terminal Branches", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click"), _make_step(1, "click")])
    run.workflow_snapshot["analysis"] = {"goal_predicate": {"type": "extract_count", "min": 1}}
    run.total_steps = 2
    run.status = "recovering"
    run.extracted_data = [{"row": 1}]
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)

    monkeypatch.setattr(settings, "ai_api_key", "", raising=False)
    assert await agent._last_chance_recovery(run, 0, "err", None, 0) is None

    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(agent, "_analyze_failure", AsyncMock(return_value=None))
    assert await agent._last_chance_recovery(run, 0, "err", None, 0) is None

    monkeypatch.setattr(
        agent,
        "_analyze_failure",
        AsyncMock(
            return_value={"should_skip": True, "confidence": 0.9, "analysis": "skip"}
        ),
    )
    skip = await agent._last_chance_recovery(run, 0, "err", None, 0)
    assert skip is not None
    assert skip.decision == "SKIP"

    monkeypatch.setattr(
        agent,
        "_analyze_failure",
        AsyncMock(
            return_value={
                "should_skip": False,
                "confidence": 0.8,
                "analysis": "adapt",
                "suggested_action": "navigate",
                "suggested_value": "https://x",
                "suggested_selectors": [],
            }
        ),
    )
    adapt = await agent._last_chance_recovery(run, 0, "err", None, 1)
    assert adapt is not None
    assert adapt.decision == "ADAPT"

    monkeypatch.setattr(
        agent,
        "_analyze_failure",
        AsyncMock(return_value={"should_skip": False, "suggested_selectors": []}),
    )
    assert await agent._last_chance_recovery(run, 0, "err", None, 1) is None

    async def _boom_transition(*_args, **_kwargs):
        raise RuntimeError("no transition")

    monkeypatch.setattr(agent, "_transition_to_running", _boom_transition)

    async def _boom_resolve(*_args, **_kwargs):
        raise RuntimeError("resolve fail")

    monkeypatch.setattr(agent.ai_outcomes, "resolve_latest", _boom_resolve)
    async def _force_advance(_run_id):
        target = await agent.execution.get_run(_run_id)
        target.current_step_index += 1
        await db_session.flush()
        return target

    monkeypatch.setattr(agent.execution, "advance_step", _force_advance)
    result_completed = await agent.report_result(
        run_id,
        ResultRequest(step_index=run.current_step_index, success=True),
    )
    assert result_completed.decision == "COMPLETED"

    run2 = await svc.create_run(workflow_id=str(workflow.id))
    run2.workflow_snapshot = _make_run_snapshot([_make_step(0, "click")])
    run2.total_steps = 1
    run2.status = "running"
    await db_session.flush()
    result_terminal = await agent.report_result(str(run2.id), ResultRequest(step_index=0, success=True))
    assert result_terminal.decision == "COMPLETED"

    fail_result = await agent.report_result(
        run_id,
        ResultRequest(
            step_index=run.current_step_index,
            success=False,
            error="boom",
            page_context_after=PageContext(
                url="https://x",
                title="X",
                visible_elements=[],
                visible_text="",
            ),
        ),
    )
    assert fail_result.should_poll is True


@pytest.mark.asyncio
async def test_poll_ai_adapt_skip_and_nonblocking_pause_recovery(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "deterministic_only", False, raising=False)
    svc = ExecutionService(db_session)
    workflow = Workflow(name="AI Branch WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click"), _make_step(1, "click")])
    run.total_steps = 2
    run.status = "waiting_for_user"
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)

    async def _adapt(*_args, **_kwargs):
        return {
            "decision": "ADAPT",
            "confidence": 0.8,
            "reasoning": "adapt it",
            "command": {"action": "click", "selector_chain": ["#new"], "value": "v", "intent": "x", "methods": []},
            "thinking_steps": [],
            "decision_context": {},
        }

    monkeypatch.setattr(agent, "_consult_ai_for_step", _adapt)
    adapt = await agent.poll(run_id, PollRequest(page_context=_make_context(), current_step_index=0))
    assert adapt.decision == "ADAPT"
    assert _run_adapt_count[run_id] >= 1

    run.status = "running"
    run.current_step_index = 0
    await db_session.flush()

    async def _skip(*_args, **_kwargs):
        return {
            "decision": "SKIP",
            "confidence": 0.7,
            "reasoning": "skip this",
            "thinking_steps": [],
            "decision_context": {},
        }

    monkeypatch.setattr(agent, "_consult_ai_for_step", _skip)
    skip = await agent.poll(run_id, PollRequest(page_context=_make_context(), current_step_index=0))
    assert skip.decision == "SKIP"
    await db_session.refresh(run)
    assert run.current_step_index == 1

    async def _pause(*_args, **_kwargs):
        return {
            "decision": "PAUSE",
            "confidence": 0.6,
            "reasoning": "manual needed",
            "pause_reason": "manual needed",
            "thinking_steps": [],
            "decision_context": {},
        }

    monkeypatch.setattr(agent, "_consult_ai_for_step", _pause)
    pause = await agent.poll(run_id, PollRequest(page_context=_make_context(), current_step_index=1))
    assert pause.decision == "WAIT"
    assert pause.requires_human is False


@pytest.mark.asyncio
async def test_agent_transition_waiting_branch_and_get_decisions(db_session: AsyncSession):
    from services.audit import AppendEvent, AuditService

    svc = ExecutionService(db_session)
    workflow = Workflow(name="Transition Waiting WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click")])
    run.total_steps = 1
    run.status = "waiting_for_user"
    await db_session.flush()

    agent = AgentService(db_session)
    await agent._transition_to_running(run)
    await db_session.refresh(run)
    assert run.status == "running"

    await AuditService(db_session).append(
        AppendEvent(event_type="agent_decision", payload={"decision": "EXECUTE"}, run_id=str(run.id))
    )
    decisions = await agent.get_decisions(str(run.id), limit=10)
    assert len(decisions) >= 1

    assert agent._normalize_ai_decision({"decision": "ADAPT"}) is not None
    assert agent._normalize_ai_decision({"decision": "UNKNOWN"}) is None
    assert agent._normalize_ai_decision("bad") is None


@pytest.mark.asyncio
async def test_agent_remaining_branch_coverage(db_session: AsyncSession, monkeypatch):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Branch Sweep WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click", selector_chain=[{"type": "css", "value": "#x"}])])
    run.total_steps = 1
    await db_session.flush()
    run_id = str(run.id)
    agent = AgentService(db_session)

    monkeypatch.setattr(agent, "_classify_blockage", AsyncMock(return_value={"reason": "detected"}))
    blocking = await agent.poll(
        run_id,
        PollRequest(
            page_context=PageContext(url="u", title="t", is_blocking=True, blocking_type="captcha"),
            current_step_index=0,
        ),
    )
    assert blocking.decision == "PAUSE"

    run.status = "queued"
    await db_session.flush()
    async def _boom_transition(*_args, **_kwargs):
        raise RuntimeError("no transition")
    monkeypatch.setattr(agent, "_transition_to_running", _boom_transition)
    monkeypatch.setattr(settings, "ai_api_key", "", raising=False)
    fast = await agent.poll(run_id, PollRequest(page_context=_make_context(), current_step_index=0))
    assert fast.decision == "EXECUTE"

    assert AgentService._selectors_look_fragile([{"type": "css", "value": "[data-testid='x']", "score": 0.8}, "bad"]) is False
    assert AgentService._extract_thinking_steps({"thinking_steps": "bad"}) == []
    assert AgentService._extract_thinking_steps({"thinking_steps": [{"question": "q"}]})[0]["question"] == "q"
    assert AgentService._is_transitional_page(types.SimpleNamespace(page_diff={"url_changed": True}, visible_elements=[], visible_text="")) is True

    wait_fallback = await agent._fallback_after_ai_failure(
        run,
        0,
        {},
        types.SimpleNamespace(page_diff={"added": [1]}, visible_elements=[], visible_text=""),
    )
    assert wait_fallback is not None and wait_fallback.decision == "WAIT"

    execute_fallback = await agent._fallback_after_ai_failure(
        run,
        0,
        {"action_type": "navigate", "value": "https://www.speedtest.net/es", "selector_chain": []},
        types.SimpleNamespace(page_diff={}, visible_elements=[{"selector": "x"}], visible_text="ready"),
    )
    assert execute_fallback is not None and execute_fallback.decision == "EXECUTE"
    assert execute_fallback.command is not None
    assert execute_fallback.command.value == "https://www.speedtest.net/es"

    _run_restart_count[run_id] = 99
    restart = await agent._handle_restart_decision(run, 0, {}, _make_context())
    assert restart.decision == "WAIT"

    rollback = await agent._handle_rollback_decision(run, 1, {"rollback_to": "x"}, _make_context())
    assert rollback.decision == "WAIT"
    rollback2 = await agent._handle_rollback_decision(run, 1, {"rollback_to": 5}, _make_context())
    assert rollback2.decision == "WAIT"
    rollback3 = await agent._handle_rollback_decision(run, 1, {"rollback_to": 0}, _make_context())
    assert rollback3.decision == "WAIT"

    from services.audit import AppendEvent, AuditService
    await AuditService(db_session).append(AppendEvent(event_type="checkpoint", payload={"step_index": 0, "success": False}, run_id=run_id))
    assert await agent._resolve_checkpoint_url(run, 0) == "https://example.com"

    orig_execute = db_session.execute
    async def _bad_execute(*_args, **_kwargs):
        raise RuntimeError("db down")
    monkeypatch.setattr(db_session, "execute", _bad_execute)
    assert await agent._load_previous_failures(run, 0) is None
    assert await agent._load_workflow_expertise("wf", run_id) is None
    monkeypatch.setattr(db_session, "execute", orig_execute)

    monkeypatch.setattr(settings, "ai_api_key", "", raising=False)
    assert await agent._consult_ai_for_step(run, 0, run.workflow_snapshot["steps"][0], agent._build_command(run.workflow_snapshot["steps"][0]), {}, _make_context()) is None
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "deterministic_only", False, raising=False)
    bad_ctx = types.SimpleNamespace(url="u", title="t", visible_text="", visible_elements=[{"x": 1}] * 30, page_diff=None, page_context_error=None, actual_url=None)

    class _BadProvider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(content='{"decision":"UNKNOWN"}')

    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_kwargs: _BadProvider())
    monkeypatch.setattr(agent.ai_outcomes, "load_run_memory", AsyncMock(return_value={}))
    monkeypatch.setattr(agent, "_load_previous_failures", AsyncMock(return_value=[]))
    monkeypatch.setattr(agent, "_load_workflow_expertise", AsyncMock(return_value=None))
    assert await agent._consult_ai_for_step(run, 0, run.workflow_snapshot["steps"][0], agent._build_command(run.workflow_snapshot["steps"][0]), {}, bad_ctx) is None

    monkeypatch.setattr(agent, "_apply_plan_updates_from_ai", AsyncMock(return_value=[]))
    assert await agent._apply_plan_updates_from_ai(run, [{"operation": "INVALID"}]) == []
    assert agent._parse_adapted_command({"action": "click", "selector_chain": 7}) is None

    run.status = "paused"
    await db_session.flush()
    monkeypatch.setattr(agent, "_transition_to_running", _boom_transition)
    monkeypatch.setattr(agent.ai_outcomes, "resolve_latest", AsyncMock(return_value=None))
    await agent.report_result(run_id, ResultRequest(step_index=0, success=False, error="e"))

    monkeypatch.setattr(agent.ai_outcomes, "record_decision", AsyncMock(side_effect=RuntimeError("nope")))
    await agent._audit_decision(run_id, "EXECUTE", 0.9, "x")
