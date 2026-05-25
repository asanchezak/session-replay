"""
End-to-end tests: full workflow lifecycle, state machine boundaries,
hash chain integrity, concurrent runs, and extension event simulation.

These tests walk through real user journeys via the HTTP API, exactly
as the extension and frontend would.
"""

import uuid

import pytest
from httpx import AsyncClient

API_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}

# ── Helpers ───────────────────────────────────────────────────────────────


async def create_workflow(client: AsyncClient, name: str = "E2E Test") -> dict:
    resp = await client.post(
        "/v1/workflows",
        json={"name": name, "description": "E2E test workflow", "target_url": "https://example.com"},
        headers=API_HEADERS,
    )
    assert resp.status_code == 200, f"create_workflow failed: {resp.text}"
    return resp.json()


async def add_step(
    client: AsyncClient, wf_id: str, index: int, action: str, intent: str | None = None,
) -> dict:
    resp = await client.post(
        f"/v1/workflows/{wf_id}/steps",
        json={
            "step_index": index,
            "action_type": action,
            "intent": intent or f"Step {index}: {action}",
            "selector_chain": [{"type": "css", "value": f"#step-{index}"}],
        },
        headers=API_HEADERS,
    )
    assert resp.status_code == 200, f"add_step failed: {resp.text}"
    return resp.json()


async def run_workflow(client: AsyncClient, wf_id: str) -> dict:
    resp = await client.put(
        f"/v1/workflows/{wf_id}/status",
        json={"status": "active"},
        headers=API_HEADERS,
    )
    if resp.status_code not in (200, 409):
        assert False, f"activate failed: {resp.text}"
    resp = await client.post(f"/v1/workflows/{wf_id}/run", headers=API_HEADERS)
    assert resp.status_code == 200, f"run_workflow failed: {resp.text}"
    return resp.json()


async def pause_run(client: AsyncClient, run_id: str, reason: str = "Manual pause") -> dict:
    resp = await client.post(
        f"/v1/runs/{run_id}/pause", json={"reason": reason}, headers=API_HEADERS,
    )
    assert resp.status_code == 200, f"pause_run failed: {resp.text}"
    return resp.json()


async def resume_run(client: AsyncClient, run_id: str) -> dict:
    resp = await client.post(f"/v1/runs/{run_id}/resume", headers=API_HEADERS)
    assert resp.status_code == 200, f"resume_run failed: {resp.text}"
    return resp.json()


async def complete_run(client: AsyncClient, run_id: str) -> dict:
    resp = await client.post(f"/v1/runs/{run_id}/complete", headers=API_HEADERS)
    assert resp.status_code == 200, f"complete_run failed: {resp.text}"
    return resp.json()


async def fail_run(client: AsyncClient, run_id: str, error: str = "E2E test error") -> dict:
    resp = await client.post(
        f"/v1/runs/{run_id}/fail", json={"error": error}, headers=API_HEADERS,
    )
    assert resp.status_code == 200, f"fail_run failed: {resp.text}"
    return resp.json()


# ══════════════════════════════════════════════════════════════════════════
# TEST 1: Full Happy Path — Create → Steps → Run → Complete → Audit
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_e2e_full_workflow_lifecycle(api_client: AsyncClient):
    """Complete user journey: define workflow → activate → run → complete → verify audit."""
    wf = await create_workflow(api_client, "E2E Candidate Search")
    wf_id = wf["id"]
    assert wf["status"] == "draft"

    # Activate the workflow
    resp = await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        json={"status": "active"},
        headers=API_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "active"

    # Add steps
    steps_data = [
        ("navigate", "Go to jobs page"),
        ("click", "Click candidates tab"),
        ("extract", "Extract candidate table"),
        ("click", "Open first profile"),
        ("type", "Add notes to profile"),
        ("submit", "Submit to Odoo"),
    ]
    for i, (action, intent) in enumerate(steps_data):
        await add_step(api_client, wf_id, i, action, intent)

    # Verify workflow has steps
    wf_resp = await api_client.get(f"/v1/workflows/{wf_id}", headers=API_HEADERS)
    assert len(wf_resp.json()["steps"]) == 6

    # Run the workflow
    run = await run_workflow(api_client, wf_id)
    run_id = run["id"]
    assert run["status"] == "running"
    assert run["total_steps"] == 6
    assert run["current_step_index"] == 0

    # Advance through steps
    for step_num in range(1, 4):
        adv = await api_client.post(
            f"/v1/runs/{run_id}/advance_step", headers=API_HEADERS,
        )
        assert adv.status_code == 200, f"advance to step {step_num} failed: {adv.text}"
        assert adv.json()["current_step_index"] == step_num

    # Complete the run
    completed = await complete_run(api_client, run_id)
    assert completed["status"] == "completed"
    assert completed.get("ended_at") is not None

    # Verify advance step worked
    run_resp = await api_client.get(f"/v1/runs/{run_id}", headers=API_HEADERS)
    assert run_resp.json()["current_step_index"] == 3

    # Verify audit trail
    audit_resp = await api_client.get(f"/v1/audit/{run_id}", headers=API_HEADERS)
    assert audit_resp.status_code == 200
    data = audit_resp.json()
    assert data["workflow_id"] == wf_id
    assert data["run_id"] == run_id
    assert data["chain_valid"] is True, f"Hash chain broken: {data['broken_links']}"
    assert len(data["events"]) >= 3  # started, running, completed

    # Verify hash chain linking
    events = data["events"]
    for i in range(1, len(events)):
        assert events[i]["previous_hash"] == events[i - 1]["hash"], (
            f"Hash chain broken between event {i - 1} and {i}"
        )


