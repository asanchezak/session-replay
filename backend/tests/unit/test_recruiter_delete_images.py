"""delete_images_for_job: when a position is archived/removed in Odoo, every stored
image (Artifact row + storage file) for every run tied to that job_id must be deleted
— across BOTH shapes job_id is stamped in (origin.job_payload.job_id for webhook-fired
runs, origin.pipeline.job_id for recruiter_* pipeline sub-runs) — and runs for a
DIFFERENT job_id must be left untouched.
"""
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.models.run import ExecutionRun
from services.artifact_service import ArtifactService
from services.recruiter_pipeline_service import RecruiterPipelineService


async def _make_run(db_session: AsyncSession, origin: dict) -> ExecutionRun:
    run = ExecutionRun(id=uuid.uuid4(), workflow_id="w", status="completed", origin=origin)
    db_session.add(run)
    await db_session.flush()
    return run


@pytest.mark.asyncio
async def test_delete_images_for_job_covers_both_origin_shapes_and_spares_other_jobs(
    db_session: AsyncSession, monkeypatch, tmp_path,
):
    monkeypatch.setattr(settings, "storage_path", str(tmp_path))

    run_job_payload = await _make_run(db_session, {"job_payload": {"job_id": "336"}})
    run_pipeline = await _make_run(db_session, {"pipeline": {"job_id": "336"}})
    run_other_job = await _make_run(db_session, {"pipeline": {"job_id": "999"}})

    artifacts = ArtifactService(db_session)
    a1 = await artifacts.store_artifact(str(run_job_payload.id), 0, "page_capture", b"png-a", "image/png")
    a2 = await artifacts.store_artifact(str(run_pipeline.id), 0, "page_capture", b"png-b", "image/png")
    a3 = await artifacts.store_artifact(str(run_other_job.id), 0, "page_capture", b"png-c", "image/png")
    await db_session.flush()

    assert artifacts.storage.fs.exists(a1.file_path)
    assert artifacts.storage.fs.exists(a2.file_path)
    assert artifacts.storage.fs.exists(a3.file_path)

    svc = RecruiterPipelineService(db_session)
    result = await svc.delete_images_for_job("336", reason="archived")

    assert result == {"job_id": "336", "runs_affected": 2, "images_deleted": 2}
    assert not artifacts.storage.fs.exists(a1.file_path)
    assert not artifacts.storage.fs.exists(a2.file_path)
    # The other job's image is untouched.
    assert artifacts.storage.fs.exists(a3.file_path)
    remaining = await artifacts.list_artifacts(str(run_other_job.id))
    assert len(remaining) == 1


@pytest.mark.asyncio
async def test_delete_images_for_job_no_matching_runs(db_session: AsyncSession, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "storage_path", str(tmp_path))
    svc = RecruiterPipelineService(db_session)
    result = await svc.delete_images_for_job("no-such-job")
    assert result == {"job_id": "no-such-job", "runs_affected": 0, "images_deleted": 0}
