"""Workstream C: translate OpenAI tool_calls into the existing ai_decision
dict shape so the dispatcher in AgentService.poll() works unchanged.

The legacy code path returned a dict like
    {"decision": "EXECUTE|ADAPT|...", "confidence": float, "reasoning": str,
     "command": {...}, "plan_updates": [...], "wait_ms": int, ...}
This module produces the same shape from one or more tool_calls plus
context about the recorded step (so we can decide ADAPT vs EXECUTE).

Returns None when the model emitted no actionable tool — the caller should
treat that as a soft WAIT and re-poll.
"""
from __future__ import annotations

import logging
from typing import Any

from pydantic import ValidationError

from ai.agent_tools import TOOL_INPUT_MODELS
from ai.client import ToolCall

logger = logging.getLogger(__name__)


def _selectors_match_recorded(
    new_chain: list[dict[str, Any]],
    recorded_chain: list[dict[str, Any]],
) -> bool:
    """Heuristic: when the model's selector_chain equals the recorded one
    (same set of {type, value} tuples), this is an EXECUTE; otherwise it's
    an ADAPT. Both sets are compared without ordering to tolerate selector
    ranking differences."""
    if not recorded_chain:
        return not new_chain  # no recorded selectors and none emitted -> match
    new_keys = {(s.get("type"), s.get("value")) for s in (new_chain or [])}
    recorded_keys = {(s.get("type"), s.get("value")) for s in recorded_chain}
    return bool(new_keys) and new_keys == recorded_keys


def _coalesce_plan_updates(calls: list[ToolCall]) -> list[dict[str, Any]]:
    """Extract all update_plan tool calls from the turn into a flat ops list."""
    ops: list[dict[str, Any]] = []
    for tc in calls:
        if tc.name != "update_plan":
            continue
        try:
            model = TOOL_INPUT_MODELS["update_plan"](**tc.arguments)
            for op in model.operations:
                ops.append(op.model_dump(mode="json"))
        except ValidationError as exc:
            logger.warning("Rejected invalid update_plan call: %s", exc)
    return ops


def translate_tool_calls(
    calls: list[ToolCall],
    *,
    recorded_step: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Translate a list of tool calls from one model turn into an
    ai_decision dict.

    Strategy:
    - If exactly one terminal tool was called (action/wait/skip/restart/
      rollback/pause/mark_complete), return that as the decision.
    - If update_plan was called alongside a terminal tool, the terminal tool
      wins and plan_updates is populated.
    - If only update_plan was called, return None — the caller should iterate
      the inner loop (feed plan-applied tool_result back, re-ask the model).
    - If multiple terminal tools were called, honor the first valid one and
      log a warning (model contract violation).
    """
    if not calls:
        return None

    plan_updates = _coalesce_plan_updates(calls)
    terminal_tools = [c for c in calls if c.name != "update_plan"]

    if not terminal_tools:
        # Only update_plan — caller should iterate. Return a sentinel dict
        # so the caller can apply the plan_updates then re-prompt.
        if plan_updates:
            return {
                "decision": "PLAN_ONLY",  # sentinel for the inner loop; not a wire decision
                "confidence": 0.7,
                "reasoning": "Plan updated; awaiting next action.",
                "plan_updates": plan_updates,
            }
        return None

    if len(terminal_tools) > 1:
        logger.warning(
            "Model emitted %d terminal tool calls in one turn; selecting first valid call",
            len(terminal_tools),
        )

    tc = None
    validated = None
    for candidate in terminal_tools:
        model_cls = TOOL_INPUT_MODELS.get(candidate.name)
        if model_cls is None:
            logger.warning("Unknown tool name: %s", candidate.name)
            continue
        try:
            validated = model_cls(**candidate.arguments)
            tc = candidate
            break
        except ValidationError as exc:
            logger.warning("Invalid arguments for tool '%s': %s", candidate.name, exc)
            continue

    if tc is None or validated is None:
        return None

    result: dict[str, Any] = {
        "tool_call_id": tc.id,
        "plan_updates": plan_updates,
    }

    if tc.name == "execute_action":
        # ADAPT vs EXECUTE: did the model keep the recorded selectors?
        recorded_chain = (recorded_step or {}).get("selector_chain", []) if recorded_step else []
        decision = (
            "EXECUTE"
            if _selectors_match_recorded(validated.selector_chain, recorded_chain)
            else "ADAPT"
        )
        result.update({
            "decision": decision,
            "confidence": validated.confidence,
            "reasoning": validated.reasoning or "AI tool decision",
            "command": {
                "action": validated.action,
                "target": validated.target,
                "value": validated.value,
                "selector_chain": validated.selector_chain,
                "intent": validated.intent,
                "methods": validated.methods,
                "timeout_ms": validated.timeout_ms,
                "script": validated.script,
                "script_args": validated.script_args,
                "script_timeout_ms": validated.script_timeout_ms,
                "delay_before_ms": validated.delay_before_ms,
            },
        })
        return result

    if tc.name == "wait":
        result.update({
            "decision": "WAIT",
            "confidence": validated.confidence,
            "reasoning": validated.reason,
            "wait_ms": validated.wait_ms,
        })
        return result

    if tc.name == "skip_step":
        result.update({
            "decision": "SKIP",
            "confidence": validated.confidence,
            "reasoning": validated.reason,
        })
        return result

    if tc.name == "restart":
        result.update({
            "decision": "RESTART",
            "confidence": validated.confidence,
            "reasoning": validated.reason,
            "command": {
                "action": "navigate",
                "value": validated.target_url,
                "target": validated.target_url,
                "selector_chain": [],
                "intent": "restart workflow",
                "methods": [],
                "timeout_ms": 15000,
            },
        })
        return result

    if tc.name == "rollback":
        result.update({
            "decision": "ROLLBACK",
            "confidence": validated.confidence,
            "reasoning": validated.reason,
            "rollback_to": validated.checkpoint_step_index,
            "command": (
                {
                    "action": "navigate",
                    "value": validated.checkpoint_url,
                    "target": validated.checkpoint_url,
                    "selector_chain": [],
                    "intent": "rollback to checkpoint",
                    "methods": [],
                    "timeout_ms": 15000,
                }
                if validated.checkpoint_url
                else None
            ),
        })
        return result

    if tc.name == "pause_for_human":
        result.update({
            "decision": "PAUSE",
            "confidence": validated.confidence,
            "reasoning": validated.pause_reason,
            "pause_reason": validated.pause_reason,
            "requires_human": validated.requires_human,
        })
        return result

    if tc.name == "mark_complete":
        result.update({
            "decision": "COMPLETED",
            "confidence": validated.confidence,
            "reasoning": validated.reason,
        })
        return result

    logger.warning("Unmapped tool '%s' — returning None", tc.name)
    return None
