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
        push_recruiter_leads=AsyncMock(return_value={"leads": [], "blacklisted": []}),
        push_flow_status=AsyncMock(return_value={"pushed": 1}),
        fetch_lead_blacklist=AsyncMock(return_value=[]),
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
    # The zero-results branch flags run.origin via flag_modified (an ORM helper); the
    # test run is a plain SimpleNamespace, so give it an origin dict and no-op
    # flag_modified.
    monkeypatch.setattr(
        "services.recruiter_pipeline_service.flag_modified", lambda *a, **k: None
    )
    pipeline = {
        "job_id": "1", "search_spec": {"core": ["x"]}, "search_tightness": 2,
        "search_reruns": 0, "search_query": "QUERY@t2",
    }
    pipeline.update(pipeline_extra or {})
    run = SimpleNamespace(id="search-run-id", origin={})
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
        pipeline_extra={"project_name": "EasyRecruit - Role", "candidate_count": 3},
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
    assert kwargs["runtime_params"]["project_name"] == "EasyRecruit - Role"


@pytest.mark.asyncio
async def test_per_candidate_fallback_when_no_bulk_wf(db_session: AsyncSession, monkeypatch):
    """No bulk wf but a per-profile save wf → one save run PER candidate."""
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch, count=120,
        pipeline_extra={"project_name": "EasyRecruit - Role", "candidate_count": 2},
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


@pytest.mark.asyncio
async def test_calibration_stashes_best_search_when_tightening(db_session: AsyncSession, monkeypatch):
    """When a tighten is enqueued, the current (still-non-empty) search is stashed as
    best_search so a later overshoot can fall back to it."""
    svc, run, pipeline = _make_svc(db_session, monkeypatch, count=460)
    await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    _, kwargs = svc._create_pipeline_run.await_args
    best = kwargs["pipeline"]["best_search"]
    assert best["count"] == 460
    assert best["run_id"] == "search-run-id"
    assert best["url"] == "https://x/search?start=0"


@pytest.mark.asyncio
async def test_tighten_overshoot_falls_back_to_best_prior_search(db_session: AsyncSession, monkeypatch):
    """A tighten that overshoots to 0 (below band_min) with reruns exhausted finalizes on
    the best prior search: leads pushed from THAT run + its URL/count on the search link,
    instead of discarding a usable candidate set."""
    best = {"url": "https://x/search?start=0&best=1", "count": 320,
            "query": "QUERY@t3", "run_id": "best-run-id"}
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch, count=0,
        pipeline_extra={"search_reruns": 1, "search_query": "QUERY@t4", "best_search": best},
    )
    monkeypatch.setattr(settings, "recruiter_max_search_reruns", 1)  # exhausted → no rerun
    res = await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    assert not res.get("calibrating")
    svc._create_pipeline_run.assert_not_called()
    # leads pulled from the best prior run, not the empty current one
    _, lead_kwargs = svc.push.push_recruiter_leads.await_args
    assert lead_kwargs["run_id"] == "best-run-id"
    # the search link reflects the best prior search's url + count + query
    _, link_kwargs = svc.push.push_search_link.await_args
    assert link_kwargs["search_url"] == "https://x/search?start=0&best=1"
    assert link_kwargs["count"] == 320
    assert link_kwargs["query"] == "QUERY@t3"


# --------------------------------------------------------------------- geography
# The position's location facet must survive the whole search stage. It did not:
# `latam` was threaded to LinkedIn as the single string "Latin America" (not a
# Recruiter geo → facet silently empty → worldwide results), the calibration rerun
# re-derived the location from a GLOBAL default instead of the position, and the
# overshoot fallback then reverted to whichever earlier search had results — the
# unfaceted one. Jobs 296/297/301 sourced India/Pakistan/Ukraine/Australia/US.


@pytest.mark.asyncio
async def test_rerun_keeps_the_positions_geography_not_the_global_default(
    db_session: AsyncSession, monkeypatch,
):
    """A calibration rerun re-searches with the POSITION's location spec."""
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch, count=460,
        pipeline_extra={"search_location": "Costa Rica;Brazil|Brasil"},
    )
    monkeypatch.setattr(settings, "recruiter_default_location", "Costa Rica")
    await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    _, kwargs = svc._create_pipeline_run.await_args
    assert kwargs["runtime_params"]["location"] == "Costa Rica;Brazil|Brasil"
    # …and it stays on the pipeline for the next hop.
    assert kwargs["pipeline"]["search_location"] == "Costa Rica;Brazil|Brasil"
    assert kwargs["pipeline"]["best_search"]["location"] == "Costa Rica;Brazil|Brasil"


