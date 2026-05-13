"""S29/S30 unit pieces + bug pins for B-C-02, B-C-03.

Pins three properties of the audit chain:
1. A direct DB-level UPDATE to a payload breaks the chain (good — already works).
2. The (run_id, nonce) pair should be unique. (xfail today — only `hash` is unique.)
3. Chain ordering must survive same-microsecond inserts. (xfail today — order by `created_at` only.)

See AUDIT_FINDINGS.md §1.1 B-C-02, B-C-03.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from core.models.event import EventLog
from services.audit import AppendEvent, AuditService, compute_event_hash, compute_seed_hash


@pytest.mark.asyncio
async def test_payload_tamper_breaks_chain(db_session):
    """Directly UPDATE a row's payload via SQL — verify_chain must report it."""
    audit = AuditService(db_session)
    run_id = str(uuid.uuid4())
    e1 = await audit.append(AppendEvent(event_type="step_executed", payload={"i": 1}, run_id=run_id))
    e2 = await audit.append(AppendEvent(event_type="step_executed", payload={"i": 2}, run_id=run_id))
    await db_session.flush()

    # Tamper via direct UPDATE — bypasses ORM hooks.
    await db_session.execute(
        update(EventLog).where(EventLog.id == e1.id).values(payload={"i": 999})
    )
    await db_session.flush()

    broken = await audit.verify_chain(run_id)
    assert len(broken) >= 1, "Tampered event must be reported"
    # The very first event's recomputed hash differs from the stored one.
    assert any(b["event_id"] == str(e1.id) for b in broken)
    _ = e2  # silence unused


@pytest.mark.asyncio
async def test_chain_intact_when_unchanged(db_session):
    audit = AuditService(db_session)
    run_id = str(uuid.uuid4())
    for i in range(5):
        await audit.append(AppendEvent(event_type="step_executed", payload={"i": i}, run_id=run_id))
    await db_session.flush()

    broken = await audit.verify_chain(run_id)
    assert broken == []


@pytest.mark.asyncio
async def test_seed_hash_is_deterministic_per_run():
    a = compute_seed_hash("11111111-1111-1111-1111-111111111111")
    b = compute_seed_hash("11111111-1111-1111-1111-111111111111")
    c = compute_seed_hash("22222222-2222-2222-2222-222222222222")
    assert a == b
    assert a != c


@pytest.mark.asyncio
async def test_compute_event_hash_canonicalizes_payload_order():
    h1 = compute_event_hash("seed", "type", {"a": 1, "b": 2}, "nonce")
    h2 = compute_event_hash("seed", "type", {"b": 2, "a": 1}, "nonce")
    assert h1 == h2, "Hash must be order-independent"


@pytest.mark.asyncio
async def test_duplicate_nonce_for_same_run_is_rejected(db_session):
    """Inserting two events with the same (run_id, nonce) must fail."""
    audit = AuditService(db_session)
    run_id = str(uuid.uuid4())
    e1 = await audit.append(AppendEvent(event_type="step_executed", payload={"i": 1}, run_id=run_id))
    await db_session.flush()

    # Try to insert a row with identical nonce manually.
    dup = EventLog(
        created_at=datetime.now(UTC),
        run_id=uuid.UUID(run_id),
        actor_type="system",
        event_type="step_executed",
        payload={"i": 1},
        previous_hash=e1.previous_hash,
        # Identical hash will trip the existing UNIQUE(hash); to isolate the nonce
        # uniqueness we use a different payload to get a different hash but reuse
        # the nonce. This is the actual attack: same nonce, different content.
        hash=compute_event_hash(e1.previous_hash, "step_executed", {"i": 99}, e1.nonce),
        nonce=e1.nonce,
    )
    db_session.add(dup)
    with pytest.raises(Exception):  # IntegrityError once UNIQUE is added.
        await db_session.flush()


@pytest.mark.asyncio
async def test_chain_ordering_survives_same_microsecond_inserts(db_session):
    """Insert several events whose created_at is identical; verify_chain must still order deterministically."""
    audit = AuditService(db_session)
    run_id = str(uuid.uuid4())

    # Force two events to share the same created_at.
    same_ts = datetime.now(UTC).replace(microsecond=500_000)
    for i in range(3):
        ev = await audit.append(AppendEvent(event_type="step_executed", payload={"i": i}, run_id=run_id))
        ev.created_at = same_ts + timedelta(microseconds=0)
    await db_session.flush()

    broken = await audit.verify_chain(run_id)
    assert broken == [], "Chain must verify deterministically even on ties"
