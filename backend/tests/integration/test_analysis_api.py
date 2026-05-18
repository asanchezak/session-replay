"""End-to-end integration tests for the semantic workflow intelligence pipeline.

Tests the full flow: create workflow → analyze → generate template → substitute parameters → execute.
"""
import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


async def _create_active_workflow_with_steps(api_client, name: str, steps: list[dict]) -> str:
    wf = await api_client.post("/v1/workflows", json={"name": name}, headers=_HEADERS)
    wf_id = wf.json()["id"]
    for i, s in enumerate(steps):
        body = {
            "step_index": i,
            "action_type": s.get("action_type", "click"),
            "intent": s.get("intent"),
            "selector_chain": s.get("selector_chain"),
            "value": s.get("value"),
        }
        await api_client.post(f"/v1/workflows/{wf_id}/steps", json=body, headers=_HEADERS)
    await api_client.put(
        f"/v1/workflows/{wf_id}/status",
        json={"status": "active"},
        headers=_HEADERS,
    )
    return wf_id


@pytest.mark.asyncio
async def test_full_semantic_analysis_flow(api_client, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")

    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://www.google.com", "intent": "Navigate to Google", "selector_chain": {"type": "css", "value": "#search"}},
        {"step_index": 1, "action_type": "type", "value": "Indeed job search", "intent": "Search for Indeed", "selector_chain": {"type": "css", "value": "#q"}},
        {"step_index": 2, "action_type": "navigate", "value": "https://indeed.com", "intent": "Open Indeed", "selector_chain": {"type": "css", "value": "a[href*='indeed']"}},
        {"step_index": 3, "action_type": "type", "value": "Python developer", "intent": "Type search term", "selector_chain": {"type": "css", "value": "#text-input-what"}},
        {"step_index": 4, "action_type": "type", "value": "Alajuela", "intent": "Type location", "selector_chain": {"type": "css", "value": "#text-input-where"}},
        {"step_index": 5, "action_type": "click", "intent": "Click search button", "selector_chain": {"type": "css", "value": "button[type='submit']"}},
        {"step_index": 6, "action_type": "click", "intent": "Click listing title", "selector_chain": {"type": "css", "value": ".jobTitle a"}},
        {"step_index": 7, "action_type": "click", "intent": "Click next page", "selector_chain": {"type": "css", "value": "a[data-testid='pagination-page-next']"}},
    ]
    wf_id = await _create_active_workflow_with_steps(api_client, "E2E Job Search Analysis", steps)

    # 1. Analyze the workflow
    ana = await api_client.post(f"/v1/workflows/{wf_id}/analyze", headers=_HEADERS)
    assert ana.status_code == 200
    ana_data = ana.json()
    assert ana_data["workflow_goal"] is not None
    assert ana_data["confidence_overall"] >= 0.0
    assert len(ana_data["phases"]) >= 1
    assert len(ana_data["parameters"]) >= 1

    # 2. Get analysis
    get_ana = await api_client.get(f"/v1/workflows/{wf_id}/analysis", headers=_HEADERS)
    assert get_ana.status_code == 200
    get_data = get_ana.json()
    assert get_data["workflow_goal"] is not None

    # 3. Get template
    tmpl = await api_client.get(f"/v1/workflows/{wf_id}/template", headers=_HEADERS)
    assert tmpl.status_code == 200
    tmpl_data = tmpl.json()
    assert "template_data" in tmpl_data
    assert "parameters" in tmpl_data["template_data"]

    # 4. Run with parameters
    run = await api_client.post(
        f"/v1/workflows/{wf_id}/run-with-params",
        json={"runtime_params": {"search_query": "React developer", "location": "Berlin"}},
        headers=_HEADERS,
    )
    assert run.status_code == 200
    run_data = run.json()
    assert run_data["status"] == "running"
    assert "execution_plan" in run_data
    assert run_data["execution_plan"]["strategy"] in ("literal", "parameterized")

    # 5. Verify workflow detail includes analysis
    detail = await api_client.get(f"/v1/workflows/{wf_id}", headers=_HEADERS)
    assert detail.status_code == 200
    detail_data = detail.json()
    assert "analysis" in detail_data


