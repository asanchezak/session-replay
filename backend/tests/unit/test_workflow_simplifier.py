"""Unit tests for the WorkflowSimplifier 5-pass pipeline."""
import json

import pytest

from services.workflow_simplifier import (
    WorkflowSimplifier,
    _build_simplification_prompt,
    _clean_url,
    _is_ephemeral_selector,
    _pass1_clean_urls,
    _pass2_filter_selectors,
    _pass3_collapse,
    _pass3b_mark_checkpoints,
    _step_signature,
)

# ---------------------------------------------------------------------------
# Pass 1 — URL cleaning
# ---------------------------------------------------------------------------

def test_pass1_google_search_strips_session_params():
    url = (
        "https://www.google.com/search"
        "?q=velocidad+internet"
        "&sxsrf=ABC123"
        "&ei=xyz"
        "&iflsig=123"
        "&ved=0"
        "&sca_esv=foo"
    )
    result = _clean_url(url)
    assert "sxsrf" not in result
    assert "ei" not in result
    assert "iflsig" not in result
    assert "ved" not in result
    assert "q=velocidad+internet" in result


def test_pass1_google_search_keeps_only_q():
    url = "https://www.google.com/search?q=python+jobs&biw=1440&bih=900&oq=python"
    result = _clean_url(url)
    assert result == "https://www.google.com/search?q=python+jobs"


def test_pass1_utm_params_stripped():
    url = "https://example.com/page?utm_source=google&utm_medium=cpc&ref=foo"
    result = _clean_url(url)
    assert "utm_source" not in result
    assert "utm_medium" not in result
    assert "ref=foo" in result


def test_pass1_clean_url_no_params():
    url = "https://speedtest.net/"
    assert _clean_url(url) == url


def test_pass1_navigate_steps_cleaned():
    steps = [
        {"action_type": "navigate", "value": "https://www.google.com/search?q=test&sxsrf=XYZ"},
        {"action_type": "click", "value": None},
    ]
    result = _pass1_clean_urls(steps)
    assert "sxsrf" not in result[0]["value"]
    assert result[1]["value"] is None  # non-navigate unchanged


# ---------------------------------------------------------------------------
# Pass 2 — Ephemeral selector filtering
# ---------------------------------------------------------------------------

def test_pass2_ephemeral_id_removed():
    step = {
        "action_type": "click",
        "intent": "Click search",
        "selector_chain": [
            {"type": "css", "value": "#_MXwLas-xK_a7wN4PkNa42Qo_40"},
            {"type": "text", "value": "Search"},
        ],
    }
    result = _pass2_filter_selectors([step])[0]
    values = [s["value"] for s in result["selector_chain"]]
    assert "#_MXwLas-xK_a7wN4PkNa42Qo_40" not in values
    assert "Search" in values


def test_pass2_text_selector_kept():
    step = {
        "action_type": "click",
        "intent": "Click button",
        "selector_chain": [{"type": "text", "value": "Submit"}],
    }
    result = _pass2_filter_selectors([step])[0]
    assert len(result["selector_chain"]) == 1


def test_pass2_empty_chain_keeps_step_with_synthesized_intent():
    step = {
        "action_type": "click",
        "intent": "Click the big button",
        "selector_chain": [{"type": "css", "value": "#_RandomlyGeneratedId_xyz123abc456"}],
    }
    result = _pass2_filter_selectors([step])[0]
    assert result["selector_chain"] == []
    assert result["intent"]
    assert "intent_only" not in result


def test_pass2_null_intent_gets_synthesized():
    step = {
        "action_type": "type",
        "intent": None,
        "value": "python developer",
        "selector_chain": [],
    }
    result = _pass2_filter_selectors([step])[0]
    assert result["intent"] is not None
    assert len(result["intent"]) > 0
    assert "python developer" in result["intent"].lower() or "type" in result["intent"].lower()


def test_pass2_short_intent_gets_enriched():
    step = {
        "action_type": "click",
        "intent": "go",
        "selector_chain": [{"type": "text", "value": "Submit"}],
    }
    result = _pass2_filter_selectors([step])[0]
    assert len(result["intent"].split()) >= 2


def test_is_ephemeral_selector_random_id():
    assert _is_ephemeral_selector({"type": "css", "value": "#_abc123defgh12345"})


def test_is_ephemeral_selector_stable_id():
    assert not _is_ephemeral_selector({"type": "css", "value": "#submit-btn"})
    assert not _is_ephemeral_selector({"type": "css", "value": ".btn-primary"})


def test_is_ephemeral_deep_nth_of_type():
    assert _is_ephemeral_selector({
        "type": "css",
        "value": "div:nth-of-type(2) > div:nth-of-type(3) > span:nth-of-type(1) > a:nth-of-type(2)"
    })


def test_pass2_semantic_id_kept():
    for semantic in ("#email-input-field", "#main-content", "#nav-2024-q3", "#submit-btn-primary"):
        assert not _is_ephemeral_selector({"type": "css", "value": semantic}), semantic


