"""Phase 2: page_diff must appear in the agent-decision prompt when provided."""
from __future__ import annotations

from ai.prompts import build_agent_decision_prompt


def test_page_diff_rendered_in_prompt():
    prompt = build_agent_decision_prompt(
        workflow_goal="Find a job",
        current_phase="open_platform",
        step_index=0,
        step_intent="Click result",
        step_action="click",
        step_selectors=[{"type": "text", "value": "Indeed"}],
        step_value=None,
        page_url="https://example.com/after",
        page_title="After",
        visible_text="hello",
        visible_elements=[],
        page_diff={
            "url_changed": True,
            "previous_url": "https://example.com/before",
            "title_changed": True,
            "previous_title": "Before",
            "added": [{"tag": "button", "role": "button", "text": "Accept cookies"}],
            "removed": [{"tag": "h3", "role": "heading", "text": "Loading..."}],
        },
    )
    assert "Page Diff" in prompt
    assert "https://example.com/before" in prompt
    assert "Accept cookies" in prompt
    assert "Loading..." in prompt


def test_page_diff_absent_when_empty():
    prompt = build_agent_decision_prompt(
        workflow_goal="Find a job",
        current_phase="open_platform",
        step_index=0,
        step_intent="Click result",
        step_action="click",
        step_selectors=[],
        step_value=None,
        page_url="https://x",
        page_title="X",
        visible_text="hello",
        visible_elements=[],
        page_diff={
            "url_changed": False,
            "title_changed": False,
            "added": [],
            "removed": [],
        },
    )
    # No diff content → no Page Diff section
    assert "Page Diff" not in prompt


def test_page_diff_none_does_not_break():
    prompt = build_agent_decision_prompt(
        workflow_goal=None,
        current_phase=None,
        step_index=0,
        step_intent=None,
        step_action="click",
        step_selectors=[],
        step_value=None,
        page_url="https://x",
        page_title="X",
        visible_text="",
        visible_elements=[],
        page_diff=None,
    )
    assert "Page Diff" not in prompt
