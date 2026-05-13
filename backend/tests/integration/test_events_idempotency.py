"""F21 — event ingestion + idempotency at the API boundary.

Repeats some of the cases in `unit/test_idempotency_scope.py` but goes through
the HTTP boundary to catch route-level bugs (e.g., the default run_id of all
zeros at events.py:83).
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


async def _make_run(api_client) -> str:
    wf = (await api_client.post("/v1/workflows", json={"name": "x"}, headers=_HEADERS)).json()
    run = (await api_client.post("/v1/runs", json={"workflow_id": wf["id"]}, headers=_HEADERS)).json()
    return run["id"]


@pytest.mark.asyncio
async def test_same_key_within_run_returns_same_event(api_client):
    run_id = await _make_run(api_client)
    body = {
        "event_type": "click", "payload": {"i": 1},
        "run_id": run_id, "idempotency_key": "k1",
    }
    a = await api_client.post("/v1/events/record", json=body, headers=_HEADERS)
    b = await api_client.post("/v1/events/record", json=body, headers=_HEADERS)
    assert a.json()["id"] == b.json()["id"]


@pytest.mark.asyncio
async def test_record_event_validates_event_type(api_client):
    run_id = await _make_run(api_client)
    r = await api_client.post(
        "/v1/events/record",
        json={"event_type": "fly", "payload": {}, "run_id": run_id},
        headers=_HEADERS,
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_record_event_payload_size_limit(api_client):
    run_id = await _make_run(api_client)
    # 1.5 MB string
    payload = {"big": "x" * (1_500_000)}
    r = await api_client.post(
        "/v1/events/record",
        json={"event_type": "click", "payload": payload, "run_id": run_id},
        headers=_HEADERS,
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_missing_run_id_should_be_rejected(api_client):
    r = await api_client.post(
        "/v1/events/record",
        json={"event_type": "click", "payload": {}},  # no run_id
        headers=_HEADERS,
    )
    assert r.status_code == 422