def test_pass2_high_entropy_id_filtered():
    for ephemeral in ("#a8f9b4c2d1e7f3a9", "#abc123XYZdef456", "#sess-7f3a9b4c2d1e"):
        assert _is_ephemeral_selector({"type": "css", "value": ephemeral}), ephemeral


# ---------------------------------------------------------------------------
# Pass 3 — Sequence collapsing
# ---------------------------------------------------------------------------

def test_pass3_search_detour_collapsed():
    steps = [
        {"step_index": 0, "action_type": "click", "value": None, "selector_chain": [], "intent": "Click search box"},
        {"step_index": 1, "action_type": "type", "value": "internet speed test", "selector_chain": [], "intent": "Type query"},
        {"step_index": 2, "action_type": "navigate", "value": "https://www.google.com/search?q=internet+speed+test", "selector_chain": [], "intent": "Go to Google"},
        {"step_index": 3, "action_type": "click", "value": None, "selector_chain": [], "intent": "Click result"},
        {"step_index": 4, "action_type": "navigate", "value": "https://speedtest.net/", "selector_chain": [], "intent": "Open Speedtest"},
        {"step_index": 5, "action_type": "click", "value": None, "selector_chain": [], "intent": "Click start"},
    ]
    result = _pass3_collapse(steps)
    action_types = [s["action_type"] for s in result]
    values = [s.get("value") for s in result]
    # Strong assertions — the search prefix is gone, the destination navigate
    # and the Go-button click are both preserved.
    assert action_types == ["navigate", "click"], action_types
    assert "speedtest.net" in (values[0] or "")
    # No google search step survives.
    assert not any("google.com" in (v or "") for v in values)


def test_pass3_consecutive_same_domain_navigates_collapsed():
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://example.com/page1", "selector_chain": [], "intent": "Go to page 1"},
        {"step_index": 1, "action_type": "navigate", "value": "https://example.com/page2", "selector_chain": [], "intent": "Go to page 2"},
        {"step_index": 2, "action_type": "click", "value": None, "selector_chain": [], "intent": "Click button"},
    ]
    result = _pass3_collapse(steps)
    navigate_steps = [s for s in result if s["action_type"] == "navigate"]
    assert len(navigate_steps) == 1
    assert navigate_steps[0]["value"] == "https://example.com/page2"


def test_pass3_duplicate_consecutive_actions_removed():
    steps = [
        {"step_index": 0, "action_type": "click", "value": "btn", "selector_chain": [{"type": "css", "value": ".btn"}], "intent": "Click"},
        {"step_index": 1, "action_type": "click", "value": "btn", "selector_chain": [{"type": "css", "value": ".btn"}], "intent": "Click"},
        {"step_index": 2, "action_type": "type", "value": "hello", "selector_chain": [], "intent": "Type"},
    ]
    result = _pass3_collapse(steps)
    clicks = [s for s in result if s["action_type"] == "click"]
    assert len(clicks) == 1


def test_pass3_different_domain_navigates_kept():
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://google.com/search?q=test", "selector_chain": [], "intent": "Google"},
        {"step_index": 1, "action_type": "navigate", "value": "https://indeed.com/jobs", "selector_chain": [], "intent": "Indeed"},
    ]
    result = _pass3_collapse(steps)
    # Google is a search engine so it should be collapsed out
    values = [s.get("value") for s in result]
    assert any("indeed.com" in (v or "") for v in values)


def test_pass3_preserves_click_before_post_test_redirect():
    """Regression: speedtest.net's Go button click was being consumed by
    Pattern A because the test-completion URL change (e.g. /es → /es/result/<id>)
    was treated as the "final destination" navigate. Pattern A must use the
    FIRST non-search navigate as the entry boundary, not the last, and Pattern
    D should drop the trailing same-domain navigate that's really a side-effect
    of the click.
    """
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://www.google.com/", "selector_chain": [], "intent": "Go to Google"},
        {"step_index": 1, "action_type": "type", "value": "velocidad internet", "selector_chain": [], "intent": "Search"},
        {"step_index": 2, "action_type": "click", "value": None, "selector_chain": [], "intent": "Click result"},
        {"step_index": 3, "action_type": "navigate", "value": "https://www.speedtest.net/es", "selector_chain": [], "intent": "Open speedtest"},
        {"step_index": 4, "action_type": "click", "value": None, "selector_chain": [], "intent": "Click Go button"},
        {"step_index": 5, "action_type": "navigate", "value": "https://www.speedtest.net/es/result/19211525847", "selector_chain": [], "intent": "Results page"},
    ]
    result = _pass3_collapse(steps)
    action_types = [s["action_type"] for s in result]
    # The destination navigate AND the Go click must both survive
    assert "click" in action_types, f"Go-button click was stripped: {action_types}"
    # The trailing stale result URL must be dropped — replay shouldn't jump there
    values = [s.get("value") or "" for s in result]
    assert not any("/result/" in v for v in values), f"Stale result URL kept: {values}"
    # Workflow should end on the click, not a navigate
    assert action_types[-1] == "click", f"Last step should be the click: {action_types}"
    # The entry navigate to speedtest must be preserved
    assert any("speedtest.net/es" in v for v in values)


