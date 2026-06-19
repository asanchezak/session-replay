"""Recruiter (/talent) → Odoo write-backs for the LinkedIn automation loop.

The second half of the Odoo↔Recruiter loop (the first half — applicant/lead
ingestion — lives in linkedin_applicant/lead_push_service). Three pushes, all
authed with the connector's `linkedin_ingest_api_key` against akcr controllers:

  * push_project_link    create-project run → POST /akcr/api/job_project_link
                         (sets hr.job.recruiter_project_url — requirement C)
  * push_recruiter_leads search run → POST /akcr/api/linkedin_lead
                         (creates linkedin.lead from /talent/profile/ cards — req A;
                          NOTE: Recruiter cards carry /talent/profile/ URLs, NOT the
                          public /in/ URLs the linkedin.com lead flow uses.)
  * push_outreach_update bulk-message-send run → POST /akcr/api/lead_outreach_update
                         (logs a linkedin.lead.message → outreach_status=messaged — req B)

Each reads what it needs from the run's `extraction` event-log rows (the daemon
posts {step_index, data:[{url, page_title, people:[...]}]} per extract step) and
the pipeline context threaded through run.origin by RecruiterPipelineService.
"""
from __future__ import annotations

import logging
import re
import uuid

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.connector import ConnectorConfig
from core.models.event import EventLog
from core.models.run import ExecutionRun
from services.profile_url_utils import (
    RECRUITER_PROFILE_MARKERS,
    canonical_profile_url,
    is_profile_url,
)

logger = logging.getLogger(__name__)

DEFAULT_MAX_LEADS_PER_RUN = 50
_PROJECT_URL_RE = re.compile(r"/talent/hire/(\d+)")


