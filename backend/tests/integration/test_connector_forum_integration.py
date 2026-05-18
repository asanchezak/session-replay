from __future__ import annotations

import json

import pytest

pytestmark = pytest.mark.asyncio

respx = pytest.importorskip("respx")
import httpx  # noqa: E402

HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}
ODOO_URL = "https://odoo.example.com"
FORUM_URL = "http://127.0.0.1:4320"


def _rpc(result):
    return {"jsonrpc": "2.0", "id": 1, "result": result}


async def _create_connector(api_client):
    response = await api_client.post(
        "/v1/connectors",
        json={
            "name": "odoo-forum-test",
            "type": "odoo",
            "config": {
                "url": ODOO_URL,
                "database": "odoo-db",
                "username": "admin",
                "password": "secret",
            },
        },
        headers=HEADERS,
    )
    assert response.status_code == 200
    return response.json()["id"]


async def test_connector_test_uses_health_check(api_client, monkeypatch):
    connector_id = await _create_connector(api_client)

    class FakeAdapter:
        def __init__(self):
            self.initialized = False

        async def initialize(self, config: dict) -> None:
            self.initialized = bool(config["url"])

        async def health_check(self):
            from adapters.base import ConnectorHealth

            assert self.initialized is True
            return ConnectorHealth(status="healthy", latency_ms=12)

        async def dispose(self) -> None:
            return None

    monkeypatch.setattr("api.v1.connectors.get_adapter", lambda _name: FakeAdapter)
    response = await api_client.post(f"/v1/connectors/{connector_id}/test", headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["healthy"] is True
    assert body["latency_ms"] == 12


async def test_sync_profiles_to_forum_uses_connector_data(api_client):
    connector_id = await _create_connector(api_client)

    candidates = [
        {
            "id": 1,
            "name": "Ana Gomez",
            "email_from": "ana@example.com",
            "partner_phone": "+50611111111",
            "description": "Frontend engineer focused on candidate experience.",
        },
        {
            "id": 2,
            "name": "Bruno Diaz",
            "email_from": "bruno@example.com",
            "partner_phone": "+50622222222",
            "description": "Operations specialist open to support roles.",
        },
    ]
    jobs = [{"id": 8, "name": "Support Engineer", "description": "Own the support queue."}]
    imported_payloads: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        if b'"login"' in body:
            return httpx.Response(200, json=_rpc(7))
        if b'"hr.candidate"' in body and b'"search_read"' in body:
            return httpx.Response(200, json=_rpc(candidates))
        if b'"hr.job"' in body and b'"search_read"' in body:
            return httpx.Response(200, json=_rpc(jobs))
        return httpx.Response(200, json=_rpc([]))

    with respx.mock(assert_all_called=False) as mock:
        mock.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)

        def _import_profiles(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content.decode())
            imported_payloads.append(payload)
            return httpx.Response(
                200,
                json={"status": "ok", "profile_count": len(payload["profiles"])},
            )
        mock.post(f"{FORUM_URL}/api/profiles/import").mock(side_effect=_import_profiles)

        response = await api_client.post(
            f"/v1/integrations/connectors/{connector_id}/forum/sync-profiles",
            json={"forum_base_url": FORUM_URL, "candidate_limit": 2},
            headers=HEADERS,
        )

    assert response.status_code == 200
    body = response.json()
    assert body["imported_count"] == 2
    assert body["profiles"][0]["name"] == "Ana Gomez"
    assert body["profiles"][1]["source_candidate_id"] == "2"
    assert body["jobs_preview"][0]["job_title"] == "Support Engineer"
    assert imported_payloads[0]["profiles"][0]["source_candidate_id"] == "1"


