"""Phase C: the seeded "LinkedIn Lead Search" plan must match the action_type
sequence the daemon's generic loop drives (DAEMON_GENERIC_PREAMBLE path).

Imports _build_steps() straight from the seed script and asserts the step shape
so the backend plan and the daemon's dispatch stay in lockstep — if someone
renames the search verb or drops the search-people strategy, this fails.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SEED_PATH = REPO_ROOT / "scripts" / "seed_linkedin_lead_search.py"
APPLICANT_SEED_PATH = REPO_ROOT / "scripts" / "seed_linkedin_people_search.py"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_build_steps():
    return _load("seed_linkedin_lead_search", SEED_PATH)._build_steps


def test_lead_seed_action_type_sequence():
    steps = _load_build_steps()()
    assert [s["action_type"] for s in steps] == [
        "navigate",               # 0 feed warm-up
        "noise_break",            # 1 idle noise
        "linkedin_people_search", # 2 humanized search nav
        "extract",                # 3 page-1 search scrape
        "navigate",               # 4 page-2 nav
        "extract",                # 5 page-2 search scrape
    ]
    assert [s["step_index"] for s in steps] == [0, 1, 2, 3, 4, 5]


def test_lead_extract_steps_declare_search_people_strategy():
    steps = _load_build_steps()()
    for idx in (3, 5):
        methods = steps[idx]["methods"]
        shapes_method = next(m for m in methods if m.get("kind") == "extract_shapes")
        assert shapes_method["strategy"] == "linkedin_search_people"


def test_lead_search_nav_carries_deep_link_fallback():
    steps = _load_build_steps()()
    assert steps[2]["value"].startswith("https://www.linkedin.com/search/results/people/")


def _applicant_steps():
    return _load("seed_linkedin_people_search", APPLICANT_SEED_PATH)._build_steps()


def test_applicant_seed_action_type_sequence():
    steps = _applicant_steps()
    assert [s["action_type"] for s in steps] == [
        "navigate",                # 0 feed warm-up
        "noise_break",             # 1 idle noise
        "linkedin_people_search",  # 2 humanized search nav
        "extract",                 # 3 page-1 URL scrape
        "linkedin_paginate_next",  # 4 human Next
        "extract",                 # 5 page-2 URL scrape
        "for_each",                # 6 per-profile iteration
    ]


def test_applicant_search_extracts_declare_search_urls_strategy():
    steps = _applicant_steps()
    for idx in (3, 5):
        shapes_method = next(m for m in steps[idx]["methods"] if m.get("kind") == "extract_shapes")
        assert shapes_method["strategy"] == "linkedin_search_urls"


def test_applicant_inner_profile_extract_uses_default_strategy():
    # The per-profile extract must NOT carry a search strategy (defaults to
    # linkedin_profile → scrapeProfileFull).
    steps = _applicant_steps()
    cfg = next(m for m in steps[6]["methods"] if m.get("kind") == "for_each_config")
    inner = cfg["inner_steps"]
    extract_inner = next(s for s in inner if s["action_type"] == "extract")
    shapes_method = next(m for m in extract_inner["methods"] if m.get("kind") == "extract_shapes")
    assert "strategy" not in shapes_method or shapes_method.get("strategy") in (None, "linkedin_profile")