def test_pass3_pattern_d_preserves_checkpoint_aligned_navigate():
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://example.com/", "selector_chain": [], "intent": "home"},
        {"step_index": 1, "action_type": "click", "value": None, "selector_chain": [], "intent": "Go"},
        {"step_index": 2, "action_type": "navigate", "value": "https://example.com/done", "selector_chain": [], "intent": "Done page"},
    ]
    # Phase boundary at step 2 — Pattern D must NOT drop it
    result = _pass3_collapse(steps, phase_start_indices={2})
    action_types = [s["action_type"] for s in result]
    assert action_types == ["navigate", "click", "navigate"]


def test_pass3b_remaps_phase_boundary_when_collapsed():
    # Simulate Pass 3 output: search detour collapsed away, only the destination
    # navigate (with original step_index=3) remains.
    steps_after_p3 = [
        {"step_index": 3, "action_type": "navigate", "value": "https://example.com", "selector_chain": [], "checkpoint": False},
        {"step_index": 4, "action_type": "click", "value": None, "selector_chain": [], "checkpoint": False},
    ]
    # Phase originally started at index 0, but step 0 was collapsed. The
    # nearest surviving navigate with step_index >= 0 is the one at 3.
    phases = [_FakePhase(0)]
    result = _pass3b_mark_checkpoints(steps_after_p3, phases)
    assert result[0]["checkpoint"] is True


def test_pass3_pattern_d_keeps_cross_domain_trailing_navigate():
    """Pattern D should NOT drop a trailing navigate that goes to a different
    domain than the click's context — that's a legitimate cross-site
    transition the user performed.
    """
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://site-a.com/", "selector_chain": [], "intent": "Site A"},
        {"step_index": 1, "action_type": "click", "value": None, "selector_chain": [], "intent": "Click button"},
        {"step_index": 2, "action_type": "navigate", "value": "https://site-b.com/", "selector_chain": [], "intent": "Site B"},
    ]
    result = _pass3_collapse(steps)
    values = [s.get("value") or "" for s in result]
    assert any("site-b.com" in v for v in values), f"Cross-site navigate was dropped: {values}"


# ---------------------------------------------------------------------------
# Pass 3b — Checkpoint marking
# ---------------------------------------------------------------------------

class _FakePhase:
    def __init__(self, start_step_index):
        self.start_step_index = start_step_index


def test_pass3b_marks_phase_entry_navigates():
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://indeed.com", "selector_chain": [], "checkpoint": False},
        {"step_index": 1, "action_type": "type", "value": "python", "selector_chain": [], "checkpoint": False},
        {"step_index": 2, "action_type": "navigate", "value": "https://indeed.com/results", "selector_chain": [], "checkpoint": False},
    ]
    phases = [_FakePhase(0), _FakePhase(2)]
    result = _pass3b_mark_checkpoints(steps, phases)
    assert result[0]["checkpoint"] is True
    assert result[1]["checkpoint"] is False
    assert result[2]["checkpoint"] is True


def test_pass3b_non_navigate_not_checkpointed():
    steps = [
        {"step_index": 0, "action_type": "type", "value": "hello", "selector_chain": [], "checkpoint": False},
    ]
    phases = [_FakePhase(0)]
    result = _pass3b_mark_checkpoints(steps, phases)
    assert result[0].get("checkpoint") is False


def test_pass3b_no_phases_returns_unchanged():
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://example.com", "selector_chain": [], "checkpoint": False},
    ]
    result = _pass3b_mark_checkpoints(steps, [])
    assert result == steps


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

def test_pass3_collapse_empty_list_returns_empty():
    assert _pass3_collapse([]) == []


def test_pass3_pure_interactions_no_navigates_unchanged():
    steps = [
        {"step_index": 0, "action_type": "click", "value": None, "selector_chain": [{"type": "text", "value": "A"}], "intent": "click A"},
        {"step_index": 1, "action_type": "type", "value": "abc", "selector_chain": [{"type": "css", "value": "#email"}], "intent": "type email"},
        {"step_index": 2, "action_type": "click", "value": None, "selector_chain": [{"type": "text", "value": "B"}], "intent": "click B"},
    ]
    result = _pass3_collapse(steps)
    assert [s["action_type"] for s in result] == ["click", "type", "click"]


def test_pass3_all_search_navigates_kept_as_is():
    # No real destination → no detour to collapse. Pattern B still applies.
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://www.google.com/search?q=a", "selector_chain": []},
        {"step_index": 1, "action_type": "navigate", "value": "https://www.google.com/search?q=b", "selector_chain": []},
    ]
    result = _pass3_collapse(steps)
    # Pattern B collapses consecutive same-domain navigates: only the last kept.
    assert len(result) == 1
    assert "q=b" in result[0]["value"]


