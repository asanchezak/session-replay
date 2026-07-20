from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def cleanup(retention_days: int, db: AsyncSession) -> dict[str, int]:
    cutoff = datetime.now(UTC) - timedelta(days=retention_days)
    result: dict[str, int] = {}

    from core.models.artifact import Artifact
    from core.models.event import EventLog
    from core.models.run import ExecutionRun
    from services.artifact_service import ArtifactService

    stmt = sa.delete(EventLog).where(EventLog.created_at < cutoff)
    resp = await db.execute(stmt)
    result["events_deleted"] = resp.rowcount

    # Delete each expiring run's stored images (file + row) BEFORE deleting the run
    # itself -- Artifact.run_id has no FK/cascade to execution_runs, so images left
    # behind after a run row is gone become permanently orphaned garbage on disk.
    expiring_run_ids = (
        await db.execute(
            sa.select(ExecutionRun.id).where(
                ExecutionRun.status.in_(["completed", "failed", "canceled"]),
                ExecutionRun.ended_at < cutoff,
            )
        )
    ).scalars().all()
    artifacts = ArtifactService(db)
    images_deleted = 0
    for run_id in expiring_run_ids:
        try:
            images_deleted += await artifacts.delete_artifacts_for_run(str(run_id))
        except Exception:
            logger.exception("Retention cleanup: failed deleting artifacts for run_id=%s", run_id)
    result["images_deleted"] = images_deleted

    stmt = sa.delete(ExecutionRun).where(ExecutionRun.id.in_(expiring_run_ids))
    resp = await db.execute(stmt)
    result["runs_deleted"] = resp.rowcount

    # Sweep any artifacts already orphaned by a run deleted some other way (e.g.
    # before this fix existed, or a run deleted outside this cleanup path).
    all_run_ids = {str(rid) for rid in (await db.execute(sa.select(ExecutionRun.id))).scalars().all()}
    orphaned = (
        await db.execute(sa.select(Artifact.run_id).distinct())
    ).scalars().all()
    orphaned_run_ids = [rid for rid in orphaned if rid not in all_run_ids]
    orphaned_images_deleted = 0
    for run_id in orphaned_run_ids:
        try:
            orphaned_images_deleted += await artifacts.delete_artifacts_for_run(run_id)
        except Exception:
            logger.exception("Retention cleanup: failed deleting orphaned artifacts for run_id=%s", run_id)
    result["orphaned_images_deleted"] = orphaned_images_deleted

    await db.commit()
    logger.info(
        "Retention cleanup: deleted %d events, %d runs, %d images (%d from orphaned runs) "
        "(cutoff=%s, retention_days=%d)",
        result["events_deleted"],
        result["runs_deleted"],
        result["images_deleted"] + result["orphaned_images_deleted"],
        result["orphaned_images_deleted"],
        cutoff.isoformat(),
        retention_days,
    )
    return result
