"""S47 — CORS: only whitelisted extension IDs may call the API.

Today the regex matches any chrome-extension://. After the prod ID is fixed,
this xfail flips.
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.skip(
    reason=(
        "B-C-13: the CORS regex bug is only observable against real uvicorn — "
        "httpx ASGI doesn't echo Access-Control-Allow-Origin on OPTIONS preflights "
        "the same way. Replace this skip with a real end-to-end test once a uvicorn "
        "subprocess fixture lands."
    ),
)
@pytest.mark.asyncio
async def test_unknown_extension_id_rejected(api_client):
    r = await api_client.options(
        "/v1/workflows",
        headers={
            "Origin": "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
            "Access-Control-Request-Method": "GET",
        },
    )
    # In a fixed setup the response should NOT carry an allow-origin header that
    # matches the unknown extension ID.
    aco = r.headers.get("access-control-allow-origin")
    assert aco != "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"


@pytest.mark.asyncio
async def test_localhost_5173_allowed(api_client):
    r = await api_client.get(
        "/v1/workflows",
        headers={**_HEADERS, "Origin": "http://localhost:5173"},
    )
    assert r.status_code == 200
