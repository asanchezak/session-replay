import pytest

from services.idempotency_cache import IdempotencyCache, hash_payload


def test_hash_payload_stable_under_key_reorder():
    a = {"a": 1, "b": 2, "nested": {"x": 1, "y": 2}}
    b = {"b": 2, "a": 1, "nested": {"y": 2, "x": 1}}
    assert hash_payload(a) == hash_payload(b)


def test_cache_miss_then_hit():
    cache = IdempotencyCache(ttl_seconds=60)
    h = hash_payload({"name": "x"})
    assert cache.get("scope", "k", h) == ("miss", None)
    cache.put("scope", "k", h, {"id": "wf1"})
    status, resp = cache.get("scope", "k", h)
    assert status == "hit"
    assert resp == {"id": "wf1"}


def test_cache_conflict_on_different_payload():
    cache = IdempotencyCache(ttl_seconds=60)
    cache.put("scope", "k", hash_payload({"a": 1}), {"id": "wf1"})
    status, resp = cache.get("scope", "k", hash_payload({"a": 2}))
    assert status == "conflict"
    assert resp is None


def test_cache_expires_after_ttl():
    clock_value = [1000.0]
    cache = IdempotencyCache(ttl_seconds=10, clock=lambda: clock_value[0])
    cache.put("scope", "k", "h", {"id": "x"})
    assert cache.get("scope", "k", "h")[0] == "hit"
    clock_value[0] = 1020.0  # past TTL
    assert cache.get("scope", "k", "h")[0] == "miss"


@pytest.mark.asyncio
async def test_lock_per_key_is_reentrant_to_same_caller():
    cache = IdempotencyCache(ttl_seconds=60)
    l1 = await cache.lock_for("scope", "k")
    l2 = await cache.lock_for("scope", "k")
    assert l1 is l2
