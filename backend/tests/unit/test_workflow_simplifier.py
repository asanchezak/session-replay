"""Unit tests for the WorkflowSimplifier 5-pass pipeline."""
import json
import pytest

from services.workflow_simplifier import (
    WorkflowSimplifier,
    _clean_url,
    _pass1_clean_urls,
    _pass2_filter_selectors,
    _pass3_collapse,
    _pass3b_mark_checkpoints,
    _is_ephemeral_selector,
    _synthesize_intent,
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


def test_pass2_empty_chain_marks_intent_only():
    step = {
        "action_type": "click",
        "intent": "Click the big button",
        "selector_chain": [{"type": "css", "value": "#_RandomlyGeneratedId_xyz123abc456"}],
    }
    result = _pass2_filter_selectors([step])[0]
    assert result.get("intent_only") is True
    assert result["selector_chain"] == []


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
    # Should start with the speedtest navigate, not the google ones
    navigate_values = [v for v in values if v and "speedtest" in v]
    assert len(navigate_values) >= 1
    # The result should be shorter than original (search detour removed)
    assert len(result) < len(steps)


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
# Pass 4 — AI holistic simplification
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Full simplifier pipeline
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_simplifier_full_pipeline_speedtest(monkeypatch):
    class IdentityProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            # Return whatever steps are in the prompt as-is (parse from prompt)
            import re
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
