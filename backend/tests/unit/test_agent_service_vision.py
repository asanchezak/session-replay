"""Workstream B (vision) tests: verify in-flight screenshot handling.

Properties under test:
1. When a valid screenshot_b64 is on the PollRequest, _consult_ai_for_step
   forwards an `images=[...]` kwarg to provider.generate_with_tools, with
   `detail` chosen by trigger.
2. Bytes are NOT persisted as Artifact rows; only a small `screenshot_meta`
   dict (sha256, dims, mime, byte_size, trigger, detail) is stashed on the
   ai_decision result for the audit pipeline.
3. has_screenshot=True is passed into the prompt builder when an image was
   actually attached.
4. Oversized payloads are dropped (no images, no meta).
"""
from __future__ import annotations

import base64
import struct
from typing import Any
from unittest.mock import AsyncMock

import pytest

from ai.client import ToolCall, ToolUseResponse
from services.agent_service import AgentService, _peek_jpeg_dimensions


def _make_jpeg_bytes(width: int = 1024, height: int = 768) -> bytes:
    soi = b"\xff\xd8"
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof0 = (
        b"\xff\xc0"
        + struct.pack(">H", 17)
        + b"\x08"
        + struct.pack(">H", height)
        + struct.pack(">H", width)
        + b"\x03"
        + b"\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    )
    eoi = b"\xff\xd9"
    padding = b"\x00" * (50_000 - len(soi) - len(app0) - len(sof0) - len(eoi))
    return soi + app0 + sof0 + padding + eoi


def _make_svc_with_tool_use_stub(
    tool_calls: list[ToolCall],
    captured_images: list[Any],
    captured_has_screenshot: list[bool],
    monkeypatch,
) -> AgentService:
    """Bind an AgentService whose _consult_ai_for_step dependencies are all
    stubbed and whose provider.generate_with_tools returns the supplied
    tool_calls. Also captures the `images` kwarg and the `has_screenshot`
    flag that's threaded into the prompt builder."""
    svc = AgentService.__new__(AgentService)
    svc.ai_outcomes = AsyncMock()
    svc.ai_outcomes.load_run_memory = AsyncMock(return_value={"decisions": [], "traces": []})
    svc.session = AsyncMock()
    svc.session.flush = AsyncMock()
    svc._load_previous_failures = AsyncMock(return_value=[])  # type: ignore[method-assign]
    svc._load_workflow_expertise = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._get_current_phase = lambda _a, _b: None  # type: ignore[method-assign]
    svc._apply_plan_updates_from_ai = AsyncMock(return_value=[])  # type: ignore[method-assign]

    fake_provider = AsyncMock()

    async def _generate_with_tools(messages, tools, system=None, max_tokens=2048, images=None):
        captured_images.append(images)
        return ToolUseResponse(
            tool_calls=tool_calls,
            content="",
            model="gpt-4o-mini",
            usage={"prompt_tokens": 100, "completion_tokens": 20},
            stop_reason="tool_calls",
        )

    fake_provider.generate_with_tools = _generate_with_tools
    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_: fake_provider)

    def _capture_has_screenshot(**kwargs):
        captured_has_screenshot.append(kwargs.get("has_screenshot", False))
        return "test prompt"

    monkeypatch.setattr("services.agent_service.build_agent_decision_prompt", _capture_has_screenshot)
    return svc


def _make_run_and_ctx() -> tuple[Any, dict[str, Any], Any]:
    run = type("Run", (), {
        "id": "run-1", "goal_progress": None,
        "workflow_snapshot": {"workflow": {"id": "wf-1"}},
        "ai_conversation": [],
    })()
    step = {"action_type": "click", "intent": "click button",
            "selector_chain": [{"type": "css", "value": "#x"}]}
    ctx = type("Ctx", (), {
        "url": "https://example.com", "title": "T",
        "visible_text": "", "visible_elements": [],
        "is_blocking": False, "page_diff": None,
    })()
    return run, step, ctx


