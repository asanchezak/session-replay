"""Recruiter (/talent) automation pipeline — manual/gated controls.

The auto-pipeline (new position → create project → search → save) intentionally
does NOT send messages. This router is the deliberate, human-initiated outreach
trigger for requirement B: bulk-message a job's saved Recruiter candidates; on the
run's completion the transition terminal hook records outreach_status=messaged in
Odoo (via /akcr/api/lead_outreach_update).
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from services.recruiter_pipeline_service import RecruiterPipelineService

router = APIRouter(prefix="/recruiter", tags=["recruiter"])


class SendMessagesRequest(BaseModel):
    subject: str | None = None
    body: str | None = None
    # Gated: false (default) = compose + STOP for a snapshot preview (no real send);
    # true = actually send InMail. The Odoo wizard sends false first, then true.
    send: bool = False


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
