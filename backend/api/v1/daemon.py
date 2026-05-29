from __future__ import annotations

import time
from datetime import UTC, datetime

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(prefix="/daemon", tags=["daemon"])

HEARTBEAT_TTL_SECONDS = 30.0
_heartbeats: dict[str, dict[str, object]] = {}


class DaemonHeartbeatRequest(BaseModel):
    worker_id: str = Field(min_length=1)
    polling: bool
    driving_run_id: str | None = None
    # Circuit-breaker state so operators can see "account in cooldown" remotely
    # instead of wondering why a trigger does nothing. The daemon already sends
    # circuit_open; reason/cooldown_until make the dashboard actionable.
    circuit_open: bool | None = None
    circuit_reason: str | None = None
    cooldown_until: str | None = None


def reset_heartbeat_state() -> None:
    _heartbeats.clear()


def _isoformat_utc(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).isoformat().replace("+00:00", "Z")


@router.post("/heartbeat")
async def heartbeat(payload: DaemonHeartbeatRequest):
    _heartbeats[payload.worker_id] = {
        "worker_id": payload.worker_id,
        "polling": payload.polling,
        "driving_run_id": payload.driving_run_id,
        "circuit_open": payload.circuit_open,
        "circuit_reason": payload.circuit_reason,
        "cooldown_until": payload.cooldown_until,
        "last_seen_ts": time.time(),
    }
    return {"ok": True}


@router.get("/status")
async def status():
    now = time.time()
    workers = []
    for state in sorted(
        _heartbeats.values(),
        key=lambda item: (float(item["last_seen_ts"]), str(item["worker_id"])),
        reverse=True,
    ):
        age_seconds = max(0.0, now - float(state["last_seen_ts"]))
        workers.append({
            "worker_id": state["worker_id"],
            "polling": bool(state["polling"]),
            "driving_run_id": state["driving_run_id"],
            "circuit_open": state.get("circuit_open"),
            "circuit_reason": state.get("circuit_reason"),
            "cooldown_until": state.get("cooldown_until"),
            "last_seen": _isoformat_utc(float(state["last_seen_ts"])),
            "age_seconds": round(age_seconds, 3),
            "up": age_seconds < HEARTBEAT_TTL_SECONDS,
        })

    return {
        "workers": workers,
        "any_up": any(worker["up"] for worker in workers),
        # True if any live worker reports its circuit open (account in cooldown).
        "circuit_open": any(
            bool(w.get("circuit_open")) for w in workers if w["up"]
        ),
    }
