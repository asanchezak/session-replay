from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.connector import ConnectorConfig
from core.models.webhook import WebhookTrigger
from core.models.workflow import Workflow
from services.connector_forum_service import ConnectorForumService
from services.execution_service import ExecutionService
from services.template_service import TemplateService
from services.workflow_connector_service import WorkflowConnectorService

EVENT_KIND_NEW_JOB_POSITION = "new_job_position"
SUPPORTED_EVENT_KINDS = {EVENT_KIND_NEW_JOB_POSITION}


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
        triggers = [
            t
            for t in await self.list_triggers(connector_id=connector_id)
            if t.enabled and t.event_kind == EVENT_KIND_NEW_JOB_POSITION
        ]
        connector = await self._get_connector_or_raise(connector_id)
        odoo_base = (connector.config.get("url") or "").rstrip("/")
        raw_job_id = str(payload.get("job_id") or payload.get("id") or "")
        job_data = {
            "job_id": raw_job_id,
            "job_title": str(payload.get("job_title") or payload.get("name") or ""),
            "job_description": str(
                payload.get("description") or payload.get("job_description") or ""
            ),
            "job_url": str(
                payload.get("url")
                or payload.get("job_url")
                or (f"{odoo_base}/web#action=recruitment&id={raw_job_id}" if odoo_base and raw_job_id else "")
            ),
        }
        run_ids: list[str] = []
        for trigger in triggers:
            run_id = await self._fire(trigger.workflow_id, job_data)
            if run_id:
                run_ids.append(run_id)
        return run_ids

    async def trigger_now(
        self, workflow_id: str, connector_id: str, job_url: str | None = None
    ) -> dict:
        """Manual test trigger: resolve latest Odoo job, optionally override job_url."""
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
        job_data = {
            "job_id": latest["job_id"],
            "job_title": latest["job_title"],
            "job_description": latest["job_description"],
            "job_url": job_url or auto_url,
        }
        run_id = await self._fire(workflow_id, job_data)
        return {"run_id": run_id, "resolved_params": job_data}

    async def _fire(self, workflow_id: str, job_data: dict) -> str | None:
        """Render all enabled connector bindings with job_data, build plan, create and start run."""
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
        from core.state_machine import RunStatus
        run = await exec_svc.transition(str(run.id), RunStatus.RUNNING)
        return str(run.id)

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
