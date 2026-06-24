"""Candidate notes PUSH orchestration in RecruiterPipelineService (push-only).

The recruiter writes notes on a linkedin.candidate in Odoo; "Sync notes" pushes each unsynced
note to LinkedIn by selecting the candidate (by name) in a project pipeline and adding the note
(strategy recruiter_candidate_note_add). These tests pin the backend orchestration (the seat
interaction is covered live):
  - sync_candidate_notes gates on workflow id / name / project_url and enqueues ONE run per note
  - _after_notes_sync marks the Odoo note synced (push_candidate_notes pushed=[id]) only on save
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from services.recruiter_pipeline_service import EVENT_NOTES_SYNC, RecruiterPipelineService

PURL = "https://www.linkedin.com/in/jane-doe-123"
PROJ = "https://www.linkedin.com/talent/hire/999/manage/all"


@pytest.mark.asyncio
async def test_sync_notes_skips_when_unconfigured(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr(settings, "recruiter_notes_sync_workflow_id", "")
    svc = RecruiterPipelineService(db_session)
    svc._create_pipeline_run = AsyncMock()
    res = await svc.sync_candidate_notes(profile_url=PURL, name="Jane", project_url=PROJ,
                                         odoo_notes=[{"id": 1, "body": "x"}])
    assert res["status"] == "not_configured"
    svc._create_pipeline_run.assert_not_called()


@pytest.mark.asyncio
async def test_sync_notes_requires_project_url(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr(settings, "recruiter_notes_sync_workflow_id", "notes-wf")
    svc = RecruiterPipelineService(db_session)
    svc._create_pipeline_run = AsyncMock()
    res = await svc.sync_candidate_notes(profile_url=PURL, name="Jane", project_url=None,
                                         odoo_notes=[{"id": 1, "body": "x"}])
    assert res["status"] == "error" and "project" in res["reason"]
    svc._create_pipeline_run.assert_not_called()


@pytest.mark.asyncio
async def test_sync_notes_noop_without_unsynced(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr(settings, "recruiter_notes_sync_workflow_id", "notes-wf")
    svc = RecruiterPipelineService(db_session)
    svc._latest_recruiter_connector = AsyncMock(return_value="c1")
    svc._create_pipeline_run = AsyncMock()
    res = await svc.sync_candidate_notes(profile_url=PURL, name="Jane", project_url=PROJ, odoo_notes=[])
    assert res["status"] == "noop"
    svc._create_pipeline_run.assert_not_called()


@pytest.mark.asyncio
async def test_sync_notes_enqueues_one_run_per_note(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr(settings, "recruiter_notes_sync_workflow_id", "notes-wf")
    svc = RecruiterPipelineService(db_session)
    svc._create_pipeline_run = AsyncMock(side_effect=[
        SimpleNamespace(id="r1"), SimpleNamespace(id="r2"),
    ])
    res = await svc.sync_candidate_notes(
        profile_url=PURL, candidate_id=7, name="Jane Doe", connector_id="c1", project_url=PROJ,
        odoo_notes=[{"id": 11, "body": "great fit"}, {"id": 12, "body": "follow up"}, {"id": 13, "body": "  "}],
    )
    assert res == {"status": "queued", "run_ids": ["r1", "r2"], "count": 2}  # blank-body note skipped
    first = svc._create_pipeline_run.await_args_list[0].kwargs
    assert first["event_kind"] == EVENT_NOTES_SYNC
    assert first["runtime_params"] == {
        "project_url": PROJ, "candidate_name": "Jane Doe", "note_text": "great fit", "save": "true",
    }
    assert first["pipeline"]["note_id"] == 11


@pytest.mark.asyncio
async def test_after_notes_sync_marks_synced_on_save(db_session: AsyncSession, monkeypatch):
    svc = RecruiterPipelineService(db_session)
    svc.push = SimpleNamespace(
        read_candidate_note_add_result=AsyncMock(return_value={"ok": True, "saved": True}),
        push_candidate_notes=AsyncMock(return_value={"pushed": 1}),
    )
    run = SimpleNamespace(id="r1")
    pipeline = {"profile_url": PURL, "note_id": 11, "candidate_name": "Jane"}
    out = await svc._after_notes_sync(run, pipeline, "c1", None)
    assert out["saved"] is True and out["note_id"] == 11
    kw = svc.push.push_candidate_notes.await_args.kwargs
    assert kw["pushed"] == [11] and kw["notes"] == [] and kw["profile_url"] == PURL


@pytest.mark.asyncio
async def test_after_notes_sync_leaves_unsynced_when_not_saved(db_session: AsyncSession, monkeypatch):
    svc = RecruiterPipelineService(db_session)
    svc.push = SimpleNamespace(
        read_candidate_note_add_result=AsyncMock(return_value={"ok": False, "reason": "candidate_not_found"}),
        push_candidate_notes=AsyncMock(),
    )
    run = SimpleNamespace(id="r1")
    out = await svc._after_notes_sync(run, {"profile_url": PURL, "note_id": 11}, "c1", None)
    assert out["saved"] is False and out["reason"] == "candidate_not_found"
    svc.push.push_candidate_notes.assert_not_called()
