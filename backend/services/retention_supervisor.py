from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core.models.settings import AppSetting
from services.retention_service import cleanup

logger = logging.getLogger(__name__)

DEFAULT_RETENTION_DAYS = 90
POLL_INTERVAL_SECONDS = 3600


class RetentionSupervisor:
    @staticmethod
    def start_supervisor(app):
        from core.database import async_session_factory

        task = asyncio.create_task(_run_supervisor(async_session_factory))
        app.state.retention_supervisor = task
        logger.info("Retention supervisor started")
        return task


async def _resolve_retention_days(session: AsyncSession) -> int:
    result = await session.execute(
        select(AppSetting).where(AppSetting.key == "retention_days")
    )
    setting = result.scalar_one_or_none()
    if not setting:
        return DEFAULT_RETENTION_DAYS
    value = setting.value
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return DEFAULT_RETENTION_DAYS


async def _run_supervisor(session_factory: async_sessionmaker[AsyncSession]):
    logger.info("Retention supervisor loop started")
    while True:
        try:
            async with session_factory() as session:
                retention_days = await _resolve_retention_days(session)
                await cleanup(retention_days, session)
        except Exception:
            logger.exception("Retention supervisor cycle failed")
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
