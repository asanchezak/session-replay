from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from services.connector_forum_service import ConnectorForumService

router = APIRouter(prefix="/integrations", tags=["integrations"])


class SyncRequest(BaseModel):
    connector_id: str
    action: str
    params: dict = {}
    password: str | None = None


class ForumProfileSyncRequest(BaseModel):
    forum_base_url: str
    candidate_limit: int = Field(default=10, ge=1, le=100)
    candidate_filters: dict = Field(default_factory=dict)


class ForumMessageRequest(BaseModel):
    forum_base_url: str
    candidate_ids: list[str] = Field(default_factory=list)
    selection_prompt: str | None = None
    candidate_limit: int = Field(default=25, ge=1, le=200)
    candidate_filters: dict = Field(default_factory=dict)
    job_id: str | None = None
    job_description: str | None = None
    random_job: bool = False
    message_template: str | None = None


@router.post("/odoo/sync")
async def sync_odoo(
    req: SyncRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = ConnectorForumService(db)
    connector = await svc.resolve_connector(req.connector_id)
    if not connector:
        return JSONResponse(
            status_code=404,
            content={
                "error": {
                    "code": "NOT_FOUND",
                    "message": "Connector not found",
                }
            },
        )

    try:
        adapter = await svc._build_adapter(connector)
        try:
            result = await adapter.list(req.action, filters=req.params, limit=100)
            count = len(result) if isinstance(result, list) else 0
            return {"status": "ok", "records": result, "count": count}
        finally:
            await adapter.dispose()
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "SYNC_ERROR", "message": str(e)}},
        )


@router.post("/connectors/{connector_id}/forum/sync-profiles")
async def sync_connector_profiles_to_forum(
    connector_id: str,
    req: ForumProfileSyncRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = ConnectorForumService(db)
    connector = await svc.resolve_connector(connector_id)
    if not connector:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Connector not found"}},
        )

    try:
        return await svc.sync_profiles(
            connector,
            req.forum_base_url,
            candidate_limit=req.candidate_limit,
            candidate_filters=req.candidate_filters,
        )
    except Exception as e:
        return JSONResponse(
            status_code=502,
            content={"error": {"code": "FORUM_SYNC_FAILED", "message": str(e)}},
        )


@router.post("/connectors/{connector_id}/forum/send-messages")
async def send_forum_messages_via_connector(
    connector_id: str,
    req: ForumMessageRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = ConnectorForumService(db)
    connector = await svc.resolve_connector(connector_id)
    if not connector:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Connector not found"}},
        )

    try:
        return await svc.send_messages(
            connector,
            req.forum_base_url,
            candidate_ids=req.candidate_ids,
            selection_prompt=req.selection_prompt,
            candidate_limit=req.candidate_limit,
            candidate_filters=req.candidate_filters,
            job_id=req.job_id,
            job_description=req.job_description,
            random_job=req.random_job,
            message_template=req.message_template,
        )
    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "INVALID_REQUEST", "message": str(e)}},
        )
    except Exception as e:
        return JSONResponse(
            status_code=502,
            content={"error": {"code": "FORUM_MESSAGE_FAILED", "message": str(e)}},
        )
