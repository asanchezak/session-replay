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
EVENT_ARCHIVE = "recruiter_archive"
EVENT_RECOMMENDATIONS = "recruiter_recommendations"
PIPELINE_EVENT_KINDS = {
    EVENT_CREATE_PROJECT, EVENT_SEARCH, EVENT_SAVE, EVENT_MESSAGE, EVENT_ARCHIVE,
    EVENT_RECOMMENDATIONS,
}

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
        if event_kind == EVENT_ARCHIVE:
            return await self._after_archive(run, pipeline, connector_id, job_id)
        if event_kind == EVENT_RECOMMENDATIONS:
            return await self._after_recommendations(run, pipeline, connector_id, job_id)
        return {"skipped": "unknown_event_kind", "event_kind": event_kind}

    async def _after_recommendations(self, run, pipeline, connector_id, job_id) -> dict:
        """Terminal hook: the recommended matches were added to the LinkedIn project —
        push them to Odoo as linkedin.lead (the strategy posted them under `people`, so
        the SAME collector as search→save ingests them)."""
        lead_res = await self.push.push_recruiter_leads(
            run_id=run.id, job_id=job_id, connector_id=connector_id
        )
        logger.info(
            "recruiter pipeline: recommendations for job %s → pushed %s lead(s)",
            job_id, lead_res.get("pushed"),
        )
        return {"stage": "recommendations", "done": True,
                "pushed": lead_res.get("pushed"), "leads": len(lead_res.get("leads") or [])}

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
            corpus, title, job_location = await self._fetch_job_corpus(job_id, connector_id)
            built = await BooleanQueryBuilder().build(
                corpus, fallback_title=title or pipeline.get("position", ""),
                start_tightness=settings.recruiter_search_start_tightness,
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
            run_id=run.id, job_id=job_id, connector_id=connector_id
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
        # GATED: only record outreach in Odoo when the message was actually SENT.
        # A gated preview (send=false) types + stops — nothing was sent, so don't mark.
        compose = await self.push.read_message_compose_result(run.id)
        if not pipeline.get("send") or not compose.get("sent"):
            logger.info(
                "recruiter pipeline: message preview for job %s (send=%s sent=%s) — "
                "no Odoo outreach update", job_id, pipeline.get("send"), compose.get("sent"),
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
        return {"stage": "message", "sent": True, "outreach": res}

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
        return {"stage": "archive", "removed": True, "archive": archive, "odoo": res}

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

        Recipients are whoever is ACTIVE in the project at send time (the compose
        strategy selects them + reports them back); we no longer rely on the prior
        save-run history for the recipient set.
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
            "subject": subject,
            "send": bool(send),
        }
        run = await self._create_pipeline_run(
            workflow_id=wf,
            event_kind=EVENT_MESSAGE,
            runtime_params={
                "project_url": project_url,
                "subject": subject,
                "body": body,
                "send": "true" if send else "false",
            },
            pipeline=pipeline_ctx,
            connector_id=ctx.get("connector_id"),
        )
        logger.info(
            "recruiter pipeline: started message-compose run %s for job %s (send=%s)",
            run.id, job_id, send,
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
        return str(run.id)

    async def save_recommendations(self, job_id, *, count: int = 10,
                                   require_open_to_work: bool = False) -> str | None:
        """Add the job's project RECOMMENDED matches (Automated Sourcing) to the pipeline.
        Resolves the project from prior runs, fires ONE daemon run of the recommendations
        workflow (target_count=count); the terminal hook pushes the added candidates as
        linkedin.lead. Returns the run id, or None if no project/workflow."""
        wf = settings.recruiter_recommendations_workflow_id
        if not wf:
            logger.warning("recruiter pipeline: recruiter_recommendations_workflow_id unset — skip")
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
        }
        run = await self._create_pipeline_run(
            workflow_id=wf, event_kind=EVENT_RECOMMENDATIONS,
            runtime_params={"project_url": project_url, "target_count": str(max(1, int(count))),
                            "require_open_to_work": "true" if require_open_to_work else "false"},
            pipeline=pipeline, connector_id=connector_id,
        )
        logger.info("recruiter pipeline: started recommendations run %s for job %s (count=%s)",
                    run.id, job_id, count)
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

    async def preview_count(self, job_id, tightness: int) -> dict:
        """Cheap strictness calibration: build the boolean from the job's JD at the
        given tightness and fire a COUNT-ONLY search (one page, no 30-candidate
        pagination, no save, no lead push). Returns {run_id, boolean, tightness};
        poll the run's extraction for total_count. The count-only flag is patched onto
        the extract method in this run's snapshot, so no separate workflow is needed."""
        adv_wf = settings.recruiter_advanced_search_workflow_id
        if not adv_wf:
            return {"error": "recruiter_advanced_search_workflow_id unset"}
        ctx = await self._gather_job_context(job_id)
        connector_id = ctx.get("connector_id")
        corpus, title, job_location = await self._fetch_job_corpus(job_id, connector_id)
        from services.boolean_query_builder import BooleanQueryBuilder
        b = BooleanQueryBuilder()
        spec = await b.extract_spec(corpus, fallback_title=title)
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