@pytest.mark.asyncio
async def test_workflow_no_analysis_returns_literal_plan(api_client):
    steps = [
        {"step_index": 0, "action_type": "click", "intent": "Simple step", "selector_chain": {"type": "css", "value": "#btn"}},
    ]
    wf_id = await _create_active_workflow_with_steps(api_client, "No Analysis WF", steps)

    run = await api_client.post(
        f"/v1/workflows/{wf_id}/run-with-params",
        json={"runtime_params": {"foo": "bar"}},
        headers=_HEADERS,
    )
    assert run.status_code == 200
    run_data = run.json()
    assert run_data["execution_plan"]["strategy"] == "literal"


@pytest.mark.asyncio
async def test_get_analysis_returns_404_for_unanalyzed(api_client):
    steps = [{"step_index": 0, "action_type": "click"}]
    wf_id = await _create_active_workflow_with_steps(api_client, "Unanalyzed", steps)

    r = await api_client.get(f"/v1/workflows/{wf_id}/analysis", headers=_HEADERS)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_analyze_then_reanalyze_works(api_client, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")

    steps = [
        {"step_index": 0, "action_type": "type", "value": "search term", "intent": "Search", "selector_chain": {"type": "css", "value": "#q"}},
    ]
    wf_id = await _create_active_workflow_with_steps(api_client, "Reanalyze", steps)

    a1 = await api_client.post(f"/v1/workflows/{wf_id}/analyze", headers=_HEADERS)
    assert a1.status_code == 200

    a2 = await api_client.post(f"/v1/workflows/{wf_id}/analyze", headers=_HEADERS)
    assert a2.status_code == 200

    params = await api_client.get(f"/v1/workflows/{wf_id}/analysis", headers=_HEADERS)
    data = params.json()
    assert len(data["parameters"]) == 1


@pytest.mark.asyncio
async def test_update_analysis_user_edits_persist(api_client, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")

    steps = [{"step_index": 0, "action_type": "click", "intent": "Test", "selector_chain": {"type": "css", "value": "#x"}}]
    wf_id = await _create_active_workflow_with_steps(api_client, "User Edit", steps)

    await api_client.post(f"/v1/workflows/{wf_id}/analyze", headers=_HEADERS)
    upd = await api_client.put(
        f"/v1/workflows/{wf_id}/analysis",
        json={"workflow_goal": "Collect data", "replay_strategy": "semantic"},
        headers=_HEADERS,
    )
    assert upd.status_code == 200
    assert upd.json()["is_user_edited"] is True

    get = await api_client.get(f"/v1/workflows/{wf_id}/analysis", headers=_HEADERS)
    assert get.json()["workflow_goal"] == "Collect data"


@pytest.mark.asyncio
async def test_parameter_update_endpoint(api_client, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")

    steps = [
        {"step_index": 0, "action_type": "type", "value": "hello", "intent": "Input", "selector_chain": {"type": "css", "value": "#test"}},
    ]
    wf_id = await _create_active_workflow_with_steps(api_client, "Param Update", steps)

    await api_client.post(f"/v1/workflows/{wf_id}/analyze", headers=_HEADERS)
    params = await api_client.get(f"/v1/workflows/{wf_id}/analysis", headers=_HEADERS)
    param_keys = [p["key"] for p in params.json()["parameters"]]
    assert len(param_keys) >= 1

    upd = await api_client.put(
        f"/v1/workflows/{wf_id}/parameters/{param_keys[0]}",
        json={"default_value": "world", "is_required": True},
        headers=_HEADERS,
    )
    assert upd.status_code == 200


@pytest.mark.asyncio
async def test_record_workflow_includes_analysis(api_client, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")

    resp = await api_client.post(
        "/v1/workflows/record",
        json={
            "name": "Record with Analysis",
            "events": [
                {
                    "event_type": "navigate",
                    "payload": {"intent": "Open page", "selector_chain": [{"type": "css", "value": "#search"}], "value": "https://example.com", "target": {"text": "", "selector": "#search"}},
                },
                {
                    "event_type": "type",
                    "payload": {"intent": "Type query", "selector_chain": [{"type": "css", "value": "#q"}], "value": "hello world", "target": {"text": "hello world"}},
                },
            ],
        },
        headers=_HEADERS,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "analysis" in data
    assert "goal" in data["analysis"]


@pytest.mark.asyncio
async def test_run_with_params_requires_goal_for_ambiguous_semantic_workflow(api_client, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")

    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://indeed.com", "intent": "Open Indeed", "selector_chain": {"type": "css", "value": "#root"}},
        {"step_index": 1, "action_type": "scroll", "intent": None, "selector_chain": None},
        {"step_index": 2, "action_type": "copy", "intent": "Copy description", "selector_chain": {"type": "css", "value": ".job"}},
    ]
    wf_id = await _create_active_workflow_with_steps(api_client, "Need Goal", steps)
    await api_client.post(f"/v1/workflows/{wf_id}/analyze", headers=_HEADERS)

    run = await api_client.post(
        f"/v1/workflows/{wf_id}/run-with-params",
        json={"runtime_params": {}},
        headers=_HEADERS,
    )
    assert run.status_code == 409
    assert run.json()["error"]["code"] == "GOAL_REQUIRED"


@pytest.mark.asyncio
async def test_run_with_params_applies_execution_goal_and_semantic_plan(api_client, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")

    create = await api_client.post(
        "/v1/workflows",
        json={"name": "Goal Driven Run", "prompt": "Get the first 10 job descriptions from Indeed."},
        headers=_HEADERS,
    )
    wf_id = create.json()["id"]
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://indeed.com", "intent": "Open Indeed", "selector_chain": {"type": "css", "value": "#root"}},
        {"step_index": 1, "action_type": "scroll", "intent": None, "selector_chain": None},
        {"step_index": 2, "action_type": "scroll", "intent": None, "selector_chain": None},
        {"step_index": 3, "action_type": "click", "intent": "Click listing title", "selector_chain": {"type": "css", "value": ".jobTitle a"}},
    ]
    for i, s in enumerate(steps):
        body = {
            "step_index": i,
            "action_type": s.get("action_type", "click"),
            "intent": s.get("intent"),
            "selector_chain": s.get("selector_chain"),
            "value": s.get("value"),
        }
        await api_client.post(f"/v1/workflows/{wf_id}/steps", json=body, headers=_HEADERS)
    await api_client.put(f"/v1/workflows/{wf_id}/status", json={"status": "active"}, headers=_HEADERS)
    await api_client.post(f"/v1/workflows/{wf_id}/analyze", headers=_HEADERS)

    run = await api_client.post(
        f"/v1/workflows/{wf_id}/run-with-params",
        json={
            "runtime_params": {},
            "execution_goal": "Extract the first 10 job descriptions from the search results",
        },
        headers=_HEADERS,
    )
    assert run.status_code == 200
    run_data = run.json()
    assert run_data["execution_plan"]["strategy"] == "semantic"
    assert run_data["execution_plan"]["mode"] == "goal_driven"
    assert len(run_data["execution_plan"]["steps"]) == 2

    run_detail = await api_client.get(f"/v1/runs/{run_data['id']}", headers=_HEADERS)
    assert run_detail.status_code == 200
    goal_progress = run_detail.json()["goal_progress"]
    assert goal_progress["workflow_goal"] == "Extract the first 10 job descriptions from the search results"
