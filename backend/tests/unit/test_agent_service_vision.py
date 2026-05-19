"""Workstream B (vision) tests: verify in-flight screenshot handling.

Properties under test:
1. When a valid screenshot_b64 is on the PollRequest, _consult_ai_for_step
   forwards an `images=[...]` kwarg to the provider, with `detail` chosen by
   trigger.
2. Bytes are NOT persisted as Artifact rows; only a small `screenshot_meta`
   dict (sha256, dims, mime, byte_size, trigger, detail) is stashed on the
   ai_decision result for the audit pipeline.
3. has_screenshot=True is passed into the prompt builder when an image was
   actually attached.
4. Oversized payloads are dropped (no images, no meta).
"""
from __future__ import annotations

import base64
import io
import struct
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from ai.client import AIResponse
from services.agent_service import AgentService, _peek_jpeg_dimensions


def _make_jpeg_bytes(width: int = 1024, height: int = 768) -> bytes:
    """Forge a minimal JPEG header that exposes the requested SOF0 dimensions.

    Not a decodable JPEG — the test only verifies metadata extraction, which
    walks markers to the start-of-frame and reads height/width. The remainder
    is padded so the byte_size is realistic.
    """
    soi = b"\xff\xd8"
    # APP0 (JFIF) marker — length=16, "JFIF\0", version 1.1, units 0, x/y density 1, no thumbnail
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    # SOF0: length=17, precision=8, height, width, components=3, then 3*3 component bytes
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
    # Pad to a realistic on-the-wire size (~50KB).
    padding = b"\x00" * (50_000 - len(soi) - len(app0) - len(sof0) - len(eoi))
    return soi + app0 + sof0 + padding + eoi


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

    # Build an AgentService bound to no DB — we only call _consult_ai_for_step
    # in isolation, so we can stub out everything it touches.
    svc = AgentService.__new__(AgentService)
    svc.ai_outcomes = AsyncMock()
    svc.ai_outcomes.load_run_memory = AsyncMock(return_value={"decisions": [], "traces": []})

    # Stub the prompt-builder dependencies
    svc._load_previous_failures = AsyncMock(return_value=[])  # type: ignore[method-assign]
    svc._load_workflow_expertise = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._get_current_phase = lambda _a, _b: None  # type: ignore[method-assign]
    svc._extract_thinking_steps = lambda _r: []  # type: ignore[method-assign]
    svc._normalize_ai_decision = lambda r: r  # type: ignore[method-assign]

    captured_images: list[Any] = []
    captured_has_screenshot: list[bool] = []

    fake_provider = AsyncMock()

    async def _generate(prompt, system=None, max_tokens=1024, images=None):
        captured_images.append(images)
        return AIResponse(
            content='{"decision": "EXECUTE", "confidence": 0.9, "reasoning": "ok"}',
            model="gpt-4o-mini",
            usage={"prompt_tokens": 100, "completion_tokens": 20},
            confidence=0.9,
        )

    fake_provider.generate = _generate

    def _capture_has_screenshot(**kwargs):
        captured_has_screenshot.append(kwargs.get("has_screenshot", False))
        return "test prompt"

    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_: fake_provider)
    monkeypatch.setattr("services.agent_service.build_agent_decision_prompt", _capture_has_screenshot)
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "vision_enabled", True, raising=False)

    img_bytes = _make_jpeg_bytes(1280, 720)
    b64 = base64.b64encode(img_bytes).decode()

    run = type("Run", (), {
        "id": "run-1", "goal_progress": None,
        "workflow_snapshot": {"workflow": {"id": "wf-1"}},
    })()
    step = {"action_type": "click", "intent": "click button",
            "selector_chain": [{"type": "css", "value": "#x"}]}
    ctx = type("Ctx", (), {
        "url": "https://example.com", "title": "T",
        "visible_text": "", "visible_elements": [],
        "is_blocking": False, "page_diff": None,
    })()

    result = await svc._consult_ai_for_step(
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

    assert result is not None
    assert captured_has_screenshot == [True]
    assert len(captured_images) == 1
    assert captured_images[0] is not None
    assert captured_images[0][0]["mime"] == "image/jpeg"
    assert captured_images[0][0]["detail"] == "low"  # baseline triggers stay low

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

    svc = AgentService.__new__(AgentService)
    svc.ai_outcomes = AsyncMock()
    svc.ai_outcomes.load_run_memory = AsyncMock(return_value={"decisions": [], "traces": []})
    svc._load_previous_failures = AsyncMock(return_value=[])  # type: ignore[method-assign]
    svc._load_workflow_expertise = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._get_current_phase = lambda _a, _b: None  # type: ignore[method-assign]
    svc._extract_thinking_steps = lambda _r: []  # type: ignore[method-assign]
    svc._normalize_ai_decision = lambda r: r  # type: ignore[method-assign]

    captured_images: list[Any] = []

    fake_provider = AsyncMock()

    async def _generate(prompt, system=None, max_tokens=1024, images=None):
        captured_images.append(images)
        return AIResponse(
            content='{"decision": "ADAPT", "confidence": 0.7, "reasoning": "ok", "command": {"action": "click"}}',
            model="gpt-4o-mini",
            usage={"prompt_tokens": 100, "completion_tokens": 20},
            confidence=0.7,
        )

    fake_provider.generate = _generate
    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_: fake_provider)
    monkeypatch.setattr("services.agent_service.build_agent_decision_prompt", lambda **_: "test prompt")
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "vision_enabled", True, raising=False)
    monkeypatch.setattr(settings, "vision_high_detail_on_failure", True, raising=False)

    b64 = base64.b64encode(_make_jpeg_bytes()).decode()
    run = type("Run", (), {"id": "run-1", "goal_progress": None,
                            "workflow_snapshot": {"workflow": {"id": "wf-1"}}})()
    step = {"action_type": "click", "intent": "x",
            "selector_chain": [{"type": "css", "value": "#x"}]}
    ctx = type("Ctx", (), {"url": "u", "title": "t", "visible_text": "",
                            "visible_elements": [], "is_blocking": False,
                            "page_diff": None})()

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

    svc = AgentService.__new__(AgentService)
    svc.ai_outcomes = AsyncMock()
    svc.ai_outcomes.load_run_memory = AsyncMock(return_value={"decisions": [], "traces": []})
    svc._load_previous_failures = AsyncMock(return_value=[])  # type: ignore[method-assign]
    svc._load_workflow_expertise = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._get_current_phase = lambda _a, _b: None  # type: ignore[method-assign]
    svc._extract_thinking_steps = lambda _r: []  # type: ignore[method-assign]
    svc._normalize_ai_decision = lambda r: r  # type: ignore[method-assign]

    captured_images: list[Any] = []
    captured_has_screenshot: list[bool] = []

    fake_provider = AsyncMock()

    async def _generate(prompt, system=None, max_tokens=1024, images=None):
        captured_images.append(images)
        return AIResponse(content='{"decision": "EXECUTE", "confidence": 0.9, "reasoning": "ok"}')

    fake_provider.generate = _generate
    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_: fake_provider)
    monkeypatch.setattr(
        "services.agent_service.build_agent_decision_prompt",
        lambda **kwargs: (captured_has_screenshot.append(kwargs.get("has_screenshot", False)) or "x"),
    )
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "vision_enabled", True, raising=False)
    monkeypatch.setattr(settings, "vision_max_bytes", 1000, raising=False)  # tiny cap

    b64 = base64.b64encode(_make_jpeg_bytes()).decode()  # ~50KB > 1KB cap
    run = type("Run", (), {"id": "run-1", "goal_progress": None,
                            "workflow_snapshot": {"workflow": {"id": "wf-1"}}})()
    step = {"action_type": "click", "intent": "x",
            "selector_chain": [{"type": "css", "value": "#x"}]}
    ctx = type("Ctx", (), {"url": "u", "title": "t", "visible_text": "",
                            "visible_elements": [], "is_blocking": False,
                            "page_diff": None})()

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

    svc = AgentService.__new__(AgentService)
    svc.ai_outcomes = AsyncMock()
    svc.ai_outcomes.load_run_memory = AsyncMock(return_value={"decisions": [], "traces": []})
    svc._load_previous_failures = AsyncMock(return_value=[])  # type: ignore[method-assign]
    svc._load_workflow_expertise = AsyncMock(return_value=None)  # type: ignore[method-assign]
    svc._get_current_phase = lambda _a, _b: None  # type: ignore[method-assign]
    svc._extract_thinking_steps = lambda _r: []  # type: ignore[method-assign]
    svc._normalize_ai_decision = lambda r: r  # type: ignore[method-assign]

    captured_images: list[Any] = []
    captured_has_screenshot: list[bool] = []

    fake_provider = AsyncMock()

    async def _generate(prompt, system=None, max_tokens=1024, images=None):
        captured_images.append(images)
        return AIResponse(content='{"decision": "EXECUTE", "confidence": 0.9, "reasoning": "ok"}')

    fake_provider.generate = _generate
    monkeypatch.setattr("services.agent_service.get_ai_provider", lambda **_: fake_provider)
    monkeypatch.setattr(
        "services.agent_service.build_agent_decision_prompt",
        lambda **kwargs: (captured_has_screenshot.append(kwargs.get("has_screenshot", False)) or "x"),
    )
    monkeypatch.setattr(settings, "ai_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "vision_enabled", True, raising=False)

    run = type("Run", (), {"id": "run-1", "goal_progress": None,
                            "workflow_snapshot": {"workflow": {"id": "wf-1"}}})()
    step = {"action_type": "click", "intent": "x",
            "selector_chain": [{"type": "css", "value": "#x"}]}
    ctx = type("Ctx", (), {"url": "u", "title": "t", "visible_text": "",
                            "visible_elements": [], "is_blocking": False,
                            "page_diff": None})()

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
    from ai.client import OpenAIProvider, ImageBlock

    # We don't call real OpenAI — just exercise the conversion logic by
    # intercepting the httpx client's POST.
    posted_json: list[dict] = []

    class _FakeResp:
        def raise_for_status(self): pass
        def json(self):
            return {
                "model": "gpt-4o-mini",
                "choices": [{"message": {"content": '{"confidence": 0.9}'}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            }

    class _FakeClient:
        async def post(self, url, headers=None, json=None):  # noqa: A002 — mirror httpx signature
            posted_json.append(json)
            return _FakeResp()

    provider = OpenAIProvider(api_key="test", model="gpt-4o-mini")
    provider._client = _FakeClient()  # type: ignore[assignment]

    import asyncio

    asyncio.run(provider.generate(
        "describe this",
        system="you are visual",
        images=[ImageBlock(b64="ZmFrZQ==", mime="image/jpeg", detail="low")],
    ))

    body = posted_json[0]
    user_msg = body["messages"][-1]
    assert user_msg["role"] == "user"
    content = user_msg["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "describe this"}
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert content[1]["image_url"]["detail"] == "low"
