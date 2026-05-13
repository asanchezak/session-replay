"""Pins B-C-16 — idempotency key is scoped to run_id, so the same key on two
different runs both succeed. The standard semantic is that an idempotency key
uniquely identifies a *request*.
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


async def _seed_two_runs(api_client):
    wfr = await api_client.post("/v1/workflows", json={"name": "x"}, headers=_HEADERS)
    wf_id = wfr.json()["id"]
    r1 = (await api_client.post("/v1/runs", json={"workflow_id": wf_id}, headers=_HEADERS)).json()["id"]
    r2 = (await api_client.post("/v1/runs", json={"workflow_id": wf_id}, headers=_HEADERS)).json()["id"]
    return r1, r2


@pytest.mark.asyncio
async def test_idempotency_within_run_returns_same_event(api_client):
    r1, _ = await _seed_two_runs(api_client)
    payload = {
        "event_type": "click",
        "payload": {"i": 1},
        "run_id": r1,
        "idempotency_key": "abc-123",
    }
    a = await api_client.post("/v1/events/record", json=payload, headers=_HEADERS)
    b = await api_client.post("/v1/events/record", json=payload, headers=_HEADERS)
    assert a.status_code == 200
    assert b.status_code == 200
    assert a.json()["id"] == b.json()["id"], "Same key within run must return same event"


@pytest.mark.asyncio
async def test_idempotency_across_runs_is_rejected(api_client):
    r1, r2 = await _seed_two_runs(api_client)
    payload_a = {
        "event_type": "click",
        "payload": {"i": 1},
        "run_id": r1,
        "idempotency_key": "shared-key-xyz",
    }
    payload_b = {**payload_a, "run_id": r2}

    a = await api_client.post("/v1/events/record", json=payload_a, headers=_HEADERS)
    b = await api_client.post("/v1/events/record", json=payload_b, headers=_HEADERS)
    assert a.status_code == 200
    assert b.status_code == 409
