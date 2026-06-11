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

logger = logging.getLogger(__name__)

DEFAULT_MAX_LEADS_PER_RUN = 50
_PROJECT_URL_RE = re.compile(r"/talent/hire/(\d+)")
# Recruiter candidate URLs are /talent/profile/<id>; also accept public /in/.
_RECRUITER_PROFILE_MARKERS = ("/talent/profile/", "linkedin.com/in/")


def _is_recruiter_profile_url(url: str | None) -> bool:
    if not url:
        return False
    head = url.split("?", 1)[0]
    return any(m in head for m in _RECRUITER_PROFILE_MARKERS)


def _canonical_url(url: str) -> str:
    """Canonicalize for dedup/match — drop query (?project=…&trk=…) + fragment.

    The keying contract (see docs/recruiter-odoo-integration-design.md): leads and
    outreach updates join on the bare /talent/profile/<id> URL, so search-push and
    message-push must canonicalize identically.
    """
    return url.split("?", 1)[0].split("#", 1)[0].rstrip("/")


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
                if not _is_recruiter_profile_url(url):
                    continue
                canon = _canonical_url(url)
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
            "recruiter_project_url": _canonical_url(url),
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
                                   mode: str = "live") -> dict:
        """Requirement A: create linkedin.lead rows from the search run's candidates.

        Always returns the collected candidates under "leads" (even when the Odoo
        POST is skipped), so the orchestrator can still fan out save-to-project
        runs off them.
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
                messages.append({"profile_url": _canonical_url(m)})
            elif isinstance(m, dict) and (m.get("profile_url") or m.get("url")):
                url = _canonical_url(m.get("profile_url") or m.get("url"))
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
            "profile_url": _canonical_url(profile_url),
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
