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
PIPELINE_EVENT_KINDS = {EVENT_CREATE_PROJECT, EVENT_SEARCH, EVENT_SAVE}

_NON_TERMINAL = (
    RunStatus.QUEUED.value,
    RunStatus.RUNNING.value,
    RunStatus.WAITING_FOR_USER.value,
    RunStatus.RECOVERING.value,
)
_PROJECT_URL_RE = re.compile(r"/talent/hire/(\d+)")
# Prefix marking projects this automation created (so they're findable/cleanable).
PROJECT_NAME_PREFIX = "-EZ "


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
            runtime_params={"position": position},
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

        search_wf = settings.recruiter_search_workflow_id
        if not search_wf:
            logger.warning(
                "recruiter pipeline: search workflow unset — stopping after create-project"
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

    async def _after_search(self, run, pipeline, connector_id, job_id) -> dict:
        # Requirement A: candidates → linkedin.lead. Returns the collected
        # candidates under "leads" even if the Odoo POST is skipped.
        lead_res = await self.push.push_recruiter_leads(
            run_id=run.id, job_id=job_id, connector_id=connector_id
        )
        candidates = lead_res.get("leads") or []

        # Cap how many we auto-save (each save is its own daemon run).
        cap = settings.recruiter_max_saves_per_position or 0
        pcount = pipeline.get("candidate_count") or 0
        if cap and pcount:
            limit = min(cap, pcount)
        elif cap:
            limit = cap
        elif pcount:
            limit = pcount
        else:
            limit = len(candidates)
        to_save = candidates[:limit] if limit else candidates

        save_wf = settings.recruiter_save_workflow_id
        project_name = pipeline.get("project_name", "")
        save_runs: list[str] = []
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
        elif not save_wf:
            logger.warning(
                "recruiter pipeline: recruiter_save_workflow_id unset — leads pushed, "
                "candidates NOT auto-saved to the project"
            )
        return {"stage": "search", "leads": lead_res, "save_runs": save_runs}
