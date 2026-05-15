from fastapi import APIRouter, Request

from services.log_service import LogLevel, get_logger

router = APIRouter(prefix="/logs", tags=["logs"])

_log = get_logger()


@router.post("/client")
async def frontend_log(entry: dict, request: Request):
    """Receive structured logs from the frontend web app."""
    layer = "frontend"
    component = entry.get("component", "unknown")
    action = entry.get("action", "unknown")
    level_name = entry.get("level", "info")
    level = {
        "verbose": LogLevel.VERBOSE,
        "debug": LogLevel.DEBUG,
        "info": LogLevel.INFORMATION,
        "warn": LogLevel.WARNING,
        "error": LogLevel.ERROR,
        "fatal": LogLevel.FATAL,
    }.get(level_name, LogLevel.INFORMATION)
    status = entry.get("status", "success")
    details = entry.get("details")
    elapsed_ms = entry.get("elapsed_ms")

    _log.log(layer, component, action, level, status, details, elapsed_ms)

    return {"ok": True}
