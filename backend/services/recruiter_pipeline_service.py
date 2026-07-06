"""Recruiter (/talent) automation pipeline — the Odoo→LinkedIn loop orchestrator.

On a new Odoo job position (linkedin_sync + published), this chains the promoted
Recruiter sub-workflows as a sequence of daemon runs, threading the pipeline
context through each run's `origin.pipeline`:

    start()                         create -EZ <position> project   (event recruiter_create_project)
      └─ on COMPLETED → advance() ─ push project URL to hr.job + fire search   (recruiter_search)
           └─ on COMPLETED → advance() ─ push candidates as linkedin.lead
                                         + fan out one save-to-project run per
                                         candidate (recruiter_save)
                └─ on COMPLETED → advance() ─ terminal. (Message-send stays MANUAL/gated.)

Each step is one daemon run (execution_target=daemon, pinned to the LinkedIn
operator, use_profile=true for the warm /talent seat). advance() is invoked by
ExecutionService.transition's terminal hook when a pipeline run COMPLETES, in a
fresh session (commit-before-await rule). The Odoo write-backs go through
RecruiterPushService; this service owns only the orchestration/chaining.

See docs/recruiter-odoo-integration-design.md for the full contract.
"""
from __future__ import annotations

import json
import logging
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from core.config import settings
from core.models.run import ExecutionRun
from core.state_machine import RunStatus
from services.execution_service import ExecutionService
from services.recruiter_push_service import RecruiterPushService

logger = logging.getLogger(__name__)

EVENT_CREATE_PROJECT = "recruiter_create_project"
EVENT_SEARCH = "recruiter_search"
EVENT_SAVE = "recruiter_save"
EVENT_MESSAGE = "recruiter_message"
EVENT_ARCHIVE = "recruiter_archive"
EVENT_RECOMMENDATIONS = "recruiter_recommendations"
# Add a "Contactado para <posición>" NOTE (bulk) + move to the native "contacted" stage.
# Standalone (POST .../add-note + Odoo button) and chained after a real message send.
EVENT_NOTE = "recruiter_note"
# Sync a candidate's GLOBAL notes with LinkedIn (read + add on the profile notes panel).
# Standalone, candidate-centric (POST .../candidates/sync-notes + Odoo candidate button).
EVENT_NOTES_SYNC = "recruiter_notes_sync"
# DEMO button chain (Odoo "Demo"): reset the project to ONLY the demo profile, then
# optionally message it. archive-all (looped) → add-profile → (send → recruiter_message).
EVENT_DEMO_ARCHIVE = "recruiter_demo_archive"
EVENT_DEMO_ADD = "recruiter_demo_add"
# RESET button chain (Odoo "Reset & re-buscar"): archive the WHOLE LinkedIn project, then
# restart the sourcing pipeline from scratch (create project → search → save), as if the
# "search candidates" checkbox had just been ticked. archive-project → start().
EVENT_RESET_ARCHIVE = "recruiter_reset_archive"
PIPELINE_EVENT_KINDS = {
    EVENT_CREATE_PROJECT, EVENT_SEARCH, EVENT_SAVE, EVENT_MESSAGE, EVENT_ARCHIVE,
    EVENT_RECOMMENDATIONS, EVENT_NOTE, EVENT_NOTES_SYNC, EVENT_DEMO_ARCHIVE, EVENT_DEMO_ADD,
    EVENT_RESET_ARCHIVE,
}

# Recruiter event kinds whose FAILURE should NOT raise a position-level alarm in Odoo:
# the demo chain (a deliberate test tool) and the cheap count-only preview probe.
SILENT_FLOW_EVENT_KINDS = {EVENT_DEMO_ARCHIVE, EVENT_DEMO_ADD, EVENT_NOTES_SYNC,
                           "recruiter_preview_count"}

# Human-readable stage labels for the Odoo chatter note / status field (English, to
# match the recruiter UI).
_FLOW_STAGE_LABELS = {
    EVENT_CREATE_PROJECT: "create project",
    EVENT_SEARCH: "candidate search",
    EVENT_SAVE: "save candidates",
    EVENT_MESSAGE: "message",
    EVENT_ARCHIVE: "archive candidate",
    EVENT_RECOMMENDATIONS: "add recommended",
    EVENT_NOTE: "add contact note",
    EVENT_RESET_ARCHIVE: "reset (archive project)",
}

_NON_TERMINAL = (
    RunStatus.QUEUED.value,
    RunStatus.RUNNING.value,
    RunStatus.WAITING_FOR_USER.value,
    RunStatus.RECOVERING.value,
)
_PROJECT_URL_RE = re.compile(r"/talent/hire/(\d+)")
# Prefix marking projects this automation created (so they're findable/cleanable).
PROJECT_NAME_PREFIX = "EasyRecruit - "
# Max chars to type into the LinkedIn project "Descripción del proyecto" textarea.
_PROJECT_DESC_MAX = 2000
# Default outreach copy for req B (send_messages); overridable per call.
DEFAULT_MESSAGE_SUBJECT = "Opportunity at AKUREY"
DEFAULT_MESSAGE_BODY = (
    "Hi {Name},\n\n"
    "I'm reaching out from AKUREY — your profile really caught our attention for an "
    "opening we currently have. If you're interested, we'd love to connect and tell "
    "you more about the role. I look forward to hearing from you!"
)
# "Add contact note" copy; overridable per call. The note records WHAT position they were
# contacted for, WHO contacted them (the automation, by default), and a deep-link back to
# the Odoo position — composed in _default_note_text from the job context + connector URL.
DEFAULT_NOTE_PREFIX = "Contacted - "
DEFAULT_CONTACTED_BY = "Automation"


