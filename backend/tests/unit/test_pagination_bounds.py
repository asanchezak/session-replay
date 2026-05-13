"""Pins T-G-06 — pagination bounds are not validated.

`limit` and `offset` on every list endpoint are accepted as bare ints with no
`ge=`/`le=` constraints. A client can request `limit=999999` and the server
will try to honor it. This test asserts the corrected behavior; today the
xfailed cases are silently accepted.
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


async def _seed_workflow(api_client):
    r = await api_client.post(
        "/v1/workflows", json={"name": "p"}, headers=_HEADERS,
    )
    return r.json()["id"]


@pytest.mark.asyncio
async def test_workflows_list_default_works(api_client):
    r = await api_client.get("/v1/workflows", headers=_HEADERS)
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_runs_list_default_works(api_client):
    r = await api_client.get("/v1/runs", headers=_HEADERS)
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_pagination_with_valid_params(api_client):
    r = await api_client.get("/v1/workflows?limit=10&offset=0", headers=_HEADERS)
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_workflows_list_rejects_oversize_limit(api_client):
    r = await api_client.get("/v1/workflows?limit=999999", headers=_HEADERS)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_workflows_list_rejects_negative_offset(api_client):
    r = await api_client.get("/v1/workflows?offset=-1", headers=_HEADERS)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_runs_list_rejects_oversize_limit(api_client):
    r = await api_client.get("/v1/runs?limit=10000", headers=_HEADERS)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_runs_list_rejects_negative_offset(api_client):
    r = await api_client.get("/v1/runs?offset=-5", headers=_HEADERS)
    assert r.status_code == 422


@pytest.mark.xfail(
    strict=True,
    reason="No bounds on /v1/debug/logs either.",
)
@pytest.mark.asyncio
async def test_debug_logs_rejects_oversize_limit(api_client):
    r = await api_client.get("/v1/debug/logs?limit=999999", headers=_HEADERS)
    assert r.status_code == 422
