from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from services.webhook_trigger_service import SUPPORTED_EVENT_KINDS, WebhookTriggerService

router = APIRouter(tags=["webhooks"])


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


# ── Incoming webhook from Odoo ────────────────────────────────────────────────

@router.post("/webhooks/incoming/odoo/{connector_id}")
async def odoo_incoming_webhook(
    connector_id: str,
    payload: dict,
    db: AsyncSession = Depends(get_db),
):
    """Receive a new-position event from Odoo and fire linked workflow triggers."""
    svc = WebhookTriggerService(db)
    try:
        run_ids = await svc.fire_from_odoo_payload(connector_id, payload)
    except ValueError as exc:
        return _err(400, "BAD_REQUEST", str(exc))
    await db.commit()
    return {"triggered_runs": run_ids, "count": len(run_ids)}


# ── Manual test trigger ───────────────────────────────────────────────────────

class TriggerNowRequest(BaseModel):
    connector_id: str
    job_url: str | None = Field(default=None, description="Override the application URL sent in the message")


@router.post("/workflows/{workflow_id}/trigger-now")
async def trigger_workflow_now(
    workflow_id: str,
    req: TriggerNowRequest,
    db: AsyncSession = Depends(get_db),
):
    """Manually trigger a workflow run using the latest Odoo job (for testing)."""
    svc = WebhookTriggerService(db)
    try:
        result = await svc.trigger_now(
            workflow_id=workflow_id,
            connector_id=req.connector_id,
            job_url=req.job_url,
        )
    except ValueError as exc:
        return _err(400, "BAD_REQUEST", str(exc))
    await db.commit()
    return result


# ── Webhook trigger management ────────────────────────────────────────────────

class CreateTriggerRequest(BaseModel):
    connector_id: str
    event_kind: str = Field(default="new_job_position", pattern=r"^new_job_position$")


@router.get("/workflows/{workflow_id}/webhook-triggers")
async def list_webhook_triggers(
    workflow_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = WebhookTriggerService(db)
    triggers = await svc.list_triggers(workflow_id=workflow_id)
    return {
        "triggers": [
            {
                "id": str(t.id),
                "connector_id": t.connector_id,
                "workflow_id": t.workflow_id,
                "event_kind": t.event_kind,
                "enabled": t.enabled,
                "created_at": t.created_at.isoformat() if t.created_at else None,
            }
            for t in triggers
        ]
    }


@router.post("/workflows/{workflow_id}/webhook-triggers")
async def create_webhook_trigger(
    workflow_id: str,
    req: CreateTriggerRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = WebhookTriggerService(db)
    try:
        trigger = await svc.create_trigger(
            connector_id=req.connector_id,
            workflow_id=workflow_id,
            event_kind=req.event_kind,
        )
    except ValueError as exc:
        return _err(400, "BAD_REQUEST", str(exc))
    await db.commit()
    return {
        "id": str(trigger.id),
        "connector_id": trigger.connector_id,
        "workflow_id": trigger.workflow_id,
        "event_kind": trigger.event_kind,
        "enabled": trigger.enabled,
    }


@router.delete("/workflows/{workflow_id}/webhook-triggers/{trigger_id}")
async def delete_webhook_trigger(
    workflow_id: str,
    trigger_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = WebhookTriggerService(db)
    deleted = await svc.delete_trigger(trigger_id)
    if not deleted:
        return _err(404, "NOT_FOUND", "Webhook trigger not found.")
    await db.commit()
    return {"deleted": True}


@router.get("/connectors/{connector_id}/webhook-triggers")
async def list_connector_webhook_triggers(
    connector_id: str,
    db: AsyncSession = Depends(get_db),
):
    """List all webhook triggers that use a specific connector."""
    svc = WebhookTriggerService(db)
    triggers = await svc.list_triggers(connector_id=connector_id)
    return {
        "triggers": [
            {
                "id": str(t.id),
                "connector_id": t.connector_id,
                "workflow_id": t.workflow_id,
                "event_kind": t.event_kind,
                "enabled": t.enabled,
            }
            for t in triggers
        ]
    }


@router.get("/webhooks/supported-events")
async def list_supported_events():
    return {"event_kinds": sorted(SUPPORTED_EVENT_KINDS)}
