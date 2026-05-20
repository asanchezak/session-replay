"""Workstream A (run_script) backend tests.

Properties under test:
1. The run_script quota in SAFETY_LIMITS caps repeated AI use; the 31st
   attempt downgrades to PAUSE with pause_reason='script_budget_exhausted'.
2. report_result emits a 'script_executed' EventLog row whenever the
   extension reports back script outputs (result/logs/duration_ms present),
   carrying SHA-256, result_preview, logs, duration, success.
3. The quota counter clears on terminal state transitions.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.agent_models import (
    SAFETY_LIMITS,
    AgentCommand,
    CommandAction,
    ResultRequest,
)
from services.agent_service import AgentService, _run_script_count


def _make_svc() -> AgentService:
    svc = AgentService.__new__(AgentService)
    svc.audit = MagicMock()
    svc.audit.append = AsyncMock()
    return svc


def test_run_script_quota_allows_up_to_cap():
    svc = _make_svc()
    _run_script_count.clear()
    run_id = "test-run-1"
    cap = SAFETY_LIMITS["max_run_script_per_run"]
    assert cap == 30
    for _ in range(cap):
        result = svc._check_run_script_quota(run_id, 0, None)
        assert result is None, "quota should permit the first 30 calls"
    assert _run_script_count[run_id] == cap


def test_run_script_quota_pauses_on_overflow():
    svc = _make_svc()
    _run_script_count.clear()
    run_id = "test-run-2"
    cap = SAFETY_LIMITS["max_run_script_per_run"]
    # Burn through the budget
    for _ in range(cap):
        svc._check_run_script_quota(run_id, 5, None)
    # The next call should be denied with PAUSE
    overflow = svc._check_run_script_quota(run_id, 5, None)
    assert overflow is not None
    assert overflow.decision == "PAUSE"
    assert overflow.pause_reason == "script_budget_exhausted"
    assert overflow.requires_human is False
    assert overflow.next_step_index == 5
    # Counter does not increase past the cap when blocked
    assert _run_script_count[run_id] == cap


def test_run_script_quota_annotates_decision_context():
    svc = _make_svc()
    _run_script_count.clear()
    ai_decision: dict[str, Any] = {"decision": "ADAPT", "confidence": 0.7}
    svc._check_run_script_quota("run-x", 2, ai_decision)
    assert ai_decision["decision_context"]["run_script_count"] == 1


def test_clear_recovery_state_resets_script_count():
    svc = _make_svc()
    _run_script_count["run-3"] = 5
    svc._clear_recovery_state("run-3")
    assert "run-3" not in _run_script_count


@pytest.mark.asyncio
async def test_audit_script_execution_emits_event_log():
    svc = _make_svc()
    req = ResultRequest(
        step_index=0,
        success=True,
        error=None,
        script_result={"rows": [1, 2, 3]},
        script_logs=["[log] hello"],
        script_duration_ms=42,
    )
    await svc._audit_script_execution("run-4", req)
    assert svc.audit.append.await_count == 1
    call_args = svc.audit.append.await_args[0][0]
    assert call_args.event_type == "script_executed"
    assert call_args.run_id == "run-4"
    p = call_args.payload
    assert p["step_index"] == 0
    assert p["success"] is True
    assert p["duration_ms"] == 42
    assert p["logs"] == ["[log] hello"]
    assert p["result_type"] == "dict"
    assert p["result_sha256"]
    assert "[1, 2, 3]" in p["result_preview"]


@pytest.mark.asyncio
async def test_audit_script_execution_truncates_giant_result():
    svc = _make_svc()
    huge = {"data": "x" * 10_000}
    req = ResultRequest(
        step_index=1,
        success=True,
        error=None,
        script_result=huge,
        script_logs=[],
        script_duration_ms=5,
    )
    await svc._audit_script_execution("run-5", req)
    p = svc.audit.append.await_args[0][0].payload
    assert len(p["result_preview"]) <= 1024
    assert p["result_len_bytes"] >= 10_000


@pytest.mark.asyncio
async def test_audit_script_execution_caps_logs_at_ten():
    svc = _make_svc()
    req = ResultRequest(
        step_index=0,
        success=True,
        error=None,
        script_result=None,
        script_logs=[f"[log] line {i}" for i in range(50)],
        script_duration_ms=1,
    )
    await svc._audit_script_execution("run-6", req)
    p = svc.audit.append.await_args[0][0].payload
    assert len(p["logs"]) == 10


def test_command_action_run_script_present():
    """Smoke test: prep PR registered the new enum value."""
    assert CommandAction.RUN_SCRIPT.value == "run_script"


def test_agent_command_accepts_script_fields():
    """Pydantic round-trip for the new fields landed in the prep PR."""
    cmd = AgentCommand(
        action=CommandAction.RUN_SCRIPT,
        script="return document.title;",
        script_args={"sel": "h1"},
        script_timeout_ms=8000,
    )
    assert cmd.action == CommandAction.RUN_SCRIPT
    assert cmd.script == "return document.title;"
    assert cmd.script_args == {"sel": "h1"}
    assert cmd.script_timeout_ms == 8000