@pytest.mark.asyncio
async def test_rerun_derives_geography_from_job_location_when_not_stashed(
    db_session: AsyncSession, monkeypatch,
):
    """Runs started before the stash existed re-derive from job_location — never from
    recruiter_default_location (that turned a latam search into a CR-only one)."""
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch, count=460, pipeline_extra={"job_location": "latam"},
    )
    monkeypatch.setattr(settings, "recruiter_default_location", "Costa Rica")
    monkeypatch.setattr(settings, "recruiter_location_map",
                        {"cr": "Costa Rica", "latam": "Mexico|México;Colombia", "global": ""})
    await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    _, kwargs = svc._create_pipeline_run.await_args
    assert kwargs["runtime_params"]["location"] == "Mexico|México;Colombia"


@pytest.mark.asyncio
async def test_fallback_refuses_a_prior_search_with_a_different_geography(
    db_session: AsyncSession, monkeypatch,
):
    """The overshoot fallback must not cross facets: a prior search run whose location
    differs (e.g. the one whose facet never applied) is NOT a valid fallback."""
    best = {"url": "https://x/search?start=0&best=1", "count": 15000,
            "query": "QUERY@t3", "run_id": "unfaceted-run-id", "location": ""}
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch, count=4,
        pipeline_extra={"search_reruns": 1, "search_query": "QUERY@t4",
                        "best_search": best, "search_location": "Costa Rica"},
    )
    monkeypatch.setattr(settings, "recruiter_max_search_reruns", 1)
    await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    # finalize on THIS run (4 correctly-faceted results), not the worldwide 15 000
    _, lead_kwargs = svc.push.push_recruiter_leads.await_args
    assert lead_kwargs["run_id"] == "search-run-id"
    _, link_kwargs = svc.push.push_search_link.await_args
    assert link_kwargs["count"] == 4
    # the summary reports the facet actually used
    assert link_kwargs["filters"] == "Location: Costa Rica"


@pytest.mark.asyncio
async def test_fallback_allowed_when_the_geography_matches(
    db_session: AsyncSession, monkeypatch,
):
    """Same geography on both searches → the overshoot fallback still works."""
    best = {"url": "https://x/search?start=0&best=1", "count": 320, "query": "QUERY@t3",
            "run_id": "best-run-id", "location": "Costa Rica"}
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch, count=0,
        pipeline_extra={"search_reruns": 1, "search_query": "QUERY@t4",
                        "best_search": best, "search_location": "Costa Rica"},
    )
    monkeypatch.setattr(settings, "recruiter_max_search_reruns", 1)
    await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    _, lead_kwargs = svc.push.push_recruiter_leads.await_args
    assert lead_kwargs["run_id"] == "best-run-id"


def test_location_label_renders_the_first_spelling_of_each_place():
    """Odoo shows the facet in prose — not the raw ";"/"|" spec."""
    label = RecruiterPipelineService._location_label
    assert label("Costa Rica;Brazil|Brasil;Mexico|México") == "Costa Rica, Brazil, Mexico"
    assert label("") == ""


# ------------------------------------------------------- per-position geography
# A position can hire in a SUBSET of its region while Odoo's job_location selection
# only offers cr/latam/global (job 296: data engineers in Colombia, Mexico, Costa
# Rica, Brasil and Peru only, though the position is LATAM).


