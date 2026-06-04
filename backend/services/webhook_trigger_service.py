from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from core.config import settings
from core.models.connector import ConnectorConfig
from core.models.run import ExecutionRun
from core.models.webhook import WebhookTrigger
from core.state_machine import RunStatus
from services.connector_forum_service import ConnectorForumService
from services.execution_service import ExecutionService
from services.template_service import TemplateService
from services.workflow_connector_service import WorkflowConnectorService, _short_description

EVENT_KIND_NEW_JOB_POSITION = "new_job_position"
# Lightweight "lead sourcing" flow: same Odoo position-publish payload, but the
# run only collects name+headline+profile_url from the first 2 search pages
# (no profile visits) and pushes them to Odoo as linkedin.lead rows. Which of
# these two event kinds actually fires is decided by which WebhookTrigger row is
# enabled for the connector (see seed_linkedin_lead_search_bindings.py).
EVENT_KIND_LINKEDIN_LEAD = "linkedin_lead_search"
SUPPORTED_EVENT_KINDS = {EVENT_KIND_NEW_JOB_POSITION, EVENT_KIND_LINKEDIN_LEAD}

# A run in any of these statuses is still "live" — the single daemon is or will
# be driving it. trigger-now refuses to pile a second run on top so testers
# don't burn the shared LinkedIn budget on duplicate scrapes (see the plan's
# "Guard de run activo"). Terminal states (completed/failed/canceled) don't count.
NON_TERMINAL_STATUSES = (
    RunStatus.QUEUED.value,
    RunStatus.RUNNING.value,
    RunStatus.WAITING_FOR_USER.value,
    RunStatus.RECOVERING.value,
)


class ActiveRunConflictError(Exception):
    """Raised when a manual trigger is rejected because the workflow already
    has a non-terminal run in flight. Carries the existing run id."""

    def __init__(self, run_id: str):
        self.run_id = run_id
        super().__init__(f"Workflow already has an active run ({run_id}).")


