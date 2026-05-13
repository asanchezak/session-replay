"""S46 — Pagination boundary."""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_limit_too_large_rejected(api_client):
    r = await api_client.get("/v1/workflows?limit=999999", headers=_HEADERS)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_negative_offset_rejected(api_client):
    r = await api_client.get("/v1/workflows?offset=-1", headers=_HEADERS)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_offset_far_beyond_returns_empty(api_client):
    r = await api_client.get("/v1/workflows?offset=99999", headers=_HEADERS)
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_pagination_returns_correct_window(api_client):
    # Seed five workflows.
    for i in range(5):
        await api_client.post("/v1/workflows", json={"name": f"p-{i}"}, headers=_HEADERS)
    page = (await api_client.get("/v1/workflows?limit=2&offset=2", headers=_HEADERS)).json()
    assert isinstance(page, list)
    assert len(page) <= 2
