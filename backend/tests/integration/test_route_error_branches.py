from __future__ import annotations

import types
import uuid

import pytest

from core.exceptions import NotFoundError, StateTransitionError

HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_runs_create_and_get_not_found(api_client, monkeypatch):
    async def _missing_create(self, workflow_id, user_id=None):  # noqa: ARG001
        raise NotFoundError("missing")

    async def _missing_get(self, run_id):  # noqa: ARG001
        raise NotFoundError("missing")

    monkeypatch.setattr("services.execution_service.ExecutionService.create_run", _missing_create)
    monkeypatch.setattr("services.execution_service.ExecutionService.get_run", _missing_get)

    create = await api_client.post(
        "/v1/runs",
        headers=HEADERS,
        json={"workflow_id": str(uuid.uuid4())},
    )
    assert create.status_code == 404
    assert create.json()["error"]["code"] == "NOT_FOUND"

    get_resp = await api_client.get(f"/v1/runs/{uuid.uuid4()}", headers=HEADERS)
    assert get_resp.status_code == 404
    assert get_resp.json()["error"]["code"] == "NOT_FOUND"


@pytest.mark.asyncio
async def test_runs_transition_errors(api_client, monkeypatch):
    async def _state_error(*_args, **_kwargs):
        raise StateTransitionError("bad transition")

    monkeypatch.setattr("services.execution_service.ExecutionService.pause", _state_error)
    monkeypatch.setattr("services.execution_service.ExecutionService.resume", _state_error)
    monkeypatch.setattr("services.execution_service.ExecutionService.fail", _state_error)
    monkeypatch.setattr("services.execution_service.ExecutionService.complete", _state_error)
    monkeypatch.setattr("services.execution_service.ExecutionService.advance_step", _state_error)

    run_id = str(uuid.uuid4())
    pause = await api_client.post(f"/v1/runs/{run_id}/pause", headers=HEADERS, json={"reason": "x"})
    resume = await api_client.post(f"/v1/runs/{run_id}/resume", headers=HEADERS)
    fail = await api_client.post(f"/v1/runs/{run_id}/fail", headers=HEADERS, json={"error": "x"})
    complete = await api_client.post(f"/v1/runs/{run_id}/complete", headers=HEADERS)
    advance = await api_client.post(f"/v1/runs/{run_id}/advance_step", headers=HEADERS)

    for resp in (pause, resume, fail, complete, advance):
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "STATE_ERROR"


@pytest.mark.asyncio
async def test_cancel_run_validation_and_internal_errors(api_client, monkeypatch):
    run_id = str(uuid.uuid4())

    async def _validation(*_args, **_kwargs):
        raise ValueError("bad cancel request")

    monkeypatch.setattr("services.execution_service.ExecutionService.cancel", _validation)
    bad = await api_client.post(f"/v1/runs/{run_id}/cancel", headers=HEADERS)
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "VALIDATION_ERROR"

    async def _crash(*_args, **_kwargs):
        raise RuntimeError("cancel crash")

    async def _get(*_args, **_kwargs):
        return types.SimpleNamespace(status="running")

    monkeypatch.setattr("services.execution_service.ExecutionService.cancel", _crash)
    monkeypatch.setattr("services.execution_service.ExecutionService.get_run", _get)
    failed = await api_client.post(f"/v1/runs/{run_id}/cancel", headers=HEADERS)
    assert failed.status_code == 500
    assert failed.json()["error"]["code"] == "INTERNAL_ERROR"
    assert failed.json()["error"]["details"]["current_status"] == "running"


@pytest.mark.asyncio
async def test_events_and_next_step_error_paths(api_client, monkeypatch):
    async def _present(_self, _run_id):
        return types.SimpleNamespace(
            status="queued",
            workflow_snapshot={"steps": []},
            current_step_index=0,
        )

    monkeypatch.setattr("services.execution_service.ExecutionService.get_run", _present)
    events = await api_client.get(f"/v1/runs/{uuid.uuid4()}/events", headers=HEADERS)
    assert events.status_code == 200

    invalid_uuid = await api_client.get("/v1/runs/not-a-uuid/events", headers=HEADERS)
    assert invalid_uuid.status_code == 404

    next_step = await api_client.post(f"/v1/runs/{uuid.uuid4()}/next-step", headers=HEADERS)
    assert next_step.status_code == 409
    assert next_step.json()["error"]["code"] == "STATE_ERROR"


@pytest.mark.asyncio
async def test_runs_healing_error_paths(api_client, monkeypatch):
    run_id = str(uuid.uuid4())

    async def _missing_get(_self, _run_id, *args, **kwargs):  # noqa: ARG001
        raise NotFoundError("missing")

    monkeypatch.setattr("services.execution_service.ExecutionService.get_run", _missing_get)
    extraction_nf = await api_client.post(
        f"/v1/runs/{run_id}/extraction",
        headers=HEADERS,
        json={"step_index": 0, "data": []},
    )
    assert extraction_nf.status_code == 404

    monkeypatch.setattr("services.healing_service.HealingService.recover", _missing_get)
    recover_nf = await api_client.post(f"/v1/runs/{run_id}/recover", headers=HEADERS, json={})
    assert recover_nf.status_code == 404

    async def _state_recover(*_args, **_kwargs):
        raise StateTransitionError("bad state")

    monkeypatch.setattr("services.healing_service.HealingService.recover", _state_recover)
    recover_state = await api_client.post(f"/v1/runs/{run_id}/recover", headers=HEADERS, json={})
    assert recover_state.status_code == 409


@pytest.mark.asyncio
async def test_workflow_branch_errors(api_client, monkeypatch):
    wf_id = str(uuid.uuid4())

    async def _missing_wf(_self, workflow_id):  # noqa: ARG001
        raise NotFoundError("missing")

    monkeypatch.setattr("services.workflow_service.WorkflowService.get", _missing_wf)

    for method, path, body in [
        ("GET", f"/v1/workflows/{wf_id}", None),
        ("PUT", f"/v1/workflows/{wf_id}", {"name": "x"}),
        ("PUT", f"/v1/workflows/{wf_id}/steps", []),
        ("POST", f"/v1/workflows/{wf_id}/steps", {"step_index": 0, "action_type": "click"}),
        ("POST", f"/v1/workflows/{wf_id}/run", None),
        ("POST", f"/v1/workflows/{wf_id}/run-with-params", {"runtime_params": {}}),
        ("GET", f"/v1/workflows/{wf_id}/analyze", None),
    ]:
        resp = await api_client.request(method, path, headers=HEADERS, json=body)
        assert resp.status_code == 404


@pytest.mark.asyncio
async def test_workflow_update_status_invalid_and_transition_error(api_client, monkeypatch):
    wf = await api_client.post("/v1/workflows", headers=HEADERS, json={"name": "status wf"})
    wf_id = wf.json()["id"]

    invalid = await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        headers=HEADERS,
        json={"status": "invalid"},
    )
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "VALIDATION_ERROR"

    async def _state_error(*_args, **_kwargs):
        raise StateTransitionError("nope")

    monkeypatch.setattr("services.workflow_service.WorkflowService.update_status", _state_error)
    conflict = await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        headers=HEADERS,
        json={"status": "archived"},
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "INVALID_TRANSITION"
