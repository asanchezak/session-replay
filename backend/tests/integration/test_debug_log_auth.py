"""Pins B-C-11 — POST /v1/debug/log is unauthenticated (and present in the auth-exempt set).

Anyone who can reach the server can write arbitrary log lines that are then
visible to authenticated readers via GET /v1/debug/logs. This is a log-injection
vector and should require auth.
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_post_debug_log_rejects_no_auth(api_client):
    """POST /v1/debug/log now requires X-API-Key."""
    r = await api_client.post(
        "/v1/debug/log",
        json={"source": "x", "level": "info", "message": "injected", "timestamp": 0},
    )
    assert r.status_code == 401, "POST /v1/debug/log now requires auth"


@pytest.mark.asyncio
async def test_post_debug_log_should_require_auth(api_client):
    r = await api_client.post(
        "/v1/debug/log",
        json={"source": "x", "level": "info", "message": "injected", "timestamp": 0},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_get_debug_logs_requires_auth(api_client):
    r = await api_client.get("/v1/debug/logs")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_get_debug_logs_with_auth(api_client):
    r = await api_client.get("/v1/debug/logs", headers=_HEADERS)
    assert r.status_code == 200
    assert isinstance(r.json(), list)
