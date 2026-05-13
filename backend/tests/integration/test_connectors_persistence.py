"""Pins B-M-12 — connector configs are stored in a module-level dict and
disappear on restart. Also asserts the test endpoint shape.
"""
from __future__ import annotations

import importlib

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_register_connector_appears_in_list(api_client):
    """The backend has no GET /v1/connectors/{id}; only the collection endpoint."""
    body = {"name": "odoo-prod", "type": "odoo", "config": {"url": "https://x"}}
    r = await api_client.post("/v1/connectors", json=body, headers=_HEADERS)
    assert r.status_code in (200, 201)
    cid = r.json()["id"]

    g = await api_client.get("/v1/connectors", headers=_HEADERS)
    assert g.status_code == 200
    assert any(item["id"] == cid for item in g.json())


@pytest.mark.asyncio
async def test_get_by_id_endpoint_exists(api_client):
    body = {"name": "x", "type": "odoo", "config": {}}
    r = await api_client.post("/v1/connectors", json=body, headers=_HEADERS)
    cid = r.json()["id"]
    g = await api_client.get(f"/v1/connectors/{cid}", headers=_HEADERS)
    assert g.status_code == 200


@pytest.mark.asyncio
async def test_register_persists_across_module_reload(api_client):
    body = {"name": "odoo-prod-2", "type": "odoo", "config": {"url": "https://y"}}
    r = await api_client.post("/v1/connectors", json=body, headers=_HEADERS)
    cid = r.json()["id"]

    # Simulate "server restart" by reloading the module backing the in-memory store.
    import api.v1.connectors as conn_mod
    importlib.reload(conn_mod)

    g = await api_client.get("/v1/connectors", headers=_HEADERS)
    assert any(item["id"] == cid for item in g.json()), \
        "Connector should survive a 'restart' (module reload)"


@pytest.mark.asyncio
async def test_test_connection_returns_status_shape(api_client):
    body = {"name": "x", "type": "odoo", "config": {"url": "https://example.invalid"}}
    r = await api_client.post("/v1/connectors", json=body, headers=_HEADERS)
    cid = r.json()["id"]
    t = await api_client.post(f"/v1/connectors/{cid}/test", headers=_HEADERS)
    # The endpoint exists; either 200 or 503. The shape is what matters.
    assert t.status_code in (200, 502, 503)
    body = t.json()
    # Be lenient: either shape is OK, but at least one of "status"/"healthy"/"error" exists.
    assert any(k in body for k in ("status", "healthy", "error"))
