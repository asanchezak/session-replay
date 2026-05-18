import uuid

import pytest
from httpx import AsyncClient

API_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


async def _create_active_wf(api_client: AsyncClient, name: str) -> str:
    wf_resp = await api_client.post(
        "/v1/workflows", json={"name": name}, headers=API_HEADERS
    )
    wf_id = wf_resp.json()["id"]
    await api_client.post(
        f"/v1/workflows/{wf_id}/steps",
        json={
            "step_index": 0,
            "action_type": "click",
            "selector_chain": [{"type": "css", "value": "#x"}],
        },
        headers=API_HEADERS,
    )
    await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        json={"status": "active"},
        headers=API_HEADERS,
    )
    return wf_id


@pytest.mark.asyncio
async def test_create_workflow(api_client: AsyncClient):
    response = await api_client.post(
        "/v1/workflows",
        json={"name": "Test WF", "description": "A test workflow"},
        headers=API_HEADERS,
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Test WF"
    assert data["status"] == "draft"


@pytest.mark.asyncio
async def test_list_workflows(api_client: AsyncClient):
    await api_client.post("/v1/workflows", json={"name": "WF 1"}, headers=API_HEADERS)
    await api_client.post("/v1/workflows", json={"name": "WF 2"}, headers=API_HEADERS)

    response = await api_client.get("/v1/workflows", headers=API_HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert len(data) >= 2


@pytest.mark.asyncio
async def test_get_workflow(api_client: AsyncClient):
    create_resp = await api_client.post(
        "/v1/workflows", json={"name": "Get Test"}, headers=API_HEADERS
    )
    wf_id = create_resp.json()["id"]

    response = await api_client.get(f"/v1/workflows/{wf_id}", headers=API_HEADERS)
    assert response.status_code == 200
    assert response.json()["name"] == "Get Test"


@pytest.mark.asyncio
async def test_get_workflow_not_found(api_client: AsyncClient):
    fake_id = str(uuid.uuid4())
    response = await api_client.get(f"/v1/workflows/{fake_id}", headers=API_HEADERS)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


@pytest.mark.asyncio
async def test_create_run(api_client: AsyncClient):
    wf_resp = await api_client.post(
        "/v1/workflows", json={"name": "Run Test"}, headers=API_HEADERS
    )
    wf_id = wf_resp.json()["id"]

    response = await api_client.post(
        "/v1/runs", json={"workflow_id": wf_id}, headers=API_HEADERS
    )
    assert response.status_code == 200
    assert response.json()["status"] == "queued"


@pytest.mark.asyncio
async def test_run_workflow(api_client: AsyncClient):
    wf_id = await _create_active_wf(api_client, "Run WF")

    response = await api_client.post(
        f"/v1/workflows/{wf_id}/run", headers=API_HEADERS
    )
    assert response.status_code == 200
    assert response.json()["status"] == "running"


@pytest.mark.asyncio
async def test_pause_resume_run(api_client: AsyncClient):
    wf_id = await _create_active_wf(api_client, "Pause Test")

    run_resp = await api_client.post(
        f"/v1/workflows/{wf_id}/run", headers=API_HEADERS
    )
    run_id = run_resp.json()["id"]

    pause_resp = await api_client.post(
        f"/v1/runs/{run_id}/pause",
        json={"reason": "CAPTCHA"},
        headers=API_HEADERS,
    )
    assert pause_resp.status_code == 200
    assert pause_resp.json()["status"] == "waiting_for_user"
    assert pause_resp.json()["pause_reason"] == "CAPTCHA"

    resume_resp = await api_client.post(
        f"/v1/runs/{run_id}/resume", headers=API_HEADERS
    )
    assert resume_resp.status_code == 200
    assert resume_resp.json()["status"] == "running"


@pytest.mark.asyncio
async def test_cancel_run(api_client: AsyncClient):
    wf_id = await _create_active_wf(api_client, "Cancel Test")

    run_resp = await api_client.post(
        f"/v1/workflows/{wf_id}/run", headers=API_HEADERS
    )
    run_id = run_resp.json()["id"]

    cancel_resp = await api_client.post(
        f"/v1/runs/{run_id}/cancel", headers=API_HEADERS
    )
    assert cancel_resp.status_code == 200
    assert cancel_resp.json()["status"] == "canceled"


@pytest.mark.asyncio
async def test_complete_run(api_client: AsyncClient):
    wf_id = await _create_active_wf(api_client, "Complete Test")

    run_resp = await api_client.post(
        f"/v1/workflows/{wf_id}/run", headers=API_HEADERS
    )
    run_id = run_resp.json()["id"]

    complete_resp = await api_client.post(
        f"/v1/runs/{run_id}/complete", headers=API_HEADERS
    )
    assert complete_resp.status_code == 200
    assert complete_resp.json()["status"] == "completed"


@pytest.mark.asyncio
async def test_fail_run(api_client: AsyncClient):
    wf_id = await _create_active_wf(api_client, "Fail Test")

    run_resp = await api_client.post(
        f"/v1/workflows/{wf_id}/run", headers=API_HEADERS
    )
    run_id = run_resp.json()["id"]

    fail_resp = await api_client.post(
        f"/v1/runs/{run_id}/fail",
        json={"error": "Element not found"},
        headers=API_HEADERS,
    )
    assert fail_resp.status_code == 200
    assert fail_resp.json()["status"] == "failed"
    assert fail_resp.json()["error"] == "Element not found"


@pytest.mark.asyncio
async def test_auth_required_on_get(api_client: AsyncClient):
    response = await api_client.get("/v1/workflows")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_auth_required_on_post(api_client: AsyncClient):
    response = await api_client.post("/v1/workflows", json={"name": "test"})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_health_no_auth(api_client: AsyncClient):
    response = await api_client.get("/v1/health")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_error_contract_on_404(api_client: AsyncClient):
    fake_id = str(uuid.uuid4())
    response = await api_client.get(
        f"/v1/workflows/{fake_id}", headers=API_HEADERS
    )
    assert response.status_code == 404
    body = response.json()
    assert "error" in body
    assert "code" in body["error"]
    assert "message" in body["error"]


@pytest.mark.asyncio
async def test_audit_trail(api_client: AsyncClient):
    wf_id = await _create_active_wf(api_client, "Audit Test")

    run_resp = await api_client.post(
        f"/v1/workflows/{wf_id}/run", headers=API_HEADERS
    )
    run_id = run_resp.json()["id"]

    await api_client.post(
        f"/v1/runs/{run_id}/pause",
        json={"reason": "test"},
        headers=API_HEADERS,
    )
    await api_client.post(
        f"/v1/runs/{run_id}/resume", headers=API_HEADERS
    )
    await api_client.post(
        f"/v1/runs/{run_id}/complete", headers=API_HEADERS
    )

    audit_resp = await api_client.get(
        f"/v1/audit/{run_id}", headers=API_HEADERS
    )
    assert audit_resp.status_code == 200, audit_resp.text
    data = audit_resp.json()
    assert len(data["events"]) >= 4, f"Expected >=4 events, got {len(data['events'])}"
    for i in range(1, len(data["events"])):
        assert data["events"][i]["previous_hash"] == data["events"][i - 1]["hash"], (
            f"Hash chain broken at event {i}"
        )


@pytest.mark.asyncio
async def test_checkpoint(api_client: AsyncClient):
    wf_id = await _create_active_wf(api_client, "CP Test")

    run_resp = await api_client.post(
        f"/v1/workflows/{wf_id}/run", headers=API_HEADERS
    )
    run_id = run_resp.json()["id"]

    cp_resp = await api_client.post(
        f"/v1/runs/{run_id}/checkpoint",
        json={"step_index": 2, "snapshot": {"state": "ok"}},
        headers=API_HEADERS,
    )
    assert cp_resp.status_code == 200
    assert cp_resp.json()["checkpoint_step"] == 2


@pytest.mark.asyncio
async def test_intervention_recording(api_client: AsyncClient):
    wf_id = await _create_active_wf(api_client, "Int Test")

    run_resp = await api_client.post(
        f"/v1/workflows/{wf_id}/run", headers=API_HEADERS
    )
    run_id = run_resp.json()["id"]

    int_resp = await api_client.post(
        "/v1/runs/interventions",
        json={
            "run_id": run_id,
            "trigger_reason": "CAPTCHA",
            "page_url": "https://example.com",
        },
        headers=API_HEADERS,
    )
    assert int_resp.status_code == 200
    assert int_resp.json()["trigger_reason"] == "CAPTCHA"

    list_resp = await api_client.get(
        "/v1/interventions", headers=API_HEADERS
    )
    assert list_resp.status_code == 200
    items = list_resp.json()["interventions"]
    assert any(i["run_id"] == run_id for i in items)


@pytest.mark.asyncio
async def test_extraction_schema_compat(api_client: AsyncClient):
    wf_id = await _create_active_wf(api_client, "Extraction Schema Test")
    run_resp = await api_client.post(
        f"/v1/workflows/{wf_id}/run", headers=API_HEADERS
    )
    run_id = run_resp.json()["id"]

    legacy_resp = await api_client.post(
        f"/v1/runs/{run_id}/extraction",
        json={
            "step_index": 1,
            "data": [{"title": "Engineer"}],
            "schema": {"type": "array"},
            "url": "https://example.com/jobs",
        },
        headers=API_HEADERS,
    )
    assert legacy_resp.status_code == 200

    modern_resp = await api_client.post(
        f"/v1/runs/{run_id}/extraction",
        json={
            "step_index": 2,
            "data": [{"title": "Designer"}],
            "output_schema": {"type": "array", "items": {"type": "object"}},
            "url": "https://example.com/jobs",
        },
        headers=API_HEADERS,
    )
    assert modern_resp.status_code == 200

    audit_resp = await api_client.get(f"/v1/audit/{run_id}", headers=API_HEADERS)
    assert audit_resp.status_code == 200
    extraction_events = [
        e for e in audit_resp.json()["events"] if e["event_type"] == "extraction"
    ]
    assert len(extraction_events) >= 2
    assert extraction_events[-2]["payload"]["output_schema"] == {"type": "array"}
    assert extraction_events[-1]["payload"]["output_schema"] == {
        "type": "array",
        "items": {"type": "object"},
    }


@pytest.mark.asyncio
async def test_workflow_status_update(api_client: AsyncClient):
    resp = await api_client.post(
        "/v1/workflows", json={"name": "Status Test"}, headers=API_HEADERS
    )
    wf_id = resp.json()["id"]

    update_resp = await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        json={"status": "active"},
        headers=API_HEADERS,
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["status"] == "active"


@pytest.mark.asyncio
async def test_workflow_status_invalid(api_client: AsyncClient):
    resp = await api_client.post(
        "/v1/workflows", json={"name": "Bad Status"}, headers=API_HEADERS
    )
    wf_id = resp.json()["id"]

    update_resp = await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        json={"status": "flibbertygibbet"},
        headers=API_HEADERS,
    )
    assert update_resp.status_code == 422
