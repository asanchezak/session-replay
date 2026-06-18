"""Push LinkedIn search-result leads from a completed run into Odoo.

Used by execution_service when a run originating from a `linkedin_lead_search`
webhook reaches COMPLETED. This is the lightweight sibling of
LinkedInApplicantPushService: instead of full per-profile dossiers, the run only
captured name + headline + profile_url for each person on the first two search
pages. Reads those `people` arrays from the run's extraction event_log rows,
dedups by canonical profile URL, and POSTs them in a single batch to the akcr
controller `/akcr/api/linkedin_lead` for linkedin.lead creation (no AI scoring).
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from core.models.connector import ConnectorConfig
from core.models.event import EventLog
from core.models.run import ExecutionRun
from services.profile_url_utils import canonical_profile_url, is_profile_url

logger = logging.getLogger(__name__)

DEFAULT_MAX_LEADS_PER_RUN = 50


def _summaries_from_push_result(inner: dict, leads: list[dict]) -> list[dict]:
    """Build a per-run snapshot from the controller's batch response.

    The controller returns `{created, skipped, leads: [{id, name, profile_url,
    outreach_status, odoo_url, status}]}`. Fall back to the pushed leads
    (status=push_failed) if the controller response is unusable.
    """
    now_iso = datetime.now(UTC).isoformat()
    rows = (inner or {}).get("leads") if isinstance(inner, dict) else None
    if isinstance(rows, list) and rows:
        return [
            {**r, "refreshed_at": now_iso}
            for r in rows
            if isinstance(r, dict)
        ]
    return [
        {
            "status": "push_failed",
            "profile_url": lead.get("profile_url"),
            "name": lead.get("name") or "",
            "headline": lead.get("headline") or "",
            "id": None,
            "odoo_url": None,
            "refreshed_at": now_iso,
        }
        for lead in leads
    ]


class LinkedInLeadPushService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def push_from_run(self, run: ExecutionRun) -> dict:
        result = await self.push_for_origin(run_id=run.id, origin=run.origin or {})
        leads = result.get("snapshot") or []
        if leads:
            run.linkedin_leads = leads
            flag_modified(run, "linkedin_leads")
            await self.session.flush()
        return result

    async def push_for_origin(self, *, run_id, origin: dict) -> dict:
        job_payload = origin.get("job_payload") or {}
        job_id = job_payload.get("job_id")
        connector_id = origin.get("connector_id")

        exec_opts = origin.get("execution_options") or {}
        if exec_opts.get("push_to_odoo") is False:
            logger.info("lead push: push_to_odoo disabled for run %s — skipping", run_id)
            return {"pushed": 0, "skipped": "push_disabled"}
        run_mode = exec_opts.get("mode") or "live"
        label_outputs = bool(exec_opts.get("label_outputs"))

        if not job_id:
            logger.warning("lead push: no job_id in origin for run %s", run_id)
            return {"pushed": 0, "skipped": "no_job_id"}
        if not connector_id:
            logger.warning("lead push: no connector_id in origin for run %s", run_id)
            return {"pushed": 0, "skipped": "no_connector_id"}

        connector = await self._get_connector(connector_id)
        if connector is None:
            logger.warning("lead push: connector %s not found", connector_id)
            return {"pushed": 0, "skipped": "connector_missing"}

        base_url = (connector.config.get("url") or "").rstrip("/")
        api_key = connector.config.get("linkedin_ingest_api_key") or ""
        if not base_url or not api_key:
            logger.warning(
                "lead push: connector %s missing url or linkedin_ingest_api_key",
                connector_id,
            )
            return {"pushed": 0, "skipped": "connector_unconfigured"}

        leads = await self._collect_leads(run_id)
        if not leads:
            logger.info("lead push: no leads collected for run %s", run_id)
            return {"pushed": 0, "skipped": "no_leads"}

        # Cap leads pushed per run. The lead flow only reads 2 search pages so
        # the natural ceiling is ~20-30; clamp defensively anyway.
        raw_limit = job_payload.get("candidate_count") or origin.get("candidate_count")
        try:
            # candidate_count caps the applicant flow at a small number; for
            # leads we want the whole page, so only honor an explicit larger
            # value and otherwise take everything up to the hard ceiling.
            max_leads = int(raw_limit) if raw_limit is not None else DEFAULT_MAX_LEADS_PER_RUN
        except (TypeError, ValueError):
            max_leads = DEFAULT_MAX_LEADS_PER_RUN
        max_leads = max(1, min(max(max_leads, len(leads)), DEFAULT_MAX_LEADS_PER_RUN))
        leads = leads[:max_leads]

        endpoint = f"{base_url}/akcr/api/linkedin_lead"
        payload = {
            "job_id": job_id,
            "source_run_id": str(run_id),
            "mode": run_mode,
            "label_outputs": label_outputs,
            "leads": leads,
        }
        # No AI on the Odoo side for leads — a short timeout is plenty.
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    endpoint,
                    json={"params": payload},
                    headers={"Content-Type": "application/json", "X-API-Key": api_key},
                )
                body = resp.json() if resp.content else {}
            inner = body.get("result") if isinstance(body, dict) else body
            logger.info(
                "lead push: posted %d leads for run %s status=%s odoo=%s",
                len(leads), run_id, resp.status_code, inner,
            )
            snapshot = _summaries_from_push_result(inner or {}, leads)
            return {"pushed": len(leads), "odoo": inner, "snapshot": snapshot}
        except Exception:
            logger.exception("lead push: POST failed for run %s", run_id)
            return {
                "pushed": 0,
                "error": True,
                "snapshot": _summaries_from_push_result({}, leads),
            }

    async def _get_connector(self, connector_id: str) -> ConnectorConfig | None:
        try:
            uid = uuid.UUID(connector_id)
        except (ValueError, TypeError):
            return None
        result = await self.session.execute(
            select(ConnectorConfig).where(ConnectorConfig.id == uid)
        )
        return result.scalar_one_or_none()

    async def _collect_leads(self, run_id) -> list[dict]:
        """Flatten `people` arrays from extraction events, dedup by profile URL.

        The daemon's lead branch posts each search page as
        `{step_index, data: [{page_title, url, people: [{name, headline,
        profile_url}]}]}`. First non-empty name/headline per URL wins.
        """
        result = await self.session.execute(
            select(EventLog)
            .where(EventLog.run_id == run_id, EventLog.event_type == "extraction")
            .order_by(EventLog.sequence_number.asc())
        )
        rows = list(result.scalars().all())
        by_url: dict[str, dict] = {}
        order: list[str] = []
        for ev in rows:
            payload = ev.payload or {}
            data = payload.get("data") or []
            if not isinstance(data, list):
                continue
            for rec in data:
                if not isinstance(rec, dict):
                    continue
                people = rec.get("people") or []
                if not isinstance(people, list):
                    continue
                for person in people:
                    if not isinstance(person, dict):
                        continue
                    url = person.get("profile_url") or person.get("url")
                    if not is_profile_url(url):
                        continue
                    canon = canonical_profile_url(url)
                    lead = by_url.get(canon)
                    if lead is None:
                        lead = {"profile_url": canon, "name": "", "headline": ""}
                        by_url[canon] = lead
                        order.append(canon)
                    if not lead["name"] and person.get("name"):
                        lead["name"] = str(person["name"]).strip()
                    if not lead["headline"] and person.get("headline"):
                        lead["headline"] = str(person["headline"]).strip()
        return [by_url[u] for u in order]
