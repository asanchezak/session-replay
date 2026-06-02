"""Push LinkedIn-extracted profiles from a completed run into Odoo.

Used by execution_service when a run originating from a `new_job_position`
webhook reaches COMPLETED. Reads per-profile extraction event_log rows,
groups them by profile URL, and POSTs each (up to 2) to the akcr
controller `/akcr/api/linkedin_applicant` for applicant creation +
Easy Recruit scoring.
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

logger = logging.getLogger(__name__)

DEFAULT_MAX_PROFILES_PER_RUN = 2
PROFILE_URL_PREFIX = "linkedin.com/in/"
CANONICAL_PROFILE_FIELDS = (
    "full_name",
    "headline",
    "about",
    "location",
    "skills",
    "experience",
    "education",
    "certifications",
    "projects",
    "courses",
    "languages",
)


def _is_profile_url(url: str | None) -> bool:
    if not url:
        return False
    return PROFILE_URL_PREFIX in url.split("?", 1)[0]


def _canonical_profile_url(url: str) -> str:
    base = url.split("?", 1)[0].rstrip("/")
    return base


def _summaries_from_push_results(results: list[dict]) -> list[dict]:
    """Extract applicant snapshots from push-service per-profile results.

    Each entry has shape {"profile_url": str, "odoo": <controller response>}.
    The controller now returns a `summary` block alongside its status — we
    pull that out, falling back to a minimal record on push error.
    """
    now_iso = datetime.now(UTC).isoformat()
    out: list[dict] = []
    for entry in results:
        if not isinstance(entry, dict):
            continue
        url = entry.get("profile_url")
        if entry.get("error"):
            out.append({
                "status": "push_failed",
                "profile_url": url,
                "id": None,
                "name": "",
                "score": None,
                "recommendation": None,
                "odoo_url": None,
                "refreshed_at": now_iso,
            })
            continue
        odoo = entry.get("odoo") or {}
        summary = odoo.get("summary") if isinstance(odoo, dict) else None
        if isinstance(summary, dict):
            out.append({**summary, "status": odoo.get("status") or summary.get("status") or "unknown", "refreshed_at": now_iso})
        else:
            out.append({
                "status": (odoo.get("status") if isinstance(odoo, dict) else None) or "unknown",
                "profile_url": url,
                "id": odoo.get("id") if isinstance(odoo, dict) else None,
                "name": "",
                "score": None,
                "recommendation": None,
                "odoo_url": None,
                "refreshed_at": now_iso,
            })
    return out


def _build_pre_extracted(profile: dict) -> dict:
    # Easy Recruit (akodoo) reads pre_extracted to SKIP its redundant extraction
    # agents (~40% AI cost + 30-120s/applicant). Include profile_url here too —
    # the analyzer's overview reads pre_extracted["profile_url"] for the LinkedIn
    # URL, but it isn't in CANONICAL_PROFILE_FIELDS (those are AI-extracted fields).
    fields = (*CANONICAL_PROFILE_FIELDS, "profile_url")
    return {
        key: profile.get(key)
        for key in fields
        if profile.get(key) not in (None, "", [], {})
    }


class LinkedInApplicantPushService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def push_from_run(self, run: ExecutionRun) -> dict:
        result = await self.push_for_origin(run_id=run.id, origin=run.origin or {})
        applicants = _summaries_from_push_results(result.get("results") or [])
        if applicants:
            run.linkedin_applicants = applicants
            flag_modified(run, "linkedin_applicants")
            await self.session.flush()
        return result

    async def refresh_from_run(self, run: ExecutionRun) -> dict:
        """Re-query Odoo for applicants tied to this run.

        Used by POST /runs/{id}/refresh-applicants. Computes the set of
        candidate profile URLs from extraction events, calls the Odoo
        lookup endpoint, and writes the snapshot back to the run.
        """
        origin = run.origin or {}
        job_payload = origin.get("job_payload") or {}
        job_id = job_payload.get("job_id")
        connector_id = origin.get("connector_id")
        if not job_id or not connector_id:
            return {"refreshed": 0, "skipped": "missing_origin"}

        connector = await self._get_connector(connector_id)
        if connector is None:
            return {"refreshed": 0, "skipped": "connector_missing"}
        base_url = (connector.config.get("url") or "").rstrip("/")
        api_key = connector.config.get("linkedin_ingest_api_key") or ""
        if not base_url or not api_key:
            return {"refreshed": 0, "skipped": "connector_unconfigured"}

        profiles = await self._collect_profiles(run.id)
        profile_urls = [p["profile_url"] for p in profiles if p.get("profile_url")]
        # Also include any URLs already snapshotted on the run, so a
        # refresh after profiles have aged out of extraction events still
        # finds them.
        for prior in run.linkedin_applicants or []:
            url = prior.get("profile_url") if isinstance(prior, dict) else None
            if url and url not in profile_urls:
                profile_urls.append(url)
        if not profile_urls:
            return {"refreshed": 0, "skipped": "no_profile_urls"}

        endpoint = f"{base_url}/akcr/api/linkedin_applicant/lookup"
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                endpoint,
                json={"params": {"job_id": job_id, "profile_urls": profile_urls}},
                headers={"Content-Type": "application/json", "X-API-Key": api_key},
            )
            body = resp.json() if resp.content else {}
        inner = body.get("result") if isinstance(body, dict) else body
        applicants_raw = (inner or {}).get("applicants") or []
        now_iso = datetime.now(UTC).isoformat()
        applicants = []
        for a in applicants_raw:
            if not isinstance(a, dict):
                continue
            applicants.append({**a, "refreshed_at": now_iso})
        run.linkedin_applicants = applicants
        flag_modified(run, "linkedin_applicants")
        await self.session.flush()
        return {"refreshed": len(applicants), "applicants": applicants}

    async def push_for_origin(self, *, run_id, origin: dict) -> dict:
        job_payload = origin.get("job_payload") or {}
        job_id = job_payload.get("job_id")
        connector_id = origin.get("connector_id")

        # QA execution options: skip the Odoo push entirely if disabled, and tag
        # applicants as test data when mode=test / label_outputs so they can be
        # cleaned up later (Odoo akcr_cleanup_test_applicants).
        exec_opts = origin.get("execution_options") or {}
        if exec_opts.get("push_to_odoo") is False:
            logger.info("push_from_run: push_to_odoo disabled for run %s — skipping", run_id)
            return {"pushed": 0, "skipped": "push_disabled"}
        run_mode = exec_opts.get("mode") or "live"
        label_outputs = bool(exec_opts.get("label_outputs"))

        if not job_id:
            logger.warning("push_from_run: no job_id in origin for run %s", run_id)
            return {"pushed": 0, "skipped": "no_job_id"}
        if not connector_id:
            logger.warning("push_from_run: no connector_id in origin for run %s", run_id)
            return {"pushed": 0, "skipped": "no_connector_id"}

        connector = await self._get_connector(connector_id)
        if connector is None:
            logger.warning("push_from_run: connector %s not found", connector_id)
            return {"pushed": 0, "skipped": "connector_missing"}

        base_url = (connector.config.get("url") or "").rstrip("/")
        api_key = connector.config.get("linkedin_ingest_api_key") or ""
        if not base_url or not api_key:
            logger.warning(
                "push_from_run: connector %s missing url or linkedin_ingest_api_key",
                connector_id,
            )
            return {"pushed": 0, "skipped": "connector_unconfigured"}

        profiles = await self._collect_profiles(run_id)
        if not profiles:
            logger.info("push_from_run: no LinkedIn profiles in run %s", run_id)
            return {"pushed": 0, "skipped": "no_profiles"}

        endpoint = f"{base_url}/akcr/api/linkedin_applicant"
        results: list[dict] = []

        # Cap the number of profiles to push per run. Reads from
        # origin.job_payload.candidate_count (set by the new-job webhook) and
        # falls back to DEFAULT_MAX_PROFILES_PER_RUN. Clamps to [1, 25] so a
        # bogus payload value can't run unbounded HTTP calls.
        raw_limit = job_payload.get("candidate_count") or origin.get("candidate_count")
        try:
            max_profiles = int(raw_limit) if raw_limit is not None else DEFAULT_MAX_PROFILES_PER_RUN
        except (TypeError, ValueError):
            max_profiles = DEFAULT_MAX_PROFILES_PER_RUN
        max_profiles = max(1, min(max_profiles, 25))

        # Odoo runs 8 AI agents synchronously inside _analyze_easy_recruit
        # (30-120s per applicant). httpx default 5s would always trip.
        async with httpx.AsyncClient(timeout=240.0) as client:
            for profile in profiles[:max_profiles]:
                payload = {
                    "job_id": job_id,
                    "source_run_id": str(run_id),
                    "mode": run_mode,
                    "label_outputs": label_outputs,
                    "profile_url": profile["profile_url"],
                    "full_name": profile.get("full_name") or "",
                    "headline": profile.get("headline") or "",
                    "about": profile.get("about") or "",
                    "skills": profile.get("skills") or [],
                    "experience": profile.get("experience") or [],
                    "education": profile.get("education") or [],
                    "certifications": profile.get("certifications") or [],
                    "projects": profile.get("projects") or [],
                    "courses": profile.get("courses") or [],
                    "languages": profile.get("languages") or [],
                    "pre_extracted": _build_pre_extracted(profile),
                }
                try:
                    resp = await client.post(
                        endpoint,
                        json={"params": payload},
                        headers={
                            "Content-Type": "application/json",
                            "X-API-Key": api_key,
                        },
                    )
                    body = resp.json() if resp.content else {}
                    # JSON-RPC wraps the controller return in {"result": ...}
                    inner = body.get("result") if isinstance(body, dict) else body
                    logger.info(
                        "push_from_run: posted %s status=%s odoo=%s",
                        profile["profile_url"], resp.status_code, inner,
                    )
                    results.append({"profile_url": profile["profile_url"], "odoo": inner})
                except Exception:
                    logger.exception(
                        "push_from_run: POST failed for %s", profile["profile_url"]
                    )
                    results.append({"profile_url": profile["profile_url"], "error": True})

        return {"pushed": len(results), "results": results}

    async def _get_connector(self, connector_id: str) -> ConnectorConfig | None:
        try:
            uid = uuid.UUID(connector_id)
        except (ValueError, TypeError):
            return None
        result = await self.session.execute(
            select(ConnectorConfig).where(ConnectorConfig.id == uid)
        )
        return result.scalar_one_or_none()

    async def _collect_profiles(self, run_id) -> list[dict]:
        """Group extraction events by profile URL into one dossier per profile."""
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
            url = payload.get("url") or ev.page_url
            if not _is_profile_url(url):
                continue
            canon = _canonical_profile_url(url)
            data = payload.get("data") or []
            if not isinstance(data, list):
                continue
            profile = by_url.get(canon)
            if profile is None:
                profile = {"profile_url": canon}
                by_url[canon] = profile
                order.append(canon)
            for rec in data:
                if not isinstance(rec, dict):
                    continue
                for k, v in rec.items():
                    if v in (None, "", [], {}):
                        continue
                    # First non-empty value wins per key
                    profile.setdefault(k, v)
        # Drop profiles with no extracted content beyond the URL itself.
        return [
            p for p in (by_url[u] for u in order)
            if any(k for k in p if k != "profile_url")
        ]
