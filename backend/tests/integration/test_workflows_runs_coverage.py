from __future__ import annotations

import types
import uuid

import fsspec
import pytest

from core.config import settings
from core.exceptions import NotFoundError, StateTransitionError
from core.models.run import ExecutionRun
from core.models.workflow import WorkflowStep
from core.state_machine import RunStatus

HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.fixture(autouse=True)
def _storage_tmp(monkeypatch, tmp_path):
    def _fake_init(self):
        self.fs = fsspec.filesystem("file")
        self.base_path = str(tmp_path)

    monkeypatch.setattr("services.storage_service.StorageService.__init__", _fake_init)


async def _create_active_workflow(api_client, name: str = "wf", *, with_step: bool = True) -> str:
    create = await api_client.post("/v1/workflows", headers=HEADERS, json={"name": name})
    workflow_id = create.json()["id"]
    if with_step:
        await api_client.post(
            f"/v1/workflows/{workflow_id}/steps",
            headers=HEADERS,
            json={
                "step_index": 0,
                "action_type": "click",
                "intent": "click it",
                "selector_chain": [{"type": "css", "value": "#btn"}],
            },
        )
    await api_client.put(
        f"/v1/workflows/{workflow_id}/status",
        headers=HEADERS,
        json={"status": "active"},
    )
    return workflow_id


async def _create_running_run(api_client, *, with_step: bool = True) -> tuple[str, str]:
    workflow_id = await _create_active_workflow(api_client, name="run-wf", with_step=with_step)
    run = await api_client.post(f"/v1/workflows/{workflow_id}/run", headers=HEADERS)
    assert run.status_code == 200, run.text
    return workflow_id, run.json()["id"]


