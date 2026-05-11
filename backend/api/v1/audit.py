import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.exceptions import NotFoundError
from core.models.event import EventLog
from services.audit import AuditService
from services.execution_service import ExecutionService

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("/{run_id}")
async def get_audit_trail(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = ExecutionService(db)
    try:
        run = await svc.get_run(run_id)
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
    result = await db.execute(
        select(EventLog)
        .where(EventLog.run_id == run_uuid)
        .order_by(EventLog.created_at)
    )
    events = list(result.scalars().all())

    audit = AuditService(db)
    broken = await audit.verify_chain(run_id)

    return {
        "run_id": run_id,
        "workflow_id": run.workflow_id,
        "event_count": len(events),
        "chain_valid": len(broken) == 0,
        "broken_links": broken,
        "events": [
            {
                "id": str(e.id),
                "event_type": e.event_type,
                "actor_type": e.actor_type,
                "payload": e.payload,
                "page_url": e.page_url,
                "hash": e.hash,
                "previous_hash": e.previous_hash,
                "created_at": e.created_at.isoformat(),
            }
            for e in events
        ],
    }
