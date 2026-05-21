"""S41 — E2E: LinkedIn workflow records, analyses, then replays with an Odoo job-invite.

Full end-to-end scenario driven entirely through the HTTP API:
  1. Register an Odoo connector.
  2. Record a 5-step LinkedIn messaging workflow (generic placeholder message).
  3. Verify auto-analysis detected a substitutable parameter on the type step.
  4. Promote replay_strategy → parameterized via PUT /analysis.
  5. Activate the workflow.
  6. Fetch the first open job from Odoo (transport mocked via respx).
  7. Compose a personalised job-invite from the job data.
  8. Run the workflow via POST run-with-params, supplying the Odoo-sourced message.
  9. Assert the execution plan carries the substituted invite in the type step.
 10. Complete the run and verify the audit chain is intact.
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio

respx = pytest.importorskip("respx")
import httpx  # noqa: E402

ODOO_URL = "https://odoo.example.com"
HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}

_FIRST_JOB = {
    "id": 1,
    "name": "Senior Python Engineer",
    "description": "Join our fast-growing team and work on cutting-edge products",
    "state": "recruit",
}

# Generic placeholder message used during recording — will be replaced with the
# Odoo-sourced invite at replay time via parameter substitution.
_RECORDED_MESSAGE = "Hello, I wanted to reach out."


def _compose_job_invite(job: dict) -> str:
    desc = (job.get("description") or "").rstrip(".")
    return (
        f"Hi! We have an exciting opening: '{job['name']}'. "
        f"{desc}. "
        "We'd love for you to apply — feel free to reply if you're interested!"
    )


def _odoo_handler(request: httpx.Request) -> httpx.Response:
    body = request.read()
    if b'"login"' in body:
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"uid": 1}})
    return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": [_FIRST_JOB]})


# ── Recording payload: 5 LinkedIn messaging events ────────────────────────────

def _linkedin_events() -> list[dict]:
    base_ts = "2026-05-21T10:00:0{n}.000Z"
    return [
        {
            "event_type": "navigate",
            "payload": {"value": "https://www.linkedin.com/feed/"},
            "page_url": "https://www.linkedin.com/feed/",
            "timestamp": base_ts.format(n=0),
        },
        {
            "event_type": "click",
            "payload": {
                "target": {"selector": "a[data-link-to='MESSAGING']"},
                "intent": "Open Messaging dock",
            },
            "page_url": "https://www.linkedin.com/feed/",
            "timestamp": base_ts.format(n=2),
        },
        {
            "event_type": "click",
            "payload": {
                "selector_chain": [
                    {
                        "type": "shadow_css",
                        "value": (
                            '{"host_chain":["div[data-testid=\\"interop-shadowdom\\"]"],'
                            '"target":"li[data-test-id=\\"conversation-jane-doe\\"]"}'
                        ),
                    }
                ],
                "target": {"text": "Jane Doe"},
                "intent": "Open conversation with Jane Doe",
            },
            "page_url": "https://www.linkedin.com/feed/",
            "timestamp": base_ts.format(n=4),
        },
        {
            "event_type": "type",
            "payload": {
                "selector_chain": [
                    {
                        "type": "shadow_css",
                        "value": (
                            '{"host_chain":["div[data-testid=\\"interop-shadowdom\\"]"],'
                            '"target":"div[contenteditable=\\"true\\"]"}'
                        ),
                    }
                ],
                "value": _RECORDED_MESSAGE,
                "intent": "Type message in LinkedIn messaging composer",
            },
            "page_url": "https://www.linkedin.com/feed/",
            "timestamp": base_ts.format(n=6),
        },
        {
            "event_type": "click",
            "payload": {
                "selector_chain": [
                    {
                        "type": "shadow_css",
                        "value": (
                            '{"host_chain":["div[data-testid=\\"interop-shadowdom\\"]"],'
                            '"target":"button[aria-label=\\"Send\\"]"}'
                        ),
                    }
                ],
                "target": {"text": "Send"},
                "intent": "Click the Send button",
            },
            "page_url": "https://www.linkedin.com/feed/",
            "timestamp": base_ts.format(n=8),
        },
    ]


# ══════════════════════════════════════════════════════════════════════════════
# Main E2E test
# ══════════════════════════════════════════════════════════════════════════════

async def test_e2e_linkedin_odoo_job_invite(api_client):
    """Full HTTP API journey: record → analyse → fetch Odoo job → run with invite."""

    # ── 1. Register an Odoo connector ─────────────────────────────────────────
    conn_resp = await api_client.post(
        "/v1/connectors",
        json={
            "type": "odoo",
            "name": "Odoo HR (test)",
            "config": {
                "url": ODOO_URL,
                "database": "db",
                "username": "u",
                "password": "p",
            },
        },
        headers=HEADERS,
    )
    assert conn_resp.status_code == 200, f"Register connector failed: {conn_resp.text}"
    connector_id = conn_resp.json()["id"]
    assert connector_id

    # ── 2. Record LinkedIn messaging workflow ──────────────────────────────────
    record_resp = await api_client.post(
        "/v1/workflows/record",
        json={
            "name": "LinkedIn Job Invite Message",
            "target_url": "https://www.linkedin.com/",
            "events": _linkedin_events(),
        },
        headers=HEADERS,
    )
    assert record_resp.status_code == 200, f"Record workflow failed: {record_resp.text}"
    record_data = record_resp.json()
    wf_id = record_data["id"]
    assert record_data["step_count"] == 5

    # ── 3. Verify auto-analysis detected a parameter for the type step ─────────
    analysis_resp = await api_client.get(
        f"/v1/workflows/{wf_id}/analysis",
        headers=HEADERS,
    )
    assert analysis_resp.status_code == 200, f"Get analysis failed: {analysis_resp.text}"
    analysis_data = analysis_resp.json()
    params = analysis_data["parameters"]
    assert params, "Auto-analysis must detect at least one substitutable parameter"

    # The type step (step_index=3) produces parameter key "input_3" via the
    # heuristic fallback, since the message text matches no named pattern.
    param_keys = [p["key"] for p in params]
    assert "input_3" in param_keys, (
        f"Expected 'input_3' in detected parameters, got: {param_keys}"
    )
    input_3_param = next(p for p in params if p["key"] == "input_3")
    assert input_3_param["default"] == _RECORDED_MESSAGE

    # ── 4. Promote replay_strategy to "parameterized" ─────────────────────────
    patch_resp = await api_client.put(
        f"/v1/workflows/{wf_id}/analysis",
        json={"replay_strategy": "parameterized"},
        headers=HEADERS,
    )
    assert patch_resp.status_code == 200, f"Update analysis failed: {patch_resp.text}"

    # Confirm strategy was saved
    analysis_check = await api_client.get(
        f"/v1/workflows/{wf_id}/analysis",
        headers=HEADERS,
    )
    assert analysis_check.json()["replay_strategy"] == "parameterized"

    # ── 5. Activate the workflow ───────────────────────────────────────────────
    activate_resp = await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        json={"status": "active"},
        headers=HEADERS,
    )
    assert activate_resp.status_code == 200
    assert activate_resp.json()["status"] == "active"

    # ── 6. Fetch the first open job from Odoo (transport mocked) ─────────────
    from adapters.odoo.adapter import OdooAdapter

    with respx.mock() as r:
        r.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=_odoo_handler)
        odoo = OdooAdapter({
            "url": ODOO_URL, "database": "db", "username": "u", "password": "p",
        })
        await odoo.connect()
        jobs = await odoo.list("job", filters={"state": "recruit"}, limit=1)

    assert jobs, "Odoo adapter must return at least one open job"
    invite_message = _compose_job_invite(jobs[0])
    assert "Senior Python Engineer" in invite_message

    # ── 7. Run the workflow with the Odoo-sourced message ─────────────────────
    run_resp = await api_client.post(
        f"/v1/workflows/{wf_id}/run-with-params",
        json={"runtime_params": {"input_3": invite_message}},
        headers=HEADERS,
    )
    assert run_resp.status_code == 200, f"run-with-params failed: {run_resp.text}"
    run_data = run_resp.json()

    # ── 8. Assert the execution plan carries the substituted invite ───────────
    assert run_data["status"] == "running"
    execution_plan = run_data["execution_plan"]
    assert execution_plan["mode"] == "substituted", (
        f"Expected mode='substituted', got: {execution_plan.get('mode')!r}\n"
        f"Full plan: {execution_plan}"
    )
    assert execution_plan["strategy"] == "parameterized"

    plan_steps = execution_plan["steps"]
    assert len(plan_steps) == 5

    type_step = next(
        (s for s in plan_steps if s.get("action_type") == "type"),
        None,
    )
    assert type_step is not None, "Execution plan must contain the type step"
    assert type_step["value"] == invite_message, (
        f"type step value must be the Odoo invite.\n"
        f"Expected: {invite_message!r}\n"
        f"Got:      {type_step['value']!r}"
    )

    # The Send-click's success_condition should also reference the invite message
    # (promoted from the original typed text by generate_template).
    send_step = next(
        (s for s in plan_steps if s.get("value") == "Send"),
        None,
    )
    if send_step and isinstance(send_step.get("success_condition"), dict):
        assert send_step["success_condition"]["value"] == invite_message, (
            "Send step's success_condition must track the substituted invite text"
        )

    # ── 9. Complete the run and verify the audit chain ────────────────────────
    run_id = run_data["id"]
    complete_resp = await api_client.post(
        f"/v1/runs/{run_id}/complete",
        headers=HEADERS,
    )
    assert complete_resp.status_code == 200
    assert complete_resp.json()["status"] == "completed"

    audit_resp = await api_client.get(
        f"/v1/audit/{run_id}",
        headers=HEADERS,
    )
    assert audit_resp.status_code == 200
    audit = audit_resp.json()
    assert audit["chain_valid"] is True, f"Audit chain broken: {audit.get('broken_links')}"
    assert audit["workflow_id"] == wf_id
    assert audit["run_id"] == run_id