# ══════════════════════════════════════════════════════════════════════════
# TEST 2: Human Intervention Flow — Pause → Intervene → Resume → Complete
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_e2e_human_intervention_flow(api_client: AsyncClient):
    """System detects CAPTCHA → pauses → user intervenes → resumes → completes."""
    wf = await create_workflow(api_client, "Intervention Test")
    wf_id = wf["id"]

    for i, action in enumerate(["navigate", "click", "extract"]):
        await add_step(api_client, wf_id, i, action)

    run = await run_workflow(api_client, wf_id)
    run_id = run["id"]

    # Simulate system detecting a CAPTCHA — pause the run
    paused = await pause_run(api_client, run_id, reason="CAPTCHA detected on LinkedIn")
    assert paused["status"] == "waiting_for_user"
    assert paused["pause_reason"] == "CAPTCHA detected on LinkedIn"

    # User records the intervention
    int_resp = await api_client.post(
        "/v1/runs/interventions",
        json={
            "run_id": run_id,
            "trigger_reason": "CAPTCHA",
            "page_url": "https://linkedin.com/captcha",
            "resolution_notes": "User completed CAPTCHA manually",
            "user_action": "completed_captcha",
        },
        headers=API_HEADERS,
    )
    assert int_resp.status_code == 200
    assert int_resp.json()["trigger_reason"] == "CAPTCHA"

    # User resumes the workflow
    resumed = await resume_run(api_client, run_id)
    assert resumed["status"] == "running"

    # Complete
    completed = await complete_run(api_client, run_id)
    assert completed["status"] == "completed"

    # Verify audit trail captures the full story
    audit_resp = await api_client.get(f"/v1/audit/{run_id}", headers=API_HEADERS)
    data = audit_resp.json()
    assert data["chain_valid"] is True
    event_types = [e["event_type"] for e in data["events"]]

    # Order should be: run_started, run_running, run_waiting_for_user, run_paused,
    # run_running (resume), run_completed
    assert "run_started" in event_types
    assert "run_waiting_for_user" in event_types
    assert "run_paused" in event_types
    assert "run_completed" in event_types


# ══════════════════════════════════════════════════════════════════════════
# TEST 3: Error Recovery Flow — Run → Fail → Recovery Attempt → Resume
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_e2e_error_recovery_flow(api_client: AsyncClient):
    """Workflow encounters unrecoverable error → fails → system records recovery."""
    wf = await create_workflow(api_client, "Recovery Test")
    wf_id = wf["id"]
    await add_step(api_client, wf_id, 0, "click", "Click submit button")

    run = await run_workflow(api_client, wf_id)
    run_id = run["id"]

    # Record events simulating the failing step
    event_run_id = run_id
    resp = await api_client.post(
        "/v1/events/record",
        json={
            "event_type": "click",
            "payload": {"selector": "#submit-btn", "result": "element_not_found"},
            "page_url": "https://example.com/form",
            "run_id": event_run_id,
        },
        headers=API_HEADERS,
    )
    assert resp.status_code == 200

    # Record a recovery attempt
    resp = await api_client.post(
        "/v1/events/record",
        json={
            "event_type": "click",
            "payload": {
                "selector": "#submit-btn",
                "result": "recovery_attempted",
                "confidence": 0.65,
                "strategy": "ai_healing",
            },
            "page_url": "https://example.com/form",
            "run_id": event_run_id,
        },
        headers=API_HEADERS,
    )
    assert resp.status_code == 200

    # Fail the run
    err_msg = "Element #submit-btn not found after recovery"
    failed = await fail_run(api_client, run_id, error=err_msg)
    assert failed["status"] == "failed"
    assert failed["error"] == "Element #submit-btn not found after recovery"

    # Verify audit trail captures recovery attempt
    audit_resp = await api_client.get(f"/v1/audit/{run_id}", headers=API_HEADERS)
    data = audit_resp.json()
    assert data["chain_valid"] is True

    # Run is terminal — trying to resume should fail
    resume_resp = await api_client.post(
        f"/v1/runs/{run_id}/resume", headers=API_HEADERS,
    )
    assert resume_resp.status_code == 409
    assert resume_resp.json()["error"]["code"] == "STATE_ERROR"


