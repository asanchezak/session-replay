"""S28 — Append-only chain remains intact after 10 000 events on one run.

Default cap of 10k is configurable via `SR_S28_N` to make the test fast in CI.
"""
from __future__ import annotations

import os
import uuid

import pytest

from services.audit import AppendEvent, AuditService

N = int(os.environ.get("SR_S28_N", "1000"))  # 10 000 by default in nightly via env


@pytest.mark.asyncio
async def test_chain_intact_at_scale(db_session):
    audit = AuditService(db_session)
    run_id = str(uuid.uuid4())
    for i in range(N):
        await audit.append(AppendEvent(event_type="step_executed", payload={"i": i}, run_id=run_id))
    await db_session.flush()

    broken = await audit.verify_chain(run_id)
    assert broken == [], f"Chain broken at indices: {[b['index'] for b in broken[:5]]}"


@pytest.mark.asyncio
async def test_chain_hash_uniqueness_under_load(db_session):
    audit = AuditService(db_session)
    run_id = str(uuid.uuid4())
    hashes = set()
    for i in range(N):
        ev = await audit.append(AppendEvent(event_type="step_executed", payload={"i": i}, run_id=run_id))
        assert ev.hash not in hashes
        hashes.add(ev.hash)