async def test_sync_profiles_falls_back_to_hr_applicant_when_hr_candidate_is_missing(api_client):
    connector_id = await _create_connector(api_client)

    applicants = [
        {
            "id": 21,
            "name": "Platform Engineer",
            "partner_name": "Laura Campos",
            "email_from": "laura@example.com",
            "partner_phone": "+50677777777",
            "description": "Experienced in distributed systems.",
        },
        {
            "id": 22,
            "name": "Support Engineer",
            "partner_name": "Mario Ruiz",
            "email_from": "mario@example.com",
            "partner_phone": "+50688888888",
            "description": "Strong customer-facing background.",
        },
    ]
    jobs = [{"id": 8, "name": "Support Engineer", "description": "Own the support queue."}]
    imported_payloads: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        if b'"login"' in body:
            return httpx.Response(200, json=_rpc(7))
        if b'"hr.candidate"' in body and b'"search_read"' in body:
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "error": {
                        "code": 200,
                        "message": "Odoo Server Error",
                        "data": {
                            "message": "Object hr.candidate doesn't exist",
                        },
                    },
                },
            )
        if b'"hr.applicant"' in body and b'"search_read"' in body:
            return httpx.Response(200, json=_rpc(applicants))
        if b'"hr.job"' in body and b'"search_read"' in body:
            return httpx.Response(200, json=_rpc(jobs))
        return httpx.Response(200, json=_rpc([]))

    with respx.mock(assert_all_called=False) as mock:
        mock.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)

        def _import_profiles(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content.decode())
            imported_payloads.append(payload)
            return httpx.Response(
                200,
                json={"status": "ok", "profile_count": len(payload["profiles"])},
            )

        mock.post(f"{FORUM_URL}/api/profiles/import").mock(side_effect=_import_profiles)

        response = await api_client.post(
            f"/v1/integrations/connectors/{connector_id}/forum/sync-profiles",
            json={"forum_base_url": FORUM_URL, "candidate_limit": 2},
            headers=HEADERS,
        )

    assert response.status_code == 200
    body = response.json()
    assert body["imported_count"] == 2
    assert body["profiles"][0]["name"] == "Laura Campos"
    assert body["profiles"][1]["email"] == "mario@example.com"
    assert imported_payloads[0]["profiles"][0]["source_candidate_id"] == "21"


async def test_send_forum_messages_supports_prompt_selection_and_custom_job_text(api_client):
    connector_id = await _create_connector(api_client)
    candidates = [
        {
            "id": 10,
            "name": "Ana Gomez",
            "email_from": "ana@example.com",
            "partner_phone": "",
            "description": "Excellent communicator.",
        },
        {
            "id": 11,
            "name": "Bruno Diaz",
            "email_from": "bruno@example.com",
            "partner_phone": "",
            "description": "Strong operations background.",
        },
        {
            "id": 12,
            "name": "Carla Soto",
            "email_from": "carla@example.com",
            "partner_phone": "",
            "description": "Interested in backend platform roles.",
        },
    ]
    sent_payloads: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        if b'"login"' in body:
            return httpx.Response(200, json=_rpc(7))
        if b'"hr.candidate"' in body and b'"search_read"' in body:
            return httpx.Response(200, json=_rpc(candidates))
        if b'"hr.job"' in body and b'"search_read"' in body:
            return httpx.Response(200, json=_rpc([]))
        return httpx.Response(200, json=_rpc([]))

    with respx.mock(assert_all_called=False) as mock:
        mock.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)

        def _send_messages(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content.decode())
            sent_payloads.append(payload)
            return httpx.Response(
                200,
                json={"status": "ok", "sent_count": len(payload["messages"])},
            )
        mock.post(f"{FORUM_URL}/api/messages/send").mock(side_effect=_send_messages)

        response = await api_client.post(
            f"/v1/integrations/connectors/{connector_id}/forum/send-messages",
            json={
                "forum_base_url": FORUM_URL,
                "selection_prompt": "Send this to Ana Gomez and Bruno Diaz",
                "job_description": "Senior Python developer role working on automation services.",
            },
            headers=HEADERS,
        )

    assert response.status_code == 200
    body = response.json()
    assert body["sent_count"] == 2
    assert [recipient["name"] for recipient in body["recipients"]] == ["Ana Gomez", "Bruno Diaz"]
    assert body["job"]["job_description"].startswith("Senior Python developer role")
    assert sent_payloads
    assert len(sent_payloads[0]["messages"]) == 2
    assert "Senior Python developer role" in sent_payloads[0]["messages"][0]["body"]
