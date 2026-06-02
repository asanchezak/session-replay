from __future__ import annotations

import types
import uuid

import fsspec
import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

from api.v1.runs import (
    CheckpointRequest,
    CreateRunRequest,
    ExtractionResultRequest,
    FailRequest,
    HealResultRequest,
    HealStepRequest,
    StepResultRequest,
    advance_step_run,
    cancel_run,
    checkpoint_run,
    clear_heal_overrides,
    complete_run,
    create_run,
    delete_all_runs,
    fail_run,
    get_next_step,
    get_run,
    get_run_events,
    heal_result,
    heal_step,
    inject_heal_override,
    list_runs,
    pause_run,
    record_intervention,
    recover_run,
    report_extraction,
    report_step_result,
    resume_run,
)
from core.config import settings
from core.exceptions import StateTransitionError
from core.models.run import ExecutionRun
from core.state_machine import RunStatus
from services.execution_service import ExecutionService
from services.workflow_service import WorkflowService


@pytest.fixture(autouse=True)
def _storage_tmp(monkeypatch, tmp_path):
    def _fake_init(self):
        self.fs = fsspec.filesystem("file")
        self.base_path = str(tmp_path)

    monkeypatch.setattr("services.storage_service.StorageService.__init__", _fake_init)


async def _seed_run(db_session, *, status: str = "running") -> tuple[str, str]:
    wf_svc = WorkflowService(db_session)
    wf = await wf_svc.create(name="run", target_url="https://example.test")
    await wf_svc.add_step(
        workflow_id=str(wf.id),
        step_index=0,
        action_type="click",
        intent="click",
        selector_chain=[{"type": "css", "value": "#btn"}],
    )
    await wf_svc.update_status(str(wf.id), "active")
    run = await ExecutionService(db_session).create_run(str(wf.id))
    if status == "running":
        run = await ExecutionService(db_session).transition(str(run.id), RunStatus.RUNNING)
    else:
        run.status = status
        await db_session.flush()
    return str(wf.id), str(run.id)


@pytest.mark.asyncio
async def test_runs_basic_routes_direct(db_session, monkeypatch):
    _, run_id = await _seed_run(db_session, status="running")
    run = await get_run(run_id, db=db_session)
    assert run["id"] == run_id

    listed = await list_runs(limit=50, offset=0, db=db_session)
    assert any(r["id"] == run_id for r in listed)

    events = await get_run_events(run_id, limit=100, offset=0, event_type=None, db=db_session)
    assert isinstance(events, list)

    pause = await pause_run(run_id, body={"reason": "manual"}, db=db_session)
    assert pause["status"] == "waiting_for_user"

    resumed = await resume_run(run_id, db=db_session)
    assert resumed["status"] == "running"

    advanced = await advance_step_run(run_id, db=db_session)
    assert advanced["current_step_index"] >= 0

    _, run_id2 = await _seed_run(db_session, status="running")
    failed = await fail_run(run_id2, req=FailRequest(error="boom"), db=db_session)
    assert failed["status"] == "failed"

    _, run_id3 = await _seed_run(db_session, status="running")
    completed = await complete_run(run_id3, db=db_session)
    assert completed["status"] == "completed"

    _, run_id4 = await _seed_run(db_session, status="running")
    canceled = await cancel_run(run_id4, db=db_session)
    assert canceled["status"] == "canceled"

    checkpoint = await checkpoint_run(
        run_id,
        req=CheckpointRequest(step_index=0, snapshot={"url": "https://x"}),
        db=db_session,
    )
    assert checkpoint["checkpoint_step"] == 0

    run_obj = await db_session.get(ExecutionRun, uuid.UUID(run_id))
    assert run_obj is not None
    run_obj.status = RunStatus.RUNNING.value
    run_obj.current_step_index = 0
    await db_session.flush()

    next_step = await get_next_step(run_id, db=db_session)
    assert next_step["step_index"] >= 0


