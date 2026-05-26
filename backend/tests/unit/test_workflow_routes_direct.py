from __future__ import annotations

import types
import uuid

import pytest
from fastapi.responses import JSONResponse

from api.v1.workflows import (
    RecordEventInput,
    RecordWorkflowRequest,
    RunWithParamsRequest,
    UpdateStatusRequest,
    analyze_workflow_blueprint,
    create_workflow,
    delete_all_workflows,
    delete_workflow,
    generate_workflow_prompt,
    get_workflow,
    record_workflow,
    run_workflow,
    run_workflow_with_parameters,
    update_step_selectors,
    update_workflow,
    update_workflow_status,
)
from core.exceptions import NotFoundError
from core.models.workflow import WorkflowStep
from services.workflow_service import WorkflowService


async def _seed_workflow(db_session, *, status: str = "active", with_step: bool = True) -> str:
    svc = WorkflowService(db_session)
    wf = await svc.create(name="seed", target_url="https://example.test")
    if with_step:
        await svc.add_step(
            workflow_id=str(wf.id),
            step_index=0,
            action_type="click",
            intent="click",
            selector_chain=[{"type": "css", "value": "#a"}],
        )
    if status != "draft":
        await svc.update_status(str(wf.id), status)
    return str(wf.id)


@pytest.mark.asyncio
async def test_record_workflow_direct_success_and_failure_paths(db_session, monkeypatch):
    class _Provider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(content="Direct Name")

    async def _analysis(_self, _workflow_id):
        return types.SimpleNamespace(workflow_goal="Goal", confidence_overall=0.9)

    async def _phases(_self, _workflow_id):
        return []

    monkeypatch.setattr("api.v1.workflows.get_ai_provider", lambda **_kwargs: _Provider())
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.analyze_workflow", _analysis
    )
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.get_phases", _phases
    )

    req = RecordWorkflowRequest(
        name="recorded",
        target_url="https://example.test",
        events=[
            RecordEventInput(
                event_type="click",
                payload={"target": {"selector": "#x", "text": "X"}, "methods": [{"action_type": "click"}]},
            ),
            RecordEventInput(
                event_type="type",
                payload={"selector_chain": [{"type": "css", "value": "#email"}], "value": "a@b.com"},
            ),
        ],
    )
    out = await record_workflow(req, db=db_session)
    assert out["name"] == "Direct Name"
    # Simplification disabled: all 2 events are kept
    assert out["step_count"] == 2
    assert out["simplified_from"] is None
    assert out["simplification_status"] == "skipped"

    class _BrokenProvider:
        async def generate(self, *_args, **_kwargs):
            raise RuntimeError("boom")

    async def _analysis_fail(_self, _workflow_id):
        raise RuntimeError("analysis down")

    monkeypatch.setattr("api.v1.workflows.get_ai_provider", lambda **_kwargs: _BrokenProvider())
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.analyze_workflow", _analysis_fail
    )

    failed = await record_workflow(
        RecordWorkflowRequest(
            name="recorded-2",
            events=[RecordEventInput(event_type="click", payload={"target": {"selector": "#y"}})],
        ),
        db=db_session,
    )
    assert failed["step_count"] == 1
    assert failed["analysis"]["goal"] is None


@pytest.mark.asyncio
async def test_record_workflow_accepts_legacy_navigate_url_payload(db_session, monkeypatch):
    class _Provider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(content="Name")

    async def _analysis(_self, _workflow_id):
        return types.SimpleNamespace(workflow_goal="Goal", confidence_overall=0.9)

    async def _phases(_self, _workflow_id):
        return []

    async def _identity_simplify(_self, steps, phases):  # noqa: ARG001
        return [
            {
                "action_type": s.action_type,
                "intent": s.intent,
                "selector_chain": s.selector_chain,
                "value": s.value,
                "methods": s.methods,
            }
            for s in steps
        ]

    monkeypatch.setattr("api.v1.workflows.get_ai_provider", lambda **_kwargs: _Provider())
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.analyze_workflow", _analysis
    )
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.get_phases", _phases
    )
    monkeypatch.setattr("services.workflow_simplifier.WorkflowSimplifier.simplify", _identity_simplify)

    out = await record_workflow(
        RecordWorkflowRequest(
            name="legacy-nav",
            events=[
                RecordEventInput(
                    event_type="navigate",
                    payload={"url": "https://example.com/legacy"},
                ),
            ],
        ),
        db=db_session,
    )
    assert out["step_count"] == 1

    detail = await get_workflow(out["id"], db=db_session)
    assert detail["steps"][0]["action_type"] == "navigate"
    assert detail["steps"][0]["value"] == "https://example.com/legacy"


