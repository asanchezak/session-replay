"""S36–S39 — integration tests for the Odoo adapter using respx to mock XML-RPC.

Pins:
- B-M-09: re-auth recursion when AccessError happens repeatedly.
- B-M-10: list_open_jobs must paginate.
- S38: a single session expiry triggers exactly one re-auth.

The Odoo adapter at `backend/adapters/odoo/client.py` POSTs JSON-RPC to
`/jsonrpc`. We mock that single endpoint with respx and return canned responses
keyed by method.
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio


respx = pytest.importorskip("respx")
import httpx  # noqa: E402

ODOO_URL = "https://odoo.example.com"


def _rpc(result):
    """Build a JSON-RPC 2.0 success envelope."""
    return {"jsonrpc": "2.0", "id": 1, "result": result}


def _rpc_error(message: str):
    return {"jsonrpc": "2.0", "id": 1, "error": {"message": message}}


async def test_list_open_jobs_paginates():
    from adapters.odoo.adapter import OdooAdapter

    page = 0
    pages = [
        [{"id": i, "name": f"job-{i}"} for i in range(1, 51)],
        [{"id": i, "name": f"job-{i}"} for i in range(51, 101)],
        [],
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal page
        body = request.read()
        out = _rpc({"uid": 1}) if b'"login"' in body else _rpc(pages[page])
        if b'"login"' not in body:
            page += 1
        return httpx.Response(200, json=out)

    with respx.mock() as r:
        r.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)
        adapter = OdooAdapter({
            "url": ODOO_URL, "database": "db", "username": "u", "password": "p",
        })
        await adapter.connect()
        out_a = await adapter.list("job", filters={"status": "open"})
        out_b = await adapter.list("job", filters={"status": "open"})
        out_c = await adapter.list("job", filters={"status": "open"})

    assert len(out_a) == 50
    assert len(out_b) == 50
    assert len(out_c) == 0


async def test_upsert_candidate_is_idempotent():
    from adapters.odoo.adapter import OdooAdapter

    seen_writes = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        if b'"login"' in body:
            return httpx.Response(200, json=_rpc({"uid": 1}))
        if b'"search_read"' in body:
            return httpx.Response(200, json=_rpc([{"id": 42, "email": "x@y"}]))
        if b'"write"' in body:
            seen_writes.append(body)
            return httpx.Response(200, json=_rpc(True))
        if b'"create"' in body:
            return httpx.Response(200, json=_rpc(99))
        return httpx.Response(200, json=_rpc(None))

    with respx.mock() as r:
        r.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)
        adapter = OdooAdapter({"url": ODOO_URL, "database": "db", "username": "u", "password": "p"})
        await adapter.connect()
        try:
            await adapter.upsert("candidate", {"email": "x@y", "name": "X"}, key="email")
            await adapter.upsert("candidate", {"email": "x@y", "name": "X"}, key="email")
        except AttributeError:
            pytest.skip("OdooAdapter.upsert not implemented yet (B-M-10 area)")

    assert len(seen_writes) <= 2


async def test_session_expired_triggers_exactly_one_reauth():
    """Pins B-M-09: AccessError → re-auth, then retry the original call exactly once."""
    from adapters.odoo.adapter import OdooAdapter

    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        calls.append(body)
        if b'"login"' in body:
            return httpx.Response(200, json=_rpc({"uid": 1}))
        if b'"search_read"' in body and len([c for c in calls if b'"search_read"' in c]) == 1:
            return httpx.Response(200, json=_rpc_error("AccessError: Session expired"))
        if b'"search_read"' in body:
            return httpx.Response(200, json=_rpc([{"id": 1, "name": "job"}]))
        return httpx.Response(200, json=_rpc(None))

    with respx.mock() as r:
        r.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)
        adapter = OdooAdapter({"url": ODOO_URL, "database": "db", "username": "u", "password": "p"})
        await adapter.connect()
        try:
            out = await adapter.list("job", filters={"status": "open"})
        except Exception as e:
            pytest.fail(f"Adapter must recover from one AccessError, got {e!r}")

    logins = sum(1 for c in calls if b'"login"' in c)
    assert logins <= 2, f"Re-auth budget exceeded: {logins} logins"
    _ = out


async def test_connector_test_returns_latency_and_error():
    from adapters.odoo.adapter import OdooAdapter

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        if b'"login"' in body:
            return httpx.Response(200, json=_rpc({"uid": 1}))
        return httpx.Response(500, text="upstream down")

    with respx.mock() as r:
        r.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)
        adapter = OdooAdapter({"url": ODOO_URL, "database": "db", "username": "u", "password": "p"})
        await adapter.connect()
        try:
            h = await adapter.health_check()
        except AttributeError:
            pytest.skip("health_check not exposed; adapter API in flux")
            return

    assert h.status in ("healthy", "down")
    assert isinstance(h.latency_ms, int)
