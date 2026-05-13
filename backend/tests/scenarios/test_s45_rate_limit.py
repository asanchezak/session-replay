"""S45 — Rate-limit at 600 rpm.

This is the scenario-flavored duplicate of integration/test_rate_limit.py for
the `make test-scenarios` selector.
"""
from __future__ import annotations

import pytest

from core.config import settings

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.fixture
def low_ceiling(monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_enabled", True, raising=False)
    monkeypatch.setattr(settings, "rate_limit_per_minute", 3, raising=False)
    from api.main import _rate_limit_buckets
    _rate_limit_buckets.clear()
    yield
    _rate_limit_buckets.clear()


@pytest.mark.asyncio
async def test_burst_returns_429(api_client, low_ceiling):
    saw_429 = False
    for _ in range(20):
        r = await api_client.get("/v1/workflows", headers=_HEADERS)
        if r.status_code == 429:
            saw_429 = True
            assert r.json()["error"]["code"] == "RATE_LIMITED"
            break
    assert saw_429


@pytest.mark.skip(reason="B-C-12: multi-worker shared bucket requires Redis. Re-enable when implemented.")
@pytest.mark.asyncio
async def test_multiprocess_shared_bucket():
    pass