@pytest.mark.asyncio
async def test_workflow_detail_update_and_prompt_routes_direct(db_session, monkeypatch):
    wf_id = await _seed_workflow(db_session, with_step=True)

    async def _analysis(_self, _workflow_id):
        return types.SimpleNamespace(
            workflow_goal="collect",
            workflow_summary="sum",
            domain_context="ctx",
            confidence_overall=0.8,
            replay_strategy="goal_first",
            is_user_edited=False,
            ambiguity_notes=[],
        )

    async def _phases(_self, _workflow_id):
        return [types.SimpleNamespace(phase_index=0, phase_name="p", phase_goal="g", start_step_index=0, end_step_index=1)]

    async def _params(_self, _workflow_id):
        return [types.SimpleNamespace(parameter_key="q", parameter_type="str", default_value="x", description="d", confidence=0.9, is_required=True)]

    async def _output(_self, _workflow_id):
        return types.SimpleNamespace(output_type="list", output_schema={"type": "array"}, schema_confidence=0.7)

    async def _template(_self, _workflow_id):
        return types.SimpleNamespace(template_version=2)

    monkeypatch.setattr("services.semantic_analysis_service.SemanticAnalysisService.get_analysis", _analysis)
    monkeypatch.setattr("services.semantic_analysis_service.SemanticAnalysisService.get_phases", _phases)
    monkeypatch.setattr("services.semantic_analysis_service.SemanticAnalysisService.get_parameters", _params)
    monkeypatch.setattr("services.semantic_analysis_service.SemanticAnalysisService.get_output_spec", _output)
    monkeypatch.setattr("services.semantic_analysis_service.SemanticAnalysisService.get_template", _template)

    detail = await get_workflow(wf_id, db=db_session)
    assert detail["analysis"]["workflow_goal"] == "collect"

    updated = await update_workflow(wf_id, req=types.SimpleNamespace(name="new", description="d", prompt=None, target_url=None), db=db_session)
    assert updated["name"] == "new"

    selectors = await update_step_selectors(
        wf_id,
        step_index=0,
        req=types.SimpleNamespace(selector_chain=[types.SimpleNamespace(model_dump=lambda: {"type": "css", "value": "#new"})]),
        db=db_session,
    )
    assert selectors["selector_chain"][0]["value"] == "#new"

    class _Provider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(content="Prompt summary")

    monkeypatch.setattr("api.v1.workflows.get_ai_provider", lambda **_kwargs: _Provider())
    req = types.SimpleNamespace(headers={"X-AI-API-Key": "x"})
    prompt = await generate_workflow_prompt(wf_id, request=req, db=db_session)
    assert prompt["generated"] is True

    class _BrokenProvider:
        async def generate(self, *_args, **_kwargs):
            raise RuntimeError("nope")

    monkeypatch.setattr("api.v1.workflows.get_ai_provider", lambda **_kwargs: _BrokenProvider())
    fallback = await generate_workflow_prompt(wf_id, request=req, db=db_session)
    assert fallback["generated"] is False

    missing = await generate_workflow_prompt(str(uuid.uuid4()), request=req, db=db_session)
    assert isinstance(missing, JSONResponse)
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_workflow_run_routes_direct(db_session, monkeypatch):
    active_empty = await _seed_workflow(db_session, with_step=False)
    empty = await run_workflow(active_empty, db=db_session)
    assert isinstance(empty, JSONResponse)
    assert empty.status_code == 400

    draft = await _seed_workflow(db_session, status="draft", with_step=True)
    bad_status = await run_workflow(draft, db=db_session)
    assert isinstance(bad_status, JSONResponse)
    assert bad_status.status_code == 409

    active = await _seed_workflow(db_session, with_step=True)
    started = await run_workflow(active, db=db_session)
    assert started["status"] == "running"

    async def _nf_create(*_args, **_kwargs):
        from core.exceptions import NotFoundError

        raise NotFoundError("missing")

    monkeypatch.setattr("services.execution_service.ExecutionService.create_run", _nf_create)
    missing_run = await run_workflow(active, db=db_session)
    assert isinstance(missing_run, JSONResponse)
    assert missing_run.status_code == 404

    async def _confirm(*_args, **_kwargs):
        return {"mode": "confirmation_required", "reason": "need goal", "ambiguity_notes": [], "questions": []}

    monkeypatch.setattr("services.template_service.TemplateService.build_execution_plan", _confirm)
    goal_required = await run_workflow_with_parameters(
        active,
        req=RunWithParamsRequest(runtime_params={}, execution_goal="goal"),
        db=db_session,
    )
    assert isinstance(goal_required, JSONResponse)
    assert goal_required.status_code == 409

    async def _plan(*_args, **_kwargs):
        return {"mode": "execute", "steps": [{"action_type": "click"}]}

    monkeypatch.setattr("services.template_service.TemplateService.build_execution_plan", _plan)
    async def _ok_create(*_args, **_kwargs):
        return types.SimpleNamespace(
            id=uuid.uuid4(),
            workflow_id=active,
            status="queued",
            current_step_index=0,
            total_steps=1,
        )

    async def _ok_transition(*_args, **_kwargs):
        return types.SimpleNamespace(
            id=uuid.uuid4(),
            workflow_id=active,
            status="running",
            current_step_index=0,
            total_steps=1,
        )

    monkeypatch.setattr("services.execution_service.ExecutionService.create_run", _ok_create)
    monkeypatch.setattr("services.execution_service.ExecutionService.transition", _ok_transition)
    normal = await run_workflow_with_parameters(
        active,
        req=RunWithParamsRequest(runtime_params={"x": "y"}, execution_goal=None),
        db=db_session,
    )
    assert normal["status"] == "running"