class WebhookTriggerService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.connector_forum = ConnectorForumService(session)
        self.wc_service = WorkflowConnectorService(session)

    async def create_trigger(
        self, connector_id: str, workflow_id: str, event_kind: str
    ) -> WebhookTrigger:
        if event_kind not in SUPPORTED_EVENT_KINDS:
            raise ValueError(f"Unsupported event_kind '{event_kind}'.")
        existing = await self._find_trigger(connector_id, workflow_id, event_kind)
        if existing:
            existing.enabled = True
            await self.session.flush()
            return existing
        trigger = WebhookTrigger(
            connector_id=connector_id,
            workflow_id=workflow_id,
            event_kind=event_kind,
        )
        self.session.add(trigger)
        await self.session.flush()
        return trigger

    async def list_triggers(
        self,
        workflow_id: str | None = None,
        connector_id: str | None = None,
    ) -> list[WebhookTrigger]:
        q = select(WebhookTrigger)
        if workflow_id:
            q = q.where(WebhookTrigger.workflow_id == workflow_id)
        if connector_id:
            q = q.where(WebhookTrigger.connector_id == connector_id)
        result = await self.session.execute(q.order_by(WebhookTrigger.created_at.desc()))
        return list(result.scalars().all())

    async def delete_trigger(self, trigger_id: str) -> bool:
        try:
            uid = uuid.UUID(trigger_id)
        except ValueError:
            return False
        result = await self.session.execute(
            select(WebhookTrigger).where(WebhookTrigger.id == uid)
        )
        trigger = result.scalar_one_or_none()
        if trigger is None:
            return False
        await self.session.delete(trigger)
        await self.session.flush()
        return True

    async def fire_from_odoo_payload(self, connector_id: str, payload: dict) -> list[str]:
        """Process incoming Odoo webhook; fire all enabled triggers. Returns created run IDs."""
        # Fire whichever enabled trigger the connector has, across all supported
        # event kinds. The same Odoo position-publish webhook drives either the
        # applicant scraper (new_job_position) or the lead sourcer
        # (linkedin_lead_search), depending on which trigger row is enabled.
        triggers = [
            t
            for t in await self.list_triggers(connector_id=connector_id)
            if t.enabled and t.event_kind in SUPPORTED_EVENT_KINDS
        ]
        connector = await self._get_connector_or_raise(connector_id)
        odoo_base = (connector.config.get("url") or "").rstrip("/")
        raw_job_id = str(payload.get("job_id") or payload.get("id") or "")

        # Resolve job_url: prefer explicit url fields, then website_url (make absolute),
        # then fall back to Odoo admin URL built from job_id.
        raw_website_url = str(payload.get("website_url") or "")
        if raw_website_url and not raw_website_url.startswith("http"):
            raw_website_url = f"{odoo_base}{raw_website_url}"
        job_url = (
            str(payload.get("apply_url") or payload.get("url") or payload.get("job_url") or "")
            or raw_website_url
            or (f"{odoo_base}/web#action=recruitment&id={raw_job_id}" if odoo_base and raw_job_id else "")
        )

        # Resolve description: if absent from payload, fetch from Odoo by job_id.
        raw_description = str(payload.get("description") or payload.get("job_description") or "")
        if not raw_description and raw_job_id:
            raw_description = await self._fetch_job_description(connector, raw_job_id)

        # candidate_count: per-fire knob. Optional in the payload; if a
        # WorkflowConnectorBinding's template references {candidate_count},
        # this value substitutes in. Defaults to 2 when not provided.
        raw_count = payload.get("candidate_count") or payload.get("count")
        try:
            candidate_count = int(raw_count) if raw_count is not None else 2
        except (TypeError, ValueError):
            candidate_count = 2
        # Anti-bot: cap how many profiles one webhook can request in a single
        # burst. 25 profiles × ~3 page loads each is a reckless spike that
        # tripped LinkedIn's wall; 8 is a sane ceiling. Per-profile extraction
        # is unaffected (full data still captured for each profile visited).
        candidate_count = max(1, min(candidate_count, 8))

        job_data = {
            "job_id": raw_job_id,
            "job_title": str(payload.get("job_title") or payload.get("name") or ""),
            "job_description": raw_description,
            "job_description_short": _short_description(raw_description),
            "job_url": job_url,
            "department": str(payload.get("department") or ""),
            "company": str(payload.get("company") or ""),
            "job_location": str(payload.get("job_location") or ""),
            "seniority_level": str(payload.get("seniority_level") or ""),
            "employment_model": str(payload.get("employment_model") or ""),
            "internal_area": str(payload.get("internal_area") or ""),
            "candidate_count": str(candidate_count),
        }
        run_ids: list[str] = []
        for trigger in triggers:
            run_id = await self._fire(trigger, job_data)
            if run_id:
                run_ids.append(run_id)
                trigger.last_job_payload = job_data
                trigger.last_fired_at = datetime.now(UTC)
                flag_modified(trigger, "last_job_payload")
                await self.session.flush()
        return run_ids

    async def _fetch_job_description(self, connector: ConnectorConfig, job_id: str) -> str:
        """Fetch the description of a specific job from Odoo by ID."""
        try:
            from adapters.odoo.adapter import OdooAdapter
            from adapters.registry import get_adapter
            try:
                adapter_cls = get_adapter(connector.connector_type)
            except ValueError:
                adapter_cls = OdooAdapter
            adapter = adapter_cls()
            await adapter.initialize(connector.config)
            try:
                records = await adapter.list(
                    "job",
                    filters={"id": int(job_id)},
                    limit=1,
                    fields=["id", "name", "description", "website_description", "requirements"],
                )
                if records:
                    r = records[0]
                    raw = str(
                        r.get("description") or r.get("website_description") or r.get("requirements") or ""
                    )
                    from services.connector_forum_service import ConnectorForumService
                    return ConnectorForumService._strip_html(raw)
            finally:
                await adapter.dispose()
        except Exception:
            pass
        return ""

    async def trigger_now(
        self,
        workflow_id: str,
        connector_id: str,
        job_url: str | None = None,
        execution_options: dict | None = None,
        idempotency_key: str | None = None,
        triggered_by: str | None = None,
    ) -> dict:
        """Manual test trigger: resolve latest Odoo job, optionally override job_url.

        Two guards protect the shared LinkedIn account:
        - idempotency_key: re-firing the same logical request returns the prior
          run instead of creating a duplicate.
        - active-run guard: refuses to start a second run while the workflow
          already has one in flight (the single daemon serializes anyway, and a
          pile of runs just wastes the daily budget).
        """
        if idempotency_key:
            existing = await self._find_run_by_idempotency_key(workflow_id, idempotency_key)
            if existing is not None:
                return {
                    "run_id": str(existing.id),
                    "status": "duplicate",
                    "idempotency_key": idempotency_key,
                }

        active = await self._find_active_run(workflow_id)
        if active is not None:
            raise ActiveRunConflictError(str(active.id))

        connector = await self._get_connector_or_raise(connector_id)
        jobs = await self.connector_forum.fetch_jobs(connector, limit=25)
        if not jobs:
            raise ValueError("No jobs are available in this connector.")

        def _sort_key(j: dict) -> tuple[int, str]:
            raw = str(j.get("job_id") or "")
            return (int(raw) if raw.isdigit() else -1, raw)

        latest = sorted(jobs, key=_sort_key, reverse=True)[0]
        odoo_base = (connector.config.get("url") or "").rstrip("/")
        auto_url = (
            f"{odoo_base}/web#action=recruitment&id={latest['job_id']}"
            if odoo_base
            else ""
        )
        full_desc = latest["job_description"]
        job_data = {
            "job_id": latest["job_id"],
            "job_title": latest["job_title"],
            "job_description": full_desc,
            "job_description_short": _short_description(full_desc),
            "job_url": job_url or auto_url,
            "department": "",
            "company": "",
            "job_location": "",
            "seniority_level": "",
            "employment_model": "",
            "internal_area": "",
            # candidate_count: per-fire knob; the flat-payload webhook path sets it
            # from the payload (default 2). trigger_now has no payload count, so
            # mirror that default here so templates using {candidate_count} render.
            "candidate_count": "2",
        }
        # Use the real configured trigger so the run's event_kind matches the
        # workflow's flow (e.g. linkedin_lead_search), not a hardcoded default.
        # The daemon branches on origin.event_kind, so mislabeling a lead-search
        # run as new_job_position drives the wrong flow (applicant for-each on a
        # lead plan → "Step N not in snapshot").
        configured = await self.list_triggers(workflow_id=workflow_id, connector_id=connector_id)
        trigger = configured[0] if configured else WebhookTrigger(
            connector_id=connector_id,
            workflow_id=workflow_id,
            event_kind=EVENT_KIND_NEW_JOB_POSITION,
        )
        run_id = await self._fire(
            trigger,
            job_data,
            execution_options=execution_options,
            idempotency_key=idempotency_key,
            triggered_by=triggered_by,
        )
        return {"run_id": run_id, "resolved_params": job_data}

    async def replay_last(self, trigger_id: str) -> dict:
        """Re-fire a trigger using the last job payload it received."""
        try:
            uid = uuid.UUID(trigger_id)
        except ValueError as exc:
            raise ValueError("Trigger not found.") from exc
        result = await self.session.execute(
            select(WebhookTrigger).where(WebhookTrigger.id == uid)
        )
        trigger = result.scalar_one_or_none()
        if trigger is None:
            raise ValueError("Trigger not found.")
        if not trigger.last_job_payload:
            raise ValueError("No previous job recorded for this trigger. Fire the webhook at least once first.")
        run_id = await self._fire(trigger, trigger.last_job_payload)
        return {"run_id": run_id, "replayed_from": trigger.last_fired_at.isoformat() if trigger.last_fired_at else None, "job_data": trigger.last_job_payload}

    async def _fire(
        self,
        trigger: WebhookTrigger,
        job_data: dict,
        execution_options: dict | None = None,
        idempotency_key: str | None = None,
        triggered_by: str | None = None,
    ) -> str | None:
        """Render all enabled connector bindings with job_data, build plan, create and start run."""
        workflow_id = trigger.workflow_id
        bindings = await self.wc_service.list_bindings(workflow_id)
        runtime_params: dict[str, str] = {}
        for binding in bindings:
            if not binding.enabled:
                continue
            try:
                runtime_params[binding.parameter_key] = binding.template.format(**job_data).strip()
            except KeyError:
                # Fall back to connector-resolved value if job_data is missing a placeholder
                try:
                    preview = await self.wc_service.preview_binding(workflow_id, binding.parameter_key)
                    runtime_params[binding.parameter_key] = preview["resolved_value"]
                except Exception:
                    pass

        template_svc = TemplateService(self.session)
        execution_plan = await template_svc.build_execution_plan(workflow_id, runtime_params)

        exec_svc = ExecutionService(self.session)
        run = await exec_svc.create_run(workflow_id=workflow_id, execution_plan=execution_plan)
        run.origin = {
            "connector_id": str(trigger.connector_id) if trigger.connector_id else None,
            "event_kind": trigger.event_kind,
            "trigger_id": str(trigger.id) if trigger.id else None,
            "job_payload": job_data,
            # Daemon decides hardcoded-vs-generic per run from this (sourced from
            # the workflow, stamped into the snapshot by create_run).
            "execution_mode": (run.workflow_snapshot or {}).get("workflow", {}).get("execution_mode"),
            # QA testing knobs (default empty for production webhook/replay fires):
            # execution_options.{mode,max_candidates,push_to_odoo,label_outputs}
            # is read by the daemon (scrape cap + test tagging) and the push hook.
            "execution_options": execution_options or {},
            "idempotency_key": idempotency_key,
            "triggered_by": triggered_by,
            # Routing: LinkedIn flows always run on the LinkedIn operator's daemon
            # (Fernanda's host holds the session), regardless of who triggered them.
            "target_operator": (
                settings.linkedin_operator
                if trigger.event_kind in SUPPORTED_EVENT_KINDS
                else None
            ),
        }
        flag_modified(run, "origin")
        await self.session.flush()
        # Leave the run in QUEUED (its birth state from create_run). The single
        # daemon claims it (QUEUED→RUNNING via POST /runs/{id}/start) when it is
        # ready to drive. Resting in QUEUED is what lets a backlog built up while
        # the daemon host was offline survive: the daemon's pickup is no longer
        # gated on a 30-min "freshness" window, and FIFO ordering is well-defined.
        return str(run.id)

    async def _find_active_run(self, workflow_id: str) -> ExecutionRun | None:
        """Most recent non-terminal run for the workflow, if any."""
        result = await self.session.execute(
            select(ExecutionRun)
            .where(
                ExecutionRun.workflow_id == workflow_id,
                ExecutionRun.status.in_(NON_TERMINAL_STATUSES),
            )
            .order_by(ExecutionRun.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def _find_run_by_idempotency_key(
        self, workflow_id: str, idempotency_key: str
    ) -> ExecutionRun | None:
        """Find a prior run created with the same idempotency_key. Scans the
        workflow's recent runs in Python to stay dialect-agnostic (origin is a
        JSON column; idempotency lookups are rare manual-trigger events)."""
        result = await self.session.execute(
            select(ExecutionRun)
            .where(ExecutionRun.workflow_id == workflow_id)
            .order_by(ExecutionRun.created_at.desc())
            .limit(50)
        )
        for run in result.scalars().all():
            if (run.origin or {}).get("idempotency_key") == idempotency_key:
                return run
        return None

    async def _find_run_by_job_id(self, job_id: str) -> ExecutionRun | None:
        """Most recent run whose origin job_payload carries this job_id, if any.

        The reconciler uses this to avoid enqueuing a second run for a position
        that the webhook (or a prior reconcile pass) already handled — one
        position → one flow. Scans recent runs in Python because origin is a JSON
        column and reconcile volume is low (a handful of positions per day)."""
        job_id = str(job_id or "")
        if not job_id:
            return None
        result = await self.session.execute(
            select(ExecutionRun)
            .order_by(ExecutionRun.created_at.desc())
            .limit(200)
        )
        for run in result.scalars().all():
            payload = (run.origin or {}).get("job_payload") or {}
            if str(payload.get("job_id") or "") == job_id:
                return run
        return None

    async def _find_trigger(
        self, connector_id: str, workflow_id: str, event_kind: str
    ) -> WebhookTrigger | None:
        result = await self.session.execute(
            select(WebhookTrigger).where(
                WebhookTrigger.connector_id == connector_id,
                WebhookTrigger.workflow_id == workflow_id,
                WebhookTrigger.event_kind == event_kind,
            )
        )
        return result.scalar_one_or_none()

    async def _get_connector_or_raise(self, connector_id: str) -> ConnectorConfig:
        try:
            uid = uuid.UUID(connector_id)
        except ValueError as exc:
            raise ValueError("Connector not found.") from exc
        result = await self.session.execute(
            select(ConnectorConfig).where(ConnectorConfig.id == uid)
        )
        connector = result.scalar_one_or_none()
        if connector is None:
            raise ValueError("Connector not found.")
        return connector