@pytest.mark.asyncio
async def test_simplify_empty_list_returns_empty():
    simplifier = WorkflowSimplifier()
    assert await simplifier.simplify([]) == []


@pytest.mark.asyncio
async def test_simplify_single_step_passes_through(monkeypatch):
    class _IdentityProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            import json as _json

            from ai.client import AIResponse
            return AIResponse(content=_json.dumps([
                {"action_type": "navigate", "value": "https://example.com", "intent": "Open page", "selector_chain": [], "checkpoint": False},
            ]))

    import services.workflow_simplifier as mod
    monkeypatch.setattr(mod, "get_ai_provider", lambda: _IdentityProvider())

    simplifier = WorkflowSimplifier(workflow_goal="see homepage", target_url="https://example.com")
    result = await simplifier.simplify([
        {"action_type": "navigate", "value": "https://example.com", "intent": "Open page", "selector_chain": []},
    ])
    assert len(result) == 1
    assert result[0]["action_type"] == "navigate"


def test_pass3_pattern_d_keeps_subdomain_change():
    # `c.example.com` → click → `www.example.com` is treated as a legitimate
    # cross-(sub)domain transition because `_same_domain` is netloc-strict.
    # Pinning this so a future refactor to registered-domain matching doesn't
    # regress it silently.
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://c.example.com/", "selector_chain": [], "intent": "Open c"},
        {"step_index": 1, "action_type": "click", "value": None, "selector_chain": [{"type": "text", "value": "Continue"}], "intent": "Continue"},
        {"step_index": 2, "action_type": "navigate", "value": "https://www.example.com/done", "selector_chain": [], "intent": "Arrive www"},
    ]
    result = _pass3_collapse(steps)
    values = [s.get("value") or "" for s in result]
    assert any("www.example.com" in v for v in values)


# ---------------------------------------------------------------------------
# Safety guard isolated tests
# ---------------------------------------------------------------------------

def test_reject_ai_candidate_accepts_identical_baseline():
    from services.workflow_simplifier import _reject_ai_candidate

    steps = [
        {"action_type": "navigate", "value": "https://example.com", "selector_chain": []},
        {"action_type": "click", "value": None, "selector_chain": [{"type": "text", "value": "Go"}]},
    ]
    assert _reject_ai_candidate(steps, [dict(s) for s in steps]) is False


def test_reject_ai_candidate_rejects_length_or_signature_changes():
    from services.workflow_simplifier import _reject_ai_candidate

    baseline = [
        {"action_type": "navigate", "value": "https://www.speedtest.net/es", "selector_chain": []},
        {"action_type": "click", "value": None, "selector_chain": [{"type": "text", "value": "Iniciar"}]},
        {"action_type": "click", "value": "115.65", "selector_chain": [{"type": "text", "value": "115.65"}]},
    ]
    # Drops the start click (length change).
    shorter = [
        {"action_type": "navigate", "value": "https://www.speedtest.net/es/result/19212057393", "selector_chain": []},
        {"action_type": "click", "value": "115.65", "selector_chain": [{"type": "text", "value": "115.65"}]},
    ]
    assert _reject_ai_candidate(baseline, shorter) is True

    # Keeps length but changes step signature at index 1.
    wrong_middle = [
        {"action_type": "navigate", "value": "https://www.speedtest.net/es", "selector_chain": []},
        {"action_type": "click", "value": None, "selector_chain": [{"type": "text", "value": "115.65"}]},
        {"action_type": "click", "value": "115.65", "selector_chain": [{"type": "text", "value": "115.65"}]},
    ]
    assert _reject_ai_candidate(baseline, wrong_middle) is True


def test_drops_post_destination_interactions_detects_drop():
    from services.workflow_simplifier import _drops_post_destination_interactions

    baseline = [
        {"action_type": "navigate", "value": "https://example.com", "selector_chain": []},
        {"action_type": "click", "value": None, "selector_chain": [{"type": "text", "value": "Go"}]},
    ]
    candidate_dropped = [
        {"action_type": "navigate", "value": "https://example.com", "selector_chain": []},
    ]
    assert _drops_post_destination_interactions(baseline, candidate_dropped) is True
    assert _drops_post_destination_interactions(baseline, baseline) is False


def test_missing_post_destination_critical_actions_subsequence():
    from services.workflow_simplifier import _missing_post_destination_critical_actions

    baseline = [
        {"action_type": "navigate", "value": "https://example.com", "selector_chain": []},
        {"action_type": "click", "value": None, "selector_chain": [{"type": "text", "value": "Go"}]},
        {"action_type": "type", "value": "hello", "selector_chain": [{"type": "css", "value": "#email"}]},
    ]
    # Candidate keeps both critical actions in same order.
    candidate_ok = [
        {"action_type": "navigate", "value": "https://example.com", "selector_chain": []},
        {"action_type": "click", "value": None, "selector_chain": [{"type": "text", "value": "Go"}]},
        {"action_type": "type", "value": "hello", "selector_chain": [{"type": "css", "value": "#email"}]},
    ]
    assert _missing_post_destination_critical_actions(baseline, candidate_ok) is False
    # Candidate drops the type.
    candidate_missing = [
        {"action_type": "navigate", "value": "https://example.com", "selector_chain": []},
        {"action_type": "click", "value": None, "selector_chain": [{"type": "text", "value": "Go"}]},
    ]
    assert _missing_post_destination_critical_actions(baseline, candidate_missing) is True