def test_peek_jpeg_dimensions_reads_sof0():
    img = _make_jpeg_bytes(1280, 720)
    assert _peek_jpeg_dimensions(img) == (1280, 720)


def test_peek_jpeg_dimensions_returns_zero_for_invalid_input():
    assert _peek_jpeg_dimensions(b"not a jpeg") == (0, 0)
    assert _peek_jpeg_dimensions(b"") == (0, 0)


@pytest.mark.asyncio
async def test_vision_forwarded_to_provider_with_low_detail_for_baseline(monkeypatch):
    """A baseline (non-failure) screenshot is sent with detail='low' and the
    resulting ai_decision carries a populated screenshot_meta."""
    from core.config import settings

    captured_images: list[Any] = []
    captured_has_screenshot: list[bool] = []

    # The tool the model "called" — selectors match recorded, so EXECUTE.
    tc = ToolCall(
        id="call-1",
        name="execute_action",
        arguments={
            "action": "click",
            "selector_chain": [{"type": "css", "value": "#x"}],
            "intent": "click",
            "confidence": 0.9,
            "reasoning": "ok",
        },
    )
    svc = _make_svc_with_tool_use_stub(
        [tc], captured_images, captured_has_screenshot, monkeypatch,
    )
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "vision_enabled", True, raising=False)

    img_bytes = _make_jpeg_bytes(1280, 720)
    b64 = base64.b64encode(img_bytes).decode()
    run, step, ctx = _make_run_and_ctx()

    result = await svc._consult_ai_for_step(
        run=run, step_index=0, step=step, _original_command=None,
        analysis={}, ctx=ctx,
        screenshot_b64=b64, screenshot_mime="image/jpeg",
        screenshot_trigger="first_poll",
    )

    assert result is not None
    assert captured_has_screenshot == [True]
    assert len(captured_images) == 1
    assert captured_images[0] is not None
    assert captured_images[0][0]["mime"] == "image/jpeg"
    assert captured_images[0][0]["detail"] == "low"

    meta = result.get("screenshot_meta")
    assert meta is not None
    assert meta["width"] == 1280
    assert meta["height"] == 720
    assert meta["byte_size"] == len(img_bytes)
    assert meta["trigger"] == "first_poll"
    assert meta["detail"] == "low"
    assert len(meta["sha256"]) == 64


@pytest.mark.asyncio
async def test_vision_detail_high_for_failure_trigger(monkeypatch):
    """Trigger=post_failure should bump detail to 'high' when configured."""
    from core.config import settings

    captured_images: list[Any] = []
    captured_has_screenshot: list[bool] = []
    tc = ToolCall(
        id="call-1",
        name="execute_action",
        arguments={
            "action": "click",
            "selector_chain": [{"type": "text", "value": "Submit"}],  # different from recorded → ADAPT
            "intent": "click",
            "confidence": 0.7,
            "reasoning": "adapted",
        },
    )
    svc = _make_svc_with_tool_use_stub(
        [tc], captured_images, captured_has_screenshot, monkeypatch,
    )
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "vision_enabled", True, raising=False)
    monkeypatch.setattr(settings, "vision_high_detail_on_failure", True, raising=False)

    b64 = base64.b64encode(_make_jpeg_bytes()).decode()
    run, step, ctx = _make_run_and_ctx()

    result = await svc._consult_ai_for_step(
        run=run, step_index=0, step=step, _original_command=None,
        analysis={}, ctx=ctx,
        screenshot_b64=b64, screenshot_mime="image/jpeg",
        screenshot_trigger="post_failure",
    )
    assert captured_images[0][0]["detail"] == "high"
    assert result["screenshot_meta"]["detail"] == "high"


