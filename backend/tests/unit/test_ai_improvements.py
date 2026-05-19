"""Stress tests for the 5 AI intelligence improvements.

1. Goal-predicate early termination in poll()
2. Selector stability annotations in build_agent_decision_prompt()
3. Cross-run workflow expertise injection (_load_workflow_expertise)
4. Self-healing plan_update persistence after COMPLETED runs
5. Blueprint health analysis API: GET /v1/workflows/{id}/analyze
"""
from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ai.prompts import build_agent_decision_prompt
from core.models.event import EventLog
from core.models.run import ExecutionRun
from core.models.workflow import Workflow, WorkflowStep
from core.config import settings
from services.agent_models import DecisionType, PageContext, PollRequest
from services.agent_service import AgentService
from services.audit import AppendEvent, AuditService
from services.execution_service import ExecutionService

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def no_ai(monkeypatch):
    monkeypatch.setattr(settings, "ai_api_key", "", raising=False)


def _make_step(index: int, action_type: str = "click", **extra) -> dict:
    return {
        "step_index": index,
        "action_type": action_type,
        "intent": extra.get("intent", f"Step {index}"),
        "selector_chain": extra.get(
            "selector_chain",
            [{"type": "css", "value": f"#step-{index}", "score": 0.5}],
        ),
        "value": extra.get("value"),
        "methods": extra.get("methods", []),
        "selector_stability_score": extra.get("selector_stability_score"),
    }


def _make_snapshot(steps: list[dict], goal_predicate: dict | None = None, workflow_id: str | None = None) -> dict:
    snapshot: dict = {
        "workflow": {
            "id": workflow_id or "wf-test",
            "name": "Test WF",
            "version": 1,
            "target_url": "https://example.com",
        },
        "steps": steps,
    }
    if goal_predicate is not None:
        snapshot["analysis"] = {"goal_predicate": goal_predicate}
    return snapshot


def _make_context(
    url: str = "https://example.com",
    title: str = "Test",
    visible_text: str = "",
    visible_elements: list[dict] | None = None,
) -> PageContext:
    return PageContext(
        url=url,
        title=title,
        visible_text=visible_text,
        visible_elements=visible_elements or [],
    )


async def _create_workflow(db: AsyncSession, name: str = "Test WF") -> Workflow:
    wf = Workflow(name=name, status="active")
    db.add(wf)
    await db.flush()
    return wf


async def _create_step(
    db: AsyncSession,
    workflow_id: str,
    step_index: int,
    action_type: str = "click",
    value: str | None = None,
    stability_score: float | None = None,
) -> WorkflowStep:
    ws = WorkflowStep(
        workflow_id=workflow_id,
        step_index=step_index,
        action_type=action_type,
        intent=f"Step {step_index}",
        selector_chain=[{"type": "css", "value": f"#s{step_index}", "score": 0.5}],
        value=value,
        selector_stability_score=stability_score,
    )
    db.add(ws)
    await db.flush()
    return ws


async def _create_run(
    db: AsyncSession,
    workflow_id: str,
    status: str = "running",
    snapshot: dict | None = None,
    n_steps: int = 2,
    extracted_data: list | None = None,
) -> ExecutionRun:
    svc = ExecutionService(db)
    run = await svc.create_run(workflow_id=workflow_id)
    run.workflow_snapshot = snapshot or _make_snapshot(
        [_make_step(i) for i in range(n_steps)],
        workflow_id=workflow_id,
    )
    run.total_steps = n_steps
    run.status = status
    if extracted_data is not None:
        run.extracted_data = extracted_data
    await db.flush()
    return run


async def _append_event(
    db: AsyncSession,
    run_id: str,
    event_type: str,
    payload: dict,
) -> None:
    """Append an event to the audit log for a run."""
    audit = AuditService(db)
    ev = AppendEvent(event_type=event_type, payload=payload, run_id=run_id)
    await audit.append(ev)
    await db.flush()


# ---------------------------------------------------------------------------
# Section 1 — Goal-Predicate Early Termination
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_goal_url_matches_returns_completed(db_session: AsyncSession):
    """URL-match predicate satisfied → poll returns COMPLETED without running the step."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot(
            [_make_step(0, "click")],
            goal_predicate={"type": "url_matches", "pattern": ".*/success"},
        ),
        n_steps=1,
    )
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(
            page_context=_make_context(url="https://example.com/success"),
            current_step_index=0,
        ),
    )
    assert resp.decision == DecisionType.COMPLETED
    assert "Goal predicate" in resp.reasoning


@pytest.mark.asyncio
async def test_goal_url_no_match_continues(db_session: AsyncSession):
    """URL-match predicate NOT satisfied → poll continues to EXECUTE."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot(
            [_make_step(0, "click")],
            goal_predicate={"type": "url_matches", "pattern": ".*/success"},
        ),
        n_steps=1,
    )
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(
            page_context=_make_context(url="https://example.com/login"),
            current_step_index=0,
        ),
    )
    assert resp.decision == DecisionType.EXECUTE


@pytest.mark.asyncio
async def test_goal_text_present_returns_completed(db_session: AsyncSession):
    """text_present predicate satisfied → COMPLETED."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot(
            [_make_step(0)],
            goal_predicate={"type": "text_present", "phrase": "Order confirmed"},
        ),
        n_steps=1,
    )
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(
            page_context=_make_context(visible_text="Thank you! Order confirmed."),
            current_step_index=0,
        ),
    )
    assert resp.decision == DecisionType.COMPLETED


@pytest.mark.asyncio
async def test_goal_text_missing_continues(db_session: AsyncSession):
    """text_present predicate NOT satisfied → EXECUTE."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot(
            [_make_step(0)],
            goal_predicate={"type": "text_present", "phrase": "Order confirmed"},
        ),
        n_steps=1,
    )
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(
            page_context=_make_context(visible_text=""),
            current_step_index=0,
        ),
    )
    assert resp.decision == DecisionType.EXECUTE


