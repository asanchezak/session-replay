from __future__ import annotations

from ai.prompts import (
    build_agent_decision_prompt,
    build_classify_prompt,
    build_extract_prompt,
    build_heal_prompt,
    build_semantic_analysis_prompt,
    build_simplification_prompt,
)


def test_basic_prompt_builders_cover_optional_sections():
    heal = build_heal_prompt(
        dom_snippet="<div>hello</div>",
        at_snippet="role=button name=Run",
        old_selectors=["#old", ".btn"],
        intent="click run",
        visible_text="Run now",
        page_url="https://example.test/run",
    )
    assert "Current page URL" in heal
    assert "Accessibility tree" in heal
    assert "Visible text on page" in heal

    classify = build_classify_prompt("captcha verify human", ["button", "input"])
    assert "Page text content" in classify
    assert "Visible interactive elements" in classify

    extract = build_extract_prompt("row 1", {"type": "array"})
    assert "Expected schema" in extract

    semantic = build_semantic_analysis_prompt(
        workflow_name="Jobs",
        steps_summary="1. click",
        parameter_candidates="q=python",
        phase_boundaries="0-2",
        target_url="https://example.test",
        prompt_text="Find jobs",
    )
    assert "Workflow Name" in semantic
    assert "Target URL" in semantic
    assert "User-Provided Prompt" in semantic

    simplify = build_simplification_prompt(
        [{"action_type": "click", "intent": "go", "selector_chain": [], "value": None, "checkpoint": False}],
        workflow_goal="Find top 10 rows",
        target_url="https://example.test",
    )
    assert "browser automation optimizer" in simplify
    assert "Return ONLY a JSON array" in simplify


def test_agent_decision_prompt_covers_all_optional_blocks():
    prompt = build_agent_decision_prompt(
        workflow_goal="Collect 10 jobs",
        workflow_summary="Find and extract job cards.",
        current_phase="Search",
        step_index=2,
        step_intent="open detail",
        step_action="navigate",
        step_selectors=[
            {"type": "css", "value": "#_abcd1234", "score": 0.2},
            {"type": "text", "value": "Open", "score": 0.8},
        ],
        step_value="https://target.test/jobs",
        page_url="https://login.test/",
        page_title="Sign in",
        visible_text="Please sign in to continue",
        visible_elements=[{"tag": "button", "role": "button", "text": "Sign in"}],
        previous_failures=[{"step_index": 2, "action": "click", "error": "not found"}],
        page_diff={
            "url_changed": True,
            "previous_url": "https://target.test/jobs",
            "title_changed": True,
            "previous_title": "Jobs",
            "added": [{"tag": "input", "role": "textbox", "text": "Email"}],
            "removed": [{"tag": "button", "role": "button", "text": "Apply"}],
        },
        goal_progress={
            "phases": [
                {"name": "Search", "goal": "run search", "status": "done"},
                {"name": "Extract", "goal": "capture cards", "status": "active"},
            ],
            "intents": [
                {"step_index": 2, "intent": "open detail", "status": "pending"},
                {"step_index": 1, "intent": "search", "status": "satisfied"},
            ],
        },
        run_memory={
            "decisions": [{"step": 1, "decision": "WAIT", "confidence": 0.4, "outcome": "failure", "summary": "stalled"}],
            "traces": [{"step": 1, "trigger": "heal", "error": "selector broke", "suggested_action": "navigate", "outcome": "success"}],
        },
        checkpoint_steps=[0, 3],
        step_stability_score=0.4,
        workflow_expertise="Known problem steps: [2]",
        page_context_error="network timeout",
        actual_url="https://login.test/",
    )
    assert "Workflow Context" in prompt
    assert "Historical selector stability: FRAGILE" in prompt
    assert "URL match: NO" in prompt
    assert "Page Diff" in prompt
    assert "Known problem steps" in prompt


def test_surrounding_steps_section_appears_in_prompt():
    surrounding = [
        {"step_index": 3, "action_type": "navigate", "intent": "Go to LinkedIn feed", "value": "https://linkedin.com/feed/", "caused_url_change": False, "time_since_previous_ms": None, "context_url_before": None},
        {"step_index": 4, "action_type": "click", "intent": "Click search box", "value": None, "caused_url_change": True, "time_since_previous_ms": 500, "context_url_before": "https://linkedin.com/feed/"},
        {"step_index": 5, "action_type": "type", "intent": "Type John Smith", "value": "John Smith", "caused_url_change": False, "time_since_previous_ms": 3700, "context_url_before": "https://linkedin.com/search/"},
        {"step_index": 6, "action_type": "click", "intent": "Click first result", "value": None, "caused_url_change": False, "time_since_previous_ms": 1000, "context_url_before": None},
        {"step_index": 7, "action_type": "navigate", "intent": "Open profile", "value": None, "caused_url_change": False, "time_since_previous_ms": 800, "context_url_before": None},
    ]
    prompt = build_agent_decision_prompt(
        workflow_goal="Send a LinkedIn message",
        current_phase="Messaging",
        step_index=5,
        step_intent="Type John Smith",
        step_action="type",
        step_selectors=[],
        step_value="John Smith",
        page_url="https://linkedin.com/search/",
        page_title="LinkedIn Search",
        visible_text="Search results",
        visible_elements=[],
        surrounding_steps=surrounding,
    )
    assert "Step Context (Recorded Sequence)" in prompt
    assert "← CURRENT" in prompt
    assert "caused URL change in recording" in prompt
    assert "3s pause" in prompt


def test_skip_hint_fires_for_matching_navigate_url():
    surrounding = [
        {"step_index": 0, "action_type": "navigate", "intent": "Go to feed", "value": "https://linkedin.com/feed/", "caused_url_change": False, "time_since_previous_ms": None, "context_url_before": None},
    ]
    prompt = build_agent_decision_prompt(
        workflow_goal="browse feed",
        current_phase=None,
        step_index=0,
        step_intent="Go to feed",
        step_action="navigate",
        step_selectors=[],
        step_value="https://linkedin.com/feed/",
        page_url="https://linkedin.com/feed/",
        page_title="LinkedIn",
        visible_text="",
        visible_elements=[],
        surrounding_steps=surrounding,
    )
    assert "Skip hint" in prompt
    assert "already on the recorded destination" in prompt
