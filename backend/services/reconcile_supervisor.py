"""Reconcile supervisor — backfills job-positions the webhook missed.

The Odoo→session-replay webhook (`hr_job.py::_notify_session_replay_new_job`) is
the low-latency path: a position goes `linkedin_sync=True AND is_published=True`
and Odoo POSTs to `/v1/webhooks/incoming/odoo/{connector_id}`, which creates a
QUEUED run for the single LinkedIn daemon to drive.

But that POST is best-effort and fire-once: if it fails (backend bouncing,
network blip) or the run otherwise never materialises, the position is silently
dropped. This supervisor is the safety net. Periodically (and once on startup) it
asks Odoo which positions are currently LinkedIn-eligible and enqueues any that
lack a run — spaced out for anti-bot by the daemon's existing inter-run cooldown.

Two invariants keep it from misbehaving:

- **Activation watermark.** On first sight of a connector it records
  `max(hr.job id)` into `connector.config["reconcile_min_job_id"]` and enqueues
  nothing that pass. Thereafter only positions with `id > watermark` (i.e.
  created after install) are ever backfilled — the historical backlog never
  triggers a flow. The watermark is fixed, never advanced.
- **Dedup by job_id.** Before enqueuing, it checks whether a run already exists
  for the position (`WebhookTriggerService._find_run_by_job_id`), so one position
  yields exactly one flow no matter how many passes run.

Singleton note: if several backends share one Postgres, set `RECONCILER_ENABLED`
on only one of them — concurrent passes converge via the job_id dedup but could
double-enqueue in a millisecond race. The daemon on Fernanda's Mac remains the
sole executor regardless.
"""
from __future__ import annotations

import asyncio
import logging
import os

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm.attributes import flag_modified

from services.connector_forum_service import ConnectorForumService
from services.webhook_trigger_service import (
    SUPPORTED_EVENT_KINDS,
    WebhookTriggerService,
)

logger = logging.getLogger(__name__)

# How often to sweep Odoo for missed positions. 5 min keeps the race window
# small for the multi-backend case while staying cheap (one search_read per
# connector). On startup the loop runs once immediately.
RECONCILE_POLL_INTERVAL = int(os.getenv("RECONCILE_POLL_INTERVAL_SECONDS", "300"))
# Set to 0/false on secondary backends so only one instance reconciles.
RECONCILE_ENABLED = os.getenv("RECONCILER_ENABLED", "1").lower() not in (
    "0",
    "false",
    "no",
    "",
)
# Upper bound on LinkedIn-eligible positions scanned per pass. A real recruitment
# pipeline has at most a handful open at once; 200 is a generous ceiling.
RECONCILE_JOB_FETCH_LIMIT = int(os.getenv("RECONCILE_JOB_FETCH_LIMIT", "200"))


class ReconcileSupervisor:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.webhook = WebhookTriggerService(session)
        self.forum = ConnectorForumService(session)

    async def reconcile_all(self) -> int:
        """Reconcile every connector that has an enabled supported trigger.

        Returns the number of runs enqueued across all connectors."""
        triggers = await self.webhook.list_triggers()
        connector_ids = sorted(
            {
                str(t.connector_id)
                for t in triggers
                if t.enabled
                and t.event_kind in SUPPORTED_EVENT_KINDS
                and t.connector_id
            }
        )
        total = 0
        for connector_id in connector_ids:
            try:
                total += await self.reconcile_connector(connector_id)
            except Exception:
                logger.exception("Reconcile failed for connector %s", connector_id)
                await self.session.rollback()
        return total

    async def reconcile_connector(self, connector_id: str) -> int:
        connector = await self.forum.resolve_connector(connector_id)
        if connector is None:
            return 0

        config = dict(connector.config or {})
        watermark_raw = config.get("reconcile_min_job_id")

        # First sight: baseline at the current max id and enqueue nothing. This is
        # the "everything that exists now is historical" cutover the user asked
        # for — no manual install step needed.
        if watermark_raw is None:
            baseline = await self.forum.fetch_max_job_id(connector)
            config["reconcile_min_job_id"] = baseline
            connector.config = config
            flag_modified(connector, "config")
            await self.session.commit()
            logger.info(
                "Reconcile baseline for connector %s set to job_id=%s",
                connector_id,
                baseline,
            )
            return 0

        try:
            watermark = int(watermark_raw)
        except (TypeError, ValueError):
            watermark = 0

        jobs = await self.forum.fetch_jobs(
            connector,
            filters={"linkedin_sync": True, "is_published": True},
            limit=RECONCILE_JOB_FETCH_LIMIT,
        )

        enqueued = 0
        for job in jobs:
            try:
                job_id = int(job.get("job_id") or 0)
            except (TypeError, ValueError):
                continue
            if job_id <= watermark:
                continue  # historical position — never backfill
            existing = await self.webhook._find_run_by_job_id(str(job_id))
            if existing is not None:
                continue  # webhook (or a prior pass) already handled it

            # Reuse the webhook ingress path so the run is built identically
            # (plan, origin, candidate_count cap, trigger selection). Flat payload
            # mirrors hr_job.py::_notify_session_replay_new_job.
            payload = {
                "job_id": str(job_id),
                "name": job.get("job_title") or "",
                "job_title": job.get("job_title") or "",
                "job_description": job.get("job_description") or "",
            }
            run_ids = await self.webhook.fire_from_odoo_payload(connector_id, payload)
            if run_ids:
                enqueued += len(run_ids)
                logger.info(
                    "Reconcile enqueued run(s) %s for missed job_id=%s (connector %s)",
                    run_ids,
                    job_id,
                    connector_id,
                )

        await self.session.commit()
        return enqueued

    @staticmethod
    def start_supervisor(app) -> asyncio.Task | None:
        """Wire into FastAPI's lifespan — mirrors RecoverySupervisor."""
        if not RECONCILE_ENABLED:
            logger.info("Reconcile supervisor disabled (RECONCILER_ENABLED=0)")
            return None
        from core.database import async_session_factory

        task = asyncio.create_task(_run_supervisor_loop(async_session_factory))
        app.state.reconcile_supervisor = task
        logger.info("Reconcile supervisor background task started")
        return task


async def _run_supervisor_loop(session_factory: async_sessionmaker[AsyncSession]):
    logger.info("Reconcile supervisor loop started (interval=%ss)", RECONCILE_POLL_INTERVAL)
    while True:
        try:
            async with session_factory() as session:
                supervisor = ReconcileSupervisor(session)
                enqueued = await supervisor.reconcile_all()
                if enqueued:
                    logger.info("Reconcile pass enqueued %s run(s)", enqueued)
        except Exception:
            logger.exception("Reconcile supervisor error")
        await asyncio.sleep(RECONCILE_POLL_INTERVAL)