@pytest.mark.asyncio
async def test_goal_element_visible_returns_completed(db_session: AsyncSession):
    """element_visible predicate satisfied → COMPLETED."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot(
            [_make_step(0)],
            goal_predicate={"type": "element_visible", "selector": ".success-banner"},
        ),
        n_steps=1,
    )
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(
            page_context=_make_context(
                visible_elements=[{"tag": "div", "selector": ".success-banner", "text": "Done"}]
            ),
            current_step_index=0,
        ),
    )
    assert resp.decision == DecisionType.COMPLETED


@pytest.mark.asyncio
async def test_goal_element_not_found_continues(db_session: AsyncSession):
    """element_visible predicate NOT satisfied → EXECUTE."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot(
            [_make_step(0)],
            goal_predicate={"type": "element_visible", "selector": ".success-banner"},
        ),
        n_steps=1,
    )
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(
            page_context=_make_context(visible_elements=[]),
            current_step_index=0,
        ),
    )
    assert resp.decision == DecisionType.EXECUTE


@pytest.mark.asyncio
async def test_goal_extract_count_satisfied(db_session: AsyncSession):
    """extract_count with enough items → COMPLETED."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot(
            [_make_step(0)],
            goal_predicate={"type": "extract_count", "min": 3},
        ),
        n_steps=1,
        extracted_data=[{"a": 1}, {"b": 2}, {"c": 3}],
    )
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(page_context=_make_context(), current_step_index=0),
    )
    assert resp.decision == DecisionType.COMPLETED


@pytest.mark.asyncio
async def test_goal_extract_count_insufficient(db_session: AsyncSession):
    """extract_count with too few items → EXECUTE."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot(
            [_make_step(0)],
            goal_predicate={"type": "extract_count", "min": 3},
        ),
        n_steps=1,
        extracted_data=[{"a": 1}, {"b": 2}],
    )
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(page_context=_make_context(), current_step_index=0),
    )
    assert resp.decision == DecisionType.EXECUTE


@pytest.mark.asyncio
async def test_no_goal_predicate_key(db_session: AsyncSession):
    """Analysis exists but no goal_predicate key → no short-circuit."""
    wf = await _create_workflow(db_session)
    snapshot = _make_snapshot([_make_step(0)])
    snapshot["analysis"] = {"workflow_goal": "just a goal, no predicate"}
    run = await _create_run(db_session, str(wf.id), snapshot=snapshot, n_steps=1)
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(page_context=_make_context(), current_step_index=0),
    )
    assert resp.decision == DecisionType.EXECUTE


@pytest.mark.asyncio
async def test_goal_predicate_missing_type(db_session: AsyncSession):
    """Empty goal_predicate dict (no type) → no short-circuit."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], goal_predicate={}),
        n_steps=1,
    )
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(page_context=_make_context(), current_step_index=0),
    )
    assert resp.decision == DecisionType.EXECUTE


@pytest.mark.asyncio
async def test_goal_predicate_unknown_type(db_session: AsyncSession):
    """Unknown predicate type → gracefully falls through to EXECUTE."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot(
            [_make_step(0)],
            goal_predicate={"type": "magic_oracle_check", "answer": 42},
        ),
        n_steps=1,
    )
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(page_context=_make_context(), current_step_index=0),
    )
    assert resp.decision == DecisionType.EXECUTE


@pytest.mark.asyncio
async def test_no_analysis_in_snapshot(db_session: AsyncSession):
    """No analysis key in snapshot at all → no short-circuit."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)]),  # no goal_predicate
        n_steps=1,
    )
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(page_context=_make_context(), current_step_index=0),
    )
    assert resp.decision == DecisionType.EXECUTE


@pytest.mark.asyncio
async def test_goal_satisfied_at_step_0(db_session: AsyncSession):
    """Predicate matches at step 0 → COMPLETED before any step runs."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot(
            [_make_step(i) for i in range(5)],
            goal_predicate={"type": "text_present", "phrase": "done"},
        ),
        n_steps=5,
    )
    agent = AgentService(db_session)
    resp = await agent.poll(
        str(run.id),
        PollRequest(
            page_context=_make_context(visible_text="All done!"),
            current_step_index=0,
        ),
    )
    assert resp.decision == DecisionType.COMPLETED
    # Verify audit event logged with early-termination reasoning.
    events = (await db_session.execute(
        select(EventLog)
        .where(EventLog.run_id == run.id, EventLog.event_type == "agent_decision")
        .order_by(EventLog.sequence_number.desc())
        .limit(1)
    )).scalars().all()
    assert any("Goal predicate" in (e.payload or {}).get("reasoning", "") for e in events)


