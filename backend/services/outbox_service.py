import asyncio
import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core.models.outbox import AuditOutbox
from services.audit import AppendEvent, AuditService

logger = logging.getLogger(__name__)


class OutboxService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def enqueue(
        self,
        event_type: str,
        payload: dict | None = None,
        run_id: str | None = None,
        actor_type: str = "system",
        idempotency_key: str | None = None,
    ) -> AuditOutbox:
        entry = AuditOutbox(
            event_type=event_type,
            payload=payload or {},
            run_id=run_id,
            actor_type=actor_type,
            idempotency_key=idempotency_key,
        )
        self.session.add(entry)
        await self.session.flush()
        logger.debug("Enqueued outbox event type=%s run_id=%s", event_type, run_id)
        return entry

    async def process_pending(self) -> int:
        result = await self.session.execute(
            select(AuditOutbox)
            .where(AuditOutbox.processed == False)
            .order_by(AuditOutbox.created_at)
        )
        entries = list(result.scalars().all())
        if not entries:
            return 0

        audit = AuditService(self.session)
        for entry in entries:
            event = AppendEvent(
                event_type=entry.event_type,
                payload=entry.payload,
                run_id=entry.run_id,
                actor_type=entry.actor_type,
                idempotency_key=entry.idempotency_key,
            )
            try:
                await audit.append(event)
                entry.processed = True
                entry.processed_at = datetime.now(UTC)
            except Exception:
                logger.exception(
                    "Failed to process outbox entry id=%s event_type=%s",
                    entry.id, entry.event_type,
                )
        await self.session.flush()
        logger.info("Processed %d outbox entries", len(entries))
        return len(entries)

    @staticmethod
    def start_processor(app):
        from core.database import async_session_factory

        task = asyncio.create_task(_run_processor(async_session_factory))
        app.state.outbox_processor = task
        logger.info("Outbox background processor started")
        return task


async def _run_processor(session_factory: async_sessionmaker[AsyncSession]):
    logger.info("Outbox processor loop started")
    while True:
        try:
            async with session_factory() as session:
                svc = OutboxService(session)
                await svc.process_pending()
                await session.commit()
        except Exception:
            logger.exception("Outbox processor error")
        await asyncio.sleep(5)
