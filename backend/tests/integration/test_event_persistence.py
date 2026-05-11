import uuid

import pytest
from httpx import AsyncClient

API_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.mark.asyncio
async def test_record_event(api_client: AsyncClient):
    test_run_id = str(uuid.uuid4())
    response = await api_client.post(
        "/v1/events/record",
        json={
            "event_type": "click",
            "payload": {
                "selector": "#submit-btn",
                "tag": "button",
                "text": "Submit",
            },
            "page_url": "https://example.com",
            "page_title": "Example",
            "run_id": test_run_id,
            "actor_type": "extension",
        },
        headers=API_HEADERS,
    )
    assert response.status_code == 200
    data = response.json()
    assert "id" in data
    assert "hash" in data
    assert "previous_hash" in data
    assert len(data["hash"]) == 64


@pytest.mark.asyncio
async def test_record_event_missing_api_key(api_client: AsyncClient):
    response = await api_client.post(
        "/v1/events/record",
        json={"event_type": "click", "payload": {}, "run_id": str(uuid.uuid4())},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_record_event_invalid_type(api_client: AsyncClient):
    response = await api_client.post(
        "/v1/events/record",
        json={"event_type": "invalid_type", "payload": {}, "run_id": str(uuid.uuid4())},
        headers=API_HEADERS,
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_get_event(api_client: AsyncClient):
    test_run_id = str(uuid.uuid4())
    post_resp = await api_client.post(
        "/v1/events/record",
        json={
            "event_type": "navigate",
            "payload": {"url": "/home"},
            "page_url": "https://example.com",
            "run_id": test_run_id,
        },
        headers=API_HEADERS,
    )
    event_id = post_resp.json()["id"]

    get_resp = await api_client.get(f"/v1/events/{event_id}", headers=API_HEADERS)
    assert get_resp.status_code == 200
    data = get_resp.json()
    assert data["event_type"] == "navigate"
    assert data["payload"] == {"url": "/home"}


@pytest.mark.asyncio
async def test_hash_chain_linking(api_client: AsyncClient):
    test_run_id = str(uuid.uuid4())
    r1 = await api_client.post(
        "/v1/events/record",
        json={"event_type": "click", "payload": {"step": 1}, "run_id": test_run_id},
        headers=API_HEADERS,
    )
    r2 = await api_client.post(
        "/v1/events/record",
        json={"event_type": "click", "payload": {"step": 2}, "run_id": test_run_id},
        headers=API_HEADERS,
    )

    e1 = r1.json()
    e2 = r2.json()

    assert e1["hash"] != e2["hash"]
    assert e2["previous_hash"] == e1["hash"]