@pytest.mark.asyncio
async def test_goal_satisfied_mid_workflow(db_session: AsyncSession):
    """Predicate satisfied partway through → stops at that poll."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot(
            [_make_step(i) for i in range(5)],
            goal_predicate={"type": "url_matches", "pattern": ".*/final"},
        ),
        n_steps=5,
    )
    agent = AgentService(db_session)
    # Poll at step 3 with goal-matching URL.
    resp = await agent.poll(
        str(run.id),
        PollRequest(
            page_context=_make_context(url="https://example.com/final"),
            current_step_index=3,
        ),
    )
    assert resp.decision == DecisionType.COMPLETED


# ---------------------------------------------------------------------------
# Section 2 — Selector Stability in Prompt
# ---------------------------------------------------------------------------


def _build_minimal_prompt(stability_score: float | None) -> str:
    """Helper: build a prompt with just the stability-relevant args set."""
    return build_agent_decision_prompt(
        workflow_goal=None,
        current_phase=None,
        step_index=0,
        step_intent="Click submit",
        step_action="click",
        step_selectors=[{"type": "css", "value": "#submit", "score": 0.5}],
        step_value=None,
        page_url="https://example.com",
        page_title="Test",
        visible_text="Submit button",
        visible_elements=[],
        step_stability_score=stability_score,
    )


def test_stability_none_not_rendered():
    """stability_score=None → no stability line in prompt."""
    prompt = _build_minimal_prompt(None)
    assert "Historical selector stability" not in prompt


def test_stability_high_renders_stable():
    """stability_score=0.9 → STABLE label in prompt."""
    prompt = _build_minimal_prompt(0.9)
    assert "STABLE" in prompt
    assert "90%" in prompt


def test_stability_boundary_stable():
    """stability_score=0.8 exactly → STABLE (≥ 0.8 threshold)."""
    prompt = _build_minimal_prompt(0.8)
    assert "STABLE" in prompt
    assert "80%" in prompt


def test_stability_just_below_stable():
    """stability_score=0.799 → MODERATE (< 0.8 threshold)."""
    prompt = _build_minimal_prompt(0.799)
    assert "MODERATE" in prompt
    # Should round to 80%.
    assert "80%" in prompt


def test_stability_mid_moderate():
    """stability_score=0.65 → MODERATE."""
    prompt = _build_minimal_prompt(0.65)
    assert "MODERATE" in prompt
    assert "65%" in prompt


def test_stability_boundary_moderate():
    """stability_score=0.5 exactly → MODERATE (≥ 0.5 threshold)."""
    prompt = _build_minimal_prompt(0.5)
    assert "MODERATE" in prompt
    assert "50%" in prompt


def test_stability_just_below_moderate():
    """stability_score=0.499 → FRAGILE (< 0.5 threshold)."""
    prompt = _build_minimal_prompt(0.499)
    assert "FRAGILE" in prompt
    assert "50%" in prompt


def test_stability_very_low():
    """stability_score=0.1 → FRAGILE."""
    prompt = _build_minimal_prompt(0.1)
    assert "FRAGILE" in prompt
    assert "10%" in prompt


def test_stability_zero():
    """stability_score=0.0 → FRAGILE (0%)."""
    prompt = _build_minimal_prompt(0.0)
    assert "FRAGILE" in prompt
    assert "0%" in prompt


def test_stability_all_three_labels_exclusive():
    """Three stability labels are mutually exclusive."""
    stable_prompt = _build_minimal_prompt(0.9)
    assert "STABLE" in stable_prompt
    assert "MODERATE" not in stable_prompt
    assert "FRAGILE" not in stable_prompt

    moderate_prompt = _build_minimal_prompt(0.6)
    assert "MODERATE" in moderate_prompt
    assert "STABLE" not in moderate_prompt
    assert "FRAGILE" not in moderate_prompt

    fragile_prompt = _build_minimal_prompt(0.2)
    assert "FRAGILE" in fragile_prompt
    assert "STABLE" not in fragile_prompt
    assert "MODERATE" not in fragile_prompt


def test_workflow_expertise_in_prompt():
    """workflow_expertise string is injected into prompt."""
    expertise = "## Workflow Expertise (3 prior runs)\nKnown problem steps:\n  • Step 2: healed 3/3"
    prompt = build_agent_decision_prompt(
        workflow_goal=None,
        current_phase=None,
        step_index=0,
        step_intent="Click",
        step_action="click",
        step_selectors=[],
        step_value=None,
        page_url="https://example.com",
        page_title="Test",
        visible_text="",
        visible_elements=[],
        workflow_expertise=expertise,
    )
    assert "## Workflow Expertise" in prompt
    assert "Step 2" in prompt


def test_workflow_expertise_none_not_in_prompt():
    """workflow_expertise=None → no expertise section in prompt."""
    prompt = build_agent_decision_prompt(
        workflow_goal=None,
        current_phase=None,
        step_index=0,
        step_intent="Click",
        step_action="click",
        step_selectors=[],
        step_value=None,
        page_url="https://example.com",
        page_title="Test",
        visible_text="",
        visible_elements=[],
        workflow_expertise=None,
    )
    assert "## Workflow Expertise" not in prompt


def test_workflow_expertise_empty_string_not_in_prompt():
    """workflow_expertise='' (empty string, falsy) → not injected."""
    prompt = build_agent_decision_prompt(
        workflow_goal=None,
        current_phase=None,
        step_index=0,
        step_intent="Click",
        step_action="click",
        step_selectors=[],
        step_value=None,
        page_url="https://example.com",
        page_title="Test",
        visible_text="",
        visible_elements=[],
        workflow_expertise="",
    )
    assert "## Workflow Expertise" not in prompt


# ---------------------------------------------------------------------------
# Section 3 — Cross-Run Expertise Injection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_expertise_no_prior_runs(db_session: AsyncSession):
    """First run of a workflow → expertise returns None."""
    wf = await _create_workflow(db_session)
    run = await _create_run(db_session, str(wf.id))
    agent = AgentService(db_session)
    result = await agent._load_workflow_expertise(str(wf.id), str(run.id))
    assert result is None


@pytest.mark.asyncio
async def test_expertise_only_running_runs_excluded(db_session: AsyncSession):
    """Prior runs with status='running' are not included in expertise."""
    wf = await _create_workflow(db_session)
    # Create a prior "running" run (not terminal).
    prior = await _create_run(db_session, str(wf.id), status="running")
    await _append_event(db_session, str(prior.id), "step_executed", {"step_index": 0, "success": True})
    # Current run.
    current = await _create_run(db_session, str(wf.id), status="running")
    agent = AgentService(db_session)
    result = await agent._load_workflow_expertise(str(wf.id), str(current.id))
    assert result is None


@pytest.mark.asyncio
async def test_expertise_current_run_excluded(db_session: AsyncSession):
    """The current run_id is filtered out; only prior terminal runs count."""
    wf = await _create_workflow(db_session)
    run = await _create_run(db_session, str(wf.id), status="completed")
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})
    agent = AgentService(db_session)
    # Pass the only run as both current AND the only prior → should return None.
    result = await agent._load_workflow_expertise(str(wf.id), str(run.id))
    assert result is None


@pytest.mark.asyncio
async def test_expertise_single_completed_run_with_heals(db_session: AsyncSession):
    """1 prior completed run with a heal on step_0 and success on step_1."""
    wf = await _create_workflow(db_session)
    prior = await _create_run(db_session, str(wf.id), status="completed")
    await _append_event(db_session, str(prior.id), "selector_healed", {"step_index": 0})
    await _append_event(db_session, str(prior.id), "step_executed", {"step_index": 0, "success": True})
    await _append_event(db_session, str(prior.id), "step_executed", {"step_index": 1, "success": True})
    await _append_event(db_session, str(prior.id), "step_executed", {"step_index": 1, "success": True})

    current = await _create_run(db_session, str(wf.id))
    agent = AgentService(db_session)
    result = await agent._load_workflow_expertise(str(wf.id), str(current.id))

    assert result is not None
    assert "## Workflow Expertise" in result
    # Step 0 healed → should be in problem steps.
    assert "Step 0" in result
    # Step 1 succeeded twice and no heals → reliable.
    assert "1" in result  # appears in "Reliable steps"


@pytest.mark.asyncio
async def test_expertise_top5_problem_steps_only(db_session: AsyncSession):
    """When more than 5 problem steps exist, only top 5 are listed."""
    wf = await _create_workflow(db_session)
    prior = await _create_run(db_session, str(wf.id), status="completed")
    # Create 7 different problem steps.
    for idx in range(7):
        await _append_event(db_session, str(prior.id), "selector_healed", {"step_index": idx})

    current = await _create_run(db_session, str(wf.id))
    agent = AgentService(db_session)
    result = await agent._load_workflow_expertise(str(wf.id), str(current.id))

    assert result is not None
    # Count "• Step" bullet points (max 5).
    bullet_count = result.count("• Step")
    assert bullet_count <= 5


@pytest.mark.asyncio
async def test_expertise_reliable_requires_2_successes(db_session: AsyncSession):
    """Step with only 1 success is NOT listed as reliable (requires success >= 2)."""
    wf = await _create_workflow(db_session)
    prior = await _create_run(db_session, str(wf.id), status="completed")
    # Only 1 success for step_0.
    await _append_event(db_session, str(prior.id), "step_executed", {"step_index": 0, "success": True})

    current = await _create_run(db_session, str(wf.id))
    agent = AgentService(db_session)
    result = await agent._load_workflow_expertise(str(wf.id), str(current.id))

    # Either None (no stats) or the step is NOT in reliable list.
    if result:
        # Step 0 with 1 success should not be in "Reliable steps".
        lines = result.split("\n")
        reliable_lines = [l for l in lines if "Reliable" in l]
        # If there's a reliable line, step 0 should not be in it.
        for line in reliable_lines:
            assert "0" not in line or "100%" not in line


@pytest.mark.asyncio
async def test_expertise_step_with_2_successes_is_reliable(db_session: AsyncSession):
    """Step with 2+ successes and no heals is listed in Reliable steps."""
    wf = await _create_workflow(db_session)
    # Two prior completed runs, step_0 succeeded in both.
    for _ in range(2):
        prior = await _create_run(db_session, str(wf.id), status="completed")
        await _append_event(db_session, str(prior.id), "step_executed", {"step_index": 0, "success": True})

    current = await _create_run(db_session, str(wf.id))
    agent = AgentService(db_session)
    result = await agent._load_workflow_expertise(str(wf.id), str(current.id))

    assert result is not None
    assert "Reliable" in result
    assert "0" in result  # step 0 in reliable list


@pytest.mark.asyncio
async def test_expertise_mixed_terminal_statuses_all_counted(db_session: AsyncSession):
    """completed + failed + waiting_for_user all included in total_runs."""
    wf = await _create_workflow(db_session)
    for status in ["completed", "failed", "waiting_for_user"]:
        prior = await _create_run(db_session, str(wf.id), status=status)
        await _append_event(db_session, str(prior.id), "step_executed", {"step_index": 0, "success": True})

    current = await _create_run(db_session, str(wf.id))
    agent = AgentService(db_session)
    result = await agent._load_workflow_expertise(str(wf.id), str(current.id))

    assert result is not None
    # Header shows "3 prior runs".
    assert "3 prior runs" in result


@pytest.mark.asyncio
async def test_expertise_step_index_none_skipped(db_session: AsyncSession):
    """Events with step_index=None in payload are skipped without crashing."""
    wf = await _create_workflow(db_session)
    prior = await _create_run(db_session, str(wf.id), status="completed")
    # Inject event with no step_index.
    await _append_event(db_session, str(prior.id), "step_executed", {"success": True})  # no step_index
    await _append_event(db_session, str(prior.id), "step_executed", {"step_index": 1, "success": True})
    await _append_event(db_session, str(prior.id), "step_executed", {"step_index": 1, "success": True})

    current = await _create_run(db_session, str(wf.id))
    agent = AgentService(db_session)
    # Should not raise; may or may not produce expertise depending on step_1 count.
    result = await agent._load_workflow_expertise(str(wf.id), str(current.id))
    # No crash. If result exists, it shouldn't contain malformed step entries.
    if result:
        assert "## Workflow Expertise" in result


@pytest.mark.asyncio
async def test_expertise_selector_healed_events_counted_as_problems(db_session: AsyncSession):
    """selector_healed events count as heal stats for the step."""
    wf = await _create_workflow(db_session)
    prior = await _create_run(db_session, str(wf.id), status="completed")
    # Heal on step 3 specifically.
    await _append_event(db_session, str(prior.id), "selector_healed", {"step_index": 3})

    current = await _create_run(db_session, str(wf.id))
    agent = AgentService(db_session)
    result = await agent._load_workflow_expertise(str(wf.id), str(current.id))

    assert result is not None
    assert "Step 3" in result  # step 3 is a problem step


@pytest.mark.asyncio
async def test_expertise_empty_payload_events_do_not_crash(db_session: AsyncSession):
    """Events with completely empty payload dict are handled gracefully."""
    wf = await _create_workflow(db_session)
    prior = await _create_run(db_session, str(wf.id), status="completed")
    await _append_event(db_session, str(prior.id), "step_executed", {})  # empty payload

    current = await _create_run(db_session, str(wf.id))
    agent = AgentService(db_session)
    # No crash; likely returns None (no step_stats built).
    result = await agent._load_workflow_expertise(str(wf.id), str(current.id))
    assert result is None or isinstance(result, str)


# ---------------------------------------------------------------------------
# Section 4 — Self-Healing Plan Persistence
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_persist_skips_empty_workflow_id(db_session: AsyncSession):
    """No workflow.id in snapshot → method returns without touching DB."""
    wf = await _create_workflow(db_session)
    run = await _create_run(db_session, str(wf.id))
    # Remove the workflow id from snapshot.
    run.workflow_snapshot = {"steps": [_make_step(0)], "workflow": {}}
    await db_session.flush()

    agent = AgentService(db_session)
    # Should not raise.
    await agent._maybe_persist_plan_mutations(run)

    # No workflow_evolved events.
    events = (await db_session.execute(
        select(EventLog).where(EventLog.event_type == "workflow_evolved")
    )).scalars().all()
    assert len(events) == 0


@pytest.mark.asyncio
async def test_persist_low_confidence_skipped(db_session: AsyncSession):
    """Confidence < 0.85 → mutation not persisted."""
    wf = await _create_workflow(db_session)
    ws = await _create_step(db_session, str(wf.id), step_index=0)
    original_chain = ws.selector_chain
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.7,  # below threshold
        "plan_updates": [{"operation": "MODIFY", "step_index": 0, "new_step": {"selector_chain": [{"type": "text", "value": "New"}]}}],
    })
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    await db_session.refresh(ws)
    # Should be unchanged.
    assert ws.selector_chain == original_chain


@pytest.mark.asyncio
async def test_persist_add_operation_rejected(db_session: AsyncSession):
    """ADD operation (not MODIFY/SIMPLIFY) is not persisted."""
    wf = await _create_workflow(db_session)
    ws = await _create_step(db_session, str(wf.id), step_index=0)
    original_chain = ws.selector_chain
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.95,
        "plan_updates": [{"operation": "ADD", "step_index": 0, "new_step": {"selector_chain": [{"type": "text", "value": "New"}]}}],
    })
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    await db_session.refresh(ws)
    assert ws.selector_chain == original_chain


@pytest.mark.asyncio
async def test_persist_remove_operation_rejected(db_session: AsyncSession):
    """REMOVE operation is not persisted."""
    wf = await _create_workflow(db_session)
    ws = await _create_step(db_session, str(wf.id), step_index=0)
    original_chain = ws.selector_chain
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.95,
        "plan_updates": [{"operation": "REMOVE", "step_index": 0, "new_step": None}],
    })
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    await db_session.refresh(ws)
    assert ws.selector_chain == original_chain


@pytest.mark.asyncio
async def test_persist_step_not_in_successes(db_session: AsyncSession):
    """Mutation for step_2 but no success event for step_2 → not persisted."""
    wf = await _create_workflow(db_session)
    ws = await _create_step(db_session, str(wf.id), step_index=2)
    original_chain = ws.selector_chain
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(i) for i in range(3)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.95,
        "plan_updates": [{"operation": "MODIFY", "step_index": 2, "new_step": {"selector_chain": [{"type": "text", "value": "Better"}]}}],
    })
    # Only step_0 and step_1 succeeded — step_2 never ran.
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 1, "success": True})

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    await db_session.refresh(ws)
    assert ws.selector_chain == original_chain


@pytest.mark.asyncio
async def test_persist_step_idx_negative_skipped(db_session: AsyncSession):
    """step_index=-1 → skipped (guard clause: step_idx < 0)."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.95,
        "plan_updates": [{"operation": "MODIFY", "step_index": -1, "new_step": {"selector_chain": [{"type": "text", "value": "x"}]}}],
    })

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    # No workflow_evolved event.
    events = (await db_session.execute(
        select(EventLog).where(EventLog.event_type == "workflow_evolved")
    )).scalars().all()
    assert len(events) == 0


