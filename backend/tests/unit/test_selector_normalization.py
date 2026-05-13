"""Pins B-N-17 / B-Q-06 — _normalize_selector silently coerces bad input.

Today the helper accepts almost anything and returns `{"type":"css","value":...}`.
That sweeps shape mismatches under the rug. The test below documents the current
(buggy) behavior with xfail markers — when the helper is replaced by a Pydantic
model that raises on bad input, the markers flip to passing.
"""
from __future__ import annotations

import pytest

from services.healing_service import _normalize_selector


def test_passthrough_dict_with_type_and_value():
    sel = {"type": "css", "value": "#x"}
    assert _normalize_selector(sel) == sel


def test_xpath_string_starting_with_double_slash():
    assert _normalize_selector("//div[@id='x']") == {"type": "xpath", "value": "//div[@id='x']"}


def test_xpath_string_starting_with_paren():
    assert _normalize_selector("(//div)[1]") == {"type": "xpath", "value": "(//div)[1]"}


def test_css_id():
    assert _normalize_selector("#login") == {"type": "css", "value": "#login"}


def test_css_class():
    assert _normalize_selector(".btn-primary") == {"type": "css", "value": ".btn-primary"}


def test_css_attribute():
    assert _normalize_selector("[data-testid='submit']") == {"type": "css", "value": "[data-testid='submit']"}


def test_bare_string_defaults_to_css():
    assert _normalize_selector("button") == {"type": "css", "value": "button"}


def test_none_input_raises():
    with pytest.raises((TypeError, ValueError)):
        _normalize_selector(None)  # type: ignore[arg-type]


def test_integer_input_raises():
    with pytest.raises((TypeError, ValueError)):
        _normalize_selector(123)  # type: ignore[arg-type]


def test_empty_string_raises():
    with pytest.raises(ValueError):
        _normalize_selector("")


def test_dict_missing_value_raises():
    with pytest.raises((TypeError, ValueError, KeyError)):
        _normalize_selector({"type": "css"})  # type: ignore[arg-type]
