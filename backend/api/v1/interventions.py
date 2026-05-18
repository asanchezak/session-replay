from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.models.intervention import HumanIntervention

router = APIRouter(prefix="/interventions", tags=["interventions"])


def _priority_for_reason(reason: str) -> int:
    lowered = reason.lower()
    if "captcha" in lowered or "2fa" in lowered:
        return 3
    if "login" in lowered or "modal" in lowered:
        return 2
    return 1


@router.get("")
async def list_interventions(
    limit: int = Query(default=50, ge=1, le=200),
    unresolved_only: bool = Query(default=True),
    db: AsyncSession = Depends(get_db),
):
    query = select(HumanIntervention).order_by(HumanIntervention.paused_at.desc()).limit(limit)
    if unresolved_only:
        query = query.where(HumanIntervention.resumed_at.is_(None))

    result = await db.execute(query)
    interventions = list(result.scalars().all())
    return {
        "interventions": [
            {
                "id": str(i.id),
                "run_id": i.run_id,
                "trigger_reason": i.trigger_reason,
                "paused_at": i.paused_at.isoformat() if i.paused_at else None,
                "priority": _priority_for_reason(i.trigger_reason),
            }
            for i in interventions
        ]
    }
