from __future__ import annotations

import pytest

HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_update_step_scores(db_session, api_client):
    """Update-step endpoint accepts selector_chain with scores."""
    headers = HEADERS
    wf = (await api_client.post(
        "/v1/workflows", json={"name": "Score Test"}, headers=headers,
    )).json()
    await api_client.post(
        f"/v1/workflows/{wf['id']}/steps",
        json={
            "step_index": 0, "action_type": "click",
            "intent": "test",
            "selector_chain": {"type": "css", "value": "#btn"},
        },
        headers=headers,
    )

    resp = await api_client.put(
        f"/v1/workflows/{wf['id']}/steps/0",
        json={
            "selector_chain": [
                {"type": "css", "value": "#btn", "score": 0.95},
                {"type": "text", "value": "Click", "score": 0.70},
            ],
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_empty_chain_defaults(db_session, api_client):
    """Step with no selector_chain doesn't crash."""
    headers = HEADERS
    wf = (await api_client.post(
        "/v1/workflows", json={"name": "Empty Chain"}, headers=headers,
    )).json()
    resp = await api_client.post(
        f"/v1/workflows/{wf['id']}/steps",
        json={
            "step_index": 0, "action_type": "navigate",
            "intent": "go to url",
            "value": "https://example.com",
        },
        headers=headers,
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_workflow_get_returns_steps(db_session, api_client):
    """Workflow detail includes steps with stored data."""
    headers = HEADERS
    wf = (await api_client.post(
        "/v1/workflows", json={"name": "Get Steps Test"}, headers=headers,
    )).json()
    await api_client.post(
        f"/v1/workflows/{wf['id']}/steps",
        json={
            "step_index": 0, "action_type": "click",
            "intent": "test",
            "selector_chain": {
                "type": "css", "value": "#btn", "score": 0.8,
            },
        },
        headers=headers,
    )
    resp = await api_client.get(f"/v1/workflows/{wf['id']}", headers=headers)
    steps = resp.json().get("steps", [])
    assert len(steps) >= 1
    chain = steps[0].get("selector_chain", {})
    if isinstance(chain, dict):
        assert chain.get("score") == 0.8
