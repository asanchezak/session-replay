from __future__ import annotations

import types
import uuid
from datetime import UTC, datetime
import io

import fsspec
import pytest
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from adapters.base import ConnectorHealth
from api.v1.agent import agent_action, agent_decisions, agent_outcomes, agent_poll, agent_result, agent_resume
from api.v1.ai import ClassifyRequest, ExtractRequest, RecoverySuggestRequest, classify_page, extract_data, suggest_recovery
from api.v1.analysis import (
    UpdateAnalysisRequest,
    UpdateParameterRequest,
    ai_status,
    analyze_workflow,
    get_analysis,
    get_template,
    update_analysis,
    update_parameter,
)
from api.v1.artifacts import delete_artifact, download_artifact, get_artifact_metadata, list_artifacts, upload_artifact
from api.v1.audit import get_audit_trail
from api.v1.connectors import (
    delete_connector,
    get_connector,
    list_connectors,
    register_connector,
    test_connector as connector_test_route,
)
from api.v1.debug import get_logs, ingest_log
from api.v1.events import RecordEventRequest, get_event, record_event
from api.v1.integrations import (
    ForumMessageRequest,
    ForumProfileSyncRequest,
    SyncRequest,
    send_forum_messages_via_connector,
    sync_connector_profiles_to_forum,
    sync_odoo,
)
from api.v1.settings import UpdateSettingsRequest, get_settings, update_settings
from core.models.ai_decision_outcome import AIDecisionOutcome
from core.models.connector import ConnectorConfig
from core.models.run import ExecutionRun
from core.models.workflow import Workflow
from services.agent_models import DecisionType, PollResponse, ResultResponse
from services.execution_service import ExecutionService
from services.workflow_service import WorkflowService


@pytest.fixture(autouse=True)
def _storage_tmp(monkeypatch, tmp_path):
    def _fake_init(self):
        self.fs = fsspec.filesystem("file")
        self.base_path = str(tmp_path)

    monkeypatch.setattr("services.storage_service.StorageService.__init__", _fake_init)


async def _seed_run(db_session: AsyncSession) -> str:
    wf = Workflow(name="seed", status="active")
    db_session.add(wf)
    await db_session.flush()
    run = ExecutionRun(workflow_id=str(wf.id), status="running", total_steps=1, current_step_index=0)
    db_session.add(run)
    await db_session.flush()
    return str(run.id)


