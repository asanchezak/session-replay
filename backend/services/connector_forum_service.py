from __future__ import annotations

import asyncio
import random
import re
import uuid
from html.parser import HTMLParser
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from adapters.odoo.adapter import OdooAdapter
from adapters.registry import get_adapter
from core.models.connector import ConnectorConfig


class ConnectorForumService:
    CANDIDATE_FIELDS = [
        "id",
        "name",
        "partner_name",
        "email_from",
        "email",
        "partner_phone",
        "mobile_phone",
        "description",
    ]
    APPLICANT_FIELDS = [
        "id",
        "name",
        "partner_name",
        "email_from",
        "partner_phone",
        "description",
        "job_id",
    ]
    JOB_FIELDS = [
        "id",
        "name",
        "description",
        "website_description",
        "requirements",
    ]

    def __init__(self, db: AsyncSession):
        self.db = db

    async def resolve_connector(self, connector_id: str) -> ConnectorConfig | None:
        try:
            uid = uuid.UUID(connector_id)
        except ValueError:
            return None
        result = await self.db.execute(select(ConnectorConfig).where(ConnectorConfig.id == uid))
        return result.scalar_one_or_none()

    async def _build_adapter(self, connector: ConnectorConfig):
        try:
            adapter_cls = get_adapter(connector.connector_type)
        except ValueError:
            if connector.connector_type == "odoo":
                adapter_cls = OdooAdapter
            else:
                raise
        adapter = adapter_cls()
        await adapter.initialize(connector.config)
        return adapter

    async def _post_json(self, url: str, payload: dict) -> dict:
        timeout = httpx.Timeout(connect=5, read=20, write=10, pool=5)

        def _send() -> dict:
            with httpx.Client(timeout=timeout) as client:
                response = client.post(url, json=payload)
                response.raise_for_status()
                return response.json()

        return await asyncio.to_thread(_send)

    async def fetch_candidates(
        self,
        connector: ConnectorConfig,
        *,
        limit: int = 10,
        filters: dict | None = None,
    ) -> list[dict]:
        adapter = await self._build_adapter(connector)
        try:
            last_error: Exception | None = None
            strategies = [
                ("candidate", self.CANDIDATE_FIELDS),
                ("applicant", self.APPLICANT_FIELDS),
            ]
            for resource, fields in strategies:
                try:
                    records = await adapter.list(
                        resource,
                        filters=filters or {},
                        limit=limit,
                        fields=fields,
                    )
                    return [self._normalize_candidate(record) for record in records]
                except Exception as exc:
                    last_error = exc
                    if not self._is_candidate_fallback_error(exc):
                        raise
            if last_error is not None:
                raise last_error
            return []
        finally:
            await adapter.dispose()

    async def fetch_jobs(
        self,
        connector: ConnectorConfig,
        *,
        limit: int = 25,
        filters: dict | None = None,
    ) -> list[dict]:
        adapter = await self._build_adapter(connector)
        try:
            records = await adapter.list(
                "job",
                filters=filters or {},
                limit=limit,
                fields=self.JOB_FIELDS,
            )
            return [self._normalize_job(record) for record in records]
        finally:
            await adapter.dispose()

    async def sync_profiles(
        self,
        connector: ConnectorConfig,
        forum_base_url: str,
        *,
        candidate_limit: int,
        candidate_filters: dict | None = None,
    ) -> dict:
        candidates = await self.fetch_candidates(
            connector,
            limit=candidate_limit,
            filters=candidate_filters,
        )
        jobs = await self.fetch_jobs(connector, limit=10)
        payload = {
            "profiles": [
                {
                    "source_candidate_id": candidate["source_candidate_id"],
                    "name": candidate["name"],
                    "email": candidate["email"],
                    "phone": candidate["phone"],
                    "summary": candidate["summary"],
                }
                for candidate in candidates
            ],
        }
        forum_result = await self._post_json(
            f"{forum_base_url.rstrip('/')}/api/profiles/import",
            payload,
        )
        return {
            "connector": {
                "id": str(connector.id),
                "name": connector.name,
                "type": connector.connector_type,
            },
            "imported_count": len(payload["profiles"]),
            "profiles": payload["profiles"],
            "jobs_preview": jobs[:5],
            "forum_result": forum_result,
        }

    async def send_messages(
        self,
        connector: ConnectorConfig,
        forum_base_url: str,
        *,
        candidate_ids: list[str] | None = None,
        selection_prompt: str | None = None,
        candidate_limit: int = 25,
        candidate_filters: dict | None = None,
        job_id: str | None = None,
        job_description: str | None = None,
        random_job: bool = False,
        message_template: str | None = None,
    ) -> dict:
        candidates = await self.fetch_candidates(
            connector,
            limit=candidate_limit,
            filters=candidate_filters,
        )
        selected_candidates = self._select_candidates(
            candidates,
            candidate_ids=candidate_ids or [],
            selection_prompt=selection_prompt,
        )
        if not selected_candidates:
            raise ValueError("No candidates matched the provided selection.")

        jobs = await self.fetch_jobs(connector, limit=25)
        job = self._resolve_job(
            jobs,
            job_id=job_id,
            job_description=job_description,
            random_job=random_job,
        )

        messages = [
            {
                "source_candidate_id": candidate["source_candidate_id"],
                "candidate_name": candidate["name"],
                "candidate_email": candidate["email"],
                "job_id": job["job_id"],
                "job_title": job["job_title"],
                "job_description": job["job_description"],
                "body": self._render_message(
                    candidate,
                    job,
                    template=message_template,
                ),
            }
            for candidate in selected_candidates
        ]
        forum_result = await self._post_json(
            f"{forum_base_url.rstrip('/')}/api/messages/send",
            {"messages": messages},
        )
        return {
            "sent_count": len(messages),
            "recipients": [
                {
                    "source_candidate_id": candidate["source_candidate_id"],
                    "name": candidate["name"],
                    "email": candidate["email"],
                }
                for candidate in selected_candidates
            ],
            "job": job,
            "forum_result": forum_result,
        }

    def _normalize_candidate(self, record: dict[str, Any]) -> dict[str, str]:
        candidate_id = record.get("id")
        email = record.get("email_from") or record.get("email") or ""
        phone = record.get("partner_phone") or record.get("mobile_phone") or ""
        summary = (record.get("description") or "").strip()
        return {
            "source_candidate_id": str(candidate_id),
            "name": str(record.get("partner_name") or record.get("name") or f"Candidate {candidate_id}"),
            "email": str(email),
            "phone": str(phone),
            "summary": summary,
        }

    @staticmethod
    def _strip_html(raw: str) -> str:
        """Strip HTML tags and collapse whitespace for use in plain-text messages."""
        class _Stripper(HTMLParser):
            def __init__(self):
                super().__init__()
                self._parts: list[str] = []
            def handle_data(self, data: str) -> None:
                self._parts.append(data)
            def get_text(self) -> str:
                return re.sub(r"\n{3,}", "\n\n", "\n".join(
                    line for line in (p.strip() for p in self._parts) if line
                )).strip()

        stripper = _Stripper()
        stripper.feed(raw)
        return stripper.get_text()

    def _normalize_job(self, record: dict[str, Any]) -> dict[str, str]:
        raw_description = (
            record.get("description")
            or record.get("website_description")
            or record.get("requirements")
            or ""
        )
        return {
            "job_id": str(record.get("id") or ""),
            "job_title": str(record.get("name") or "Untitled role"),
            "job_description": self._strip_html(str(raw_description)),
        }

    def _is_candidate_fallback_error(self, exc: Exception) -> bool:
        message = str(exc)
        return "Object hr.candidate doesn't exist" in message or "Invalid field" in message

    def _select_candidates(
        self,
        candidates: list[dict],
        *,
        candidate_ids: list[str],
        selection_prompt: str | None,
    ) -> list[dict]:
        if candidate_ids:
            wanted = set(candidate_ids)
            return [candidate for candidate in candidates if candidate["source_candidate_id"] in wanted]

        if not selection_prompt:
            return []

        prompt = selection_prompt.lower()
        direct_matches = [
            candidate
            for candidate in candidates
            if candidate["name"].lower() in prompt
            or candidate["source_candidate_id"] in prompt
            or (candidate["email"] and candidate["email"].lower() in prompt)
        ]
        if direct_matches:
            return direct_matches

        match = re.search(r"\b(\d+)\b", prompt)
        if match:
            return candidates[: max(1, int(match.group(1)))]

        word_counts = {
            "one": 1,
            "two": 2,
            "three": 3,
            "four": 4,
            "five": 5,
        }
        for word, count in word_counts.items():
            if re.search(rf"\b{word}\b", prompt):
                return candidates[:count]
        return []

    def _resolve_job(
        self,
        jobs: list[dict],
        *,
        job_id: str | None,
        job_description: str | None,
        random_job: bool,
    ) -> dict[str, str]:
        if job_description:
            return {
                "job_id": job_id or "custom",
                "job_title": "Custom job description",
                "job_description": job_description.strip(),
            }

        if job_id:
            for job in jobs:
                if job["job_id"] == job_id:
                    return job
            raise ValueError(f"Job '{job_id}' was not found in the connector.")

        if not jobs:
            raise ValueError("No jobs are available in the connector.")

        if random_job:
            return random.choice(jobs)
        return jobs[0]

    def _render_message(
        self,
        candidate: dict[str, str],
        job: dict[str, str],
        *,
        template: str | None,
    ) -> str:
        default_template = (
            "Hello {candidate_name},\n\n"
            "We think your background is a strong match for {job_title}.\n\n"
            "{job_description}\n\n"
            "Profile notes: {candidate_summary}\n"
        )
        chosen = template or default_template
        return chosen.format(
            candidate_name=candidate["name"],
            candidate_email=candidate["email"],
            candidate_summary=candidate["summary"] or "No summary available.",
            job_title=job["job_title"],
            job_description=job["job_description"] or "No job description provided.",
        )
