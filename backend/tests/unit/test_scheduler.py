from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from tests.doubles import FakeCronScheduler


@pytest.mark.smoke
class TestSchedulerSmoke:
    def test_create_and_check_due(self):
        scheduler = FakeCronScheduler()
        scheduler.set_now(datetime(2025, 6, 1, 12, 0, tzinfo=UTC))
        sched = scheduler.add_schedule("wf-1", "0 12 * * *")
        assert scheduler.is_due(sched) is True

    def test_not_due_before_schedule(self):
        scheduler = FakeCronScheduler()
        scheduler.set_now(datetime(2025, 6, 1, 11, 59, tzinfo=UTC))
        sched = scheduler.add_schedule("wf-1", "0 12 * * *")
        assert scheduler.is_due(sched) is False

    def test_disabled_not_due(self):
        scheduler = FakeCronScheduler()
        scheduler.set_now(datetime(2025, 6, 1, 12, 0, tzinfo=UTC))
        sched = scheduler.add_schedule("wf-1", "* * * * *", enabled=False)
        assert scheduler.is_due(sched) is False


@pytest.mark.regression
class TestSchedulerRegression:
    def test_multiple_schedules_filtered(self):
        scheduler = FakeCronScheduler()
        scheduler.set_now(datetime(2025, 6, 1, 12, 0, tzinfo=UTC))
        scheduler.add_schedule("due-1", "0 12 * * *")
        scheduler.add_schedule("not-due", "0 13 * * *")
        due = scheduler.get_due_schedules()
        assert len(due) == 1
        assert due[0]["workflow_id"] == "due-1"

    def test_mark_run_updates_last_and_next(self):
        scheduler = FakeCronScheduler()
        base = datetime(2025, 6, 1, 12, 0, tzinfo=UTC)
        scheduler.set_now(base)
        sched = scheduler.add_schedule("wf-1", "0 * * * *")
        scheduler.mark_run(sched)
        assert sched["last_run_at"] == base
        assert sched["next_run_at"] is not None
        assert sched["next_run_at"] > base

    def test_advance_moves_time_forward(self):
        scheduler = FakeCronScheduler()
        base = datetime(2025, 6, 1, 12, 0, tzinfo=UTC)
        scheduler.set_now(base)
        scheduler.advance(3600)
        assert scheduler._now == base + timedelta(hours=1)

    def test_clear_resets_all(self):
        scheduler = FakeCronScheduler()
        scheduler.set_now(datetime(2025, 6, 1, 12, 0, tzinfo=UTC))
        scheduler.add_schedule("wf-1", "0 12 * * *")
        scheduler.clear()
        assert len(scheduler._schedules) == 0
        assert scheduler._now is None

    def test_next_5_schedule_times(self):
        from croniter import croniter
        base = datetime(2025, 6, 1, 0, 0, tzinfo=UTC)
        cron = croniter("0 */6 * * *", base)
        times = [cron.get_next(datetime) for _ in range(5)]
        assert len(times) == 5
        assert times[0] == datetime(2025, 6, 1, 6, 0, tzinfo=UTC)
        assert times[1] == datetime(2025, 6, 1, 12, 0, tzinfo=UTC)

    def test_dst_transition_handled(self):
        import pytz
        from croniter import croniter
        tz = pytz.timezone("America/New_York")
        # Spring forward: March 9, 2025 at 2:00 AM
        spring_forward = tz.localize(datetime(2025, 3, 9, 1, 59, 0))
        cron = croniter("0 2 * * *", spring_forward)
        next_time = cron.get_next(datetime)
        # The 2:00 AM that doesn't exist should be skipped to 3:00 AM EDT
        next_time_et = next_time.astimezone(tz)
        assert next_time_et.hour == 3
