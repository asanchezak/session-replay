from __future__ import annotations

import asyncio
import types
import uuid
from datetime import UTC, datetime, timedelta

import fsspec
import pytest
from sqlalchemy import select

from core.models.event import EventLog
from core.models.outbox import AuditOutbox
from core.models.run import ExecutionRun
from core.models.settings import AppSetting
from core.models.workflow import Workflow
from services.outbox_service import OutboxService
from services.retention_service import cleanup
from services.retention_supervisor import (
    DEFAULT_RETENTION_DAYS,
    RetentionSupervisor,
    _resolve_retention_days,
    _run_supervisor,
)
from services.storage_service import StorageService


@pytest.fixture(autouse=True)
def _storage_config(monkeypatch, tmp_path):
    def _fake_init(self):
        self.fs = fsspec.filesystem("file")
        self.base_path = str(tmp_path)

    monkeypatch.setattr("services.storage_service.StorageService.__init__", _fake_init)


@pytest.mark.asyncio
async def test_storage_service_roundtrip():
    svc = StorageService()
    stored_path = await svc.store(b"hello", "a/b.txt")
    assert await svc.exists(stored_path)
    assert await svc.retrieve(stored_path) == b"hello"
    await svc.delete(stored_path)
    assert not await svc.exists(stored_path)


@pytest.mark.asyncio
async def test_outbox_enqueue_and_process(db_session):
    run_id = str(uuid.uuid4())
    svc = OutboxService(db_session)
    entry = await svc.enqueue("run_started", {"x": 1}, run_id=run_id, actor_type="system")
    assert isinstance(entry, AuditOutbox)
    assert entry.processed is False

    processed = await svc.process_pending()
    assert processed == 1
    assert entry.processed is True
    assert entry.processed_at is not None

    events = (await db_session.execute(select(EventLog))).scalars().all()
    assert len(events) == 1
    assert events[0].event_type == "run_started"


@pytest.mark.asyncio
async def test_outbox_process_handles_append_error(db_session, monkeypatch):
    svc = OutboxService(db_session)
    await svc.enqueue("run_started", {"x": 1}, run_id=str(uuid.uuid4()))

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("append failed")

    monkeypatch.setattr("services.audit.AuditService.append", _boom)
    processed = await svc.process_pending()
    assert processed == 1

    outbox = (await db_session.execute(select(AuditOutbox))).scalars().all()
    assert len(outbox) == 1
    assert outbox[0].processed is False


def test_outbox_start_processor_sets_task(monkeypatch):
    created = {"called": False}

    def _fake_create_task(_coro):
        created["called"] = True
        _coro.close()
        return "task-sentinel"

    monkeypatch.setattr("services.outbox_service.asyncio.create_task", _fake_create_task)
    monkeypatch.setattr("core.database.async_session_factory", object(), raising=False)
    app = types.SimpleNamespace(state=types.SimpleNamespace())
    task = OutboxService.start_processor(app)
    assert task == "task-sentinel"
    assert app.state.outbox_processor == "task-sentinel"
    assert created["called"] is True


@pytest.mark.asyncio
async def test_resolve_retention_days(db_session):
    assert await _resolve_retention_days(db_session) == DEFAULT_RETENTION_DAYS

    db_session.add(AppSetting(key="retention_days", value="45"))
    await db_session.flush()
    assert await _resolve_retention_days(db_session) == 45

    setting = (
        await db_session.execute(
            select(AppSetting).where(AppSetting.key == "retention_days")
        )
    ).scalar_one()
    setting.value = {"bad": "shape"}
    await db_session.flush()
    assert await _resolve_retention_days(db_session) == DEFAULT_RETENTION_DAYS


@pytest.mark.asyncio
async def test_retention_cleanup_removes_old_rows(db_session):
    wf = Workflow(name="Retention WF", status="active")
    db_session.add(wf)
    await db_session.flush()

    old_run = ExecutionRun(
        workflow_id=str(wf.id),
        status="completed",
        ended_at=datetime.now(UTC) - timedelta(days=120),
    )
    recent_run = ExecutionRun(
        workflow_id=str(wf.id),
        status="running",
        ended_at=None,
    )
    db_session.add_all([old_run, recent_run])
    await db_session.flush()

    old_event = EventLog(
        run_id=old_run.id,
        step_id=None,
        actor_type="system",
        event_type="checkpoint",
        payload={},
        page_url=None,
        page_title=None,
        previous_hash="a" * 64,
        hash="b" * 64,
        nonce="n1",
        sequence_number=1,
        created_at=datetime.now(UTC) - timedelta(days=120),
    )
    recent_event = EventLog(
        run_id=recent_run.id,
        step_id=None,
        actor_type="system",
        event_type="checkpoint",
        payload={},
        page_url=None,
        page_title=None,
        previous_hash="c" * 64,
        hash="d" * 64,
        nonce="n2",
        sequence_number=1,
        created_at=datetime.now(UTC),
    )
    db_session.add_all([old_event, recent_event])
    await db_session.flush()

    result = await cleanup(90, db_session)
    assert result["events_deleted"] >= 1
    assert result["runs_deleted"] >= 1


@pytest.mark.asyncio
async def test_run_supervisor_one_cycle(db_session, monkeypatch):
    class _Factory:
        def __call__(self):
            return self

        async def __aenter__(self):
            return db_session

        async def __aexit__(self, exc_type, exc, tb):
            return False

    called = {"retention_days": None}

    async def _fake_cleanup(retention_days, _session):
        called["retention_days"] = retention_days
        return {"events_deleted": 0, "runs_deleted": 0}

    async def _stop(_seconds):
        raise asyncio.CancelledError

    monkeypatch.setattr("services.retention_supervisor.cleanup", _fake_cleanup)
    monkeypatch.setattr("services.retention_supervisor.asyncio.sleep", _stop)

    with pytest.raises(asyncio.CancelledError):
        await _run_supervisor(_Factory())  # type: ignore[arg-type]

    assert called["retention_days"] == DEFAULT_RETENTION_DAYS


def test_retention_start_supervisor_sets_task(monkeypatch):
    def _fake_create_task(_coro):
        _coro.close()
        return "retention-task"

    monkeypatch.setattr("services.retention_supervisor.asyncio.create_task", _fake_create_task)
    monkeypatch.setattr("core.database.async_session_factory", object(), raising=False)
    app = types.SimpleNamespace(state=types.SimpleNamespace())
    task = RetentionSupervisor.start_supervisor(app)
    assert task == "retention-task"
    assert app.state.retention_supervisor == "retention-task"
