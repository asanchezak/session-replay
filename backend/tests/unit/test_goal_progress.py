"""Phase 6: goal_progress seeded from analysis and advanced with the cursor."""
from __future__ import annotations

import pytest

from core.models.workflow import Workflow
from services.execution_service import (
    ExecutionService,
    _advance_goal_progress,
    _seed_goal_progress,
)


def test_seed_goal_progress_with_phases():
    analysis = {
        "workflow_goal": "Find a job",
        "phases": [
            {"name": "open", "goal": "open platform", "start_step": 0, "end_step": 1},
            {"name": "search", "goal": "search query", "start_step": 2, "end_step": 4},
        ],
    }
    steps = [
        {"step_index": 0, "intent": "navigate"},
        {"step_index": 1, "intent": "click login"},
        {"step_index": 2, "intent": "click search"},
        {"step_index": 3, "intent": "type query"},
        {"step_index": 4, "intent": "submit"},
    ]
    gp = _seed_goal_progress(analysis, steps)
    assert gp["workflow_goal"] == "Find a job"
    assert len(gp["phases"]) == 2
    assert gp["phases"][0]["status"] == "active"
    assert gp["phases"][1]["status"] == "pending"
    assert len(gp["intents"]) == 5
    assert all(it["status"] == "pending" for it in gp["intents"])


def test_seed_goal_progress_without_analysis():
    steps = [{"step_index": 0, "intent": "click"}]
    gp = _seed_goal_progress(None, steps)
    assert gp["phases"] == []
    assert len(gp["intents"]) == 1
    assert gp["workflow_goal"] is None


def test_advance_goal_progress_marks_phases_done():
    progress = {
        "workflow_goal": "G",
        "phases": [
            {"name": "open", "start_step": 0, "end_step": 1, "status": "active"},
            {"name": "search", "start_step": 2, "end_step": 4, "status": "pending"},
        ],
        "intents": [
            {"step_index": 0, "intent": "i0", "status": "active"},
            {"step_index": 1, "intent": "i1", "status": "pending"},
            {"step_index": 2, "intent": "i2", "status": "pending"},
        ],
    }
    # Advance to step 2 → phase 'open' should be done, phase 'search' active
    updated = _advance_goal_progress(progress, 2)
    assert updated["phases"][0]["status"] == "done"
    assert updated["phases"][1]["status"] == "active"
    assert updated["intents"][0]["status"] == "satisfied"
    assert updated["intents"][1]["status"] == "satisfied"
    assert updated["intents"][2]["status"] == "active"


@pytest.mark.asyncio
async def test_run_is_created_with_goal_progress(db_session):
    """End-to-end: create_run seeds goal_progress; advance_step updates it."""
    wf = Workflow(name="Goal WF", status="draft")
    db_session.add(wf)
    await db_session.flush()
    # Add 3 steps via WorkflowService
    from services.workflow_service import WorkflowService
    ws = WorkflowService(db_session)
    for i in range(3):
        await ws.add_step(
            workflow_id=str(wf.id),
            step_index=i,
            action_type="click",
            intent=f"intent {i}",
            selector_chain=[{"type": "css", "value": f"#x{i}"}],
        )

    svc = ExecutionService(db_session)
    run = await svc.create_run(workflow_id=str(wf.id))
    assert run.goal_progress is not None
    assert len(run.goal_progress["intents"]) == 3
    assert run.goal_progress["intents"][0]["status"] == "pending"