@pytest.mark.asyncio
async def test_persist_no_selector_chain_skipped(db_session: AsyncSession):
    """MODIFY mutation with new_step lacking selector_chain → skipped."""
    wf = await _create_workflow(db_session)
    ws = await _create_step(db_session, str(wf.id), step_index=0)
    original_chain = ws.selector_chain
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.95,
        "plan_updates": [{"operation": "MODIFY", "step_index": 0, "new_step": {"value": "some-url"}}],  # no selector_chain
    })
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    await db_session.refresh(ws)
    assert ws.selector_chain == original_chain


@pytest.mark.asyncio
async def test_persist_workflow_step_not_found_no_crash(db_session: AsyncSession):
    """Mutation targets step_index=5, but WorkflowStep for that index doesn't exist → no crash."""
    wf = await _create_workflow(db_session)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.95,
        "plan_updates": [{"operation": "MODIFY", "step_index": 5, "new_step": {"selector_chain": [{"type": "text", "value": "x"}]}}],
    })
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 5, "success": True})

    agent = AgentService(db_session)
    # Should not raise.
    await agent._maybe_persist_plan_mutations(run)


@pytest.mark.asyncio
async def test_persist_modify_updates_selector_chain(db_session: AsyncSession):
    """MODIFY with confidence >= 0.85 and step succeeded → selector_chain updated."""
    new_chain = [{"type": "text", "value": "Submit", "score": 0.95}]
    wf = await _create_workflow(db_session)
    ws = await _create_step(db_session, str(wf.id), step_index=0)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.9,
        "plan_updates": [{"operation": "MODIFY", "step_index": 0, "new_step": {"selector_chain": new_chain}, "reason": "CSS is fragile"}],
    })
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    await db_session.refresh(ws)
    assert ws.selector_chain == new_chain

    # workflow_evolved event should be logged.
    events = (await db_session.execute(
        select(EventLog).where(EventLog.event_type == "workflow_evolved")
    )).scalars().all()
    assert len(events) == 1
    assert events[0].payload["step_index"] == 0