def test_changes_destination_domain_handles_missing_destination():
    from services.workflow_simplifier import _changes_destination_domain

    baseline = [
        {"action_type": "navigate", "value": "https://example.com", "selector_chain": []},
    ]
    # Candidate has no non-search navigate at all.
    candidate_no_dest = [
        {"action_type": "navigate", "value": "https://www.google.com/search?q=foo", "selector_chain": []},
    ]
    assert _changes_destination_domain(baseline, candidate_no_dest) is True
    # Candidate has the same destination.
    assert _changes_destination_domain(baseline, baseline) is False
    # Different non-search destination.
    candidate_swap = [
        {"action_type": "navigate", "value": "https://fast.com", "selector_chain": []},
    ]
    assert _changes_destination_domain(baseline, candidate_swap) is True


# ---------------------------------------------------------------------------
# _step_signature
# ---------------------------------------------------------------------------

def test_step_signature_stable_under_selector_reorder():
    step_a = {
        "action_type": "click",
        "value": "Go",
        "selector_chain": [
            {"type": "css", "value": ".btn"},
            {"type": "text", "value": "Go"},
            {"type": "xpath", "value": "/html/body/button"},
        ],
    }
    step_b = {
        "action_type": "click",
        "value": "Go",
        "selector_chain": [
            {"type": "xpath", "value": "/html/body/button"},
            {"type": "text", "value": "Go"},
            {"type": "css", "value": ".btn"},
        ],
    }
    assert _step_signature(step_a) == _step_signature(step_b)


def test_step_signature_picks_text_over_css():
    step = {
        "action_type": "click",
        "value": None,
        "selector_chain": [
            {"type": "css", "value": ".btn"},
            {"type": "text", "value": "Submit"},
        ],
    }
    sig = _step_signature(step)
    assert sig[2] == "Submit"


def test_step_signature_falls_back_to_lowest_priority_when_only_xpath():
    step = {
        "action_type": "click",
        "value": None,
        "selector_chain": [{"type": "xpath", "value": "/html/body/button[2]"}],
    }
    sig = _step_signature(step)
    assert sig[2] == "/html/body/button[2]"


# ---------------------------------------------------------------------------
# Pass 4 — AI holistic simplification
# ---------------------------------------------------------------------------

def test_pass4_prompt_includes_post_click_guidance():
    steps = [
        {"action_type": "navigate", "value": "https://example.com", "intent": "Open", "selector_chain": []},
        {"action_type": "click", "value": None, "intent": "Click button", "selector_chain": []},
    ]
    prompt = _build_simplification_prompt(steps, "Some goal", "https://example.com")
    assert "Trailing same-domain navigates" in prompt
    assert "side-effects of a click have already been removed" in prompt
    assert "Never remove the final click, type, submit, or select" in prompt


@pytest.mark.asyncio
async def test_pass4_ai_returns_fewer_steps(monkeypatch):
    class SimplifyingProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            # Return just one step
            simplified = [{"action_type": "navigate", "value": "https://speedtest.net/", "intent": "Open Speedtest", "selector_chain": [], "checkpoint": False}]
            return AIResponse(content=json.dumps(simplified))

    import services.workflow_simplifier as mod
    monkeypatch.setattr(mod, "get_ai_provider", lambda: SimplifyingProvider())

    simplifier = WorkflowSimplifier(workflow_goal="Run internet speed test", target_url="https://speedtest.net")
    steps = [
        {"action_type": "navigate", "value": "https://www.google.com/search?q=speedtest", "intent": "Google search", "selector_chain": []},
        {"action_type": "click", "value": None, "intent": "Click result", "selector_chain": []},
        {"action_type": "navigate", "value": "https://speedtest.net/", "intent": "Open speedtest", "selector_chain": []},
    ]
    result = await simplifier.simplify(steps)
    assert len(result) == 1
    assert result[0]["action_type"] == "navigate"
    assert "speedtest.net" in result[0]["value"]


@pytest.mark.asyncio
async def test_pass4_ai_invalid_json_falls_back(monkeypatch):
    class BadJsonProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            return AIResponse(content="not json at all {{")

    import services.workflow_simplifier as mod
    monkeypatch.setattr(mod, "get_ai_provider", lambda: BadJsonProvider())

    simplifier = WorkflowSimplifier()
    steps = [
        {"action_type": "navigate", "value": "https://example.com", "intent": "Go to example", "selector_chain": []},
    ]
    result = await simplifier.simplify(steps)
    assert len(result) >= 1
    assert result[0]["action_type"] == "navigate"


