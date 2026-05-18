from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.workflow import Workflow
from services.agent_models import (
    SAFETY_LIMITS,
    DecisionType,
    PageContext,
    PollRequest,
    ResultRequest,
)
from services.agent_service import AgentService
from services.execution_service import ExecutionService
from core.config import settings


@pytest.fixture
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

    assert response.decision == DecisionType.EXECUTE
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
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)
    response = await agent.poll(
        run_id,
        PollRequest(page_context=_make_context(), current_step_index=1),
    )

    assert response.decision == DecisionType.COMPLETED


@pytest.mark.asyncio
async def test_poll_pauses_on_blocking_challenge(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Blocked WF", status="draft")
    db_session.add(workflow)
    await db_session.flush()
    wf_id = str(workflow.id)

    run = await svc.create_run(workflow_id=wf_id)
    run.workflow_snapshot = _make_run_snapshot([_make_step(0, "click")])
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

    assert response.decision == DecisionType.PAUSE
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
    assert response.decision == DecisionType.WAIT
    assert response.wait_ms == 1800
    assert run.status == "running"


@pytest.mark.asyncio
async def test_consecutive_waits_escalate_to_pause(
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
    assert response.decision == DecisionType.PAUSE


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
    assert response.decision == DecisionType.RESTART
    assert response.next_step_index == 0
    assert run.current_step_index == 0
    assert run.workflow_snapshot["steps"][0]["intent"] == "Step 0"


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
    assert response.decision == DecisionType.ROLLBACK
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

    assert response.decision == DecisionType.EXECUTE
    assert response.command.action.value == "type"
    assert response.command.value == "hello"


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
    assert final.decision in (DecisionType.ADAPT, DecisionType.SKIP)


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
