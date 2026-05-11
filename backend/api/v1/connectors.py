from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from adapters.registry import get_adapter

router = APIRouter(prefix="/connectors", tags=["connectors"])


class RegisterConnectorRequest(BaseModel):
    type: str
    name: str
    config: dict


_connectors: dict[str, dict] = {}


@router.get("")
async def list_connectors():
    return [
        {
            "id": cid,
            "name": c["name"],
            "type": c["type"],
            "status": "connected" if c.get("healthy") else "error",
            "last_sync": c.get("last_sync"),
        }
        for cid, c in _connectors.items()
    ]


@router.post("")
async def register_connector(
    req: RegisterConnectorRequest,
):
    import uuid
    cid = str(uuid.uuid4())
    _connectors[cid] = {
        "name": req.name,
        "type": req.type,
        "config": req.config,
        "healthy": False,
        "last_sync": None,
    }
    return {"id": cid, "name": req.name, "type": req.type}


@router.post("/{connector_id}/test")
async def test_connector(
    connector_id: str,
):
    connector = _connectors.get(connector_id)
    if not connector:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Connector not found"}},
        )

    try:
        adapter_cls = get_adapter(connector["type"])
    except ValueError:
        return {"status": "error", "message": f"No adapter found for type '{connector['type']}'"}

    try:
        adapter = adapter_cls(connector["config"])
        healthy = await adapter.health()
        connector["healthy"] = healthy
        return {"status": "ok" if healthy else "error", "healthy": healthy}
    except Exception as e:
        connector["healthy"] = False
        return {"status": "error", "message": str(e)}
