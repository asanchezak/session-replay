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
PIPELINE_EVENT_KINDS = {EVENT_CREATE_PROJECT, EVENT_SEARCH, EVENT_SAVE, EVENT_MESSAGE}

_NON_TERMINAL = (
    RunStatus.QUEUED.value,
    RunStatus.RUNNING.value,
    RunStatus.WAITING_FOR_USER.value,
    RunStatus.RECOVERING.value,
)
_PROJECT_URL_RE = re.compile(r"/talent/hire/(\d+)")
# Prefix marking projects this automation created (so they're findable/cleanable).
PROJECT_NAME_PREFIX = "-EZ "
# Max chars to type into the LinkedIn project "Descripción del proyecto" textarea.
_PROJECT_DESC_MAX = 2000
# Default outreach copy for req B (send_messages); overridable per call.
DEFAULT_MESSAGE_SUBJECT = "Oportunidad en Akurey"
DEFAULT_MESSAGE_BODY = (
    "Hola, ¡espero que estés muy bien! Te escribo desde Akurey porque tu perfil "
    "nos llamó la atención para una posición que tenemos abierta. ¿Te interesaría "
    "que conversemos? ¡Saludos!"
)


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
        pipeline: dict, connector_id,
    ) -> ExecutionRun:
        """Create a QUEUED daemon run for the next pipeline step.

        Mirrors WebhookTriggerService._fire's origin shape but for the generic
        daemon path: execution_target=daemon + target_operator=linkedin_operator
        (so the daemon claims it) + use_profile (the warm Recruiter seat).
        runtime_params are substituted into the snapshot by create_run.
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

    async def _has_active_pipeline_run(self, job_id) -> bool:
        """Avoid duplicate concurrent pipelines for the same position. Scans recent
        non-terminal runs (origin is JSON → filter in Python; rare event)."""
        result = await self.session.execute(
            select(ExecutionRun)
            .where(ExecutionRun.status.in_(_NON_TERMINAL))
            .order_by(ExecutionRun.created_at.desc())
            .limit(300)
        )
        for r in result.scalars().all():
            o = r.origin or {}
            if o.get("event_kind") in PIPELINE_EVENT_KINDS:
                if str((o.get("pipeline") or {}).get("job_id")) == str(job_id):
                    return True
        return False

    # -------------------------------------------------------------------- start
    async def start(self, connector_id, job_payload: dict) -> str | None:
        """Kick off the pipeline for a new position: create the -EZ project run."""
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
        # The Odoo job description → the LinkedIn project's "Descripción del proyecto"
        # textarea. job_payload.job_description is already HTML-stripped (fetch_jobs).
        # Cap it so we don't overflow the textarea on very long JDs.
        job_description = str(job_payload.get("job_description") or "").strip()
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
        return str(run.id)

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
            # Terminal: candidate is in the project. Message-send is manual/gated.
            logger.info(
                "recruiter pipeline: save complete for job %s candidate %s",
                job_id, pipeline.get("candidate_url"),
            )
            return {"stage": "save", "done": True}
        if event_kind == EVENT_MESSAGE:
            return await self._after_message(run, pipeline, connector_id, job_id)
        return {"skipped": "unknown_event_kind", "event_kind": event_kind}

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
            from services.boolean_query_builder import BooleanQueryBuilder
            corpus, title = await self._fetch_job_corpus(job_id, connector_id)
            built = await BooleanQueryBuilder().build(
                corpus, fallback_title=title or pipeline.get("position", "")
            )
            pipeline["search_spec"] = built["spec"]
            pipeline["search_tightness"] = built["tightness"]
            pipeline["search_query"] = built["query"]
            pipeline["search_reruns"] = 0
            logger.info(
                "recruiter pipeline: boolean for job %s (t=%s): %s",
                job_id, built["tightness"], built["query"],
            )
            search_params = {"boolean_query": built["query"]}
            if settings.recruiter_default_location:
                search_params["location"] = settings.recruiter_default_location
            search_run = await self._create_pipeline_run(
                workflow_id=adv_wf, event_kind=EVENT_SEARCH,
                runtime_params=search_params,
                pipeline=pipeline, connector_id=connector_id,
            )
            return {"stage": "create_project", "project_link": link_res,
                    "next_run": str(search_run.id), "boolean": built["query"]}

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
        return {
            "stage": "create_project",
            "project_link": link_res,
            "next_run": str(search_run.id),
        }

    async def _fetch_job_corpus(self, job_id, connector_id) -> tuple[str, str]:
        """Assemble the JD corpus (title + description + requirements) from Odoo for
        the AI boolean builder. Best-effort → returns (corpus, title)."""
        from adapters.odoo.adapter import OdooAdapter
        from services.connector_forum_service import ConnectorForumService

        def strip(v):
            return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", str(v or ""))).strip()

        title, parts = "", []
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
                    "seniority_level", "experience_years",
                ])
                j = jobs[0] if jobs else {}
                title = j.get("name") or ""
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
        return "\n".join(p for p in parts if p), title

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
            run_id=run.id, job_id=job_id, connector_id=connector_id
        )
        candidates = lead_res.get("leads") or []

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
        search_url = result.get("url")
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
        return {"stage": "search", "leads": lead_res, "save_runs": save_runs}

    async def _after_message(self, run, pipeline, connector_id, job_id) -> dict:
        # Req B: record that the job's candidates were messaged → Odoo
        # outreach_status=messaged (via linkedin.lead.message).
        messaged = pipeline.get("messaged") or []
        res = await self.push.push_outreach_update(
            run_id=run.id, job_id=job_id, connector_id=connector_id, messaged=messaged,
        )
        logger.info("recruiter pipeline: outreach update for job %s — %s", job_id, res)
        return {"stage": "message", "outreach": res}

    async def _gather_job_context(self, job_id) -> dict:
        """Reconstruct a job's pipeline context from its prior runs: connector +
        project + the candidates actually SAVED (completed save runs)."""
        result = await self.session.execute(
            select(ExecutionRun).order_by(ExecutionRun.created_at.desc()).limit(500)
        )
        ctx = {"connector_id": None, "project_id": None, "project_url": None,
               "project_name": None, "saved": []}
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
            if o.get("event_kind") == EVENT_SAVE and r.status == RunStatus.COMPLETED.value:
                url = p.get("candidate_url")
                if url and url not in seen:
                    seen.add(url)
                    ctx["saved"].append({"profile_url": url})
        return ctx

    async def send_messages(self, job_id, subject: str | None = None,
                            body: str | None = None) -> str | None:
        """Deliberate (manual/gated) req B trigger: bulk-message a job's saved
        candidates, recording it in Odoo on completion. ⚠️ SENDS real InMail.

        Reconstructs the job's project + saved candidates from prior pipeline runs,
        then fires a recruiter_message run (stamped with job_id + the recipients).
        The transition terminal hook → _after_message → push_outreach_update.
        """
        wf = settings.recruiter_message_workflow_id
        if not wf:
            logger.warning("recruiter pipeline: recruiter_message_workflow_id unset — skip")
            return None
        ctx = await self._gather_job_context(job_id)
        if not ctx.get("project_id"):
            logger.warning("recruiter pipeline: no project for job %s — can't message", job_id)
            return None
        recipients = ctx.get("saved") or []
        if not recipients:
            logger.warning(
                "recruiter pipeline: no saved candidates for job %s — nothing to message",
                job_id,
            )
            return None
        subject = (subject or DEFAULT_MESSAGE_SUBJECT).strip()
        body = (body or DEFAULT_MESSAGE_BODY).strip()
        pipeline_url = (
            f"https://www.linkedin.com/talent/hire/{ctx['project_id']}/manage/all"
        )
        messaged = [
            {**m, "subject": subject, "body": body, "message_type": "inmail"}
            for m in recipients
        ]
        pipeline_ctx = {
            "job_id": str(job_id),
            "connector_id": ctx.get("connector_id"),
            "project_id": ctx.get("project_id"),
            "messaged": messaged,
            "subject": subject,
        }
        run = await self._create_pipeline_run(
            workflow_id=wf,
            event_kind=EVENT_MESSAGE,
            runtime_params={"pipeline_url": pipeline_url, "subject": subject, "body": body},
            pipeline=pipeline_ctx,
            connector_id=ctx.get("connector_id"),
        )
        logger.info(
            "recruiter pipeline: started message run %s for job %s (%d recipients)",
            run.id, job_id, len(messaged),
        )
        return str(run.id)
