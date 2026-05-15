
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.analysis import (
    SemanticAction,
)
from core.models.workflow import Workflow, WorkflowStep
from services.semantic_analysis_service import SemanticAnalysisService


async def _seed_workflow_with_steps(
    session: AsyncSession,
    name: str = "Test Workflow",
    steps_data: list[dict] | None = None,
) -> str:
    wf = Workflow(name=name, status="draft", target_url="https://example.com")
    session.add(wf)
    await session.flush()
    wf_id = str(wf.id)

    if steps_data:
        for sd in steps_data:
            step = WorkflowStep(
                workflow_id=wf_id,
                step_index=sd.get("step_index", sd.get("i", 0)),
                action_type=sd.get("action_type", "click"),
                intent=sd.get("intent"),
                value=sd.get("value"),
                selector_chain=sd.get("selector_chain"),
            )
            session.add(step)
        await session.flush()

    return wf_id


@pytest.mark.asyncio
async def test_analyze_workflow_heuristics_only(db_session: AsyncSession, monkeypatch):
    monkeypatch.setattr("core.config.settings.ai_api_key", "")
    monkeypatch.setattr("core.config.settings.ai_provider", "openai")
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://www.google.com", "intent": "Navigate to Google"},
        {"step_index": 1, "action_type": "type", "value": "Indeed jobs", "intent": "Type search query"},
        {"step_index": 2, "action_type": "navigate", "value": "https://indeed.com", "intent": "Open Indeed"},
        {"step_index": 3, "action_type": "type", "value": "Python developer", "intent": "Type search term"},
        {"step_index": 4, "action_type": "type", "value": "Alajuela", "intent": "Type location"},
        {"step_index": 5, "action_type": "click", "value": "", "intent": "Click search button"},
        {"step_index": 6, "action_type": "click", "value": "", "intent": "Click listing title"},
        {"step_index": 7, "action_type": "click", "value": "", "intent": "Click next page"},
    ]
    wf_id = await _seed_workflow_with_steps(db_session, "Job Search", steps)

    svc = SemanticAnalysisService(db_session)
    analysis = await svc.analyze_workflow(wf_id)

    assert analysis is not None
    assert analysis.workflow_goal is not None
    assert len(analysis.workflow_goal) > 0
    assert analysis.domain_context is not None
    assert analysis.confidence_overall >= 0.0

    # Verify phases were created
    phases = await svc.get_phases(wf_id)
    assert len(phases) > 0

    # Verify parameters were detected
    params = await svc.get_parameters(wf_id)
    param_keys = [p.parameter_key for p in params]
    assert len(params) >= 1
    # At minimum should detect the type actions with values
    type_params = [p for p in params if p.parameter_type == "string"]
    assert len(type_params) >= 1

    # Verify semantic actions
    result = await db_session.execute(
        select(SemanticAction).where(SemanticAction.workflow_id == wf_id)
    )
    actions = result.scalars().all()
    assert len(actions) == len(steps)

    # Verify output spec
    output_spec = await svc.get_output_spec(wf_id)
    assert output_spec is not None
    assert output_spec.output_type in ("unknown", "structured_data", "submitted_form")

    # Verify template was created
    template = await svc.get_template(wf_id)
    assert template is not None
    assert template.template_version == 1
    assert "parameters" in template.template_data


