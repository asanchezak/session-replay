from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.exceptions import NotFoundError, StateTransitionError
from core.models.intervention import HumanIntervention
from services.execution_service import ExecutionService

router = APIRouter(prefix="/runs", tags=["runs"])


class CreateRunRequest(BaseModel):
    workflow_id: str
    user_id: str | None = None


class CheckpointRequest(BaseModel):
    step_index: int
    snapshot: dict = {}


class FailRequest(BaseModel):
    error: str


class InterventionRequest(BaseModel):
    run_id: str
    trigger_reason: str
    page_url: str | None = None
    checkpoint_event_id: str | None = None
    resolution_notes: str | None = None
    user_action: str | None = None


def _error(code: str, message: str, status: int = 404):
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}},
    )


@router.post("")
async def create_run(
    req: CreateRunRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.create_run(
            workflow_id=req.workflow_id, user_id=req.user_id
        )
    except NotFoundError:
        return _error("NOT_FOUND", "Workflow not found")

    return {
        "id": str(run.id),
        "workflow_id": run.workflow_id,
        "status": run.status,
        "current_step_index": run.current_step_index,
        "total_steps": run.total_steps,
        "created_at": run.created_at.isoformat(),
    }


@router.get("")
async def list_runs(
    workflow_id: str | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    runs = await svc.list_runs(
        workflow_id=workflow_id, status=status, limit=limit, offset=offset
    )
    return [
        {
            "id": str(r.id),
            "workflow_id": r.workflow_id,
            "status": r.status,
            "current_step_index": r.current_step_index,
            "total_steps": r.total_steps,
            "pause_reason": r.pause_reason,
            "error_summary": r.error_summary,
            "created_at": r.created_at.isoformat(),
        }
        for r in runs
    ]


@router.get("/{run_id}")
async def get_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.get_run(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")

    return {
        "id": str(run.id),
        "workflow_id": run.workflow_id,
        "status": run.status,
        "current_step_index": run.current_step_index,
        "total_steps": run.total_steps,
        "pause_reason": run.pause_reason,
        "error_summary": run.error_summary,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "ended_at": run.ended_at.isoformat() if run.ended_at else None,
        "created_at": run.created_at.isoformat(),
    }


@router.post("/{run_id}/pause")
async def pause_run(
    run_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.pause(
            run_id, reason=body.get("reason", "Manual pause")
        )
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    except StateTransitionError as e:
        return _error("STATE_ERROR", str(e), status=409)

    return {
        "id": str(run.id),
        "status": run.status,
        "pause_reason": run.pause_reason,
    }


@router.post("/{run_id}/resume")
async def resume_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.resume(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    except StateTransitionError as e:
        return _error("STATE_ERROR", str(e), status=409)

    return {"id": str(run.id), "status": run.status}


@router.post("/{run_id}/cancel")
async def cancel_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.cancel(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    except StateTransitionError as e:
        return _error("STATE_ERROR", str(e), status=409)

    return {"id": str(run.id), "status": run.status}


@router.post("/{run_id}/checkpoint")
async def checkpoint_run(
    run_id: str,
    req: CheckpointRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.get_run(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")

    from services.audit import AuditService
    audit = AuditService(db)
    await audit.append(
        event_type="checkpoint",
        payload={"step_index": req.step_index, "snapshot": req.snapshot},
        run_id=run_id,
    )
    return {"id": str(run.id), "status": run.status, "checkpoint_step": req.step_index}


@router.post("/{run_id}/fail")
async def fail_run(
    run_id: str,
    req: FailRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.fail(run_id, error=req.error)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    except StateTransitionError as e:
        return _error("STATE_ERROR", str(e), status=409)

    return {"id": str(run.id), "status": run.status, "error": run.error_summary}


@router.post("/{run_id}/complete")
async def complete_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.complete(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    except StateTransitionError as e:
        return _error("STATE_ERROR", str(e), status=409)

    return {"id": str(run.id), "status": run.status}


@router.post("/interventions")
async def record_intervention(
    req: InterventionRequest,
    db: AsyncSession = Depends(get_db),
):
    intervention = HumanIntervention(
        run_id=req.run_id,
        trigger_reason=req.trigger_reason,
        page_url=req.page_url,
        checkpoint_event_id=req.checkpoint_event_id,
        resolution_notes=req.resolution_notes,
        user_action=req.user_action,
        paused_at=datetime.now(UTC),
    )
    db.add(intervention)
    await db.flush()

    return {
        "id": str(intervention.id),
        "run_id": intervention.run_id,
        "trigger_reason": intervention.trigger_reason,
        "paused_at": intervention.paused_at.isoformat(),
    }
