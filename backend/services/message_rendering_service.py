"""Render per-candidate LinkedIn outreach drafts for a run.

Used by GET /v1/runs/{run_id}/message-targets — the extension's
`open_message_drafts` action handler fetches this list and opens a
new tab per target with the rendered message pre-pasted in the
LinkedIn compose dialog.

Rendering reuses the same `{{name}}` semantics the rest of the
workflow engine uses (see services.template_service). Unresolved
placeholders stay literal so a typo in the template doesn't blow
up the whole step.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from core.models.run import ExecutionRun
from core.models.workflow import Workflow
from services.linkedin_applicant_push_service import LinkedInApplicantPushService

logger = logging.getLogger(__name__)

_placeholder_pattern = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")

# Variables the editor advertises. Used both for the in-app token
# inserter and to keep this list discoverable in tests.
SUPPORTED_VARIABLES = (
    "candidate_name",
    "candidate_headline",
    "candidate_score",
    "job_title",
    "job_url",
    "job_description",
    "job_description_short",
    "job_location",
    "company",
    "department",
    "seniority_level",
    "employment_model",
)


def render_message(template: str, ctx: dict[str, Any]) -> str:
    """Substitute `{{name}}` placeholders against ctx (string coerced).

    Unknown keys stay literal so the recruiter can spot typos by eye.
    """
    if not template:
        return ""

    def _replace(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        if key in ctx and ctx[key] is not None and ctx[key] != "":
            return str(ctx[key])
        return match.group(0)

    return _placeholder_pattern.sub(_replace, template)


def _candidate_ctx(profile: dict[str, Any], applicant_snapshot: dict[str, Any] | None) -> dict[str, Any]:
    ctx: dict[str, Any] = {
        "candidate_name": (profile.get("full_name") or "").strip(),
        "candidate_headline": (profile.get("headline") or "").strip(),
    }
    if applicant_snapshot:
        score = applicant_snapshot.get("score")
        if score is not None:
            ctx["candidate_score"] = f"{score}/10"
        if applicant_snapshot.get("name") and not ctx["candidate_name"]:
            ctx["candidate_name"] = applicant_snapshot["name"]
    return ctx


def _job_ctx(run: ExecutionRun) -> dict[str, Any]:
    """Pull job-side variables from the run's origin payload."""
    origin = run.origin or {}
    job = origin.get("job_payload") or {}
    return {
        "job_title": (job.get("job_title") or "").strip(),
        "job_url": (job.get("job_url") or "").strip(),
        "job_description": (job.get("job_description") or "").strip(),
        "job_description_short": (job.get("job_description_short") or "").strip(),
        "job_location": (job.get("job_location") or "").strip(),
        "company": (job.get("company") or "").strip(),
        "department": (job.get("department") or "").strip(),
        "seniority_level": (job.get("seniority_level") or "").strip(),
        "employment_model": (job.get("employment_model") or "").strip(),
    }


class MessageRenderingService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def build_targets_for_run(
        self,
        run: ExecutionRun,
        workflow: Workflow,
    ) -> dict[str, Any]:
        """Render outreach drafts for every extracted profile in the run.

        Joins extraction events (the canonical-URL profile dossiers) with
        the per-applicant snapshot persisted on the run after push, then
        renders the workflow's message_template per candidate.
        """
        config = workflow.config or {}
        template = (config.get("message_template") or "").strip()
        if not template:
            return {"targets": [], "template": "", "count": 0, "skipped": "no_template"}

        # Reuse the push service's profile grouping — single source of truth
        # for "which profiles did this run actually extract".
        pusher = LinkedInApplicantPushService(self.session)
        profiles = await pusher._collect_profiles(run.id)  # noqa: SLF001

        # Build a URL → applicant snapshot lookup (push results captured
        # earlier hold the score + odoo data we want to surface).
        snapshot_by_url: dict[str, dict[str, Any]] = {}
        for a in (run.linkedin_applicants or []):
            if isinstance(a, dict) and a.get("profile_url"):
                snapshot_by_url[a["profile_url"]] = a

        job_ctx = _job_ctx(run)

        targets: list[dict[str, Any]] = []
        for profile in profiles:
            url = profile.get("profile_url")
            if not url:
                continue
            snap = snapshot_by_url.get(url)
            ctx = {**job_ctx, **_candidate_ctx(profile, snap)}
            rendered = render_message(template, ctx)
            targets.append({
                "profile_url": url,
                "name": ctx.get("candidate_name") or (snap or {}).get("name") or "",
                "headline": ctx.get("candidate_headline") or "",
                "score": (snap or {}).get("score"),
                "recommendation": (snap or {}).get("recommendation"),
                "odoo_url": (snap or {}).get("odoo_url"),
                "rendered_message": rendered,
            })

        return {
            "targets": targets,
            "template": template,
            "count": len(targets),
        }
