"""Every 4xx/5xx response must follow `{error: {code, message, [details]}}`.

This test fan-outs across endpoints with deliberately bad input to exercise
each error path and asserts the shape.
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


def _is_error_shape(body) -> bool:
    return (
        isinstance(body, dict)
        and "error" in body
        and isinstance(body["error"], dict)
        and "code" in body["error"]
        and "message" in body["error"]
    )


@pytest.mark.asyncio
async def test_404_get_workflow_missing(api_client):
    r = await api_client.get("/v1/workflows/00000000-0000-0000-0000-000000000000", headers=_HEADERS)
    assert r.status_code == 404
    assert _is_error_shape(r.json())


@pytest.mark.asyncio
async def test_404_get_run_missing(api_client):
    r = await api_client.get("/v1/runs/00000000-0000-0000-0000-000000000000", headers=_HEADERS)
    assert r.status_code == 404
    assert _is_error_shape(r.json())


@pytest.mark.asyncio
async def test_404_get_event_missing(api_client):
    r = await api_client.get("/v1/events/00000000-0000-0000-0000-000000000000", headers=_HEADERS)
    assert r.status_code == 404
    assert _is_error_shape(r.json())


@pytest.mark.asyncio
async def test_401_missing_api_key(api_client):
    r = await api_client.get("/v1/workflows")  # no header
    assert r.status_code == 401
    assert _is_error_shape(r.json())


@pytest.mark.asyncio
async def test_401_wrong_api_key(api_client):
    r = await api_client.get("/v1/workflows", headers={"X-API-Key": "wrong"})
    assert r.status_code == 401
    assert _is_error_shape(r.json())


@pytest.mark.asyncio
async def test_409_invalid_state_transition(api_client):
    # Create a workflow and run, then try to pause an idle run (illegal: idle is not paused-able).
    wfr = await api_client.post("/v1/workflows", json={"name": "x"}, headers=_HEADERS)
    wf_id = wfr.json()["id"]
    runr = await api_client.post("/v1/runs", json={"workflow_id": wf_id}, headers=_HEADERS)
    run_id = runr.json()["id"]
    # Brand-new run is in "queued" — pause requires RUNNING. Should 409.
    r = await api_client.post(f"/v1/runs/{run_id}/pause", json={"reason": "x"}, headers=_HEADERS)
    assert r.status_code == 409
    assert _is_error_shape(r.json())


@pytest.mark.asyncio
async def test_422_invalid_workflow_status(api_client):
    wfr = await api_client.post("/v1/workflows", json={"name": "x"}, headers=_HEADERS)
    wf_id = wfr.json()["id"]
    r = await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        json={"status": "not-a-real-status"},
        headers=_HEADERS,
    )
    assert r.status_code == 422
    assert _is_error_shape(r.json())


@pytest.mark.asyncio
async def test_422_invalid_event_type(api_client):
    r = await api_client.post(
        "/v1/events/record",
        json={"event_type": "fly", "payload": {}},  # not in VALID_EVENT_TYPES
        headers=_HEADERS,
    )
    assert r.status_code == 422
    assert _is_error_shape(r.json())


@pytest.mark.asyncio
async def test_422_validation_error_normalized_shape(api_client):
    r = await api_client.post(
        "/v1/runs/not-a-real-run-id/pause",
        json={"reason": {"bad": "type"}},
        headers=_HEADERS,
    )
    assert r.status_code == 422
    body = r.json()
    assert _is_error_shape(body)
    assert body["error"]["code"] == "VALIDATION_ERROR"
