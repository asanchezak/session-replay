"""Blacklist enforcement in the recruiter push + pipeline services.

Pins the three enforcement points:
  - push_recruiter_leads pre-filters blocked people out of the leads (and returns
    them under "blacklisted" so the caller can sweep)
  - sweep_blacklisted enqueues bounded, deduped archive runs
  - send_messages defers while a blacklist/archive sweep is still pending
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from services.blacklist_matcher import BlacklistMatcher
from services.recruiter_pipeline_service import RecruiterPipelineService
from services.recruiter_push_service import RecruiterPushService


# --------------------------------------------------------------- pre-filter

@pytest.mark.asyncio
async def test_push_recruiter_leads_prefilters_blacklisted(db_session: AsyncSession):
    svc = RecruiterPushService(db_session)
    svc._collect_recruiter_leads = AsyncMock(return_value=[
        {"profile_url": "https://x/talent/profile/AAA", "name": "Jane Doe", "headline": ""},
        {"profile_url": "https://x/talent/profile/BBB", "name": "John Ok", "headline": ""},
    ])
    matcher = BlacklistMatcher([{"name": "Jane Doe", "normalized_name": "jane doe"}])
    # job_id=None → returns before any Odoo POST, but AFTER the filter.
    res = await svc.push_recruiter_leads(
        run_id="r1", job_id=None, connector_id="c", blacklist=matcher,
    )
    assert [l["name"] for l in res["leads"]] == ["John Ok"]
    assert [b["name"] for b in res["blacklisted"]] == ["Jane Doe"]
    assert res["blacklisted"][0]["match_reason"] == "name"


@pytest.mark.asyncio
async def test_push_recruiter_leads_no_matcher_keeps_all(db_session: AsyncSession):
    svc = RecruiterPushService(db_session)
    svc._collect_recruiter_leads = AsyncMock(return_value=[
        {"profile_url": "https://x/talent/profile/AAA", "name": "Jane Doe", "headline": ""},
    ])
    res = await svc.push_recruiter_leads(run_id="r1", job_id=None, connector_id="c")
    assert len(res["leads"]) == 1
    assert res["blacklisted"] == []


@pytest.mark.asyncio
async def test_push_recruiter_leads_all_blacklisted_returns_no_leads(db_session: AsyncSession):
    svc = RecruiterPushService(db_session)
    svc._collect_recruiter_leads = AsyncMock(return_value=[
        {"profile_url": "https://x/talent/profile/AAA", "name": "Jane Doe", "headline": ""},
    ])
    matcher = BlacklistMatcher([{"name": "Jane Doe", "normalized_name": "jane doe"}])
    res = await svc.push_recruiter_leads(
        run_id="r1", job_id="1", connector_id="c", blacklist=matcher,
    )
    assert res["leads"] == []
    assert res["skipped"] == "no_leads"
    assert [b["name"] for b in res["blacklisted"]] == ["Jane Doe"]


# --------------------------------------------------------------- sweep

@pytest.mark.asyncio
async def test_sweep_enqueues_capped(db_session: AsyncSession, monkeypatch):
    svc = RecruiterPipelineService(db_session)
    monkeypatch.setattr(settings, "recruiter_max_sweep_archives_per_run", 2)
    svc._recently_archived_names = AsyncMock(return_value=set())
    svc.remove_candidate = AsyncMock(return_value="arch-run")
    blacklisted = [
        {"name": "A One", "profile_url": "u1"},
        {"name": "B Two", "profile_url": "u2"},
        {"name": "C Three", "profile_url": "u3"},
    ]
    res = await svc.sweep_blacklisted(
        "1", blacklisted=blacklisted, connector_id="c",
        project_url="https://x/talent/hire/9/manage/all", pipeline={},
    )
    assert res["enqueued"] == 2
    assert res["remainder"] == 1
    assert svc.remove_candidate.await_count == 2
    # Sweep archives are tagged so a failure won't flip the Odoo position to failed.
    assert svc.remove_candidate.await_args.kwargs.get("sweep") is True


@pytest.mark.asyncio
async def test_sweep_dedups_recently_archived(db_session: AsyncSession, monkeypatch):
    svc = RecruiterPipelineService(db_session)
    monkeypatch.setattr(settings, "recruiter_max_sweep_archives_per_run", 10)
    svc._recently_archived_names = AsyncMock(return_value={"jane doe"})
    svc.remove_candidate = AsyncMock(return_value="arch-run")
    res = await svc.sweep_blacklisted(
        "1", blacklisted=[{"name": "Jane Doe", "profile_url": "u1"},
                          {"name": "New Person", "profile_url": "u2"}],
        connector_id="c", project_url="https://x/talent/hire/9/manage/all", pipeline={},
    )
    assert res["enqueued"] == 1
    assert res["skipped_seen"] == 1
    svc.remove_candidate.assert_awaited_once()
    assert svc.remove_candidate.await_args.kwargs["name"] == "New Person"


@pytest.mark.asyncio
async def test_sweep_skips_nameless(db_session: AsyncSession, monkeypatch):
    svc = RecruiterPipelineService(db_session)
    monkeypatch.setattr(settings, "recruiter_max_sweep_archives_per_run", 10)
    svc._recently_archived_names = AsyncMock(return_value=set())
    svc.remove_candidate = AsyncMock(return_value="arch-run")
    res = await svc.sweep_blacklisted(
        "1", blacklisted=[{"name": "", "profile_url": "u1"}],
        connector_id="c", project_url="https://x/talent/hire/9/manage/all", pipeline={},
    )
    assert res["enqueued"] == 0
    assert res["no_name"] == 1
    svc.remove_candidate.assert_not_called()


# --------------------------------------------------------------- send-time gate

def _msg_svc(db_session, monkeypatch):
    svc = RecruiterPipelineService(db_session)
    monkeypatch.setattr(settings, "recruiter_message_workflow_id", "msg-wf")
    svc._gather_job_context = AsyncMock(return_value={
        "project_id": "9", "connector_id": "c", "position": "Dev", "project_name": "-EZ Dev",
    })
    svc._default_note_text = AsyncMock(return_value="note")
    svc._push_flow_status = AsyncMock(return_value={})
    svc._create_pipeline_run = AsyncMock(return_value=SimpleNamespace(id="msg-run"))
    return svc


@pytest.mark.asyncio
async def test_send_defers_when_archive_pending(db_session: AsyncSession, monkeypatch):
    svc = _msg_svc(db_session, monkeypatch)
    svc._find_active_pipeline_run = AsyncMock(return_value=SimpleNamespace(id="arch-run"))
    out = await svc.send_messages("1", subject="s", body="b", send=True)
    assert out is None
    svc._create_pipeline_run.assert_not_called()


@pytest.mark.asyncio
async def test_send_proceeds_when_no_archive_pending(db_session: AsyncSession, monkeypatch):
    svc = _msg_svc(db_session, monkeypatch)
    svc._find_active_pipeline_run = AsyncMock(return_value=None)
    out = await svc.send_messages("1", subject="s", body="b", send=True)
    assert out == "msg-run"
    svc._create_pipeline_run.assert_awaited_once()


# ------------------------------------------- notify_failure quiet for sweep archives

@pytest.mark.asyncio
async def test_notify_failure_skips_blacklist_sweep(db_session: AsyncSession):
    svc = RecruiterPipelineService(db_session)
    svc._push_flow_status = AsyncMock()
    run = SimpleNamespace(
        id="arch-run", error_summary="archive_not_verified",
        origin={"event_kind": "recruiter_archive",
                "pipeline": {"job_id": "1", "blacklist_sweep": True}})
    res = await svc.notify_failure(run)
    assert res.get("skipped") == "blacklist_sweep"
    svc._push_flow_status.assert_not_called()


@pytest.mark.asyncio
async def test_notify_failure_marks_normal_archive_failed(db_session: AsyncSession):
    svc = RecruiterPipelineService(db_session)
    svc._push_flow_status = AsyncMock(return_value={"pushed": 1})
    run = SimpleNamespace(
        id="arch-run", error_summary="archive_not_verified",
        origin={"event_kind": "recruiter_archive",
                "pipeline": {"job_id": "1", "connector_id": "c"}})
    await svc.notify_failure(run)
    svc._push_flow_status.assert_awaited_once()
    assert svc._push_flow_status.await_args.kwargs["status"] == "failed"