@pytest.mark.asyncio
async def test_record_workflow_covers_analysis_naming_and_simplifier(api_client, monkeypatch):
    class _Provider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(content="AI Generated Name")

    async def _analyze(_self, _workflow_id):
        return types.SimpleNamespace(workflow_goal="Do task", confidence_overall=0.91)

    async def _phases(_self, _workflow_id):
        return []

    async def _simplify(_self, steps, phases):
        assert phases == []
        return [
            {
                "action_type": steps[0].action_type,
                "intent": steps[0].intent,
                "selector_chain": steps[0].selector_chain,
                "value": steps[0].value,
                "methods": steps[0].methods,
            }
        ]

    monkeypatch.setattr("api.v1.workflows.get_ai_provider", lambda **_kwargs: _Provider())
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.analyze_workflow", _analyze
    )
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.get_phases", _phases
    )
    monkeypatch.setattr("services.workflow_simplifier.WorkflowSimplifier.simplify", _simplify)

    resp = await api_client.post(
        "/v1/workflows/record",
        headers=HEADERS,
        json={
            "name": "raw name",
            "target_url": "https://example.com",
            "events": [
                {
                    "event_type": "click",
                    "payload": {
                        "intent": "press login",
                        "target": {"selector": "#login", "text": "Login"},
                        "methods": [
                            {
                                "action_type": "click",
                                "selector_chain": [{"type": "css", "value": "#login"}],
                            }
                        ],
                    },
                },
                {
                    "event_type": "type",
                    "payload": {
                        "selector_chain": [{"type": "css", "value": "#email"}],
                        "value": "user@example.com",
                    },
                },
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "AI Generated Name"
    assert body["step_count"] == 1
    assert body["simplified_from"] == 2
    assert body["analysis"]["goal"] == "Do task"
    assert body["simplification_status"] == "succeeded"
    assert body["simplification_error"] is None


@pytest.mark.asyncio
async def test_record_workflow_idempotency(api_client, monkeypatch):
    from services import idempotency_cache as ic

    # Use a fresh cache so other tests don't bleed state in.
    fresh = ic.IdempotencyCache(ttl_seconds=600)
    monkeypatch.setattr(ic, "_default_cache", fresh)

    async def _no_analysis(_self, _workflow_id):
        return types.SimpleNamespace(
            workflow_goal="goal", workflow_summary="s", domain_context="d",
            confidence_overall=0.5, replay_strategy="parameterized",
            is_user_edited=False, ambiguity_notes=[], parameters=[],
            output_spec=types.SimpleNamespace(type="unknown", schema=None, confidence=0.0),
            template_version=2,
        )

    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.analyze_workflow",
        _no_analysis,
    )

    class _Provider:
        async def generate(self, *_args, **_kwargs):
            from ai.client import AIResponse
            return AIResponse(content="Some Name")

    monkeypatch.setattr("api.v1.workflows.get_ai_provider", lambda **_kwargs: _Provider())

    async def _identity_simplify(_self, steps, phases):
        return steps

    monkeypatch.setattr(
        "services.workflow_simplifier.WorkflowSimplifier.simplify",
        _identity_simplify,
    )

    payload = {
        "name": "idem-test",
        "target_url": "https://example.com",
        "events": [{"event_type": "click", "payload": {"target": {"selector": "#a"}}}],
    }
    headers = {**HEADERS, "Idempotency-Key": "idem-1"}

    r1 = await api_client.post("/v1/workflows/record", headers=headers, json=payload)
    assert r1.status_code == 200, r1.text
    r2 = await api_client.post("/v1/workflows/record", headers=headers, json=payload)
    assert r2.status_code == 200, r2.text
    # Same key + same payload → identical response body, no new workflow row.
    assert r1.json()["id"] == r2.json()["id"]

    # Same key + different payload → 409 conflict.
    r3 = await api_client.post(
        "/v1/workflows/record",
        headers=headers,
        json={**payload, "name": "idem-test-different"},
    )
    assert r3.status_code == 409


@pytest.mark.asyncio
async def test_record_workflow_handles_analysis_ai_and_simplifier_failures(api_client, monkeypatch):
    class _Provider:
        async def generate(self, *_args, **_kwargs):
            raise RuntimeError("ai down")

    async def _analyze_fail(_self, _workflow_id):
        raise RuntimeError("analysis fail")

    async def _simplify_fail(_self, _steps, phases):  # noqa: ARG001
        raise RuntimeError("simplify fail")

    monkeypatch.setattr("api.v1.workflows.get_ai_provider", lambda **_kwargs: _Provider())
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.analyze_workflow",
        _analyze_fail,
    )
    monkeypatch.setattr("services.workflow_simplifier.WorkflowSimplifier.simplify", _simplify_fail)

    resp = await api_client.post(
        "/v1/workflows/record",
        headers=HEADERS,
        json={
            "name": "fallback",
            "events": [{"event_type": "click", "payload": {"target": {"selector": "#a"}}}],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["step_count"] == 1
    assert body["analysis"]["goal"] is None
    # New observability fields surface the simplification failure to the client
    assert body["simplification_status"] == "failed"
    assert body["simplification_error"] == "simplify fail"


@pytest.mark.asyncio
async def test_get_workflow_includes_analysis_payload(api_client, monkeypatch):
    workflow_id = await _create_active_workflow(api_client, name="analysis-payload")

    async def _analysis(_self, _workflow_id):
        return types.SimpleNamespace(
            workflow_goal="Collect data",
            workflow_summary="summary",
            domain_context="jobs",
            confidence_overall=0.8,
            replay_strategy="goal_first",
            is_user_edited=False,
            ambiguity_notes=["none"],
        )

    async def _phases(_self, _workflow_id):
        return [
            types.SimpleNamespace(
                phase_index=0,
                phase_name="Search",
                phase_goal="open page",
                start_step_index=0,
                end_step_index=1,
            )
        ]

    async def _params(_self, _workflow_id):
        return [
            types.SimpleNamespace(
                parameter_key="q",
                parameter_type="string",
                default_value="engineer",
                description="query",
                confidence=0.9,
                is_required=True,
            )
        ]

    async def _output_spec(_self, _workflow_id):
        return types.SimpleNamespace(
            output_type="list",
            output_schema={"items": {"title": "x"}},
            schema_confidence=0.7,
        )

    async def _template(_self, _workflow_id):
        return types.SimpleNamespace(template_version=3)

    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.get_analysis", _analysis
    )
    monkeypatch.setattr("services.semantic_analysis_service.SemanticAnalysisService.get_phases", _phases)
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.get_parameters", _params
    )
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.get_output_spec", _output_spec
    )
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.get_template", _template
    )

    resp = await api_client.get(f"/v1/workflows/{workflow_id}", headers=HEADERS)
    assert resp.status_code == 200
    analysis = resp.json()["analysis"]
    assert analysis["workflow_goal"] == "Collect data"
    assert analysis["parameters"][0]["key"] == "q"
    assert analysis["template_version"] == 3


