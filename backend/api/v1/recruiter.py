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


@router.post("/jobs/{job_id}/send-messages")
async def send_messages(
    job_id: str,
    req: SendMessagesRequest | None = None,
    db: AsyncSession = Depends(get_db),
):
    """⚠️ SENDS real InMail. Bulk-messages the job's saved Recruiter candidates and
    records the outreach in Odoo when the run completes. Creates a daemon run on the
    LinkedIn operator; returns its id (or skips if the job has no project/candidates).
    """
    svc = RecruiterPipelineService(db)
    run_id = await svc.send_messages(
        job_id,
        subject=(req.subject if req else None),
        body=(req.body if req else None),
    )
    await db.commit()
    if not run_id:
        return {
            "status": "skipped",
            "job_id": job_id,
            "reason": "no project or no saved candidates for this job",
        }
    return {"status": "queued", "job_id": job_id, "run_id": run_id}
