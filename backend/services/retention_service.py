from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def cleanup(retention_days: int, db: AsyncSession) -> dict[str, int]:
    cutoff = datetime.now(UTC) - timedelta(days=retention_days)
    result: dict[str, int] = {}

    from core.models.event import EventLog
    from core.models.run import ExecutionRun

    stmt = sa.delete(EventLog).where(EventLog.created_at < cutoff)
    resp = await db.execute(stmt)
    result["events_deleted"] = resp.rowcount

    stmt = sa.delete(ExecutionRun).where(
        ExecutionRun.status.in_(["completed", "failed", "canceled"]),
        ExecutionRun.ended_at < cutoff,
    )
    resp = await db.execute(stmt)
    result["runs_deleted"] = resp.rowcount

    await db.commit()
    logger.info(
        "Retention cleanup: deleted %d events and %d runs (cutoff=%s, retention_days=%d)",
        result["events_deleted"],
        result["runs_deleted"],
        cutoff.isoformat(),
        retention_days,
    )
    return result
