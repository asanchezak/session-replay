"""S29 — Tampering with a row's payload via direct SQL UPDATE breaks the chain.

This is the positive case for `verify_chain`. The complementary scenario S30
checks that a duplicate (run_id, nonce) is rejected — currently xfail.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import update

from core.models.event import EventLog
from services.audit import AppendEvent, AuditService


@pytest.mark.asyncio
async def test_payload_update_breaks_chain_at_exact_index(db_session):
    audit = AuditService(db_session)
    run_id = str(uuid.uuid4())
    ids = []
    for i in range(20):
        ev = await audit.append(AppendEvent(event_type="step_executed", payload={"i": i}, run_id=run_id))
        ids.append(ev.id)
    await db_session.flush()

    target_index = 7
    await db_session.execute(
        update(EventLog).where(EventLog.id == ids[target_index]).values(payload={"i": 999})
    )
    await db_session.flush()

    broken = await audit.verify_chain(run_id)
    assert broken, "tamper must be detected"
    assert broken[0]["index"] == target_index


@pytest.mark.asyncio
async def test_tampering_does_not_cascade(db_session):
    """Tampering one row should produce one broken entry, not N. The chain
    rebuild past the tampered row continues with the stored (tampered) hash.
    """
    audit = AuditService(db_session)
    run_id = str(uuid.uuid4())
    ids = []
    for i in range(5):
        ev = await audit.append(AppendEvent(event_type="step_executed", payload={"i": i}, run_id=run_id))
        ids.append(ev.id)
    await db_session.flush()

    await db_session.execute(
        update(EventLog).where(EventLog.id == ids[2]).values(payload={"tampered": True})
    )
    await db_session.flush()
    broken = await audit.verify_chain(run_id)
    # We expect exactly 1 broken entry — the tampered one. (Implementations
    # that continue the chain with stored hash will also produce 1.)
    assert len(broken) == 1
