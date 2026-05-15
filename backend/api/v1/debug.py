import time

from fastapi import APIRouter

from services.log_service import LogLevel, get_logger

router = APIRouter(prefix="/debug", tags=["debug"])

_logs: list[dict] = []
_MAX_LOG = 500

_log = get_logger()


@router.post("/log")
async def ingest_log(entry: dict):
    """Receive debug logs from extension content script and service worker."""
    entry["_server_time"] = time.time()
    _logs.append(entry)
    if len(_logs) > _MAX_LOG:
        _logs.pop(0)

    # Forward to Seq for centralized viewing
    source = entry.get("source", "extension")
    level_name = entry.get("level", "log")
    level = {
        "error": LogLevel.ERROR,
        "warn": LogLevel.WARNING,
        "log": LogLevel.INFORMATION,
        "info": LogLevel.INFORMATION,
        "debug": LogLevel.DEBUG,
    }.get(level_name, LogLevel.INFORMATION)

    _log.extension(
        source,
        entry.get("message", ""),
        level=level,
        status="failure" if level_name == "error" else "success",
    )
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
