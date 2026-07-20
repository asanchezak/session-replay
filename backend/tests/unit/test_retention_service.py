"""retention_service.cleanup() must delete a run's stored images (file + Artifact
row) alongside the run itself -- Artifact.run_id has no FK/cascade to
execution_runs, so images left behind become permanently orphaned garbage on disk.
Also covers the orphan-sweep for artifacts whose run is already gone by some other
path (the pre-existing-garbage case discovered live on DEV).
"""
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.models.run import ExecutionRun
from services.artifact_service import ArtifactService
from services.retention_service import cleanup


async def _make_run(db_session: AsyncSession, *, ended_at, status="completed") -> ExecutionRun:
    run = ExecutionRun(
        id=uuid.uuid4(), workflow_id="w", status=status, total_steps=1,
        ended_at=ended_at,
    )
    db_session.add(run)
    await db_session.flush()
    return run


@pytest.mark.asyncio
async def test_cleanup_deletes_images_for_expiring_runs(db_session: AsyncSession, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "storage_path", str(tmp_path))
    now = datetime.now(UTC)

    expired_run = await _make_run(db_session, ended_at=now - timedelta(days=100))
    fresh_run = await _make_run(db_session, ended_at=now - timedelta(days=1))

    artifacts = ArtifactService(db_session)
    expired_artifact = await artifacts.store_artifact(
        str(expired_run.id), 0, "page_capture", b"old", "image/png"
    )
    fresh_artifact = await artifacts.store_artifact(
        str(fresh_run.id), 0, "page_capture", b"new", "image/png"
    )
    await db_session.flush()

    result = await cleanup(90, db_session)

    assert result["runs_deleted"] == 1
    assert result["images_deleted"] == 1
    assert not artifacts.storage.fs.exists(expired_artifact.file_path)
    # The fresh run + its image survive.
    assert artifacts.storage.fs.exists(fresh_artifact.file_path)
    remaining = await artifacts.list_artifacts(str(fresh_run.id))
    assert len(remaining) == 1


@pytest.mark.asyncio
async def test_cleanup_sweeps_already_orphaned_artifacts(db_session: AsyncSession, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "storage_path", str(tmp_path))
    artifacts = ArtifactService(db_session)
    # No ExecutionRun row exists for this run_id at all -- simulates garbage left
    # behind by a run deleted before this fix existed.
    orphan_run_id = str(uuid.uuid4())
    orphan_artifact = await artifacts.store_artifact(
        orphan_run_id, 0, "page_capture", b"orphan", "image/png"
    )
    await db_session.flush()

    result = await cleanup(90, db_session)

    assert result["orphaned_images_deleted"] == 1
    assert not artifacts.storage.fs.exists(orphan_artifact.file_path)
    remaining = await artifacts.list_artifacts(orphan_run_id)
    assert len(remaining) == 0


@pytest.mark.asyncio
async def test_cleanup_leaves_non_expired_runs_and_images_alone(db_session: AsyncSession, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "storage_path", str(tmp_path))
    now = datetime.now(UTC)
    fresh_run = await _make_run(db_session, ended_at=now - timedelta(days=1))
    artifacts = ArtifactService(db_session)
    a = await artifacts.store_artifact(str(fresh_run.id), 0, "page_capture", b"x", "image/png")
    await db_session.flush()

    result = await cleanup(90, db_session)

    assert result["runs_deleted"] == 0
    assert result["images_deleted"] == 0
    assert result["orphaned_images_deleted"] == 0
    assert artifacts.storage.fs.exists(a.file_path)
