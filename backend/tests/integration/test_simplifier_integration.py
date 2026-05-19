"""Integration tests for the WorkflowSimplifier wired into record_workflow."""
import json
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.workflow import Workflow, WorkflowStep
from sqlalchemy import select

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


def _make_record_payload(name: str, steps: list[dict], target_url: str | None = None) -> dict:
    events = []
    for step in steps:
        events.append({
            "event_type": step["action_type"],
            "payload": {
                "intent": step.get("intent"),
                "value": step.get("value"),
                "selector_chain": step.get("selector_chain", []),
            },
        })
    return {"name": name, "target_url": target_url, "events": events}


@pytest.mark.asyncio
async def test_record_speedtest_workflow_simplified(api_client: AsyncClient, db_session: AsyncSession, monkeypatch):
    """6-step Google-search-then-speedtest workflow should be simplified to ≤3 steps."""
    import services.workflow_simplifier as mod

    class IdentityProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            # Extract the JSON array from the prompt and return it
            import re
            m = re.search(r"steps.*?:\n(\[.*?\])\n\n", prompt, re.DOTALL)
            if m:
                try:
                    data = json.loads(m.group(1))
                    return AIResponse(content=json.dumps(data))
                except Exception:
                    pass
            return AIResponse(content='[{"action_type": "navigate", "value": "https://speedtest.net/", "intent": "Open Speedtest", "selector_chain": []}]')

    monkeypatch.setattr(mod, "get_ai_provider", lambda: IdentityProvider())

    payload = _make_record_payload(
        "Internet Speed Test",
        [
            {"action_type": "click", "intent": "Click Google search box", "value": None, "selector_chain": [{"type": "css", "value": "#_RandomSessionId123456789012"}]},
            {"action_type": "type", "intent": "Type query", "value": "internet speed test"},
            {"action_type": "navigate", "intent": "Go to Google", "value": "https://www.google.com/search?q=internet+speed+test&sxsrf=XYZ&ei=ABC"},
            {"action_type": "click", "intent": "Click speedtest result", "value": None, "selector_chain": [{"type": "css", "value": "#_MXwLas-xK_a7wN4PkNa42Qo_40"}]},
            {"action_type": "navigate", "intent": "Open Speedtest", "value": "https://speedtest.net/"},
            {"action_type": "click", "intent": "Click start button", "value": None, "selector_chain": [{"type": "text", "value": "Start"}]},
        ],
        target_url="https://speedtest.net",
    )

    response = await api_client.post("/v1/workflows/record", json=payload, headers=_HEADERS)
    assert response.status_code == 200, response.text
    data = response.json()

    assert "step_count" in data
    # Should be fewer than 6 steps after simplification
    assert data["step_count"] < 6

    # Verify in DB that no Google search navigate remains
    wf_id = data["id"]
    result = await db_session.execute(
        select(WorkflowStep).where(WorkflowStep.workflow_id == wf_id).order_by(WorkflowStep.step_index)
    )
    db_steps = result.scalars().all()
    google_navigates = [s for s in db_steps if s.action_type == "navigate" and "google.com" in (s.value or "")]
    assert len(google_navigates) == 0


@pytest.mark.asyncio
async def test_record_clean_workflow_not_over_simplified(api_client: AsyncClient, db_session: AsyncSession, monkeypatch):
    """A workflow that only visits the destination site should not lose meaningful steps."""
    import services.workflow_simplifier as mod

    class IdentityProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            import re
            m = re.search(r"steps.*?:\n(\[.*?\])\n\n", prompt, re.DOTALL)
            if m:
                try:
                    data = json.loads(m.group(1))
                    return AIResponse(content=json.dumps(data))
                except Exception:
                    pass
            return AIResponse(content="[]")

    monkeypatch.setattr(mod, "get_ai_provider", lambda: IdentityProvider())

    payload = _make_record_payload(
        "Indeed Job Search",
        [
            {"action_type": "navigate", "intent": "Go to Indeed", "value": "https://indeed.com"},
            {"action_type": "type", "intent": "Type job title", "value": "Python developer"},
            {"action_type": "type", "intent": "Type location", "value": "San Jose"},
            {"action_type": "click", "intent": "Click search", "value": None, "selector_chain": [{"type": "text", "value": "Find jobs"}]},
        ],
        target_url="https://indeed.com",
    )

    response = await api_client.post("/v1/workflows/record", json=payload, headers=_HEADERS)
    assert response.status_code == 200, response.text
    data = response.json()

    # Should retain the on-site steps (no detour to collapse)
    assert data["step_count"] >= 2