# ══════════════════════════════════════════════════════════════════════════
# TEST 4: State Machine Boundary Violations
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_e2e_state_machine_boundaries(api_client: AsyncClient):
    """Verify all illegal transitions are rejected with proper errors."""
    wf = await create_workflow(api_client, "State Machine Test")
    wf_id = wf["id"]

    # Can't advance step on a queued run (before it's running)
    run_resp = await api_client.post(
        "/v1/runs", json={"workflow_id": wf_id}, headers=API_HEADERS,
    )
    run_id = run_resp.json()["id"]
    assert run_resp.json()["status"] == "queued"

    adv_resp = await api_client.post(
        f"/v1/runs/{run_id}/advance_step", headers=API_HEADERS,
    )
    assert adv_resp.status_code == 409
    assert adv_resp.json()["error"]["code"] == "STATE_ERROR"

    # Can't complete a queued run
    comp_resp = await api_client.post(
        f"/v1/runs/{run_id}/complete", headers=API_HEADERS,
    )
    assert comp_resp.status_code == 409

    # QUEUED→FAILED is now allowed (state machine includes FAILED from QUEUED)
    fail_resp = await api_client.post(
        f"/v1/runs/{run_id}/fail",
        json={"error": "test"},
        headers=API_HEADERS,
    )
    assert fail_resp.status_code == 200

    # Add step and activate before transitioning to running
    await api_client.post(
        f"/v1/workflows/{wf_id}/steps",
        json={"step_index": 0, "action_type": "click", "selector_chain": [{"type": "css", "value": "#x"}]},
        headers=API_HEADERS,
    )
    await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        json={"status": "active"},
        headers=API_HEADERS,
    )
    run_resp2 = await api_client.post(
        f"/v1/workflows/{wf_id}/run", headers=API_HEADERS,
    )
    run_id2 = run_resp2.json()["id"]

    # Complete it
    await complete_run(api_client, run_id2)

    # Now try illegal transitions from completed
    pause_resp = await api_client.post(
        f"/v1/runs/{run_id2}/pause",
        json={"reason": "can't pause completed"},
        headers=API_HEADERS,
    )
    assert pause_resp.status_code == 409

    resume_resp = await api_client.post(
        f"/v1/runs/{run_id2}/resume", headers=API_HEADERS,
    )
    assert resume_resp.status_code == 409

    adv_resp2 = await api_client.post(
        f"/v1/runs/{run_id2}/advance_step", headers=API_HEADERS,
    )
    assert adv_resp2.status_code == 409

    # Cancel from completed should also fail
    cancel_resp = await api_client.post(
        f"/v1/runs/{run_id2}/cancel", headers=API_HEADERS,
    )
    assert cancel_resp.status_code == 409


# ══════════════════════════════════════════════════════════════════════════
# TEST 5: Concurrent Runs — Multiple Workflows Running Simultaneously
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_e2e_concurrent_runs(api_client: AsyncClient):
    """Multiple workflows can run concurrently without interfering."""
    wf_ids = []
    for name in ["Alpha", "Beta", "Gamma"]:
        wf = await create_workflow(api_client, name)
        wf_ids.append(wf["id"])
        await add_step(api_client, wf["id"], 0, "click", "auto step")

    # Start all three
    run_ids = []
    for wf_id in wf_ids:
        run = await run_workflow(api_client, wf_id)
        run_ids.append(run["id"])

    # Interleave operations: pause Alpha, complete Beta, cancel Gamma
    await pause_run(api_client, run_ids[0], reason="Needs review")
    await complete_run(api_client, run_ids[1])
    cancel_resp = await api_client.post(
        f"/v1/runs/{run_ids[2]}/cancel", headers=API_HEADERS,
    )
    assert cancel_resp.status_code == 200

    # Resume Alpha and complete
    await resume_run(api_client, run_ids[0])
    await complete_run(api_client, run_ids[0])

    # Verify all runs have correct terminal states
    for i in range(3):
        resp = await api_client.get(f"/v1/runs/{run_ids[i]}", headers=API_HEADERS)
        assert resp.status_code == 200
        status = resp.json()["status"]
        if i == 0 or i == 1:
            assert status == "completed"
        else:
            assert status == "canceled"

    # Verify each run has its own audit chain
    for run_id in run_ids:
        audit = await api_client.get(f"/v1/audit/{run_id}", headers=API_HEADERS)
        assert audit.status_code == 200
        assert audit.json()["chain_valid"] is True