@pytest.mark.asyncio
async def test_generate_prompt_paths(api_client, monkeypatch):
    wf_id = await _create_active_workflow(api_client, name="prompt")

    class _Provider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(content="Short summary")

    monkeypatch.setattr("api.v1.workflows.get_ai_provider", lambda **_kwargs: _Provider())

    ai_resp = await api_client.post(
        f"/v1/workflows/{wf_id}/generate-prompt",
        headers={**HEADERS, "X-AI-API-Key": "local-key"},
    )
    assert ai_resp.status_code == 200
    assert ai_resp.json()["generated"] is True

    class _BrokenProvider:
        async def generate(self, *_args, **_kwargs):
            raise RuntimeError("boom")

    monkeypatch.setattr("api.v1.workflows.get_ai_provider", lambda **_kwargs: _BrokenProvider())
    fallback_ai = await api_client.post(
        f"/v1/workflows/{wf_id}/generate-prompt",
        headers={**HEADERS, "X-AI-API-Key": "local-key"},
    )
    assert fallback_ai.status_code == 200
    assert fallback_ai.json()["generated"] is False

    old_key = settings.ai_api_key
    settings.ai_api_key = ""
    no_ai = await api_client.post(f"/v1/workflows/{wf_id}/generate-prompt", headers=HEADERS)
    settings.ai_api_key = old_key
    assert no_ai.status_code == 200
    assert no_ai.json()["generated"] is False

    missing = await api_client.post(
        f"/v1/workflows/{uuid.uuid4()}/generate-prompt",
        headers=HEADERS,
    )
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_run_and_run_with_params_branches(api_client, monkeypatch):
    empty_active = await _create_active_workflow(api_client, name="empty", with_step=False)
    empty_resp = await api_client.post(f"/v1/workflows/{empty_active}/run", headers=HEADERS)
    assert empty_resp.status_code == 400

    draft = await api_client.post("/v1/workflows", headers=HEADERS, json={"name": "draft"})
    draft_id = draft.json()["id"]
    await api_client.post(
        f"/v1/workflows/{draft_id}/steps",
        headers=HEADERS,
        json={
            "step_index": 0,
            "action_type": "click",
            "selector_chain": [{"type": "css", "value": "#x"}],
        },
    )
    invalid_status = await api_client.post(f"/v1/workflows/{draft_id}/run", headers=HEADERS)
    assert invalid_status.status_code == 409

    async def _nf_create(*_args, **_kwargs):
        raise NotFoundError("missing")

    monkeypatch.setattr("services.execution_service.ExecutionService.create_run", _nf_create)
    not_found_run = await api_client.post(f"/v1/workflows/{draft_id}/run", headers=HEADERS)
    assert not_found_run.status_code == 409

    wf_id = await _create_active_workflow(api_client, name="params")

    async def _confirmation(*_args, **_kwargs):
        return {
            "mode": "confirmation_required",
            "reason": "goal required",
            "ambiguity_notes": ["ambiguous"],
            "questions": ["What exactly do you want?"],
        }

    monkeypatch.setattr("services.template_service.TemplateService.build_execution_plan", _confirmation)
    goal_required = await api_client.post(
        f"/v1/workflows/{wf_id}/run-with-params",
        headers=HEADERS,
        json={"runtime_params": {}, "execution_goal": "get first 10 rows"},
    )
    assert goal_required.status_code == 409
    assert goal_required.json()["error"]["code"] == "GOAL_REQUIRED"

    async def _plan(*_args, **_kwargs):
        return {"mode": "execute", "goal": "x", "steps": [{"action_type": "click"}]}

    monkeypatch.setattr("services.template_service.TemplateService.build_execution_plan", _plan)

    async def _nf_create_params(*_args, **_kwargs):
        raise NotFoundError("missing")

    monkeypatch.setattr("services.execution_service.ExecutionService.create_run", _nf_create_params)
    nf_params = await api_client.post(
        f"/v1/workflows/{wf_id}/run-with-params",
        headers=HEADERS,
        json={"runtime_params": {}},
    )
    assert nf_params.status_code == 404


