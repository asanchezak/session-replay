"""S38 — Session expired mid-flow; adapter re-auths exactly once.

Pins B-M-09: the adapter must not loop on AccessError. After one re-auth the
call must either succeed or fail definitively.
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio

respx = pytest.importorskip("respx")
import httpx  # noqa: E402

ODOO_URL = "https://odoo.example.com"


async def test_single_reauth_then_recover():
    from adapters.odoo.adapter import OdooAdapter

    logins = 0
    operation_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal logins, operation_calls
        body = request.read()
        if b'"login"' in body:
            logins += 1
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"uid": 1}})
        operation_calls += 1
        if operation_calls == 1:
            return httpx.Response(200, json={
                "jsonrpc": "2.0", "id": 1,
                "error": {"message": "Odoo Server Error\nAccessError: Session expired"},
            })
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": [{"id": 1, "name": "job"}]})

    with respx.mock() as r:
        r.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)
        adapter = OdooAdapter({"url": ODOO_URL, "database": "d", "username": "u", "password": "p"})
        await adapter.connect()
        out = await adapter.list("job", filters={"status": "open"})

    assert logins == 2, f"Expected one initial + one re-auth; got {logins}"
    assert out, "Second attempt must succeed"


async def test_repeated_access_error_does_not_recurse_forever():
    from adapters.odoo.adapter import OdooAdapter

    logins = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal logins
        body = request.read()
        if b'"login"' in body:
            logins += 1
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"uid": 1}})
        return httpx.Response(200, json={
            "jsonrpc": "2.0", "id": 1,
            "error": {"message": "AccessError: Session expired"},
        })

    with respx.mock() as r:
        r.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)
        adapter = OdooAdapter({"url": ODOO_URL, "database": "d", "username": "u", "password": "p"})
        await adapter.connect()
        with pytest.raises(Exception):
            await adapter.list("job", filters={"status": "open"})

    assert logins <= 2
