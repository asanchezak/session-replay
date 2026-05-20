"""Workstream C: conversation persistence helpers."""
from __future__ import annotations

from types import SimpleNamespace

from ai.client import ToolCall
from services.agent_conversation import (
    HISTORICAL_TEXT_BUDGET,
    MAX_HISTORY_MESSAGES,
    append_assistant_turn,
    append_tool_result,
    append_user_turn,
    load_conversation,
    save_conversation,
    trim_for_persistence,
)


def test_load_conversation_empty_when_run_has_no_history():
    run = SimpleNamespace(ai_conversation=None)
    assert load_conversation(run) == []
    run2 = SimpleNamespace(ai_conversation=[])
    assert load_conversation(run2) == []


def test_load_conversation_filters_non_dict_entries():
    run = SimpleNamespace(ai_conversation=[
        {"role": "user", "content": "hi"},
        "junk",
        {"role": "assistant", "content": "yo"},
    ])
    msgs = load_conversation(run)
    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"


def test_append_helpers_build_canonical_openai_shape():
    msgs: list = []
    append_user_turn(msgs, "what's the page state?")
    append_assistant_turn(msgs, "", tool_calls=[ToolCall("c1", "wait", {"wait_ms": 1000})])
    append_tool_result(msgs, "c1", {"ok": True})

    assert msgs[0] == {"role": "user", "content": "what's the page state?"}
    assert msgs[1]["role"] == "assistant"
    assert msgs[1]["content"] is None
    assert msgs[1]["tool_calls"][0]["function"]["name"] == "wait"
    assert msgs[1]["tool_calls"][0]["function"]["arguments"] == '{"wait_ms": 1000}'
    assert msgs[2] == {"role": "tool", "tool_call_id": "c1", "content": '{"ok": true}'}


def test_trim_windows_to_max_history():
    msgs = [{"role": "user", "content": f"msg-{i}"} for i in range(30)]
    out = trim_for_persistence(msgs)
    assert len(out) == MAX_HISTORY_MESSAGES
    # Most recent kept
    assert out[-1]["content"] == "msg-29"


def test_trim_strips_image_blocks_from_prior_user_turns():
    old_user = {
        "role": "user",
        "content": [
            {"type": "text", "text": "old page"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}},
        ],
    }
    current_user = {"role": "user", "content": "current page"}
    out = trim_for_persistence([old_user, current_user])
    # Old user's image_url stripped; text part flattened to a plain string
    assert out[0]["content"] == "old page"
    # Current preserved verbatim
    assert out[1]["content"] == "current page"


def test_trim_summarizes_long_text_in_prior_user_turns():
    long = "X" * (HISTORICAL_TEXT_BUDGET + 500)
    out = trim_for_persistence([
        {"role": "user", "content": long},
        {"role": "user", "content": "current"},
    ])
    assert len(out[0]["content"]) < len(long)
    assert "...[truncated for history]" in out[0]["content"]
    assert out[1]["content"] == "current"


def test_trim_preserves_assistant_and_tool_messages_verbatim():
    msgs = [
        {"role": "user", "content": "Y" * 1000},  # gets summarized (not last user)
        {"role": "assistant", "content": "thinking...", "tool_calls": [{"id": "1"}]},
        {"role": "tool", "tool_call_id": "1", "content": '{"r": 42}'},
        {"role": "user", "content": "current"},
    ]
    out = trim_for_persistence(msgs)
    assert out[1] == msgs[1]  # assistant unchanged
    assert out[2] == msgs[2]  # tool unchanged


def test_save_conversation_writes_trimmed_list_onto_run():
    run = SimpleNamespace(ai_conversation=None)
    long_msgs = [{"role": "user", "content": f"m-{i}"} for i in range(40)]
    save_conversation(run, long_msgs)
    assert isinstance(run.ai_conversation, list)
    assert len(run.ai_conversation) == MAX_HISTORY_MESSAGES
