import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.analysis import WorkflowParameter
from core.models.connector import ConnectorConfig
from core.models.workflow import Workflow
from services.workflow_connector_service import WorkflowConnectorService


async def _seed_workflow_param_and_connector(session: AsyncSession) -> tuple[str, str]:
    workflow = Workflow(name="Connector Binding WF", status="active")
    session.add(workflow)
    await session.flush()

    session.add(
        WorkflowParameter(
            workflow_id=str(workflow.id),
            parameter_key="recipient",
            parameter_type="string",
            default_value="Fallback message",
            is_required=True,
        )
    )
    session.add(
        WorkflowParameter(
            workflow_id=str(workflow.id),
            parameter_key="secondary",
            parameter_type="string",
            default_value="Secondary",
            is_required=False,
        )
    )
    from core.models.workflow import WorkflowStep
    session.add(
        WorkflowStep(
            workflow_id=str(workflow.id),
            step_index=0,
            action_type="type",
            intent="Type message",
            value="Fallback message",
        )
    )
    connector = ConnectorConfig(
        name="Odoo Test",
        connector_type="odoo",
        config={"url": "https://odoo.example.com", "database": "db", "username": "u", "password": "p"},
    )
    session.add(connector)
    await session.flush()
    return str(workflow.id), str(connector.id)


@pytest.mark.asyncio
async def test_save_and_preview_binding(db_session: AsyncSession, monkeypatch):
    workflow_id, connector_id = await _seed_workflow_param_and_connector(db_session)
    svc = WorkflowConnectorService(db_session)

    async def _jobs(*_args, **_kwargs):
        return [
            {"job_id": "2", "job_title": "Older Role", "job_description": "Old description"},
            {"job_id": "9", "job_title": "Latest Role", "job_description": "Latest description"},
        ]

    monkeypatch.setattr(
        "services.connector_forum_service.ConnectorForumService.fetch_jobs",
        _jobs,
    )

    binding = await svc.save_binding(
        workflow_id,
        "recipient",
        connector_id=connector_id,
        workflow_step_index=0,
        source_kind="odoo_latest_job",
        template="Role: {job_title}\n\n{job_description}",
        job_filters={},
        enabled=True,
    )
    assert binding.parameter_key == "recipient"
    assert binding.workflow_step_index == 0

    preview = await svc.preview_binding(workflow_id, "recipient")
    assert preview["resolved_value"] == "Role: Latest Role\n\nLatest description"
    assert preview["source_record"]["job_id"] == "9"
    assert preview["workflow_step_index"] == 0
    assert preview["target_summary"] == "Step 1 - type: Type message"


@pytest.mark.asyncio
async def test_resolve_runtime_params_preserves_manual_override(db_session: AsyncSession, monkeypatch):
    workflow_id, connector_id = await _seed_workflow_param_and_connector(db_session)
    svc = WorkflowConnectorService(db_session)

    await svc.save_binding(
        workflow_id,
        "recipient",
        connector_id=connector_id,
        workflow_step_index=None,
        source_kind="odoo_latest_job",
        template="{job_title}: {job_description}",
        job_filters={},
        enabled=True,
    )

    async def _jobs(*_args, **_kwargs):
        return [{"job_id": "4", "job_title": "Connector Role", "job_description": "Connector description"}]

    monkeypatch.setattr(
        "services.connector_forum_service.ConnectorForumService.fetch_jobs",
        _jobs,
    )

    merged, resolutions = await svc.resolve_runtime_params(
        workflow_id,
        {"recipient": "Manual message"},
    )
    assert merged["recipient"] == "Manual message"
    assert resolutions == []


@pytest.mark.asyncio
async def test_rejects_unknown_template_placeholders(db_session: AsyncSession):
    workflow_id, connector_id = await _seed_workflow_param_and_connector(db_session)
    svc = WorkflowConnectorService(db_session)

    with pytest.raises(ValueError, match="Unknown template placeholders"):
        await svc.save_binding(
            workflow_id,
            "recipient",
            connector_id=connector_id,
            workflow_step_index=99,
            source_kind="odoo_latest_job",
            template="{job_title} {candidate_name}",
            job_filters={},
            enabled=True,
        )


@pytest.mark.asyncio
async def test_rejects_unknown_workflow_step(db_session: AsyncSession):
    workflow_id, connector_id = await _seed_workflow_param_and_connector(db_session)
    svc = WorkflowConnectorService(db_session)

    with pytest.raises(ValueError, match="Workflow step '99' does not exist"):
        await svc.save_binding(
            workflow_id,
            "recipient",
            connector_id=connector_id,
            workflow_step_index=99,
            source_kind="odoo_latest_job",
            template="{job_title}",
            job_filters={},
            enabled=True,
        )
