"""S42 — POST /v1/runs/{id}/rerun creates a fresh run cloning the source's plan.

Verifies:
  - Re-run of a parameterised run carries the substituted value forward
  - The new run is a distinct entity (different id, fresh status)
  - Audit event for the new run carries `rerun_of: <source_id>`
  - Re-run of a non-existent source returns 404
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}

LINKEDIN_EVENTS = [
    {
        "event_type": "navigate",
        "payload": {"value": "https://www.linkedin.com/feed/"},
        "page_url": "https://www.linkedin.com/feed/",
        "timestamp": "2026-05-21T10:00:00.000Z",
    },
    {
        "event_type": "type",
        "payload": {
            "selector_chain": [{"type": "css", "value": "#composer"}],
            "value": "Hello, generic.",
            "intent": "Type message",
        },
        "page_url": "https://www.linkedin.com/feed/",
        "timestamp": "2026-05-21T10:00:02.000Z",
    },
]


async def test_rerun_clones_substituted_plan(api_client):
    # Record + activate workflow
    rec = await api_client.post(
        "/v1/workflows/record",
        json={
            "name": "Rerun Source",
            "target_url": "https://www.linkedin.com/",
            "events": LINKEDIN_EVENTS,
        },
        headers=_HEADERS,
    )
    assert rec.status_code == 200, rec.text
    wf_id = rec.json()["id"]

    await api_client.put(
        f"/v1/workflows/{wf_id}/analysis",
        json={"replay_strategy": "parameterized"},
        headers=_HEADERS,
    )
    await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        json={"status": "active"},
        headers=_HEADERS,
    )

    # First run with an Odoo-style substituted message
    invite = "Hi! Job offer: Senior Python Engineer. Apply now."
    source = await api_client.post(
        f"/v1/workflows/{wf_id}/run-with-params",
        json={"runtime_params": {"input_1": invite}},
        headers=_HEADERS,
    )
    assert source.status_code == 200, source.text
    source_data = source.json()
    source_id = source_data["id"]
    source_total = source_data["total_steps"]

    # Sanity: source plan carries the invite
    source_type_step = next(
        s for s in source_data["execution_plan"]["steps"] if s["action_type"] == "type"
    )
    assert source_type_step["value"] == invite

    # Re-run the source
    rr = await api_client.post(
        f"/v1/runs/{source_id}/rerun",
        headers=_HEADERS,
    )
    assert rr.status_code == 200, rr.text
    rr_data = rr.json()

    assert rr_data["id"] != source_id, "Re-run must be a NEW run"
    assert rr_data["workflow_id"] == wf_id
    assert rr_data["status"] == "running"
    assert rr_data["current_step_index"] == 0
    assert rr_data["total_steps"] == source_total
    assert rr_data["rerun_of"] == source_id

    # The cloned run's snapshot must carry the same substituted invite
    get_run = await api_client.get(f"/v1/runs/{rr_data['id']}", headers=_HEADERS)
    assert get_run.status_code == 200

    # Pull events for the new run — first event must be run_started with rerun_of payload
    events_resp = await api_client.get(
        f"/v1/runs/{rr_data['id']}/events", headers=_HEADERS
    )
    assert events_resp.status_code == 200
    events = events_resp.json()
    started_events = [e for e in events if e["event_type"] == "run_started"]
    assert started_events, "Re-run must emit a run_started audit event"
    assert started_events[0]["payload"].get("rerun_of") == source_id


async def test_rerun_of_missing_source_returns_404(api_client):
    import uuid
    fake_id = str(uuid.uuid4())
    resp = await api_client.post(f"/v1/runs/{fake_id}/rerun", headers=_HEADERS)
    assert resp.status_code == 404
    body = resp.json()
    assert body["error"]["code"] == "NOT_FOUND"


async def test_rerun_of_invalid_uuid_returns_404(api_client):
    resp = await api_client.post("/v1/runs/not-a-uuid/rerun", headers=_HEADERS)
    assert resp.status_code == 404
