import hashlib
import json
import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.event import EventLog
from core.utils import to_uuid

logger = logging.getLogger(__name__)


def compute_event_hash(
    previous_hash: str,
    event_type: str,
    payload: dict,
    nonce: str,
) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    raw = f"{previous_hash}|{event_type}|{canonical}|{nonce}"
    return hashlib.sha256(raw.encode()).hexdigest()


def compute_seed_hash(run_id: str, user_id: str | None = None) -> str:
    seed_raw = f"seed|{run_id}|{user_id or 'anonymous'}"
    return hashlib.sha256(seed_raw.encode()).hexdigest()


@dataclass
class AppendEvent:
    event_type: str
    payload: dict | None = None
    run_id: str | None = None
    actor_type: str = "system"
    page_url: str | None = None
    page_title: str | None = None
    step_id: str | None = None
    idempotency_key: str | None = None


class AuditService:
    """Service for appending and verifying tamper-evident audit events.

    Each event is chained to the previous via SHA-256 hash, creating a
    tamper-evident log. Supports idempotent event insertion and chain
    verification.
    """

    def __init__(self, session: AsyncSession):
        self.session = session

    async def append(
        self,
        event: AppendEvent,
        previous_hash: str | None = None,
    ) -> EventLog:
        """Append an audit event to the chain.

        Args:
            event: The event data to append.
            previous_hash: Explicit previous hash (auto-computed if None).

        Returns:
            The persisted EventLog record.
        """
        payload = event.payload or {}
        nonce = secrets.token_hex(32)
        now = datetime.now(UTC)
        run_uuid = to_uuid(event.run_id) if event.run_id else None

        if previous_hash is None:
            result = await self.session.execute(
                select(EventLog.hash)
                .where(EventLog.run_id == run_uuid)
                .order_by(EventLog.created_at.desc(), EventLog.sequence_number.desc())
                .limit(1)
            )
            row = result.scalar_one_or_none()
            previous_hash = row or compute_seed_hash(
                str(event.run_id) if event.run_id else "no-run"
            )

        max_seq = 0
        if event.run_id:
            result = await self.session.execute(
                select(func.max(EventLog.sequence_number)).where(EventLog.run_id == run_uuid)
            )
            max_seq = result.scalar() or 0

        event_hash = compute_event_hash(previous_hash, event.event_type, payload, nonce)

        ev = EventLog(
            created_at=now,
            run_id=run_uuid,
            step_id=to_uuid(event.step_id) if event.step_id else None,
            actor_type=event.actor_type,
            event_type=event.event_type,
            payload=payload,
            page_url=event.page_url,
            page_title=event.page_title,
            previous_hash=previous_hash,
            hash=event_hash,
            nonce=nonce,
            idempotency_key=event.idempotency_key,
            sequence_number=max_seq + 1,
        )
        self.session.add(ev)
        await self.session.flush()
        logger.info("Appended event type=%s run_id=%s", event.event_type, event.run_id)
        return ev

    async def verify_chain(self, run_id: str) -> list[dict]:
        """Verify hash-chain integrity for all events in a run.

        Args:
            run_id: The run to verify.

        Returns:
            List of broken links, each with event_id, index, expected/actual hash.
        """
        logger.info("Verifying chain for run_id=%s", run_id)
        result = await self.session.execute(
            select(EventLog)
            .where(EventLog.run_id == to_uuid(run_id))
            .order_by(EventLog.sequence_number, EventLog.created_at)
        )
        events = result.scalars().all()

        broken = []
        previous_hash = compute_seed_hash(run_id)
        for i, event in enumerate(events):
            expected = compute_event_hash(
                previous_hash, event.event_type, event.payload, event.nonce
            )
            if expected != event.hash:
                broken.append({
                    "event_id": str(event.id),
                    "index": i,
                    "expected": expected,
                    "actual": event.hash,
                })
            previous_hash = event.hash
        if broken:
            logger.warning(
                "Chain verification found %d broken links for run_id=%s",
                len(broken), run_id,
            )
        else:
            logger.info("Chain verification passed for run_id=%s", run_id)
        return broken
