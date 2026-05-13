"""Tests for MethodDef and SelectorSet Pydantic models and API acceptance."""

import pytest
from pydantic import ValidationError

# Import directly from the api module where they're defined
from api.v1.workflows import MethodDef, SelectorSet


class TestSelectorSet:
    def test_valid_css(self):
        s = SelectorSet(type="css", value="#my-button")
        assert s.type == "css"
        assert s.value == "#my-button"

    def test_invalid_type(self):
        with pytest.raises(ValidationError):
            SelectorSet(type="invalid", value="#btn")

    def test_empty_value(self):
        with pytest.raises(ValidationError):
            SelectorSet(type="css", value="")


class TestMethodDef:
    def test_valid_click(self):
        m = MethodDef(
            action_type="click",
            selector_chain=[SelectorSet(type="css", value="#btn")],
        )
        assert m.action_type == "click"
        assert m.value is None

    def test_valid_with_value(self):
        m = MethodDef(
            action_type="type",
            selector_chain=[SelectorSet(type="css", value="#input")],
            value="hello",
        )
        assert m.value == "hello"

    def test_rejects_navigate(self):
        with pytest.raises(ValidationError):
            MethodDef(
                action_type="navigate",
                selector_chain=[SelectorSet(type="css", value="#btn")],
            )

    def test_rejects_empty_selector_chain(self):
        with pytest.raises(ValidationError):
            MethodDef(action_type="click", selector_chain=[])

    def test_allows_hover(self):
        m = MethodDef(
            action_type="hover",
            selector_chain=[SelectorSet(type="css", value="#btn")],
        )
        assert m.action_type == "hover"

    def test_allows_scroll(self):
        m = MethodDef(
            action_type="scroll",
            selector_chain=[SelectorSet(type="css", value="#section")],
        )
        assert m.action_type == "scroll"