@pytest.mark.asyncio
async def test_workflow_blueprint_analysis_and_not_found(api_client, db_session):
    wf_id = await _create_active_workflow(api_client, name="blueprint")
    await api_client.post(
        f"/v1/workflows/{wf_id}/steps",
        headers=HEADERS,
        json={
            "step_index": 1,
            "action_type": "navigate",
            "value": "https://site.local/jobs#x",
            "selector_chain": [],
        },
    )
    await api_client.post(
        f"/v1/workflows/{wf_id}/steps",
        headers=HEADERS,
        json={
            "step_index": 2,
            "action_type": "navigate",
            "value": "https://site.local/jobs#y",
            "selector_chain": [],
        },
    )
    result = await db_session.execute(
        WorkflowStep.__table__.select().where(WorkflowStep.workflow_id == wf_id).order_by(WorkflowStep.step_index)
    )
    step_ids = [row.id for row in result.fetchall()]
    for idx, sid in enumerate(step_ids):
        obj = await db_session.get(WorkflowStep, sid)
        assert obj is not None
        obj.selector_stability_score = [None, 0.9, 0.4][idx]
    await db_session.flush()

    analysis = await api_client.get(f"/v1/workflows/{wf_id}/analyze", headers=HEADERS)
    assert analysis.status_code == 200
    data = analysis.json()
    assert data["high_risk_steps"] >= 1
    assert data["redundant_steps"] >= 1
    assert data["estimated_completion_probability"] <= 1.0

    missing = await api_client.get(f"/v1/workflows/{uuid.uuid4()}/analyze", headers=HEADERS)
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_runs_testing_overrides_and_listing(api_client, monkeypatch):
    settings.debug = False
    inject_off = await api_client.post(
        "/v1/runs/testing/inject-heal-override",
        headers=HEADERS,
        json={"run_id": "__all__", "response": {"new_selectors": []}},
    )
    assert inject_off.status_code == 404

    clear_off = await api_client.post("/v1/runs/testing/clear-heal-overrides", headers=HEADERS)
    assert clear_off.status_code == 404

    settings.debug = True
    inject_on = await api_client.post(
        "/v1/runs/testing/inject-heal-override",
        headers=HEADERS,
        json={"run_id": "__all__", "response": {"new_selectors": [{"type": "css", "value": "#x"}]}},
    )
    assert inject_on.status_code == 200
    clear_on = await api_client.post("/v1/runs/testing/clear-heal-overrides", headers=HEADERS)
    assert clear_on.status_code == 200

    _, run_id = await _create_running_run(api_client)
    listed = await api_client.get("/v1/runs", headers=HEADERS)
    assert listed.status_code == 200
    assert any(r["id"] == run_id for r in listed.json())

    detail = await api_client.get(f"/v1/runs/{run_id}", headers=HEADERS)
    assert detail.status_code == 200
    assert detail.json()["id"] == run_id

    settings.debug = False


@pytest.mark.asyncio
async def test_runs_next_step_checkpoint_and_step_result_paths(api_client, db_session, monkeypatch):
    _, run_id = await _create_running_run(api_client)

    next_step = await api_client.post(f"/v1/runs/{run_id}/next-step", headers=HEADERS)
    assert next_step.status_code == 200
    assert next_step.json()["step_index"] == 0

    checkpoint = await api_client.post(
        f"/v1/runs/{run_id}/checkpoint",
        headers=HEADERS,
        json={"step_index": 0, "snapshot": {"url": "https://example.com"}},
    )
    assert checkpoint.status_code == 200

    mismatch = await api_client.post(
        f"/v1/runs/{run_id}/step-result",
        headers=HEADERS,
        json={"step_index": 1, "success": True, "action_type": "click"},
    )
    assert mismatch.status_code == 409
    assert mismatch.json()["error"]["code"] == "STEP_INDEX_MISMATCH"

    ok = await api_client.post(
        f"/v1/runs/{run_id}/step-result",
        headers=HEADERS,
        json={
            "step_index": 0,
            "action_type": "click",
            "success": True,
            "screenshot_ref": "s3://test/ref",
            "actual_url": "https://example.com",
        },
    )
    assert ok.status_code == 200
    assert ok.json()["current_step_index"] == 1

    run = await db_session.get(ExecutionRun, uuid.UUID(run_id))
    assert run is not None
    run.current_step_index = 0
    run.status = RunStatus.RUNNING.value
    await db_session.flush()

    async def _raise_store(*_args, **_kwargs):
        raise RuntimeError("store failed")

    monkeypatch.setattr("services.artifact_service.ArtifactService.store_artifact", _raise_store)
    failed_store = await api_client.post(
        f"/v1/runs/{run_id}/step-result",
        headers=HEADERS,
        json={"step_index": 0, "action_type": "click", "success": False, "error": "boom", "screenshot_ref": "x"},
    )
    assert failed_store.status_code == 200
    assert failed_store.json()["status"] == "failed"

    run = await db_session.get(ExecutionRun, uuid.UUID(run_id))
    assert run is not None
    run.current_step_index = run.total_steps
    run.status = RunStatus.RUNNING.value
    await db_session.flush()
    done = await api_client.post(f"/v1/runs/{run_id}/next-step", headers=HEADERS)
    assert done.status_code == 409
    assert done.json()["error"]["message"] == "All steps completed"


