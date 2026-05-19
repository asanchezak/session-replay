from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Literal, TypedDict

import httpx

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


class OpenAIProvider(AIProvider):
    def __init__(self, api_key: str, model: str = "gpt-4o-mini"):
        self.api_key = api_key
        self.model = model
        self.confidence_threshold = settings.ai_confidence_threshold
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5, read=20, write=5, pool=5)
        )

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
        # When images are attached, the user content becomes a multi-part array
        # of {type:"text"|"image_url"} blocks per the OpenAI Chat Completions
        # vision schema. Without images we keep the simpler string form.
        if images:
            user_content: list[dict] = [{"type": "text", "text": prompt}]
            for img in images:
                b64 = img.get("b64") or ""
                mime = img.get("mime") or "image/jpeg"
                detail = img.get("detail") or "low"
                if not b64:
                    continue
                user_content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{mime};base64,{b64}",
                        "detail": detail,
                    },
                })
            messages.append({"role": "user", "content": user_content})
        else:
            messages.append({"role": "user", "content": prompt})

        resp = await self._client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": self.model,
                "messages": messages,
                "max_tokens": max_tokens,
            },
        )
        resp.raise_for_status()
        data = resp.json()

        choice = data["choices"][0]
        content = choice["message"]["content"]
        confidence = 0.0
        try:
            parsed = json.loads(content)
            confidence = float(parsed.get("confidence", 0.0))
        except (json.JSONDecodeError, ValueError, TypeError):
            pass
        return AIResponse(
            content=content,
            model=data["model"],
            usage={
                "prompt_tokens": data["usage"]["prompt_tokens"],
                "completion_tokens": data["usage"]["completion_tokens"],
            },
            confidence=confidence,
        )

    async def embed(self, text: str) -> list[float]:
        resp = await self._client.post(
            "https://api.openai.com/v1/embeddings",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={"model": "text-embedding-3-small", "input": text},
        )
        resp.raise_for_status()
        data = resp.json()
        return data["data"][0]["embedding"]


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


def get_ai_provider(api_key_override: str | None = None) -> AIProvider:
    effective_key = api_key_override or settings.ai_api_key
    if settings.ai_provider == "openai" and effective_key:
        return OpenAIProvider(api_key=effective_key, model=settings.ai_model)
        # Fallback: when no API key is available, use MockProvider.
        # FallbackProvider can be extended to support additional providers
        # (e.g., Anthropic, Google, local models) in priority order.
    return MockProvider()
