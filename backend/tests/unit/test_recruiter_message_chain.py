"""Chained bulk-outreach accounting in RecruiterPipelineService._after_message.

A send now walks the project's uncontacted stage in small batches (default 5) across many
chained runs. A batch whose composer reports ineligible recipients ("N recipients cannot be
contacted more than once within 24 hours" / "…contacted by someone on your team") is DEFERRED
whole — LinkedIn never says WHICH recipients it silently drops, so messaging it would break the
messaged == noted == moved guarantee.

These tests pin the parts that made PROD run 26eb7ce9 (job 290, 2026-07-27) send 0 of 97:
a fully-deferred run must still CHAIN (not stall), deferred URLs must carry forward so the
chain converges, and only the LAST run may post a chatter summary.
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from services.recruiter_pipeline_service import RecruiterPipelineService


def _make_svc(db_session, monkeypatch, *, compose, pipeline_extra=None):
    svc = RecruiterPipelineService(db_session)
    svc.push = SimpleNamespace(
        read_message_compose_result=AsyncMock(return_value=compose),
        push_outreach_update=AsyncMock(return_value={"updated": 1}),
        push_candidate_notes=AsyncMock(return_value={"pushed": 1}),
        push_flow_status=AsyncMock(return_value={"pushed": 1}),
    )
    svc.send_messages = AsyncMock(return_value="next-run-id")
    monkeypatch.setattr(settings, "recruiter_message_max_continuations", 40)
    pipeline = {
        "job_id": "290", "send": True, "subject": "Job opportunity", "body": "Hi {Nombre},",
        "note_text": "Contacted - Staff SWE", "batch_size": 5,
    }
    pipeline.update(pipeline_extra or {})
    run = SimpleNamespace(id="msg-run-id", origin={})
    return svc, run, pipeline


def _chatter(svc):
    """The chatter messages actually posted (empty message = status-only, no chatter)."""
    return [c.kwargs.get("message") for c in svc.push.push_flow_status.await_args_list
            if c.kwargs.get("message")]


@pytest.mark.asyncio
async def test_fully_deferred_run_still_chains(db_session: AsyncSession, monkeypatch):
    """0 messaged but 5 deferred is NOT the end of the road — the next run must be enqueued
    (failing/stopping here is exactly what stalled job 290)."""
    svc, run, pipeline = _make_svc(db_session, monkeypatch, compose={
        "ok": True, "sent": False, "reason": "all_deferred", "more_remaining": True,
        "messaged_count": 0, "noted_count": 0, "moved_count": 0, "recipients": [],
        "skipped": [{"profile_url": "https://www.linkedin.com/talent/profile/A", "name": "A"},
                    {"profile_url": "https://www.linkedin.com/talent/profile/B", "name": "B"}],
        "skipped_count": 2,
    })
    res = await svc._after_message(run, pipeline, connector_id="c", job_id="290")
    assert res["continuation_run_id"] == "next-run-id"
    svc.send_messages.assert_awaited_once()
    _, kwargs = svc.send_messages.await_args
    # Deferred people carry forward, or the next run burns its budget on the same blockers.
    assert kwargs["deferred_urls"] == ["https://www.linkedin.com/talent/profile/A",
                                       "https://www.linkedin.com/talent/profile/B"]
    assert kwargs["batch_size"] == 5
    assert kwargs["chain"]["index"] == 1
    assert kwargs["chain"]["skipped"] == 2
    # Nothing was messaged → no Odoo outreach rows, and no chatter yet (chain still running).
    assert svc.push.push_outreach_update.await_args.kwargs["messaged"] == []
    assert _chatter(svc) == []


@pytest.mark.asyncio
async def test_chain_totals_accumulate_and_only_last_run_posts_chatter(
    db_session: AsyncSession, monkeypatch,
):
    """The final run reports the WHOLE chain, once."""
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch,
        compose={"ok": True, "sent": True, "messaged_count": 5, "noted_count": 5, "moved_count": 5,
                 "recipients": [{"profile_url": "https://www.linkedin.com/talent/profile/C", "name": "C"}],
                 "skipped": [], "skipped_count": 0},
        # …after 3 earlier runs that messaged 15 and deferred 10.
        pipeline_extra={"chain": {"index": 3, "messaged": 15, "noted": 15, "moved": 15, "skipped": 10},
                        "deferred_urls": ["https://www.linkedin.com/talent/profile/X"]},
    )
    res = await svc._after_message(run, pipeline, connector_id="c", job_id="290")
    # No more_remaining → the chain ends here.
    assert res["continuation_run_id"] is None
    svc.send_messages.assert_not_awaited()
    assert res["chain_totals"] == {"messaged": 20, "noted": 20, "moved": 20, "skipped": 10}
    msgs = _chatter(svc)
    assert len(msgs) == 1
    assert "20 candidate(s)" in msgs[0]
    assert "10 skipped" in msgs[0]


@pytest.mark.asyncio
async def test_chain_stops_at_the_continuation_cap(db_session: AsyncSession, monkeypatch):
    """A pathological loop can't run forever."""
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch,
        compose={"ok": True, "sent": True, "more_remaining": True, "messaged_count": 5,
                 "noted_count": 5, "moved_count": 5, "recipients": [], "skipped_count": 0},
        pipeline_extra={"chain": {"index": 40}},
    )
    monkeypatch.setattr(settings, "recruiter_message_max_continuations", 40)
    res = await svc._after_message(run, pipeline, connector_id="c", job_id="290")
    assert res["continuation_run_id"] is None
    svc.send_messages.assert_not_awaited()
    # …and it says so instead of silently dropping the rest.
    assert "run the send again" in _chatter(svc)[0]


@pytest.mark.asyncio
async def test_bounded_batch_never_chains(db_session: AsyncSession, monkeypatch):
    """max_recipients is the deliberate one-shot path (manual/testing) — no auto-drain."""
    svc, run, pipeline = _make_svc(
        db_session, monkeypatch,
        compose={"ok": True, "sent": True, "more_remaining": True, "messaged_count": 5,
                 "noted_count": 5, "moved_count": 5, "recipients": [], "skipped_count": 0},
        pipeline_extra={"max_recipients": 5},
    )
    await svc._after_message(run, pipeline, connector_id="c", job_id="290")
    svc.send_messages.assert_not_awaited()
