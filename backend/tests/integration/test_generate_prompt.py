"""Integration tests for the /v1/workflows/{id}/generate-prompt endpoint.

Two branches:
- without AI key: heuristic summary via `_summarize_actions`.
- with AI key: provider is called.
"""
from __future__ import annotations

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


async def _make_workflow_with_steps(api_client):
    wf = (await api_client.post("/v1/workflows", json={"name": "auto-prompt", "target_url": "https://x.test"}, headers=_HEADERS)).json()
    for i, at in enumerate(["click", "type", "click"]):
        await api_client.post(
            f"/v1/workflows/{wf['id']}/steps",
            json={
                "step_index": i,
                "action_type": at,
                "intent": f"step {i}",
                "selector_chain": {"type": "css", "value": f"#x{i}"},
            },
            headers=_HEADERS,
        )
    return wf["id"]


@pytest.mark.asyncio
async def test_no_ai_key_uses_heuristic(api_client, monkeypatch):
    from core.config import settings
    monkeypatch.setattr(settings, "ai_api_key", "", raising=False)
    wf_id = await _make_workflow_with_steps(api_client)
    r = await api_client.post(f"/v1/workflows/{wf_id}/generate-prompt", headers=_HEADERS)
    assert r.status_code == 200
    body = r.json()
    assert body["generated"] is False
    assert "2 click" in body["prompt"] or "click" in body["prompt"]
    assert "https://x.test" in body["prompt"]


@pytest.mark.xfail(strict=False, reason="respx interception with ASGI test client — fix in batch A7")
@pytest.mark.asyncio
async def test_with_ai_key_calls_provider(api_client, monkeypatch):
    respx = pytest.importorskip("respx")
    import httpx

    from core.config import settings
    monkeypatch.setattr(settings, "ai_api_key", "sk-test", raising=False)

    canned = {
        "choices": [{"message": {"content": "Records candidate search and exports CSV."}}],
        "model": "gpt-4o-mini",
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    }
    wf_id = await _make_workflow_with_steps(api_client)
    with respx.mock(base_url="https://api.openai.com") as r:
        r.post("/v1/chat/completions").mock(return_value=httpx.Response(200, json=canned))
        resp = await api_client.post(f"/v1/workflows/{wf_id}/generate-prompt", headers=_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["generated"] is True
    assert "Records candidate search" in body["prompt"]


@pytest.mark.xfail(
    strict=True,
    reason="B-M-16: generate-prompt has no try/except around provider.generate. 500 leaks to client.",
)
@pytest.mark.asyncio
async def test_with_ai_key_handles_provider_error(api_client, monkeypatch):
    respx = pytest.importorskip("respx")
    import httpx

    from core.config import settings
    monkeypatch.setattr(settings, "ai_api_key", "sk-test", raising=False)

    wf_id = await _make_workflow_with_steps(api_client)
    with respx.mock(base_url="https://api.openai.com") as r:
        r.post("/v1/chat/completions").mock(return_value=httpx.Response(503))
        resp = await api_client.post(f"/v1/workflows/{wf_id}/generate-prompt", headers=_HEADERS)
    # Expected behavior: fall back to heuristic with `generated: false`, not 500.
    assert resp.status_code == 200
    assert resp.json()["generated"] is False
