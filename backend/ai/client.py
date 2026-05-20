from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from openai import AsyncOpenAI
from openai._exceptions import APIError, APIStatusError, APITimeoutError, RateLimitError

from core.config import settings


class ImageBlock(TypedDict, total=False):
    """A single image attached to a generate() call. Bytes are passed inline
    as base64; the provider translates to its native content-block shape and
    is responsible for discarding the bytes after the call returns."""
    b64: str
    mime: str  # "image/jpeg" | "image/png" | "image/webp"
    detail: Literal["low", "high"]  # OpenAI vision tile mode; ignored by Mock


@dataclass
class AIResponse:
    content: str
    model: str = ""
    usage: dict = field(default_factory=dict)
    confidence: float = 0.0


@dataclass
class ToolCall:
    """A single tool invocation emitted by the model."""
    id: str
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolUseResponse:
    """Structured output of generate_with_tools(): the model may emit zero or
    more tool_calls plus optional assistant text. stop_reason indicates why
    the model stopped ("tool_calls", "stop", "length", ...)."""
    tool_calls: list[ToolCall] = field(default_factory=list)
    content: str = ""  # assistant text alongside tool calls (may be empty)
    model: str = ""
    usage: dict = field(default_factory=dict)
    stop_reason: str = ""


def _build_user_content(prompt: str, images: list[ImageBlock] | None) -> Any:
    """Build the OpenAI Chat Completions user content. Plain string when no
    images; multi-part array of text+image_url blocks when images attached."""
    if not images:
        return prompt
    parts: list[dict] = [{"type": "text", "text": prompt}]
    for img in images:
        b64 = img.get("b64") or ""
        mime = img.get("mime") or "image/jpeg"
        detail = img.get("detail") or "low"
        if not b64:
            continue
        parts.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{mime};base64,{b64}",
                "detail": detail,
            },
        })
    return parts


class AIProvider(ABC):
    @abstractmethod
    async def generate(
        self,
        prompt: str,
        system: str | None = None,
        max_tokens: int = 1024,
        images: list[ImageBlock] | None = None,
    ) -> AIResponse:
        ...

    @abstractmethod
    async def embed(self, text: str) -> list[float]:
        ...

    async def generate_with_tools(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        system: str | None = None,
        max_tokens: int = 2048,
        images: list[ImageBlock] | None = None,  # noqa: ARG002 — overridden by concrete impls
    ) -> ToolUseResponse:
        """Tool-use shape: model is given a list of function tools and may
        emit zero or more tool_calls. Concrete providers override; the
        default raises so subclasses must implement explicitly."""
        raise NotImplementedError(f"{type(self).__name__} does not implement generate_with_tools")


class MockProvider(AIProvider):
    async def generate(
        self,
        prompt: str,
        system: str | None = None,
        max_tokens: int = 1024,
        images: list[ImageBlock] | None = None,
    ) -> AIResponse:
        return AIResponse(
            content='{"result": "mock_success", "confidence": 0.85}',
            model="mock",
            usage={"prompt_tokens": 0, "completion_tokens": 0},
            confidence=0.85,
        )

    async def embed(self, text: str) -> list[float]:
        return [0.0] * 384

    async def generate_with_tools(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        system: str | None = None,
        max_tokens: int = 2048,
        images: list[ImageBlock] | None = None,
    ) -> ToolUseResponse:
        # Canned execute_action call so tests can exercise the loop end-to-end
        # without external dependencies. Args are intentionally minimal.
        return ToolUseResponse(
            tool_calls=[ToolCall(
                id="mock-tool-call-1",
                name="execute_action",
                arguments={
                    "action": "click",
                    "selector_chain": [],
                    "intent": "mock",
                    "reasoning": "MockProvider canned response",
                    "confidence": 0.85,
                },
            )],
            content="",
            model="mock",
            usage={"prompt_tokens": 0, "completion_tokens": 0},
            stop_reason="tool_calls",
        )