class RecruiterPushService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ------------------------------------------------------------------ infra
    async def _get_connector(self, connector_id: str) -> ConnectorConfig | None:
        try:
            uid = uuid.UUID(str(connector_id))
        except (ValueError, TypeError):
            return None
        result = await self.session.execute(
            select(ConnectorConfig).where(ConnectorConfig.id == uid)
        )
        return result.scalar_one_or_none()

    async def _connector_endpoint(self, connector_id: str) -> tuple[str, str] | None:
        """Return (base_url, api_key) for the connector, or None if unconfigured."""
        if not connector_id:
            logger.warning("recruiter push: no connector_id")
            return None
        connector = await self._get_connector(connector_id)
        if connector is None:
            logger.warning("recruiter push: connector %s not found", connector_id)
            return None
        base_url = (connector.config.get("url") or "").rstrip("/")
        api_key = connector.config.get("linkedin_ingest_api_key") or ""
        if not base_url or not api_key:
            logger.warning(
                "recruiter push: connector %s missing url or linkedin_ingest_api_key",
                connector_id,
            )
            return None
        return base_url, api_key

    async def _post(self, base_url: str, api_key: str, path: str, payload: dict,
                    timeout: float = 30.0) -> dict:
        endpoint = f"{base_url}{path}"
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                endpoint,
                json={"params": payload},
                headers={"Content-Type": "application/json", "X-API-Key": api_key},
            )
            body = resp.json() if resp.content else {}
        inner = body.get("result") if isinstance(body, dict) else body
        return {"status_code": resp.status_code, "odoo": inner}

    # ------------------------------------------------------- extraction readers
    async def _extraction_rows(self, run_id) -> list[dict]:
        result = await self.session.execute(
            select(EventLog)
            .where(EventLog.run_id == run_id, EventLog.event_type == "extraction")
            .order_by(EventLog.sequence_number.asc())
        )
        rows: list[dict] = []
        for ev in result.scalars().all():
            data = (ev.payload or {}).get("data") or []
            if isinstance(data, list):
                rows.extend(r for r in data if isinstance(r, dict))
        return rows

    async def _find_project_url(self, run_id) -> str | None:
        """The create-project run lands on /talent/hire/<id>/… — its extract step
        posts that page URL. Return the last extraction URL that looks like a
        project URL (most recent navigation wins)."""
        found = None
        for rec in await self._extraction_rows(run_id):
            url = rec.get("url") or ""
            if _PROJECT_URL_RE.search(url):
                found = url
        return found

    async def _collect_recruiter_leads(self, run_id) -> list[dict]:
        """Flatten `people` from the search run's extractions; dedup by canonical
        /talent/profile/ URL. First non-empty name/headline per URL wins."""
        by_url: dict[str, dict] = {}
        order: list[str] = []
        for rec in await self._extraction_rows(run_id):
            for person in (rec.get("people") or []):
                if not isinstance(person, dict):
                    continue
                url = person.get("profile_url") or person.get("url")
                if not is_profile_url(url, RECRUITER_PROFILE_MARKERS):
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

    # -------------------------------------------------------------- the pushes
    async def push_project_link(self, *, run_id, job_id, connector_id,
                                project_url: str | None = None) -> dict:
        """Requirement C: set hr.job.recruiter_project_url from a create-project run."""
        if not job_id:
            return {"pushed": 0, "skipped": "no_job_id"}
        ep = await self._connector_endpoint(connector_id)
        if ep is None:
            return {"pushed": 0, "skipped": "connector_unconfigured"}
        base_url, api_key = ep
        url = project_url or await self._find_project_url(run_id)
        if not url:
            logger.warning("project link push: no project URL found for run %s", run_id)
            return {"pushed": 0, "skipped": "no_project_url"}
        m = _PROJECT_URL_RE.search(url)
        payload = {
            "job_id": job_id,
            "recruiter_project_url": canonical_profile_url(url),
            "recruiter_project_id": m.group(1) if m else None,
        }
        try:
            res = await self._post(base_url, api_key, "/akcr/api/job_project_link", payload)
            logger.info("project link push: job=%s url=%s odoo=%s", job_id, url, res)
            return {"pushed": 1, "project_url": payload["recruiter_project_url"], **res}
        except Exception:
            logger.exception("project link push: POST failed for run %s", run_id)
            return {"pushed": 0, "error": True}

    async def push_recruiter_leads(self, *, run_id, job_id, connector_id,
                                   mode: str = "live", source: str = "") -> dict:
        """Requirement A: create linkedin.lead rows from the search run's candidates.

        Always returns the collected candidates under "leads" (even when the Odoo
        POST is skipped), so the orchestrator can still fan out save-to-project
        runs off them.

        `source` tags how the candidates were sourced ("boolean_search" vs
        "recommendation") — it's uniform per run, so it rides at the payload top level
        and Odoo applies it to every lead in the batch.
        """
        leads = await self._collect_recruiter_leads(run_id)
        if not leads:
            logger.info("recruiter lead push: no candidates for run %s", run_id)
            return {"pushed": 0, "skipped": "no_leads", "leads": []}
        leads = leads[:DEFAULT_MAX_LEADS_PER_RUN]
        if not job_id:
            return {"pushed": 0, "skipped": "no_job_id", "leads": leads}
        ep = await self._connector_endpoint(connector_id)
        if ep is None:
            return {"pushed": 0, "skipped": "connector_unconfigured", "leads": leads}
        base_url, api_key = ep
        payload = {
            "job_id": job_id,
            "source_run_id": str(run_id),
            "mode": mode,
            "source": source,
            "leads": leads,
        }
        try:
            res = await self._post(base_url, api_key, "/akcr/api/linkedin_lead", payload)
            logger.info(
                "recruiter lead push: posted %d candidates for run %s odoo=%s",
                len(leads), run_id, res,
            )
            return {"pushed": len(leads), "leads": leads, **res}
        except Exception:
            logger.exception("recruiter lead push: POST failed for run %s", run_id)
            return {"pushed": 0, "error": True, "leads": leads}

    async def push_outreach_update(self, *, run_id, job_id, connector_id,
                                   messaged: list[dict] | list[str]) -> dict:
        """Requirement B: log InMails sent → linkedin.lead.message (status=sent).

        `messaged` is a list of /talent/profile/ URLs, or dicts
        {profile_url, subject?, body?, message_type?}.
        """
        if not job_id:
            return {"pushed": 0, "skipped": "no_job_id"}
        if not messaged:
            return {"pushed": 0, "skipped": "no_messaged"}
        ep = await self._connector_endpoint(connector_id)
        if ep is None:
            return {"pushed": 0, "skipped": "connector_unconfigured"}
        base_url, api_key = ep
        messages = []
        for m in messaged:
            if isinstance(m, str):
                messages.append({"profile_url": canonical_profile_url(m)})
            elif isinstance(m, dict) and (m.get("profile_url") or m.get("url")):
                url = canonical_profile_url(m.get("profile_url") or m.get("url"))
                messages.append({**m, "profile_url": url})
        if not messages:
            return {"pushed": 0, "skipped": "no_valid_urls"}
        payload = {
            "job_id": job_id,
            "source_run_id": str(run_id),
            "messages": messages,
        }
        try:
            res = await self._post(
                base_url, api_key, "/akcr/api/lead_outreach_update", payload
            )
            logger.info(
                "outreach push: marked %d messaged for run %s odoo=%s",
                len(messages), run_id, res,
            )
            return {"pushed": len(messages), **res}
        except Exception:
            logger.exception("outreach push: POST failed for run %s", run_id)
            return {"pushed": 0, "error": True}

    async def push_inbox_replies(self, *, connector_id, replied: list[dict] | list[str],
                                 run_id=None) -> dict:
        """Inbox-reply scan: a candidate REPLIED to our outreach → log an INBOUND
        linkedin.lead.message (status=responded) so Odoo flips the lead to
        outreach_status='responded' (via _sync_lead_status). No job_id needed — the
        inbox scan sees a conversation, not a position; akcr matches by profile_url
        (or name among messaged leads). Idempotent on the akcr side.

        `replied` is a list of /talent/profile/ URLs, or dicts {profile_url?, name?}.
        """
        if not replied:
            return {"pushed": 0, "skipped": "no_replied"}
        ep = await self._connector_endpoint(connector_id)
        if ep is None:
            return {"pushed": 0, "skipped": "connector_unconfigured"}
        base_url, api_key = ep
        replies = []
        for m in replied:
            if isinstance(m, str):
                replies.append({"profile_url": canonical_profile_url(m)})
            elif isinstance(m, dict):
                url = m.get("profile_url") or m.get("url")
                entry = {**m}
                if url:
                    entry["profile_url"] = canonical_profile_url(url)
                # keep name-only entries — akcr falls back to name matching
                if entry.get("profile_url") or entry.get("name"):
                    replies.append(entry)
        if not replies:
            return {"pushed": 0, "skipped": "no_valid_replies"}
        payload = {"source_run_id": str(run_id) if run_id else None, "replies": replies}
        try:
            res = await self._post(base_url, api_key, "/akcr/api/lead_replied", payload)
            logger.info("inbox-reply push: sent %d replies odoo=%s", len(replies), res)
            return {"pushed": len(replies), **res}
        except Exception:
            logger.exception("inbox-reply push: POST failed")
            return {"pushed": 0, "error": True}

    # ------------------------------------------------------- boolean search read/push
    async def read_search_result(self, run_id) -> dict:
        """Read a search run's extraction → {url, total_count, leads}. total_count is
        None until the daemon extractor enhancement ships (then the calibration loop
        activates); leads are the deduped /talent/profile/ candidates."""
        url, total = None, None
        for rec in await self._extraction_rows(run_id):
            if rec.get("url"):
                url = rec.get("url")
            if rec.get("total_count") is not None:
                total = rec.get("total_count")
        leads = await self._collect_recruiter_leads(run_id)
        return {"url": url, "total_count": total, "leads": leads}

    async def push_search_link(self, *, run_id, job_id, connector_id,
                               search_url, count, query, filters="") -> dict:
        """Save the (final, in-band) search URL + count + boolean query + facet
        filters on the Odoo position (hr.job) via POST /akcr/api/job_search_link."""
        if not job_id:
            return {"pushed": 0, "skipped": "no_job_id"}
        ep = await self._connector_endpoint(connector_id)
        if ep is None:
            return {"pushed": 0, "skipped": "connector_unconfigured"}
        base_url, api_key = ep
        payload = {
            "job_id": job_id,
            "search_url": search_url or "",
            "count": count,
            "query": query or "",
            "filters": filters or "",
        }
        try:
            res = await self._post(base_url, api_key, "/akcr/api/job_search_link", payload)
            logger.info(
                "search link push: job=%s count=%s url=%s odoo=%s",
                job_id, count, search_url, res,
            )
            return {"pushed": 1, **res}
        except Exception:
            logger.exception("search link push: POST failed for run %s", run_id)
            return {"pushed": 0, "error": True}

    # ------------------------------------------------------- archive read/push
    async def read_archive_result(self, run_id) -> dict:
        """Read an archive (remove-from-project) run's strategy result. The
        recruiter_archive_candidate strategy posts {archive_result: {...}} as its
        extraction → {archived, verified_gone, candidate_name, profile_url, reason}.
        Last non-empty wins."""
        out: dict = {}
        for rec in await self._extraction_rows(run_id):
            ar = rec.get("archive_result")
            if isinstance(ar, dict):
                out = ar
        return out

    async def read_archive_all_result(self, run_id) -> dict:
        """Read an archive-ALL run's result. The recruiter_archive_all_in_project
        strategy posts {archive_all_result: {...}} → {archived_count, active_after,
        more_remaining, archived_before/after, reason}. Last non-empty wins."""
        out: dict = {}
        for rec in await self._extraction_rows(run_id):
            ar = rec.get("archive_all_result")
            if isinstance(ar, dict):
                out = ar
        return out

    async def read_message_compose_result(self, run_id) -> dict:
        """Read a recruiter_message_compose run's result → {sent, recipients, ...}.
        recipients are the project's active candidates the strategy messaged
        (profile_url + name), used to mark outreach in Odoo. Last non-empty wins."""
        out: dict = {}
        for rec in await self._extraction_rows(run_id):
            mc = rec.get("message_compose_result")
            if isinstance(mc, dict):
                out = mc
        return out

    async def read_note_compose_result(self, run_id) -> dict:
        """Read a recruiter_note_compose run's result → {saved, stage_moved, recipient_count,
        note_field_found, recipients, ...}. Last non-empty wins."""
        out: dict = {}
        for rec in await self._extraction_rows(run_id):
            nc = rec.get("note_compose_result")
            if isinstance(nc, dict):
                out = nc
        return out

    async def push_lead_removed(self, *, run_id, job_id, connector_id,
                                profile_url: str | None, name: str | None = None) -> dict:
        """Confirmed removal: the candidate is archived/gone in LinkedIn, so delete
        the Odoo linkedin.lead via POST /akcr/api/lead_removed. Idempotent on the
        Odoo side (lead not found → ok)."""
        if not job_id:
            return {"pushed": 0, "skipped": "no_job_id"}
        if not profile_url:
            return {"pushed": 0, "skipped": "no_profile_url"}
        ep = await self._connector_endpoint(connector_id)
        if ep is None:
            return {"pushed": 0, "skipped": "connector_unconfigured"}
        base_url, api_key = ep
        payload = {
            "job_id": job_id,
            "source_run_id": str(run_id),
            "profile_url": canonical_profile_url(profile_url),
            "name": name or "",
        }
        try:
            res = await self._post(base_url, api_key, "/akcr/api/lead_removed", payload)
            logger.info(
                "lead removed push: job=%s url=%s odoo=%s", job_id, profile_url, res,
            )
            return {"pushed": 1, **res}
        except Exception:
            logger.exception("lead removed push: POST failed for run %s", run_id)
            return {"pushed": 0, "error": True}

    async def push_flow_status(self, *, connector_id, job_id, status: str,
                               stage: str = "", error_kind: str = "",
                               error_summary: str = "", message: str = "",
                               run_id=None) -> dict:
        """Surface the recruiter automation lifecycle on the Odoo hr.job position via
        POST /akcr/api/recruiter_flow_status. `status` is running|done|failed; `message`
        is a descriptive chatter note (e.g. "Searching for candidates…") for running/done.
        On 'failed' akcr composes its own note + schedules a to-do for the recruiter.
        Best-effort — a push failure must never block run termination."""
        if not job_id:
            return {"pushed": 0, "skipped": "no_job_id"}
        ep = await self._connector_endpoint(connector_id)
        if ep is None:
            return {"pushed": 0, "skipped": "connector_unconfigured"}
        base_url, api_key = ep
        payload = {
            "job_id": job_id,
            "status": status,
            "stage": stage or "",
            "error_kind": error_kind or "",
            "error_summary": (error_summary or "")[:2000],
            "message": (message or "")[:2000],
            "source_run_id": str(run_id) if run_id else "",
        }
        try:
            res = await self._post(
                base_url, api_key, "/akcr/api/recruiter_flow_status", payload
            )
            logger.info(
                "flow status push: job=%s status=%s stage=%s odoo=%s",
                job_id, status, stage, res,
            )
            return {"pushed": 1, **res}
        except Exception:
            logger.exception(
                "flow status push: POST failed (job=%s status=%s)", job_id, status
            )
            return {"pushed": 0, "error": True}
