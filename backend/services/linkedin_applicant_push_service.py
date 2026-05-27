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

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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


def _build_pre_extracted(profile: dict) -> dict:
    return {
        key: profile.get(key)
        for key in CANONICAL_PROFILE_FIELDS
        if profile.get(key) not in (None, "", [], {})
    }


class LinkedInApplicantPushService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def push_from_run(self, run: ExecutionRun) -> dict:
        return await self.push_for_origin(run_id=run.id, origin=run.origin or {})

    async def push_for_origin(self, *, run_id, origin: dict) -> dict:
        job_payload = origin.get("job_payload") or {}
        job_id = job_payload.get("job_id")
        connector_id = origin.get("connector_id")

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
