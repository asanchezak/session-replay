import json
import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.models.event import EventLog
from services.audit import AuditService

VALID_EVENT_TYPES = (
    "click|type|select|submit|scroll|navigate|hover|copy|paste|tab_change"
)

router = APIRouter(prefix="/events", tags=["events"])


class RecordEventRequest(BaseModel):
    event_type: str = Field(
        ..., pattern=rf"^({VALID_EVENT_TYPES})$"
    )
    payload: dict = Field(default_factory=dict)
    page_url: str | None = None
    page_title: str | None = None
    run_id: str = Field(..., min_length=1)
    step_id: str | None = None
    actor_type: str = "extension"

    @field_validator("payload")
    @classmethod
    def payload_size(cls, v: dict) -> dict:
        size = len(json.dumps(v))
        if size > 1_000_000:
            raise ValueError(f"Payload exceeds 1MB limit ({size} bytes)")
        return v


class RecordEventResponse(BaseModel):
    id: str
    hash: str
    previous_hash: str


@router.post("/record", response_model=RecordEventResponse)
async def record_event(
    req: RecordEventRequest,
    db: AsyncSession = Depends(get_db),
):
    audit = AuditService(db)
    event = await audit.append(
        event_type=req.event_type,
        payload=req.payload,
        actor_type=req.actor_type,
        page_url=req.page_url,
        page_title=req.page_title,
        run_id=req.run_id,
        step_id=req.step_id,
    )
    return RecordEventResponse(
        id=str(event.id),
        hash=event.hash,
        previous_hash=event.previous_hash,
    )


@router.get("/{event_id}")
async def get_event(
    event_id: str,
    db: AsyncSession = Depends(get_db),
):
    try:
        uid = uuid.UUID(event_id)
    except ValueError:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Event not found"}},
        )
    result = await db.execute(
        select(EventLog).where(EventLog.id == uid)
    )
    event = result.scalar_one_or_none()
    if not event:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Event not found"}},
        )

    return {
        "id": str(event.id),
        "event_type": event.event_type,
        "actor_type": event.actor_type,
        "payload": event.payload,
        "page_url": event.page_url,
        "page_title": event.page_title,
        "hash": event.hash,
        "previous_hash": event.previous_hash,
        "created_at": event.created_at.isoformat(),
    }
