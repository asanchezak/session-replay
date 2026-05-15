
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.workflow import Workflow, WorkflowStep
from services.semantic_analysis_service import SemanticAnalysisService
from services.template_service import TemplateService


async def _seed_analyzed_workflow(session: AsyncSession, name: str = "Template Test") -> str:
    wf = Workflow(name=name, status="draft")
    session.add(wf)
    await session.flush()
    wf_id = str(wf.id)

    steps_data = [
        {"step_index": 0, "action_type": "navigate", "value": "https://example.com", "intent": "Open platform"},
        {"step_index": 1, "action_type": "type", "value": "Python developer", "intent": "Search term"},
        {"step_index": 2, "action_type": "type", "value": "Berlin", "intent": "Location"},
        {"step_index": 3, "action_type": "click", "intent": "Search button"},
        {"step_index": 4, "action_type": "click", "intent": "Listing"},
        {"step_index": 5, "action_type": "click", "intent": "Next page"},
    ]
    for sd in steps_data:
        step = WorkflowStep(
            workflow_id=wf_id,
            step_index=sd["step_index"],
            action_type=sd["action_type"],
            intent=sd.get("intent"),
            value=sd.get("value", ""),
        )
        session.add(step)
    await session.flush()

    svc = SemanticAnalysisService(session)
    await svc.analyze_workflow(wf_id)
    return wf_id


@pytest.mark.asyncio
async def test_generate_template(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")
    wf_id = await _seed_analyzed_workflow(db_session, "Generate Template")

    svc = TemplateService(db_session)
    template = await svc.generate_template(wf_id)

    assert template is not None
    assert "workflow_id" in template
    assert template["workflow_id"] == wf_id
    assert "parameters" in template
    assert "steps" in template
    assert "fixed_steps" in template
    assert "variable_steps" in template
    assert "replay_strategy" in template
    assert len(template["steps"]) == 6
    assert len(template["fixed_steps"]) + len(template["variable_steps"]) == 6


@pytest.mark.asyncio
async def test_substitute_parameters(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")
    wf_id = await _seed_analyzed_workflow(db_session, "Substitute")

    svc = TemplateService(db_session)
    template = await svc.generate_template(wf_id)

    runtime_params = {"search_query": "React developer", "location": "London"}
    substituted = await svc.substitute_parameters(template, runtime_params)

    assert len(substituted) == len(template["steps"])
    assert all("step_index" in s for s in substituted)
    assert all("action_type" in s for s in substituted)


@pytest.mark.asyncio
async def test_substitute_uses_default_when_param_missing(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")
    wf_id = await _seed_analyzed_workflow(db_session, "Default Fallback")

    svc = TemplateService(db_session)
    template = await svc.generate_template(wf_id)

    # Don't provide any runtime params — defaults should be used
    substituted = await svc.substitute_parameters(template, {})

    assert len(substituted) == len(template["steps"])


@pytest.mark.asyncio
async def test_validate_parameters(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")
    wf_id = await _seed_analyzed_workflow(db_session, "Validate")

    svc = TemplateService(db_session)
    # First generate a template
    await svc.generate_template(wf_id)

    # Validate with all params provided
    result = await svc.validate_parameters(wf_id, {"search_query": "test", "location": "Remote"})
    assert "valid" in result
    assert "missing" in result


@pytest.mark.asyncio
async def test_build_execution_plan_literal(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")
    wf_id = await _seed_analyzed_workflow(db_session, "Literal Plan")

    svc = TemplateService(db_session)
    await svc.generate_template(wf_id)

    plan = await svc.build_execution_plan(wf_id)
    assert plan is not None
    assert "strategy" in plan
    assert "mode" in plan


@pytest.mark.asyncio
async def test_build_execution_plan_parameterized(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")
    wf_id = await _seed_analyzed_workflow(db_session, "Param Plan")

    # Update analysis to use parameterized strategy
    analysis_svc = SemanticAnalysisService(db_session)
    await analysis_svc.update_analysis(wf_id, {"replay_strategy": "parameterized"})

    svc = TemplateService(db_session)
    await svc.generate_template(wf_id)

    params = {"search_query": "Go developer", "location": "Remote"}
    plan = await svc.build_execution_plan(wf_id, params)

    assert plan is not None
    assert plan["strategy"] == "parameterized"


@pytest.mark.asyncio
async def test_no_analysis_fallback_to_literal(db_session: AsyncSession):
    wf = Workflow(name="No Analysis WF", status="active")
    db_session.add(wf)
    await db_session.flush()
    wf_id = str(wf.id)

    svc = TemplateService(db_session)
    plan = await svc.build_execution_plan(wf_id, {"param": "value"})

    assert plan["strategy"] == "literal"
    assert plan["mode"] == "exact"


@pytest.mark.asyncio
async def test_template_versioning(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")
    wf_id = await _seed_analyzed_workflow(db_session, "Version Test")

    svc = TemplateService(db_session)
    t1 = await svc.generate_template(wf_id)
    v1 = t1["version"]

    t2 = await svc.generate_template(wf_id)
    v2 = t2["version"]

    assert v2 > v1


@pytest.mark.asyncio
async def test_variable_steps_have_param_references(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")
    wf_id = await _seed_analyzed_workflow(db_session, "Var Steps")

    svc = TemplateService(db_session)
    template = await svc.generate_template(wf_id)

    for step_index in template["variable_steps"]:
        step = template["steps"][step_index]
        assert step["value"].startswith("{{") or step["value"] == ""
