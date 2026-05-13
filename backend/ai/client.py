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
            content="Mock response",
            model="mock",
            usage={"prompt_tokens": 0, "completion_tokens": 0},
            confidence=0.0,
        )

    async def embed(self, text: str) -> list[float]:
        return [0.0] * 384


class OpenAIProvider(AIProvider):
    def __init__(self, api_key: str, model: str = "gpt-4o-mini"):
        self.api_key = api_key
        self.model = model
        self.confidence_threshold = settings.ai_confidence_threshold
        self._client = httpx.AsyncClient(timeout=60)

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


def get_ai_provider(api_key_override: str | None = None) -> AIProvider:
    effective_key = api_key_override or settings.ai_api_key
    if settings.ai_provider == "openai" and effective_key:
        return OpenAIProvider(
            api_key=effective_key, model=settings.ai_model
        )
    return MockProvider()
