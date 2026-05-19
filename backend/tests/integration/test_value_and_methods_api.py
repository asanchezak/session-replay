"""Integration tests for value and methods in API endpoints."""

import pytest
from httpx import AsyncClient

API_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_add_step_with_value(api_client: AsyncClient):
    """POST step with value returns value in response."""
    wf_resp = await api_client.post("/v1/workflows", json={"name": "Val Test"}, headers=API_HEADERS)
    wf_id = wf_resp.json()["id"]

    resp = await api_client.post(
        f"/v1/workflows/{wf_id}/steps",
        json={
            "step_index": 0,
            "action_type": "type",
            "intent": "Type search",
            "selector_chain": [{"type": "css", "value": "#search"}],
            "value": "hello world",
        },
        headers=API_HEADERS,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["value"] == "hello world"
    assert data["action_type"] == "type"


@pytest.mark.asyncio
async def test_add_step_with_methods(api_client: AsyncClient):
    """POST step with methods returns methods in response."""
    wf_resp = await api_client.post(
        "/v1/workflows", json={"name": "Meth Test"}, headers=API_HEADERS
    )
    wf_id = wf_resp.json()["id"]

    resp = await api_client.post(
        f"/v1/workflows/{wf_id}/steps",
        json={
            "step_index": 0,
            "action_type": "click",
            "intent": "Click submit",
            "selector_chain": [{"type": "css", "value": "#submit"}],
            "methods": [
                {
                    "action_type": "click",
                    "selector_chain": [{"type": "css", "value": "#submit-new"}],
                },
                {
                    "action_type": "click",
                    "selector_chain": [{"type": "text", "value": "Submit"}],
                },
            ],
        },
        headers=API_HEADERS,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["methods"] is not None
    assert len(data["methods"]) == 2
    assert data["methods"][0]["action_type"] == "click"
    assert data["methods"][1]["selector_chain"][0]["value"] == "Submit"


@pytest.mark.asyncio
async def test_add_step_navigate_in_methods_rejected(api_client: AsyncClient):
    """POST step with navigate in methods returns 422."""
    wf_resp = await api_client.post("/v1/workflows", json={"name": "Nav Test"}, headers=API_HEADERS)
    wf_id = wf_resp.json()["id"]

    resp = await api_client.post(
        f"/v1/workflows/{wf_id}/steps",
        json={
            "step_index": 0,
            "action_type": "click",
            "methods": [
                {"action_type": "navigate", "selector_chain": [{"type": "css", "value": "#x"}]},
            ],
        },
        headers=API_HEADERS,
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_get_workflow_returns_value_and_methods(api_client: AsyncClient):
    """GET workflow returns value and methods per step."""
    wf_resp = await api_client.post(
        "/v1/workflows", json={"name": "Get WM Test"}, headers=API_HEADERS
    )
    wf_id = wf_resp.json()["id"]

    await api_client.post(
        f"/v1/workflows/{wf_id}/steps",
        json={
            "step_index": 0,
            "action_type": "click",
            "value": "test-val",
            "methods": [
                {"action_type": "click", "selector_chain": [{"type": "css", "value": "#b"}]}
            ],
        },
        headers=API_HEADERS,
    )

    resp = await api_client.get(f"/v1/workflows/{wf_id}", headers=API_HEADERS)
    assert resp.status_code == 200
    steps = resp.json()["steps"]
    assert len(steps) == 1
    assert steps[0]["value"] == "test-val"
    assert len(steps[0]["methods"]) == 1


@pytest.mark.asyncio
async def test_next_step_returns_value_and_methods(api_client: AsyncClient):
    """GET next-step returns value and methods from snapshot."""
    wf_resp = await api_client.post("/v1/workflows", json={"name": "NS Test"}, headers=API_HEADERS)
    wf_id = wf_resp.json()["id"]

    await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        json={"status": "active"},
        headers=API_HEADERS,
    )
    await api_client.post(
        f"/v1/workflows/{wf_id}/steps",
        json={
            "step_index": 0,
            "action_type": "type",
            "value": "search-term",
            "methods": [
                {
                    "action_type": "type",
                    "selector_chain": [{"type": "css", "value": "#s"}],
                    "value": "search-term",
                }
            ],
        },
        headers=API_HEADERS,
    )

    run_resp = await api_client.post(f"/v1/workflows/{wf_id}/run", headers=API_HEADERS)
    run_id = run_resp.json()["id"]

    ns_resp = await api_client.post(f"/v1/runs/{run_id}/next-step", headers=API_HEADERS)
    assert ns_resp.status_code == 200, ns_resp.text
    data = ns_resp.json()
    assert data["value"] == "search-term"
    assert data["methods"] is not None
    assert len(data["methods"]) == 1


@pytest.mark.asyncio
async def test_add_step_without_value_methods_legacy(api_client: AsyncClient):
    """POST step without value/methods works as before (backward compat)."""
    wf_resp = await api_client.post(
        "/v1/workflows", json={"name": "Legacy Compat"}, headers=API_HEADERS
    )
    wf_id = wf_resp.json()["id"]

    resp = await api_client.post(
        f"/v1/workflows/{wf_id}/steps",
        json={
            "step_index": 0,
            "action_type": "click",
            "intent": "Old style",
            "selector_chain": [{"type": "css", "value": "#old-btn"}],
        },
        headers=API_HEADERS,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["value"] is None
    assert data["methods"] is None
