"""Candidate notes-sync orchestration in RecruiterPipelineService.

A candidate's GLOBAL notes round-trip with LinkedIn Recruiter notes on-demand. These tests
pin the backend orchestration (the LinkedIn DOM strategy is Phase 2, seat-gated):
  - sync_candidate_notes gates on the workflow id (not_configured) and otherwise enqueues a
    notes-sync run with the right event_kind + params
  - _after_notes_sync reads the run's notes_sync_result and pushes both the pulled notes and
    the pushed-note ids to akcr, falling back to the requested ids when the strategy is silent
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from services.recruiter_pipeline_service import EVENT_NOTES_SYNC, RecruiterPipelineService

PURL = "https://www.linkedin.com/in/jane-doe-123"


@pytest.mark.asyncio
async def test_sync_notes_skips_when_unconfigured(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr(settings, "recruiter_notes_sync_workflow_id", "")
    svc = RecruiterPipelineService(db_session)
    svc._create_pipeline_run = AsyncMock()
    res = await svc.sync_candidate_notes(profile_url=PURL, candidate_id=649, name="Jane")
    assert res["status"] == "not_configured"
    svc._create_pipeline_run.assert_not_called()


@pytest.mark.asyncio
async def test_sync_notes_requires_profile_url(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr(settings, "recruiter_notes_sync_workflow_id", "notes-wf")
    svc = RecruiterPipelineService(db_session)
    svc._create_pipeline_run = AsyncMock()
    res = await svc.sync_candidate_notes(profile_url="", candidate_id=1)
    assert res["status"] == "error"
    svc._create_pipeline_run.assert_not_called()


@pytest.mark.asyncio
async def test_sync_notes_enqueues_run(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr(settings, "recruiter_notes_sync_workflow_id", "notes-wf")
    svc = RecruiterPipelineService(db_session)
    svc._create_pipeline_run = AsyncMock(return_value=SimpleNamespace(id="notes-run"))
    res = await svc.sync_candidate_notes(
        profile_url=PURL, candidate_id=649, name="Jane", connector_id="c1",
        odoo_notes=[{"id": 7, "body": "great fit"}, {"id": 8, "body": "follow up"}],
    )
    assert res == {"status": "queued", "run_id": "notes-run"}
    kwargs = svc._create_pipeline_run.await_args.kwargs
    assert kwargs["event_kind"] == EVENT_NOTES_SYNC
    assert kwargs["workflow_id"] == "notes-wf"
    assert kwargs["runtime_params"]["profile_url"] == PURL
    # the bodies to add are threaded to the strategy as a JSON string
    assert "great fit" in kwargs["runtime_params"]["notes_to_add"]
    assert kwargs["pipeline"]["odoo_notes"][0]["id"] == 7


@pytest.mark.asyncio
async def test_after_notes_sync_pushes_read_and_pushed(db_session: AsyncSession, monkeypatch):
    svc = RecruiterPipelineService(db_session)
    pulled = [{"body": "LinkedIn note", "key": "k1"}]
    svc.push = SimpleNamespace(
        read_notes_sync_result=AsyncMock(
            return_value={"profile_url": PURL, "notes": pulled, "pushed": [7]}
        ),
        push_candidate_notes=AsyncMock(return_value={"pushed": 1, "created": 1, "matched": 0}),
    )
    run = SimpleNamespace(id="notes-run")
    pipeline = {"profile_url": PURL, "odoo_notes": [{"id": 7, "body": "x"}]}
    out = await svc._after_notes_sync(run, pipeline, "c1", None)
    assert out["stage"] == "notes_sync"
    assert out["read"] == 1 and out["pushed"] == 1
    kwargs = svc.push.push_candidate_notes.await_args.kwargs
    assert kwargs["profile_url"] == PURL
    assert kwargs["notes"] == pulled
    assert kwargs["pushed"] == [7]


@pytest.mark.asyncio
async def test_after_notes_sync_falls_back_to_requested_pushed_ids(
    db_session: AsyncSession, monkeypatch
):
    """When the strategy doesn't echo which notes it pushed, mark the ones we asked it to."""
    svc = RecruiterPipelineService(db_session)
    svc.push = SimpleNamespace(
        read_notes_sync_result=AsyncMock(return_value={"notes": []}),  # no 'pushed' key
        push_candidate_notes=AsyncMock(return_value={"pushed": 2}),
    )
    run = SimpleNamespace(id="notes-run")
    pipeline = {"profile_url": PURL, "odoo_notes": [{"id": 7}, {"id": 8}, {"body": "no id"}]}
    out = await svc._after_notes_sync(run, pipeline, "c1", None)
    assert out["pushed"] == 2
    assert svc.push.push_candidate_notes.await_args.kwargs["pushed"] == [7, 8]
