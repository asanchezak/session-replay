import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from core.exceptions import NotFoundError, StateTransitionError
from core.models.workflow import Workflow
from services.audit import AppendEvent, AuditService
from services.execution_service import ExecutionService


def _for_each_step(sources, inner_steps, limit_param="count", item_sigil="$item", **extra_config):
    config = {
        "kind": "for_each_config",
        "sources": sources,
        "limit_param": limit_param,
        "item_var": "profile_url",
        "item_sigil": item_sigil,
        "inner_failure_policy": "continue",
        "inner_steps": inner_steps,
    }
    config.update(extra_config)
    return {
        "step_index": 0,
        "action_type": "for_each",
        "intent": None,
        "selector_chain": None,
        "value": None,
        "methods": [config],
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


# ---------------------------------------------------------------------------
# Anti-bot pacing: noise_navigations + extended_cooldown_* + random_seed
# ---------------------------------------------------------------------------


async def _seed_with_urls(
    db_session: AsyncSession,
    urls: list[str],
    *,
    noise_navigations: bool = False,
    iteration_delay_ms: int = 0,
    iteration_delay_jitter_ms: int = 0,
    extended_cooldown_every_n: int = 0,
    extended_cooldown_ms: int = 0,
    extended_cooldown_jitter_ms: int = 0,
    random_seed: int | None = None,
    count: int | None = None,
):
    """Create a run with one extract step (step 0) seeded with `urls` and a
    for_each step (step 1) that consumes them. Returns (svc, run_id, n_urls)."""
    inner = [{"action_type": "navigate", "value": "$item"}]
    config_extras: dict = {}
    if noise_navigations:
        config_extras["noise_navigations"] = True
    if iteration_delay_ms:
        config_extras["iteration_delay_ms"] = iteration_delay_ms
    if iteration_delay_jitter_ms:
        config_extras["iteration_delay_jitter_ms"] = iteration_delay_jitter_ms
    if extended_cooldown_every_n:
        config_extras["extended_cooldown_every_n"] = extended_cooldown_every_n
    if extended_cooldown_ms:
        config_extras["extended_cooldown_ms"] = extended_cooldown_ms
    if extended_cooldown_jitter_ms:
        config_extras["extended_cooldown_jitter_ms"] = extended_cooldown_jitter_ms
    if random_seed is not None:
        config_extras["random_seed"] = random_seed

    snapshot_steps = [
        {"step_index": 0, "action_type": "extract", "value": "urls"},
        {**_for_each_step(
            [{"step_index": 0, "field": "profile_urls"}],
            inner,
            **config_extras,
        ), "step_index": 1},
    ]
    resolved = {"count": count if count is not None else len(urls)}
    svc, run_id = await _seed_run_with_snapshot(db_session, snapshot_steps, resolved_params=resolved)

    audit = AuditService(db_session)
    await audit.append(AppendEvent(
        event_type="extraction",
        payload={"step_index": 0, "data": [{"profile_urls": urls}]},
        run_id=run_id,
    ))
    await db_session.flush()
    return svc, run_id, len(urls)


@pytest.mark.asyncio
async def test_noise_navigations_off_no_noise_break_steps(db_session: AsyncSession):
    svc, run_id, _ = await _seed_with_urls(
        db_session,
        ["A", "B", "C"],
        noise_navigations=False,
    )
    result = await svc.expand_for_each(run_id, 1)
    materialized = result["steps"][2:]  # everything after [extract, for_each]
    assert all(s.get("action_type") != "noise_break" for s in materialized)
    assert sum(1 for s in materialized if s.get("action_type") == "navigate") == 3


@pytest.mark.asyncio
async def test_noise_navigations_on_prepends_one_per_iteration_except_first(
    db_session: AsyncSession,
):
    svc, run_id, _ = await _seed_with_urls(
        db_session,
        ["A", "B", "C", "D"],
        noise_navigations=True,
        random_seed=42,
    )
    result = await svc.expand_for_each(run_id, 1)
    materialized = result["steps"][2:]
    noise = [s for s in materialized if s.get("action_type") == "noise_break"]
    navs = [s for s in materialized if s.get("action_type") == "navigate"]
    # 4 iterations → 3 noise_break steps (skipping iteration 0)
    assert len(noise) == 3
    assert len(navs) == 4
    valid_kinds = {"search_bounce", "feed_scroll", "profile_hover", "idle_scroll"}
    for n in noise:
        assert n["_noise_kind"] in valid_kinds
        assert isinstance(n["_noise_seed"], int)
        assert n["_for_each_origin_step"] == 1


@pytest.mark.asyncio
async def test_noise_kinds_are_probability_weighted(db_session: AsyncSession):
    # 500 iterations across two seeds, then aggregate — reduces sampling noise.
    expected = {"search_bounce": 0.35, "feed_scroll": 0.20, "profile_hover": 0.25, "idle_scroll": 0.20}
    counts: dict[str, int] = {}
    total = 0
    for seed in (12345, 67890):
        urls = [f"https://x/{seed}/in/u{i}/" for i in range(250)]
        svc, run_id, _ = await _seed_with_urls(
            db_session, urls, noise_navigations=True, random_seed=seed,
        )
        result = await svc.expand_for_each(run_id, 1)
        for s in result["steps"][2:]:
            if s.get("action_type") == "noise_break":
                counts[s["_noise_kind"]] = counts.get(s["_noise_kind"], 0) + 1
                total += 1
    # 2 × (250 - 1) = 498 noise_break steps total.
    assert total == 498
    for kind, exp in expected.items():
        observed = counts.get(kind, 0) / total
        assert abs(observed - exp) < 0.05, f"{kind}: observed {observed:.3f}, expected {exp}"


@pytest.mark.asyncio
async def test_extended_cooldown_stacks_every_nth_iteration(db_session: AsyncSession):
    svc, run_id, _ = await _seed_with_urls(
        db_session,
        ["A", "B", "C", "D", "E", "F", "G"],
        iteration_delay_ms=1000,
        iteration_delay_jitter_ms=0,
        extended_cooldown_every_n=3,
        extended_cooldown_ms=10_000,
        extended_cooldown_jitter_ms=0,
        random_seed=7,
        noise_navigations=False,
    )
    result = await svc.expand_for_each(run_id, 1)
    # Iteration indices that should carry extended cooldown: i > 0 and i % 3 == 0,
    # i.e. 3 and 6 (with 7 URLs: indices 0..6).
    materialized = result["steps"][2:]
    # Inner step is just navigate; one per iteration.
    iteration_pre_delays = [s.get("delay_before_ms", 0) for s in materialized]
    # Iter 0: no delay. Iter 1,2,4,5: base 1000 only. Iter 3,6: base + 10000.
    assert iteration_pre_delays[0] == 0
    assert iteration_pre_delays[1] == 1000
    assert iteration_pre_delays[2] == 1000
    assert iteration_pre_delays[3] == 11000
    assert iteration_pre_delays[4] == 1000
    assert iteration_pre_delays[5] == 1000
    assert iteration_pre_delays[6] == 11000
    assert materialized[3]["_extended_cooldown"] is True
    assert materialized[6]["_extended_cooldown"] is True


@pytest.mark.asyncio
async def test_random_seed_determinism(db_session: AsyncSession):
    urls = [f"https://x/in/u{i}/" for i in range(8)]
    svc1, run_id1, _ = await _seed_with_urls(
        db_session, urls, noise_navigations=True, random_seed=999,
    )
    svc2, run_id2, _ = await _seed_with_urls(
        db_session, urls, noise_navigations=True, random_seed=999,
    )
    res1 = await svc1.expand_for_each(run_id1, 1)
    res2 = await svc2.expand_for_each(run_id2, 1)
    # Strip per-run keys (none here) and compare materialized step lists.
    def _shape(steps):
        return [
            {k: v for k, v in s.items() if k != "_for_each_item"} or s
            for s in steps[2:]
        ]
    assert _shape(res1["steps"]) == _shape(res2["steps"])


@pytest.mark.asyncio
async def test_cooldown_pre_delay_lives_on_noise_break_when_noise_on(
    db_session: AsyncSession,
):
    """When noise_navigations is on, the iteration's delay_before_ms is carried
    by the noise_break step, not the first inner navigate."""
    svc, run_id, _ = await _seed_with_urls(
        db_session,
        ["A", "B", "C"],
        iteration_delay_ms=5000,
        iteration_delay_jitter_ms=0,
        noise_navigations=True,
        random_seed=1,
    )
    result = await svc.expand_for_each(run_id, 1)
    materialized = result["steps"][2:]
    # Iteration 0: just one navigate, no delay, no noise.
    assert materialized[0]["action_type"] == "navigate"
    assert materialized[0].get("delay_before_ms", 0) == 0
    # Iteration 1: noise_break with delay_before_ms=5000, then navigate (no delay).
    assert materialized[1]["action_type"] == "noise_break"
    assert materialized[1]["delay_before_ms"] == 5000
    assert materialized[2]["action_type"] == "navigate"
    assert materialized[2].get("delay_before_ms", 0) == 0
