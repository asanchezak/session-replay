"""Calibration / finalize decision in RecruiterPipelineService._after_search.

The pipeline tightens the boolean to shrink an over-broad search, but must NOT
mechanically burn every rerun: it finalizes once the count is acceptable or once
tightening stops converging. These tests pin that decision logic.
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from services.recruiter_pipeline_service import RecruiterPipelineService


class _FakeBuilder:
    """Stand-in for BooleanQueryBuilder so the test controls tightness bounds."""

    def max_tightness(self, spec):
        return 6

    def assemble(self, spec, tightness):
        return f"QUERY@t{tightness}"


def _make_svc(db_session, monkeypatch, *, count, pipeline_extra=None):
    svc = RecruiterPipelineService(db_session)
    # Isolate collaborators.
    svc.push = SimpleNamespace(
        read_search_result=AsyncMock(return_value={"total_count": count, "url": "https://x/search?start=0"}),
        push_search_link=AsyncMock(return_value={"pushed": 1}),
        push_recruiter_leads=AsyncMock(return_value={"leads": []}),
    )
    svc._create_pipeline_run = AsyncMock(return_value=SimpleNamespace(id="rerun-run-id"))
    # Deterministic config + a builder we control.
    monkeypatch.setattr(settings, "recruiter_advanced_search_workflow_id", "adv-wf")
    monkeypatch.setattr(settings, "recruiter_save_workflow_id", "")
    monkeypatch.setattr(settings, "recruiter_save_results_workflow_id", "")
    monkeypatch.setattr(settings, "recruiter_count_acceptable_max", 150)
    monkeypatch.setattr(settings, "recruiter_count_band_min", 10)
    monkeypatch.setattr(settings, "recruiter_count_min_convergence", 0.2)
    monkeypatch.setattr(settings, "recruiter_max_search_reruns", 2)
    monkeypatch.setattr(
        "services.boolean_query_builder.BooleanQueryBuilder", _FakeBuilder
    )
    pipeline = {
        "job_id": "1", "search_spec": {"core": ["x"]}, "search_tightness": 2,
        "search_reruns": 0, "search_query": "QUERY@t2",
    }
    pipeline.update(pipeline_extra or {})
    run = SimpleNamespace(id="search-run-id")
    return svc, run, pipeline


@pytest.mark.asyncio
async def test_finalizes_when_count_acceptable_no_rerun(db_session: AsyncSession, monkeypatch):
    """Count at/below the acceptable ceiling → finalize, never re-run."""
    svc, run, pipeline = _make_svc(db_session, monkeypatch, count=120)
    res = await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    assert not res.get("calibrating")
    svc._create_pipeline_run.assert_not_called()
    svc.push.push_recruiter_leads.assert_awaited_once()


@pytest.mark.asyncio
async def test_reruns_when_too_high_and_converging(db_session: AsyncSession, monkeypatch):
    """Way over the ceiling on the first pass (no prev) → tighten + re-run once."""
    svc, run, pipeline = _make_svc(db_session, monkeypatch, count=460)
    res = await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    assert res.get("calibrating") is True
    svc._create_pipeline_run.assert_awaited_once()
    # carries the convergence anchor forward for the next pass
    _, kwargs = svc._create_pipeline_run.await_args
    assert kwargs["pipeline"]["search_prev_count"] == 460
    assert kwargs["pipeline"]["search_tightness"] == 3


@pytest.mark.asyncio
async def test_finalizes_when_tightening_saturated(db_session: AsyncSession, monkeypatch):
    """Still above the ceiling but the last tighten barely moved the count
    (200→190 = 5% < 20% min_convergence) → stop, do NOT burn the rerun."""
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch, count=190, pipeline_extra={"search_prev_count": 200, "search_reruns": 1},
    )
    res = await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    assert not res.get("calibrating")
    svc._create_pipeline_run.assert_not_called()
    svc.push.push_recruiter_leads.assert_awaited_once()


@pytest.mark.asyncio
async def test_finalizes_when_reruns_exhausted(db_session: AsyncSession, monkeypatch):
    """Hard cap still honored: at max reruns, finalize even if over the ceiling."""
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch, count=400, pipeline_extra={"search_reruns": 2},
    )
    res = await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    assert not res.get("calibrating")
    svc._create_pipeline_run.assert_not_called()


@pytest.mark.asyncio
async def test_bulk_save_fires_one_run(db_session: AsyncSession, monkeypatch):
    """When recruiter_save_results_workflow_id is set, finalize fires ONE bulk
    results-page save run (search_url + target_count), not N per-candidate runs."""
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch, count=120,
        pipeline_extra={"project_name": "-EZ Role", "candidate_count": 3},
    )
    svc.push.push_recruiter_leads = AsyncMock(return_value={"leads": [
        {"profile_url": "https://x/talent/profile/a"},
        {"profile_url": "https://x/talent/profile/b"},
    ]})
    monkeypatch.setattr(settings, "recruiter_save_results_workflow_id", "bulk-wf")
    monkeypatch.setattr(settings, "recruiter_max_saves_per_position", 5)

    res = await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    assert res.get("bulk_save") is True
    svc._create_pipeline_run.assert_awaited_once()
    _, kwargs = svc._create_pipeline_run.await_args
    assert kwargs["workflow_id"] == "bulk-wf"
    assert kwargs["runtime_params"]["search_url"] == "https://x/search?start=0"
    assert kwargs["runtime_params"]["target_count"] == 2
    assert kwargs["runtime_params"]["project_name"] == "-EZ Role"


@pytest.mark.asyncio
async def test_per_candidate_fallback_when_no_bulk_wf(db_session: AsyncSession, monkeypatch):
    """No bulk wf but a per-profile save wf → one save run PER candidate."""
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch, count=120,
        pipeline_extra={"project_name": "-EZ Role", "candidate_count": 2},
    )
    svc.push.push_recruiter_leads = AsyncMock(return_value={"leads": [
        {"profile_url": "https://x/talent/profile/a"},
        {"profile_url": "https://x/talent/profile/b"},
    ]})
    monkeypatch.setattr(settings, "recruiter_save_results_workflow_id", "")
    monkeypatch.setattr(settings, "recruiter_save_workflow_id", "save-wf")
    monkeypatch.setattr(settings, "recruiter_max_saves_per_position", 5)

    res = await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    assert not res.get("bulk_save")
    assert svc._create_pipeline_run.await_count == 2
