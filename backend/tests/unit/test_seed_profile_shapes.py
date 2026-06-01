"""F4 de-dup: the LinkedIn people-search seed must derive its extract_shapes from
the single source of truth (ai.extraction_shapes.FIELD_SHAPES) — it used to drift
(missing extract_hints). These tests lock the seed to the registry."""

import importlib.util
import pathlib

import pytest

from ai.extraction_shapes import FIELD_SHAPES, normalize_field_key, shape_to_dict

_SEED_PATH = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "seed_linkedin_people_search.py"


def _load_seed_shapes() -> dict[str, dict]:
    spec = importlib.util.spec_from_file_location("seed_lps", _SEED_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return {s["key"]: s for s in mod.PROFILE_EXTRACT_SHAPES}


# Fields the seed shares with the registry — must stay in lock-step.
_REGISTRY_FIELDS = ["about", "skills", "projects", "experience", "education", "certifications"]


@pytest.mark.parametrize("field", _REGISTRY_FIELDS)
def test_seed_shape_matches_registry(field):
    seeded = _load_seed_shapes()[field]
    expected = shape_to_dict(FIELD_SHAPES[normalize_field_key(field)])
    assert seeded["kind"] == expected["kind"]
    assert seeded["item_keys"] == expected["item_keys"]
    assert seeded.get("extract_hints") == expected["extract_hints"]


def test_seed_carries_registry_extract_hints():
    """Regression: the seed used to drop extract_hints, drifting from the registry."""
    shapes = _load_seed_shapes()
    assert shapes["skills"]["extract_hints"]
    assert shapes["education"]["extract_hints"]
    assert shapes["certifications"]["extract_hints"]


def test_non_registry_fields_default_scalar():
    shapes = _load_seed_shapes()
    for f in ("full_name", "headline"):
        assert shapes[f]["kind"] == "scalar"
        assert shapes[f]["item_keys"] is None
