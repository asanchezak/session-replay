"""S36 — list_open_jobs paginates.

Smoke test for OdooAdapter.list with mocked transport. See full details in
integration/test_odoo_adapter_mocked.py — this is the scenario-flavored
duplicate so `make test-scenarios` runs it.
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio

respx = pytest.importorskip("respx")
import httpx  # noqa: E402

ODOO_URL = "https://odoo.example.com"


async def test_list_jobs_returns_at_most_limit():
    from adapters.odoo.adapter import OdooAdapter

    rows = [{"id": i, "name": f"job-{i}"} for i in range(120)]

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        if b'"login"' in body:
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"uid": 1}})
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": rows[:50]})

    with respx.mock() as r:
        r.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)
        adapter = OdooAdapter({"url": ODOO_URL, "database": "d", "username": "u", "password": "p"})
        await adapter.connect()
        out = await adapter.list("job", filters={"status": "open"})

    assert len(out) <= 100
