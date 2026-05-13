import logging
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.database import get_db
from core.exceptions import NotFoundError, StateTransitionError
from core.models.event import EventLog
from core.models.intervention import HumanIntervention
from services.artifact_service import ArtifactService
from services.audit import AppendEvent, AuditService
from services.execution_service import ExecutionService
from services.healing_service import HealingService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/runs", tags=["runs"])

# In-memory heal overrides for testing (maps run_id → override dict, "__all__" for global)
_HEAL_OVERRIDES: dict[str, dict] = {}


class InjectHealOverrideRequest(BaseModel):
    run_id: str = "__all__"
    response: dict


@router.post("/testing/inject-heal-override")
async def inject_heal_override(req: InjectHealOverrideRequest):
    if not settings.debug:
        raise HTTPException(status_code=404, detail="Not found")
    _HEAL_OVERRIDES[req.run_id] = req.response
    return {"injected": True}


@router.post("/testing/clear-heal-overrides")
async def clear_heal_overrides():
    if not settings.debug:
        raise HTTPException(status_code=404, detail="Not found")
    _HEAL_OVERRIDES.clear()
    return {"cleared": True}


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
    logger.info("Creating run workflow_id=%s user_id=%s", req.workflow_id, req.user_id)
    svc = ExecutionService(db)
    try:
        run = await svc.create_run(
            workflow_id=req.workflow_id, user_id=req.user_id
        )
    except NotFoundError:
        logger.warning("Workflow not found for create_run workflow_id=%s", req.workflow_id)
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
    limit: int = Query(default=50, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    logger.info("Listing runs workflow_id=%s status=%s", workflow_id, status)
    svc = ExecutionService(db)
    runs = await svc.list_runs(
        workflow_id=workflow_id, status=status, limit=limit, offset=offset
    )
    return runs


@router.get("/{run_id}")
async def get_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    logger.info("Getting run run_id=%s", run_id)
    svc = ExecutionService(db)
    try:
        run = await svc.get_run(run_id)
    except NotFoundError:
        logger.warning("Run not found run_id=%s", run_id)
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


@router.get("/{run_id}/events")
async def get_run_events(
    run_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    event_type: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        await svc.get_run(run_id)
    except NotFoundError:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Run not found"}},
        )

    try:
        run_uuid = uuid.UUID(run_id)
    except ValueError:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Run not found"}},
        )

    query = select(EventLog).where(EventLog.run_id == run_uuid)
    if event_type:
        query = query.where(EventLog.event_type == event_type)
    query = query.order_by(EventLog.sequence_number).offset(offset).limit(limit)

    result = await db.execute(query)
    events = list(result.scalars().all())

    return [
        {
            "id": str(e.id),
            "event_type": e.event_type,
            "actor_type": e.actor_type,
            "payload": e.payload,
            "page_url": e.page_url,
            "hash": e.hash,
            "previous_hash": e.previous_hash,
            "sequence_number": e.sequence_number,
            "created_at": e.created_at.isoformat(),
        }
        for e in events
    ]


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

    audit = AuditService(db)
    await audit.append(AppendEvent(
        event_type="checkpoint",
        payload={"step_index": req.step_index, "snapshot": req.snapshot},
        run_id=run_id,
    ))
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

    return {
        "id": str(run.id),
        "status": run.status,
        "ended_at": run.ended_at.isoformat() if run.ended_at else None,
    }


