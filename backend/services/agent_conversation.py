"""Workstream C: helpers for the rolling AI conversation persisted on
ExecutionRun.ai_conversation.

Each entry is an OpenAI Chat Completions message:
    {"role": "system" | "user" | "assistant" | "tool", "content": ...,
     "tool_calls": [...], "tool_call_id": "..."}

Rules:
- Window to the last N (default 20) messages.
- Strip image_url blocks from prior user messages — they were forwarded to
  the model once and would otherwise compound token cost across turns with
  zero marginal signal (the page has moved on). The current poll's image
  is re-attached fresh.
- Replace large text payloads in prior user messages with a 200-char
  summary so historical DOM snippets don't pile up.
"""
from __future__ import annotations

from typing import Any

MAX_HISTORY_MESSAGES = 20
HISTORICAL_TEXT_BUDGET = 200


def load_conversation(run: Any) -> list[dict[str, Any]]:
    """Pull the persisted message list off the run. Returns an empty list
    when nothing has been stored yet."""
    raw = getattr(run, "ai_conversation", None)
    if not raw or not isinstance(raw, list):
        return []
    # Defensive copy so callers can mutate freely.
    return [dict(m) for m in raw if isinstance(m, dict)]


def _strip_images(content: Any) -> Any:
    """If content is a multi-part user message with image_url blocks, drop
    the image_url parts and keep only the text. Plain string content is
    returned unchanged."""
    if isinstance(content, list):
        kept: list[dict[str, Any]] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "image_url":
                continue
            kept.append(part)
        # If we stripped everything down to nothing, return empty string
        # so the OpenAI API doesn't reject the message.
        if not kept:
            return ""
        # If only a single text part remains, flatten to a plain string —
        # smaller payload + same semantics.
        if len(kept) == 1 and isinstance(kept[0], dict) and kept[0].get("type") == "text":
            return kept[0].get("text", "")
        return kept
    return content


def _summarize_text(content: Any) -> Any:
    """For non-current user turns, replace long text payloads with a
    truncated summary. Tool/assistant messages pass through unchanged
    since they're already structured (and usually short)."""
    if isinstance(content, str) and len(content) > HISTORICAL_TEXT_BUDGET:
        return content[:HISTORICAL_TEXT_BUDGET] + "...[truncated for history]"
    if isinstance(content, list):
        # Already structured (post _strip_images may have left a list)
        # — leave as-is.
        return content
    return content


def trim_for_persistence(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply window + image strip + text summary policies. The last user
    message is preserved as-is (it's the current poll's input)."""
    if not messages:
        return []
    # Window first so the bounds are predictable regardless of which
    # messages are user vs assistant vs tool.
    windowed = messages[-MAX_HISTORY_MESSAGES:]
    # Find the index of the LAST user message — preserve that one verbatim;
    # transform earlier user messages.
    last_user_idx = -1
    for i in range(len(windowed) - 1, -1, -1):
        if windowed[i].get("role") == "user":
            last_user_idx = i
            break
    out: list[dict[str, Any]] = []
    for i, msg in enumerate(windowed):
        if msg.get("role") == "user" and i != last_user_idx:
            new_msg = dict(msg)
            stripped = _strip_images(new_msg.get("content"))
            new_msg["content"] = _summarize_text(stripped)
            out.append(new_msg)
        else:
            out.append(dict(msg))
    return out


def append_user_turn(
    messages: list[dict[str, Any]],
    text: str,
) -> list[dict[str, Any]]:
    """Append a fresh user message with text only (images attached at send
    time via generate_with_tools's `images` kwarg)."""
    messages.append({"role": "user", "content": text})
    return messages


def append_assistant_turn(
    messages: list[dict[str, Any]],
    text: str,
    tool_calls: list[Any] | None = None,
) -> list[dict[str, Any]]:
    """Record what the model emitted: optional text content and zero+ tool_calls.
    Tool calls are serialized in the OpenAI message format so a follow-up
    call can re-send them as conversation context."""
    msg: dict[str, Any] = {"role": "assistant"}
    if text:
        msg["content"] = text
    else:
        msg["content"] = None
    if tool_calls:
        msg["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.name,
                    "arguments": _to_json_str(tc.arguments),
                },
            }
            for tc in tool_calls
        ]
    messages.append(msg)
    return messages


def append_tool_result(
    messages: list[dict[str, Any]],
    tool_call_id: str,
    result: Any,
) -> list[dict[str, Any]]:
    """Append the harness's response to a tool_call so the model can
    decide what to do next in the inner loop."""
    messages.append({
        "role": "tool",
        "tool_call_id": tool_call_id,
        "content": _to_json_str(result),
    })
    return messages


def _to_json_str(value: Any) -> str:
    """OpenAI expects tool arguments / content as JSON strings, not dicts."""
    import json
    try:
        return json.dumps(value, default=str)[:4000]
    except (TypeError, ValueError):
        return str(value)[:4000]


def save_conversation(run: Any, messages: list[dict[str, Any]]) -> None:
    """Trim and write the conversation back onto the run. The caller is
    responsible for flushing the session."""
    run.ai_conversation = trim_for_persistence(messages)
