from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import httpx

from core.config import settings


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
    ) -> AIResponse:
        messages: list[dict] = []
        if system:
            messages.append({"role": "system", "content": system})
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
        return AIResponse(
            content=choice["message"]["content"],
            model=data["model"],
            usage={
                "prompt_tokens": data["usage"]["prompt_tokens"],
                "completion_tokens": data["usage"]["completion_tokens"],
            },
            confidence=0.0,
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
    ) -> AIResponse:
        last_error: Exception | None = None
        for p in self.providers:
            try:
                return await p.generate(prompt, system, max_tokens)
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
    if settings.ai_provider == "openai":
        if effective_key:
            return OpenAIProvider(api_key=effective_key, model=settings.ai_model)
        # Fallback: when no API key is available, use MockProvider.
        # FallbackProvider can be extended to support additional providers
        # (e.g., Anthropic, Google, local models) in priority order.
    return MockProvider()
