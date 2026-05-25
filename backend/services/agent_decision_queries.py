from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.event import EventLog
from core.utils import to_uuid


async def list_agent_decisions(
    session: AsyncSession,
    run_id: str,
    limit: int = 100,
) -> list[dict[str, Any]]:
    uid = to_uuid(run_id)
    result = await session.execute(
        select(EventLog)
        .where(EventLog.run_id == uid)
        .where(EventLog.event_type == "agent_decision")
        .order_by(EventLog.sequence_number.desc())
        .limit(limit)
    )
    return [
        {
            "id": str(event.id),
            "payload": event.payload,
            "hash": event.hash,
            "created_at": event.created_at.isoformat(),
        }
        for event in result.scalars().all()
    ]