@pytest.mark.asyncio
async def test_record_response_includes_simplified_from(api_client: AsyncClient, db_session: AsyncSession, monkeypatch):
    """Response should include simplified_from when step count was reduced."""
    import services.workflow_simplifier as mod

    class AggressiveProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            # Always return just 1 step
            return AIResponse(content='[{"action_type": "navigate", "value": "https://speedtest.net/", "intent": "Go to speedtest", "selector_chain": []}]')

    monkeypatch.setattr(mod, "get_ai_provider", lambda: AggressiveProvider())

    payload = _make_record_payload(
        "Speed Test Via Google",
        [
            {"action_type": "click", "intent": "Search box", "value": None},
            {"action_type": "type", "intent": "Type query", "value": "speedtest"},
            {"action_type": "navigate", "intent": "Google search", "value": "https://www.google.com/search?q=speedtest"},
            {"action_type": "click", "intent": "Click result", "value": None},
            {"action_type": "navigate", "intent": "Speedtest", "value": "https://speedtest.net/"},
            {"action_type": "click", "intent": "Click start", "value": None, "selector_chain": [{"type": "text", "value": "Start"}]},
        ],
        target_url="https://speedtest.net",
    )

    response = await api_client.post("/v1/workflows/record", json=payload, headers=_HEADERS)
    assert response.status_code == 200, response.text
    data = response.json()

    if data["step_count"] < 6:
        assert data.get("simplified_from") == 6 or data.get("simplified_from") is not None


@pytest.mark.asyncio
async def test_replace_steps_endpoint(api_client: AsyncClient, db_session: AsyncSession):
    """PUT /workflows/{id}/steps replaces all steps atomically."""
    # Create a workflow first
    create_resp = await api_client.post("/v1/workflows", json={"name": "Replace Steps Test"}, headers=_HEADERS)
    assert create_resp.status_code == 200
    wf_id = create_resp.json()["id"]

    # Add a couple steps via the individual endpoint
    await api_client.post(f"/v1/workflows/{wf_id}/steps", headers=_HEADERS, json={
        "step_index": 0, "action_type": "navigate", "intent": "Go to page", "value": "https://example.com",
    })

    # Replace with new steps
    new_steps = [
        {"action_type": "navigate", "intent": "Go to new page", "value": "https://newexample.com", "selector_chain": [], "checkpoint": True},
        {"action_type": "click", "intent": "Click button", "value": None, "selector_chain": [{"type": "text", "value": "OK"}]},
    ]
    replace_resp = await api_client.put(f"/v1/workflows/{wf_id}/steps", json=new_steps, headers=_HEADERS)
    assert replace_resp.status_code == 200
    data = replace_resp.json()
    assert data["step_count"] == 2
    assert data["steps"][0]["checkpoint"] is True

    # Verify only 2 steps in DB
    result = await db_session.execute(
        select(WorkflowStep).where(WorkflowStep.workflow_id == wf_id).order_by(WorkflowStep.step_index)
    )
    db_steps = result.scalars().all()
    assert len(db_steps) == 2
    assert db_steps[0].checkpoint is True