@pytest.mark.asyncio
async def test_analyze_workflow_with_ai_synthesis(db_session: AsyncSession, monkeypatch):
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://indeed.com"},
        {"step_index": 1, "action_type": "type", "value": "React developer"},
        {"step_index": 2, "action_type": "type", "value": "Berlin"},
        {"step_index": 3, "action_type": "click", "intent": "Click search"},
        {"step_index": 4, "action_type": "click", "intent": "Click listing"},
        {"step_index": 5, "action_type": "click", "intent": "Click copy button"},
    ]
    wf_id = await _seed_workflow_with_steps(db_session, "AI Job Search", steps)

    from tests.doubles import FakeSemanticAnalysisProvider

    def _provider_factory(api_key_override=None):
        return FakeSemanticAnalysisProvider(
            goal="Extract job listings for React developers in Berlin",
            summary="Searches Indeed for React developers in Berlin and extracts job details.",
            domain="job_search",
            confidence_overall=0.92,
            parameters=[
                {"key": "technologies", "type": "string", "default": "React developer", "step_index": 1, "description": "Search query", "confidence": 0.95, "required": True},
                {"key": "location", "type": "string", "default": "Berlin", "step_index": 2, "description": "Location filter", "confidence": 0.88, "required": True},
            ],
        )

    import services.semantic_analysis_service as sas_module
    monkeypatch.setattr(sas_module, "get_ai_provider", _provider_factory)
    monkeypatch.setattr(sas_module.settings, "ai_api_key", "test-key")
    monkeypatch.setattr(sas_module.settings, "ai_provider", "openai")

    svc = SemanticAnalysisService(db_session)
    analysis = await svc.analyze_workflow(wf_id)

    assert analysis is not None
    assert "Extract" in analysis.workflow_goal or "search" in analysis.workflow_goal.lower()
    assert analysis.confidence_overall > 0.8
    assert analysis.ai_model_used is not None

    params = await svc.get_parameters(wf_id)
    param_keys = {p.parameter_key for p in params}
    assert "technologies" in param_keys
    assert "location" in param_keys


@pytest.mark.asyncio
async def test_analyze_workflow_ai_fallback_on_error(db_session: AsyncSession, monkeypatch):
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://example.com"},
        {"step_index": 1, "action_type": "type", "value": "test query"},
    ]
    wf_id = await _seed_workflow_with_steps(db_session, "Fallback Test", steps)

    from tests.doubles import FakeAIUnparseableProvider

    def _provider_factory(api_key_override=None):
        return FakeAIUnparseableProvider()

    import services.semantic_analysis_service as sas_module
    monkeypatch.setattr(sas_module, "get_ai_provider", _provider_factory)
    monkeypatch.setattr(sas_module.settings, "ai_api_key", "test-key")
    monkeypatch.setattr(sas_module.settings, "ai_provider", "openai")

    svc = SemanticAnalysisService(db_session)
    analysis = await svc.analyze_workflow(wf_id)

    assert analysis is not None
    assert analysis.workflow_goal is not None
    # Should have fallen back to heuristics


@pytest.mark.asyncio
async def test_get_analysis_returns_none_for_unanalyzed_workflow(db_session: AsyncSession):
    wf_id = await _seed_workflow_with_steps(db_session, "No Analysis")

    svc = SemanticAnalysisService(db_session)
    analysis = await svc.get_analysis(wf_id)
    assert analysis is None


@pytest.mark.asyncio
async def test_analyze_clears_prior_results(db_session: AsyncSession):
    steps = [
        {"step_index": 0, "action_type": "click", "intent": "Test step"},
    ]
    wf_id = await _seed_workflow_with_steps(db_session, "Reanalyze", steps)

    svc = SemanticAnalysisService(db_session)
    a1 = await svc.analyze_workflow(wf_id)
    assert a1 is not None

    a2 = await svc.analyze_workflow(wf_id)
    assert a2 is not None

    phases = await svc.get_phases(wf_id)
    actions_result = await db_session.execute(
        select(SemanticAction).where(SemanticAction.workflow_id == wf_id)
    )
    actions = actions_result.scalars().all()
    params = await svc.get_parameters(wf_id)

    # Should have exactly the right count from the re-analysis
    assert len(actions) == len(steps)


@pytest.mark.asyncio
async def test_update_analysis_user_edits(db_session: AsyncSession):
    steps = [{"step_index": 0, "action_type": "click"}]
    wf_id = await _seed_workflow_with_steps(db_session, "Edit Analysis", steps)

    svc = SemanticAnalysisService(db_session)
    await svc.analyze_workflow(wf_id)

    updated = await svc.update_analysis(wf_id, {"workflow_goal": "My custom goal", "replay_strategy": "semantic"})
    assert updated.is_user_edited is True
    assert updated.analysis_version == 2

    analysis = await svc.get_analysis(wf_id)
    assert analysis.workflow_goal == "My custom goal"
    assert analysis.replay_strategy == "semantic"


