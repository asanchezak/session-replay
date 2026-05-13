"""S34 — Workflow deleted while a run is queued.

Today the state machine forbids QUEUED→FAILED (B-M-01). The pure-state-machine
piece is xfail; the API-level behavior (DELETE workflow with a queued run)
should at least not crash.
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_workflow_delete_with_queued_run_does_not_crash(api_client):
    wf = (await api_client.post("/v1/workflows", json={"name": "to-delete"}, headers=_HEADERS)).json()
    await api_client.post(
        f"/v1/workflows/{wf['id']}/steps",
        json={"step_index": 0, "action_type": "click", "selector_chain": {"type": "css", "value": "#x"}},
        headers=_HEADERS,
    )
    run = (await api_client.post("/v1/runs", json={"workflow_id": wf["id"]}, headers=_HEADERS)).json()
    assert run["status"] == "queued"

    # No DELETE endpoint exists today, but the bug is reachable via the service.
    # Skip if the API doesn't expose DELETE.
    r = await api_client.delete(f"/v1/workflows/{wf['id']}", headers=_HEADERS)
    if r.status_code == 404 or r.status_code == 405:
        pytest.skip("DELETE /v1/workflows/{id} not yet exposed")
    assert r.status_code in (200, 204)


def test_state_machine_allows_queued_to_failed():
    from core.state_machine import RunStatus, WorkflowStateMachine
    assert WorkflowStateMachine.can_transition(RunStatus.QUEUED, RunStatus.FAILED)
