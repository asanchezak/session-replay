"""Remove-from-project (archive) flow in RecruiterPipelineService.

Deleting an Odoo linkedin.lead archives the candidate from the LinkedIn project,
and only on VERIFIED removal does the backend delete the Odoo lead. These tests pin:
  - remove_candidate enqueues an archive run (or skips without a name/project)
  - _after_archive deletes the Odoo lead only when the strategy confirmed removal
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from services.recruiter_pipeline_service import EVENT_ARCHIVE, RecruiterPipelineService


def _svc(db_session, monkeypatch):
    svc = RecruiterPipelineService(db_session)
    monkeypatch.setattr(settings, "recruiter_archive_candidate_workflow_id", "arch-wf")
    return svc


@pytest.mark.asyncio
async def test_remove_candidate_enqueues_archive_run(db_session: AsyncSession, monkeypatch):
    svc = _svc(db_session, monkeypatch)
    svc._create_pipeline_run = AsyncMock(return_value=SimpleNamespace(id="arch-run"))
    run_id = await svc.remove_candidate(
        "323",
        profile_url="https://www.linkedin.com/talent/profile/AAA",
        name="Jane Doe",
        project_url="https://www.linkedin.com/talent/hire/999/discover/recruiterSearch",
        connector_id="c1",
    )
    assert run_id == "arch-run"
    kwargs = svc._create_pipeline_run.await_args.kwargs
    assert kwargs["event_kind"] == EVENT_ARCHIVE
    assert kwargs["runtime_params"]["candidate_name"] == "Jane Doe"
    # project_url is normalized through to the run (id parsed into pipeline).
    assert kwargs["pipeline"]["project_id"] == "999"
    assert kwargs["pipeline"]["profile_url"].endswith("/AAA")


@pytest.mark.asyncio
async def test_remove_candidate_skips_without_name(db_session: AsyncSession, monkeypatch):
    svc = _svc(db_session, monkeypatch)
    svc._create_pipeline_run = AsyncMock()
    run_id = await svc.remove_candidate(
        "323", profile_url="https://x/talent/profile/AAA", name="",
        project_url="https://www.linkedin.com/talent/hire/999/manage/all",
    )
    assert run_id is None
    svc._create_pipeline_run.assert_not_called()


@pytest.mark.asyncio
async def test_remove_candidate_skips_when_unconfigured(db_session: AsyncSession, monkeypatch):
    svc = RecruiterPipelineService(db_session)
    monkeypatch.setattr(settings, "recruiter_archive_candidate_workflow_id", "")
    svc._create_pipeline_run = AsyncMock()
    run_id = await svc.remove_candidate("323", name="Jane", project_url="https://x/talent/hire/9/manage/all")
    assert run_id is None
    svc._create_pipeline_run.assert_not_called()


@pytest.mark.asyncio
async def test_after_archive_deletes_lead_when_verified(db_session: AsyncSession, monkeypatch):
    svc = RecruiterPipelineService(db_session)
    svc.push = SimpleNamespace(
        read_archive_result=AsyncMock(return_value={"archived": True, "verified_gone": True}),
        push_lead_removed=AsyncMock(return_value={"pushed": 1, "deleted": 1}),
    )
    run = SimpleNamespace(id="arch-run")
    pipeline = {"profile_url": "https://x/talent/profile/AAA", "candidate_name": "Jane"}
    res = await svc._after_archive(run, pipeline, connector_id="c1", job_id="323")
    assert res["removed"] is True
    svc.push.push_lead_removed.assert_awaited_once()


@pytest.mark.asyncio
async def test_after_archive_keeps_lead_when_unverified(db_session: AsyncSession, monkeypatch):
    svc = RecruiterPipelineService(db_session)
    svc.push = SimpleNamespace(
        read_archive_result=AsyncMock(return_value={"archived": False, "verified_gone": False, "reason": "still_present_after_archive"}),
        push_lead_removed=AsyncMock(),
    )
    run = SimpleNamespace(id="arch-run")
    pipeline = {"profile_url": "https://x/talent/profile/AAA", "candidate_name": "Jane"}
    res = await svc._after_archive(run, pipeline, connector_id="c1", job_id="323")
    assert res["removed"] is False
    svc.push.push_lead_removed.assert_not_called()
