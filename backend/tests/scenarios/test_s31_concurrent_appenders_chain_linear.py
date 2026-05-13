"""S31 — `asyncio.gather` 100 concurrent appends; chain remains linear and verifies.

Each task uses its own session so transactions don't share state. After all
tasks complete, `verify_chain` on the run returns empty `broken`.

Note: on SQLite this passes today because rows commit serially. On PostgreSQL,
without a SELECT FOR UPDATE on the latest row, two concurrent appends could
read the same `previous_hash` and produce a fork — a test gap until we add the
postgres scenario variant.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from core.models import Base
from services.audit import AuditService


@pytest_asyncio.fixture
async def isolated_engine():
    engine = create_async_engine("sqlite+aiosqlite:///file:s31?mode=memory&cache=shared&uri=true", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest.mark.xfail(
    strict=True,
    reason=(
        "S31 + B-C-09 + B-C-02: 50 concurrent appenders all read the same "
        "`previous_hash` and write forking chain rows. Surfaces here even on SQLite "
        "with shared-cache mode. Fix: SELECT … FOR UPDATE on latest row (Postgres) + "
        "sequence_number column UNIQUE(run_id, sequence_number)."
    ),
)
@pytest.mark.asyncio
async def test_concurrent_appends_chain_linear(isolated_engine):
    factory = async_sessionmaker(isolated_engine, class_=AsyncSession, expire_on_commit=False)
    run_id = str(uuid.uuid4())

    async def append_one(i: int):
        async with factory() as s:
            await AuditService(s).append("step_executed", {"i": i}, run_id=run_id)
            await s.commit()

    await asyncio.gather(*(append_one(i) for i in range(50)))

    async with factory() as s:
        broken = await AuditService(s).verify_chain(run_id)
    assert broken == []