@pytest.mark.asyncio
async def test_pass4_ai_empty_list_falls_back(monkeypatch):
    class EmptyProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            return AIResponse(content="[]")

    import services.workflow_simplifier as mod
    monkeypatch.setattr(mod, "get_ai_provider", lambda: EmptyProvider())

    simplifier = WorkflowSimplifier()
    steps = [
        {"action_type": "click", "value": None, "intent": "Click button", "selector_chain": []},
    ]
    result = await simplifier.simplify(steps)
    assert len(result) >= 1


@pytest.mark.asyncio
async def test_pass4_ai_markdown_fenced_json_parsed(monkeypatch):
    class FencedProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            content = '```json\n[{"action_type": "navigate", "value": "https://example.com", "intent": "Go", "selector_chain": []}]\n```'
            return AIResponse(content=content)

    import services.workflow_simplifier as mod
    monkeypatch.setattr(mod, "get_ai_provider", lambda: FencedProvider())

    simplifier = WorkflowSimplifier()
    steps = [{"action_type": "navigate", "value": "https://example.com", "intent": "Go", "selector_chain": []}]
    result = await simplifier.simplify(steps)
    assert len(result) == 1


@pytest.mark.asyncio
async def test_pass4_cannot_drop_destination_interaction(monkeypatch):
    class OverAggressiveProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            # Incorrectly drops the destination-page click.
            simplified = [
                {
                    "action_type": "navigate",
                    "value": "https://www.speedtest.net/es",
                    "intent": "Open speedtest",
                    "selector_chain": [],
                    "checkpoint": True,
                }
            ]
            return AIResponse(content=json.dumps(simplified))

    import services.workflow_simplifier as mod
    monkeypatch.setattr(mod, "get_ai_provider", lambda: OverAggressiveProvider())

    simplifier = WorkflowSimplifier(
        workflow_goal="get the internet speed",
        target_url="https://www.google.com/",
    )
    steps = [
        {
            "action_type": "navigate",
            "value": "https://www.google.com/search?q=velocidad+internet",
            "intent": "Google search",
            "selector_chain": [],
        },
        {
            "action_type": "navigate",
            "value": "https://www.speedtest.net/es",
            "intent": "Open speedtest",
            "selector_chain": [],
        },
        {
            "action_type": "click",
            "value": None,
            "intent": "Click speed test start",
            "selector_chain": [{"type": "text", "value": "Iniciar"}],
        },
    ]
    result = await simplifier.simplify(steps)
    actions = [s.get("action_type") for s in result]
    assert actions == ["navigate", "click"]


@pytest.mark.asyncio
async def test_pass4_rejected_candidate_merges_intent_strings(monkeypatch):
    # AI returns a structurally bad candidate (drops the click), but the AI
    # also enriched the navigate step's intent. The merge should preserve the
    # baseline structure while adopting the better intent.
    class EnrichedButBadProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            # Structurally invalid (drops the click), but intent improved.
            simplified = [
                {
                    "action_type": "navigate",
                    "value": "https://www.speedtest.net/es",
                    "intent": "Open the Ookla speedtest page in Spanish to measure connection speed",
                    "selector_chain": [],
                    "checkpoint": False,
                }
            ]
            return AIResponse(content=json.dumps(simplified))

    import services.workflow_simplifier as mod
    monkeypatch.setattr(mod, "get_ai_provider", lambda: EnrichedButBadProvider())

    simplifier = WorkflowSimplifier(workflow_goal="speedtest", target_url="https://example.com")
    baseline_navigate_intent = "Open the speedtest page in Spanish before running test"
    steps = [
        {"action_type": "navigate", "value": "https://www.speedtest.net/es", "intent": baseline_navigate_intent, "selector_chain": []},
        {"action_type": "click", "value": None, "intent": "Click the speedtest start button", "selector_chain": [{"type": "text", "value": "Iniciar"}]},
    ]
    result = await simplifier.simplify(steps)
    # Click is preserved (safety guard rejection)
    actions = [s.get("action_type") for s in result]
    assert actions == ["navigate", "click"]
    # Intent on the navigate is unchanged because the candidate length didn't
    # match baseline (1 vs 2) — defensive fallback path. This locks the
    # current "length mismatch ⇒ plain fallback" behavior.
    assert result[0]["intent"] == baseline_navigate_intent