@pytest.mark.asyncio
async def test_update_parameter(db_session: AsyncSession):
    steps = [
        {"step_index": 0, "action_type": "type", "value": "search term"},
    ]
    wf_id = await _seed_workflow_with_steps(db_session, "Edit Param", steps)

    svc = SemanticAnalysisService(db_session)
    await svc.analyze_workflow(wf_id)

    params = await svc.get_parameters(wf_id)
    assert len(params) >= 1

    param_key = params[0].parameter_key
    updated = await svc.update_parameter(wf_id, param_key, {"default_value": "Python", "is_required": False})
    assert updated.parameter_key == param_key

    param = [p for p in await svc.get_parameters(wf_id) if p.parameter_key == param_key][0]
    assert param.default_value == "Python"
    assert param.is_required is False


@pytest.mark.asyncio
async def test_phase_detection_with_domain_changes(db_session: AsyncSession):
    steps = [
        {"step_index": 0, "action_type": "navigate", "value": "https://google.com", "intent": "Go to Google"},
        {"step_index": 1, "action_type": "type", "value": "job search", "intent": "Search for jobs"},
        {"step_index": 2, "action_type": "navigate", "value": "https://indeed.com", "intent": "Open Indeed"},
        {"step_index": 3, "action_type": "type", "value": "developer", "intent": "Type job"},
        {"step_index": 4, "action_type": "click", "intent": "Click listing"},
    ]
    wf_id = await _seed_workflow_with_steps(db_session, "Domain Phases", steps)

    svc = SemanticAnalysisService(db_session)
    analysis = await svc.analyze_workflow(wf_id)

    phases = await svc.get_phases(wf_id)
    assert len(phases) >= 2


@pytest.mark.asyncio
async def test_parameter_candidates_from_type_actions(db_session: AsyncSession):
    steps = [
        {"step_index": 0, "action_type": "type", "value": "Python developer", "intent": "Search query"},
        {"step_index": 1, "action_type": "type", "value": "Alajuela", "intent": "Location"},
        {"step_index": 2, "action_type": "type", "value": "Full-time", "intent": "Filter"},
    ]
    wf_id = await _seed_workflow_with_steps(db_session, "Params Test", steps)

    svc = SemanticAnalysisService(db_session)
    analysis = await svc.analyze_workflow(wf_id)

    params = await svc.get_parameters(wf_id)
    assert len(params) >= 2


@pytest.mark.asyncio
async def test_empty_workflow_analysis(db_session: AsyncSession):
    wf = Workflow(name="Empty", status="draft")
    db_session.add(wf)
    await db_session.flush()
    wf_id = str(wf.id)

    svc = SemanticAnalysisService(db_session)
    analysis = await svc.analyze_workflow(wf_id)

    assert analysis is not None
    assert analysis.confidence_overall == 0.6


@pytest.mark.asyncio
async def test_output_spec_is_created(db_session: AsyncSession):
    steps = [
        {"step_index": 0, "action_type": "click", "intent": "Click listing"},
        {"step_index": 1, "action_type": "type", "value": "test"},
    ]
    wf_id = await _seed_workflow_with_steps(db_session, "Output Test", steps)

    svc = SemanticAnalysisService(db_session)
    await svc.analyze_workflow(wf_id)

    output_spec = await svc.get_output_spec(wf_id)
    assert output_spec is not None
    assert output_spec.workflow_id == wf_id


@pytest.mark.asyncio
async def test_template_created_on_analyze(db_session: AsyncSession):
    steps = [{"step_index": 0, "action_type": "click", "intent": "Test"}]
    wf_id = await _seed_workflow_with_steps(db_session, "Template Test", steps)

    svc = SemanticAnalysisService(db_session)
    await svc.analyze_workflow(wf_id)

    template = await svc.get_template(wf_id)
    assert template is not None
    assert template.is_active is True
    assert "parameters" in template.template_data
    assert "replay_strategy" in template.template_data