@pytest.mark.asyncio
async def test_oversized_screenshot_dropped(monkeypatch):
    """If decoded bytes exceed vision_max_bytes, no images are forwarded and
    no screenshot_meta is stashed."""
    from core.config import settings

    captured_images: list[Any] = []
    captured_has_screenshot: list[bool] = []
    tc = ToolCall(
        id="call-1",
        name="execute_action",
        arguments={
            "action": "click", "selector_chain": [{"type": "css", "value": "#x"}],
            "intent": "x", "confidence": 0.9, "reasoning": "ok",
        },
    )
    svc = _make_svc_with_tool_use_stub(
        [tc], captured_images, captured_has_screenshot, monkeypatch,
    )
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "vision_enabled", True, raising=False)
    monkeypatch.setattr(settings, "vision_max_bytes", 1000, raising=False)

    b64 = base64.b64encode(_make_jpeg_bytes()).decode()  # ~50KB > 1KB cap
    run, step, ctx = _make_run_and_ctx()

    result = await svc._consult_ai_for_step(
        run=run, step_index=0, step=step, _original_command=None,
        analysis={}, ctx=ctx,
        screenshot_b64=b64, screenshot_mime="image/jpeg",
        screenshot_trigger="first_poll",
    )
    assert captured_images[0] is None
    assert captured_has_screenshot == [False]
    assert result.get("screenshot_meta") is None


@pytest.mark.asyncio
async def test_no_screenshot_no_images_no_meta(monkeypatch):
    """When the poll body has no screenshot, the provider call is unchanged
    and no screenshot_meta is stashed."""
    from core.config import settings

    captured_images: list[Any] = []
    captured_has_screenshot: list[bool] = []
    tc = ToolCall(
        id="call-1",
        name="execute_action",
        arguments={
            "action": "click", "selector_chain": [{"type": "css", "value": "#x"}],
            "intent": "x", "confidence": 0.9, "reasoning": "ok",
        },
    )
    svc = _make_svc_with_tool_use_stub(
        [tc], captured_images, captured_has_screenshot, monkeypatch,
    )
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "vision_enabled", True, raising=False)

    run, step, ctx = _make_run_and_ctx()
    result = await svc._consult_ai_for_step(
        run=run, step_index=0, step=step, _original_command=None,
        analysis={}, ctx=ctx,
    )
    assert captured_images[0] is None
    assert captured_has_screenshot == [False]
    assert result.get("screenshot_meta") is None


