"""S45 — rate limit at 600 rpm.

Conftest disables the rate limiter for the default test client. This file
re-enables it for its tests via a context-manager fixture, then sends a burst
and asserts 429 with `RATE_LIMITED` code.
"""
from __future__ import annotations

import pytest

from core.config import settings

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.fixture
def rate_limit_enabled(monkeypatch):
    """Re-enable rate limiting around a single test, with a low ceiling."""
    monkeypatch.setattr(settings, "rate_limit_enabled", True, raising=False)
    monkeypatch.setattr(settings, "rate_limit_per_minute", 5, raising=False)
    # Also reset the in-memory buckets so we start clean.
    from api.main import _rate_limit_buckets
    _rate_limit_buckets.clear()
    yield
    _rate_limit_buckets.clear()


@pytest.mark.asyncio
async def test_burst_above_ceiling_returns_429(api_client, rate_limit_enabled):
    rs = []
    for _ in range(10):
        rs.append(await api_client.get("/v1/workflows", headers=_HEADERS))
    statuses = [r.status_code for r in rs]
    assert 429 in statuses, f"Expected at least one 429 in {statuses}"
    last_429 = next(r for r in rs if r.status_code == 429)
    body = last_429.json()
    assert body["error"]["code"] == "RATE_LIMITED"


@pytest.mark.asyncio
async def test_health_is_exempt_from_rate_limit(api_client, rate_limit_enabled):
    for _ in range(10):
        r = await api_client.get("/v1/health")
        assert r.status_code == 200


@pytest.mark.skip(
    reason=(
        "B-C-12: in-memory rate limiter is per-process. Cannot meaningfully test "
        "multi-worker behavior without spawning multiple uvicorn workers. "
        "Once moved to Redis, replace this skip with a real test."
    ),
)
@pytest.mark.asyncio
async def test_rate_limit_shared_across_workers():
    pass


@pytest.mark.skip(
    reason=(
        "B-C-12: requires distinct client IPs to exercise the eviction path; "
        "httpx ASGI transport pins request.client to a single value. Convert to "
        "a real uvicorn subprocess test once the eviction strategy lands."
    ),
)
@pytest.mark.asyncio
async def test_unique_ips_eventually_evicted(api_client, rate_limit_enabled):
    from api.main import _rate_limit_buckets
    assert len(_rate_limit_buckets) <= 1024
