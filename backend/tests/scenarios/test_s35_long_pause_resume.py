"""S35 — Resume after a long pause works; checkpoint snapshot drives the restart.

We can't sleep for 24 hours in CI, so the test asserts:
1. A paused run's `pause_reason` and `current_step_index` are persisted.
2. A separate checkpoint event is recorded with the snapshot.
3. Resuming transitions back to RUNNING with the same current_step_index.
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_pause_checkpoint_resume_preserves_state(api_client):
    wf = (await api_client.post("/v1/workflows", json={"name": "long"}, headers=_HEADERS)).json()
    for i in range(3):
        await api_client.post(
            f"/v1/workflows/{wf['id']}/steps",
            json={"step_index": i, "action_type": "click", "selector_chain": [{"type": "css", "value": f"#x{i}"}]},
            headers=_HEADERS,
        )
    await api_client.put(
        f"/v1/workflows/{wf['id']}/status",
        json={"status": "active"},
        headers=_HEADERS,
    )
    # Use /workflows/{id}/run which both creates and transitions to running.
    run = (await api_client.post(f"/v1/workflows/{wf['id']}/run", headers=_HEADERS)).json()
    run_id = run["id"]

    # Advance one step
    await api_client.post(
        f"/v1/runs/{run_id}/step-result",
        json={"step_index": 0, "success": True, "action_type": "click"},
        headers=_HEADERS,
    )

    # Pause
    p = await api_client.post(f"/v1/runs/{run_id}/pause", json={"reason": "user paused for break"}, headers=_HEADERS)
    assert p.status_code == 200, p.text
    assert p.json()["pause_reason"] == "user paused for break"

    # Checkpoint
    c = await api_client.post(
        f"/v1/runs/{run_id}/checkpoint",
        json={"step_index": 1, "snapshot": {"viewport": [1024, 768]}},
        headers=_HEADERS,
    )
    assert c.status_code == 200
    assert c.json()["checkpoint_step"] == 1

    # Resume
    res = await api_client.post(f"/v1/runs/{run_id}/resume", headers=_HEADERS)
    assert res.status_code == 200
    assert res.json()["status"] == "running"

    # Confirm current_step_index preserved
    g = await api_client.get(f"/v1/runs/{run_id}", headers=_HEADERS)
    assert g.json()["current_step_index"] == 1

    # Audit has a checkpoint event
    a = await api_client.get(f"/v1/audit/{run_id}", headers=_HEADERS)
    events = a.json()["events"]
    types = [e["event_type"] for e in events]
    assert "checkpoint" in types
    assert "run_waiting_for_user" in types
    assert "run_running" in types
