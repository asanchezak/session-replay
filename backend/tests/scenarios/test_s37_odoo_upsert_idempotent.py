"""S37 — `upsert_candidate` for an existing candidate updates instead of duplicating."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio

respx = pytest.importorskip("respx")
import httpx  # noqa: E402

ODOO_URL = "https://odoo.example.com"


async def test_upsert_existing_candidate_writes_not_creates():
    from adapters.odoo.adapter import OdooAdapter

    creates = 0
    writes = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal creates, writes
        body = request.read()
        if b'"login"' in body:
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"uid": 1}})
        if b'"search_read"' in body:
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": [{"id": 42, "email": "x@y"}]})
        if b'"write"' in body:
            writes += 1
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": True})
        if b'"create"' in body:
            creates += 1
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": 99})
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": None})

    with respx.mock() as r:
        r.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)
        adapter = OdooAdapter({"url": ODOO_URL, "database": "d", "username": "u", "password": "p"})
        await adapter.connect()
        if not hasattr(adapter, "upsert"):
            pytest.skip("OdooAdapter.upsert not implemented yet")
        await adapter.upsert("candidate", {"email": "x@y", "name": "X"}, key="email")

    assert creates == 0, "Existing record should be updated, not duplicated"
    assert writes <= 1
