from __future__ import annotations

from api.v1 import daemon as daemon_api

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


async def test_daemon_status_empty(client):
    daemon_api.reset_heartbeat_state()

    response = await client.get("/v1/daemon/status", headers=_HEADERS)

    assert response.status_code == 200
    assert response.json() == {"workers": [], "any_up": False, "circuit_open": False}


async def test_daemon_heartbeat_marks_worker_up(client, monkeypatch):
    daemon_api.reset_heartbeat_state()
    monkeypatch.setattr(daemon_api.time, "time", lambda: 100.0)

    post = await client.post(
        "/v1/daemon/heartbeat",
        json={"worker_id": "worker-a", "polling": True, "driving_run_id": None},
        headers=_HEADERS,
    )

    assert post.status_code == 200

    status = await client.get("/v1/daemon/status", headers=_HEADERS)
    body = status.json()
    assert body["any_up"] is True
    assert body["circuit_open"] is False
    assert body["workers"] == [{
        "worker_id": "worker-a",
        "polling": True,
        "driving_run_id": None,
        "circuit_open": None,
        "circuit_reason": None,
        "cooldown_until": None,
        "last_seen": "1970-01-01T00:01:40Z",
        "age_seconds": 0.0,
        "up": True,
    }]


async def test_daemon_heartbeat_reports_circuit_state(client, monkeypatch):
    daemon_api.reset_heartbeat_state()
    monkeypatch.setattr(daemon_api.time, "time", lambda: 100.0)

    post = await client.post(
        "/v1/daemon/heartbeat",
        json={
            "worker_id": "worker-a",
            "polling": True,
            "driving_run_id": None,
            "circuit_open": True,
            "circuit_reason": "checkpoint",
            "cooldown_until": "2026-05-29T00:00:00Z",
        },
        headers=_HEADERS,
    )
    assert post.status_code == 200

    body = (await client.get("/v1/daemon/status", headers=_HEADERS)).json()
    assert body["circuit_open"] is True
    worker = body["workers"][0]
    assert worker["circuit_open"] is True
    assert worker["circuit_reason"] == "checkpoint"
    assert worker["cooldown_until"] == "2026-05-29T00:00:00Z"


async def test_daemon_status_marks_worker_stale_after_ttl(client, monkeypatch):
    daemon_api.reset_heartbeat_state()
    now = {"value": 100.0}
    monkeypatch.setattr(daemon_api.time, "time", lambda: now["value"])

    await client.post(
        "/v1/daemon/heartbeat",
        json={"worker_id": "worker-a", "polling": False, "driving_run_id": "run-123"},
        headers=_HEADERS,
    )

    now["value"] = 131.0
    status = await client.get("/v1/daemon/status", headers=_HEADERS)
    body = status.json()
    assert body["any_up"] is False
    assert body["workers"][0]["up"] is False
    assert body["workers"][0]["age_seconds"] == 31.0
    assert body["workers"][0]["driving_run_id"] == "run-123"


async def test_daemon_status_sorts_multiple_workers_by_recency(client, monkeypatch):
    daemon_api.reset_heartbeat_state()
    now = {"value": 200.0}
    monkeypatch.setattr(daemon_api.time, "time", lambda: now["value"])

    await client.post(
        "/v1/daemon/heartbeat",
        json={"worker_id": "worker-a", "polling": True, "driving_run_id": None},
        headers=_HEADERS,
    )
    now["value"] = 204.0
    await client.post(
        "/v1/daemon/heartbeat",
        json={"worker_id": "worker-b", "polling": False, "driving_run_id": "run-2"},
        headers=_HEADERS,
    )

    status = await client.get("/v1/daemon/status", headers=_HEADERS)
    body = status.json()

    assert [worker["worker_id"] for worker in body["workers"]] == ["worker-b", "worker-a"]
    assert body["any_up"] is True
    assert body["workers"][0]["driving_run_id"] == "run-2"
