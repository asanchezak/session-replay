from __future__ import annotations

import pytest
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from api.v1.webhooks import CreateTriggerRequest, create_webhook_trigger
from core.models.connector import ConnectorConfig
from core.models.workflow import Workflow


@pytest.mark.asyncio
async def test_create_webhook_trigger_accepts_linkedin_lead_search(
    db_session: AsyncSession,
):
    workflow = Workflow(name="LinkedIn Lead Search", status="active")
    connector = ConnectorConfig(
        name="Odoo",
        connector_type="odoo",
        config={"url": "https://odoo.example.com"},
    )
    db_session.add_all([workflow, connector])
    await db_session.flush()

    result = await create_webhook_trigger(
        str(workflow.id),
        CreateTriggerRequest(
            connector_id=str(connector.id),
            event_kind="linkedin_lead_search",
        ),
        db=db_session,
    )

    assert result["event_kind"] == "linkedin_lead_search"
    assert result["connector_id"] == str(connector.id)
    assert result["workflow_id"] == str(workflow.id)


def test_create_trigger_request_rejects_unknown_event_kind():
    with pytest.raises(ValidationError):
        CreateTriggerRequest(connector_id="connector-1", event_kind="unknown")