@pytest.mark.asyncio
async def test_persist_simplify_updates_selector_chain(db_session: AsyncSession):
    """SIMPLIFY operation is treated same as MODIFY — persisted."""
    new_chain = [{"type": "accessibility", "value": "button/Submit", "score": 0.9}]
    wf = await _create_workflow(db_session)
    ws = await _create_step(db_session, str(wf.id), step_index=0)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.95,
        "plan_updates": [{"operation": "SIMPLIFY", "step_index": 0, "new_step": {"selector_chain": new_chain}}],
    })
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    await db_session.refresh(ws)
    assert ws.selector_chain == new_chain


@pytest.mark.asyncio
async def test_persist_value_updated_when_provided(db_session: AsyncSession):
    """new_step.value is updated when provided in MODIFY mutation."""
    wf = await _create_workflow(db_session)
    ws = await _create_step(db_session, str(wf.id), step_index=0, value="old-value")
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.9,
        "plan_updates": [{"operation": "MODIFY", "step_index": 0, "new_step": {
            "selector_chain": [{"type": "text", "value": "x"}],
            "value": "new-value",
        }}],
    })
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    await db_session.refresh(ws)
    assert ws.value == "new-value"


@pytest.mark.asyncio
async def test_persist_value_not_updated_when_absent(db_session: AsyncSession):
    """new_step has no 'value' key → WorkflowStep.value is unchanged."""
    wf = await _create_workflow(db_session)
    ws = await _create_step(db_session, str(wf.id), step_index=0, value="original-value")
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.9,
        "plan_updates": [{"operation": "MODIFY", "step_index": 0, "new_step": {"selector_chain": [{"type": "text", "value": "x"}]}}],
    })
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    await db_session.refresh(ws)
    assert ws.value == "original-value"


