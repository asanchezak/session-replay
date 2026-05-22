import uuid
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from adapters.odoo.adapter import OdooAdapter
from adapters.registry import get_adapter
from core.database import get_db
from core.models.connector import ConnectorConfig

router = APIRouter(prefix="/connectors", tags=["connectors"])


class RegisterConnectorRequest(BaseModel):
    type: str
    name: str
    config: dict[str, Any]


class UpdateConnectorRequest(BaseModel):
    name: str | None = None
    config: dict[str, Any] | None = None


_SENSITIVE_TOKENS = ("password", "secret", "token", "api_key", "apikey")
_REDACTED = "[REDACTED]"


def _is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    if lowered in {"key", "private_key", "client_secret"}:
        return True
    return any(token in lowered for token in _SENSITIVE_TOKENS)


def _redact_config(value: Any, *, key: str | None = None) -> Any:
    if key and _is_sensitive_key(key):
        return _REDACTED
    if isinstance(value, dict):
        return {k: _redact_config(v, key=str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_config(v) for v in value]
    return value


def _resolve(connector_id: str, db: AsyncSession):
    try:
        uid = uuid.UUID(connector_id)
    except ValueError:
        return None
    result = db.execute(select(ConnectorConfig).where(ConnectorConfig.id == uid))
    return result.scalar_one_or_none()


@router.get("")
async def list_connectors(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ConnectorConfig).order_by(ConnectorConfig.created_at.desc()))
    connectors = result.scalars().all()
    return [
        {
            "id": str(c.id),
            "name": c.name,
            "type": c.connector_type,
            "status": "connected" if c.config.get("healthy") else "error",
            "last_sync": c.config.get("last_sync"),
        }
        for c in connectors
    ]


@router.get("/{connector_id}")
async def get_connector(connector_id: str, db: AsyncSession = Depends(get_db)):
    try:
        uid = uuid.UUID(connector_id)
    except ValueError:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Connector not found"}},
        )
    result = await db.execute(select(ConnectorConfig).where(ConnectorConfig.id == uid))
    c = result.scalar_one_or_none()
    if not c:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Connector not found"}},
        )
    return {
        "id": str(c.id),
        "name": c.name,
        "type": c.connector_type,
        "config": _redact_config(c.config),
        "created_at": c.created_at.isoformat(),
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


@router.post("")
async def register_connector(
    req: RegisterConnectorRequest,
    db: AsyncSession = Depends(get_db),
):
    connector = ConnectorConfig(
        name=req.name,
        connector_type=req.type,
        config=req.config,
    )
    db.add(connector)
    await db.flush()
    return {"id": str(connector.id), "name": connector.name, "type": connector.connector_type}


@router.put("/{connector_id}")
async def update_connector(
    connector_id: str,
    req: UpdateConnectorRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        uid = uuid.UUID(connector_id)
    except ValueError:
        return JSONResponse(status_code=404, content={"error": {"code": "NOT_FOUND", "message": "Connector not found"}})
    result = await db.execute(select(ConnectorConfig).where(ConnectorConfig.id == uid))
    connector = result.scalar_one_or_none()
    if not connector:
        return JSONResponse(status_code=404, content={"error": {"code": "NOT_FOUND", "message": "Connector not found"}})
    if req.name is not None:
        connector.name = req.name
    if req.config is not None:
        merged = dict(connector.config or {})
        for key, value in req.config.items():
            # Allow round-tripping redacted payloads without clobbering stored secrets.
            if value == _REDACTED:
                continue
            merged[key] = value
        connector.config = merged
    await db.flush()
    return {"id": str(connector.id), "name": connector.name, "type": connector.connector_type}


@router.post("/{connector_id}/test")
async def test_connector(
    connector_id: str,
    db: AsyncSession = Depends(get_db),
):
    try:
        uid = uuid.UUID(connector_id)
    except ValueError:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Connector not found"}},
        )
    result = await db.execute(select(ConnectorConfig).where(ConnectorConfig.id == uid))
    connector = result.scalar_one_or_none()
    if not connector:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Connector not found"}},
        )

    try:
        adapter_cls = get_adapter(connector.connector_type)
    except ValueError:
        if connector.connector_type == "odoo":
            adapter_cls = OdooAdapter
        else:
            return {"status": "error", "message": f"No adapter found for type '{connector.connector_type}'"}

    try:
        adapter = adapter_cls()
        await adapter.initialize(connector.config)
        health = await adapter.health_check()
        connector.config = {**connector.config, "healthy": health.status == "healthy", "last_error": health.last_error}
        await db.flush()
        await adapter.dispose()
        return {
            "status": "ok" if health.status == "healthy" else "error",
            "healthy": health.status == "healthy",
            "latency_ms": health.latency_ms,
            "error": health.last_error,
        }
    except Exception as e:
        connector.config = {**connector.config, "healthy": False, "last_error": str(e)}
        await db.flush()
        return {"status": "error", "message": str(e)}


@router.delete("/{connector_id}")
async def delete_connector(connector_id: str, db: AsyncSession = Depends(get_db)):
    try:
        uid = uuid.UUID(connector_id)
    except ValueError:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Connector not found"}},
        )
    result = await db.execute(select(ConnectorConfig).where(ConnectorConfig.id == uid))
    connector = result.scalar_one_or_none()
    if not connector:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Connector not found"}},
        )
    await db.execute(delete(ConnectorConfig).where(ConnectorConfig.id == uid))
    return {"status": "deleted"}
