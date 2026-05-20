"""Phase 4: per-decision telemetry records + resolves outcomes correctly."""
from __future__ import annotations

import pytest
from sqlalchemy import select

from core.models.ai_decision_outcome import AIDecisionOutcome
from core.models.workflow import Workflow
from services.agent_models import PageContext, PollRequest, ResultRequest
from services.agent_service import AgentService
from services.ai_outcome_service import AIOutcomeService
from services.execution_service import ExecutionService


def _step(idx: int) -> dict:
    return {"step_index": idx, "action_type": "click", "intent": f"s{idx}",
            "selector_chain": [{"type": "css", "value": f"#x{idx}"}],
            "value": None, "methods": []}


def _snapshot(steps: list[dict]) -> dict:
    return {"workflow": {"id": "wf-1", "name": "T"}, "steps": steps}


@pytest.mark.asyncio
async def test_record_decision_writes_row(db_session):
    svc = AIOutcomeService(db_session)
    row = await svc.record_decision(
        run_id="00000000-0000-0000-0000-000000000001",
        step_index=0,
        decision="EXECUTE",
        confidence=0.99,
        reasoning="fast path",
        model="fast-path",
        prompt=None,
    )
    assert row is not None
    res = await db_session.execute(select(AIDecisionOutcome))
    rows = res.scalars().all()
    assert len(rows) == 1
    assert rows[0].decision == "EXECUTE"
    assert rows[0].confidence == 0.99
    assert rows[0].thinking_steps is None


@pytest.mark.asyncio
async def test_record_decision_stores_thinking_steps(db_session):
    svc = AIOutcomeService(db_session)
    steps = [
        {"step": 1, "question": "Is selector present?", "observation": "Not found", "conclusion": "Stale"},
    ]
    row = await svc.record_decision(
        run_id="00000000-0000-0000-0000-000000000003",
        step_index=0,
        decision="ADAPT",
        confidence=0.8,
        thinking_steps=steps,
    )
    assert row is not None
    assert row.thinking_steps == steps


@pytest.mark.asyncio
async def test_record_reasoning_chain_fail_open(db_session):
    """A DB error inside record_reasoning_chain must not raise to the caller."""
    from core.models.ai_reasoning_chain import AIReasoningChain
    svc = AIOutcomeService(db_session)
    # Pass an invalid run_id length to trigger a constraint; the method must swallow it
    result = await svc.record_reasoning_chain(
        run_id="r",
        step_index=0,
        decision="EXECUTE",
        thinking_steps=[],
    )
    # Returns None on failure — no exception propagated
    assert result is None or isinstance(result, AIReasoningChain)


@pytest.mark.asyncio
async def test_resolve_latest_marks_outcome(db_session):
    svc = AIOutcomeService(db_session)
    run_id = "00000000-0000-0000-0000-000000000002"
    await svc.record_decision(run_id=run_id, step_index=0, decision="EXECUTE", confidence=0.9)
    await svc.resolve_latest(run_id, 0, "success")
    res = await db_session.execute(select(AIDecisionOutcome))
    rows = res.scalars().all()
    assert rows[0].actual_outcome == "success"
    assert rows[0].resolved_at is not None


@pytest.mark.asyncio
async def test_record_decision_failure_preserves_session_objects(db_session):
    """A failed telemetry write must not expire pre-existing session objects.

    Before the savepoint fix, record_decision() called session.rollback() on
    failure, expiring every identity-map object — including the `run` loaded
    by AgentService.poll(). Any subsequent access to run.status then raised
    MissingGreenlet in an async session. The savepoint approach rolls back
    only the telemetry write; the outer transaction and its objects are
    untouched.
    """
    from unittest.mock import patch
    from core.models.workflow import Workflow
    from services.execution_service import ExecutionService

    wf = Workflow(name="Savepoint Guard", status="draft")
    db_session.add(wf)
    await db_session.flush()

    run = await ExecutionService(db_session).create_run(workflow_id=str(wf.id))
    await db_session.flush()

    svc = AIOutcomeService(db_session)

    # Simulate a flush failure inside the savepoint (e.g. missing column).
    # patch.object targets only the session instance, not the class.
    with patch.object(db_session, "flush", side_effect=Exception("simulated DB error")):
        result = await svc.record_decision(
            run_id=str(run.id),
            step_index=0,
            decision="EXECUTE",
            confidence=0.99,
        )

    assert result is None  # error was swallowed

    # Critical invariant: run.status must be readable without raising.
    # MissingGreenlet would be raised here under the old full-rollback approach
    # because session.rollback() expired `run` and the async session can't
    # lazy-reload scalar attributes without a greenlet.
    assert run.status is not None


@pytest.mark.asyncio
async def test_agent_service_records_and_resolves(db_session):
    """End-to-end: poll() writes a decision row; report_result() resolves it."""
    es = ExecutionService(db_session)
    wf = Workflow(name="Telemetry WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    run = await es.create_run(workflow_id=str(wf.id))
    run.workflow_snapshot = _snapshot([_step(0), _step(1)])
    run.total_steps = 2
    await db_session.flush()
    run_id = str(run.id)

    agent = AgentService(db_session)
    await agent.poll(run_id, PollRequest(
        page_context=PageContext(url="https://x", title="X"),
        current_step_index=0,
    ))
    await agent.report_result(run_id, ResultRequest(step_index=0, success=True))

    res = await db_session.execute(
        select(AIDecisionOutcome)
        .where(AIDecisionOutcome.run_id == run_id)
        .order_by(AIDecisionOutcome.created_at.asc())
    )
    rows = res.scalars().all()
    # We expect at least two decisions audited (poll + report_result success)
    assert len(rows) >= 2
    # The first row should be the executable decision for step 0; resolve_latest
    # marks the most recent unresolved (which may also be the success
    # auto-audit). Either way, success outcomes should appear.
    outcomes = {r.actual_outcome for r in rows}
    assert "success" in outcomes


@pytest.mark.asyncio
async def test_load_run_memory_shape(db_session):
    svc = AIOutcomeService(db_session)
    run_id = "00000000-0000-0000-0000-0000000000aa"
    await svc.record_decision(
        run_id=run_id,
        step_index=2,
        decision="WAIT",
        confidence=0.4,
        reasoning="Waiting for results to render",
    )
    memory = await svc.load_run_memory(run_id)
    assert "decisions" in memory
    assert isinstance(memory["decisions"], list)
    assert memory["decisions"][0]["decision"] == "WAIT"
