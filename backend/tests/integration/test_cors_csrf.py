"""Pins B-C-13 — CORS regex `chrome-extension://.*` is too permissive.

Once the production extension ID is pinned, the regex should be replaced with
that specific extension ID. Today any extension can call the API.
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_no_origin_allowed(api_client):
    r = await api_client.get("/v1/workflows", headers=_HEADERS)
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_chrome_extension_origin_accepted_today(api_client):
    r = await api_client.get(
        "/v1/workflows",
        headers={**_HEADERS, "Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
    )
    assert r.status_code == 200
    # Today the response should carry Access-Control-Allow-Origin echoing the request.
    assert r.headers.get("access-control-allow-origin") in (
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "*", None,
    )


@pytest.mark.skip(
    reason=(
        "B-C-13: bug only observable against real uvicorn; httpx ASGI doesn't echo "
        "Access-Control-Allow-Origin on OPTIONS preflights the same way. Replace "
        "this skip with a uvicorn subprocess fixture once available."
    ),
)
@pytest.mark.asyncio
async def test_unknown_chrome_extension_id_should_be_rejected(api_client):
    """Once the extension ID is fixed, an unknown extension origin should not
    receive an Access-Control-Allow-Origin header.
    """
    r = await api_client.options(
        "/v1/workflows",
        headers={
            "Origin": "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.headers.get("access-control-allow-origin") is None


@pytest.mark.asyncio
async def test_localhost_origin_accepted(api_client):
    r = await api_client.get(
        "/v1/workflows",
        headers={**_HEADERS, "Origin": "http://localhost:5173"},
    )
    assert r.status_code == 200
