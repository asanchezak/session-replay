"""Auto-outreach: message newly-added candidates without a human pressing the Odoo button.

This fires unattended every 30-90 min (the akcr recommendations cron) and sends REAL InMail on
a sensitive LinkedIn account, so every guard here is load-bearing. These tests pin the guards
themselves — especially the two that are easy to "simplify" into a bug:

  * only copy a HUMAN already sent for this position is ever reused (never the generic
    DEFAULT_MESSAGE_BODY, and never the automation's own previous output);
  * the active-run check MUST precede the daily-quota computation.
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from services.recruiter_pipeline_service import RecruiterPipelineService

HUMAN_SUBJECT = "Job opportunity"
HUMAN_BODY = "Hi {Nombre}, I'm María Fernanda from AKUREY…"


def _make_svc(db_session, monkeypatch, *, active_kinds=(), approved=(HUMAN_SUBJECT, HUMAN_BODY),
              sent_24h=0, enabled=True, cap=20):
    svc = RecruiterPipelineService(db_session)
    svc.send_messages = AsyncMock(return_value="auto-run-id")
    svc._has_active_pipeline_run = AsyncMock(side_effect=lambda job_id, kinds: bool(
        set(kinds or ()) & set(active_kinds)
    ))
    svc._last_human_message = AsyncMock(return_value=approved)
    svc._sent_last_24h = AsyncMock(return_value=sent_24h)
    monkeypatch.setattr(settings, "recruiter_auto_message_enabled", enabled)
    monkeypatch.setattr(settings, "recruiter_auto_message_daily_cap", cap)
    return svc


async def _run(svc):
    return await svc._auto_send_after_recommendations(
        job_id="290", connector_id="c", pipeline={"job_id": "290"},
    )


@pytest.mark.asyncio
async def test_happy_path_reuses_human_copy_and_bounds_the_batch(
    db_session: AsyncSession, monkeypatch,
):
    svc = _make_svc(db_session, monkeypatch, sent_24h=5, cap=20)
    res = await _run(svc)
    assert res["auto_message"] is True
    kwargs = svc.send_messages.await_args.kwargs
    # The recruiter's own copy, never DEFAULT_MESSAGE_BODY.
    assert kwargs["subject"] == HUMAN_SUBJECT
    assert kwargs["body"] == HUMAN_BODY
    assert kwargs["send"] is True and kwargs["auto"] is True
    # max_recipients = remaining quota, which also disables the run-chaining.
    assert kwargs["max_recipients"] == 15


@pytest.mark.asyncio
async def test_no_human_approved_copy_never_sends(db_session: AsyncSession, monkeypatch):
    """The guard that stops generic copy going out to real candidates."""
    svc = _make_svc(db_session, monkeypatch, approved=None)
    res = await _run(svc)
    assert res == {"auto_message": False, "reason": "no_human_approved_copy"}
    svc.send_messages.assert_not_awaited()


@pytest.mark.asyncio
async def test_daily_cap_reached_skips(db_session: AsyncSession, monkeypatch):
    svc = _make_svc(db_session, monkeypatch, sent_24h=20, cap=20)
    res = await _run(svc)
    assert res["auto_message"] is False and res["reason"] == "daily_cap_reached"
    svc.send_messages.assert_not_awaited()


@pytest.mark.asyncio
async def test_active_message_run_skips_before_consulting_the_quota(
    db_session: AsyncSession, monkeypatch,
):
    """ORDER MATTERS: _sent_last_24h counts only COMPLETED runs, so an in-flight send
    contributes 0. If the quota were computed first, a tick landing mid-send would hand out
    the full daily budget a second time and double the day's volume."""
    from services.recruiter_pipeline_service import EVENT_MESSAGE

    svc = _make_svc(db_session, monkeypatch, active_kinds=(EVENT_MESSAGE,))
    res = await _run(svc)
    assert res["reason"] == "message_run_active"
    svc.send_messages.assert_not_awaited()
    svc._sent_last_24h.assert_not_awaited()


@pytest.mark.asyncio
async def test_active_archive_sweep_skips(db_session: AsyncSession, monkeypatch):
    """send_messages defers (returns None) while an archive runs — calling it would be a
    silent no-op that also spams the position's chatter every tick."""
    from services.recruiter_pipeline_service import EVENT_ARCHIVE

    svc = _make_svc(db_session, monkeypatch, active_kinds=(EVENT_ARCHIVE,))
    res = await _run(svc)
    assert res["reason"] == "archive_sweep_active"
    svc.send_messages.assert_not_awaited()


@pytest.mark.asyncio
async def test_kill_switch(db_session: AsyncSession, monkeypatch):
    svc = _make_svc(db_session, monkeypatch, enabled=False)
    res = await _run(svc)
    assert res["reason"] == "disabled"
    svc.send_messages.assert_not_awaited()


@pytest.mark.asyncio
async def test_every_skip_logs_at_warning(db_session: AsyncSession, monkeypatch, caplog):
    """A silently-dead auto-sender is this design's most likely failure mode, and the PROD
    container drops INFO — so the skip reason has to survive at WARNING."""
    svc = _make_svc(db_session, monkeypatch, enabled=False)
    with caplog.at_level("WARNING"):
        await _run(svc)
    warnings = [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
    assert any("auto-message" in m and "disabled" in m for m in warnings), warnings


@pytest.mark.asyncio
async def test_send_not_started_is_reported(db_session: AsyncSession, monkeypatch):
    """send_messages can still return None (no workflow configured, no project)."""
    svc = _make_svc(db_session, monkeypatch)
    svc.send_messages = AsyncMock(return_value=None)
    res = await _run(svc)
    assert res == {"auto_message": False, "reason": "send_not_started"}


@pytest.mark.asyncio
async def test_auto_runs_are_not_a_copy_source(db_session: AsyncSession, monkeypatch):
    """_last_human_message must ignore the automation's OWN runs: they also complete with
    send=True and a body, so accepting them would turn "a human approved this" into
    "something sent this before" and let a disable/re-enable cycle bootstrap from itself."""
    from core.state_machine import RunStatus
    from services.recruiter_pipeline_service import EVENT_MESSAGE

    svc = RecruiterPipelineService(db_session)

    def _row(body, auto, status=RunStatus.COMPLETED.value):
        return SimpleNamespace(status=status, origin={
            "event_kind": EVENT_MESSAGE,
            "pipeline": {"job_id": "290", "send": True, "auto": auto,
                         "subject": "S", "body": body},
        })

    rows = [_row("AUTO COPY", True), _row(HUMAN_BODY, False)]  # newest first

    class _Result:
        def scalars(self_inner):
            return SimpleNamespace(all=lambda: rows)

    svc.session = SimpleNamespace(execute=AsyncMock(return_value=_Result()))
    assert await svc._last_human_message("290") == ("S", HUMAN_BODY)