class OpenAIProvider(AIProvider):
    def __init__(self, api_key: str, model: str = "gpt-4o-mini"):
        self.api_key = api_key
        self.model = model
        self.confidence_threshold = settings.ai_confidence_threshold
        # The official SDK manages connection pooling, retries, and timeouts.
        # We retain a single client per provider instance and let asyncio + the
        # SDK handle lifecycle.
        self._client = AsyncOpenAI(api_key=api_key, timeout=30.0, max_retries=2)

    async def generate(
        self,
        prompt: str,
        system: str | None = None,
        max_tokens: int = 1024,
        images: list[ImageBlock] | None = None,
    ) -> AIResponse:
        messages: list[dict] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": _build_user_content(prompt, images)})

        resp = await self._client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_tokens=max_tokens,
        )

        choice = resp.choices[0]
        content = choice.message.content or ""
        confidence = 0.0
        try:
            parsed = json.loads(content)
            confidence = float(parsed.get("confidence", 0.0))
        except (json.JSONDecodeError, ValueError, TypeError):
            pass
        usage = {
            "prompt_tokens": resp.usage.prompt_tokens if resp.usage else 0,
            "completion_tokens": resp.usage.completion_tokens if resp.usage else 0,
        }
        return AIResponse(
            content=content,
            model=resp.model,
            usage=usage,
            confidence=confidence,
        )

    async def embed(self, text: str) -> list[float]:
        resp = await self._client.embeddings.create(
            model="text-embedding-3-small",
            input=text,
        )
        return list(resp.data[0].embedding)

    async def generate_with_tools(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        system: str | None = None,
        max_tokens: int = 2048,
        images: list[ImageBlock] | None = None,
    ) -> ToolUseResponse:
        # `messages` is the rolling conversation. If a system message is
        # supplied, prepend it. If `images` is non-empty, attach to the most
        # recent user message — caller's responsibility to ensure that's the
        # current poll's user turn (the loop in agent_service guarantees this).
        out_messages: list[dict[str, Any]] = []
        if system:
            out_messages.append({"role": "system", "content": system})
        if images and messages and messages[-1].get("role") == "user":
            # Rebuild the last user message as multi-part to include images.
            base = messages[-1]
            text = base.get("content", "") if isinstance(base.get("content"), str) else ""
            out_messages.extend(messages[:-1])
            out_messages.append({"role": "user", "content": _build_user_content(text or "", images)})
        else:
            out_messages.extend(messages)

        try:
            resp = await self._client.chat.completions.create(
                model=self.model,
                messages=out_messages,
                tools=tools,
                tool_choice="auto",
                max_tokens=max_tokens,
            )
        except (APIError, APIStatusError, APITimeoutError, RateLimitError):
            raise

        choice = resp.choices[0]
        msg = choice.message
        tool_calls: list[ToolCall] = []
        for tc in (msg.tool_calls or []):
            try:
                args = json.loads(tc.function.arguments) if tc.function.arguments else {}
            except json.JSONDecodeError:
                args = {}
            tool_calls.append(ToolCall(
                id=tc.id,
                name=tc.function.name,
                arguments=args if isinstance(args, dict) else {},
            ))
        usage = {
            "prompt_tokens": resp.usage.prompt_tokens if resp.usage else 0,
            "completion_tokens": resp.usage.completion_tokens if resp.usage else 0,
        }
        return ToolUseResponse(
            tool_calls=tool_calls,
            content=msg.content or "",
            model=resp.model,
            usage=usage,
            stop_reason=choice.finish_reason or "",
        )


class FallbackProvider(AIProvider):
    def __init__(self, providers: list[AIProvider]):
        self.providers = providers

    async def generate(
        self,
        prompt: str,
        system: str | None = None,
        max_tokens: int = 1024,
        images: list[ImageBlock] | None = None,
    ) -> AIResponse:
        last_error: Exception | None = None
        for p in self.providers:
            try:
                return await p.generate(prompt, system, max_tokens, images=images)
            except Exception as e:
                last_error = e
        raise last_error  # type: ignore[UnionAttr]

    async def embed(self, text: str) -> list[float]:
        last_error: Exception | None = None
        for p in self.providers:
            try:
                return await p.embed(text)
            except Exception as e:
                last_error = e
        raise last_error  # type: ignore[UnionAttr]

    async def generate_with_tools(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        system: str | None = None,
        max_tokens: int = 2048,
        images: list[ImageBlock] | None = None,
    ) -> ToolUseResponse:
        last_error: Exception | None = None
        for p in self.providers:
            try:
                return await p.generate_with_tools(messages, tools, system, max_tokens, images=images)
            except Exception as e:
                last_error = e
        raise last_error  # type: ignore[UnionAttr]


def get_ai_provider(api_key_override: str | None = None) -> AIProvider:
    effective_key = api_key_override or settings.ai_api_key
    if settings.ai_provider == "openai" and effective_key:
        return OpenAIProvider(api_key=effective_key, model=settings.ai_model)
        # Fallback: when no API key is available, use MockProvider.
        # FallbackProvider can be extended to support additional providers
        # (e.g., Anthropic, Google, local models) in priority order.
    return MockProvider()
