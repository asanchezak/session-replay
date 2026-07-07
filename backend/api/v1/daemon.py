from __future__ import annotations

import time
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.models.run import ExecutionRun
from core.state_machine import RunStatus

router = APIRouter(prefix="/daemon", tags=["daemon"])

HEARTBEAT_TTL_SECONDS = 30.0
_heartbeats: dict[str, dict[str, object]] = {}


def _live_heartbeats() -> list[dict]:
    """Heartbeats seen within the TTL window (i.e. the daemon is currently up)."""
    now = time.time()
    return [
        s for s in _heartbeats.values()
        if (now - float(s["last_seen_ts"])) < HEARTBEAT_TTL_SECONDS
    ]


def operator_online(operator_id: str) -> bool:
    """True if a non-stale daemon heartbeat exists for this operator. Used to tell
    'host offline' from 'host up but seat walled' (recovery-supervisor orphan
    requeue must NOT fire while the daemon may still be driving the run)."""
    return any(s.get("operator_id") == operator_id for s in _live_heartbeats())


def latest_seat_warm(operator_id: str) -> bool | None:
    """Freshest non-stale seat_warm reported by this operator's daemon. None if the
    operator has NO live heartbeat (host offline / unknown right after a backend
    restart). Callers treat None as 'seat unavailable' for queue-and-drain, but skip
    crying wolf when they can't distinguish offline from not-yet-reported."""
    live = [s for s in _live_heartbeats() if s.get("operator_id") == operator_id]
    if not live:
        return None
    newest = max(live, key=lambda s: float(s["last_seen_ts"]))
    val = newest.get("seat_warm")
    return val if isinstance(val, bool) else None


def _needs_seat(origin: dict) -> bool:
    """Mirror of the daemon's needsSeat() (daemon-behavior.mjs): a run that needs the
    warm /talent seat to execute. Recruiter pipeline flows + webhook/reconciler
    LinkedIn flows + profile-using daemon runs that aren't generic dashboard runs."""
    o = origin or {}
    k = str(o.get("event_kind") or "")
    if k in ("new_job_position", "linkedin_lead_search") or k.startswith("recruiter_"):
        return True
    if o.get("execution_target") == "daemon" and o.get("execution_mode") != "generic":
        return bool((o.get("execution_options") or {}).get("use_profile"))
    return False


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
    # Which operator owns this daemon (routing key). The dashboard shows it so an
    # operator can confirm THEIR daemon is up before "Run with daemon".
    operator_id: str | None = None
    # Recruiter /talent seat health from the daemon's last keepalive ping. Lets an
    # operator answer "is the seat walled?" via GET /daemon/status — a free read that
    # never drives the sensitive LinkedIn account. None = unknown / keepalive off.
    seat_warm: bool | None = None
    seat_checked_at: str | None = None


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
        "operator_id": payload.operator_id,
        "seat_warm": payload.seat_warm,
        "seat_checked_at": payload.seat_checked_at,
        "last_seen_ts": time.time(),
    }
    return {"ok": True}


@router.get("/status")
async def status(db: AsyncSession = Depends(get_db)):
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
            "operator_id": state.get("operator_id"),
            "polling": bool(state["polling"]),
            "driving_run_id": state["driving_run_id"],
            "circuit_open": state.get("circuit_open"),
            "circuit_reason": state.get("circuit_reason"),
            "cooldown_until": state.get("cooldown_until"),
            "seat_warm": state.get("seat_warm"),
            "seat_checked_at": state.get("seat_checked_at"),
            "last_seen": _isoformat_utc(float(state["last_seen_ts"])),
            "age_seconds": round(age_seconds, 3),
            "up": age_seconds < HEARTBEAT_TTL_SECONDS,
        })

    # Count QUEUED runs that need the warm /talent seat — the backlog held by the
    # daemon's seat gate while the seat is walled. Lets the dashboard show
    # "N run(s) waiting for warm seat" so a held backlog reads as waiting, not stuck.
    queued_seat_runs = 0
    try:
        result = await db.execute(
            select(ExecutionRun.origin).where(
                ExecutionRun.status == RunStatus.QUEUED.value
            )
        )
        queued_seat_runs = sum(
            1 for (origin,) in result.all() if _needs_seat(origin or {})
        )
    except Exception:
        queued_seat_runs = 0

    return {
        "workers": workers,
        "any_up": any(worker["up"] for worker in workers),
        # True if any live worker reports its circuit open (account in cooldown).
        "circuit_open": any(
            bool(w.get("circuit_open")) for w in workers if w["up"]
        ),
        "queued_seat_runs": queued_seat_runs,
    }
