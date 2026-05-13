from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from adapters.registry import get_adapter

router = APIRouter(prefix="/integrations", tags=["integrations"])


class SyncRequest(BaseModel):
    connector_id: str
    action: str
    params: dict = {}
    password: str | None = None


@router.post("/odoo/sync")
async def sync_odoo(
    req: SyncRequest,
):
    try:
        adapter_cls = get_adapter("odoo")
    except ValueError:
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "code": "ADAPTER_NOT_FOUND",
                    "message": "Odoo adapter not registered",
                }
            },
        )

    try:
        from core.config import settings
        adapter = adapter_cls({
            "url": settings.database_url,  # placeholder — real config from connector store
            "database": "workflow",
            "username": "admin",
            "password": req.password or "",
        })
        await adapter.connect()

        result = await adapter.search_read(req.action, [])
        count = len(result) if isinstance(result, list) else 0
        return {"status": "ok", "records": result, "count": count}
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "SYNC_ERROR", "message": str(e)}},
        )
