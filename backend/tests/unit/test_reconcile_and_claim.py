from __future__ import annotations

import pytest
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from api.v1.runs import start_run
from core.models.connector import ConnectorConfig
from core.state_machine import RunStatus
from services.connector_forum_service import ConnectorForumService
from services.execution_service import ExecutionService
from services.reconcile_supervisor import ReconcileSupervisor
from services.webhook_trigger_service import WebhookTriggerService
from services.workflow_service import WorkflowService


async def _seed_queued_run(db_session: AsyncSession) -> str:
    """A workflow with one step + a run resting in QUEUED (its birth state)."""
    wf_svc = WorkflowService(db_session)
    wf = await wf_svc.create(name="claim-wf", target_url="https://example.test")
    await wf_svc.add_step(
        workflow_id=str(wf.id),
        step_index=0,
        action_type="click",
        intent="click",
        selector_chain=[{"type": "css", "value": "#btn"}],
    )
    run = await ExecutionService(db_session).create_run(str(wf.id))
    assert run.status == RunStatus.QUEUED.value  # _fire no longer forces RUNNING
    return str(run.id)


@pytest.mark.asyncio
async def test_start_run_claims_queued_then_409_on_race(db_session: AsyncSession):
    run_id = await _seed_queued_run(db_session)

    # First claim wins: QUEUED → RUNNING.
    claimed = await start_run(run_id, db=db_session)
    assert claimed["status"] == RunStatus.RUNNING.value

    # Second claim loses the race: run is no longer QUEUED → 409.
    lost = await start_run(run_id, db=db_session)
    assert isinstance(lost, JSONResponse)
    assert lost.status_code == 409


@pytest.mark.asyncio
async def test_reconcile_baselines_then_backfills_only_new_unhandled(
    db_session: AsyncSession, monkeypatch
):
    connector = ConnectorConfig(
        name="Odoo", connector_type="odoo", config={"url": "http://odoo.test"}
    )
    db_session.add(connector)
    await db_session.flush()
    connector_id = str(connector.id)

    jobs = [
        {"job_id": "100", "job_title": "A", "job_description": "da"},
        {"job_id": "101", "job_title": "B", "job_description": "db"},
        {"job_id": "102", "job_title": "C", "job_description": "dc"},
    ]

    async def fake_max_id(self, _connector):
        return 100

    async def fake_fetch_jobs(self, _connector, *, limit=25, filters=None):
        # Reconciler must query LinkedIn-eligible positions.
        assert filters == {"linkedin_sync": True, "is_published": True}
        return jobs

    monkeypatch.setattr(ConnectorForumService, "fetch_max_job_id", fake_max_id)
    monkeypatch.setattr(ConnectorForumService, "fetch_jobs", fake_fetch_jobs)

    enqueued_ids: list[str] = []

    async def fake_fire(self, cid, payload):
        assert cid == connector_id
        enqueued_ids.append(payload["job_id"])
        return [f"run-{payload['job_id']}"]

    monkeypatch.setattr(WebhookTriggerService, "fire_from_odoo_payload", fake_fire)

    sup = ReconcileSupervisor(db_session)

    # Pass 1 — first sight: baseline at max id, enqueue nothing.
    n1 = await sup.reconcile_connector(connector_id)
    assert n1 == 0
    assert enqueued_ids == []
    await db_session.refresh(connector)
    assert connector.config["reconcile_min_job_id"] == 100

    # Pass 2 — backfill only positions created after install (id > 100).
    n2 = await sup.reconcile_connector(connector_id)
    assert n2 == 2
    assert enqueued_ids == ["101", "102"]

    # Pass 3 — dedup: a position with an existing run is not re-enqueued.
    enqueued_ids.clear()

    async def fake_find(self, job_id):
        return object() if str(job_id) == "101" else None

    monkeypatch.setattr(WebhookTriggerService, "_find_run_by_job_id", fake_find)
    n3 = await sup.reconcile_connector(connector_id)
    assert n3 == 1
    assert enqueued_ids == ["102"]