@router.post("/{run_id}/advance_step")
async def advance_step_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.advance_step(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    except StateTransitionError as e:
        return _error("STATE_ERROR", str(e), status=409)

    return {
        "id": str(run.id),
        "status": run.status,
        "current_step_index": run.current_step_index,
    }


@router.post("/{run_id}/next-step")
async def get_next_step(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.get_run(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")

    if run.status != "running":
        return _error(
            "STATE_ERROR",
            f"Run is '{run.status}', must be 'running' to get next step",
            status=409,
        )

    snapshot = run.workflow_snapshot or {}
    steps = snapshot.get("steps", [])
    idx = run.current_step_index
    if idx >= len(steps):
        return _error("STATE_ERROR", "All steps completed", status=409)

    step = steps[idx]
    return {
        "run_id": run_id,
        "step_index": idx,
        "action_type": step.get("action_type"),
        "intent": step.get("intent"),
        "selector_chain": step.get("selector_chain"),
        "value": step.get("value"),
        "methods": step.get("methods"),
    }


class HealStepRequest(BaseModel):
    step_index: int
    dom_snippet: str
    old_selectors: list[str]
    intent: str | None = None


class HealResultRequest(BaseModel):
    step_index: int
    success: bool
    error: str | None = None
    new_selectors: list[dict] | None = None


class StepResultRequest(BaseModel):
    step_index: int
    action_type: str | None = None
    success: bool
    error: str | None = None
    screenshot_ref: str | None = None


@router.post("/{run_id}/step-result")
async def report_step_result(
    run_id: str,
    req: StepResultRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    audit = AuditService(db)

    try:
        run = await svc.get_run(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")

    if run.status not in ("running", "recovering"):
        return _error(
            "STATE_ERROR",
            f"Run is '{run.status}', must be 'running' or 'recovering'",
            status=409,
        )

    if req.step_index != run.current_step_index:
        return _error(
            "STEP_INDEX_MISMATCH",
            f"Expected step {run.current_step_index}, got {req.step_index}",
            status=409,
        )

    await audit.append(AppendEvent(
        event_type="step_executed",
        payload={
            "step_index": req.step_index,
            "action_type": req.action_type,
            "success": req.success,
            "error": req.error,
            "screenshot_ref": req.screenshot_ref,
        },
        run_id=run_id,
    ))

    if req.screenshot_ref:
        artifact_svc = ArtifactService(db)
        try:
            await artifact_svc.store_artifact(
                run_id=run_id,
                step_index=req.step_index,
                artifact_type="screenshot",
                data=req.screenshot_ref.encode("utf-8"),
                mime_type="text/plain",
                metadata={"action_type": req.action_type, "is_ref": True},
            )
        except Exception:
            logger.warning("Failed to store screenshot artifact", exc_info=True)

    if req.success:
        run.error_summary = None
        run = await svc.advance_step(run_id)
    else:
        run = await svc.fail(run_id, req.error or "Step failed")
    return {
        "id": str(run.id),
        "status": run.status,
        "current_step_index": run.current_step_index,
        "error_summary": run.error_summary,
    }


@router.post("/{run_id}/recover")
async def recover_run(
    run_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    svc = HealingService(db)
    try:
        run = await svc.recover(
            run_id,
            step_index=body.get("step_index", 0),
            error=body.get("error", "Step failed — attempting recovery"),
        )
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    except StateTransitionError as e:
        return _error("STATE_ERROR", str(e), status=409)

    return {
        "id": str(run.id),
        "status": run.status,
        "current_step_index": run.current_step_index,
    }


@router.post("/{run_id}/heal-step")
async def heal_step(
    run_id: str,
    req: HealStepRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    svc = HealingService(db)
    try:
        run = await svc.execution.get_run(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")

    ai_api_key = request.headers.get("X-AI-API-Key")
    override = _HEAL_OVERRIDES.pop(run_id, None) or _HEAL_OVERRIDES.get("__all__")
    if override:
        result = {
            "new_selectors": override.get("fallback_selectors", override.get("new_selectors", [])),
            "confidence": override.get("confidence", 0.0),
            "explanation": override.get("explanation", ""),
        }
    else:
        result = await svc.suggest_heal(
            run=run,
            step_index=req.step_index,
            dom_snippet=req.dom_snippet,
            old_selectors=req.old_selectors,
            intent=req.intent,
            ai_api_key=ai_api_key,
        )

    if result.get("below_threshold"):
        return _error(
            "LOW_CONFIDENCE",
            f"Healing confidence too low: {result.get('confidence', 0.0)}",
            status=409,
        )

    return {
        "step_index": req.step_index,
        "new_selectors": result["new_selectors"],
        "confidence": result["confidence"],
        "explanation": result["explanation"],
    }


@router.post("/{run_id}/heal-result")
async def heal_result(
    run_id: str,
    req: HealResultRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = HealingService(db)
    try:
        if req.success:
            run = await svc.heal_succeeded(
                run_id, req.step_index, new_selectors=req.new_selectors
            )
        else:
            run = await svc.heal_failed(
                run_id, req.step_index, error=req.error or "Healing failed"
            )
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    except StateTransitionError as e:
        return _error("STATE_ERROR", str(e), status=409)

    return {
        "id": str(run.id),
        "status": run.status,
        "current_step_index": run.current_step_index,
    }


@router.post("/interventions")
async def record_intervention(
    req: InterventionRequest,
    db: AsyncSession = Depends(get_db),
):
    existing = await db.execute(
        select(HumanIntervention).where(
            HumanIntervention.run_id == req.run_id,
            HumanIntervention.trigger_reason == req.trigger_reason,
            HumanIntervention.paused_at >= datetime.now(UTC) - timedelta(minutes=5),
        )
    )
    existing_intervention = existing.scalar_one_or_none()
    if existing_intervention:
        return {
            "id": str(existing_intervention.id),
            "run_id": existing_intervention.run_id,
            "trigger_reason": existing_intervention.trigger_reason,
            "paused_at": existing_intervention.paused_at.isoformat(),
        }

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