@pytest.mark.asyncio
async def test_speedtest_record_and_first_step_success_does_not_complete(
    api_client: AsyncClient,
    monkeypatch,
):
    """Regression: navigate-only AI simplification must not erase required start click."""
    import services.workflow_simplifier as mod

    class OverAggressiveProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            # Simulate a bad AI simplification that drops the start button click.
            return AIResponse(
                content='[{"action_type":"navigate","intent":"Open speedtest","selector_chain":[],"value":"https://www.speedtest.net/es","checkpoint":true}]'
            )

    monkeypatch.setattr(mod, "get_ai_provider", lambda: OverAggressiveProvider())

    record_payload = _make_record_payload(
        "Internet Speed Test Regression",
        [
            {"action_type": "navigate", "intent": "Open Google", "value": "https://www.google.com/"},
            {"action_type": "type", "intent": "Type speed query", "value": "velocidad internet"},
            {"action_type": "navigate", "intent": "Open Speedtest", "value": "https://www.speedtest.net/es"},
            {
                "action_type": "click",
                "intent": "Click start internet test",
                "value": None,
                "selector_chain": [{"type": "text", "value": "Iniciar"}],
            },
        ],
        target_url="https://www.google.com/",
    )

    record_resp = await api_client.post("/v1/workflows/record", json=record_payload, headers=_HEADERS)
    assert record_resp.status_code == 200, record_resp.text
    workflow_id = record_resp.json()["id"]

    wf_resp = await api_client.get(f"/v1/workflows/{workflow_id}", headers=_HEADERS)
    assert wf_resp.status_code == 200, wf_resp.text
    wf_data = wf_resp.json()
    step_actions = [s["action_type"] for s in wf_data["steps"]]
    assert "click" in step_actions
    assert len(wf_data["steps"]) >= 2

    activate_resp = await api_client.put(
        f"/v1/workflows/{workflow_id}/status",
        headers=_HEADERS,
        json={"status": "active"},
    )
    assert activate_resp.status_code == 200, activate_resp.text

    run_resp = await api_client.post(f"/v1/workflows/{workflow_id}/run", headers=_HEADERS)
    assert run_resp.status_code == 200, run_resp.text
    run_id = run_resp.json()["id"]

    result_resp = await api_client.post(
        f"/v1/agent/{run_id}/result",
        headers=_HEADERS,
        json={
            "step_index": 0,
            "success": True,
            "page_context_after": {
                "url": "https://www.speedtest.net/es",
                "title": "Speedtest",
                "visible_text": "Comprueba tu velocidad de Internet",
                "visible_elements": [],
                "dom_snippet": "",
                "accessibility_tree": "",
                "is_blocking": False,
            },
        },
    )
    assert result_resp.status_code == 200, result_resp.text
    result_data = result_resp.json()
    assert result_data.get("decision") != "COMPLETED"
    assert result_data.get("next_step_index") == 1

    run_state_resp = await api_client.get(f"/v1/runs/{run_id}", headers=_HEADERS)
    assert run_state_resp.status_code == 200, run_state_resp.text
    run_state = run_state_resp.json()
    assert run_state["status"] == "running"
    assert run_state["current_step_index"] == 1
    assert run_state["total_steps"] >= 2


@pytest.mark.asyncio
async def test_record_speedtest_full_shape_drops_side_effect_navigate(
    api_client: AsyncClient, db_session: AsyncSession, monkeypatch,
):
    """End-to-end: search detour + entry navigate + Go click + post-test
    redirect URL. The pipeline must collapse the Google detour AND drop the
    trailing result URL, leaving exactly [navigate speedtest, click Go]."""
    import services.workflow_simplifier as mod

    class IdentityProvider:
        async def generate(self, prompt, system=None, max_tokens=1024):
            from ai.client import AIResponse
            import re
            m = re.search(r"steps.*?:\n(\[.*?\])\n\n", prompt, re.DOTALL)
            if m:
                try:
                    data = json.loads(m.group(1))
                    return AIResponse(content=json.dumps(data))
                except Exception:
                    pass
            return AIResponse(content="[]")

    monkeypatch.setattr(mod, "get_ai_provider", lambda: IdentityProvider())

    payload = _make_record_payload(
        "Speedtest Full Shape",
        [
            {"action_type": "navigate", "intent": "Open Google", "value": "https://www.google.com/"},
            {"action_type": "type", "intent": "Search", "value": "velocidad internet"},
            {"action_type": "navigate", "intent": "Google search", "value": "https://www.google.com/search?q=velocidad+internet"},
            {"action_type": "click", "intent": "Click result", "value": None, "selector_chain": []},
            {"action_type": "navigate", "intent": "Open speedtest", "value": "https://www.speedtest.net/es"},
            {"action_type": "click", "intent": "Click Iniciar to start the test", "value": None, "selector_chain": [{"type": "text", "value": "Iniciar"}]},
            {"action_type": "navigate", "intent": "Results page", "value": "https://www.speedtest.net/es/result/19211525847"},
        ],
        target_url="https://www.google.com/",
    )

    response = await api_client.post("/v1/workflows/record", json=payload, headers=_HEADERS)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["simplification_status"] == "succeeded"

    wf_id = data["id"]
    result = await db_session.execute(
        select(WorkflowStep).where(WorkflowStep.workflow_id == wf_id).order_by(WorkflowStep.step_index)
    )
    db_steps = result.scalars().all()
    actions = [s.action_type for s in db_steps]
    values = [s.value or "" for s in db_steps]

    # Final workflow shape: navigate to speedtest + click Iniciar. No Google
    # detour, no stale result URL.
    assert actions == ["navigate", "click"], actions
    assert "speedtest.net" in values[0]
    assert not any("google.com" in v for v in values)
    assert not any("/result/" in v for v in values)
