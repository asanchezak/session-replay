"""Geography gate on search candidates — the Python twin of recruiter.mjs's matcher.

LinkedIn's location facet narrows a search but does not guarantee it: job 303's
city-level search (São Paulo, Medellín, Bogotá, the GAM, Lima) still returned
"San Carlos, San Pablo, Brasil". These pin the matcher (same cases as
extension/tests/location-facet.test.mjs) and the lead pre-filter built on it.
"""
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from services.recruiter_geography import location_allowed, normalize, spec_terms
from services.recruiter_push_service import RecruiterPushService

JOB_303 = (
    "Sao Paulo, San Pablo, Brasil;Medellín, Antioquia, Colombia;"
    "Bogotá, Distrito Capital, Colombia;Gran Área Metropolitana, San José, Costa Rica;"
    "San José, Costa Rica;Heredia, Costa Rica;Alajuela, Costa Rica;Cartago, Costa Rica;Lima, Perú"
)


def test_spec_terms_flattens_places_and_spellings():
    assert spec_terms("Costa Rica; Brazil|Brasil") == ["Costa Rica", "Brazil", "Brasil"]
    # blank / unresolved placeholder = no geography
    assert spec_terms("") == [] and spec_terms(None) == [] and spec_terms("{{location}}") == []


def test_normalize_is_accent_case_and_punctuation_insensitive():
    assert normalize("São Paulo, Brasil") == "sao paulo brasil"
    assert normalize("Bogotá, D.C.") == "bogota d c"


def test_city_geography_admits_the_city_and_its_districts_only():
    terms = spec_terms(JOB_303)
    for loc in ("Sao Paulo, San Pablo, Brasil", "Medellín, Antioquia, Colombia",
                "Bogotá, Distrito Capital, Colombia", "Escazú, San José, Costa Rica",
                "Belén, Heredia, Costa Rica", "Miraflores, Lima, Perú"):
        assert location_allowed(loc, terms), loc
    # the four people PROD saved for job 303 that were outside it, plus neighbours
    for loc in ("Quito Metropolitan Area", "San Pablo, Brasil", "Colombia",
                "San Carlos, San Pablo, Brasil", "Campinas, San Pablo, Brasil",
                "Costa Rica", "Limón, Costa Rica"):
        assert not location_allowed(loc, terms), loc


def test_country_match_only_counts_at_the_end():
    terms = spec_terms("Costa Rica; Panama|Panamá")
    assert location_allowed("San José, Costa Rica", terms)
    assert not location_allowed("Panama City, Florida, United States", terms)


def test_no_terms_is_no_filter_and_unreadable_fails_closed():
    assert location_allowed("Bengaluru, India", [])
    assert not location_allowed("", spec_terms("Costa Rica"))
    assert not location_allowed(None, spec_terms("Costa Rica"))


# ------------------------------------------------------------- lead pre-filter

_LEADS = [
    {"profile_url": "https://x/talent/profile/A", "name": "Amina", "headline": "",
     "location": "Sao Paulo, San Pablo, Brasil"},
    {"profile_url": "https://x/talent/profile/B", "name": "Igor", "headline": "",
     "location": "San Carlos, San Pablo, Brasil"},
    {"profile_url": "https://x/talent/profile/C", "name": "Nobody", "headline": "",
     "location": ""},
]


@pytest.mark.asyncio
async def test_push_drops_people_outside_the_positions_geography(db_session: AsyncSession):
    svc = RecruiterPushService(db_session)
    svc._collect_recruiter_leads = AsyncMock(return_value=[dict(l) for l in _LEADS])
    # job_id=None → returns before any Odoo POST, but AFTER the filters.
    res = await svc.push_recruiter_leads(
        run_id="r1", job_id=None, connector_id="c", allowed_locations=JOB_303,
    )
    assert [l["name"] for l in res["leads"]] == ["Amina"]
    # unreadable location is dropped too (fail closed)
    assert [o["name"] for o in res["out_of_location"]] == ["Igor", "Nobody"]


@pytest.mark.asyncio
async def test_push_without_a_geography_keeps_everyone(db_session: AsyncSession):
    svc = RecruiterPushService(db_session)
    svc._collect_recruiter_leads = AsyncMock(return_value=[dict(l) for l in _LEADS])
    res = await svc.push_recruiter_leads(run_id="r1", job_id=None, connector_id="c")
    assert len(res["leads"]) == 3
    assert res["out_of_location"] == []


@pytest.mark.asyncio
async def test_push_with_everyone_outside_returns_no_leads(db_session: AsyncSession):
    svc = RecruiterPushService(db_session)
    svc._collect_recruiter_leads = AsyncMock(return_value=[dict(_LEADS[1])])
    res = await svc.push_recruiter_leads(
        run_id="r1", job_id="1", connector_id="c", allowed_locations=JOB_303,
    )
    assert res["leads"] == [] and res["skipped"] == "no_leads"
    assert [o["name"] for o in res["out_of_location"]] == ["Igor"]
