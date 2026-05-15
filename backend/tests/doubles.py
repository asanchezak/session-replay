from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from ai.client import AIProvider, AIResponse


class FakeAISelectorProvider(AIProvider):
    """Predictable AI provider for selector healing tests.

    Returns configured responses so tests can verify healing behavior
    without calling a real AI API.
    """

    def __init__(
        self,
        selector: str = "#ai-suggested",
        confidence: float = 0.95,
        explanation: str = "Mock AI explanation",
        fallback_selectors: list[str] | None = None,
    ):
        self._selector = selector
        self._confidence = confidence
        self._explanation = explanation
        self._fallback_selectors = fallback_selectors or []
        self.call_count = 0
        self.last_prompt: str | None = None
        self.last_system: str | None = None

    async def generate(
        self,
        prompt: str,
        system: str | None = None,
        max_tokens: int = 1024,
    ) -> AIResponse:
        self.call_count += 1
        self.last_prompt = prompt
        self.last_system = system
        fallbacks = ",".join(
            f'"{s}"' for s in self._fallback_selectors
        )
        content = (
            '{'
            f'"selector": "{self._selector}", '
            f'"confidence": {self._confidence}, '
            f'"explanation": "{self._explanation}", '
            f'"fallback_selectors": [{fallbacks}]'
            '}'
        )
        return AIResponse(
            content=content,
            model="fake",
            confidence=self._confidence,
        )

    async def embed(self, text: str) -> list[float]:
        return [0.0] * 384


class FakeAIUnparseableProvider(AIProvider):
    """Returns malformed JSON to test AI error handling."""

    async def generate(
        self,
        prompt: str,
        system: str | None = None,
        max_tokens: int = 1024,
    ) -> AIResponse:
        return AIResponse(
            content="this is not json",
            model="fake",
            confidence=0.0,
        )

    async def embed(self, text: str) -> list[float]:
        return [0.0] * 384


class FakeCronScheduler:
    """Manual scheduler for testing schedule logic without real cron.

    Allows tests to advance time and check which schedules are due.
    """

    def __init__(self):
        self._schedules: list[dict[str, Any]] = []
        self._now: datetime | None = None

    def set_now(self, dt: datetime | None = None) -> None:
        self._now = dt or datetime.now(UTC)

    def advance(self, seconds: int) -> None:
        if self._now:
            self._now += timedelta(seconds=seconds)

    def add_schedule(
        self,
        workflow_id: str,
        cron_expression: str,
        timezone: str = "UTC",
        enabled: bool = True,
    ) -> dict[str, Any]:
        sched = {
            "workflow_id": workflow_id,
            "cron_expression": cron_expression,
            "timezone": timezone,
            "enabled": enabled,
            "created_at": self._now or datetime.now(UTC),
            "last_run_at": None,
            "next_run_at": None,
        }
        self._schedules.append(sched)
        return sched

    def is_due(self, schedule: dict[str, Any]) -> bool:
        """Check if a schedule is due at the current fake time.

        Finds the most recent cron fire time before 'now'. A schedule
        is due if that fire time is after the schedule was created AND
        after the last run (or never run).
        """
        if not schedule.get("enabled"):
            return False
        if not self._now:
            return False
        from croniter import croniter

        # get_prev from now+1s to handle exact matches (off-by-one guard)
        cron = croniter(schedule["cron_expression"], self._now + timedelta(seconds=1))
        prev_time = cron.get_prev(datetime)
        created_at = schedule.get("created_at", self._now)
        # Don't fire for events that happened before the schedule was created
        if prev_time < created_at:
            return False
        last_run = schedule.get("last_run_at")
        # Fire if never run, or a new occurrence since last run
        return last_run is None or prev_time > last_run

    def get_due_schedules(self) -> list[dict[str, Any]]:
        return [s for s in self._schedules if self.is_due(s)]

    def mark_run(self, schedule: dict[str, Any]) -> None:
        schedule["last_run_at"] = self._now
        from croniter import croniter

        cron = croniter(schedule["cron_expression"], self._now)
        schedule["next_run_at"] = cron.get_next(datetime)

    def clear(self) -> None:
        self._schedules.clear()
        self._now = None


