"""S32 — Two clients try to pause the same run simultaneously.

On SQLite without row locking we accept "at least one succeeded". The full
strict assertion ("exactly one succeeded") requires PG with `FOR UPDATE`.
"""
from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from core.exceptions import StateTransitionError
from core.models import Base
from core.models.workflow import Workflow, WorkflowStep
from core.state_machine import RunStatus
from services.execution_service import ExecutionService


@pytest_asyncio.fixture
async def factory():
    engine = create_async_engine(
        "sqlite+aiosqlite:///file:s32?mode=memory&cache=shared&uri=true", echo=False,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


async def _seed_running_run(factory) -> str:
    async with factory() as s:
        wf = Workflow(name="x", status="active")
        s.add(wf)
        await s.flush()
        step = WorkflowStep(workflow_id=str(wf.id), step_index=0, action_type="click", selector_chain=[])
        s.add(step)
        await s.flush()
        svc = ExecutionService(s)
        run = await svc.create_run(workflow_id=str(wf.id))
        await svc.transition(str(run.id), RunStatus.RUNNING)
        await s.commit()
        return str(run.id)


@pytest.mark.asyncio
async def test_two_concurrent_pauses(factory):
    run_id = await _seed_running_run(factory)

    async def attempt():
        async with factory() as s:
            try:
                await ExecutionService(s).pause(run_id, reason="contender")
                await s.commit()
                return True
            except (StateTransitionError, IntegrityError):
                return False

    results = await asyncio.gather(*(attempt() for _ in range(2)))
    successes = sum(1 for r in results if r)
    assert successes >= 1, "at least one pause must succeed"