@pytest.mark.asyncio
async def test_persist_multiple_mutations_applied(db_session: AsyncSession):
    """2 qualifying MODIFY mutations for step_0 and step_2 → both updated."""
    wf = await _create_workflow(db_session)
    ws0 = await _create_step(db_session, str(wf.id), step_index=0)
    ws2 = await _create_step(db_session, str(wf.id), step_index=2)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(i) for i in range(3)], workflow_id=str(wf.id)),
    )

    chain_0 = [{"type": "text", "value": "Step0-new"}]
    chain_2 = [{"type": "accessibility", "value": "button/Go"}]
    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.9,
        "plan_updates": [
            {"operation": "MODIFY", "step_index": 0, "new_step": {"selector_chain": chain_0}},
            {"operation": "MODIFY", "step_index": 2, "new_step": {"selector_chain": chain_2}},
        ],
    })
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 2, "success": True})

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    await db_session.refresh(ws0)
    await db_session.refresh(ws2)
    assert ws0.selector_chain == chain_0
    assert ws2.selector_chain == chain_2

    # Two workflow_evolved events.
    events = (await db_session.execute(
        select(EventLog).where(EventLog.event_type == "workflow_evolved")
    )).scalars().all()
    assert len(events) == 2


@pytest.mark.asyncio
async def test_persist_exception_caught_silently(db_session: AsyncSession):
    """Corrupt snapshot → exception swallowed, no propagation."""
    wf = await _create_workflow(db_session)
    run = await _create_run(db_session, str(wf.id))
    # Corrupt the snapshot to something that will fail processing.
    run.workflow_snapshot = None  # triggers early return for empty workflow_id
    await db_session.flush()

    agent = AgentService(db_session)
    # Must not raise.
    await agent._maybe_persist_plan_mutations(run)


