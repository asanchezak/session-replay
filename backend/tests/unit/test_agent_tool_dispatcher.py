"""Workstream C: translate_tool_calls correctness.

Each of the 8 tools should produce the expected ai_decision dict shape;
invalid arguments should be rejected (returning None); update_plan-only
turns should surface as the PLAN_ONLY sentinel so the inner loop iterates.
"""
from __future__ import annotations

from ai.client import ToolCall
from services.agent_tool_dispatcher import translate_tool_calls


def _tc(name: str, **args) -> ToolCall:
    return ToolCall(id=f"tc-{name}", name=name, arguments=args)


def test_execute_action_returns_execute_when_selectors_match():
    recorded = {"selector_chain": [{"type": "css", "value": "#submit"}]}
    out = translate_tool_calls([
        _tc("execute_action",
            action="click",
            selector_chain=[{"type": "css", "value": "#submit"}],
            intent="submit", confidence=0.9, reasoning="recorded ok"),
    ], recorded_step=recorded)
    assert out is not None
    assert out["decision"] == "EXECUTE"
    assert out["command"]["action"] == "click"
    assert out["command"]["selector_chain"][0]["value"] == "#submit"
    assert out["confidence"] == 0.9


def test_execute_action_returns_adapt_when_selectors_differ():
    recorded = {"selector_chain": [{"type": "css", "value": "#submit"}]}
    out = translate_tool_calls([
        _tc("execute_action",
            action="click",
            selector_chain=[{"type": "text", "value": "Submit"}],
            intent="submit", confidence=0.7, reasoning="adapted"),
    ], recorded_step=recorded)
    assert out["decision"] == "ADAPT"


def test_execute_action_passes_through_run_script_fields():
    out = translate_tool_calls([
        _tc("execute_action",
            action="run_script",
            script="return document.title;",
            script_args={"sel": "h1"},
            script_timeout_ms=8000,
            intent="extract title", confidence=0.85, reasoning="god-mode"),
    ])
    assert out["command"]["action"] == "run_script"
    assert out["command"]["script"] == "return document.title;"
    assert out["command"]["script_args"] == {"sel": "h1"}
    assert out["command"]["script_timeout_ms"] == 8000


def test_wait_tool_translates_to_wait_decision():
    out = translate_tool_calls([
        _tc("wait", wait_ms=1500, reason="loading", expected_signal="spinner gone"),
    ])
    assert out["decision"] == "WAIT"
    assert out["wait_ms"] == 1500
    assert "loading" in out["reasoning"]


def test_wait_rejects_invalid_range():
    """wait_ms outside [500, 5000] is rejected at Pydantic validation."""
    out = translate_tool_calls([_tc("wait", wait_ms=99, reason="too short")])
    assert out is None


def test_skip_step_tool():
    out = translate_tool_calls([_tc("skip_step", reason="already done")])
    assert out["decision"] == "SKIP"
    assert out["reasoning"] == "already done"


def test_restart_tool_emits_navigate_command():
    out = translate_tool_calls([
        _tc("restart", target_url="https://example.com/start", reason="lost"),
    ])
    assert out["decision"] == "RESTART"
    assert out["command"]["action"] == "navigate"
    assert out["command"]["value"] == "https://example.com/start"


def test_rollback_tool_includes_checkpoint_index():
    out = translate_tool_calls([
        _tc("rollback", checkpoint_step_index=2, checkpoint_url="https://x.com/2",
            reason="back to known state"),
    ])
    assert out["decision"] == "ROLLBACK"
    assert out["rollback_to"] == 2
    assert out["command"]["value"] == "https://x.com/2"


def test_rollback_without_url_has_no_command():
    out = translate_tool_calls([
        _tc("rollback", checkpoint_step_index=1, reason="back"),
    ])
    assert out["decision"] == "ROLLBACK"
    assert out["command"] is None


def test_pause_for_human():
    out = translate_tool_calls([
        _tc("pause_for_human", pause_reason="captcha", requires_human=True),
    ])
    assert out["decision"] == "PAUSE"
    assert out["pause_reason"] == "captcha"
    assert out["requires_human"] is True


def test_mark_complete():
    out = translate_tool_calls([_tc("mark_complete", reason="goal achieved")])
    assert out["decision"] == "COMPLETED"
    assert out["confidence"] >= 0.9


def test_update_plan_only_returns_plan_only_sentinel():
    """When the model emits only update_plan, the caller should iterate
    the inner loop. The sentinel decision allows the caller to detect this."""
    out = translate_tool_calls([
        _tc("update_plan", operations=[
            {"operation": "INSERT", "step_index": 1,
             "new_step": {"action_type": "click"}, "reason": "missing"},
        ]),
    ])
    assert out is not None
    assert out["decision"] == "PLAN_ONLY"
    assert len(out["plan_updates"]) == 1
    assert out["plan_updates"][0]["operation"] == "INSERT"


def test_update_plan_alongside_terminal_tool():
    """When update_plan is emitted with a sibling terminal tool, both apply."""
    out = translate_tool_calls([
        _tc("update_plan", operations=[
            {"operation": "REMOVE", "step_index": 2, "reason": "obsolete"},
        ]),
        _tc("wait", wait_ms=2000, reason="page loading"),
    ])
    assert out["decision"] == "WAIT"
    assert len(out["plan_updates"]) == 1
    assert out["plan_updates"][0]["operation"] == "REMOVE"


def test_empty_call_list_returns_none():
    assert translate_tool_calls([]) is None


def test_unknown_tool_returns_none():
    out = translate_tool_calls([_tc("does_not_exist", foo="bar")])
    assert out is None


def test_multiple_terminal_tools_first_wins():
    """Model contract violation: two terminal tools in one turn. The
    dispatcher honors the first and logs the rest."""
    out = translate_tool_calls([
        _tc("wait", wait_ms=1500, reason="hold"),
        _tc("mark_complete", reason="done"),
    ])
    assert out["decision"] == "WAIT"