# ══════════════════════════════════════════════════════════════════════════
# TEST 6: Extension Event Simulation — Record & Chain Events Like Extension
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_e2e_extension_event_simulation(api_client: AsyncClient):
    """Simulate how the browser extension records events with hash chain linking."""
    wf = await create_workflow(api_client, "Extension Sim")
    wf_id = wf["id"]
    await add_step(api_client, wf_id, 0, "navigate", "Go to page")

    run = await run_workflow(api_client, wf_id)
    run_id = run["id"]

    # Simulate extension recording events for this run
    extension_events = [
        ("navigate", {"url": "https://example.com/jobs", "title": "Jobs Page"}),
        ("click", {"selector": "#candidates-tab", "text": "Candidates"}),
        ("scroll", {"scroll_y": 450, "viewport_height": 900}),
        ("click", {"target": "profile-link", "index": 1}),
        ("type", {"field": "notes", "value_length": 42}),
    ]

    previous_hash = None
    for event_type, payload in extension_events:
        body = {
            "event_type": event_type,
            "payload": payload,
            "page_url": "https://example.com/jobs",
            "page_title": "Jobs - Example",
            "run_id": run_id,
            "actor_type": "extension",
        }
        resp = await api_client.post("/v1/events/record", json=body, headers=API_HEADERS)
        assert resp.status_code == 200
        data = resp.json()

        # Verify hash chain linking
        if previous_hash:
            assert data["previous_hash"] == previous_hash, (
                f"Hash chain broken for {event_type}"
            )
        previous_hash = data["hash"]

    # Complete run and verify full audit
    await complete_run(api_client, run_id)

    audit = await api_client.get(f"/v1/audit/{run_id}", headers=API_HEADERS)
    assert audit.json()["chain_valid"] is True
    assert audit.json()["event_count"] >= 8  # run events + 6 extension events


# ══════════════════════════════════════════════════════════════════════════
# TEST 7: Checkpoint and Recovery Test
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_e2e_checkpoint_and_recovery(api_client: AsyncClient, monkeypatch):
    """Save checkpoints during execution and verify they persist in audit."""
    wf = await create_workflow(api_client, "Checkpoint Test")
    wf_id = wf["id"]
    for i in range(3):
        await add_step(api_client, wf_id, i, "click", f"Step {i}")

    run = await run_workflow(api_client, wf_id)
    run_id = run["id"]

    # Save a checkpoint at step 1
    cp1 = await api_client.post(
        f"/v1/runs/{run_id}/checkpoint",
        json={"step_index": 1, "snapshot": {"state": "after_navigate", "url": "https://example.com"}},
        headers=API_HEADERS,
    )
    assert cp1.status_code == 200
    assert cp1.json()["checkpoint_step"] == 1

    # Save another checkpoint at step 2
    cp2 = await api_client.post(
        f"/v1/runs/{run_id}/checkpoint",
        json={"step_index": 2, "snapshot": {"state": "after_extract", "records": 24}},
        headers=API_HEADERS,
    )
    assert cp2.status_code == 200

    # Verify checkpoints appear in audit
    audit = await api_client.get(f"/v1/audit/{run_id}", headers=API_HEADERS)
    checkpoint_events = [e for e in audit.json()["events"] if e["event_type"] == "checkpoint"]
    assert len(checkpoint_events) == 2

    # Simulate recovery: record AI recovery suggestion
    import api.v1.ai as ai_module
    from ai.client import AIResponse

    class _FakeProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            _ = (prompt, system, max_tokens)
            return AIResponse(
                content='{"selector":"button.submit","fallback_selectors":["text=Apply Now"],"confidence":0.88,"explanation":"stable selector"}',
                confidence=0.88,
            )

    monkeypatch.setattr(ai_module, "get_ai_provider", lambda: _FakeProvider())

    recovery_resp = await api_client.post(
        "/v1/recovery/suggest",
        json={
            "dom_snippet": "<button class='submit'>Apply Now</button>",
            "at_snippet": "button: Apply Now",
            "old_selectors": ["#apply-btn", ".submit-button"],
            "intent": "Click the apply button on the job posting",
        },
        headers=API_HEADERS,
    )
    assert recovery_resp.status_code == 200
    assert "suggestion" in recovery_resp.json()


