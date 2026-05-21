from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.models.event import EventLog
from core.models.workflow import Workflow
from services.agent_models import PageContext, PollRequest, ResultRequest, SAFETY_LIMITS
from services.agent_service import AgentService
from services.execution_service import ExecutionService


def _step(index: int, action_type: str = "click", value: str | None = None) -> dict:
    return {
        "step_index": index,
        "action_type": action_type,
        "intent": f"Step {index}",
        "selector_chain": [{"type": "css", "value": f"#step-{index}"}],
        "value": value,
        "methods": [],
    }


def _snapshot(steps: list[dict]) -> dict:
    return {
        "workflow": {"id": "wf-1", "name": "WF", "version": 1, "target_url": "https://example.com"},
        "steps": steps,
    }


@pytest.mark.asyncio
async def test_report_result_rejects_terminal_runs(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Terminal Result Guard", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _snapshot([_step(0, "scroll")])
    run.total_steps = 1
    run.status = "completed"
    await db_session.flush()

    agent = AgentService(db_session)
    result = await agent.report_result(
        str(run.id),
        ResultRequest(step_index=0, success=True),
    )
    await db_session.refresh(run)

    assert result.accepted is False
    assert result.decision == "COMPLETED"
    assert result.should_poll is False
    assert run.status == "completed"

    step_events = (
        await db_session.execute(
            select(EventLog)
            .where(EventLog.run_id == run.id)
            .where(EventLog.event_type == "step_executed")
        )
    ).scalars().all()
    assert step_events == []


@pytest.mark.asyncio
async def test_apply_plan_updates_normalizes_operation_aliases(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Plan Op Alias Canonicalization", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _snapshot([_step(0), _step(1)])
    run.total_steps = 2
    await db_session.flush()

    agent = AgentService(db_session)
    applied_ops: list[dict] = []

    async def _capture_ops(_run, ops):
        applied_ops.extend(ops)

    agent.healing.apply_plan_update = _capture_ops  # type: ignore[method-assign]
    result = await agent._apply_plan_updates_from_ai(
        run,
        [
            {"operation": "ADD", "step_index": 1, "new_step": _step(99), "reason": "alias-add"},
            {"operation": "SKIP", "step_index": 0, "reason": "alias-skip"},
        ],
    )

    assert [op["operation"] for op in applied_ops] == ["INSERT", "REMOVE"]
    assert [op["operation"] for op in result] == ["INSERT", "REMOVE"]


@pytest.mark.asyncio
async def test_ai_unusable_output_budget_escalates_to_pause(
    db_session: AsyncSession,
    monkeypatch,
):
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "deterministic_only", False, raising=False)
    monkeypatch.setitem(SAFETY_LIMITS, "max_ai_unusable_output_wait_cycles", 2)

    svc = ExecutionService(db_session)
    workflow = Workflow(name="Unusable Output Budget", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _snapshot([_step(0, "scroll")])
    run.total_steps = 1
    run.status = "running"
    await db_session.flush()

    agent = AgentService(db_session)
    monkeypatch.setattr(agent, "_consult_ai_for_step", AsyncMock(return_value=None))

    req = PollRequest(
        current_step_index=0,
        page_context=PageContext(
            url="https://example.com/unstable",
            title="Unstable",
            visible_elements=[{"selector": "#x"}],
            visible_text="ready",
            page_diff={"added": []},
        ),
    )
    first = await agent.poll(str(run.id), req)
    second = await agent.poll(str(run.id), req)
    await db_session.refresh(run)

    assert first.decision == "WAIT"
    assert second.decision == "PAUSE"
    assert second.pause_reason == "ai_unusable_output_budget_exhausted"
    assert run.status == "waiting_for_user"


@pytest.mark.asyncio
async def test_ai_failure_click_uses_js_fallback_command(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="JS Click Fallback", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _snapshot([_step(0, "click", value="Inicio")])
    run.total_steps = 1
    run.status = "running"
    await db_session.flush()

    agent = AgentService(db_session)
    step = run.workflow_snapshot["steps"][0]
    response = await agent._fallback_after_ai_failure(
        run=run,
        step_index=0,
        step=step,
        ctx=PageContext(
            url="https://www.speedtest.net/es",
            title="Speedtest",
            page_diff={"added": []},
            visible_elements=[
                {"selector": "button.start-button", "text": "Inicio"},
                {"selector": "a.help-link", "text": "Ayuda"},
            ],
        ),
    )

    assert response is not None
    assert response.decision == "EXECUTE"
    assert response.command is not None
    assert response.command.action.value == "run_script"
    assert response.command.script is not None
    assert "JS_CLICK_FALLBACK_NO_TARGET" in response.command.script
    assert "normalizeToken" in response.command.script
    assert response.command.script_args["label"] == "Inicio"
    assert "button.start-button" in response.command.script_args["selectorCandidates"]
    assert "Inicio" in response.command.script_args["textCandidates"]


@pytest.mark.asyncio
async def test_ai_failure_navigate_template_uses_intent_url(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Navigate Template Fallback", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _snapshot([
        {
            "step_index": 0,
            "action_type": "navigate",
            "intent": "Navigate to https://www.speedtest.net/es",
            "selector_chain": [],
            "value": "{{url_target}}",
            "methods": [],
        }
    ])
    run.total_steps = 1
    run.status = "running"
    await db_session.flush()

    agent = AgentService(db_session)
    step = run.workflow_snapshot["steps"][0]
    response = await agent._fallback_after_ai_failure(
        run=run,
        step_index=0,
        step=step,
        ctx=PageContext(url="about:blank", title="Blank"),
    )

    assert response is not None
    assert response.decision == "EXECUTE"
    assert response.command is not None
    assert response.command.action.value == "navigate"
    assert response.command.value == "https://www.speedtest.net/es"


@pytest.mark.asyncio
async def test_report_result_pauses_on_repeated_script_no_target(
    db_session: AsyncSession,
):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Script No Target Guard", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _snapshot([_step(0, "click", value="Iniciar")])
    run.total_steps = 1
    run.status = "running"
    await db_session.flush()

    agent = AgentService(db_session)
    first = await agent.report_result(
        str(run.id),
        ResultRequest(step_index=0, success=False, error="JS_CLICK_FALLBACK_NO_TARGET:Iniciar"),
    )
    second = await agent.report_result(
        str(run.id),
        ResultRequest(step_index=0, success=False, error="JS_CLICK_FALLBACK_NO_TARGET:Iniciar"),
    )
    await db_session.refresh(run)

    assert first.accepted is True
    assert first.should_poll is True
    assert second.decision == "PAUSE"
    assert second.should_poll is True
    assert run.status == "waiting_for_user"
    assert run.pause_reason == "script_no_target_repeated"


def test_analyze_click_candidates_handles_numeric_punctuation():
    ctx = PageContext(
        url="https://example.com",
        title="Result",
        visible_text="Download 324,57 Mbps",
        visible_elements=[
            {"selector": "div.metric-value", "text": "324,57"},
            {"selector": "button.other", "text": "Other"},
        ],
    )
    result = AgentService._analyze_click_candidates_from_page_content(ctx, "324.57")
    assert "div.metric-value" in result["selectors"]
    assert "324,57" in result["texts"]


def test_selector_classifier_treats_numeric_value_as_text_candidate(db_session: AsyncSession):
    agent = AgentService(db_session)
    cmd = agent._build_js_click_fallback_command(
        step={
            "action_type": "click",
            "value": "324.57",
            "selector_chain": [{"type": "css", "value": "324.57"}],
        },
        ctx=PageContext(url="https://example.com", title="Result"),
    )
    assert cmd is not None
    assert cmd.script_args["selectorCandidates"] == []
    assert "324.57" in cmd.script_args["textCandidates"]


def test_js_click_fallback_extracts_shadow_css_into_shadow_selectors(db_session: AsyncSession):
    """shadow_css selectors (JSON with host_chain) must NOT leak into the
    selectorCandidates bucket — passing the JSON string to document.querySelector
    throws and silently kills the click fallback. They go to shadowSelectors
    where the harness walks host_chain through shadowRoot.querySelector."""
    agent = AgentService(db_session)
    cmd = agent._build_js_click_fallback_command(
        step={
            "action_type": "click",
            "value": "Send",
            "selector_chain": [
                {
                    "type": "shadow_css",
                    "value": (
                        '{"host_chain":["div[data-testid=\\"interop-shadowdom\\"]"],'
                        '"target":"button[aria-label=\\"Send\\"]"}'
                    ),
                    "score": 0.97,
                },
                {"type": "css", "value": "button[aria-label='Send']"},
            ],
        },
        ctx=PageContext(url="https://www.linkedin.com/feed/", title="Feed"),
    )
    assert cmd is not None
    # The CSS selector should remain in selectorCandidates
    assert "button[aria-label='Send']" in cmd.script_args["selectorCandidates"]
    # The shadow_css JSON must NOT pollute selectorCandidates
    assert not any(
        "host_chain" in str(c) for c in cmd.script_args["selectorCandidates"]
    )
    # And the shadowSelectors arg must contain the parsed entry
    shadow_selectors = cmd.script_args["shadowSelectors"]
    assert len(shadow_selectors) == 1
    assert shadow_selectors[0]["hostChain"] == ['div[data-testid="interop-shadowdom"]']
    assert shadow_selectors[0]["target"] == 'button[aria-label="Send"]'


def test_js_type_fallback_extracts_shadow_css_into_shadow_selectors(db_session: AsyncSession):
    """Same guarantee for the JS type fallback: shadow_css selectors get
    parsed into shadowSelectors arg, not passed as raw CSS."""
    cmd = AgentService._build_js_type_fallback_command(
        step={
            "action_type": "type",
            "value": "Hello",
            "intent": "Type into compose box",
            "selector_chain": [
                {
                    "type": "shadow_css",
                    "value": (
                        '{"host_chain":["div[data-testid=\\"interop-shadowdom\\"]"],'
                        '"target":"div[contenteditable=\\"true\\"]"}'
                    ),
                },
                {"type": "css", "value": "div.msg-form__contenteditable"},
            ],
        },
    )
    assert cmd is not None
    assert "div.msg-form__contenteditable" in cmd.script_args["cssCandidates"]
    shadow = cmd.script_args["shadowSelectors"]
    assert len(shadow) == 1
    assert shadow[0]["hostChain"] == ['div[data-testid="interop-shadowdom"]']
    assert shadow[0]["target"] == 'div[contenteditable="true"]'


def test_js_click_fallback_harness_script_references_shadow_helpers(db_session: AsyncSession):
    """Sanity check: the harness script must include the deep-query / shadow
    helpers; otherwise we'd silently strip shadow_css support."""
    agent = AgentService(db_session)
    cmd = agent._build_js_click_fallback_command(
        step={"action_type": "click", "value": "Send", "selector_chain": []},
        ctx=PageContext(url="https://example.com", title="X"),
    )
    assert cmd is not None
    assert "deepQuerySelector" in cmd.script
    assert "resolveShadowSelector" in cmd.script
    assert "shadowSelectors" in cmd.script


def test_extract_click_label_from_intent_when_value_missing():
    assert AgentService._extract_click_label({"action_type": "click", "intent": "Click Iniciar"}) == "Iniciar"


def test_extract_click_label_prefers_quoted_intent_text():
    step = {
        "action_type": "click",
        "intent": 'Click on "Write a message…" (labeled "Write a message…")',
        "value": None,
        "selector_chain": [],
    }
    assert AgentService._extract_click_label(step) == "Write a message…"


def test_linkedin_site_command_compiles_messaging_steps(db_session: AsyncSession):
    agent = AgentService(db_session)
    ctx = PageContext(url="https://www.linkedin.com/feed/", title="LinkedIn")

    cmd = agent._build_linkedin_site_command(
        {
            "action_type": "click",
            "intent": "Click the button \"Send\"",
            "value": "Send",
            "selector_chain": [
                {
                    "type": "shadow_css",
                    "value": '{"host_chain":["div[data-testid=\\"interop-shadowdom\\"]"],"target":"button"}',
                }
            ],
        },
        ctx,
    )
    assert cmd is not None
    assert cmd.script_args["__harness"] == "linkedin_site"
    assert cmd.script_args["operation"] == "send_message"
    assert cmd.script_args["scope"] == "messaging_dock"


def test_linkedin_site_command_compiles_general_nav_click(db_session: AsyncSession):
    agent = AgentService(db_session)
    cmd = agent._build_linkedin_site_command(
        {
            "action_type": "click",
            "intent": "Click Messaging",
            "value": "Messaging",
            "selector_chain": [],
        },
        PageContext(url="https://www.linkedin.com/feed/", title="LinkedIn"),
    )
    assert cmd is not None
    assert cmd.script_args["__harness"] == "linkedin_site"
    assert cmd.script_args["operation"] == "open_messaging_dock"


def test_linkedin_site_command_uses_intent_when_context_url_is_stale(db_session: AsyncSession):
    agent = AgentService(db_session)
    cmd = agent._build_linkedin_site_command(
        {
            "action_type": "click",
            "intent": "Click Home in the LinkedIn top navigation",
            "value": "Home",
            "selector_chain": [{"type": "text", "value": "Home"}],
        },
        PageContext(url="about:blank", title="Transitioning"),
    )
    assert cmd is not None
    assert cmd.script_args["__harness"] == "linkedin_site"
    assert cmd.script_args["operation"] == "click"
    assert cmd.script_args["scope"] == "global_nav"
    assert cmd.script_args["label"] == "Home"


def test_linkedin_site_type_message_uses_visible_text_condition(db_session: AsyncSession):
    agent = AgentService(db_session)
    cmd = agent._build_linkedin_site_command(
        {
            "action_type": "type",
            "intent": 'Type "Hello" into div (labeled "Write a message…")',
            "value": "Hello",
            "selector_chain": [
                {
                    "type": "shadow_css",
                    "value": '{"host_chain":["div[data-testid=\\"interop-shadowdom\\"]"],"target":"[role=\\"textbox\\"]"}',
                }
            ],
            "success_condition": {"type": "input_value_contains", "value": "Hello"},
        },
        PageContext(url="https://www.linkedin.com/feed/", title="LinkedIn"),
    )
    assert cmd is not None
    assert cmd.script_args["operation"] == "type_message"
    assert cmd.success_condition == {"type": "visible_text_contains", "value": "Hello"}


def test_build_command_resolves_navigate_url_from_intent(db_session: AsyncSession):
    agent = AgentService(db_session)
    cmd = agent._build_command(
        {
            "action_type": "navigate",
            "intent": "Navigate to https://www.speedtest.net/es/result/12345",
            "value": "{{url_target}}",
            "selector_chain": [],
            "methods": [],
        }
    )
    assert cmd.action.value == "navigate"
    assert cmd.value == "https://www.speedtest.net/es/result/12345"


def test_classify_fatal_script_errors():
    classify = AgentService._classify_script_failure
    assert classify("SCRIPT_PARSE_ERROR: Evaluating a string violates CSP") == "fatal"
    assert classify("SCRIPT_PARSE_ERROR: unexpected token '}'") == "fatal"
    assert classify("content security policy directive violated") == "fatal"
    assert classify("SCRIPT_TIMEOUT: took too long") == "timeout"
    assert classify("JS_CLICK_FALLBACK_NO_TARGET:Iniciar") == "no-target"
    assert classify("ReferenceError: x is not defined") == "threw"
    assert classify(None) is None
    assert classify("") is None


@pytest.mark.asyncio
async def test_report_result_fatal_error_fails_run(db_session: AsyncSession):
    svc = ExecutionService(db_session)
    workflow = Workflow(name="Fatal CSP Run", status="draft")
    db_session.add(workflow)
    await db_session.flush()

    run = await svc.create_run(workflow_id=str(workflow.id))
    run.workflow_snapshot = _snapshot([_step(0, "click")])
    run.total_steps = 1
    run.status = "running"
    await db_session.flush()

    agent = AgentService(db_session)
    result = await agent.report_result(
        str(run.id),
        ResultRequest(
            step_index=0,
            success=False,
            error="SCRIPT_PARSE_ERROR: Evaluating a string as JavaScript violates Content Security Policy",
        ),
    )
    await db_session.refresh(run)

    assert result.accepted is True
    assert result.should_poll is False
    assert run.status == "failed"
    assert run.ended_at is not None
    assert "SCRIPT_PARSE_ERROR" in (run.error_summary or "")
