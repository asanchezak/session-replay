from __future__ import annotations

import uuid
from datetime import UTC, datetime

import fsspec
import pytest

from adapters.base import ConnectorHealth
from core.models.ai_decision_outcome import AIDecisionOutcome
from core.models.connector import ConnectorConfig
from core.models.run import ExecutionRun
from core.models.workflow import Workflow
from services.agent_models import PollResponse, ResultResponse

HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.fixture(autouse=True)
def _storage_tmp(monkeypatch, tmp_path):
    def _fake_init(self):
        self.fs = fsspec.filesystem("file")
        self.base_path = str(tmp_path)

    monkeypatch.setattr("services.storage_service.StorageService.__init__", _fake_init)


async def _create_run(db_session) -> str:
    wf = Workflow(name="Aux Endpoint WF", status="active")
    db_session.add(wf)
    await db_session.flush()
    run = ExecutionRun(
        workflow_id=str(wf.id),
        status="running",
        total_steps=1,
        current_step_index=0,
    )
    db_session.add(run)
    await db_session.flush()
    return str(run.id)


@pytest.mark.asyncio
async def test_artifacts_upload_list_metadata_download_delete(api_client, db_session):
    run_id = await _create_run(db_session)

    upload = await api_client.post(
        f"/v1/runs/{run_id}/artifacts?step_index=0&artifact_type=screenshot",
        headers=HEADERS,
        files={"file": ("shot.txt", b"hello-artifact", "text/plain")},
    )
    assert upload.status_code == 200, upload.text
    artifact_id = upload.json()["id"]

    listed = await api_client.get(f"/v1/runs/{run_id}/artifacts", headers=HEADERS)
    assert listed.status_code == 200
    assert any(a["id"] == artifact_id for a in listed.json())

    metadata = await api_client.get(f"/v1/artifacts/{artifact_id}/metadata", headers=HEADERS)
    assert metadata.status_code == 200
    assert metadata.json()["mime_type"] == "text/plain"

    content = await api_client.get(f"/v1/artifacts/{artifact_id}", headers=HEADERS)
    assert content.status_code == 200
    assert content.content == b"hello-artifact"

    deleted = await api_client.delete(f"/v1/artifacts/{artifact_id}", headers=HEADERS)
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is True

    not_found = await api_client.get(f"/v1/artifacts/{artifact_id}/metadata", headers=HEADERS)
    assert not_found.status_code == 404


@pytest.mark.asyncio
async def test_artifacts_upload_requires_file(api_client):
    run_id = str(uuid.uuid4())
    response = await api_client.post(f"/v1/runs/{run_id}/artifacts", headers=HEADERS)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_REQUEST"


@pytest.mark.asyncio
async def test_settings_get_and_update(api_client):
    current = await api_client.get("/v1/settings", headers=HEADERS)
    assert current.status_code == 200
    assert "retention_days" in current.json()["settings"]

    updated = await api_client.put(
        "/v1/settings",
        headers=HEADERS,
        json={"retention_days": 45, "auto_retry_limit": 7},
    )
    assert updated.status_code == 200
    body = updated.json()["settings"]
    assert body["retention_days"] == 45
    assert body["auto_retry_limit"] == 7