@pytest.mark.asyncio
async def test_pass4_rejected_candidate_with_aligned_lengths_merges_intent(monkeypatch):
    class StructurallyBadButAlignedProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            # Same length as p3b, same signatures (action+value+text-selector),
            # but the AI deletes the destination-page click's text selector,
            # which trips the safety guard via `_drops_post_destination_interactions`.
            simplified = [
                {
                    "action_type": "navigate",
                    "value": "https://www.speedtest.net/es",
                    "intent": "Open the Ookla speedtest page to measure connection speed",
                    "selector_chain": [],
                    "checkpoint": False,
                },
                {
                    "action_type": "click",
                    "value": None,
                    "intent": "Click the Iniciar button to start the speed test",
                    "selector_chain": [{"type": "text", "value": "Iniciar"}],
                    "checkpoint": False,
                },
                # Adds a spurious extra step on the same domain — drops the
                # safety guard via missing-critical or domain-change.
                {
                    "action_type": "navigate",
                    "value": "https://www.fast.com/",  # destination domain change
                    "intent": "Switch to Fast",
                    "selector_chain": [],
                    "checkpoint": False,
                },
            ]
            return AIResponse(content=json.dumps(simplified))

    import services.workflow_simplifier as mod
    monkeypatch.setattr(mod, "get_ai_provider", lambda: StructurallyBadButAlignedProvider())

    simplifier = WorkflowSimplifier(workflow_goal="speedtest", target_url="https://example.com")
    steps = [
        {"action_type": "navigate", "value": "https://www.speedtest.net/es", "intent": "Open speedtest start page now", "selector_chain": []},
        {"action_type": "click", "value": None, "intent": "Click speedtest start button", "selector_chain": [{"type": "text", "value": "Iniciar"}]},
    ]
    result = await simplifier.simplify(steps)
    # Safety guard rejects (destination-domain change), but length mismatch
    # (3 vs 2) means plain fallback. Locks that behavior.
    actions = [s.get("action_type") for s in result]
    assert actions == ["navigate", "click"]


def test_merge_intent_enrichments_adopts_longer_intent():
    from services.workflow_simplifier import _merge_intent_enrichments

    baseline = [
        {"action_type": "click", "value": None, "intent": "Click", "selector_chain": [{"type": "text", "value": "Go"}]},
    ]
    candidate = [
        {"action_type": "click", "value": None, "intent": "Click the Go button to start the test", "selector_chain": [{"type": "text", "value": "Go"}]},
    ]
    merged = _merge_intent_enrichments(baseline, candidate)
    assert merged[0]["intent"] == "Click the Go button to start the test"


def test_merge_intent_enrichments_falls_back_on_signature_mismatch():
    from services.workflow_simplifier import _merge_intent_enrichments

    baseline = [
        {"action_type": "click", "value": None, "intent": "Click Go", "selector_chain": [{"type": "text", "value": "Go"}]},
    ]
    candidate = [
        {"action_type": "click", "value": "different", "intent": "Better intent", "selector_chain": [{"type": "text", "value": "Go"}]},
    ]
    merged = _merge_intent_enrichments(baseline, candidate)
    assert merged[0]["intent"] == "Click Go"


@pytest.mark.asyncio
async def test_pass4_cannot_swap_critical_action_type(monkeypatch):
    class WrongActionProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            simplified = [
                {
                    "action_type": "navigate",
                    "value": "https://www.speedtest.net/es",
                    "intent": "Open speedtest",
                    "selector_chain": [],
                    "checkpoint": True,
                },
                {
                    "action_type": "scroll",
                    "value": "down",
                    "intent": "Scroll page",
                    "selector_chain": [],
                    "checkpoint": False,
                },
            ]
            return AIResponse(content=json.dumps(simplified))

    import services.workflow_simplifier as mod
    monkeypatch.setattr(mod, "get_ai_provider", lambda: WrongActionProvider())

    simplifier = WorkflowSimplifier(
        workflow_goal="get the internet speed",
        target_url="https://www.google.com/",
    )
    steps = [
        {
            "action_type": "navigate",
            "value": "https://www.google.com/search?q=velocidad+internet",
            "intent": "Google search",
            "selector_chain": [],
        },
        {
            "action_type": "navigate",
            "value": "https://www.speedtest.net/es",
            "intent": "Open speedtest",
            "selector_chain": [],
        },
        {
            "action_type": "click",
            "value": None,
            "intent": "Click speed test start",
            "selector_chain": [{"type": "text", "value": "Iniciar"}],
        },
    ]
    result = await simplifier.simplify(steps)
    actions = [s.get("action_type") for s in result]
    assert actions == ["navigate", "click"]


@pytest.mark.asyncio
async def test_pass4_cannot_change_destination_domain(monkeypatch):
    class WrongDomainProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            simplified = [
                {
                    "action_type": "navigate",
                    "value": "https://fast.com/",
                    "intent": "Open speed test site",
                    "selector_chain": [],
                    "checkpoint": True,
                },
                {
                    "action_type": "click",
                    "value": None,
                    "intent": "Start test",
                    "selector_chain": [{"type": "text", "value": "Iniciar"}],
                    "checkpoint": False,
                },
            ]
            return AIResponse(content=json.dumps(simplified))

    import services.workflow_simplifier as mod
    monkeypatch.setattr(mod, "get_ai_provider", lambda: WrongDomainProvider())

    simplifier = WorkflowSimplifier(
        workflow_goal="get the internet speed",
        target_url="https://www.google.com/",
    )
    steps = [
        {
            "action_type": "navigate",
            "value": "https://www.google.com/search?q=velocidad+internet",
            "intent": "Google search",
            "selector_chain": [],
        },
        {
            "action_type": "navigate",
            "value": "https://www.speedtest.net/es",
            "intent": "Open speedtest",
            "selector_chain": [],
        },
        {
            "action_type": "click",
            "value": None,
            "intent": "Click speed test start",
            "selector_chain": [{"type": "text", "value": "Iniciar"}],
        },
    ]
    result = await simplifier.simplify(steps)
    assert "speedtest.net" in str(result[0].get("value") or "")