@pytest.mark.asyncio
async def test_get_run_exposes_workflow_snapshot_steps(db_session):
    # Phase C: the daemon's generic loop drives the plan from run.workflow_snapshot
    # .steps, so GET /v1/runs/{id} must expose it (the seeded step's action_type
    # is what the daemon dispatches on). Self-contained (does not use _seed_run,
    # whose update_status(active) hits a pre-existing StateTransitionError).
    wf_svc = WorkflowService(db_session)
    wf = await wf_svc.create(name="snap-exposure", target_url="https://example.test")
    await wf_svc.add_step(
        workflow_id=str(wf.id),
        step_index=0,
        action_type="linkedin_people_search",
        intent="search",
        value="https://www.linkedin.com/search/results/people/",
    )
    run = await ExecutionService(db_session).create_run(str(wf.id))
    result = await get_run(str(run.id), db=db_session)
    snap = result.get("workflow_snapshot")
    assert snap is not None, "GET must expose workflow_snapshot"
    steps = snap.get("steps") or []
    assert len(steps) == 1
    assert steps[0]["action_type"] == "linkedin_people_search"


@pytest.mark.asyncio
async def test_runs_error_paths_direct(db_session, monkeypatch):
    fake = str(uuid.uuid4())
    nf = await get_run(fake, db=db_session)
    assert isinstance(nf, JSONResponse)
    assert nf.status_code == 404

    invalid = await get_run_events("not-a-uuid", limit=100, offset=0, event_type=None, db=db_session)
    assert isinstance(invalid, JSONResponse)
    assert invalid.status_code == 404

    async def _state(*_args, **_kwargs):
        raise StateTransitionError("bad")

    monkeypatch.setattr("services.execution_service.ExecutionService.pause", _state)
    state_pause = await pause_run(fake, body={"reason": "x"}, db=db_session)
    assert state_pause.status_code == 409

    monkeypatch.setattr("services.execution_service.ExecutionService.resume", _state)
    state_resume = await resume_run(fake, db=db_session)
    assert state_resume.status_code == 409

    monkeypatch.setattr("services.execution_service.ExecutionService.cancel", _state)
    state_cancel = await cancel_run(fake, db=db_session)
    assert state_cancel.status_code == 409

    async def _bad_cancel(*_args, **_kwargs):
        raise ValueError("bad request")

    monkeypatch.setattr("services.execution_service.ExecutionService.cancel", _bad_cancel)
    val_cancel = await cancel_run(fake, db=db_session)
    assert val_cancel.status_code == 422

    async def _boom_cancel(*_args, **_kwargs):
        raise RuntimeError("boom")

    async def _fake_get(*_args, **_kwargs):
        return types.SimpleNamespace(status="running")

    monkeypatch.setattr("services.execution_service.ExecutionService.cancel", _boom_cancel)
    monkeypatch.setattr("services.execution_service.ExecutionService.get_run", _fake_get)
    err_cancel = await cancel_run(fake, db=db_session)
    assert err_cancel.status_code == 500

    settings.debug = False
    with pytest.raises(HTTPException):
        await inject_heal_override(types.SimpleNamespace(run_id="x", response={}))
    with pytest.raises(HTTPException):
        await clear_heal_overrides()
    settings.debug = True
    assert (await inject_heal_override(types.SimpleNamespace(run_id="x", response={})))["injected"] is True
    assert (await clear_heal_overrides())["cleared"] is True
    settings.debug = False