def test_per_position_override_wins_over_the_job_location_map(monkeypatch):
    svc = RecruiterPipelineService.__new__(RecruiterPipelineService)
    monkeypatch.setattr(settings, "recruiter_location_map",
                        {"cr": "Costa Rica", "latam": "A;B;C", "global": ""})
    monkeypatch.setattr(settings, "recruiter_job_locations",
                        '{"296": "Colombia;Mexico;Costa Rica;Brasil|Brazil;Peru"}')
    assert svc._resolve_search_location("latam", 296) == "Colombia;Mexico;Costa Rica;Brasil|Brazil;Peru"
    assert svc._resolve_search_location("latam", "296") == "Colombia;Mexico;Costa Rica;Brasil|Brazil;Peru"
    # every OTHER position still gets its region
    assert svc._resolve_search_location("latam", 297) == "A;B;C"
    # …and an override must never leak into a call that has no job id
    assert svc._resolve_search_location("latam") == "A;B;C"


def test_geography_falls_back_cleanly(monkeypatch):
    svc = RecruiterPipelineService.__new__(RecruiterPipelineService)
    monkeypatch.setattr(settings, "recruiter_location_map",
                        {"cr": "Costa Rica", "latam": "A;B", "global": ""})
    monkeypatch.setattr(settings, "recruiter_default_location", "Costa Rica")
    # `global` is a KNOWN mapping to "" — skip the facet, don't fall back to the default
    monkeypatch.setattr(settings, "recruiter_job_locations", "")
    assert svc._resolve_search_location("global", 284) == ""
    # unknown/empty job_location → the default
    assert svc._resolve_search_location("", 1) == "Costa Rica"
    assert svc._resolve_search_location("mars", 1) == "Costa Rica"
    # a blank override is not an override
    monkeypatch.setattr(settings, "recruiter_job_locations", '{"1": "   "}')
    assert svc._resolve_search_location("latam", 1) == "A;B"
    # malformed JSON must not take the pipeline down
    monkeypatch.setattr(settings, "recruiter_job_locations", "{not json")
    assert svc._resolve_search_location("latam", 1) == "A;B"


def test_latam_covers_the_countries_the_client_asked_for():
    """Regression guard on the shipped list: the five markets the data position needs,
    plus the rest of LATAM, and never the string that started all this."""
    latam = settings.recruiter_location_map["latam"]
    places = [p.split("|")[0] for p in latam.split(";")]
    for c in ("Colombia", "México", "Costa Rica", "Brasil", "Perú"):
        assert c in places, f"{c} missing from the LATAM facet spec"
    assert len(places) == 18
    assert "Latin America" not in latam


def test_language_requirement_is_threaded_into_every_search(monkeypatch):
    """"Que sepan inglés" must ride on EVERY search — first pass, calibration rerun and
    the count-only preview — or a rerun would quietly drop the requirement."""
    monkeypatch.setattr(settings, "recruiter_search_language", "Inglés|English")
    monkeypatch.setattr(settings, "recruiter_search_language_proficiency", "Nivel profesional avanzado|Full Professional")
    monkeypatch.setattr(settings, "recruiter_search_language_mode", "Debe tener|Must have")
    p = RecruiterPipelineService._language_params()
    assert p == {"language": "Inglés|English",
                 "language_proficiency": "Nivel profesional avanzado|Full Professional",
                 "language_mode": "Debe tener|Must have"}
    # switching the mode off is a config edit, not a code change
    monkeypatch.setattr(settings, "recruiter_search_language_mode", "")
    assert "language_mode" not in RecruiterPipelineService._language_params()
    # and no language at all ⇒ nothing threaded ⇒ the workflow step skips itself
    monkeypatch.setattr(settings, "recruiter_search_language", "")
    assert RecruiterPipelineService._language_params() == {}


@pytest.mark.asyncio
async def test_calibration_rerun_keeps_the_language_requirement(
    db_session: AsyncSession, monkeypatch,
):
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch, count=460, pipeline_extra={"search_location": "Costa Rica"},
    )
    monkeypatch.setattr(settings, "recruiter_search_language", "Inglés|English")
    monkeypatch.setattr(settings, "recruiter_search_language_proficiency", "Nivel profesional avanzado")
    monkeypatch.setattr(settings, "recruiter_search_language_mode", "Debe tener")
    await svc._after_search(run, pipeline, connector_id="c", job_id="1")
    _, kwargs = svc._create_pipeline_run.await_args
    assert kwargs["runtime_params"]["language"] == "Inglés|English"
    assert kwargs["runtime_params"]["language_proficiency"] == "Nivel profesional avanzado"
    assert kwargs["runtime_params"]["language_mode"] == "Debe tener"
