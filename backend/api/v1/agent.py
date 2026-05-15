import logging

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.exceptions import NotFoundError
from services.agent_models import (
    DashboardAction,
    DashboardActionResponse,
    PollRequest,
    PollResponse,
    ResultRequest,
    ResultResponse,
)
from services.agent_service import AgentService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agent", tags=["agent"])


def _error(code: str, message: str, status: int = 404):
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}},
    )


@router.post("/{run_id}/poll", response_model=PollResponse)
async def agent_poll(
    run_id: str,
    req: PollRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = AgentService(db)
    try:
        return await svc.poll(run_id, req)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    except Exception as e:
        logger.exception("Agent poll failed for run %s", run_id)
        return _error("AGENT_ERROR", str(e), status=500)


@router.post("/{run_id}/result", response_model=ResultResponse)
async def agent_result(
    run_id: str,
    req: ResultRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = AgentService(db)
    try:
        return await svc.report_result(run_id, req)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    except Exception as e:
        logger.exception("Agent result failed for run %s", run_id)
        return _error("AGENT_ERROR", str(e), status=500)


@router.post("/{run_id}/action", response_model=DashboardActionResponse)
async def agent_action(
    run_id: str,
    req: DashboardAction,
    db: AsyncSession = Depends(get_db),
):
    svc = AgentService(db)
    return await svc.push_action(run_id, req.action)


@router.get("/{run_id}/decisions")
async def agent_decisions(
    run_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    svc = AgentService(db)
    try:
        decisions = await svc.get_decisions(run_id, limit=limit)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    return decisions


@router.get("/{run_id}/outcomes")
async def agent_outcomes(
    run_id: str,
    limit: int = Query(default=200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
):
    """Phase 4: per-decision telemetry for analytics and the RunDetail trace."""
    from sqlalchemy import select

    from core.models.ai_decision_outcome import AIDecisionOutcome

    result = await db.execute(
        select(AIDecisionOutcome)
        .where(AIDecisionOutcome.run_id == run_id)
        .order_by(AIDecisionOutcome.created_at.asc())
        .limit(limit)
    )
    rows = result.scalars().all()
    return [
        {
            "id": str(r.id),
            "step_index": r.step_index,
            "decision": r.decision,
            "confidence": r.confidence,
            "actual_outcome": r.actual_outcome,
            "latency_ms": r.latency_ms,
            "model": r.model,
            "prompt_hash": r.prompt_hash,
            "reasoning": r.reasoning,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "resolved_at": r.resolved_at.isoformat() if r.resolved_at else None,
        }
        for r in rows
    ]


@router.post("/{run_id}/resume")
async def agent_resume(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    """On-demand 'Resume with AI' — gives the LLM another shot at unsticking
    a paused or stalled run. Also fired by the background supervisor."""
    from services.recovery_supervisor import RecoverySupervisor
    supervisor = RecoverySupervisor(db)
    try:
        run = await supervisor.agent.execution.get_run(run_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Run not found")
    resumed = await supervisor.attempt_resume(run, forced=True)
    return {
        "resumed": resumed,
        "run_id": run_id,
        "status": run.status,
    }
