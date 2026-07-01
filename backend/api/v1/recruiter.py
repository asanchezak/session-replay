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
    # Single-send mode: when set, message ONLY this one candidate (the next uncontacted,
    # chosen by akcr from linkedin.lead.outreach_status) instead of the whole project.
    # Absent → the legacy bulk select-all behavior.
    target_profile_url: str | None = None
    target_name: str | None = None


class AddNoteRequest(BaseModel):
    # Defaults to "Contactado para <posición>" (from the job context) when omitted.
    note_text: str | None = None
    # Gated: false (default) = open the note composer + type + STOP for a snapshot preview
    # (no save); true = save the note AND move the candidates to the "contacted" stage.
    save: bool = False


class StartPipelineRequest(BaseModel):
    # MANUAL boolean override — the operator supplies the LinkedIn boolean text so the
    # pipeline runs without calling OpenAI (used when the AI is out of quota). Required.
    boolean_query: str
    # Optional location facet override (e.g. "Costa Rica"); else derived from the Odoo job.
    location: str | None = None


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


@router.post("/jobs/{job_id}/start-pipeline")
async def start_pipeline(
    job_id: str,
    req: StartPipelineRequest,
    db: AsyncSession = Depends(get_db),
):
    """Start the recruiter pipeline (create-project → search → save) for an existing job
    using a MANUALLY-supplied boolean — NO OpenAI call. For when the AI is out of quota:
    the operator passes the boolean text. Resolves the connector + job title automatically.
    Returns the create-project run id (or an error/skip reason)."""
    svc = RecruiterPipelineService(db)
    res = await svc.start_manual(job_id, boolean_query=req.boolean_query, location=req.location)
    await db.commit()
    return res


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
        target_profile_url=(req.target_profile_url if req else None),
        target_name=(req.target_name if req else None),
    )
    await db.commit()
    if not run_id:
        return {
            "status": "skipped",
            "job_id": job_id,
            "reason": "no project or no saved candidates for this job",
        }
    return {"status": "queued", "job_id": job_id, "run_id": run_id}


@router.post("/jobs/{job_id}/add-note")
async def add_note(
    job_id: str,
    req: AddNoteRequest | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Add a "Contactado para <posición>" NOTE to the job's ACTIVE project candidates
    (bulk) AND move them to the native "contacted" pipeline stage — the LinkedIn-side
    markers of "already contacted". GATED: save=false (default) opens the composer + types
    + STOPS for a snapshot preview (no save); save=true saves the note + moves the stage,
    then records outreach in the position chatter. Creates a daemon run on the LinkedIn
    operator; returns its id (or skips if the job has no project)."""
    svc = RecruiterPipelineService(db)
    run_id = await svc.add_note_to_candidates(
        job_id,
        note_text=(req.note_text if req else None),
        save=(req.save if req else False),
    )
    await db.commit()
    if not run_id:
        return {
            "status": "skipped",
            "job_id": job_id,
            "reason": "no project for this job or note workflow unset",
        }
    return {"status": "queued", "job_id": job_id, "run_id": run_id, "save": (req.save if req else False)}


class OdooNote(BaseModel):
    id: int | None = None
    body: str = ""
    position: str | None = None
    author: str | None = None


class SyncNotesRequest(BaseModel):
    profile_url: str
    candidate_id: int | None = None
    name: str | None = None
    connector_id: str | None = None
    # A LinkedIn project the candidate is in (akcr resolves it from the candidate's leads) —
    # the add-note UI lives in a project pipeline even though notes are global.
    project_url: str | None = None
    # The Odoo-authored notes not yet on LinkedIn (to PUSH). One daemon run per note.
    odoo_notes: list[OdooNote] = []


@router.post("/candidates/sync-notes")
async def sync_candidate_notes(
    req: SyncNotesRequest,
    db: AsyncSession = Depends(get_db),
):
    """Sync a candidate's GLOBAL notes with LinkedIn Recruiter (on-demand, candidate-
    centric). Enqueues ONE daemon run on the candidate's profile that ADDS the unsynced
    Odoo notes and READS LinkedIn's notes back; the terminal hook reconciles them in Odoo
    (/akcr/api/candidate_notes). Returns {status:'queued', run_id} or 'not_configured'
    until the Phase-2 notes strategy/workflow ships."""
    svc = RecruiterPipelineService(db)
    res = await svc.sync_candidate_notes(
        profile_url=req.profile_url,
        candidate_id=req.candidate_id,
        name=req.name,
        connector_id=req.connector_id,
        project_url=req.project_url,
        odoo_notes=[n.model_dump() for n in req.odoo_notes],
    )
    await db.commit()
    return res


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


@router.post("/jobs/{job_id}/reset")
async def reset_pipeline(job_id: str, db: AsyncSession = Depends(get_db)):
    """Reset orchestration for the Odoo "Reset & re-buscar" button: archive the WHOLE
    current LinkedIn project, then restart the sourcing pipeline from scratch (create a
    fresh project → AI boolean search from the current JD → save), as if the "search
    candidates" checkbox had just been ticked. Chains via the terminal hook. The Odoo
    linkedin.lead rows are hard-deleted in Odoo by the button before this call. Returns
    the first queued run id (the archive, or the create-project when there's no project
    to archive)."""
    svc = RecruiterPipelineService(db)
    res = await svc.reset_and_research(job_id)
    await db.commit()
    return res


@router.post("/jobs/{job_id}/save-recommendations")
async def save_recommendations(
    job_id: str,
    count: int = 6,
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


class PreviewCountRequest(BaseModel):
    # MANUAL boolean to count verbatim (NO AI) — iterate selectivity while OpenAI is down.
    boolean_query: str | None = None
    tightness: int = 4


@router.post("/jobs/{job_id}/preview-count")
async def preview_count(
    job_id: str,
    tightness: int = 4,
    req: PreviewCountRequest | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Cheap strictness calibration: COUNT-ONLY search (no 30-candidate extract, no save,
    no lead push). Either builds the JD boolean at `tightness` (AI) or, when the body
    carries `boolean_query`, counts that text verbatim with NO AI. Returns the run id +
    boolean; poll the run's extraction for total_count."""
    svc = RecruiterPipelineService(db)
    boolean_query = req.boolean_query if req else None
    t = (req.tightness if req and req.boolean_query is None else tightness)
    res = await svc.preview_count(job_id, t, boolean_query=boolean_query)
    await db.commit()
    return res
