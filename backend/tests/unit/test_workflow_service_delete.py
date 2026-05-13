"""Pins B-C-05 — WorkflowService.delete orphans steps instead of cascading.

`delete()` sets `workflow_id=NULL` on steps via UPDATE. Combined with the missing
FK constraint (B-C-06/07), referential integrity is only advisory. This test
deletes a workflow with two steps and asserts the steps are also gone — fails
today, passes once `delete()` cascades.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from core.models.workflow import WorkflowStep
from services.workflow_service import WorkflowService


@pytest.mark.asyncio
async def test_delete_workflow_removes_its_steps(db_session):
    svc = WorkflowService(db_session)
    wf = await svc.create(name="to-delete")
    await svc.add_step(workflow_id=str(wf.id), step_index=0, action_type="click")
    await svc.add_step(workflow_id=str(wf.id), step_index=1, action_type="type", value="hello")
    await db_session.flush()

    # sanity
    assert len(await svc.get_steps(str(wf.id))) == 2

    await svc.delete(str(wf.id))
    await db_session.flush()

    result = await db_session.execute(select(WorkflowStep))
    rows = result.scalars().all()
    # The bug today is: rows still exist but have workflow_id=None — orphan.
    assert len(rows) == 0, f"Expected steps to be deleted, got orphans: {[r.id for r in rows]}"


@pytest.mark.asyncio
async def test_delete_unknown_workflow_raises(db_session):
    from core.exceptions import NotFoundError
    svc = WorkflowService(db_session)
    with pytest.raises(NotFoundError):
        await svc.delete(str(uuid.uuid4()))


@pytest.mark.asyncio
async def test_create_get_update_round_trip(db_session):
    svc = WorkflowService(db_session)
    wf = await svc.create(name="orig", description="d", target_url="https://x")
    fetched = await svc.get(str(wf.id))
    assert fetched.name == "orig"

    updated = await svc.update_workflow(
        workflow_id=str(wf.id), name="renamed", description="d2", prompt="p", target_url="https://y"
    )
    assert updated.name == "renamed"
    assert updated.description == "d2"
    assert updated.prompt == "p"
    assert updated.target_url == "https://y"


@pytest.mark.asyncio
async def test_update_status_round_trip(db_session):
    svc = WorkflowService(db_session)
    wf = await svc.create(name="x")
    out = await svc.update_status(str(wf.id), "active")
    assert out.status == "active"