@pytest.mark.asyncio
async def test_workflow_status_create_and_blueprint_direct(db_session):
    created = await create_workflow(
        req=types.SimpleNamespace(name="c", description=None, prompt=None, target_url="https://x", created_by=None),
        db=db_session,
    )
    wf_id = created["id"]

    bad = await update_workflow_status(wf_id, req=UpdateStatusRequest(status="invalid"), db=db_session)
    assert isinstance(bad, JSONResponse)
    assert bad.status_code == 422

    ok = await update_workflow_status(wf_id, req=UpdateStatusRequest(status="active"), db=db_session)
    assert ok["status"] == "active"

    svc = WorkflowService(db_session)
    await svc.add_step(wf_id, 0, "navigate", selector_chain=[], value="https://example.test/jobs#x")
    await svc.add_step(wf_id, 1, "navigate", selector_chain=[], value="https://example.test/jobs#y")
    result = await db_session.execute(
        WorkflowStep.__table__.select().where(WorkflowStep.workflow_id == wf_id).order_by(WorkflowStep.step_index)
    )
    rows = result.fetchall()
    for idx, row in enumerate(rows):
        obj = await db_session.get(WorkflowStep, row.id)
        assert obj is not None
        obj.selector_stability_score = [0.9, 0.4][idx]
    await db_session.flush()

    blueprint = await analyze_workflow_blueprint(wf_id, db=db_session)
    assert blueprint["high_risk_steps"] >= 1
    assert blueprint["redundant_steps"] >= 1

    missing = await analyze_workflow_blueprint(str(uuid.uuid4()), db=db_session)
    assert isinstance(missing, JSONResponse)
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_delete_workflow_routes_direct(db_session):
    created = await create_workflow(
        req=types.SimpleNamespace(name="gone", description=None, prompt=None, target_url=None, created_by=None),
        db=db_session,
    )
    svc = WorkflowService(db_session)
    await svc.add_step(created["id"], 0, "click", selector_chain=[{"type": "css", "value": "#x"}])

    deleted = await delete_workflow(created["id"], db=db_session)
    assert deleted["deleted"]["workflow_id"] == created["id"]
    with pytest.raises(NotFoundError):
        await svc.get(created["id"])


@pytest.mark.asyncio
async def test_delete_all_workflows_routes_direct(db_session):
    svc = WorkflowService(db_session)
    first = await svc.create(name="one")
    second = await svc.create(name="two")
    await svc.add_step(str(first.id), 0, "click", selector_chain=[{"type": "css", "value": "#a"}])
    await svc.add_step(str(second.id), 0, "click", selector_chain=[{"type": "css", "value": "#b"}])

    deleted = await delete_all_workflows(db=db_session)
    assert deleted["deleted"]["workflows"] == 2
    assert deleted["deleted"]["workflow_steps"] == 2
    assert await svc.list() == []


