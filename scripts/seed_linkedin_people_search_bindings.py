"""Wire the LinkedIn People Search workflow to a connector's `new_job_position` webhook.

Idempotent. Adds:
- A WebhookTrigger(connector, people_search_workflow, "new_job_position").
- WorkflowConnectorBinding rows: `keyword` → "{job_title}", `count` → "2".
- Disables any existing webhook triggers on OTHER workflows for the same
  connector + event (so the Franz "send invite" workflow doesn't fire during
  iteration-1 testing).

Run from repo root:
    cd backend && source .venv/bin/activate && \
        python ../scripts/seed_linkedin_people_search_bindings.py <connector_id>
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from core.models.analysis import WorkflowConnectorBinding
from core.models.webhook import WebhookTrigger
from core.models.workflow import Workflow

WORKFLOW_NAME = "LinkedIn People Search"
EVENT_KIND = "new_job_position"

BINDINGS = [
    {"parameter_key": "keyword", "template": "{job_title}"},
    {"parameter_key": "count", "template": "2"},
]


async def main(connector_id: str) -> None:
    db_url = os.environ.get(
        "DATABASE_URL",
        "postgresql+asyncpg://workflow:workflow@localhost:5432/workflow",
    )
    engine = create_async_engine(db_url)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as session:
        wf = (
            await session.execute(select(Workflow).where(Workflow.name == WORKFLOW_NAME))
        ).scalar_one_or_none()
        if wf is None:
            print(f"ERROR: workflow '{WORKFLOW_NAME}' not found — run seed_linkedin_people_search.py first.")
            sys.exit(1)
        workflow_id = str(wf.id)
        print(f"Workflow: {workflow_id}  ({WORKFLOW_NAME})")

        existing_trigger = (
            await session.execute(
                select(WebhookTrigger).where(
                    WebhookTrigger.connector_id == connector_id,
                    WebhookTrigger.workflow_id == workflow_id,
                    WebhookTrigger.event_kind == EVENT_KIND,
                )
            )
        ).scalar_one_or_none()
        if existing_trigger:
            existing_trigger.enabled = True
            print(f"Trigger exists, re-enabled: {existing_trigger.id}")
        else:
            trig = WebhookTrigger(
                connector_id=connector_id,
                workflow_id=workflow_id,
                event_kind=EVENT_KIND,
                enabled=True,
            )
            session.add(trig)
            await session.flush()
            print(f"Trigger created: {trig.id}")

        for b in BINDINGS:
            existing_binding = (
                await session.execute(
                    select(WorkflowConnectorBinding).where(
                        WorkflowConnectorBinding.workflow_id == workflow_id,
                        WorkflowConnectorBinding.parameter_key == b["parameter_key"],
                    )
                )
            ).scalar_one_or_none()
            if existing_binding:
                existing_binding.template = b["template"]
                existing_binding.connector_id = connector_id
                existing_binding.enabled = True
                existing_binding.source_kind = "odoo_latest_job"
                print(f"  Binding {b['parameter_key']} updated → {b['template']}")
            else:
                session.add(
                    WorkflowConnectorBinding(
                        workflow_id=workflow_id,
                        parameter_key=b["parameter_key"],
                        connector_id=connector_id,
                        source_kind="odoo_latest_job",
                        template=b["template"],
                        enabled=True,
                    )
                )
                print(f"  Binding {b['parameter_key']} created → {b['template']}")

        # Disable any OTHER workflow triggers on the same connector+event so
        # Franz (or any other iteration-1 testing noise) doesn't fire alongside.
        result = await session.execute(
            update(WebhookTrigger)
            .where(
                WebhookTrigger.connector_id == connector_id,
                WebhookTrigger.event_kind == EVENT_KIND,
                WebhookTrigger.workflow_id != workflow_id,
                WebhookTrigger.enabled.is_(True),
            )
            .values(enabled=False)
        )
        print(f"Disabled {result.rowcount} other trigger(s) on same connector+event.")

        await session.commit()
        print("Done.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python seed_linkedin_people_search_bindings.py <connector_id>")
        sys.exit(2)
    asyncio.run(main(sys.argv[1]))
