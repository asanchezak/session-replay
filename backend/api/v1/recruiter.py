"""Recruiter (/talent) automation pipeline — manual/gated controls.

The auto-pipeline (new position → create project → search → save) intentionally
does NOT send messages. This router is the deliberate, human-initiated outreach
trigger for requirement B: bulk-message a job's saved Recruiter candidates; on the
run's completion the transition terminal hook records outreach_status=messaged in
Odoo (via /akcr/api/lead_outreach_update).
"""
import time

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from services.recruiter_pipeline_service import RecruiterPipelineService

router = APIRouter(prefix="/recruiter", tags=["recruiter"])

# Manual reply-scan trigger: the Odoo "Escanear respuestas" button sets this; the
# daemon's keepAliveTick polls it and runs an inbox scan on its next warm tick (so a
# reply can be picked up on-demand instead of waiting for the 45m autonomous cadence).
# In-memory (single backend process); a stale request after a restart is harmless.
_inbox_scan_requested_at: float = 0.0


class SendMessagesRequest(BaseModel):
    subject: str | None = None
    body: str | None = None
    # Gated: false (default) = compose + STOP for a snapshot preview (no real send);
    # true = actually send InMail. The Odoo wizard sends false first, then true.
    send: bool = False


class InboxReply(BaseModel):
    profile_url: str | None = None
    name: str | None = None


class InboxRepliesRequest(BaseModel):
    replies: list[InboxReply] = []


class RemoveCandidateRequest(BaseModel):
    job_id: str
    profile_url: str | None = None
    name: str | None = None
    project_url: str | None = None
    connector_id: str | None = None
    lead_id: str | int | None = None


@router.post("/leads/remove")
async def remove_candidate(
    req: RemoveCandidateRequest,
    db: AsyncSession = Depends(get_db),
):
    """Remove (= ARCHIVE) a single candidate from the job's LinkedIn project.

    Called by Odoo when a linkedin.lead is deleted (deferred two-phase delete):
    enqueues ONE daemon archive run that locates the candidate by NAME on the
    project pipeline, archives them, and VERIFIES they're gone. On confirmed
    removal the terminal hook deletes the Odoo lead (/akcr/api/lead_removed).
    Returns the run id (or skips if name/project can't be resolved).
    """
    svc = RecruiterPipelineService(db)
    run_id = await svc.remove_candidate(
        req.job_id,
        profile_url=req.profile_url,
        name=req.name,
        project_url=req.project_url,
        connector_id=req.connector_id,
        lead_id=req.lead_id,
    )
    await db.commit()
    if not run_id:
        return {
            "status": "skipped",
            "job_id": req.job_id,
            "reason": "missing candidate name or no project for this job",
        }
    return {"status": "queued", "job_id": req.job_id, "run_id": run_id}