@pytest.mark.asyncio
async def test_persist_boundary_confidence_085(db_session: AsyncSession):
    """Confidence exactly 0.85 → meets threshold, mutation IS persisted."""
    new_chain = [{"type": "text", "value": "Boundary"}]
    wf = await _create_workflow(db_session)
    ws = await _create_step(db_session, str(wf.id), step_index=0)
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.85,  # exactly at threshold
        "plan_updates": [{"operation": "MODIFY", "step_index": 0, "new_step": {"selector_chain": new_chain}}],
    })
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    await db_session.refresh(ws)
    assert ws.selector_chain == new_chain


@pytest.mark.asyncio
async def test_persist_boundary_confidence_below_085(db_session: AsyncSession):
    """Confidence 0.849 → below threshold, mutation NOT persisted."""
    wf = await _create_workflow(db_session)
    ws = await _create_step(db_session, str(wf.id), step_index=0)
    original_chain = ws.selector_chain
    run = await _create_run(
        db_session, str(wf.id),
        snapshot=_make_snapshot([_make_step(0)], workflow_id=str(wf.id)),
    )

    await _append_event(db_session, str(run.id), "agent_decision", {
        "confidence": 0.849,
        "plan_updates": [{"operation": "MODIFY", "step_index": 0, "new_step": {"selector_chain": [{"type": "text", "value": "x"}]}}],
    })
    await _append_event(db_session, str(run.id), "step_executed", {"step_index": 0, "success": True})

    agent = AgentService(db_session)
    await agent._maybe_persist_plan_mutations(run)

    await db_session.refresh(ws)
    assert ws.selector_chain == original_chain


