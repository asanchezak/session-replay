from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from tests.doubles import (
    FakeAISelectorProvider,
    FakeAIUnparseableProvider,
    FakeCronScheduler,
    FakeStepResults,
)


class TestFakeAISelectorProvider:
    @pytest.mark.asyncio
    async def test_returns_configured_selector(self):
        provider = FakeAISelectorProvider(
            selector="#my-element",
            confidence=0.85,
            explanation="Found it",
            fallback_selectors=["#fallback"],
        )
        response = await provider.generate("Find the element")
        assert response.content
        assert "#my-element" in response.content
        assert '"confidence": 0.85' in response.content
        assert response.model == "fake"

    @pytest.mark.asyncio
    async def test_tracks_call_count_and_prompt(self):
        provider = FakeAISelectorProvider()
        await provider.generate("first prompt")
        await provider.generate("second prompt")
        assert provider.call_count == 2
        assert provider.last_prompt == "second prompt"
        assert provider.last_system is None

    @pytest.mark.asyncio
    async def test_tracks_system_message(self):
        provider = FakeAISelectorProvider()
        await provider.generate("prompt", system="You are a DOM assistant")
        assert provider.last_system == "You are a DOM assistant"

    @pytest.mark.asyncio
    async def test_default_configuration(self):
        provider = FakeAISelectorProvider()
        response = await provider.generate("prompt")
        assert "#ai-suggested" in response.content
        assert '"confidence": 0.95' in response.content
        assert response.confidence == 0.95

    @pytest.mark.asyncio
    async def test_embed_returns_zero_vector(self):
        provider = FakeAISelectorProvider()
        embedding = await provider.embed("any text")
        assert len(embedding) == 384
        assert all(v == 0.0 for v in embedding)

    @pytest.mark.asyncio
    async def test_unparseable_provider_returns_non_json(self):
        provider = FakeAIUnparseableProvider()
        response = await provider.generate("prompt")
        assert response.content == "this is not json"


class TestFakeCronScheduler:
    def test_add_schedule_creates_entry(self):
        scheduler = FakeCronScheduler()
        sched = scheduler.add_schedule(
            workflow_id="wf-1",
            cron_expression="0 * * * *",
            timezone="UTC",
            enabled=True,
        )
        assert sched["workflow_id"] == "wf-1"
        assert sched["cron_expression"] == "0 * * * *"
        assert sched["enabled"] is True

    def test_disabled_schedule_not_due(self):
        scheduler = FakeCronScheduler()
        scheduler.set_now(datetime(2025, 1, 1, 0, 0, tzinfo=UTC))
        sched = scheduler.add_schedule(
            workflow_id="wf-1",
            cron_expression="* * * * *",
            enabled=False,
        )
        assert scheduler.is_due(sched) is False

    def test_schedule_due_at_exact_minute(self):
        scheduler = FakeCronScheduler()
        base = datetime(2025, 1, 1, 12, 0, tzinfo=UTC)
        scheduler.set_now(base)
        sched = scheduler.add_schedule(
            workflow_id="wf-1", cron_expression="0 12 * * *"
        )
        assert scheduler.is_due(sched) is True

    def test_schedule_not_due_before_minute(self):
        scheduler = FakeCronScheduler()
        base = datetime(2025, 1, 1, 11, 59, tzinfo=UTC)
        scheduler.set_now(base)
        sched = scheduler.add_schedule(
            workflow_id="wf-1", cron_expression="0 12 * * *"
        )
        assert scheduler.is_due(sched) is False

    def test_get_due_schedules_filters(self):
        scheduler = FakeCronScheduler()
        scheduler.set_now(datetime(2025, 1, 1, 12, 0, tzinfo=UTC))
        scheduler.add_schedule(workflow_id="due-1", cron_expression="0 12 * * *")
        scheduler.add_schedule(workflow_id="not-due", cron_expression="0 13 * * *")
        due = scheduler.get_due_schedules()
        assert len(due) == 1
        assert due[0]["workflow_id"] == "due-1"

    def test_mark_run_updates_last_and_next(self):
        scheduler = FakeCronScheduler()
        base = datetime(2025, 1, 1, 12, 0, tzinfo=UTC)
        scheduler.set_now(base)
        sched = scheduler.add_schedule(
            workflow_id="wf-1", cron_expression="0 * * * *"
        )
        scheduler.mark_run(sched)
        assert sched["last_run_at"] == base
        assert sched["next_run_at"] is not None
        assert sched["next_run_at"] > base

    def test_advance_moves_time_forward(self):
        scheduler = FakeCronScheduler()
        base = datetime(2025, 1, 1, 12, 0, tzinfo=UTC)
        scheduler.set_now(base)
        scheduler.advance(3600)
        assert scheduler._now == base + timedelta(hours=1)

    def test_clear_resets_all_state(self):
        scheduler = FakeCronScheduler()
        scheduler.set_now(datetime(2025, 1, 1, 12, 0, tzinfo=UTC))
        scheduler.add_schedule(workflow_id="wf-1", cron_expression="* * * * *")
        scheduler.clear()
        assert len(scheduler._schedules) == 0
        assert scheduler._now is None


class TestFakeStepResults:
    def test_set_and_get(self):
        fr = FakeStepResults()
        fr.set(0, {"value": "hello", "pageTitle": "Test"})
        assert fr.get(0)["value"] == "hello"
        assert fr.get(0)["pageTitle"] == "Test"

    def test_get_missing_returns_empty(self):
        fr = FakeStepResults()
        assert fr.get(99) == {}

    def test_resolve_simple_variable(self):
        fr = FakeStepResults()
        fr.set(0, {"value": "hello"})
        result = fr.resolve("{{0.value}}")
        assert result == "hello"

    def test_resolve_multiple_variables(self):
        fr = FakeStepResults()
        fr.set(0, {"name": "Alice"})
        fr.set(1, {"age": "30"})
        result = fr.resolve("{{0.name}} is {{1.age}}")
        assert result == "Alice is 30"

    def test_resolve_missing_variable_returns_empty(self):
        fr = FakeStepResults()
        result = fr.resolve("{{99.value}}")
        assert result == ""

    def test_resolve_no_variables_unchanged(self):
        fr = FakeStepResults()
        result = fr.resolve("hello world")
        assert result == "hello world"

    def test_resolve_nested_variable_ignored(self):
        fr = FakeStepResults()
        fr.set(0, {"data": "hello {{1.name}}"})
        fr.set(1, {"name": "Bob"})
        # Only one level of resolution
        result = fr.resolve("{{0.data}}")
        assert result == "hello {{1.name}}"
