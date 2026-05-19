"""S33 — Run is canceled while a heal is in flight.

Pins: the cancel path must succeed (transition RECOVERING→CANCELED), and any
subsequent heal_result must surface as a 409 STATE_ERROR.
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_cancel_then_heal_result_returns_409(api_client):
    wf = (await api_client.post("/v1/workflows", json={"name": "h"}, headers=_HEADERS)).json()
    await api_client.post(
        f"/v1/workflows/{wf['id']}/steps",
        json={"step_index": 0, "action_type": "click", "selector_chain": [{"type": "css", "value": "#x"}]},
        headers=_HEADERS,
    )
    await api_client.put(
        f"/v1/workflows/{wf['id']}/status",
        json={"status": "active"},
        headers=_HEADERS,
    )
    run = (await api_client.post("/v1/runs", json={"workflow_id": wf["id"]}, headers=_HEADERS)).json()
    run_id = run["id"]

    # queued → running
    # use the run-workflow shortcut by manually transitioning:
    # POST step-result on a queued run is illegal, so we run it via /run endpoint.
    (await api_client.post(f"/v1/workflows/{wf['id']}/run", headers=_HEADERS)).json()
    # The `/run` endpoint creates a fresh run; we need to use *that* run id.
    runs_list = (await api_client.get(f"/v1/runs?workflow_id={wf['id']}", headers=_HEADERS)).json()
    running_run = [r for r in runs_list if r["status"] == "running"][0]

    # Trigger heal (which transitions to RECOVERING)
    rec = await api_client.post(
        f"/v1/runs/{running_run['id']}/recover",
        json={"step_index": 0, "error": "simulated"},
        headers=_HEADERS,
    )
    assert rec.status_code in (200, 201)

    # Cancel
    can = await api_client.post(f"/v1/runs/{running_run['id']}/cancel", headers=_HEADERS)
    assert can.status_code == 200
    assert can.json()["status"] == "canceled"

    # Now attempt heal_result → must 409
    hr = await api_client.post(
        f"/v1/runs/{running_run['id']}/heal-result",
        json={"step_index": 0, "success": True},
        headers=_HEADERS,
    )
    assert hr.status_code == 409
    assert hr.json()["error"]["code"] == "STATE_ERROR"
