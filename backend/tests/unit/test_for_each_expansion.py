import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from core.exceptions import NotFoundError, StateTransitionError
from core.models.workflow import Workflow
from services.audit import AppendEvent, AuditService
from services.execution_service import ExecutionService


def _for_each_step(sources, inner_steps, limit_param="count", item_sigil="$item"):
    return {
        "step_index": 0,
        "action_type": "for_each",
        "intent": None,
        "selector_chain": None,
        "value": None,
        "methods": [{
            "kind": "for_each_config",
            "sources": sources,
            "limit_param": limit_param,
            "item_var": "profile_url",
            "item_sigil": item_sigil,
            "inner_failure_policy": "continue",
            "inner_steps": inner_steps,
        }],
        "success_condition": None,
    }


async def _seed_run_with_snapshot(db_session: AsyncSession, snapshot_steps, resolved_params=None):
    wf = Workflow(name="for_each test", status="active")
    db_session.add(wf)
    await db_session.flush()
    svc = ExecutionService(db_session)
    run = await svc.create_run(workflow_id=str(wf.id))
    snap = run.workflow_snapshot or {}
    snap["steps"] = snapshot_steps
    snap["analysis"] = {
        "execution_plan": {"resolved_parameters": resolved_params or {}}
    }
    run.workflow_snapshot = snap
    run.total_steps = len(snapshot_steps)
    flag_modified(run, "workflow_snapshot")
    await db_session.flush()
    return svc, str(run.id)


@pytest.mark.asyncio
async def test_expand_for_each_basic(db_session: AsyncSession):
    inner = [
        {"action_type": "navigate", "value": "$item", "intent": "Open profile"},
        {"action_type": "extract", "value": "About", "methods": [{"kind": "extract_shapes", "shapes": []}]},
    ]
    snapshot_steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://x/search?keywords=js"},
        {"step_index": 1, "action_type": "extract", "value": "profile_urls", "methods": []},
        {**_for_each_step([{"step_index": 1, "field": "profile_urls"}], inner), "step_index": 2},
    ]
    svc, run_id = await _seed_run_with_snapshot(
        db_session, snapshot_steps, resolved_params={"count": 3}
    )

    audit = AuditService(db_session)
    await audit.append(AppendEvent(
        event_type="extraction",
        payload={"step_index": 1, "data": [{"profile_urls": ["A", "B", "C", "D", "E"]}]},
        run_id=run_id,
    ))
    await db_session.flush()

    result = await svc.expand_for_each(run_id, 2)
    assert result["iterations"] == 3
    new_steps = result["steps"]
    # 3 original + 3 iterations × 2 inner = 9
    assert len(new_steps) == 9
    # First inner navigate is at index 3 with profile_url = "A"
    assert new_steps[3]["action_type"] == "navigate"
    assert new_steps[3]["value"] == "A"
    assert new_steps[5]["value"] == "B"
    assert new_steps[7]["value"] == "C"
    # Step indices are renumbered
    for i, s in enumerate(new_steps):
        assert s["step_index"] == i


@pytest.mark.asyncio
async def test_expand_for_each_multiple_sources_dedupes(db_session: AsyncSession):
    inner = [{"action_type": "navigate", "value": "$item"}]
    snapshot_steps = [
        {"step_index": 0, "action_type": "navigate", "value": "page1"},
        {"step_index": 1, "action_type": "extract", "value": "urls"},
        {"step_index": 2, "action_type": "navigate", "value": "page2"},
        {"step_index": 3, "action_type": "extract", "value": "urls"},
        {**_for_each_step(
            [{"step_index": 1, "field": "profile_urls"}, {"step_index": 3, "field": "profile_urls"}],
            inner,
        ), "step_index": 4},
    ]
    svc, run_id = await _seed_run_with_snapshot(
        db_session, snapshot_steps, resolved_params={"count": 20}
    )

    audit = AuditService(db_session)
    await audit.append(AppendEvent(
        event_type="extraction",
        payload={"step_index": 1, "data": [{"profile_urls": ["A", "B", "C"]}]},
        run_id=run_id,
    ))
    await audit.append(AppendEvent(
        event_type="extraction",
        payload={"step_index": 3, "data": [{"profile_urls": ["C", "D", "E"]}]},  # C duplicated
        run_id=run_id,
    ))
    await db_session.flush()

    result = await svc.expand_for_each(run_id, 4)
    # Expected items: [A, B, C, D, E] (dedupe; preserve order)
    assert result["items"] == ["A", "B", "C", "D", "E"]
    assert result["iterations"] == 5


@pytest.mark.asyncio
async def test_expand_for_each_idempotent(db_session: AsyncSession):
    inner = [{"action_type": "navigate", "value": "$item"}]
    snapshot_steps = [
        {"step_index": 0, "action_type": "extract", "value": "urls"},
        {**_for_each_step([{"step_index": 0, "field": "profile_urls"}], inner), "step_index": 1},
    ]
    svc, run_id = await _seed_run_with_snapshot(
        db_session, snapshot_steps, resolved_params={"count": 2}
    )

    audit = AuditService(db_session)
    await audit.append(AppendEvent(
        event_type="extraction",
        payload={"step_index": 0, "data": [{"profile_urls": ["X", "Y"]}]},
        run_id=run_id,
    ))
    await db_session.flush()

    first = await svc.expand_for_each(run_id, 1)
    assert first["iterations"] == 2
    second = await svc.expand_for_each(run_id, 1)
    assert second.get("already_expanded") is True
    assert len(second["steps"]) == len(first["steps"])


@pytest.mark.asyncio
async def test_expand_for_each_substitutes_in_selectors(db_session: AsyncSession):
    inner = [{
        "action_type": "click",
        "value": "Open $item",
        "selector_chain": [{"type": "text", "value": "Profile $item link"}],
        "success_condition": {"type": "url_contains", "value": "$item"},
    }]
    snapshot_steps = [
        {"step_index": 0, "action_type": "extract", "value": "urls"},
        {**_for_each_step([{"step_index": 0, "field": "profile_urls"}], inner), "step_index": 1},
    ]
    svc, run_id = await _seed_run_with_snapshot(
        db_session, snapshot_steps, resolved_params={"count": 1}
    )

    audit = AuditService(db_session)
    await audit.append(AppendEvent(
        event_type="extraction",
        payload={"step_index": 0, "data": [{"profile_urls": ["alice"]}]},
        run_id=run_id,
    ))
    await db_session.flush()

    result = await svc.expand_for_each(run_id, 1)
    inner_step = result["steps"][2]
    assert inner_step["value"] == "Open alice"
    assert inner_step["selector_chain"][0]["value"] == "Profile alice link"
    assert inner_step["success_condition"]["value"] == "alice"


@pytest.mark.asyncio
async def test_expand_for_each_rejects_non_for_each(db_session: AsyncSession):
    snapshot_steps = [{"step_index": 0, "action_type": "navigate", "value": "x"}]
    svc, run_id = await _seed_run_with_snapshot(db_session, snapshot_steps)
    with pytest.raises(StateTransitionError):
        await svc.expand_for_each(run_id, 0)


@pytest.mark.asyncio
async def test_expand_for_each_unknown_step(db_session: AsyncSession):
    snapshot_steps = [{"step_index": 0, "action_type": "navigate", "value": "x"}]
    svc, run_id = await _seed_run_with_snapshot(db_session, snapshot_steps)
    with pytest.raises(NotFoundError):
        await svc.expand_for_each(run_id, 99)
