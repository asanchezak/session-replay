from __future__ import annotations

import uuid
from string import Formatter


def _short_description(text: str, max_chars: int = 300) -> str:
    """Return the first paragraph of text, capped at max_chars."""
    first_para = (text.split("\n\n")[0] if "\n\n" in text else text).strip()
    if len(first_para) <= max_chars:
        return first_para
    cut = first_para[:max_chars]
    last_space = cut.rfind(" ")
    return (cut[:last_space] if last_space > 0 else cut) + "…"

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.analysis import WorkflowConnectorBinding, WorkflowParameter
from core.models.connector import ConnectorConfig
from services.connector_forum_service import ConnectorForumService


class WorkflowConnectorService:
    SOURCE_KIND_ODOO_LATEST_JOB = "odoo_latest_job"
    SUPPORTED_SOURCE_KINDS = {SOURCE_KIND_ODOO_LATEST_JOB}
    TEMPLATE_FIELDS = {
        "job_id", "job_title", "job_description", "job_description_short", "job_url",
        "department", "company", "job_location",
        "seniority_level", "employment_model", "internal_area", "candidate_count",
    }

    def __init__(self, session: AsyncSession):
        self.session = session
        self.connector_forum = ConnectorForumService(session)

    async def delete_binding(self, workflow_id: str, parameter_key: str) -> bool:
        binding = await self.get_binding(workflow_id, parameter_key)
        if binding is None:
            return False
        await self.session.delete(binding)
        await self.session.flush()
        return True

    async def list_bindings(self, workflow_id: str) -> list[WorkflowConnectorBinding]:
        result = await self.session.execute(
            select(WorkflowConnectorBinding)
            .where(WorkflowConnectorBinding.workflow_id == workflow_id)
            .order_by(WorkflowConnectorBinding.parameter_key)
        )
        return list(result.scalars().all())

    async def get_binding(self, workflow_id: str, parameter_key: str) -> WorkflowConnectorBinding | None:
        result = await self.session.execute(
            select(WorkflowConnectorBinding).where(
                WorkflowConnectorBinding.workflow_id == workflow_id,
                WorkflowConnectorBinding.parameter_key == parameter_key,
            )
        )
        return result.scalar_one_or_none()

    async def save_binding(
        self,
        workflow_id: str,
        parameter_key: str,
        *,
        connector_id: str,
        source_kind: str,
        template: str,
        job_filters: dict | None,
        enabled: bool,
    ) -> WorkflowConnectorBinding:
        if source_kind not in self.SUPPORTED_SOURCE_KINDS:
            raise ValueError(f"Unsupported source_kind '{source_kind}'.")
        self._validate_template(template)
        await self._ensure_parameter_exists(workflow_id, parameter_key)
        await self._get_connector_or_raise(connector_id)

        binding = await self.get_binding(workflow_id, parameter_key)
        if binding is None:
            binding = WorkflowConnectorBinding(
                workflow_id=workflow_id,
                parameter_key=parameter_key,
                connector_id=connector_id,
            )
            self.session.add(binding)

        binding.connector_id = connector_id
        binding.source_kind = source_kind
        binding.template = template.strip()
        binding.job_filters = job_filters or {}
        binding.enabled = enabled
        await self.session.flush()
        return binding

    async def preview_binding(
        self,
        workflow_id: str,
        parameter_key: str,
        *,
        connector_id: str | None = None,
        source_kind: str | None = None,
        template: str | None = None,
        job_filters: dict | None = None,
        enabled: bool | None = None,
    ) -> dict:
        binding = await self.get_binding(workflow_id, parameter_key)
        if binding is None and (connector_id is None or source_kind is None or template is None):
            raise ValueError(f"No connector binding found for parameter '{parameter_key}'.")

        effective_connector_id = connector_id or (binding.connector_id if binding else None)
        effective_source_kind = source_kind or (binding.source_kind if binding else None)
        effective_template = template or (binding.template if binding else None)
        effective_job_filters = job_filters if job_filters is not None else (binding.job_filters if binding else {})
        effective_enabled = enabled if enabled is not None else (binding.enabled if binding else True)

        if not effective_enabled:
            raise ValueError("This connector binding is disabled.")
        if not effective_connector_id or not effective_source_kind or not effective_template:
            raise ValueError("Connector preview requires connector_id, source_kind, and template.")
        if effective_source_kind not in self.SUPPORTED_SOURCE_KINDS:
            raise ValueError(f"Unsupported source_kind '{effective_source_kind}'.")

        self._validate_template(effective_template)
        connector = await self._get_connector_or_raise(effective_connector_id)
        source_record = await self._resolve_source_record(
            connector,
            effective_source_kind,
            effective_job_filters or {},
        )
        rendered = self._render_template(effective_template, source_record)
        return {
            "parameter_key": parameter_key,
            "resolved_value": rendered,
            "source_record": source_record,
            "connector": {
                "id": str(connector.id),
                "name": connector.name,
                "type": connector.connector_type,
            },
            "binding": {
                "connector_id": effective_connector_id,
                "source_kind": effective_source_kind,
                "template": effective_template,
                "job_filters": effective_job_filters or {},
                "enabled": effective_enabled,
            },
        }

    async def resolve_runtime_params(self, workflow_id: str, runtime_params: dict | None) -> tuple[dict, list[dict]]:
        merged = dict(runtime_params or {})
        resolutions: list[dict] = []
        bindings = await self.list_bindings(workflow_id)
        for binding in bindings:
            if not binding.enabled or binding.parameter_key in merged:
                continue
            preview = await self.preview_binding(
                workflow_id,
                binding.parameter_key,
            )
            merged[binding.parameter_key] = preview["resolved_value"]
            resolutions.append(
                {
                    "parameter_key": binding.parameter_key,
                    "connector": preview["connector"],
                    "source_kind": preview["binding"]["source_kind"],
                    "source_record": preview["source_record"],
                    "resolved_value": preview["resolved_value"],
                    "template": preview["binding"]["template"],
                }
            )
        return merged, resolutions

    async def _ensure_parameter_exists(self, workflow_id: str, parameter_key: str) -> None:
        result = await self.session.execute(
            select(WorkflowParameter).where(
                WorkflowParameter.workflow_id == workflow_id,
                WorkflowParameter.parameter_key == parameter_key,
            )
        )
        param = result.scalar_one_or_none()
        if param is None:
            raise ValueError(f"Workflow parameter '{parameter_key}' does not exist.")

    async def _get_connector_or_raise(self, connector_id: str) -> ConnectorConfig:
        try:
            connector_uuid = uuid.UUID(connector_id)
        except ValueError as exc:
            raise ValueError("Connector not found.") from exc
        result = await self.session.execute(
            select(ConnectorConfig).where(ConnectorConfig.id == connector_uuid)
        )
        connector = result.scalar_one_or_none()
        if connector is None:
            raise ValueError("Connector not found.")
        if connector.connector_type != "odoo":
            raise ValueError(f"Unsupported connector type '{connector.connector_type}'.")
        return connector

    async def _resolve_source_record(
        self,
        connector: ConnectorConfig,
        source_kind: str,
        job_filters: dict,
    ) -> dict[str, str]:
        if source_kind != self.SOURCE_KIND_ODOO_LATEST_JOB:
            raise ValueError(f"Unsupported source_kind '{source_kind}'.")
        jobs = await self.connector_forum.fetch_jobs(connector, limit=25, filters=job_filters or {})
        if not jobs:
            raise ValueError("No jobs are available in the connector.")

        def _sort_key(job: dict[str, str]) -> tuple[int, str]:
            raw_id = str(job.get("job_id") or "")
            digits = int(raw_id) if raw_id.isdigit() else -1
            return digits, raw_id

        latest_job = sorted(jobs, key=_sort_key, reverse=True)[0]
        odoo_base = (connector.config.get("url") or "").rstrip("/")
        job_url = (
            f"{odoo_base}/web#action=recruitment&id={latest_job['job_id']}"
            if odoo_base
            else ""
        )
        full_desc = latest_job["job_description"]
        return {
            "job_id": latest_job["job_id"],
            "job_title": latest_job["job_title"],
            "job_description": full_desc,
            "job_description_short": _short_description(full_desc),
            "job_url": job_url,
            # Fields only available from webhook payload; empty on connector-fetch path.
            "department": "",
            "company": "",
            "job_location": "",
            "seniority_level": "",
            "employment_model": "",
            "internal_area": "",
            # Per-fire count is unknown on the connector-fetch path; mirror the
            # webhook default so {candidate_count} templates still render.
            "candidate_count": "2",
        }

    def _validate_template(self, template: str) -> None:
        cleaned = template.strip()
        if not cleaned:
            raise ValueError("Template is required.")
        try:
            fields = {
                field_name
                for _, field_name, _, _ in Formatter().parse(cleaned)
                if field_name
            }
        except ValueError as exc:
            raise ValueError("Template placeholders are malformed.") from exc
        unknown = sorted(fields - self.TEMPLATE_FIELDS)
        if unknown:
            raise ValueError(
                f"Unknown template placeholders: {', '.join(unknown)}. "
                f"Supported placeholders: {', '.join(sorted(self.TEMPLATE_FIELDS))}."
            )
        if not fields:
            raise ValueError("Template must include at least one connector placeholder.")

    def _render_template(self, template: str, source_record: dict[str, str]) -> str:
        try:
            return template.format(**source_record).strip()
        except KeyError as exc:
            raise ValueError(f"Template placeholder '{exc.args[0]}' is not available.") from exc
