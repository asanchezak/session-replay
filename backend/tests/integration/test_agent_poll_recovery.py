from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient

from core.config import settings
from services.agent_models import SAFETY_LIMITS
from services.agent_service import _run_active_step, _run_step_recovery_started_at

API_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


async def _create_run(api_client: AsyncClient, name: str) -> str:
    wf_resp = await api_client.post(
        "/v1/workflows",
        json={"name": name},
        headers=API_HEADERS,
    )
    wf_id = wf_resp.json()["id"]
    await api_client.post(
        f"/v1/workflows/{wf_id}/steps",
        json={
            "step_index": 0,
            "action_type": "click",
            "intent": "Click unstable button",
            "selector_chain": [{"type": "css", "value": "#unstable"}],
        },
        headers=API_HEADERS,
    )
    await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        json={"status": "active"},
        headers=API_HEADERS,
    )
    run_resp = await api_client.post(
        f"/v1/workflows/{wf_id}/run",
        headers=API_HEADERS,
    )
    assert run_resp.status_code == 200
    return run_resp.json()["id"]


def _poll_payload() -> dict:
    return {
        "current_step_index": 0,
        "page_context": {
            "url": "https://example.com/unstable",
            "title": "Unstable",
            "visible_text": "Loading",
            "visible_elements": [{"selector": "#unstable", "text": "Iniciar"}],
            "is_blocking": False,
            "page_diff": {"added": []},
        },
    }


@pytest.mark.asyncio
async def test_poll_recovery_never_moves_to_waiting_for_user_under_window(api_client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "deterministic_only", False, raising=False)
    monkeypatch.setattr(settings, "ai_step_recovery_window_seconds", 900, raising=False)

    async def _always_wait(*_args, **_kwargs):
        return {
            "decision": "WAIT",
            "confidence": 0.55,
            "reasoning": "Still loading",
            "wait_ms": 1200,
            "thinking_steps": [],
            "decision_context": {"attempt": 1, "strategy": "primary"},
        }

    monkeypatch.setattr("services.agent_service.AgentService._consult_ai_for_step", _always_wait)

    run_id = await _create_run(api_client, "Poll Recovery Window")
    for _ in range(SAFETY_LIMITS["max_consecutive_waits_per_step"] + 2):
        poll_resp = await api_client.post(
            f"/v1/agent/{run_id}/poll",
            json=_poll_payload(),
            headers=API_HEADERS,
        )
        assert poll_resp.status_code == 200
        assert poll_resp.json()["decision"] == "WAIT"

    run_state = await api_client.get(f"/v1/runs/{run_id}", headers=API_HEADERS)
    assert run_state.status_code == 200
    assert run_state.json()["status"] == "running"


@pytest.mark.asyncio
async def test_poll_recovery_timeout_transitions_run_to_failed(api_client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "deterministic_only", False, raising=False)
    monkeypatch.setattr(settings, "ai_step_recovery_window_seconds", 60, raising=False)

    async def _always_none(*_args, **_kwargs):
        return None

    monkeypatch.setattr("services.agent_service.AgentService._consult_ai_for_step", _always_none)

    run_id = await _create_run(api_client, "Poll Recovery Timeout")
    _run_active_step[run_id] = 0
    _run_step_recovery_started_at[(run_id, 0)] = datetime.now(UTC) - timedelta(seconds=180)

    poll_resp = await api_client.post(
        f"/v1/agent/{run_id}/poll",
        json=_poll_payload(),
        headers=API_HEADERS,
    )
    assert poll_resp.status_code == 200
    body = poll_resp.json()
    assert body["decision"] == "PAUSE"
    assert body["requires_human"] is False

    run_state = await api_client.get(f"/v1/runs/{run_id}", headers=API_HEADERS)
    assert run_state.status_code == 200
    assert run_state.json()["status"] == "failed"
