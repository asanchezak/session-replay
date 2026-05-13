"""S30 — Inserting a duplicate (run_id, nonce) must be rejected at the DB.

XFail today: EventLog has UNIQUE(hash) but not UNIQUE(run_id, nonce). See B-C-03.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from core.models.event import EventLog
from services.audit import AppendEvent, AuditService, compute_event_hash


@pytest.mark.asyncio
async def test_duplicate_nonce_rejected(db_session):
    audit = AuditService(db_session)
    run_id = str(uuid.uuid4())
    first = await audit.append(AppendEvent(event_type="step_executed", payload={"i": 1}, run_id=run_id))
    await db_session.flush()

    dup = EventLog(
        created_at=datetime.now(UTC),
        run_id=uuid.UUID(run_id),
        actor_type="system",
        event_type="step_executed",
        payload={"i": 2},
        previous_hash=first.hash,
        hash=compute_event_hash(first.hash, "step_executed", {"i": 2}, first.nonce),
        nonce=first.nonce,
    )
    db_session.add(dup)
    with pytest.raises(Exception):
        await db_session.flush()
