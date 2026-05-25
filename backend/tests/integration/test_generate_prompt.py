"""Integration tests for the /v1/workflows/{id}/generate-prompt endpoint.

Two branches:
- without AI key: heuristic summary via `_summarize_actions`.
- with AI key: calls real OpenAI provider.
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
                "selector_chain": [{"type": "css", "value": f"#x{i}"}],
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


@pytest.mark.asyncio
async def test_with_ai_key_calls_provider(api_client, monkeypatch):
    import api.v1.workflows as wf_module
    from ai.client import AIResponse
    from core.config import settings

    class _OkProvider:
        async def generate(self, prompt, system=None, max_tokens=1024) -> AIResponse:
            _ = (prompt, system, max_tokens)
            return AIResponse(content='"Summarized workflow sentence."', confidence=0.9)

    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(wf_module, "get_ai_provider", lambda **_: _OkProvider())

    wf_id = await _make_workflow_with_steps(api_client)
    resp = await api_client.post(f"/v1/workflows/{wf_id}/generate-prompt", headers=_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["generated"] is True
    assert len(body["prompt"]) > 10


@pytest.mark.asyncio
async def test_with_ai_key_handles_provider_error(api_client, monkeypatch):
    """When the provider fails the endpoint must fall back to the heuristic, not 500."""
    import api.v1.workflows as wf_module
    from ai.client import AIProvider, AIResponse
    from core.config import settings

    class _ErrorProvider(AIProvider):
        async def generate(self, prompt, system=None, max_tokens=1024) -> AIResponse:
            raise RuntimeError("provider unavailable")

    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(wf_module, "get_ai_provider", lambda **_: _ErrorProvider())

    wf_id = await _make_workflow_with_steps(api_client)
    resp = await api_client.post(f"/v1/workflows/{wf_id}/generate-prompt", headers=_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["generated"] is False
