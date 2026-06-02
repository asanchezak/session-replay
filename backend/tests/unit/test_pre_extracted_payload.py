"""F5 de-dup (Task D): the daemon's structured extraction is pushed as
`pre_extracted`, which Easy Recruit (akodoo) consumes to skip its redundant
extraction agents. These tests pin the producer-side contract so it can't drift
from what the analyzer reads (akcr/models/concierge/easy_recruit_analyzer.py:
about, certifications, experience, full_name, headline, location, skills,
profile_url)."""

from services.linkedin_applicant_push_service import (
    CANONICAL_PROFILE_FIELDS,
    _build_pre_extracted,
)

# Fields Easy Recruit's analyzer reads out of pre_extracted (kept in sync with
# the *_from_pre_extracted helpers + _overview_from_pre_extracted in akodoo).
_EASY_RECRUIT_CONSUMES = (
    "full_name",
    "headline",
    "about",
    "location",
    "skills",
    "experience",
    "certifications",
    "profile_url",
)


def _full_profile() -> dict:
    return {
        "profile_url": "https://www.linkedin.com/in/jane-doe",
        "full_name": "Jane Doe",
        "headline": "Senior Engineer",
        "about": "Builds things.",
        "location": "Remote",
        "skills": ["Python", "TypeScript"],
        "experience": [{"title": "Eng", "company": "Acme"}],
        "education": [{"school": "MIT"}],
        "certifications": [{"name": "AWS"}],
        "projects": [{"name": "Apollo"}],
        "courses": ["Algorithms"],
        "languages": ["English"],
    }


def test_includes_every_field_easy_recruit_consumes():
    pe = _build_pre_extracted(_full_profile())
    for field in _EASY_RECRUIT_CONSUMES:
        assert field in pe, f"pre_extracted is missing {field!r} (Easy Recruit reads it)"


def test_profile_url_is_included():
    # Regression: profile_url is NOT in CANONICAL_PROFILE_FIELDS but the analyzer's
    # overview reads pre_extracted["profile_url"], so the builder must add it.
    assert "profile_url" not in CANONICAL_PROFILE_FIELDS
    pe = _build_pre_extracted(_full_profile())
    assert pe["profile_url"] == "https://www.linkedin.com/in/jane-doe"


def test_empty_values_are_dropped():
    profile = {
        "profile_url": "https://www.linkedin.com/in/x",
        "full_name": "X",
        "headline": "",       # empty string -> dropped
        "about": None,        # None -> dropped
        "skills": [],         # empty list -> dropped
        "experience": [{"title": "Eng"}],
    }
    pe = _build_pre_extracted(profile)
    assert pe == {
        "profile_url": "https://www.linkedin.com/in/x",
        "full_name": "X",
        "experience": [{"title": "Eng"}],
    }
