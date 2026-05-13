"""Scenario fixtures shared across S01..S50.

Re-uses `api_client` and `db_session` from the parent conftest. Adds
`make_workflow_with_steps(api_client, n)` and `make_chained_run(db_session, n)`
to keep scenarios short.
"""
from __future__ import annotations

import uuid

import pytest

_HEADERS = {"X-API-Key": "dev-api-key-change-in-production"}


@pytest.fixture
def headers():
    return _HEADERS


@pytest.fixture
async def make_workflow_with_steps(api_client):
    async def _make(name: str, action_types: list[str]) -> str:
        wf = (await api_client.post(
            "/v1/workflows", json={"name": name}, headers=_HEADERS,
        )).json()
        for i, at in enumerate(action_types):
            await api_client.post(
                f"/v1/workflows/{wf['id']}/steps",
                json={
                    "step_index": i,
                    "action_type": at,
                    "intent": f"{at} #{i}",
                    "selector_chain": {"type": "css", "value": f"#x{i}"},
                    "value": f"v{i}" if at in ("type", "select") else None,
                },
                headers=_HEADERS,
            )
        return wf["id"]
    return _make


@pytest.fixture
def random_run_id():
    return str(uuid.uuid4())