@pytest.mark.asyncio
async def test_runs_heal_and_intervention_and_extraction_paths(api_client, monkeypatch):
    _, run_id = await _create_running_run(api_client)
    settings.debug = True
    await api_client.post(
        "/v1/runs/testing/inject-heal-override",
        headers=HEADERS,
        json={
            "run_id": run_id,
            "response": {
                "new_selectors": [{"type": "css", "value": "#new"}],
                "confidence": 0.92,
                "explanation": "good",
            },
        },
    )
    override = await api_client.post(
        f"/v1/runs/{run_id}/heal-step",
        headers=HEADERS,
        json={"step_index": 0, "dom_snippet": "<div/>", "old_selectors": ["#old"]},
    )
    assert override.status_code == 200
    assert override.json()["confidence"] == 0.92
    settings.debug = False

    async def _low_confidence(*_args, **_kwargs):
        return {"below_threshold": True, "confidence": 0.1}

    monkeypatch.setattr("services.healing_service.HealingService.suggest_heal", _low_confidence)
    low = await api_client.post(
        f"/v1/runs/{run_id}/heal-step",
        headers=HEADERS,
        json={"step_index": 0, "dom_snippet": "<div/>", "old_selectors": ["#old"]},
    )
    assert low.status_code == 409
    assert low.json()["error"]["code"] == "LOW_CONFIDENCE"

    async def _heal_ok(*_args, **_kwargs):
        return types.SimpleNamespace(id=uuid.UUID(run_id), status="running", current_step_index=0)

    monkeypatch.setattr("services.healing_service.HealingService.heal_succeeded", _heal_ok)
    success = await api_client.post(
        f"/v1/runs/{run_id}/heal-result",
        headers=HEADERS,
        json={"step_index": 0, "success": True, "new_selectors": [{"type": "css", "value": "#new"}]},
    )
    assert success.status_code == 200

    async def _state(*_args, **_kwargs):
        raise StateTransitionError("bad heal")

    monkeypatch.setattr("services.healing_service.HealingService.heal_failed", _state)
    state = await api_client.post(
        f"/v1/runs/{run_id}/heal-result",
        headers=HEADERS,
        json={"step_index": 0, "success": False, "error": "x"},
    )
    assert state.status_code == 409

    first = await api_client.post(
        "/v1/runs/interventions",
        headers=HEADERS,
        json={"run_id": run_id, "trigger_reason": "captcha"},
    )
    second = await api_client.post(
        "/v1/runs/interventions",
        headers=HEADERS,
        json={"run_id": run_id, "trigger_reason": "captcha"},
    )
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]

    extraction = await api_client.post(
        f"/v1/runs/{run_id}/extraction",
        headers=HEADERS,
        json={"step_index": 0, "data": [{"title": "x"}], "schema": {"type": "array"}, "url": "https://x"},
    )
    assert extraction.status_code == 200
    assert extraction.json()["records"] == 1


@pytest.mark.asyncio
async def test_delete_all_runs_endpoint(api_client):
    await _create_running_run(api_client)
    deleted = await api_client.delete("/v1/runs", headers=HEADERS)
    assert deleted.status_code == 200
    payload = deleted.json()["deleted"]
    assert "runs" in payload
    assert "events" in payload
