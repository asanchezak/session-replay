"""Seat-gate resilience: trigger dedup (Part E) + walled auto-relaunch cap (Part C).

These pin the "queue-and-drain when the seat is cold" behavior on the backend side:
- _create_pipeline_run collapses onto an already-queued run instead of duplicating.
- ExecutionService.auto_relaunch / _maybe_auto_relaunch_walled only retries walled
  failures and respects the per-run cap (no infinite loop).
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import services.recruiter_pipeline_service as rps
from services.execution_service import ExecutionService
from services.recruiter_pipeline_service import EVENT_MESSAGE, RecruiterPipelineService


@pytest.mark.asyncio
async def test_create_pipeline_run_dedups_onto_existing(db_session):
    """When an active run of the scoped kind exists, return it — don't create a dupe."""
    svc = RecruiterPipelineService(db_session)
    existing = SimpleNamespace(id="existing-run")
    svc._find_active_pipeline_run = AsyncMock(return_value=existing)
    svc.exec_svc = SimpleNamespace(create_run=AsyncMock())

    run = await svc._create_pipeline_run(
        workflow_id="wf", event_kind=EVENT_MESSAGE, runtime_params={},
        pipeline={"job_id": "1"}, connector_id="c1",
        dedup_event_kinds={EVENT_MESSAGE},
    )

    assert run is existing
    svc.exec_svc.create_run.assert_not_called()
    svc._find_active_pipeline_run.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_pipeline_run_creates_when_none_active(db_session, monkeypatch):
    """No active run → create a fresh one (dedup is a no-op)."""
    svc = RecruiterPipelineService(db_session)
    svc._find_active_pipeline_run = AsyncMock(return_value=None)
    new_run = SimpleNamespace(id="new-run", origin=None, workflow_snapshot={})
    svc.exec_svc = SimpleNamespace(create_run=AsyncMock(return_value=new_run))
    svc._maybe_note_seat_unavailable = AsyncMock()
    # flag_modified requires a mapped instance; our stub isn't one.
    monkeypatch.setattr(rps, "flag_modified", lambda *a, **k: None)

    run = await svc._create_pipeline_run(
        workflow_id="wf", event_kind=EVENT_MESSAGE, runtime_params={},
        pipeline={"job_id": "1"}, connector_id="c1",
        dedup_event_kinds={EVENT_MESSAGE},
    )

    assert run is new_run
    svc.exec_svc.create_run.assert_awaited_once()


@pytest.mark.asyncio
async def test_auto_relaunch_respects_cap(db_session):
    """At the cap, auto_relaunch does nothing (no infinite retry loop)."""
    svc = ExecutionService(db_session)
    run = SimpleNamespace(
        id="r1", origin={"auto_relaunch_count": ExecutionService.MAX_AUTO_RELAUNCH},
    )
    assert await svc.auto_relaunch(run) is None


@pytest.mark.asyncio
async def test_maybe_auto_relaunch_skips_non_walled(db_session):
    """A non-walled failure is surfaced normally (not auto-relaunched)."""
    svc = ExecutionService(db_session)
    run = SimpleNamespace(
        id="r1", origin={}, error_summary="selector not found on results page",
    )
    assert await svc._maybe_auto_relaunch_walled(run) is False


@pytest.mark.asyncio
async def test_maybe_auto_relaunch_relaunches_walled(db_session, monkeypatch):
    """A walled failure below the cap triggers auto_relaunch."""
    svc = ExecutionService(db_session)
    run = SimpleNamespace(
        id="r1", origin={},
        error_summary="Recruiter seat walled — re-login (login-talent.bat)",
    )
    svc.auto_relaunch = AsyncMock(return_value=SimpleNamespace(id="clone"))

    assert await svc._maybe_auto_relaunch_walled(run) is True
    svc.auto_relaunch.assert_awaited_once()
