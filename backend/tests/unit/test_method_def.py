"""Tests for MethodDef and SelectorSet Pydantic models and API acceptance."""

import pytest
from pydantic import ValidationError

# Import directly from the api module where they're defined
from api.v1.workflows import AddStepRequest, MethodDef, SelectorSet


class TestSelectorSet:
    def test_valid_css(self):
        s = SelectorSet(type="css", value="#my-button")
        assert s.type == "css"
        assert s.value == "#my-button"

    @pytest.mark.parametrize(
        "sel_type",
        ["css", "text", "accessibility", "xpath", "anchor", "shadow_css"],
    )
    def test_accepts_all_six_strategies(self, sel_type):
        # All six strategies the WorkflowStep model + both runtime executors
        # (extension replay.ts, daemon selector-resolve.mjs) support. anchor and
        # shadow_css were previously rejected here despite being resolvable.
        s = SelectorSet(type=sel_type, value="some-value")
        assert s.type == sel_type

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


class TestAddStepRequest:
    def test_accepts_linkedin_people_search(self):
        # Phase C: the humanized people-search nav verb the daemon dispatches.
        req = AddStepRequest(step_index=2, action_type="linkedin_people_search")
        assert req.action_type == "linkedin_people_search"

    def test_accepts_linkedin_paginate_next(self):
        # Phase C: the human "Next" pagination verb (applicant generic path).
        req = AddStepRequest(step_index=4, action_type="linkedin_paginate_next")
        assert req.action_type == "linkedin_paginate_next"

    def test_accepts_core_action_types(self):
        for at in ("navigate", "extract", "for_each", "click", "type"):
            assert AddStepRequest(step_index=0, action_type=at).action_type == at

    def test_rejects_unknown_action_type(self):
        with pytest.raises(ValidationError):
            AddStepRequest(step_index=0, action_type="teleport")
