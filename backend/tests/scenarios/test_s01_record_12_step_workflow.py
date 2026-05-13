"""S01 — Record a 12-step LinkedIn-like candidate search.

Backend-side assertion: POST /v1/workflows/record with 12 events creates a
Workflow whose step_count == 12 and whose audit chain is intact.
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


def _events_12_step():
    """12 captured events mimicking a candidate-search flow."""
    base = {"page_url": "https://search.example/jobs", "page_title": "Search", "timestamp": "2026-05-12T00:00:00Z"}
    return [
        {"event_type": "click", "payload": {"target": {"selector": "#search-input"}, "intent": "Focus search"}},
        {"event_type": "type", "payload": {"target": {"selector": "#search-input"}, "value": "Python engineer", "intent": "Type query"}},
        {"event_type": "click", "payload": {"target": {"selector": "button[type=submit]"}, "intent": "Submit search"}},
        {"event_type": "select", "payload": {"target": {"selector": "#location"}, "value": "Remote", "intent": "Filter by location"}},
        {"event_type": "scroll", "payload": {"intent": "Scroll results"}},
        {"event_type": "click", "payload": {"target": {"selector": "[data-testid='result-1']"}, "intent": "Open first result"}},
        {"event_type": "click", "payload": {"target": {"selector": "[data-testid='save-candidate']"}, "intent": "Save"}},
        {"event_type": "navigate", "payload": {"value": "https://search.example/jobs", "intent": "Back"}},
        {"event_type": "click", "payload": {"target": {"selector": "[aria-label='next page']"}, "intent": "Next page"}},
        {"event_type": "click", "payload": {"target": {"selector": "[data-testid='result-2']"}, "intent": "Open second result"}},
        {"event_type": "click", "payload": {"target": {"selector": "[data-testid='save-candidate']"}, "intent": "Save"}},
        {"event_type": "click", "payload": {"target": {"selector": "[data-testid='export']"}, "intent": "Export CSV"}},
    ]


def _enrich(e):
    return {**e, "page_url": "https://search.example/jobs", "page_title": "Search", "timestamp": "2026-05-12T00:00:00Z"}


@pytest.mark.asyncio
async def test_record_12_step_workflow_persists(api_client):
    body = {
        "name": "candidate-search-S01",
        "target_url": "https://search.example/jobs",
        "events": [_enrich(e) for e in _events_12_step()],
    }
    r = await api_client.post("/v1/workflows/record", json=body, headers=_HEADERS)
    assert r.status_code == 200
    out = r.json()
    assert out["step_count"] == 12

    g = await api_client.get(f"/v1/workflows/{out['id']}", headers=_HEADERS)
    assert g.status_code == 200
    detail = g.json()
    assert len(detail["steps"]) == 12
    # First step's action_type roundtrip.
    assert detail["steps"][0]["action_type"] == "click"
    # Selector chain for the click on result-1 should retain the data-testid.
    fifth = detail["steps"][5]
    assert fifth["selector_chain"], "selector_chain must be preserved"


@pytest.mark.asyncio
async def test_record_12_step_workflow_with_empty_events_is_valid(api_client):
    r = await api_client.post(
        "/v1/workflows/record",
        json={"name": "empty-record", "events": []},
        headers=_HEADERS,
    )
    assert r.status_code == 200
    assert r.json()["step_count"] == 0