# ---------------------------------------------------------------------------
# Section 5 — Blueprint Health Analysis API
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_analyze_404_nonexistent_workflow(client: AsyncClient):
    """GET /workflows/{bogus-id}/analyze → 404."""
    resp = await client.get(
        f"/v1/workflows/{uuid.uuid4()}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    assert resp.status_code == 404
    data = resp.json()
    assert data["error"]["code"] == "NOT_FOUND"


@pytest.mark.asyncio
async def test_analyze_200_empty_workflow(client: AsyncClient, db_session: AsyncSession):
    """Workflow with 0 steps → health_score=None, est_completion=1.0."""
    wf = await _create_workflow(db_session, "Empty WF")
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_steps"] == 0
    assert data["health_score"] is None
    assert data["estimated_completion_probability"] == 1.0
    assert data["high_risk_steps"] == 0
    assert data["redundant_steps"] == 0


@pytest.mark.asyncio
async def test_analyze_returns_correct_fields(client: AsyncClient, db_session: AsyncSession):
    """All expected top-level fields are present in response."""
    wf = await _create_workflow(db_session, "Field WF")
    await _create_step(db_session, str(wf.id), 0)
    await _create_step(db_session, str(wf.id), 1)
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    assert resp.status_code == 200
    data = resp.json()
    expected_keys = {
        "workflow_id", "workflow_name", "total_steps", "health_score",
        "estimated_completion_probability", "high_risk_steps", "redundant_steps",
        "recommendations", "step_analysis",
    }
    assert expected_keys.issubset(data.keys())
    assert data["total_steps"] == 2


@pytest.mark.asyncio
async def test_analyze_no_history_is_unknown(client: AsyncClient, db_session: AsyncSession):
    """Steps with stability_score=None → risk='unknown', health_score=None."""
    wf = await _create_workflow(db_session, "No History WF")
    await _create_step(db_session, str(wf.id), 0, stability_score=None)
    await _create_step(db_session, str(wf.id), 1, stability_score=None)
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["health_score"] is None
    assert data["estimated_completion_probability"] == 1.0
    for step in data["step_analysis"]:
        assert step["risk"] == "unknown"


@pytest.mark.asyncio
async def test_analyze_stable_step_low_risk(client: AsyncClient, db_session: AsyncSession):
    """stability_score=0.9 → risk='low'; not in recommendations."""
    wf = await _create_workflow(db_session, "Stable WF")
    await _create_step(db_session, str(wf.id), 0, stability_score=0.9)
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["step_analysis"][0]["risk"] == "low"
    assert data["high_risk_steps"] == 0
    # Low-risk steps should not appear in recommendations.
    rec_indices = [r["step_index"] for r in data["recommendations"]]
    assert 0 not in rec_indices


@pytest.mark.asyncio
async def test_analyze_stable_boundary_is_low(client: AsyncClient, db_session: AsyncSession):
    """stability_score=0.8 exactly → risk='low' (≥ 0.8 threshold)."""
    wf = await _create_workflow(db_session, "Boundary Stable")
    await _create_step(db_session, str(wf.id), 0, stability_score=0.8)
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["step_analysis"][0]["risk"] == "low"


@pytest.mark.asyncio
async def test_analyze_moderate_step_in_recommendations(client: AsyncClient, db_session: AsyncSession):
    """stability_score=0.6 → risk='medium'; appears in recommendations."""
    wf = await _create_workflow(db_session, "Moderate WF")
    await _create_step(db_session, str(wf.id), 0, stability_score=0.6)
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["step_analysis"][0]["risk"] == "medium"
    assert any(r["step_index"] == 0 for r in data["recommendations"])


@pytest.mark.asyncio
async def test_analyze_moderate_lower_boundary(client: AsyncClient, db_session: AsyncSession):
    """stability_score=0.5 → risk='medium' (≥ 0.5 threshold)."""
    wf = await _create_workflow(db_session, "Moderate Boundary")
    await _create_step(db_session, str(wf.id), 0, stability_score=0.5)
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["step_analysis"][0]["risk"] == "medium"


@pytest.mark.asyncio
async def test_analyze_fragile_step_high_risk(client: AsyncClient, db_session: AsyncSession):
    """stability_score=0.3 → risk='high'; reduces est_completion by 0.15."""
    wf = await _create_workflow(db_session, "Fragile WF")
    await _create_step(db_session, str(wf.id), 0, stability_score=0.3)
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["step_analysis"][0]["risk"] == "high"
    assert data["high_risk_steps"] == 1
    assert abs(data["estimated_completion_probability"] - 0.85) < 0.001


@pytest.mark.asyncio
async def test_analyze_fragile_boundary(client: AsyncClient, db_session: AsyncSession):
    """stability_score=0.499 → risk='high' (< 0.5 threshold)."""
    wf = await _create_workflow(db_session, "Fragile Boundary")
    await _create_step(db_session, str(wf.id), 0, stability_score=0.499)
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["step_analysis"][0]["risk"] == "high"


@pytest.mark.asyncio
async def test_analyze_completion_floor_at_zero(client: AsyncClient, db_session: AsyncSession):
    """8 high-risk steps → est_completion floored at 0.0 (max(0, 1-8*0.15)=-0.2→0)."""
    wf = await _create_workflow(db_session, "All Fragile")
    for i in range(8):
        await _create_step(db_session, str(wf.id), i, stability_score=0.1)
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["estimated_completion_probability"] == 0.0


@pytest.mark.asyncio
async def test_analyze_health_score_average(client: AsyncClient, db_session: AsyncSession):
    """Two steps with scores 0.6 and 0.8 → health_score = 0.7."""
    wf = await _create_workflow(db_session, "Health Score WF")
    await _create_step(db_session, str(wf.id), 0, stability_score=0.6)
    await _create_step(db_session, str(wf.id), 1, stability_score=0.8)
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert abs(data["health_score"] - 0.7) < 0.001


@pytest.mark.asyncio
async def test_analyze_health_score_ignores_none(client: AsyncClient, db_session: AsyncSession):
    """3 steps: 0.6, None, 0.8 → health_score = 0.7 (None excluded)."""
    wf = await _create_workflow(db_session, "Health Score Mixed")
    await _create_step(db_session, str(wf.id), 0, stability_score=0.6)
    await _create_step(db_session, str(wf.id), 1, stability_score=None)
    await _create_step(db_session, str(wf.id), 2, stability_score=0.8)
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert abs(data["health_score"] - 0.7) < 0.001


@pytest.mark.asyncio
async def test_analyze_no_redundancy_mixed_actions(client: AsyncClient, db_session: AsyncSession):
    """navigate + click + navigate (different URLs) → redundant_steps=0."""
    wf = await _create_workflow(db_session, "Mixed Actions")
    await _create_step(db_session, str(wf.id), 0, action_type="navigate", value="https://a.com")
    await _create_step(db_session, str(wf.id), 1, action_type="click")
    await _create_step(db_session, str(wf.id), 2, action_type="navigate", value="https://b.com")
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["redundant_steps"] == 0


@pytest.mark.asyncio
async def test_analyze_consecutive_same_navigate_is_redundant(client: AsyncClient, db_session: AsyncSession):
    """Two consecutive navigate steps to same base URL (different hashes) → 1 redundant."""
    wf = await _create_workflow(db_session, "Redundant Nav")
    await _create_step(db_session, str(wf.id), 0, action_type="navigate", value="https://a.com/page#section1")
    await _create_step(db_session, str(wf.id), 1, action_type="navigate", value="https://a.com/page#section2")
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["redundant_steps"] == 1
    # The redundant step (index 1) should be in recommendations.
    assert any(r["step_index"] == 1 and r["redundant"] for r in data["recommendations"])


@pytest.mark.asyncio
async def test_analyze_consecutive_different_navigate_not_redundant(client: AsyncClient, db_session: AsyncSession):
    """Two consecutive navigate steps to DIFFERENT base URLs → redundant_steps=0."""
    wf = await _create_workflow(db_session, "Different Nav")
    await _create_step(db_session, str(wf.id), 0, action_type="navigate", value="https://a.com")
    await _create_step(db_session, str(wf.id), 1, action_type="navigate", value="https://b.com")
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["redundant_steps"] == 0


@pytest.mark.asyncio
async def test_analyze_redundancy_resets_on_non_navigate(client: AsyncClient, db_session: AsyncSession):
    """navigate(A) + click + navigate(A) → redundant_steps=0 (click resets tracking)."""
    wf = await _create_workflow(db_session, "Reset Tracking")
    await _create_step(db_session, str(wf.id), 0, action_type="navigate", value="https://a.com")
    await _create_step(db_session, str(wf.id), 1, action_type="click")
    await _create_step(db_session, str(wf.id), 2, action_type="navigate", value="https://a.com")
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["redundant_steps"] == 0


@pytest.mark.asyncio
async def test_analyze_triple_consecutive_navigate(client: AsyncClient, db_session: AsyncSession):
    """navigate(A) + navigate(A) + navigate(A) → redundant_steps=2."""
    wf = await _create_workflow(db_session, "Triple Nav")
    for i in range(3):
        await _create_step(db_session, str(wf.id), i, action_type="navigate", value="https://a.com")
    await db_session.flush()

    resp = await client.get(
        f"/v1/workflows/{wf.id}/analyze",
        headers={"X-API-Key": "dev-api-key-change-in-production"},
    )
    data = resp.json()
    assert data["redundant_steps"] == 2
