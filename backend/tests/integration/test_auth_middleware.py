"""F24 — API auth middleware (`X-API-Key`).

Pins:
- /v1/health is exempt (intentional).
- /v1/debug/log is exempt (B-C-11, also pinned by test_debug_log_auth.py).
- Every other /v1/* requires the key.
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_health_exempt(api_client):
    r = await api_client.get("/v1/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_workflows_requires_key(api_client):
    r = await api_client.get("/v1/workflows")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_wrong_key_returns_401(api_client):
    r = await api_client.get("/v1/workflows", headers={"X-API-Key": "wrong"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_valid_key_passes(api_client):
    r = await api_client.get("/v1/workflows", headers=_HEADERS)
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_request_id_present_on_all_responses(api_client):
    r = await api_client.get("/v1/health")
    assert "x-request-id" in (k.lower() for k in r.headers.keys())


@pytest.mark.xfail(
    strict=True,
    reason="S-11: no rate-limit on failed auth attempts allows brute-forcing the weak default key.",
)
@pytest.mark.asyncio
async def test_brute_force_failed_auth_gets_locked_out(api_client):
    for _ in range(50):
        await api_client.get("/v1/workflows", headers={"X-API-Key": "wrong"})
    # Expected: after N failures, even valid key returns 429 for that IP for a window.
    r = await api_client.get("/v1/workflows", headers={"X-API-Key": "wrong"})
    assert r.status_code == 429