@router.post("/jobs/{job_id}/send-messages")
async def send_messages(
    job_id: str,
    req: SendMessagesRequest | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Compose a templated bulk InMail to the job's ACTIVE project candidates. GATED:
    send=false (default) types everything + STOPS for a snapshot preview (no real
    send); send=true actually sends InMail + records outreach in Odoo. Creates a daemon
    run on the LinkedIn operator; returns its id (or skips if the job has no project).
    """
    svc = RecruiterPipelineService(db)
    run_id = await svc.send_messages(
        job_id,
        subject=(req.subject if req else None),
        body=(req.body if req else None),
        send=(req.send if req else False),
    )
    await db.commit()
    if not run_id:
        return {
            "status": "skipped",
            "job_id": job_id,
            "reason": "no project or no saved candidates for this job",
        }
    return {"status": "queued", "job_id": job_id, "run_id": run_id}


@router.post("/request-inbox-scan")
async def request_inbox_scan():
    """Ask the daemon to run an inbox reply-scan on its next warm tick (the Odoo
    'Escanear respuestas' button). Returns the request timestamp; the daemon compares
    it to its last scan and scans if newer — no waiting for the 45m autonomous cadence."""
    global _inbox_scan_requested_at
    _inbox_scan_requested_at = time.time()
    return {"ok": True, "requested_at": _inbox_scan_requested_at}


@router.get("/inbox-scan-requested")
async def inbox_scan_requested():
    """Polled by the daemon's keepAliveTick: the epoch-seconds of the last manual scan
    request (0 = none). The daemon scans when this is newer than its last scan."""
    return {"requested_at": _inbox_scan_requested_at}


@router.post("/inbox-replies")
async def inbox_replies(
    req: InboxRepliesRequest,
    db: AsyncSession = Depends(get_db),
):
    """Passive reply-scan ingress: the daemon's keepAliveTick scrapes the Recruiter
    inbox (read-only) and POSTs the candidates who replied to our outreach. For each,
    push an inbound-message marker to Odoo so the linkedin.lead flips to
    outreach_status='responded'. No run is created; idempotent on the Odoo side."""
    svc = RecruiterPipelineService(db)
    res = await svc.record_inbox_replies([r.model_dump() for r in req.replies])
    await db.commit()
    return res


@router.post("/jobs/{job_id}/demo")
async def run_demo(
    job_id: str,
    req: SendMessagesRequest | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Demo orchestration for the Odoo "Demo" button: reset the job's LinkedIn project
    to ONLY the demo profile (archive ALL → add the profile), then — if req.send —
    send the templated InMail to it. Chains via the terminal hook (archive-all looped
    until empty → add-profile → message). The Odoo lead reset to that profile is done
    in Odoo by the button itself before this call. Returns the first run id (queued),
    or skips if the job has no project."""
    svc = RecruiterPipelineService(db)
    run_id = await svc.start_demo(
        job_id,
        send=(req.send if req else False),
        subject=(req.subject if req else None),
        body=(req.body if req else None),
    )
    await db.commit()
    if not run_id:
        return {"status": "skipped", "job_id": job_id,
                "reason": "no project for this job or demo workflows unset"}
    return {"status": "queued", "job_id": job_id, "run_id": run_id,
            "send": (req.send if req else False)}


@router.post("/jobs/{job_id}/save-recommendations")
async def save_recommendations(
    job_id: str,
    count: int = 10,
    open_to_work: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """Add the job's project RECOMMENDED matches (LinkedIn Automated Sourcing → Recommended
    matches) to the pipeline — top `count` (default 10). `open_to_work=true` only adds
    candidates with the Open-to-work spotlight (quality filter; LinkedIn already ranks the
    rest by match). Fires a daemon run; the terminal hook pushes the added candidates to Odoo
    as linkedin.lead (with headline). Skips if the job has no project."""
    svc = RecruiterPipelineService(db)
    run_id = await svc.save_recommendations(job_id, count=count, require_open_to_work=open_to_work)
    await db.commit()
    if not run_id:
        return {"status": "skipped", "job_id": job_id,
                "reason": "no project for this job or recommendations workflow unset"}
    return {"status": "queued", "job_id": job_id, "run_id": run_id, "count": count}


@router.get("/jobs/{job_id}/pipeline")
async def pipeline_status(
    job_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Read-only one-shot summary of a job's pipeline: the chained runs (id/kind/
    status/priority), the boolean, per-search total_count, project URL, and the
    zero-result flag — so you don't have to poll /runs + pull snapshots."""
    svc = RecruiterPipelineService(db)
    return await svc.pipeline_status(job_id)


@router.post("/jobs/{job_id}/preview-count")
async def preview_count(
    job_id: str,
    tightness: int = 4,
    db: AsyncSession = Depends(get_db),
):
    """Cheap strictness calibration: build the JD boolean at `tightness` and fire a
    COUNT-ONLY search (no 30-candidate extract, no save, no lead push). Returns the
    run id + boolean; poll the run's extraction for total_count."""
    svc = RecruiterPipelineService(db)
    res = await svc.preview_count(job_id, tightness)
    await db.commit()
    return res
