import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.database import get_db
from core.exceptions import NotFoundError, StateTransitionError
from core.models.ai_decision_outcome import AIDecisionOutcome
from core.models.ai_reasoning_chain import AIReasoningChain
from core.models.artifact import Artifact
from core.models.event import EventLog
from core.models.intervention import HumanIntervention
from core.models.page_state_snapshot import PageStateSnapshot
from core.models.recovery_attempt_trace import RecoveryAttemptTrace
from core.models.run import ExecutionRun
from core.models.run_summary import RunSummary
from core.state_machine import RunStatus
from services.artifact_service import ArtifactService
from services.audit import AppendEvent, AuditService
from services.execution_service import ExecutionService
from services.healing_service import HealingService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/runs", tags=["runs"])

# In-memory heal overrides for testing (maps run_id → override dict, "__all__" for global)
_HEAL_OVERRIDES: dict[str, dict[str, Any]] = {}


class InjectHealOverrideRequest(BaseModel):
    run_id: str = "__all__"
    response: dict[str, Any]


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
    snapshot: dict[str, Any] = Field(default_factory=dict)


class FailRequest(BaseModel):
    error: str


class PauseRunRequest(BaseModel):
    reason: str = "Manual pause"
    step_index: int | None = None


class RecoverRunRequest(BaseModel):
    step_index: int = 0
    error: str = "Step failed - attempting recovery"
    dom_snippet: str = ""


class InterventionRequest(BaseModel):
    run_id: str
    trigger_reason: str
    page_url: str | None = None
    checkpoint_event_id: str | None = None
    resolution_notes: str | None = None
    user_action: str | None = None


def _error(code: str, message: str, status: int = 404, details: dict | None = None):
    body: dict = {"error": {"code": code, "message": message}}
    if details:
        body["error"]["details"] = details
    return JSONResponse(
        status_code=status,
        content=body,
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


@router.delete("")
async def delete_all_runs(db: AsyncSession = Depends(get_db)):
    logger.info("Deleting all runs")
    counts: dict[str, int] = {}
    for model, key in [
        (EventLog, "events"),
        (HumanIntervention, "interventions"),
        (Artifact, "artifacts"),
        (RunSummary, "run_summaries"),
        (AIDecisionOutcome, "ai_decisions"),
        (AIReasoningChain, "ai_reasoning_chains"),
        (PageStateSnapshot, "page_snapshots"),
        (RecoveryAttemptTrace, "recovery_traces"),
        (ExecutionRun, "runs"),
    ]:
        resp = await db.execute(sa.delete(model))
        counts[key] = resp.rowcount
    await db.commit()
    logger.info("delete_all_runs complete: %s", counts)
    return {"deleted": counts}


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
        "goal_progress": run.goal_progress,
        "extracted_data": run.extracted_data or [],
        "resolved_parameters": (run.workflow_snapshot or {}).get("resolved_parameters", {}),
        "connector_resolution": (run.workflow_snapshot or {}).get("connector_resolution", []),
        "origin": run.origin or None,
        "linkedin_applicants": run.linkedin_applicants or [],
    }