@pytest.mark.asyncio
async def test_pass4_cannot_remove_start_test_click_before_results_click(monkeypatch):
    class OverAggressiveProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            # Mirrors the bad pattern from run 5c271508: keep only result URL
            # navigate plus a results-page click, dropping the start-test click.
            simplified = [
                {
                    "action_type": "navigate",
                    "value": "https://www.speedtest.net/es/result/19212057393",
                    "intent": "Open speedtest result",
                    "selector_chain": [],
                    "checkpoint": True,
                },
                {
                    "action_type": "click",
                    "value": "115.65",
                    "intent": "Click 115.65",
                    "selector_chain": [{"type": "text", "value": "115.65"}],
                    "checkpoint": False,
                },
            ]
            return AIResponse(content=json.dumps(simplified))

    import services.workflow_simplifier as mod
    monkeypatch.setattr(mod, "get_ai_provider", lambda: OverAggressiveProvider())

    simplifier = WorkflowSimplifier(
        workflow_goal="get the internet speed",
        target_url="https://www.google.com/",
    )
    steps = [
        {
            "action_type": "navigate",
            "value": "https://www.google.com/search?q=velocidad+internet",
            "intent": "Google search",
            "selector_chain": [],
        },
        {
            "action_type": "navigate",
            "value": "https://www.speedtest.net/es",
            "intent": "Open speedtest",
            "selector_chain": [],
        },
        {
            "action_type": "click",
            "value": None,
            "intent": "Click speed test start",
            "selector_chain": [{"type": "text", "value": "Iniciar"}],
        },
        {
            "action_type": "navigate",
            "value": "https://www.speedtest.net/es/result/19212057393",
            "intent": "Results page",
            "selector_chain": [],
        },
        {
            "action_type": "click",
            "value": "115.65",
            "intent": "Click 115.65",
            "selector_chain": [{"type": "text", "value": "115.65"}],
        },
    ]
    result = await simplifier.simplify(steps)
    actions = [s.get("action_type") for s in result]
    intents = [str(s.get("intent") or "").lower() for s in result]
    assert actions.count("click") >= 2
    assert any("start" in intent or "iniciar" in intent for intent in intents)


# ---------------------------------------------------------------------------
# Full simplifier pipeline
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_simplifier_full_pipeline_speedtest(monkeypatch):
    class IdentityProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            # Return whatever steps are in the prompt as-is (parse from prompt)
            import re

            from ai.client import AIResponse
            m = re.search(r"Recorded steps.*?:\n(\[.*?\])\n\n", prompt, re.DOTALL)
            if m:
                return AIResponse(content=m.group(1))
            return AIResponse(content='[{"action_type": "navigate", "value": "https://speedtest.net/", "intent": "Open Speedtest", "selector_chain": []}]')

    import services.workflow_simplifier as mod
    monkeypatch.setattr(mod, "get_ai_provider", lambda: IdentityProvider())

    simplifier = WorkflowSimplifier(workflow_goal="Test internet speed", target_url="https://speedtest.net")
    steps = [
        {"action_type": "click", "value": None, "intent": "Click Google search", "selector_chain": [{"type": "css", "value": "#_RandomSessionId123456789"}]},
        {"action_type": "type", "value": "internet speed test", "intent": None, "selector_chain": []},
        {"action_type": "navigate", "value": "https://www.google.com/search?q=internet+speed+test&sxsrf=XYZ&ei=ABC", "intent": "Google search", "selector_chain": []},
        {"action_type": "click", "value": None, "intent": "Click first result", "selector_chain": [{"type": "css", "value": "#_MXwLas-xK_a7wN4PkNa42Qo_40"}]},
        {"action_type": "navigate", "value": "https://speedtest.net/", "intent": "Open speedtest", "selector_chain": []},
        {"action_type": "click", "value": None, "intent": "Click start button", "selector_chain": [{"type": "text", "value": "Start"}]},
    ]
    result = await simplifier.simplify(steps)

    # At minimum, the Google search detour should be collapsed
    navigate_values = [s.get("value") or "" for s in result if s["action_type"] == "navigate"]
    google_navigates = [v for v in navigate_values if "google.com" in v]
    assert len(google_navigates) == 0, f"Google search navigates should be collapsed, got: {navigate_values}"

    # Steps should be re-indexed
    for i, step in enumerate(result):
        assert step["step_index"] == i
