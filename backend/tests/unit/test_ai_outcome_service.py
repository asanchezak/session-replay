"""Phase 4: per-decision telemetry records + resolves outcomes correctly."""
from __future__ import annotations

import pytest
from sqlalchemy import select

from core.models.ai_decision_outcome import AIDecisionOutcome
from core.models.workflow import Workflow
from services.agent_models import DecisionType, PageContext, PollRequest, ResultRequest
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
