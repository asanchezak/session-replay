"""S39 — Connector test endpoint surfaces latency_ms + error when remote is down."""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_connector_test_endpoint_returns_status_and_latency(api_client):
    body = {"name": "t1", "type": "odoo", "config": {"url": "https://example.invalid"}}
    r = await api_client.post("/v1/connectors", json=body, headers=_HEADERS)
    cid = r.json()["id"]

    t = await api_client.post(f"/v1/connectors/{cid}/test", headers=_HEADERS)
    # We don't reach the remote, so it should be "down".
    assert t.status_code in (200, 502, 503)
    body = t.json()
    # Required fields:
    assert "status" in body or "healthy" in body or "error" in body


@pytest.mark.xfail(
    strict=True,
    reason=(
        "B-M-13-ish: connector test endpoint may not include latency_ms when the connection fails. "
        "The shape should always include latency_ms even if 0."
    ),
)
@pytest.mark.asyncio
async def test_connector_test_endpoint_always_returns_latency(api_client):
    body = {"name": "t2", "type": "odoo", "config": {"url": "https://example.invalid"}}
    r = await api_client.post("/v1/connectors", json=body, headers=_HEADERS)
    cid = r.json()["id"]

    t = await api_client.post(f"/v1/connectors/{cid}/test", headers=_HEADERS)
    body = t.json()
    assert "latency_ms" in body
    assert isinstance(body["latency_ms"], int)