class FakeStepResults:
    """In-memory store for step results during variable interpolation tests."""

    def __init__(self) -> None:
        self._results: dict[int, dict[str, Any]] = {}

    def set(self, step_index: int, data: dict[str, Any]) -> None:
        self._results[step_index] = data

    def get(self, step_index: int) -> dict[str, Any]:
        return self._results.get(step_index, {})

    def resolve(self, template: str) -> str:
        """Resolve {{stepIndex.field}} patterns in the template string."""
        import re

        def replacer(match: re.Match) -> str:
            expr = match.group(1)
            parts = expr.split(".")
            if len(parts) != 2:
                return match.group(0)
            try:
                idx = int(parts[0])
            except ValueError:
                return match.group(0)
            field = parts[1]
            result = self._results.get(idx, {})
            return str(result.get(field, ""))
        return re.sub(r"\{\{(.+?)\}\}", replacer, template)


class FakeSemanticAnalysisProvider(AIProvider):
    """Predictable AI provider for workflow semantic analysis tests.

    Returns a canned structured analysis response so tests can verify
    the full analysis pipeline without calling a real AI API.
    """

    def __init__(
        self,
        goal: str = "Extract job listings matching configurable search criteria",
        summary: str = "Searches a job platform, filters results, and extracts structured data.",
        domain: str = "job_search",
        confidence_overall: float = 0.92,
        parameters: list[dict] | None = None,
        phases: list[dict] | None = None,
        actions: list[dict] | None = None,
        output_type: str = "structured_data",
        replay_strategy: str = "parameterized",
    ):
        self._goal = goal
        self._summary = summary
        self._domain = domain
        self._confidence = confidence_overall
        self._parameters = parameters or [
            {"key": "technologies", "type": "string", "default": "Python developer", "step_index": 1, "description": "Search query", "confidence": 0.95, "required": True},
            {"key": "location", "type": "string", "default": "Alajuela", "step_index": 2, "description": "Location filter", "confidence": 0.88, "required": True},
        ]
        self._phases = phases or [
            {"index": 0, "name": "Navigation Phase", "goal": "Reach search interface", "steps": [0]},
            {"index": 1, "name": "Search Phase", "goal": "Configure and execute search", "steps": [1, 2, 3]},
            {"index": 2, "name": "Extraction Phase", "goal": "Extract structured listings", "steps": [4, 5]},
        ]
        self._actions = actions or [
            {"step_index": 0, "semantic_type": "open_platform", "description": "Open job search platform", "confidence": 0.99},
            {"step_index": 1, "semantic_type": "set_search_query", "description": "Enter search term", "confidence": 0.95},
            {"step_index": 2, "semantic_type": "set_location", "description": "Set location filter", "confidence": 0.90},
            {"step_index": 3, "semantic_type": "submit_search", "description": "Execute search", "confidence": 0.95},
            {"step_index": 4, "semantic_type": "open_detail", "description": "Open listing details", "confidence": 0.80},
            {"step_index": 5, "semantic_type": "extract_data", "description": "Extract job details", "confidence": 0.85},
        ]
        self._output_type = output_type
        self._replay_strategy = replay_strategy
        self.call_count = 0
        self.last_prompt: str | None = None

    async def generate(
        self,
        prompt: str,
        system: str | None = None,
        max_tokens: int = 1024,
    ) -> AIResponse:
        self.call_count += 1
        self.last_prompt = prompt
        import json
        content = json.dumps({
            "workflow_goal": self._goal,
            "workflow_summary": self._summary,
            "domain_context": self._domain,
            "confidence_overall": self._confidence,
            "phases": self._phases,
            "actions": self._actions,
            "parameters": self._parameters,
            "output_spec": {"type": self._output_type, "schema": {"type": "array", "items": {"type": "object"}}, "confidence": 0.75},
            "fixed_steps": [0],
            "variable_steps": [1, 2, 3, 4, 5],
            "ambiguity_notes": [],
            "replay_strategy": self._replay_strategy,
            "healing_hints": "Use text content and aria labels to find elements",
            "generalization_notes": "Search parameters and location are configurable",
        })
        return AIResponse(content=content, model="fake-semantic", confidence=self._confidence)

    async def embed(self, text: str) -> list[float]:
        return [0.0] * 384