@pytest.mark.asyncio
async def test_delete_all_workflows_preserves_system_workflows(db_session):
    """Bulk delete must never wipe system workflows when invoked without an
    explicit type filter (the UI's 'Delete all' button on the user tab)."""
    svc = WorkflowService(db_session)
    user_wf = await svc.create(name="user one", workflow_type="user")
    system_wf = await svc.create(name="system one", workflow_type="system")

    deleted = await delete_all_workflows(db=db_session)
    assert deleted["deleted"]["workflows"] == 1

    remaining = await svc.list()
    assert len(remaining) == 1
    assert str(remaining[0].id) == str(system_wf.id)
    with pytest.raises(NotFoundError):
        await svc.get(str(user_wf.id))


@pytest.mark.asyncio
async def test_delete_all_workflows_with_explicit_system_type(db_session):
    svc = WorkflowService(db_session)
    await svc.create(name="user one", workflow_type="user")
    await svc.create(name="system one", workflow_type="system")

    deleted = await delete_all_workflows(type="system", db=db_session)
    assert deleted["deleted"]["workflows"] == 1
    remaining = await svc.list()
    assert len(remaining) == 1
    assert remaining[0].workflow_type == "user"


@pytest.mark.asyncio
async def test_record_workflow_no_simplification_and_causal_enrichment(db_session, monkeypatch):
    """All events are kept and accessibility_metadata is populated with causal data."""
    class _Provider:
        async def generate(self, *_a, **_kw):
            return types.SimpleNamespace(content="LinkedIn Message Sender")

    async def _analysis(_self, _wf_id):
        return types.SimpleNamespace(workflow_goal="send message", confidence_overall=0.8)

    async def _phases(_self, _wf_id):
        return []

    monkeypatch.setattr("api.v1.workflows.get_ai_provider", lambda **_kw: _Provider())
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.analyze_workflow", _analysis
    )
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.get_phases", _phases
    )

    req = RecordWorkflowRequest(
        name="linkedin test",
        target_url="https://www.linkedin.com/",
        events=[
            RecordEventInput(
                event_type="navigate",
                payload={"value": "https://www.linkedin.com/feed/"},
                page_url="https://www.linkedin.com/",
                timestamp="2026-05-20T10:00:00.000Z",
            ),
            RecordEventInput(
                event_type="click",
                payload={"target": {"selector": "#search-box"}, "intent": "Click Search"},
                page_url="https://www.linkedin.com/feed/",
                timestamp="2026-05-20T10:00:02.000Z",
            ),
            RecordEventInput(
                event_type="navigate",
                payload={"value": "https://www.linkedin.com/search/results/"},
                page_url="https://www.linkedin.com/feed/",
                timestamp="2026-05-20T10:00:02.300Z",
            ),
            RecordEventInput(
                event_type="type",
                payload={"value": "John Smith", "intent": "Type name"},
                page_url="https://www.linkedin.com/search/results/",
                timestamp="2026-05-20T10:00:06.000Z",
            ),
            RecordEventInput(
                event_type="click",
                payload={"target": {"selector": "#send-btn"}, "intent": "Click Send"},
                page_url="https://www.linkedin.com/search/results/",
                timestamp="2026-05-20T10:00:07.000Z",
            ),
        ],
    )
    out = await record_workflow(req, db=db_session)

    # All 5 events kept — no simplification
    assert out["step_count"] == 5
    assert out["simplification_status"] == "skipped"
    assert out["simplified_from"] is None

    # Causal enrichment: the click at index 1 is followed by a navigate within 300ms
    svc = WorkflowService(db_session)
    steps = await svc.get_steps(out["id"])
    assert len(steps) == 5

    click_step = steps[1]
    meta = click_step.accessibility_metadata or {}
    assert meta.get("caused_url_change") is True
    assert meta.get("context_url_before") == "https://www.linkedin.com/feed/"
    assert meta.get("time_since_previous_ms") == 2000  # 2s gap from navigate to click

    # Type step preceded by a ~3.7s gap
    type_step = steps[3]
    type_meta = type_step.accessibility_metadata or {}
    assert type_meta.get("caused_url_change") is False
    assert type_meta.get("time_since_previous_ms") is not None
    assert type_meta.get("time_since_previous_ms") > 3000  # 3.7s gap