class RecruiterPipelineService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.exec_svc = ExecutionService(session)
        self.push = RecruiterPushService(session)

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def position_from_payload(job_payload: dict) -> str:
        return str(
            job_payload.get("job_title")
            or job_payload.get("name")
            or job_payload.get("title")
            or ""
        ).strip()

    @staticmethod
    def _project_name(position: str) -> str:
        return f"{PROJECT_NAME_PREFIX}{position}".strip()

    async def _create_pipeline_run(
        self, *, workflow_id: str, event_kind: str, runtime_params: dict,
        pipeline: dict, connector_id, priority: int = 10,
    ) -> ExecutionRun:
        """Create a QUEUED daemon run for the next pipeline step.

        Mirrors WebhookTriggerService._fire's origin shape but for the generic
        daemon path: execution_target=daemon + target_operator=linkedin_operator
        (so the daemon claims it) + use_profile (the warm Recruiter seat).
        runtime_params are substituted into the snapshot by create_run.

        `priority` lands in origin.priority — the daemon claims higher-priority runs
        first (FIFO within a priority). Pipeline/message steps default to +10; bulk
        cleanup (deferred-removal archive) passes a low value so a flood of removals
        can't starve an interactive run.
        """
        run = await self.exec_svc.create_run(
            workflow_id=workflow_id, runtime_params=runtime_params
        )
        run.origin = {
            "connector_id": str(connector_id) if connector_id else None,
            "event_kind": event_kind,
            "execution_target": "daemon",
            "execution_mode": (run.workflow_snapshot or {}).get("workflow", {}).get(
                "execution_mode"
            ),
            "execution_options": {"use_profile": True, "snapshot": True},
            "operator_id": settings.linkedin_operator,
            "target_operator": settings.linkedin_operator,
            "priority": priority,
            "runtime_params": runtime_params,
            "pipeline": pipeline,
            # Keep a job_payload so the existing push paths that read
            # origin.job_payload.job_id keep working if ever reused.
            "job_payload": pipeline.get("job_payload")
            or {"job_id": pipeline.get("job_id")},
        }
        flag_modified(run, "origin")
        await self.session.flush()
        return run

    async def _has_active_pipeline_run(self, job_id, event_kinds=None) -> bool:
        """Avoid duplicate concurrent runs for the same position. Scans recent
        non-terminal runs (origin is JSON → filter in Python; rare event). By default
        matches any pipeline stage; pass `event_kinds` to scope to specific stages
        (e.g. {EVENT_RECOMMENDATIONS} to dedup just recommendation runs)."""
        kinds = event_kinds or PIPELINE_EVENT_KINDS
        result = await self.session.execute(
            select(ExecutionRun)
            .where(ExecutionRun.status.in_(_NON_TERMINAL))
            .order_by(ExecutionRun.created_at.desc())
            .limit(300)
        )
        for r in result.scalars().all():
            o = r.origin or {}
            if o.get("event_kind") in kinds:
                if str((o.get("pipeline") or {}).get("job_id")) == str(job_id):
                    return True
        return False

    # ------------------------------------------------------------- flow status
    @staticmethod
    def _flow_stage_label(event_kind: str | None) -> str:
        return _FLOW_STAGE_LABELS.get(event_kind or "", (event_kind or "").replace("recruiter_", ""))

    @staticmethod
    def _classify_flow_error(error_summary: str | None) -> str:
        """Bucket a failure reason for the Odoo note: walled_seat (login/checkpoint/
        captcha wall) vs timeout (watchdog) vs a generic error."""
        s = (error_summary or "").lower()
        if any(t in s for t in ("checkpoint", "captcha", "login", "blocker", "walled")):
            return "walled_seat"
        if any(t in s for t in ("timeout", "watchdog", "timed out")):
            return "timeout"
        return "error"

    async def _push_flow_status(self, *, job_id, connector_id, status: str,
                                event_kind: str = "", error_summary: str = "",
                                message: str = "", run_id=None) -> dict:
        """Best-effort: surface a lifecycle status (running/done/failed) on the Odoo
        position. `message` is a human, descriptive note (e.g. "Searching for
        candidates…") posted to the chatter for running/done. No-op (logged) when
        job_id/connector are missing."""
        if not job_id or not connector_id:
            return {"skipped": "no_job_or_connector"}
        return await self.push.push_flow_status(
            connector_id=connector_id, job_id=job_id, status=status,
            stage=self._flow_stage_label(event_kind),
            error_kind=self._classify_flow_error(error_summary) if status == "failed" else "",
            error_summary=error_summary or "", message=message or "", run_id=run_id,
        )

    async def notify_failure(self, run: ExecutionRun) -> dict:
        """Called from the terminal hook when a recruiter_* run FAILS → mark the Odoo
        position 'failed' (chatter note + recruiter to-do). Skips the demo/preview
        event kinds (test tooling, not a real flow)."""
        origin = run.origin or {}
        event_kind = origin.get("event_kind") or ""
        if event_kind in SILENT_FLOW_EVENT_KINDS:
            return {"skipped": "silent_event_kind", "event_kind": event_kind}
        pipeline = origin.get("pipeline") or {}
        job_id = pipeline.get("job_id") or origin.get("job_id")
        connector_id = pipeline.get("connector_id") or origin.get("connector_id")
        return await self._push_flow_status(
            job_id=job_id, connector_id=connector_id, status="failed",
            event_kind=event_kind, error_summary=run.error_summary or "", run_id=run.id,
        )

    # -------------------------------------------------------------------- start
    async def start(self, connector_id, job_payload: dict, *,
                    boolean_query: str | None = None,
                    location: str | None = None) -> str | None:
        """Kick off the pipeline for a new position: create the -EZ project run.

        `boolean_query` (optional) is a MANUAL boolean override — when given, the AI
        extraction is skipped entirely (used when OpenAI is unavailable / out of quota:
        the operator supplies the boolean text). `location` optionally overrides the
        search location facet (else derived from the Odoo job_location)."""
        position = self.position_from_payload(job_payload)
        job_id = str(job_payload.get("job_id") or job_payload.get("id") or "")
        if not position or not job_id:
            logger.warning(
                "recruiter pipeline: missing position/job_id (job_id=%s position=%r) — skip",
                job_id, position,
            )
            return None
        wf = settings.recruiter_create_project_workflow_id
        if not wf:
            logger.warning(
                "recruiter pipeline: recruiter_create_project_workflow_id unset — skip"
            )
            return None
        if await self._has_active_pipeline_run(job_id):
            logger.info(
                "recruiter pipeline: an active pipeline already exists for job %s — skip",
                job_id,
            )
            return None
        try:
            candidate_count = int(job_payload.get("candidate_count") or 0) or None
        except (TypeError, ValueError):
            candidate_count = None
        # The Odoo job sections → the LinkedIn project's "Descripción del proyecto"
        # textarea. Compose all structured sections (What you will be doing +
        # Requirements + Nice-to-have) so the project mirrors the full JD; fall back to
        # the webhook's plain job_description if the Odoo fetch fails. Capped so we
        # don't overflow the textarea on very long JDs.
        job_description = await self._compose_project_description(
            job_id, connector_id,
            fallback=str(job_payload.get("job_description") or "").strip(),
        )
        if len(job_description) > _PROJECT_DESC_MAX:
            job_description = job_description[:_PROJECT_DESC_MAX].rsplit(" ", 1)[0].rstrip() + "…"
        pipeline = {
            "job_id": job_id,
            "connector_id": str(connector_id) if connector_id else None,
            "position": position,
            "project_name": self._project_name(position),
            "candidate_count": candidate_count,
            "job_payload": job_payload,
        }
        # Build the JD boolean UP FRONT (it needs the AI). If the AI is unavailable
        # (e.g. OpenAI insufficient_quota / 429), FAIL the pipeline now — before creating
        # the LinkedIn project or touching the seat — instead of running a degraded
        # title-only search. The built boolean is stashed for the search step to reuse
        # (one AI call). Only when the advanced (boolean) search is configured.
        if settings.recruiter_advanced_search_workflow_id:
            if boolean_query and boolean_query.strip():
                # MANUAL override — skip the AI entirely (e.g. OpenAI out of quota). Still
                # fetch the location facet from Odoo (no AI). tightness=None disables the
                # calibration reruns (the operator's boolean is used verbatim).
                try:
                    _, _, job_location = await self._fetch_job_corpus(job_id, connector_id)
                except Exception:
                    job_location = ""
                if location is not None:
                    job_location = location
                pipeline["search_spec"] = {}
                pipeline["search_tightness"] = None
                pipeline["search_query"] = boolean_query.strip()
                pipeline["search_reruns"] = 0
                pipeline["search_manual"] = True
                pipeline["job_location"] = job_location
                logger.info(
                    "recruiter pipeline: MANUAL boolean for job %s (location=%r): %s",
                    job_id, job_location, boolean_query.strip(),
                )
            else:
                from services.boolean_query_builder import BooleanBuildError, BooleanQueryBuilder
                corpus, title, job_location = await self._fetch_job_corpus(job_id, connector_id)
                try:
                    built = await BooleanQueryBuilder().build(
                        corpus, fallback_title=title or position,
                        start_tightness=settings.recruiter_search_start_tightness,
                        location=job_location,
                    )
                except BooleanBuildError as exc:
                    logger.error(
                        "recruiter pipeline: boolean build failed for job %s — NOT starting "
                        "(no project created): %s", job_id, exc,
                    )
                    await self._push_flow_status(
                        job_id=job_id, connector_id=connector_id, status="failed",
                        event_kind=EVENT_CREATE_PROJECT, error_summary=str(exc),
                        message="❌ Couldn't build the boolean search: the AI is unavailable "
                                "(no OpenAI quota). Process stopped — the project was not "
                                "created and the search did not run. Retry when quota is "
                                "available.",
                    )
                    return None
                if location is not None:
                    job_location = location
                pipeline["search_spec"] = built["spec"]
                pipeline["search_tightness"] = built["tightness"]
                pipeline["search_query"] = built["query"]
                pipeline["search_reruns"] = 0
                pipeline["job_location"] = job_location
                logger.info(
                    "recruiter pipeline: prebuilt boolean for job %s (t=%s): %s",
                    job_id, built["tightness"], built["query"],
                )
        run = await self._create_pipeline_run(
            workflow_id=wf,
            event_kind=EVENT_CREATE_PROJECT,
            runtime_params={"position": position, "job_description": job_description},
            pipeline=pipeline,
            connector_id=connector_id,
        )
        logger.info(
            "recruiter pipeline: started create-project run %s for job %s (%r)",
            run.id, job_id, position,
        )
        await self._push_flow_status(
            job_id=job_id, connector_id=connector_id, status="running",
            event_kind=EVENT_CREATE_PROJECT, run_id=run.id,
            message="🛠️ Creating the LinkedIn Recruiter project for this position…",
        )
        return str(run.id)

    async def start_manual(self, job_id, boolean_query: str,
                           location: str | None = None) -> dict:
        """Start the pipeline for an existing job with a MANUALLY-supplied boolean (no AI).
        Resolves the connector + job title from prior runs / Odoo, then calls start().
        Used when OpenAI is unavailable: the operator provides the boolean text. Returns
        {run_id} or {skipped/error}."""
        if not boolean_query or not boolean_query.strip():
            return {"error": "boolean_query is required"}
        job_id = str(job_id)
        ctx = await self._gather_job_context(job_id)
        connector_id = ctx.get("connector_id") or await self._latest_recruiter_connector()
        if not connector_id:
            return {"error": "could not resolve a connector for this job"}
        # Title for the project name / position — prefer Odoo (no AI), fall back to prior runs.
        title = ""
        try:
            _, title, _ = await self._fetch_job_corpus(job_id, connector_id)
        except Exception:
            pass
        position = title or ctx.get("position") or ""
        if not position:
            return {"error": "could not resolve the job title/position"}
        if await self._has_active_pipeline_run(job_id):
            return {"skipped": "active pipeline run already exists for this job"}
        job_payload = {"job_id": job_id, "name": position, "job_title": position}
        run_id = await self.start(
            connector_id, job_payload, boolean_query=boolean_query, location=location,
        )
        if not run_id:
            return {"error": "pipeline did not start (see logs)"}
        return {"run_id": run_id, "boolean": boolean_query.strip(), "position": position}

    # ------------------------------------------------------------------ advance
    async def advance(self, run: ExecutionRun) -> dict:
        """Called from the terminal hook when a pipeline run COMPLETES."""
        origin = run.origin or {}
        event_kind = origin.get("event_kind")
        pipeline = dict(origin.get("pipeline") or {})
        connector_id = pipeline.get("connector_id") or origin.get("connector_id")
        job_id = pipeline.get("job_id")

        if event_kind == EVENT_CREATE_PROJECT:
            return await self._after_create_project(run, pipeline, connector_id, job_id)
        if event_kind == EVENT_SEARCH:
            return await self._after_search(run, pipeline, connector_id, job_id)
        if event_kind == EVENT_SAVE:
            # Terminal success of the sourcing chain: candidates are verified in the
            # project (the per-stage gate fails this run otherwise). Message-send is
            # manual/gated. Mark the position DONE with a wrap-up note.
            logger.info(
                "recruiter pipeline: save complete for job %s candidate %s",
                job_id, pipeline.get("candidate_url"),
            )
            await self._push_flow_status(
                job_id=job_id, connector_id=connector_id, status="done",
                event_kind=EVENT_SAVE, run_id=run.id,
                message="✅ Sourcing complete — candidates saved to the LinkedIn project.",
            )
            return {"stage": "save", "done": True}
        if event_kind == EVENT_MESSAGE:
            return await self._after_message(run, pipeline, connector_id, job_id)
        if event_kind == EVENT_ARCHIVE:
            return await self._after_archive(run, pipeline, connector_id, job_id)
        if event_kind == EVENT_RECOMMENDATIONS:
            return await self._after_recommendations(run, pipeline, connector_id, job_id)
        if event_kind == EVENT_NOTE:
            return await self._after_note(run, pipeline, connector_id, job_id)
        if event_kind == EVENT_NOTES_SYNC:
            return await self._after_notes_sync(run, pipeline, connector_id, job_id)
        if event_kind == EVENT_DEMO_ARCHIVE:
            return await self._after_demo_archive(run, pipeline, connector_id, job_id)
        if event_kind == EVENT_DEMO_ADD:
            return await self._after_demo_add(run, pipeline, connector_id, job_id)
        if event_kind == EVENT_RESET_ARCHIVE:
            return await self._after_reset_archive(run, pipeline, connector_id, job_id)
        return {"skipped": "unknown_event_kind", "event_kind": event_kind}

    async def _after_recommendations(self, run, pipeline, connector_id, job_id) -> dict:
        """Terminal hook: the recommended matches were added to the LinkedIn project —
        push them to Odoo as linkedin.lead (the strategy posted them under `people`, so
        the SAME collector as search→save ingests them). If LinkedIn had no new
        recommendations to add (an EXPECTED empty outcome), just post a soft note — it's
        not a failure and shouldn't push leads."""
        rec: dict = {}
        try:
            for row in await self.push._extraction_rows(run.id):
                v = row.get("save_recommendations_result")
                if isinstance(v, dict):
                    rec = v
        except Exception:  # noqa: BLE001
            logger.debug("recommendations hook: no extraction for run %s", run.id, exc_info=True)
        if rec.get("no_recommendations") or rec.get("reason") == "no_recommendations":
            await self._push_flow_status(
                job_id=job_id, connector_id=connector_id, status="done",
                event_kind=EVENT_RECOMMENDATIONS, run_id=run.id,
                message="✨ No new recommendations right now — LinkedIn didn't suggest more candidates for this position.",
            )
            return {"stage": "recommendations", "done": True, "no_recommendations": True, "leads": 0}
        lead_res = await self.push.push_recruiter_leads(
            run_id=run.id, job_id=job_id, connector_id=connector_id,
            source="recommendation",
        )
        logger.info(
            "recruiter pipeline: recommendations for job %s → pushed %s lead(s)",
            job_id, lead_res.get("pushed"),
        )
        n_added = len(lead_res.get("leads") or [])
        await self._push_flow_status(
            job_id=job_id, connector_id=connector_id, status="done",
            event_kind=EVENT_RECOMMENDATIONS, run_id=run.id,
            message=f"✨ Added {n_added} recommended candidate(s) to the project.",
        )
        return {"stage": "recommendations", "done": True,
                "pushed": lead_res.get("pushed"), "leads": n_added}

    # ----------------------------------------------------------------- demo button
    async def start_demo(self, job_id, *, send: bool = False,
                         subject: str | None = None, body: str | None = None) -> str | None:
        """Odoo "Demo" button orchestration: reset the job's LinkedIn project to ONLY
        the demo profile, then optionally send the templated InMail. Chains entirely via
        the terminal hook (no in-process polling): archive-all (LOOPED until the project
        is empty) → add the demo profile → (send ? recruiter_message : stop). The Odoo
        linkedin.lead reset to that profile is done IN Odoo by the akcr button BEFORE
        this call, so no Odoo write-back happens here. Returns the first run id (or None
        if the job has no project / the demo workflows are unset)."""
        arch_wf = settings.recruiter_archive_all_workflow_id
        add_wf = settings.recruiter_add_profile_workflow_id
        if not arch_wf or not add_wf:
            logger.warning("recruiter demo: archive-all/add-profile workflow id unset — skip")
            return None
        ctx = await self._gather_job_context(job_id)
        project_id = ctx.get("project_id")
        if not project_id:
            logger.warning("recruiter demo: no project for job %s — skip", job_id)
            return None
        project_url = f"https://www.linkedin.com/talent/hire/{project_id}/manage/all"
        pipeline = {
            "job_id": str(job_id),
            "connector_id": ctx.get("connector_id"),
            "project_id": project_id,
            "project_url": project_url,
            "project_name": ctx.get("project_name"),
            "profile_url": settings.recruiter_demo_profile_url,
            "profile_name": settings.recruiter_demo_profile_name,
            "send": bool(send),
            "subject": (subject or DEFAULT_MESSAGE_SUBJECT).strip(),
            "body": (body or DEFAULT_MESSAGE_BODY).strip(),
            "archive_rounds": 0,
        }
        run = await self._create_pipeline_run(
            workflow_id=arch_wf, event_kind=EVENT_DEMO_ARCHIVE,
            runtime_params={"project_url": project_url},
            pipeline=pipeline, connector_id=ctx.get("connector_id"),
        )
        logger.info(
            "recruiter demo: started archive-all run %s for job %s (send=%s)",
            run.id, job_id, send,
        )
        return str(run.id)

    async def _after_demo_archive(self, run, pipeline, connector_id, job_id) -> dict:
        """Demo: an archive-all pass completed. Re-enqueue another pass while the
        project still has ACTIVE candidates and we're under the round cap (archive-all
        clears ~15-25 per 175s run); once empty (or capped), add the demo profile."""
        res = await self.push.read_archive_all_result(run.id)
        more = bool(res.get("more_remaining"))
        active_after = res.get("active_after")
        rounds = int(pipeline.get("archive_rounds") or 0) + 1
        cap = settings.recruiter_demo_archive_rounds
        if more and rounds < cap and (active_after is None or active_after > 0):
            nxt = dict(pipeline)
            nxt["archive_rounds"] = rounds
            r = await self._create_pipeline_run(
                workflow_id=settings.recruiter_archive_all_workflow_id,
                event_kind=EVENT_DEMO_ARCHIVE,
                runtime_params={"project_url": pipeline["project_url"]},
                pipeline=nxt, connector_id=connector_id,
            )
            logger.info(
                "recruiter demo: archive round %d (active_after=%s, more=%s) → another pass %s",
                rounds, active_after, more, r.id,
            )
            return {"stage": "demo_archive", "round": rounds,
                    "active_after": active_after, "next_run": str(r.id)}
        add_run = await self._create_pipeline_run(
            workflow_id=settings.recruiter_add_profile_workflow_id,
            event_kind=EVENT_DEMO_ADD,
            runtime_params={
                "candidate_url": pipeline["profile_url"],
                "project_name": pipeline.get("project_name") or "",
                "project_url": pipeline["project_url"],
            },
            pipeline=pipeline, connector_id=connector_id,
        )
        logger.info(
            "recruiter demo: project cleared (active_after=%s, rounds=%d) → add %s → run %s",
            active_after, rounds, pipeline["profile_url"], add_run.id,
        )
        return {"stage": "demo_archive", "cleared": True, "rounds": rounds,
                "next_run": str(add_run.id)}

    async def _after_demo_add(self, run, pipeline, connector_id, job_id) -> dict:
        """Demo: the demo profile was added to the (now empty) project. If send was
        requested, fire the templated message run (send=true) — the existing
        _after_message marks the Odoo lead messaged. Otherwise stop (preview-less)."""
        if not pipeline.get("send"):
            logger.info(
                "recruiter demo: profile added for job %s — no send requested (done)", job_id
            )
            return {"stage": "demo_add", "done": True, "sent": False}
        msg_run = await self.send_messages(
            job_id, subject=pipeline.get("subject"), body=pipeline.get("body"), send=True,
        )
        logger.info(
            "recruiter demo: profile added → message-send run %s (job %s)", msg_run, job_id
        )
        return {"stage": "demo_add", "next_run": msg_run, "sent": bool(msg_run)}

    # ---------------------------------------------------------------- reset button
    async def reset_and_research(self, job_id) -> dict:
        """Odoo "Reset & re-buscar" button: wipe the LinkedIn side and re-run sourcing
        from scratch. Chains via the terminal hook (no polling): archive the WHOLE
        current project → start() the normal pipeline (create a fresh project → AI
        boolean search from the current JD → save). The Odoo linkedin.lead rows are
        hard-deleted authoritatively by the backend in _after_reset_archive (once the
        project is archived, before repopulation) via POST /akcr/api/reset_leads — NOT by
        the button (whose delete is skipped while a run is active). Returns {run_id} or
        {skipped/error}.

        Falls back to starting the pipeline directly (no archive) when the job has no
        known project or the archive-project workflow is unconfigured."""
        job_id = str(job_id)
        ctx = await self._gather_job_context(job_id)
        connector_id = ctx.get("connector_id") or await self._latest_recruiter_connector()
        if not connector_id:
            return {"error": "could not resolve a connector for this job"}
        # Title for the project name / position — prefer Odoo (no AI), fall back to context.
        position = ""
        try:
            _, title, _ = await self._fetch_job_corpus(job_id, connector_id)
            position = title or ""
        except Exception:  # noqa: BLE001
            pass
        position = position or ctx.get("position") or ""
        if not position:
            return {"error": "could not resolve the job title/position"}
        if await self._has_active_pipeline_run(job_id):
            return {"skipped": "active pipeline run already exists for this job"}
        job_payload = {"job_id": job_id, "name": position, "job_title": position}

        project_url = ctx.get("project_url")
        if not project_url and ctx.get("project_id"):
            project_url = (
                f"https://www.linkedin.com/talent/hire/{ctx['project_id']}/manage/all"
            )
        arch_wf = settings.recruiter_archive_project_workflow_id
        if project_url and arch_wf:
            pipeline = {
                "job_id": job_id,
                "connector_id": connector_id,
                "position": position,
                "project_url": project_url,
                "project_name": ctx.get("project_name"),
                "job_payload": job_payload,
            }
            run = await self._create_pipeline_run(
                workflow_id=arch_wf, event_kind=EVENT_RESET_ARCHIVE,
                runtime_params={
                    "project_url": project_url,
                    "project_name": ctx.get("project_name") or "",
                },
                pipeline=pipeline, connector_id=connector_id,
            )
            await self._push_flow_status(
                job_id=job_id, connector_id=connector_id, status="running",
                event_kind=EVENT_RESET_ARCHIVE, run_id=run.id,
                message="🔄 Reset: archiving the current LinkedIn project…",
            )
            logger.info(
                "recruiter reset: archiving project for job %s → run %s", job_id, run.id
            )
            return {"run_id": str(run.id), "stage": "reset_archive", "position": position}

        # No project to archive (or archive workflow unset) → just (re)start the pipeline.
        logger.info(
            "recruiter reset: no project to archive for job %s (project_url=%r, wf=%r) "
            "— starting pipeline directly", job_id, project_url, bool(arch_wf),
        )
        run_id = await self.start(connector_id, job_payload)
        if not run_id:
            return {"error": "pipeline did not start (see logs)"}
        return {"run_id": run_id, "stage": "create_project", "position": position}

    async def _after_reset_archive(self, run, pipeline, connector_id, job_id) -> dict:
        """Reset: the whole project was archived — WIPE the job's Odoo leads to match the
        now-empty project, then restart the normal sourcing pipeline (create a fresh
        project → search → save). The archive run is already terminal (COMPLETED) by the
        time this fresh-session hook runs, so start()'s own _has_active_pipeline_run guard
        passes.

        The lead wipe is authoritative here (NOT in the Odoo reset button, whose delete is
        skipped whenever a run is active): it runs only once the project is genuinely
        archived and strictly BEFORE start() repopulates, so we never wipe fresh leads and
        never wipe a reset that didn't proceed. Best-effort — a wipe failure must not block
        the restart."""
        wipe = {}
        try:
            wipe = await self.push.push_reset_leads(
                run_id=run.id, job_id=job_id, connector_id=connector_id,
            )
        except Exception:  # noqa: BLE001 — wipe is best-effort; never block the restart
            logger.exception("recruiter reset: lead wipe failed (job %s)", job_id)
        # Only claim a removal count when the wipe actually reported one (honest chatter).
        deleted = wipe.get("deleted") if isinstance(wipe, dict) else None
        if isinstance(deleted, int):
            await self._push_flow_status(
                job_id=job_id, connector_id=connector_id, status="running",
                event_kind=EVENT_RESET_ARCHIVE, run_id=run.id,
                message=f"🔄 Reset: removed {deleted} old lead(s) in Odoo; re-searching…",
            )
        job_payload = pipeline.get("job_payload") or {"job_id": job_id}
        run_id = await self.start(connector_id, job_payload)
        logger.info(
            "recruiter reset: project archived for job %s → wiped=%s → restart run %s",
            job_id, deleted, run_id,
        )
        return {"stage": "reset_archive", "wiped": deleted,
                "restarted": bool(run_id), "next_run": run_id}

    async def _after_create_project(self, run, pipeline, connector_id, job_id) -> dict:
        # Requirement C: push the new project URL to hr.job.recruiter_project_url.
        link_res = await self.push.push_project_link(
            run_id=run.id, job_id=job_id, connector_id=connector_id
        )
        project_url = link_res.get("project_url")
        if project_url:
            pipeline["project_url"] = project_url
            m = _PROJECT_URL_RE.search(project_url)
            pipeline["project_id"] = m.group(1) if m else None

        # Prefer the BOOLEAN advanced search built from the JD content; fall back to
        # the legacy title-only Copilot search when not configured.
        adv_wf = settings.recruiter_advanced_search_workflow_id
        if adv_wf:
            # The boolean is normally prebuilt at pipeline start() (so an AI/quota
            # failure aborts BEFORE the project is created). Reuse it. Only build here as
            # a fallback for pipelines started before this path existed / relaunches with
            # no stash — and there too, FAIL (never run a title-only search) if the AI is
            # unavailable.
            if pipeline.get("search_query"):
                query = pipeline["search_query"]
                job_location = pipeline.get("job_location") or ""
                tightness = pipeline.get("search_tightness")
            else:
                from services.boolean_query_builder import BooleanBuildError, BooleanQueryBuilder
                corpus, title, job_location = await self._fetch_job_corpus(job_id, connector_id)
                try:
                    built = await BooleanQueryBuilder().build(
                        corpus, fallback_title=title or pipeline.get("position", ""),
                        start_tightness=settings.recruiter_search_start_tightness,
                        location=job_location,
                    )
                except BooleanBuildError as exc:
                    logger.error(
                        "recruiter pipeline: boolean build failed for job %s — search NOT "
                        "started: %s", job_id, exc,
                    )
                    await self._push_flow_status(
                        job_id=job_id, connector_id=connector_id, status="failed",
                        event_kind=EVENT_SEARCH, error_summary=str(exc),
                        message="❌ Couldn't build the boolean search: the AI is unavailable "
                                "(no OpenAI quota). Search not run.",
                    )
                    return {"stage": "create_project", "boolean_failed": True}
                pipeline["search_spec"] = built["spec"]
                pipeline["search_tightness"] = built["tightness"]
                pipeline["search_query"] = built["query"]
                pipeline["search_reruns"] = 0
                pipeline["job_location"] = job_location
                query = built["query"]
                tightness = built["tightness"]
            logger.info(
                "recruiter pipeline: boolean for job %s (t=%s): %s",
                job_id, tightness, query,
            )
            search_params = {"boolean_query": query}
            # Location facet from the Odoo job_location (cr→Costa Rica, latam→Latin
            # America, global→skip). Only thread it when non-empty: a blank location is
            # OMITTED so the search workflow's skip_if_blank:location steps are pruned
            # (a global/worldwide boolean-only search) — never typed as a literal.
            location = self._resolve_search_location(job_location)
            if location:
                search_params["location"] = location
            logger.info(
                "recruiter pipeline: job %s job_location=%r → search location=%r",
                job_id, job_location, location or "(skip facet)",
            )
            search_run = await self._create_pipeline_run(
                workflow_id=adv_wf, event_kind=EVENT_SEARCH,
                runtime_params=search_params,
                pipeline=pipeline, connector_id=connector_id,
            )
            # Global/worldwide (no location): drop the location facet steps so the run
            # does a boolean-only search instead of typing a literal "{{location}}".
            if not location:
                removed = self._strip_location_facet_steps(search_run.workflow_snapshot)
                if removed:
                    flag_modified(search_run, "workflow_snapshot")
                    search_run.total_steps = len(search_run.workflow_snapshot["steps"])
                    await self.session.flush()
                    logger.info(
                        "recruiter pipeline: job %s no location → pruned %d location facet step(s)",
                        job_id, removed,
                    )
            await self._push_flow_status(
                job_id=job_id, connector_id=connector_id, status="running",
                event_kind=EVENT_SEARCH, run_id=search_run.id,
                message="🔍 Project created — searching for candidates on LinkedIn…",
            )
            return {"stage": "create_project", "project_link": link_res,
                    "next_run": str(search_run.id), "boolean": query}

        search_wf = settings.recruiter_search_workflow_id
        if not search_wf:
            logger.warning(
                "recruiter pipeline: no search workflow configured — stopping after create-project"
            )
            return {"stage": "create_project", "project_link": link_res, "next_run": None}
        search_run = await self._create_pipeline_run(
            workflow_id=search_wf,
            event_kind=EVENT_SEARCH,
            runtime_params={"position": pipeline.get("position", "")},
            pipeline=pipeline,
            connector_id=connector_id,
        )
        await self._push_flow_status(
            job_id=job_id, connector_id=connector_id, status="running",
            event_kind=EVENT_SEARCH, run_id=search_run.id,
            message="🔍 Project created — searching for candidates on LinkedIn…",
        )
        return {
            "stage": "create_project",
            "project_link": link_res,
            "next_run": str(search_run.id),
        }

    async def _fetch_job_corpus(self, job_id, connector_id) -> tuple[str, str, str]:
        """Assemble the JD corpus (title + description + requirements) from Odoo for
        the AI boolean builder, and read the job_location (cr/latam/global) used to
        pick the search location facet. Best-effort → returns (corpus, title,
        job_location)."""
        from adapters.odoo.adapter import OdooAdapter
        from services.connector_forum_service import ConnectorForumService

        def strip(v):
            return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", str(v or ""))).strip()

        title, parts, job_location = "", [], ""
        try:
            connector = await ConnectorForumService(self.session).resolve_connector(
                str(connector_id)
            )
            adapter = OdooAdapter()
            await adapter.initialize(connector.config)
            try:
                jobs = await adapter.list("job", filters={"id": int(job_id)}, limit=1, fields=[
                    "name", "description", "job_requirements", "non_negotiable_requirements",
                    "nice_to_have_requirements", "role_responsibilities",
                    "seniority_level", "experience_years", "job_location",
                ])
                j = jobs[0] if jobs else {}
                title = j.get("name") or ""
                job_location = str(j.get("job_location") or "").strip()
                if title:
                    parts.append(title)
                for f in ("description", "job_requirements", "non_negotiable_requirements",
                          "nice_to_have_requirements", "role_responsibilities"):
                    v = strip(j.get(f))
                    if v:
                        parts.append(v)
                reqs = await adapter.list(
                    "ak.job.requirement", filters={"job_id": int(job_id)}, limit=40,
                    fields=["name", "summary"],
                )
                for r in reqs:
                    line = f"{strip(r.get('name'))}: {strip(r.get('summary'))}".strip(" :")
                    if line:
                        parts.append(line)
                if j.get("seniority_level"):
                    parts.append(f"Seniority: {j['seniority_level']}")
                if j.get("experience_years"):
                    parts.append(f"Experience: {j['experience_years']} years")
            finally:
                await adapter.dispose()
        except Exception:
            logger.exception("recruiter pipeline: corpus fetch failed for job %s", job_id)
        return "\n".join(p for p in parts if p), title, job_location

    async def _compose_project_description(self, job_id, connector_id, fallback: str = "") -> str:
        """Build the LinkedIn project description from the Odoo job's structured
        sections — "What you will be doing" (description) + "What we're looking for"
        (job_requirements) + "What would be a plus" (nice_to_have_requirements) — so
        the project mirrors the full JD, not just the first section. HTML-stripped,
        section-headed. Best-effort: returns `fallback` (the webhook's plain
        job_description) if the fetch fails or yields nothing."""
        from adapters.odoo.adapter import OdooAdapter
        from services.connector_forum_service import ConnectorForumService

        def strip(v):
            return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", str(v or ""))).strip()

        sections = []
        try:
            connector = await ConnectorForumService(self.session).resolve_connector(
                str(connector_id)
            )
            adapter = OdooAdapter()
            await adapter.initialize(connector.config)
            try:
                jobs = await adapter.list("job", filters={"id": int(job_id)}, limit=1, fields=[
                    "description", "job_requirements", "nice_to_have_requirements",
                ])
                j = jobs[0] if jobs else {}
                for header, field in (
                    ("", "description"),
                    ("Requisitos:", "job_requirements"),
                    ("Deseable:", "nice_to_have_requirements"),
                ):
                    v = strip(j.get(field))
                    if v:
                        sections.append(f"{header}\n{v}".strip() if header else v)
            finally:
                await adapter.dispose()
        except Exception:
            logger.exception(
                "recruiter pipeline: project-description fetch failed for job %s", job_id
            )
        composed = "\n\n".join(sections).strip()
        return composed or (fallback or "")

    def _resolve_search_location(self, job_location: str) -> str:
        """Map the Odoo job_location (cr/latam/global) to a LinkedIn location facet
        string. A KNOWN mapping wins (incl. "" = skip the facet, e.g. global); an
        unknown/empty job_location falls back to recruiter_default_location."""
        loc_map = settings.recruiter_location_map or {}
        key = (job_location or "").strip().lower()
        if key in loc_map:
            return (loc_map[key] or "").strip()
        return (settings.recruiter_default_location or "").strip()

    @staticmethod
    def _strip_location_facet_steps(snapshot: dict | None) -> int:
        """Remove the location-facet step block from a search run's snapshot so a
        location-less (global/worldwide) position runs a boolean-only search — never
        typing a literal "{{location}}" into the typeahead. Anchored on STABLE,
        locale-proof data-test selectors (the block's interleaved scroll/delay steps
        carry no selector or intent, so an intent/text match would miss them): from
        the FIRST step whose selector opens the location facet (data-test-facet-
        geo-locations / facet-locations) up to — but excluding — the "Run search"
        button (data-test-save-advanced-button). No-op when those anchors aren't
        present (e.g. a workflow without a location facet). Reindexes step_index so
        the remaining steps stay contiguous. Returns the number of steps removed."""
        steps = (snapshot or {}).get("steps") or []

        def sel_has(step, *tokens) -> bool:
            for s in (step.get("selector_chain") or []):
                v = str(s.get("value") or "")
                if any(tok in v for tok in tokens):
                    return True
            return False

        start = next(
            (i for i, s in enumerate(steps)
             if sel_has(s, "facet-geo-locations", "facet-locations")),
            None,
        )
        if start is None:
            return 0
        end = next(
            (i for i in range(start + 1, len(steps))
             if sel_has(steps[i], "save-advanced-button")),
            None,
        )
        if end is None:
            return 0
        del steps[start:end]
        for i, s in enumerate(steps):
            s["step_index"] = i
        return end - start

    async def _after_search(self, run, pipeline, connector_id, job_id) -> dict:
        # Read the search result (url + total_count). total_count is None until the
        # daemon extractor enhancement ships → the calibration below is then a no-op.
        result = await self.push.read_search_result(run.id)
        count = result.get("total_count")
        spec = pipeline.get("search_spec")
        tightness = pipeline.get("search_tightness")
        reruns = pipeline.get("search_reruns", 0)
        prev_count = pipeline.get("search_prev_count")  # count before this run's tightness
        adv_wf = settings.recruiter_advanced_search_workflow_id

        # --- count calibration: converge toward a usable set, but DON'T burn every
        # rerun. Tighten only while the count is above the acceptable ceiling AND
        # tightening is still meaningfully reducing it; broaden only when clearly too
        # few. Anything in [band_min, acceptable_max] is good enough → finalize. ---
        if (adv_wf and spec is not None and tightness is not None and count is not None
                and reruns < settings.recruiter_max_search_reruns):
            from services.boolean_query_builder import BooleanQueryBuilder
            b = BooleanQueryBuilder()
            new_t = None
            if count > settings.recruiter_count_acceptable_max:
                # Diminishing-returns guard: if the previous tighten reduced the count
                # by less than min_convergence, another tighten won't reach a usable
                # set either — finalize with what we have instead of exhausting reruns.
                converging = (
                    prev_count is None or prev_count <= 0
                    or (prev_count - count) / prev_count >= settings.recruiter_count_min_convergence
                )
                if converging:
                    new_t = tightness + 1          # too many AND still converging → tighten
            elif count < settings.recruiter_count_band_min:
                new_t = tightness - 1              # clearly too few → broaden
            if new_t is not None and 0 <= new_t <= b.max_tightness(spec) and new_t != tightness:
                query = b.assemble(spec, new_t)
                re_params = {"boolean_query": query}
                if settings.recruiter_default_location:
                    re_params["location"] = settings.recruiter_default_location
                re_run = await self._create_pipeline_run(
                    workflow_id=adv_wf, event_kind=EVENT_SEARCH,
                    runtime_params=re_params,
                    pipeline={**pipeline, "search_tightness": new_t,
                              "search_reruns": reruns + 1, "search_query": query,
                              "search_prev_count": count},
                    connector_id=connector_id,
                )
                logger.info(
                    "recruiter pipeline: calibrate job %s count=%s (prev=%s) t=%s→%s rerun=%s",
                    job_id, count, prev_count, tightness, new_t, str(re_run.id),
                )
                return {"stage": "search", "calibrating": True, "count": count,
                        "tightness": new_t, "re_run": str(re_run.id)}
            logger.info(
                "recruiter pipeline: finalize job %s count=%s (prev=%s) — within "
                "acceptable range or tightening saturated; not re-running",
                job_id, count, prev_count,
            )

        # --- in band (or no count / reruns exhausted): finalize ---
        if pipeline.get("search_query"):
            # Readable summary of the facet filters applied to the search (currently
            # the location facet; extend here as more facets are added).
            filter_parts = []
            if settings.recruiter_default_location:
                filter_parts.append(f"Location: {settings.recruiter_default_location}")
            await self.push.push_search_link(
                run_id=run.id, job_id=job_id, connector_id=connector_id,
                search_url=result.get("url"), count=count,
                query=pipeline.get("search_query"),
                filters=" · ".join(filter_parts),
            )
        # Requirement A: candidates → linkedin.lead.
        lead_res = await self.push.push_recruiter_leads(
            run_id=run.id, job_id=job_id, connector_id=connector_id,
            source="boolean_search",
        )
        candidates = lead_res.get("leads") or []

        # Loud signal: finalizing with ZERO candidates is almost always a problem
        # (a walled seat, a search that committed empty, or a boolean too tight after
        # reruns) — NOT a normal success. Mark it on the run origin and warn so it's
        # visible instead of silently completing with no leads. (The calibration above
        # already broadens while reruns remain; this is the terminal 0 case.)
        if not candidates:
            logger.warning(
                "recruiter pipeline: job %s search finalized with 0 candidates "
                "(count=%s, tightness=%s, reruns=%s) — flagging zero_results",
                job_id, count, tightness, reruns,
            )
            origin = dict(run.origin or {})
            origin["zero_results"] = True
            run.origin = origin
            flag_modified(run, "origin")
            await self.session.flush()

        # Chatter narration: the search finished. The terminal "done" comes from the SAVE
        # stage (candidates verified in the project) or the FAILED hook; here we narrate
        # "found N; saving M…" when a save is enqueued, or a terminal "search complete"
        # note when there's nothing to save.
        n_cands = len(candidates)
        found_str = f"found {count} result(s); " if count is not None else ""

        # Save EVERY extracted candidate to the project: the count saved == the count
        # the search extracted (the extraction is itself bounded by the search
        # workflow's target_count, ~30). recruiter_max_saves_per_position is now only
        # an OPTIONAL absolute ceiling — 0 (default) = no cap = save all extracted.
        cap = settings.recruiter_max_saves_per_position or 0
        to_save = candidates[:cap] if cap > 0 else candidates

        project_name = pipeline.get("project_name", "")
        save_runs: list[str] = []

        # Preferred: ONE bulk results-page save run — select N candidates on the
        # search results page and save them together (no profile visits). Needs
        # the concrete search URL the search run landed on.
        bulk_wf = settings.recruiter_save_results_workflow_id
        # The search extractor stores the LAST page it landed on (often start=25).
        # Normalize to start=0 so the bulk save begins on page 1 and can paginate
        # forward over the whole result set.
        search_url = re.sub(r"([?&]start=)\d+", r"\g<1>0", result.get("url") or "")
        if bulk_wf and project_name and to_save and search_url:
            target_count = len(to_save)
            save_run = await self._create_pipeline_run(
                workflow_id=bulk_wf,
                event_kind=EVENT_SAVE,
                runtime_params={
                    "search_url": search_url,
                    "project_name": project_name,
                    "target_count": target_count,
                    # Lets the save step VERIFY: it navigates to the project's candidate
                    # list at the end (snapshot proof) and reads back the saved count.
                    "project_url": pipeline.get("project_url") or "",
                },
                pipeline={**pipeline, "bulk_save_target": target_count},
                connector_id=connector_id,
            )
            save_runs.append(str(save_run.id))
            logger.info(
                "recruiter pipeline: bulk save run %s for job %s (target=%s, project=%r)",
                save_run.id, job_id, target_count, project_name,
            )
            await self._push_flow_status(
                job_id=job_id, connector_id=connector_id, status="running",
                event_kind=EVENT_SEARCH, run_id=run.id,
                message=f"🔎 Candidate search done — {found_str}saving {target_count} candidate(s) to the project…",
            )
            return {"stage": "search", "leads": lead_res, "save_runs": save_runs,
                    "bulk_save": True}

        # Fallback: per-candidate save runs (the legacy profile-page save flow).
        save_wf = settings.recruiter_save_workflow_id
        if bulk_wf and not search_url:
            logger.warning(
                "recruiter pipeline: bulk save configured but search run produced no "
                "URL — falling back to per-candidate saves"
            )
        if save_wf and project_name and to_save:
            for cand in to_save:
                url = cand.get("profile_url")
                if not url:
                    continue
                save_run = await self._create_pipeline_run(
                    workflow_id=save_wf,
                    event_kind=EVENT_SAVE,
                    runtime_params={
                        "candidate_url": url,
                        "project_name": project_name,
                    },
                    pipeline={**pipeline, "candidate_url": url},
                    connector_id=connector_id,
                )
                save_runs.append(str(save_run.id))
        elif not save_wf and not bulk_wf:
            logger.warning(
                "recruiter pipeline: no save workflow configured — leads pushed, "
                "candidates NOT auto-saved to the project"
            )
        if save_runs:
            await self._push_flow_status(
                job_id=job_id, connector_id=connector_id, status="running",
                event_kind=EVENT_SEARCH, run_id=run.id,
                message=f"🔎 Candidate search done — {found_str}saving {len(save_runs)} candidate(s) to the project…",
            )
        else:
            # Nothing to save (0 candidates or no save workflow) → terminal "done".
            await self._push_flow_status(
                job_id=job_id, connector_id=connector_id, status="done",
                event_kind=EVENT_SEARCH, run_id=run.id,
                message=(f"🔎 Candidate search complete — {n_cands} candidate(s) found."
                         if n_cands else "🔎 Candidate search complete — no candidates matched."),
            )
        return {"stage": "search", "leads": lead_res, "save_runs": save_runs}

    async def _after_message(self, run, pipeline, connector_id, job_id) -> dict:
        # GATED: only record outreach in Odoo when the message was actually SENT.
        # A gated preview (send=false) types + stops — nothing was sent, so don't mark.
        compose = await self.push.read_message_compose_result(run.id)
        # Idempotent re-send: the strategy messages ONLY not-yet-contacted candidates. If
        # everyone in the project was already contacted, nothing is sent — surface that
        # clearly (no Odoo outreach update, no add-note chain) instead of "preview".
        if compose.get("reason") == "no_uncontacted":
            logger.info(
                "recruiter pipeline: job %s — all candidates already contacted (%s), no messages sent",
                job_id, compose.get("contacted_count"),
            )
            await self._push_flow_status(
                job_id=job_id, connector_id=connector_id, status="done",
                event_kind=EVENT_MESSAGE, run_id=run.id,
                message=f"✅ All candidates in the project were already contacted "
                        f"({compose.get('contacted_count', 0)}) — no new messages were sent.",
            )
            return {"stage": "message", "sent": False, "no_uncontacted": True}
        if not pipeline.get("send") or not compose.get("sent"):
            logger.info(
                "recruiter pipeline: message preview for job %s (send=%s sent=%s) — "
                "no Odoo outreach update", job_id, pipeline.get("send"), compose.get("sent"),
            )
            await self._push_flow_status(
                job_id=job_id, connector_id=connector_id, status="done",
                event_kind=EVENT_MESSAGE, run_id=run.id,
                message="✉️ Message preview ready (not sent).",
            )
            return {"stage": "message", "sent": False, "preview": True}
        # Req B: mark the candidates we actually messaged (the project's active
        # candidates at send time, reported by the compose strategy) as messaged.
        recipients = compose.get("recipients") or pipeline.get("messaged") or []
        subject = pipeline.get("subject") or ""
        messaged = [
            ({"profile_url": r, "subject": subject, "message_type": "inmail"}
             if isinstance(r, str)
             else {**r, "subject": subject, "message_type": "inmail"})
            for r in recipients
        ]
        res = await self.push.push_outreach_update(
            run_id=run.id, job_id=job_id, connector_id=connector_id, messaged=messaged,
        )
        logger.info("recruiter pipeline: outreach update for job %s — %s", job_id, res)
        await self._push_flow_status(
            job_id=job_id, connector_id=connector_id, status="done",
            event_kind=EVENT_MESSAGE, run_id=run.id,
            message=f"✉️ Message sent to {len(recipients)} candidate(s).",
        )
        # "Ambos": after a REAL send, chain an add-note run (save=true) so the messaged
        # candidates get the "Contactado para <posición>" note + the native "contacted"
        # stage — the LinkedIn-side markers of "already contacted". Best-effort: if the
        # note workflow is unset it no-ops; a note failure never un-does the send.
        note_run_id = None
        if settings.recruiter_note_workflow_id:
            try:
                note_run_id = await self._enqueue_note_run(
                    job_id=job_id, connector_id=connector_id,
                    project_id=pipeline.get("project_id"),
                    position=pipeline.get("position"),
                    project_name=pipeline.get("project_name"),
                )
            except Exception:  # noqa: BLE001 — chaining is best-effort
                logger.exception("recruiter pipeline: failed to chain add-note after message (job %s)", job_id)
        return {"stage": "message", "sent": True, "outreach": res, "note_run_id": note_run_id}

    async def _default_note_text(self, job_id, position: str | None,
                                 connector_id, contacted_by: str = DEFAULT_CONTACTED_BY) -> str:
        """Compose the LinkedIn note: "Contacted - <position> · by: <who> · <Odoo link>".
        The Odoo deep-link (classic web client form URL) is built from the connector's base
        URL + job_id; if the connector is unconfigured the link is omitted (graceful)."""
        pos = (position or "").strip()
        parts = [f"{DEFAULT_NOTE_PREFIX}{pos}".strip(" -") if pos else "Contacted",
                 f"by: {contacted_by}"]
        ep = await self.push._connector_endpoint(connector_id)
        if ep:
            base, _key = ep
            parts.append(f"{base.rstrip('/')}/web#id={job_id}&model=hr.job&view_type=form")
        return " · ".join(parts)

    async def _enqueue_note_run(
        self, *, job_id, connector_id, project_id, position: str | None = None,
        project_name: str | None = None, note_text: str | None = None, save: bool = True,
    ) -> str | None:
        """Create a QUEUED recruiter_note run: add the "Contactado para <posición>" note
        to the project's active candidates AND move them to the native "contacted" stage
        (save=true). Shared by add_note_to_candidates (standalone/Odoo button) and the
        post-message chain. Returns the run id, or None if the job has no project."""
        if not settings.recruiter_note_workflow_id or not project_id:
            return None
        note_text = (note_text or await self._default_note_text(job_id, position, connector_id)).strip()
        project_url = f"https://www.linkedin.com/talent/hire/{project_id}/manage/all"
        pipeline_ctx = {
            "job_id": str(job_id), "connector_id": connector_id, "project_id": project_id,
            "position": position, "project_name": project_name,
            "note_text": note_text, "save": bool(save),
        }
        run = await self._create_pipeline_run(
            workflow_id=settings.recruiter_note_workflow_id,
            event_kind=EVENT_NOTE,
            runtime_params={
                "project_url": project_url,
                "note_text": note_text,
                "save": "true" if save else "false",
            },
            pipeline=pipeline_ctx,
            connector_id=connector_id,
        )
        logger.info(
            "recruiter pipeline: started add-note run %s for job %s (save=%s note=%r)",
            run.id, job_id, save, note_text,
        )
        await self._push_flow_status(
            job_id=str(job_id), connector_id=connector_id, status="running",
            event_kind=EVENT_NOTE, run_id=run.id,
            message=("📝 Agregando la nota de contacto + marcando 'contacted'…"
                     if save else "📝 Preparando la nota de contacto (preview)…"),
        )
        return str(run.id)

    async def add_note_to_candidates(self, job_id, note_text: str | None = None,
                                     save: bool = False) -> str | None:
        """Standalone (Odoo button) trigger: add the "Contactado para <posición>" note to
        the job's project candidates (bulk) + move them to "contacted". GATED by `save`
        (false=preview/STOP, true=save the note + move stage). note_text defaults to
        "Contactado para <position>" from the job context. Returns the run id, or None if
        the job has no project / the workflow is unset."""
        if not settings.recruiter_note_workflow_id:
            logger.warning("recruiter pipeline: recruiter_note_workflow_id unset — skip")
            return None
        ctx = await self._gather_job_context(job_id)
        if not ctx.get("project_id"):
            logger.warning("recruiter pipeline: no project for job %s — can't add note", job_id)
            return None
        return await self._enqueue_note_run(
            job_id=job_id, connector_id=ctx.get("connector_id"),
            project_id=ctx.get("project_id"), position=ctx.get("position"),
            project_name=ctx.get("project_name"), note_text=note_text, save=save,
        )

    async def sync_candidate_notes(self, *, profile_url: str, candidate_id=None,
                                   name: str | None = None, connector_id=None,
                                   odoo_notes: list[dict] | None = None,
                                   project_url: str | None = None) -> dict:
        """Standalone (Odoo candidate button) trigger: PUSH a candidate's unsynced Odoo
        notes to LinkedIn (push-only — we don't pull LinkedIn's notes). LinkedIn notes are
        GLOBAL to the candidate, added by selecting the candidate (by NAME) inside a project
        pipeline and adding the note there (strategy recruiter_candidate_note_add). Enqueues
        ONE daemon run PER unsynced note (the composer takes one note at a time); each run's
        terminal hook marks that note synced in Odoo. `project_url` = any LinkedIn project the
        candidate is in (akcr resolves it from the candidate's leads). Returns
        {status:'queued', run_ids} / 'not_configured' / 'error'."""
        if not profile_url:
            return {"status": "error", "reason": "profile_url required"}
        if not name:
            return {"status": "error", "reason": "candidate_name required"}
        if not settings.recruiter_notes_sync_workflow_id:
            logger.warning("recruiter pipeline: recruiter_notes_sync_workflow_id unset")
            return {"status": "not_configured", "reason": "notes-sync workflow not configured"}
        if not project_url:
            # Push requires a project to select the candidate in (notes are global, but the
            # add-note UI lives in a project pipeline). akcr sends the candidate's project.
            return {"status": "error", "reason": "no_project_url — candidate is not in any LinkedIn project"}
        connector_id = connector_id or await self._latest_recruiter_connector()
        pending = [n for n in (odoo_notes or []) if (n.get("body") or "").strip()]
        if not pending:
            return {"status": "noop", "reason": "no_unsynced_notes"}
        run_ids = []
        for note in pending:
            run = await self._create_pipeline_run(
                workflow_id=settings.recruiter_notes_sync_workflow_id,
                event_kind=EVENT_NOTES_SYNC,
                runtime_params={
                    "project_url": project_url,
                    "candidate_name": name,
                    "note_text": note.get("body", ""),
                    "save": "true",
                },
                pipeline={
                    "profile_url": profile_url,
                    "candidate_id": candidate_id,
                    "candidate_name": name,
                    "connector_id": connector_id,
                    "project_url": project_url,
                    "note_id": note.get("id"),
                },
                connector_id=connector_id,
            )
            run_ids.append(str(run.id))
        logger.info(
            "recruiter pipeline: enqueued %d notes-sync run(s) for candidate %r (push)",
            len(run_ids), name,
        )
        return {"status": "queued", "run_ids": run_ids, "count": len(run_ids)}

    async def _after_note(self, run, pipeline, connector_id, job_id) -> dict:
        """An add-note run completed. The note + "contacted" stage are LinkedIn-side
        markers (Odoo's outreach_status is set by the message flow), so this only reports
        status to the position chatter. ok=false (note not saved) surfaces as failed."""
        note = await self.push.read_note_compose_result(run.id)
        saved = bool(note.get("saved"))
        moved = bool(note.get("stage_moved"))
        # noted_count = candidates actually noted across ALL pages (the strategy paginates so
        # every active candidate is covered, not just the first ~25). Fall back to recipient_count.
        noted = note.get("noted_count") or note.get("recipient_count") or 0
        movedN = note.get("moved_count") or 0
        if not pipeline.get("save") or not saved:
            await self._push_flow_status(
                job_id=job_id, connector_id=connector_id, status="done",
                event_kind=EVENT_NOTE, run_id=run.id,
                message="📝 Vista previa de la nota lista (no guardada).",
            )
            return {"stage": "note", "saved": False, "preview": True}
        await self._push_flow_status(
            job_id=job_id, connector_id=connector_id, status="done",
            event_kind=EVENT_NOTE, run_id=run.id,
            message=(f"📝 Contact note added to {noted} candidate(s)"
                     + (f" + {movedN} moved to 'contacted'." if moved else ".")),
        )
        # The note is now on LinkedIn (global to each candidate) — mirror it as a
        # linkedin.candidate.note in Odoo so the candidate view reflects it. Best-effort,
        # idempotent (deduped per candidate by a stable linkedin_key). Recipients carry
        # profile_url+name; notes are GLOBAL, so one note per recipient candidate.
        recipients = note.get("recipients") or []
        note_text = pipeline.get("note_text") or ""
        if note_text and recipients:
            lkey = f"contact-note:job{job_id}"
            for r in recipients:
                purl = (r.get("profile_url") or "").strip() if isinstance(r, dict) else ""
                if not purl:
                    continue
                try:
                    await self.push.push_candidate_notes(
                        run_id=run.id, connector_id=connector_id, profile_url=purl,
                        notes=[{"body": note_text, "key": lkey}], pushed=[],
                    )
                except Exception:
                    logger.exception("recruiter pipeline: failed to mirror contact note "
                                     "for %s (run %s)", purl, run.id)
        return {"stage": "note", "saved": True, "noted_count": noted, "moved_count": movedN, "stage_moved": moved}

    async def _after_notes_sync(self, run, pipeline, connector_id, job_id) -> dict:
        """A candidate notes-PUSH run completed (one Odoo note → LinkedIn). If the strategy
        SAVED the note, mark that Odoo note synced via /akcr/api/candidate_notes (pushed=[id]).
        Push-only; candidate-centric (no job_id). LinkedIn notes are global to the candidate."""
        profile_url = pipeline.get("profile_url")
        note_id = pipeline.get("note_id")
        res = await self.push.read_candidate_note_add_result(run.id)
        saved = bool(res.get("saved") or res.get("ok"))
        if not saved:
            logger.warning(
                "recruiter pipeline: notes-push run %s for %r NOT saved (reason=%r) — "
                "leaving Odoo note %s unsynced",
                run.id, pipeline.get("candidate_name"), res.get("reason"), note_id,
            )
            return {"stage": "notes_sync", "saved": False, "note_id": note_id, "reason": res.get("reason")}
        odoo = {}
        if note_id and profile_url:
            odoo = await self.push.push_candidate_notes(
                run_id=run.id, connector_id=connector_id, profile_url=profile_url,
                notes=[], pushed=[note_id],
            )
        logger.info(
            "recruiter pipeline: notes-push complete for %r — note %s saved on LinkedIn, odoo=%s",
            pipeline.get("candidate_name"), note_id, odoo,
        )
        return {"stage": "notes_sync", "saved": True, "note_id": note_id, "odoo": odoo}

    async def _after_archive(self, run, pipeline, connector_id, job_id) -> dict:
        """An archive (remove-from-project) run completed. Only when the strategy
        VERIFIED the candidate is gone from the active project list do we delete the
        Odoo lead (/akcr/api/lead_removed). If unverified, leave the lead in its
        'pending' removal state — safe, and re-runnable."""
        profile_url = pipeline.get("profile_url")
        name = pipeline.get("candidate_name") or pipeline.get("name")
        archive = await self.push.read_archive_result(run.id)
        verified_gone = bool(archive.get("verified_gone"))
        archived = bool(archive.get("archived"))
        if not (verified_gone or archived):
            logger.warning(
                "recruiter pipeline: archive run %s for job %s candidate %r NOT "
                "confirmed (archived=%s verified_gone=%s reason=%r) — leaving Odoo "
                "lead pending",
                run.id, job_id, name, archived, verified_gone, archive.get("reason"),
            )
            return {"stage": "archive", "removed": False, "archive": archive}
        res = await self.push.push_lead_removed(
            run_id=run.id, job_id=job_id, connector_id=connector_id,
            profile_url=profile_url, name=name,
        )
        logger.info(
            "recruiter pipeline: archived+removed candidate %r (job %s) — %s",
            name, job_id, res,
        )
        await self._push_flow_status(
            job_id=job_id, connector_id=connector_id, status="done",
            event_kind=EVENT_ARCHIVE, run_id=run.id,
            message=f"🗄️ Candidate {name or ''} archived and removed from the project.".replace("  ", " "),
        )
        return {"stage": "archive", "removed": True, "archive": archive, "odoo": res}

    async def _gather_job_context(self, job_id) -> dict:
        """Reconstruct a job's pipeline context from its prior runs: connector +
        project + the candidates actually SAVED (completed save runs)."""
        result = await self.session.execute(
            select(ExecutionRun).order_by(ExecutionRun.created_at.desc()).limit(500)
        )
        ctx = {"connector_id": None, "project_id": None, "project_url": None,
               "project_name": None, "position": None, "saved": []}
        seen = set()
        for r in result.scalars().all():
            o = r.origin or {}
            if o.get("event_kind") not in PIPELINE_EVENT_KINDS:
                continue
            p = o.get("pipeline") or {}
            if str(p.get("job_id")) != str(job_id):
                continue
            ctx["connector_id"] = ctx["connector_id"] or p.get("connector_id") or o.get("connector_id")
            ctx["project_id"] = ctx["project_id"] or p.get("project_id")
            ctx["project_url"] = ctx["project_url"] or p.get("project_url")
            ctx["project_name"] = ctx["project_name"] or p.get("project_name")
            ctx["position"] = ctx["position"] or p.get("position")
            if o.get("event_kind") == EVENT_SAVE and r.status == RunStatus.COMPLETED.value:
                url = p.get("candidate_url")
                if url and url not in seen:
                    seen.add(url)
                    ctx["saved"].append({"profile_url": url})
        return ctx

    async def _latest_recruiter_connector(self) -> str | None:
        """The recruiter connector to push to when there's no run/job context (the
        passive inbox-reply scan): the connector_id of the most recent pipeline run.
        In practice there is exactly one recruiter connector."""
        result = await self.session.execute(
            select(ExecutionRun).order_by(ExecutionRun.created_at.desc()).limit(500)
        )
        for r in result.scalars().all():
            o = r.origin or {}
            if o.get("event_kind") not in PIPELINE_EVENT_KINDS:
                continue
            p = o.get("pipeline") or {}
            cid = p.get("connector_id") or o.get("connector_id")
            if cid:
                return str(cid)
        return None

    async def record_inbox_replies(self, replies: list[dict]) -> dict:
        """Passive inbox-reply scan ingress: the daemon's keepAliveTick scrapes the
        Recruiter inbox and POSTs candidates who replied to our outreach. Resolve the
        recruiter connector and push an INBOUND-message marker to Odoo (→
        outreach_status='responded' via _sync_lead_status). No ExecutionRun is created
        (passive); akcr is idempotent so repeated scans are safe."""
        replies = [
            r for r in (replies or [])
            if isinstance(r, dict) and (r.get("profile_url") or r.get("name"))
        ]
        if not replies:
            return {"status": "skipped", "reason": "no_replies", "pushed": 0}
        connector_id = await self._latest_recruiter_connector()
        if not connector_id:
            return {"status": "skipped", "reason": "no_recruiter_connector", "pushed": 0}
        res = await self.push.push_inbox_replies(connector_id=connector_id, replied=replies)
        logger.info("recruiter inbox-replies: %d candidates → %s", len(replies), res)
        return {"status": "ok", "received": len(replies), **res}

    async def send_messages(self, job_id, subject: str | None = None,
                            body: str | None = None, send: bool = False) -> str | None:
        """Deliberate (manual/gated) req B trigger: bulk-message a job's project
        candidates with a template body. Fires the recruiter_message_compose run
        (GATED by `send`: send=False types everything + STOPS for a snapshot preview;
        send=True actually sends InMail). The `{Nombre}` token in the body becomes the
        LinkedIn {firstName} variable chip. On completion the terminal hook
        → _after_message → push_outreach_update marks the messaged leads in Odoo.

        Recipients = the project's UNCONTACTED candidates: the compose strategy switches
        to LinkedIn's native "uncontacted" pipeline stage and select-alls it, so
        already-contacted/replied candidates are never re-messaged. It reports exactly
        the rows it selected so the backend marks precisely those in Odoo.
        """
        wf = settings.recruiter_message_workflow_id
        if not wf:
            logger.warning("recruiter pipeline: recruiter_message_workflow_id unset — skip")
            return None
        ctx = await self._gather_job_context(job_id)
        if not ctx.get("project_id"):
            logger.warning("recruiter pipeline: no project for job %s — can't message", job_id)
            return None
        subject = (subject or DEFAULT_MESSAGE_SUBJECT).strip()
        body = (body or DEFAULT_MESSAGE_BODY).strip()
        project_url = (
            f"https://www.linkedin.com/talent/hire/{ctx['project_id']}/manage/all"
        )
        pipeline_ctx = {
            "job_id": str(job_id),
            "connector_id": ctx.get("connector_id"),
            "project_id": ctx.get("project_id"),
            "position": ctx.get("position"),
            "project_name": ctx.get("project_name"),
            "subject": subject,
            "send": bool(send),
        }
        runtime_params = {
            "project_url": project_url,
            "subject": subject,
            "body": body,
            "send": "true" if send else "false",
        }
        run = await self._create_pipeline_run(
            workflow_id=wf,
            event_kind=EVENT_MESSAGE,
            runtime_params=runtime_params,
            pipeline=pipeline_ctx,
            connector_id=ctx.get("connector_id"),
        )
        logger.info(
            "recruiter pipeline: started message-compose run %s for job %s (send=%s)",
            run.id, job_id, send,
        )
        await self._push_flow_status(
            job_id=str(job_id), connector_id=ctx.get("connector_id"), status="running",
            event_kind=EVENT_MESSAGE, run_id=run.id,
            message=("✉️ Sending the outreach message to the project's candidates…"
                     if send else "✉️ Preparing the outreach message (preview)…"),
        )
        return str(run.id)

    async def remove_candidate(
        self, job_id, *, profile_url: str | None = None, name: str | None = None,
        project_url: str | None = None, connector_id=None, lead_id=None,
    ) -> str | None:
        """Deferred-delete trigger: an Odoo linkedin.lead was deleted → archive that
        candidate from the LinkedIn project. Creates ONE daemon archive run that
        locates the candidate by NAME on the project pipeline, archives them, and
        verifies removal. On confirmed removal the terminal hook (_after_archive)
        deletes the Odoo lead. Returns the run id, or None if it can't proceed.

        Archive targets the candidate by visible NAME (the per-row archive button is
        name-labelled), so a name is REQUIRED. project_url is taken from the caller
        (hr.job.recruiter_project_url) or reconstructed from prior pipeline runs.
        """
        wf = settings.recruiter_archive_candidate_workflow_id
        if not wf:
            logger.warning("recruiter pipeline: recruiter_archive_candidate_workflow_id unset — skip")
            return None
        name = (name or "").strip()
        if not name:
            logger.warning(
                "recruiter pipeline: remove_candidate for job %s lacks a candidate "
                "name (profile_url=%r) — can't target the archive button", job_id, profile_url,
            )
            return None
        # Resolve project + connector: prefer the caller's, else reconstruct.
        ctx = None
        if not project_url or not connector_id:
            ctx = await self._gather_job_context(job_id)
        project_url = project_url or (ctx or {}).get("project_url")
        connector_id = connector_id or (ctx or {}).get("connector_id")
        project_id = None
        if project_url:
            m = _PROJECT_URL_RE.search(project_url)
            project_id = m.group(1) if m else None
        elif ctx and ctx.get("project_id"):
            project_id = ctx["project_id"]
            project_url = f"https://www.linkedin.com/talent/hire/{project_id}/manage/all"
        if not project_url:
            logger.warning(
                "recruiter pipeline: no project URL for job %s — can't archive %r",
                job_id, name,
            )
            return None
        pipeline_ctx = {
            "job_id": str(job_id),
            "connector_id": str(connector_id) if connector_id else None,
            "project_id": project_id,
            "project_url": project_url,
            "position": (ctx or {}).get("position"),
            "project_name": (ctx or {}).get("project_name"),
            "profile_url": profile_url,
            "candidate_name": name,
            "lead_id": lead_id,
        }
        run = await self._create_pipeline_run(
            workflow_id=wf,
            event_kind=EVENT_ARCHIVE,
            runtime_params={
                "project_url": project_url,
                "candidate_name": name,
                "profile_url": profile_url or "",
            },
            pipeline=pipeline_ctx,
            connector_id=connector_id,
            # Low priority: deferred-removal archives are bulk cleanup. A burst of them
            # (e.g. a demo reset deleting many leads) must NOT queue ahead of an
            # interactive pipeline/message run on the single daemon.
            priority=-10,
        )
        logger.info(
            "recruiter pipeline: started archive run %s for job %s candidate %r",
            run.id, job_id, name,
        )
        await self._push_flow_status(
            job_id=str(job_id), connector_id=connector_id, status="running",
            event_kind=EVENT_ARCHIVE, run_id=run.id,
            message=f"🗄️ Archiving candidate {name} from the project…",
        )
        return str(run.id)

    async def save_recommendations(self, job_id, *, count: int = 6,
                                   require_open_to_work: bool = False) -> str | None:
        """Add the job's project RECOMMENDED matches (Automated Sourcing) to the pipeline.
        Resolves the project from prior runs, fires ONE daemon run of the recommendations
        workflow (target_count=count); the terminal hook pushes the added candidates as
        linkedin.lead. Returns the run id, or None if no project/workflow."""
        wf = settings.recruiter_recommendations_workflow_id
        if not wf:
            logger.warning("recruiter pipeline: recruiter_recommendations_workflow_id unset — skip")
            return None
        # Dedup: never stack recommendation runs for the same job. akcr can POST this
        # repeatedly (toggle on-enable + cron + manual button) — only ONE active run at a
        # time, so the seat doesn't churn and the Odoo chatter stays clean.
        if await self._has_active_pipeline_run(job_id, event_kinds={EVENT_RECOMMENDATIONS}):
            logger.info(
                "recruiter pipeline: a recommendations run is already active for job %s — skip (dedup)",
                job_id,
            )
            return None
        ctx = await self._gather_job_context(job_id)
        project_url = ctx.get("project_url")
        connector_id = ctx.get("connector_id")
        if not project_url and ctx.get("project_id"):
            project_url = f"https://www.linkedin.com/talent/hire/{ctx['project_id']}/manage/all"
        if not project_url:
            logger.warning("recruiter pipeline: no project for job %s — can't save recommendations", job_id)
            return None
        m = _PROJECT_URL_RE.search(project_url)
        pipeline = {
            "job_id": str(job_id),
            "connector_id": str(connector_id) if connector_id else None,
            "project_id": m.group(1) if m else ctx.get("project_id"),
            "project_url": project_url,
            "position": ctx.get("position"),
            "project_name": ctx.get("project_name"),
        }
        run = await self._create_pipeline_run(
            workflow_id=wf, event_kind=EVENT_RECOMMENDATIONS,
            runtime_params={"project_url": project_url, "target_count": str(max(1, int(count))),
                            "require_open_to_work": "true" if require_open_to_work else "false"},
            pipeline=pipeline, connector_id=connector_id,
        )
        logger.info("recruiter pipeline: started recommendations run %s for job %s (count=%s)",
                    run.id, job_id, count)
        await self._push_flow_status(
            job_id=str(job_id), connector_id=connector_id, status="running",
            event_kind=EVENT_RECOMMENDATIONS, run_id=run.id,
            message=f"✨ Adding up to {max(1, int(count))} recommended candidate(s) from LinkedIn…",
        )
        return str(run.id)

    # --------------------------------------------------------------- status / preview
    async def pipeline_status(self, job_id) -> dict:
        """Read-only summary of a job's pipeline: the chained runs + the boolean,
        per-search total_count, project URL, and zero-result flag — one call instead
        of polling /runs + pulling snapshots. (origin is JSON → filter in Python.)"""
        result = await self.session.execute(
            select(ExecutionRun).order_by(ExecutionRun.created_at.desc()).limit(500)
        )
        runs, project_url, search_query, zero_results = [], None, None, False
        for r in result.scalars().all():
            o = r.origin or {}
            if o.get("event_kind") not in PIPELINE_EVENT_KINDS:
                continue
            p = o.get("pipeline") or {}
            if str(p.get("job_id")) != str(job_id):
                continue
            project_url = project_url or p.get("project_url")
            if o.get("event_kind") == EVENT_SEARCH:
                search_query = p.get("search_query") or search_query
            zero_results = zero_results or bool(o.get("zero_results"))
            entry = {
                "run_id": str(r.id),
                "event_kind": o.get("event_kind"),
                "status": r.status,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "priority": o.get("priority", 0),
            }
            if o.get("event_kind") == EVENT_SEARCH:
                entry["tightness"] = p.get("search_tightness")
                try:
                    entry["total_count"] = (await self.push.read_search_result(r.id)).get("total_count")
                except Exception:
                    pass
            runs.append(entry)
        runs.reverse()  # chronological
        return {"job_id": str(job_id), "project_url": project_url,
                "search_query": search_query, "zero_results": zero_results, "runs": runs}

    async def preview_count(self, job_id, tightness: int, boolean_query: str | None = None) -> dict:
        """Cheap strictness calibration: fire a COUNT-ONLY search (one page, no 30-candidate
        pagination, no save, no lead push) and return {run_id, boolean, tightness}; poll the
        run's extraction for total_count. The boolean is either built from the JD at `tightness`
        (AI) OR, when `boolean_query` is given, used verbatim — a MANUAL count check with NO AI
        (iterate the boolean's selectivity while OpenAI is unavailable). Count-only is patched
        onto the extract method in this run's snapshot, so no separate workflow is needed."""
        adv_wf = settings.recruiter_advanced_search_workflow_id
        if not adv_wf:
            return {"error": "recruiter_advanced_search_workflow_id unset"}
        ctx = await self._gather_job_context(job_id)
        connector_id = ctx.get("connector_id")
        corpus, title, job_location = await self._fetch_job_corpus(job_id, connector_id)
        if boolean_query and boolean_query.strip():
            query = boolean_query.strip()
            t = None
        else:
            from services.boolean_query_builder import BooleanBuildError, BooleanQueryBuilder
            b = BooleanQueryBuilder()
            try:
                spec = await b.extract_spec(corpus, fallback_title=title)
            except BooleanBuildError as exc:
                return {"error": "ai_unavailable", "detail": str(exc)}
            t = max(0, min(int(tightness), b.max_tightness(spec)))
            query = b.assemble(spec, t)
        params = {"boolean_query": query}
        location = self._resolve_search_location(job_location)
        if location:
            params["location"] = location
        run = await self.exec_svc.create_run(workflow_id=adv_wf, runtime_params=params)
        # No location (global) → prune the location facet block (boolean-only count).
        if not location:
            removed = self._strip_location_facet_steps(run.workflow_snapshot)
            if removed:
                run.total_steps = len(run.workflow_snapshot["steps"])
        # Patch the extract method → count-only (one page, no pagination/collection).
        snap = run.workflow_snapshot or {}
        for st in snap.get("steps", []):
            for mth in (st.get("methods") or []):
                if isinstance(mth, dict) and mth.get("strategy") == "recruiter_search_people":
                    mth["count_only"] = True
        run.workflow_snapshot = snap
        flag_modified(run, "workflow_snapshot")
        run.origin = {
            "connector_id": str(connector_id) if connector_id else None,
            "event_kind": "recruiter_preview_count",  # NOT a pipeline kind → advance() skips (no save)
            "execution_target": "daemon",
            # MUST carry execution_mode (from the snapshot) or the daemon misroutes the
            # run to the generic AI-supervised path instead of the literal recruiter steps.
            "execution_mode": (run.workflow_snapshot or {}).get("workflow", {}).get("execution_mode"),
            "execution_options": {"use_profile": True, "snapshot": False},
            "operator_id": settings.linkedin_operator,
            "target_operator": settings.linkedin_operator,
            "priority": 20,  # quick human-facing feedback → jump the queue
            "runtime_params": params,
            "pipeline": {"job_id": str(job_id)},
        }
        flag_modified(run, "origin")
        await self.session.flush()
        return {"run_id": str(run.id), "boolean": query, "tightness": t}
