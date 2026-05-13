import time

from fastapi import APIRouter

router = APIRouter(prefix="/debug", tags=["debug"])

_logs: list[dict] = []
_MAX_LOG = 500


@router.post("/log")
async def ingest_log(entry: dict):
    entry["_server_time"] = time.time()
    _logs.append(entry)
    if len(_logs) > _MAX_LOG:
        _logs.pop(0)
    return {"ok": True}


@router.get("/logs")
async def get_logs(source: str | None = None, since: float | None = None, limit: int = 100):
    result = list(_logs)
    if source:
        result = [e for e in result if e.get("source") == source]
    if since:
        result = [e for e in result if e.get("_server_time", 0) > since]
    result.reverse()
    return result[:limit]
