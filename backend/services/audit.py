import hashlib
import json
import secrets
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.event import EventLog


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


def _to_uuid(id_str: str | None) -> uuid.UUID | None:
    if id_str is None:
        return None
    try:
        return uuid.UUID(id_str)
    except ValueError:
        return None


class AuditService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def append(
        self,
        event_type: str,
        payload: dict | None = None,
        actor_type: str = "system",
        page_url: str | None = None,
        page_title: str | None = None,
        run_id: str | None = None,
        step_id: str | None = None,
        previous_hash: str | None = None,
    ) -> EventLog:
        if payload is None:
            payload = {}
        nonce = secrets.token_hex(32)
        now = datetime.now(UTC)

        if previous_hash is None:
            result = await self.session.execute(
                select(EventLog.hash)
                .where(EventLog.run_id == _to_uuid(run_id))
                .order_by(EventLog.created_at.desc())
                .limit(1)
            )
            row = result.scalar_one_or_none()
            previous_hash = row or compute_seed_hash(
                str(run_id) if run_id else "no-run"
            )

        event_hash = compute_event_hash(previous_hash, event_type, payload, nonce)

        event = EventLog(
            created_at=now,
            run_id=_to_uuid(run_id),
            step_id=_to_uuid(step_id),
            actor_type=actor_type,
            event_type=event_type,
            payload=payload,
            page_url=page_url,
            page_title=page_title,
            previous_hash=previous_hash,
            hash=event_hash,
            nonce=nonce,
        )
        self.session.add(event)
        await self.session.flush()
        return event

    async def verify_chain(self, run_id: str) -> list[dict]:
        result = await self.session.execute(
            select(EventLog)
            .where(EventLog.run_id == _to_uuid(run_id))
            .order_by(EventLog.created_at)
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
        return broken