@pytest.mark.asyncio
async def test_runs_step_heal_and_extraction_direct(db_session, monkeypatch):
    _, run_id = await _seed_run(db_session, status="running")

    ok = await report_step_result(
        run_id,
        req=StepResultRequest(step_index=0, action_type="click", success=True, screenshot_ref="s3://x"),
        db=db_session,
    )
    assert ok["status"] in {"running", "completed"}

    run = await db_session.get(ExecutionRun, uuid.UUID(run_id))
    assert run is not None
    run.current_step_index = 0
    run.status = RunStatus.RUNNING.value
    await db_session.flush()
    fail = await report_step_result(
        run_id,
        req=StepResultRequest(step_index=0, action_type="click", success=False, error="failed", screenshot_ref="x"),
        db=db_session,
    )
    assert fail["status"] == "failed"

    mismatch = await report_step_result(
        run_id,
        req=StepResultRequest(step_index=7, action_type="click", success=True),
        db=db_session,
    )
    assert isinstance(mismatch, JSONResponse)
    assert mismatch.status_code == 409

    run.status = RunStatus.RECOVERING.value
    await db_session.flush()

    async def _suggest(*_args, **_kwargs):
        return {"new_selectors": [{"type": "css", "value": "#a"}], "confidence": 0.8, "explanation": "ok"}

    monkeypatch.setattr("services.healing_service.HealingService.suggest_heal", _suggest)
    heal = await heal_step(
        run_id,
        req=HealStepRequest(step_index=0, dom_snippet="<div/>", old_selectors=["#old"]),
        request=types.SimpleNamespace(headers={"X-AI-API-Key": "x"}),
        db=db_session,
    )
    assert heal["confidence"] == 0.8

    async def _low(*_args, **_kwargs):
        return {"below_threshold": True, "confidence": 0.1}

    monkeypatch.setattr("services.healing_service.HealingService.suggest_heal", _low)
    low = await heal_step(
        run_id,
        req=HealStepRequest(step_index=0, dom_snippet="<div/>", old_selectors=["#old"]),
        request=types.SimpleNamespace(headers={}),
        db=db_session,
    )
    assert isinstance(low, JSONResponse)
    assert low.status_code == 409

    async def _heal_ok(*_args, **_kwargs):
        return types.SimpleNamespace(id=uuid.UUID(run_id), status="running", current_step_index=0)

    monkeypatch.setattr("services.healing_service.HealingService.heal_succeeded", _heal_ok)
    heal_ok = await heal_result(
        run_id,
        req=HealResultRequest(step_index=0, success=True, new_selectors=[{"type": "css", "value": "#a"}]),
        db=db_session,
    )
    assert heal_ok["status"] == "running"

    async def _heal_fail(*_args, **_kwargs):
        raise StateTransitionError("bad")

    monkeypatch.setattr("services.healing_service.HealingService.heal_failed", _heal_fail)
    heal_bad = await heal_result(
        run_id,
        req=HealResultRequest(step_index=0, success=False, error="bad"),
        db=db_session,
    )
    assert isinstance(heal_bad, JSONResponse)
    assert heal_bad.status_code == 409

    first = await record_intervention(
        req=types.SimpleNamespace(
            run_id=run_id,
            trigger_reason="captcha",
            page_url=None,
            checkpoint_event_id=None,
            resolution_notes=None,
            user_action=None,
        ),
        db=db_session,
    )
    second = await record_intervention(
        req=types.SimpleNamespace(
            run_id=run_id,
            trigger_reason="captcha",
            page_url=None,
            checkpoint_event_id=None,
            resolution_notes=None,
            user_action=None,
        ),
        db=db_session,
    )
    assert first["id"] == second["id"]

    extraction = await report_extraction(
        run_id,
        req=ExtractionResultRequest(step_index=0, data=[{"a": 1}], schema={"type": "array"}),
        db=db_session,
    )
    assert extraction["records"] == 1


@pytest.mark.asyncio
async def test_runs_create_and_delete_all_direct(db_session):
    wf_id, _ = await _seed_run(db_session, status="running")
    created = await create_run(CreateRunRequest(workflow_id=wf_id), db=db_session)
    assert created["workflow_id"] == wf_id

    deleted = await delete_all_runs(db=db_session)
    assert "runs" in deleted["deleted"]

    missing = await recover_run(str(uuid.uuid4()), body={"step_index": 0}, db=db_session)
    assert isinstance(missing, JSONResponse)
    assert missing.status_code == 404