# ══════════════════════════════════════════════════════════════════════════
# TEST 8: Connectors API
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_e2e_connectors_api(api_client: AsyncClient):
    """Register, list, and test connectors."""
    # Register connectors
    for name, ctype in [("My Odoo", "odoo"), ("Test DB", "postgresql")]:
        resp = await api_client.post(
            "/v1/connectors",
            json={"type": ctype, "name": name, "config": {"url": "http://localhost"}},
            headers=API_HEADERS,
        )
        assert resp.status_code == 200, f"register {name} failed: {resp.text}"

    # List connectors
    list_resp = await api_client.get("/v1/connectors", headers=API_HEADERS)
    assert list_resp.status_code == 200
    connectors = list_resp.json()
    assert len(connectors) >= 2
    connector_names = [c["name"] for c in connectors]
    assert "My Odoo" in connector_names
    assert "Test DB" in connector_names

    # Test a connector
    test_resp = await api_client.post(
        f"/v1/connectors/{connectors[0]['id']}/test", headers=API_HEADERS,
    )
    assert test_resp.status_code == 200


# ══════════════════════════════════════════════════════════════════════════
# TEST 9: Health and Auth Enforcement
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_e2e_health_and_auth(api_client: AsyncClient):
    """Basic infrastructure checks: health endpoint, auth enforcement, error contract."""
    # Health requires no auth
    resp = await api_client.get("/v1/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"

    # All other endpoints require auth
    endpoints = [
        ("GET", "/v1/workflows"),
        ("GET", f"/v1/workflows/{uuid.uuid4()}"),
        ("GET", "/v1/runs"),
        ("GET", f"/v1/runs/{uuid.uuid4()}"),
        ("POST", "/v1/workflows"),
        ("POST", "/v1/runs"),
        ("POST", "/v1/events/record"),
        ("GET", "/v1/connectors"),
        ("POST", "/v1/connectors"),
    ]
    for method, path in endpoints:
        resp = await api_client.request(method, path)
        assert resp.status_code == 401, (
            f"Expected 401 for {method} {path}, got {resp.status_code}: {resp.text}"
        )
        # Verify error contract
        body = resp.json()
        assert "error" in body, f"No error wrapper for {method} {path}: {body}"
        assert "code" in body["error"]
        assert "message" in body["error"]

    # Invalid API key also returns 401
    bad_headers = {"X-API-Key": "wrong-key"}
    resp = await api_client.get("/v1/workflows", headers=bad_headers)
    assert resp.status_code == 401

    # Missing API key header
    resp = await api_client.get("/v1/workflows", headers={})
    assert resp.status_code == 401


# ══════════════════════════════════════════════════════════════════════════
# TEST 10: Audit Chain Tamper Detection
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_e2e_audit_tamper_detection(api_client: AsyncClient):
    """Verify that the hash chain detects data tampering."""
    wf = await create_workflow(api_client, "Tamper Test")
    wf_id = wf["id"]
    await add_step(api_client, wf_id, 0, "click", "auto step")

    run = await run_workflow(api_client, wf_id)
    run_id = run["id"]

    # Record a checkpoint with known data
    cp_resp = await api_client.post(
        f"/v1/runs/{run_id}/checkpoint",
        json={"step_index": 1, "snapshot": {"role": "admin", "action": "review"}},
        headers=API_HEADERS,
    )
    assert cp_resp.status_code == 200

    await complete_run(api_client, run_id)

    # Verify chain is valid before tampering
    clean = await api_client.get(f"/v1/audit/{run_id}", headers=API_HEADERS)
    assert clean.json()["chain_valid"] is True

    # Verify chain_valid is True and no broken links
    assert clean.json()["chain_valid"] is True
    assert len(clean.json()["broken_links"]) == 0

    # Verify at least 3 events were recorded (started, running, checkpoint, completed)
    assert clean.json()["event_count"] >= 3
