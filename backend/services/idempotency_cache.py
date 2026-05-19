"""In-memory idempotency cache for endpoints that need request deduplication
without a DB-backed scheme. Single-pod only — restart clears state."""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass
from typing import Any


@dataclass
class _Entry:
    payload_hash: str
    response: Any
    expires_at: float


def _now() -> float:
    return time.time()


class IdempotencyCache:
    def __init__(self, ttl_seconds: float = 600.0, clock=_now):
        self._ttl = ttl_seconds
        self._clock = clock
        self._entries: dict[tuple[str, str], _Entry] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._registry_lock = asyncio.Lock()

    async def lock_for(self, scope: str, key: str) -> asyncio.Lock:
        async with self._registry_lock:
            ck = (scope, key)
            lock = self._locks.get(ck)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[ck] = lock
            return lock

    def get(self, scope: str, key: str, payload_hash: str) -> tuple[str, Any | None]:
        # Returns ("hit", response) | ("conflict", None) | ("miss", None).
        self._evict_expired()
        entry = self._entries.get((scope, key))
        if entry is None:
            return ("miss", None)
        if entry.payload_hash != payload_hash:
            return ("conflict", None)
        return ("hit", entry.response)

    def put(self, scope: str, key: str, payload_hash: str, response: Any) -> None:
        self._entries[(scope, key)] = _Entry(
            payload_hash=payload_hash,
            response=response,
            expires_at=self._clock() + self._ttl,
        )

    def _evict_expired(self) -> None:
        now = self._clock()
        expired = [k for k, v in self._entries.items() if v.expires_at <= now]
        for k in expired:
            self._entries.pop(k, None)
            self._locks.pop(k, None)


def hash_payload(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


_default_cache = IdempotencyCache()


def get_cache() -> IdempotencyCache:
    return _default_cache