def test_openai_provider_builds_multipart_user_content_when_images_present():
    """Smoke-test the OpenAIProvider message construction path: with images,
    the user content block is a list of {type: 'text'|'image_url'} parts."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from ai.client import ImageBlock, OpenAIProvider

    captured: dict[str, object] = {}

    fake_completion = SimpleNamespace(
        model="gpt-4o-mini",
        choices=[SimpleNamespace(
            message=SimpleNamespace(content='{"confidence": 0.9}', tool_calls=None),
            finish_reason="stop",
        )],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5),
    )

    async def _fake_create(**kwargs):
        captured.update(kwargs)
        return fake_completion

    provider = OpenAIProvider(api_key="test", model="gpt-4o-mini")
    provider._client.chat.completions.create = AsyncMock(side_effect=_fake_create)  # type: ignore[assignment]

    import asyncio

    asyncio.run(provider.generate(
        "describe this",
        system="you are visual",
        images=[ImageBlock(b64="ZmFrZQ==", mime="image/jpeg", detail="low")],
    ))

    messages = captured["messages"]
    user_msg = messages[-1]
    assert user_msg["role"] == "user"
    content = user_msg["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "describe this"}
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert content[1]["image_url"]["detail"] == "low"


@pytest.mark.asyncio
async def test_vision_image_attached_only_on_first_tool_attempt(monkeypatch):
    from core.config import settings

    captured_images: list[Any] = []

    svc = AgentService.__new__(AgentService)
    svc.ai_outcomes = AsyncMock()
    svc.ai_outcomes.load_run_memory = AsyncMock(return_value={"decisions": [], "traces": []})
    svc.session = AsyncMock()
    svc.session.flush = AsyncMock()
    svc._load_previous_failures = AsyncMock(return_value=[])  # type: ignore[method-assign]
    svc._load_workflow_expertise = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._get_current_phase = lambda _a, _b: None  # type: ignore[method-assign]
    svc._apply_plan_updates_from_ai = AsyncMock(return_value=[])  # type: ignore[method-assign]

    calls = [
        ToolUseResponse(
            tool_calls=[ToolCall(
                id="plan-1",
                name="update_plan",
                arguments={"operations": [{"operation": "INSERT", "step_index": 0, "new_step": {"action_type": "click"}}]},
            )],
            content="",
            model="gpt-4o-mini",
            usage={"prompt_tokens": 10, "completion_tokens": 3},
            stop_reason="tool_calls",
        ),
        ToolUseResponse(
            tool_calls=[ToolCall(
                id="exec-1",
                name="execute_action",
                arguments={
                    "action": "click",
                    "selector_chain": [{"type": "css", "value": "#x"}],
                    "intent": "click",
                    "confidence": 0.9,
                    "reasoning": "ok",
                },
            )],
            content="",
            model="gpt-4o-mini",
            usage={"prompt_tokens": 10, "completion_tokens": 3},
            stop_reason="tool_calls",
        ),
    ]

    async def _generate_with_tools(messages, tools, system=None, max_tokens=2048, images=None):
        captured_images.append(images)
        return calls[len(captured_images) - 1]

    fake_provider = AsyncMock()
    fake_provider.generate_with_tools = _generate_with_tools
    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_: fake_provider)
    monkeypatch.setattr("services.agent_service.build_agent_decision_prompt", lambda **_: "prompt")
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "vision_enabled", True, raising=False)

    b64 = base64.b64encode(_make_jpeg_bytes()).decode()
    run, step, ctx = _make_run_and_ctx()

    out = await svc._consult_ai_for_step(
        run=run,
        step_index=0,
        step=step,
        _original_command=None,
        analysis={},
        ctx=ctx,
        screenshot_b64=b64,
        screenshot_mime="image/jpeg",
        screenshot_trigger="first_poll",
    )

    assert out is not None
    assert out["decision"] == "EXECUTE"
    assert len(captured_images) == 2
    assert captured_images[0] is not None
    assert captured_images[1] is None


@pytest.mark.asyncio
async def test_tool_loop_exhaustion_returns_bounded_wait(monkeypatch):
    from core.config import settings

    svc = AgentService.__new__(AgentService)
    svc.ai_outcomes = AsyncMock()
    svc.ai_outcomes.load_run_memory = AsyncMock(return_value={"decisions": [], "traces": []})
    svc.session = AsyncMock()
    svc.session.flush = AsyncMock()
    svc._load_previous_failures = AsyncMock(return_value=[])  # type: ignore[method-assign]
    svc._load_workflow_expertise = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._get_current_phase = lambda _a, _b: None  # type: ignore[method-assign]
    svc._apply_plan_updates_from_ai = AsyncMock(return_value=[])  # type: ignore[method-assign]

    fake_provider = AsyncMock()
    fake_provider.generate_with_tools = AsyncMock(return_value=ToolUseResponse(
        tool_calls=[],
        content="",
        model="gpt-4o-mini",
        usage={"prompt_tokens": 10, "completion_tokens": 3},
        stop_reason="stop",
    ))
    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_: fake_provider)
    monkeypatch.setattr("services.agent_service.build_agent_decision_prompt", lambda **_: "prompt")
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)

    run, step, ctx = _make_run_and_ctx()
    out = await svc._consult_ai_for_step(
        run=run,
        step_index=0,
        step=step,
        _original_command=None,
        analysis={},
        ctx=ctx,
    )

    assert out is not None
    assert out["decision"] == "WAIT"
    assert out["decision_context"]["reason_code"] == "tool_loop_invalid_or_unmappable"