@router.get("/{run_id}/message-targets")
async def get_run_message_targets(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Per-candidate rendered outreach drafts for a run's workflow template.

    Consumed by the extension's `open_message_drafts` action handler.
    """
    from core.models.workflow import Workflow
    from services.message_rendering_service import MessageRenderingService

    svc = ExecutionService(db)
    try:
        run = await svc.get_run(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")

    result = await db.execute(
        select(Workflow).where(Workflow.id == run.workflow_id)
    )
    workflow = result.scalar_one_or_none()
    if workflow is None:
        return _error("NOT_FOUND", "Workflow for run not found")

    renderer = MessageRenderingService(db)
    return await renderer.build_targets_for_run(run, workflow)


@router.post("/{run_id}/repush-applicants")
async def repush_run_applicants(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Re-run the LinkedIn applicant push hook for this run.

    Useful when initial push partially failed or to backfill the
    linkedin_applicants snapshot for runs that completed before this
    feature existed. Reads extraction events, posts each profile to
    Odoo's /akcr/api/linkedin_applicant, persists results on the run.
    """
    from services.linkedin_applicant_push_service import LinkedInApplicantPushService

    svc = ExecutionService(db)
    try:
        run = await svc.get_run(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    if not run.origin or (run.origin or {}).get("event_kind") != "new_job_position":
        return _error("INVALID_RUN", "Run is not a LinkedIn new-job-position run", status=400)
    pusher = LinkedInApplicantPushService(db)
    try:
        result = await pusher.push_from_run(run)
    except Exception as e:
        logger.exception("Repush failed for run %s", run_id)
        return _error("PUSH_FAILED", str(e), status=502)
    await db.commit()
    return result


@router.post("/{run_id}/refresh-applicants")
async def refresh_run_applicants(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Re-query Odoo for the applicants created from this run.

    Reads run.origin + extraction events, calls the Odoo lookup
    controller, and persists the snapshot to run.linkedin_applicants.
    Returns the refreshed list for immediate UI display.
    """
    from services.linkedin_applicant_push_service import LinkedInApplicantPushService

    svc = ExecutionService(db)
    try:
        run = await svc.get_run(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    pusher = LinkedInApplicantPushService(db)
    try:
        result = await pusher.refresh_from_run(run)
    except Exception as e:
        logger.exception("Failed to refresh applicants for run %s", run_id)
        return _error("REFRESH_FAILED", str(e), status=502)
    await db.commit()
    return result


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
    req: PauseRunRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.pause(run_id, reason=req.reason)
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


@router.post("/{run_id}/tab-closed")
async def tab_closed_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.tab_closed(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    return {"id": str(run.id), "status": run.status, "pause_reason": run.pause_reason}


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
    except ValueError as e:
        return _error("VALIDATION_ERROR", str(e), status=422)
    except Exception as e:
        logger.exception("Failed to cancel run %s", run_id)
        detail = {"exception_type": type(e).__name__, "exception": str(e)}
        try:
            run = await svc.get_run(run_id)
            detail["current_status"] = run.status
        except Exception:
            pass
        return _error("INTERNAL_ERROR", str(e), status=500, details=detail)

    return {"id": str(run.id), "status": run.status}


@router.post("/{run_id}/rerun")
async def rerun_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Create a new run that re-executes the source run's substituted plan."""
    svc = ExecutionService(db)
    try:
        new_run = await svc.rerun(run_id)
        new_run = await svc.transition(str(new_run.id), RunStatus.RUNNING)
    except NotFoundError:
        return _error("NOT_FOUND", "Source run not found")
    except StateTransitionError as e:
        return _error("STATE_ERROR", str(e), status=409)

    return {
        "id": str(new_run.id),
        "workflow_id": new_run.workflow_id,
        "status": new_run.status,
        "current_step_index": new_run.current_step_index,
        "total_steps": new_run.total_steps,
        "rerun_of": run_id,
    }


class ExpandForEachRequest(BaseModel):
    step_index: int


@router.post("/{run_id}/expand-for-each")
async def expand_for_each(
    run_id: str,
    req: ExpandForEachRequest,
    db: AsyncSession = Depends(get_db),
):
    """Materialize a for_each step into N concrete inner-step copies.

    The extension calls this mid-run after the source extract step has reported
    its profile_urls. The endpoint reads those URLs from event_log, applies the
    configured limit, and splices [navigate, extract, ...] copies into the run's
    workflow_snapshot.steps. Idempotent.
    """
    svc = ExecutionService(db)
    try:
        result = await svc.expand_for_each(run_id, req.step_index)
    except NotFoundError as e:
        return _error("NOT_FOUND", str(e))
    except StateTransitionError as e:
        return _error("STATE_ERROR", str(e), status=409)
    return result


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
    visible_text: str | None = None
    page_url: str | None = None


class HealResultRequest(BaseModel):
    step_index: int
    success: bool
    error: str | None = None
    new_selectors: list[dict[str, Any]] | None = None


class StepResultRequest(BaseModel):
    step_index: int
    action_type: str | None = None
    success: bool
    error: str | None = None
    screenshot_ref: str | None = None
    page_context_error: str | None = None
    actual_url: str | None = None


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
            "page_context_error": req.page_context_error,
            "actual_url": req.actual_url,
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
    req: RecoverRunRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = HealingService(db)
    try:
        run = await svc.recover(
            run_id,
            step_index=req.step_index,
            error=req.error,
            dom_snippet=req.dom_snippet,
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
            visible_text=req.visible_text,
            page_url=req.page_url,
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


class ExtractionResultRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    step_index: int
    data: list[dict[str, Any]] = Field(default_factory=list)
    output_schema: dict[str, Any] | None = None
    legacy_schema: dict[str, Any] | None = Field(default=None, alias="schema")
    url: str | None = None


@router.post("/{run_id}/extraction")
async def report_extraction(
    run_id: str,
    req: ExtractionResultRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.get_run(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")

    audit = AuditService(db)
    await audit.append(AppendEvent(
        event_type="extraction",
        payload={
            "step_index": req.step_index,
            "data": req.data,
            "output_schema": (
                req.output_schema
                if req.output_schema is not None
                else req.legacy_schema
            ),
            "url": req.url,
        },
        run_id=run_id,
        actor_type="extension",
    ))

    run.extracted_data = [*(run.extracted_data or []), *req.data]
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(run, "extracted_data")
    await db.flush()

    return {"status": "recorded", "records": len(req.data)}


class DebugCaptureRequest(BaseModel):
    """A snapshot of the page state when a step stalled or errored, posted by the
    daemon so it's retrievable remotely (GET /v1/runs/{id}/events?event_type=debug)
    without shell access to the host machine."""

    step_index: int | None = None
    reason: str | None = None
    url: str | None = None
    title: str | None = None
    html_excerpt: str | None = None
    console: list[str] = Field(default_factory=list)
    screenshot_path: str | None = None


@router.post("/{run_id}/debug")
async def report_debug(
    run_id: str,
    req: DebugCaptureRequest,
    db: AsyncSession = Depends(get_db),
):
    """Store a daemon-side debug capture as an event so it can be read back over
    Tailscale (the host machine has no shell access for the operator/Claude)."""
    svc = ExecutionService(db)
    try:
        await svc.get_run(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")

    audit = AuditService(db)
    await audit.append(AppendEvent(
        event_type="debug",
        payload={
            "step_index": req.step_index,
            "reason": req.reason,
            "url": req.url,
            "title": req.title,
            "html_excerpt": req.html_excerpt,
            "console": req.console,
            "screenshot_path": req.screenshot_path,
        },
        run_id=run_id,
        actor_type="extension",
    ))
    await db.flush()
    return {"status": "recorded"}