@pytest.mark.asyncio
async def test_connectors_integrations_and_settings_routes(db_session: AsyncSession, monkeypatch):
    created = await register_connector(
        types.SimpleNamespace(type="odoo", name="C1", config={"url": "http://x"}),
        db=db_session,
    )
    connector_id = created["id"]
    listed = await list_connectors(db=db_session)
    assert len(listed) >= 1

    detail = await get_connector(connector_id, db=db_session)
    assert detail["id"] == connector_id
    invalid = await get_connector("bad-id", db=db_session)
    assert isinstance(invalid, JSONResponse) and invalid.status_code == 404

    class _Adapter:
        async def initialize(self, _cfg):
            return None

        async def health_check(self):
            return ConnectorHealth(status="healthy", latency_ms=5, last_error=None)

        async def dispose(self):
            return None

    monkeypatch.setattr("api.v1.connectors.get_adapter", lambda _name: _Adapter)
    tested = await connector_test_route(connector_id, db=db_session)
    assert tested["healthy"] is True

    class _BadAdapter:
        async def initialize(self, _cfg):
            raise RuntimeError("down")

        async def health_check(self):  # pragma: no cover - never reached
            return ConnectorHealth(status="error", latency_ms=None, last_error="x")

        async def dispose(self):
            return None

    monkeypatch.setattr("api.v1.connectors.get_adapter", lambda _name: _BadAdapter)
    err = await connector_test_route(connector_id, db=db_session)
    assert err["status"] == "error"

    deleted = await delete_connector(connector_id, db=db_session)
    assert deleted["status"] == "deleted"
    missing_del = await delete_connector(str(uuid.uuid4()), db=db_session)
    assert isinstance(missing_del, JSONResponse)

    unknown = ConnectorConfig(name="Unknown", connector_type="mystery", config={})
    db_session.add(unknown)
    await db_session.flush()
    unknown_test = await connector_test_route(str(unknown.id), db=db_session)
    assert unknown_test["status"] == "error"

    connector = ConnectorConfig(name="Forum", connector_type="odoo", config={})
    db_session.add(connector)
    await db_session.flush()

    class _ListAdapter:
        async def list(self, *_args, **_kwargs):
            return [{"id": 1}]

        async def dispose(self):
            return None

    async def _build_adapter(*_args, **_kwargs):
        return _ListAdapter()

    monkeypatch.setattr("services.connector_forum_service.ConnectorForumService._build_adapter", _build_adapter)
    ok_sync = await sync_odoo(SyncRequest(connector_id=str(connector.id), action="jobs", params={}), db=db_session)
    assert ok_sync["status"] == "ok"

    not_found_sync = await sync_odoo(SyncRequest(connector_id=str(uuid.uuid4()), action="jobs", params={}), db=db_session)
    assert isinstance(not_found_sync, JSONResponse) and not_found_sync.status_code == 404

    async def _boom_build(*_args, **_kwargs):
        raise RuntimeError("sync fail")

    monkeypatch.setattr("services.connector_forum_service.ConnectorForumService._build_adapter", _boom_build)
    sync_err = await sync_odoo(SyncRequest(connector_id=str(connector.id), action="jobs", params={}), db=db_session)
    assert isinstance(sync_err, JSONResponse) and sync_err.status_code == 500

    async def _profiles(*_args, **_kwargs):
        return {"imported_count": 2}

    monkeypatch.setattr("services.connector_forum_service.ConnectorForumService.sync_profiles", _profiles)
    profiles = await sync_connector_profiles_to_forum(
        str(connector.id),
        ForumProfileSyncRequest(forum_base_url="http://forum", candidate_limit=2, candidate_filters={}),
        db=db_session,
    )
    assert profiles["imported_count"] == 2

    async def _profiles_boom(*_args, **_kwargs):
        raise RuntimeError("bad profiles")

    monkeypatch.setattr("services.connector_forum_service.ConnectorForumService.sync_profiles", _profiles_boom)
    prof_err = await sync_connector_profiles_to_forum(
        str(connector.id),
        ForumProfileSyncRequest(forum_base_url="http://forum", candidate_limit=2, candidate_filters={}),
        db=db_session,
    )
    assert isinstance(prof_err, JSONResponse) and prof_err.status_code == 502

    async def _send(*_args, **_kwargs):
        return {"sent_count": 3}

    monkeypatch.setattr("services.connector_forum_service.ConnectorForumService.send_messages", _send)
    sent = await send_forum_messages_via_connector(
        str(connector.id),
        ForumMessageRequest(forum_base_url="http://forum", candidate_limit=5),
        db=db_session,
    )
    assert sent["sent_count"] == 3

    async def _send_bad(*_args, **_kwargs):
        raise ValueError("bad")

    monkeypatch.setattr("services.connector_forum_service.ConnectorForumService.send_messages", _send_bad)
    sent_bad = await send_forum_messages_via_connector(
        str(connector.id),
        ForumMessageRequest(forum_base_url="http://forum", candidate_limit=5),
        db=db_session,
    )
    assert isinstance(sent_bad, JSONResponse) and sent_bad.status_code == 400

    async def _send_err(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr("services.connector_forum_service.ConnectorForumService.send_messages", _send_err)
    sent_err = await send_forum_messages_via_connector(
        str(connector.id),
        ForumMessageRequest(forum_base_url="http://forum", candidate_limit=5),
        db=db_session,
    )
    assert isinstance(sent_err, JSONResponse) and sent_err.status_code == 502

    s0 = await get_settings(db=db_session)
    assert "settings" in s0
    s1 = await update_settings(UpdateSettingsRequest(retention_days=45, auto_retry_limit=9), db=db_session)
    assert s1["settings"]["retention_days"] == 45


@pytest.mark.asyncio
async def test_analysis_ai_agent_events_audit_debug_and_artifacts_routes(db_session: AsyncSession, monkeypatch):
    wf_svc = WorkflowService(db_session)
    wf = await wf_svc.create(name="analysis", target_url="https://example.test")
    await wf_svc.add_step(str(wf.id), 0, "click", selector_chain=[{"type": "css", "value": "#x"}], intent="x")
    wf.status = "active"
    await db_session.flush()
    run_id = await _seed_run(db_session)

    async def _ana(*_args, **_kwargs):
        return types.SimpleNamespace(
            analysis_version=1,
            workflow_goal="goal",
            workflow_summary="sum",
            domain_context="general",
            confidence_overall=0.8,
            ai_model_used="m",
            replay_strategy="semantic",
            is_user_edited=False,
            ambiguity_notes=[],
        )

    async def _phases(*_args, **_kwargs):
        return [types.SimpleNamespace(phase_index=0, phase_name="p", phase_goal="g", start_step_index=0, end_step_index=1)]

    async def _params(*_args, **_kwargs):
        return [types.SimpleNamespace(parameter_key="q", parameter_type="string", default_value="v", inferred_from_step=0, description="d", confidence=0.9, is_required=True, validation_rules={})]

    async def _out(*_args, **_kwargs):
        return types.SimpleNamespace(output_type="list", output_schema={"type": "array"}, schema_confidence=0.7, sample_output=[{"x": 1}])

    async def _tmpl(*_args, **_kwargs):
        return types.SimpleNamespace(template_version=1, template_data={"k": "v"}, is_active=True)

    monkeypatch.setattr("services.semantic_analysis_service.SemanticAnalysisService.analyze_workflow", _ana)
    monkeypatch.setattr("services.semantic_analysis_service.SemanticAnalysisService.get_phases", _phases)
    monkeypatch.setattr("services.semantic_analysis_service.SemanticAnalysisService.get_parameters", _params)
    monkeypatch.setattr("services.semantic_analysis_service.SemanticAnalysisService.get_output_spec", _out)
    monkeypatch.setattr("services.semantic_analysis_service.SemanticAnalysisService.get_template", _tmpl)
    monkeypatch.setattr("services.semantic_analysis_service.SemanticAnalysisService.get_analysis", _ana)
    async def _update_analysis(*_args, **_kwargs):
        return types.SimpleNamespace(is_user_edited=True)

    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.update_analysis",
        _update_analysis,
    )
    async def _update_param(*_args, **_kwargs):
        return None
    monkeypatch.setattr(
        "services.semantic_analysis_service.SemanticAnalysisService.update_parameter",
        _update_param,
    )

    req = types.SimpleNamespace(headers={"X-AI-API-Key": "x"})
    analyzed = await analyze_workflow(str(wf.id), request=req, db=db_session)
    assert analyzed["workflow_goal"] == "goal"
    got = await get_analysis(str(wf.id), db=db_session)
    assert got["workflow_goal"] == "goal"
    updated = await update_analysis(str(wf.id), UpdateAnalysisRequest(workflow_goal="new"), db=db_session)
    assert updated["workflow_id"] == str(wf.id)
    up_param = await update_parameter(str(wf.id), "q", UpdateParameterRequest(default_value="x"), db=db_session)
    assert up_param["updated"] is True
    tmpl = await get_template(str(wf.id), db=db_session)
    assert tmpl["version"] == 1
    status = await ai_status()
    assert "provider" in status

    class _AIProvider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(content='{"selector":"#a","fallback_selectors":["#b"],"confidence":0.9,"explanation":"ok"}', confidence=0.4)

    monkeypatch.setattr("api.v1.ai.get_ai_provider", lambda: _AIProvider())
    rec = await suggest_recovery(RecoverySuggestRequest(dom_snippet="<div/>", old_selectors=["#x"], intent="click"))
    assert rec["confidence"] == 0.9

    class _BadAIProvider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(content="not-json", confidence=0.3)

    monkeypatch.setattr("api.v1.ai.get_ai_provider", lambda: _BadAIProvider())
    bad_rec = await suggest_recovery(RecoverySuggestRequest(dom_snippet="<div/>", old_selectors=["#x"], intent="click"))
    assert bad_rec["new_selectors"] == []

    # Use concrete provider class for classify/extract
    class _TextProvider:
        async def generate(self, *_args, **_kwargs):
            return types.SimpleNamespace(content="ok")

    monkeypatch.setattr("api.v1.ai.get_ai_provider", lambda: _TextProvider())
    assert (await classify_page(ClassifyRequest(page_text="x", visible_elements=[])))["classification"] == "ok"
    assert (await extract_data(ExtractRequest(page_content="x", extraction_schema={})))["data"] == "ok"

    poll_resp = PollResponse(
        decision=DecisionType.EXECUTE,
        confidence=0.8,
        reasoning="ok",
        command={"action": "click", "target": None, "value": None, "selector_chain": [], "intent": None, "methods": [], "timeout_ms": 1000, "success_condition": None},
        next_step_index=0,
    )
    async def _poll(*_args, **_kwargs):
        return poll_resp
    monkeypatch.setattr("services.agent_service.AgentService.poll", _poll)
    poll = await agent_poll(run_id, types.SimpleNamespace(page_context=types.SimpleNamespace(url="u", title="t", dom_snippet="", accessibility_tree="", visible_text="", visible_elements=[], is_blocking=False, blocking_type=None, page_unchanged=False), current_step_index=0), db=db_session)
    assert poll.decision == DecisionType.EXECUTE

    async def _result(*_args, **_kwargs):
        return ResultResponse(accepted=True, decision=None, next_step_index=1)
    monkeypatch.setattr("services.agent_service.AgentService.report_result", _result)
    res = await agent_result(run_id, types.SimpleNamespace(step_index=0, success=True, error=None, page_context_after=None), db=db_session)
    assert res.accepted is True

    async def _action(*_args, **_kwargs):
        return {"accepted": True, "pending_action": "continue"}
    monkeypatch.setattr("services.agent_service.AgentService.push_action", _action)
    act = await agent_action(run_id, types.SimpleNamespace(action="continue"), db=db_session)
    assert act["accepted"] is True

    async def _decisions(*_args, **_kwargs):
        return [{"id": "1"}]
    monkeypatch.setattr("services.agent_service.AgentService.get_decisions", _decisions)
    dec = await agent_decisions(run_id, limit=10, db=db_session)
    assert len(dec) == 1

    outcome = AIDecisionOutcome(
        run_id=run_id,
        step_index=0,
        decision="EXECUTE",
        confidence=0.9,
        actual_outcome="success",
        latency_ms=12,
        model="m",
        prompt_hash="h",
        reasoning="ok",
        created_at=datetime.now(UTC),
    )
    db_session.add(outcome)
    await db_session.flush()
    outcomes = await agent_outcomes(run_id, limit=100, db=db_session)
    assert len(outcomes) == 1

    # call route with missing run id to trigger not-found path
    nf_resume = await agent_resume(str(uuid.uuid4()), db=db_session)
    assert isinstance(nf_resume, JSONResponse)

    log_ok = await ingest_log({"source": "sw", "level": "error", "message": "x"})
    assert log_ok["ok"] is True
    logs = await get_logs(source="sw", since=None, limit=10)
    assert len(logs) >= 1

    ev = await record_event(
        RecordEventRequest(
            event_type="click",
            payload={"x": 1},
            run_id=run_id,
            idempotency_key="k1",
        ),
        db=db_session,
    )
    ev2 = await record_event(
        RecordEventRequest(
            event_type="click",
            payload={"x": 1},
            run_id=run_id,
            idempotency_key="k1",
        ),
        db=db_session,
    )
    assert ev.id == ev2.id
    got_ev = await get_event(ev.id, db=db_session)
    assert got_ev["id"] == ev.id
    bad_ev = await get_event("not-uuid", db=db_session)
    assert isinstance(bad_ev, JSONResponse)

    audit = await get_audit_trail(run_id, db=db_session)
    assert audit["run_id"] == run_id

    upload = await upload_artifact(
        run_id=run_id,
        step_index=0,
        artifact_type="screenshot",
        file=UploadFile(filename="a.txt", file=io.BytesIO(b"x")),
        db=db_session,
    )
    artifact_id = upload["id"]
    listed = await list_artifacts(run_id, db=db_session)
    assert any(a["id"] == artifact_id for a in listed)
    meta = await get_artifact_metadata(artifact_id, db=db_session)
    assert meta["id"] == artifact_id
    blob = await download_artifact(artifact_id, db=db_session)
    assert blob.status_code == 200
    deleted = await delete_artifact(artifact_id, db=db_session)
    assert deleted["deleted"] is True