@pytest.mark.asyncio
async def test_client_logs_endpoint(api_client):
    resp = await api_client.post(
        "/v1/logs/client",
        headers=HEADERS,
        json={"component": "Dashboard", "action": "load", "level": "warn", "status": "failure"},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


@pytest.mark.asyncio
async def test_connectors_crud_and_test(api_client, monkeypatch):
    create = await api_client.post(
        "/v1/connectors",
        headers=HEADERS,
        json={"type": "odoo", "name": "Test Odoo", "config": {"url": "http://x"}},
    )
    assert create.status_code == 200
    connector_id = create.json()["id"]

    listed = await api_client.get("/v1/connectors", headers=HEADERS)
    assert listed.status_code == 200
    assert any(c["id"] == connector_id for c in listed.json())

    detail = await api_client.get(f"/v1/connectors/{connector_id}", headers=HEADERS)
    assert detail.status_code == 200
    assert detail.json()["name"] == "Test Odoo"

    class _FakeAdapter:
        async def initialize(self, _config):
            return None

        async def health_check(self):
            return ConnectorHealth(status="healthy", latency_ms=12, last_error=None)

        async def dispose(self):
            return None

    monkeypatch.setattr("api.v1.connectors.get_adapter", lambda _name: _FakeAdapter)
    tested = await api_client.post(f"/v1/connectors/{connector_id}/test", headers=HEADERS)
    assert tested.status_code == 200
    assert tested.json()["healthy"] is True

    deleted = await api_client.delete(f"/v1/connectors/{connector_id}", headers=HEADERS)
    assert deleted.status_code == 200
    assert deleted.json()["status"] == "deleted"


@pytest.mark.asyncio
async def test_connectors_not_found_and_unknown_adapter(api_client, db_session):
    bad = await api_client.get("/v1/connectors/not-a-uuid", headers=HEADERS)
    assert bad.status_code == 404

    unknown = ConnectorConfig(name="Unknown", connector_type="mystery", config={})
    db_session.add(unknown)
    await db_session.flush()

    tested = await api_client.post(f"/v1/connectors/{unknown.id}/test", headers=HEADERS)
    assert tested.status_code == 200
    assert tested.json()["status"] == "error"


@pytest.mark.asyncio
async def test_integrations_endpoints_success_and_errors(api_client, db_session, monkeypatch):
    connector = ConnectorConfig(name="Forum Connector", connector_type="odoo", config={})
    db_session.add(connector)
    await db_session.flush()

    class _ListAdapter:
        async def list(self, *_args, **_kwargs):
            return [{"id": 1}]

        async def dispose(self):
            return None

    async def _fake_build(_self, _connector):
        return _ListAdapter()

    monkeypatch.setattr(
        "services.connector_forum_service.ConnectorForumService._build_adapter",
        _fake_build,
    )

    ok_sync = await api_client.post(
        "/v1/integrations/odoo/sync",
        headers=HEADERS,
        json={"connector_id": str(connector.id), "action": "job", "params": {}},
    )
    assert ok_sync.status_code == 200
    assert ok_sync.json()["status"] == "ok"
    assert ok_sync.json()["count"] == 1

    not_found = await api_client.post(
        "/v1/integrations/odoo/sync",
        headers=HEADERS,
        json={"connector_id": str(uuid.uuid4()), "action": "job", "params": {}},
    )
    assert not_found.status_code == 404

    async def _fake_sync_profiles(_self, *_args, **_kwargs):
        return {"imported_count": 2}

    async def _fake_send_messages(_self, *_args, **_kwargs):
        return {"sent_count": 3}

    monkeypatch.setattr(
        "services.connector_forum_service.ConnectorForumService.sync_profiles",
        _fake_sync_profiles,
    )
    monkeypatch.setattr(
        "services.connector_forum_service.ConnectorForumService.send_messages",
        _fake_send_messages,
    )

    profiles = await api_client.post(
        f"/v1/integrations/connectors/{connector.id}/forum/sync-profiles",
        headers=HEADERS,
        json={
            "forum_base_url": "http://forum.local",
            "candidate_limit": 2,
            "candidate_filters": {},
        },
    )
    assert profiles.status_code == 200
    assert profiles.json()["imported_count"] == 2

    messages = await api_client.post(
        f"/v1/integrations/connectors/{connector.id}/forum/send-messages",
        headers=HEADERS,
        json={"forum_base_url": "http://forum.local", "candidate_limit": 5},
    )
    assert messages.status_code == 200
    assert messages.json()["sent_count"] == 3

    async def _raise_value_error(_self, *_args, **_kwargs):
        raise ValueError("bad input")

    monkeypatch.setattr(
        "services.connector_forum_service.ConnectorForumService.send_messages",
        _raise_value_error,
    )
    bad_req = await api_client.post(
        f"/v1/integrations/connectors/{connector.id}/forum/send-messages",
        headers=HEADERS,
        json={"forum_base_url": "http://forum.local", "candidate_limit": 5},
    )
    assert bad_req.status_code == 400


@pytest.mark.asyncio
async def test_agent_routes_success_and_error_paths(api_client, db_session, monkeypatch):
    run_id = await _create_run(db_session)

    async def _fake_poll(_self, _run_id, _req):
        return PollResponse(
            decision="EXECUTE",
            confidence=0.9,
            reasoning="ok",
            command={
                "action": "click",
                "target": None,
                "value": None,
                "selector_chain": [],
                "intent": None,
                "methods": [],
                "timeout_ms": 1000,
                "success_condition": None,
            },
            next_step_index=0,
        )

    async def _fake_result(_self, _run_id, _req):
        return ResultResponse(accepted=True, decision=None, next_step_index=1)

    async def _fake_action(_self, _run_id, action):
        return {"accepted": True, "pending_action": action}

    async def _fake_decisions(_self, _run_id, limit=100):
        return [{"payload": {"decision": "EXECUTE"}, "id": "1"}][:limit]

    monkeypatch.setattr("services.agent_service.AgentService.poll", _fake_poll)
    monkeypatch.setattr("services.agent_service.AgentService.report_result", _fake_result)
    monkeypatch.setattr("services.agent_service.AgentService.push_action", _fake_action)
    monkeypatch.setattr("services.agent_service.AgentService.get_decisions", _fake_decisions)

    poll = await api_client.post(
        f"/v1/agent/{run_id}/poll",
        headers=HEADERS,
        json={
            "page_context": {
                "url": "https://example.com",
                "title": "T",
                "dom_snippet": "",
                "accessibility_tree": "",
                "visible_text": "",
                "visible_elements": [],
                "is_blocking": False,
                "blocking_type": None,
                "page_unchanged": False,
            },
            "current_step_index": 0,
        },
    )
    assert poll.status_code == 200
    assert poll.json()["decision"] == "EXECUTE"

    result = await api_client.post(
        f"/v1/agent/{run_id}/result",
        headers=HEADERS,
        json={"step_index": 0, "success": True, "error": None, "page_context_after": None},
    )
    assert result.status_code == 200
    assert result.json()["accepted"] is True

    action = await api_client.post(
        f"/v1/agent/{run_id}/action",
        headers=HEADERS,
        json={"action": "continue"},
    )
    assert action.status_code == 200
    assert action.json()["accepted"] is True

    decisions = await api_client.get(f"/v1/agent/{run_id}/decisions?limit=1", headers=HEADERS)
    assert decisions.status_code == 200
    assert len(decisions.json()) == 1

    outcome = AIDecisionOutcome(
        run_id=run_id,
        step_index=0,
        decision="EXECUTE",
        confidence=0.8,
        actual_outcome="success",
        latency_ms=10,
        model="test-model",
        prompt_hash="abc",
        reasoning="ok",
        created_at=datetime.now(UTC),
    )
    db_session.add(outcome)
    await db_session.flush()
    outcomes = await api_client.get(f"/v1/agent/{run_id}/outcomes", headers=HEADERS)
    assert outcomes.status_code == 200
    assert len(outcomes.json()) == 1

    not_found_resume = await api_client.post(f"/v1/agent/{uuid.uuid4()}/resume", headers=HEADERS)
    assert not_found_resume.status_code == 404

    async def _boom_poll(_self, _run_id, _req):
        raise RuntimeError("poll boom")

    monkeypatch.setattr("services.agent_service.AgentService.poll", _boom_poll)
    failed = await api_client.post(
        f"/v1/agent/{run_id}/poll",
        headers=HEADERS,
        json={
            "page_context": {
                "url": "https://example.com",
                "title": "T",
                "dom_snippet": "",
                "accessibility_tree": "",
                "visible_text": "",
                "visible_elements": [],
                "is_blocking": False,
                "blocking_type": None,
                "page_unchanged": False,
            },
            "current_step_index": 0,
        },
    )
    assert failed.status_code == 500
    assert failed.json()["error"]["code"] == "AGENT_ERROR"
