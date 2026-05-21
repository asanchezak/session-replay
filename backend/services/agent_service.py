import base64
import binascii
import contextlib
import hashlib
import json
import logging
import re
import struct
import time
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ai.agent_tools import ALL_TOOLS
from ai.client import get_ai_provider
from ai.prompts import (
    AGENT_EXECUTOR_SYSTEM,
    AGENT_TOOL_USE_SYSTEM,
    build_agent_decision_prompt,
    build_classify_prompt,
)
from core.config import settings
from core.exceptions import NotFoundError
from core.models.event import EventLog
from core.models.run import ExecutionRun
from core.models.workflow import WorkflowStep
from core.state_machine import RunStatus, WorkflowStateMachine
from core.utils import to_uuid
from services.agent_conversation import (
    append_assistant_turn,
    append_tool_result,
    append_user_turn,
    load_conversation,
    save_conversation,
)
from services.agent_models import (
    SAFETY_LIMITS,
    AgentCommand,
    CommandAction,
    DecisionValue,
    PlanUpdate,
    PollRequest,
    PollResponse,
    ResultRequest,
    ResultResponse,
)
from services.agent_tool_dispatcher import translate_tool_calls
from services.ai_outcome_service import AIOutcomeService
from services.audit import AppendEvent, AuditService
from services.execution_service import ExecutionService
from services.healing_service import HealingService
from services.site_adapters.linkedin import (
    LinkedInSiteAdapter,
    extract_click_label,
    selector_chain_has_shadow_host,
    selector_chain_texts,
)
from services.site_adapters.registry import compile_site_command

logger = logging.getLogger(__name__)

_run_retries: dict[str, int] = {}
_run_heal_attempts: dict[str, int] = {}
_run_adapt_count: dict[str, int] = {}
_run_plan_updates: dict[str, int] = {}
_run_last_poll: dict[str, datetime] = {}
_run_step_wait_count: dict[tuple[str, int], int] = {}
_run_total_waits: dict[str, int] = {}
_run_restart_count: dict[str, int] = {}
_run_rollback_count: dict[str, int] = {}
_run_active_step: dict[str, int] = {}
_run_step_recovery_started_at: dict[tuple[str, int], datetime] = {}
_run_step_recovery_cycles: dict[tuple[str, int], int] = {}
_run_unusable_output_waits: dict[tuple[str, int], int] = {}
_run_script_count: dict[str, int] = {}
_run_script_failure_counts: dict[tuple[str, int, str], int] = {}
_pending_actions: dict[str, str] = {}
TERMINAL_RUN_STATUSES = {
    RunStatus.FAILED.value,
    RunStatus.COMPLETED.value,
    RunStatus.CANCELED.value,
}


def _is_http_url(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(("http://", "https://"))


def _extract_first_http_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    match = re.search(r"https?://[^\s)>\"]+", value)
    if not match:
        return None
    return match.group(0).rstrip(".,;:!?)]}")


def _peek_jpeg_dimensions(data: bytes) -> tuple[int, int]:
    """Read width/height from a JPEG byte stream without decoding pixels.

    Walks the SOF0/SOF2 frame marker. Returns (0, 0) if the bytes are not a
    valid JPEG or the marker can't be located — callers should not raise.
    """
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        return 0, 0
    i = 2
    n = len(data)
    while i < n - 9:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        i += 2
        if marker == 0xD9 or marker == 0xDA:  # EOI or SOS
            return 0, 0
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            # Start-of-frame: skip 3 bytes (length + sample precision), then
            # the next 4 bytes are height (2) then width (2).
            if i + 7 >= n:
                return 0, 0
            height, width = struct.unpack(">HH", data[i + 3 : i + 7])
            return width, height
        if i + 1 >= n:
            return 0, 0
        seg_len = struct.unpack(">H", data[i : i + 2])[0]
        i += seg_len
    return 0, 0


class AgentService:
    """Intelligent agent service — uses AI for adaptive decision-making."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.execution = ExecutionService(session)
        self.audit = AuditService(session)
        self.healing = HealingService(session)
        self.ai_outcomes = AIOutcomeService(session)

    async def poll(self, run_id: str, req: PollRequest) -> PollResponse:
        run = await self._get_run(run_id)
        _run_last_poll[run_id] = datetime.now(UTC)

        ctx = req.page_context

        if ctx.is_blocking and ctx.blocking_type:
            ai_classification = await self._classify_blockage(run, ctx)
            reasoning = f"Blocking challenge: {ctx.blocking_type.value}"
            if ai_classification:
                reasoning += f" (AI: {ai_classification.get('reason', '')})"

            await self._audit_decision(
                run_id, "PAUSE", 0.99,
                reasoning,
                pause_reason=f"Blocking challenge detected: {ctx.blocking_type.value}",
                extra_payload=(
                    {"ai_classification": ai_classification}
                    if ai_classification else None
                ),
                page_context=ctx,
            )
            with contextlib.suppress(Exception):
                await self.execution.pause(
                    run_id,
                    reason=f"Blocking challenge: {ctx.blocking_type.value}",
                )
            return PollResponse(
                decision="PAUSE",
                confidence=0.99,
                reasoning=reasoning,
                pause_reason=f"Blocking challenge detected: {ctx.blocking_type.value}",
                requires_human=True,
            )

        if run.status in TERMINAL_RUN_STATUSES:
            self._clear_recovery_state(run_id)
            return PollResponse(
                decision="COMPLETED",
                confidence=0.99,
                reasoning=f"Run already terminal: {run.status}",
                next_step_index=run.current_step_index,
            )

        snapshot = run.workflow_snapshot or {}
        steps: list[dict[str, Any]] = snapshot.get("steps", [])
        analysis: dict[str, Any] = snapshot.get("analysis", {})
        total_steps = len(steps)

        step_index = (
            req.current_step_index
            if req.current_step_index is not None
            else run.current_step_index
        )
        if step_index >= total_steps and run.current_step_index < total_steps:
            logger.warning(
                "Client step drift detected for run %s: client=%s server=%s total=%s",
                run_id,
                step_index,
                run.current_step_index,
                total_steps,
            )
            step_index = run.current_step_index

        if step_index >= total_steps:
            self._clear_recovery_state(run_id)
            return PollResponse(
                decision="COMPLETED",
                confidence=0.99,
                reasoning="All steps completed",
                next_step_index=step_index,
            )

        # Goal-predicate early termination: check if the workflow objective is
        # already satisfied on the current page before attempting the next step.
        # This prevents over-execution when the goal is met before all steps run.
        if await self._goal_predicate_satisfied(run, ctx):
            self._clear_recovery_state(run_id)
            # Audit BEFORE completing so _is_run_terminal guard doesn't skip the event.
            await self._audit_decision(
                run_id, "COMPLETED", 0.99,
                "Goal predicate satisfied — workflow objective achieved early",
                page_context=ctx,
            )
            with contextlib.suppress(Exception):
                await self.execution.complete(run_id)
            with contextlib.suppress(Exception):
                await self._maybe_persist_plan_mutations(run)
            return PollResponse(
                decision="COMPLETED",
                confidence=0.99,
                reasoning="Goal predicate satisfied — workflow objective achieved early",
                next_step_index=step_index,
            )

        self._touch_recovery_window(run_id, step_index)
        timeout_response = await self._fail_on_step_recovery_timeout(
            run=run,
            step_index=step_index,
            ctx=ctx,
            trigger="pre_decision",
        )
        if timeout_response:
            return timeout_response

        step = steps[step_index]
        command = self._build_command(step)

        ai_decision: dict[str, Any] | None = None
        applied_updates: list[dict[str, Any]] = []
        if self._should_consult_ai(run_id, step, ctx):
            ai_decision = await self._consult_ai_for_step(
                run, step_index, step, command, analysis, ctx,
                screenshot_b64=req.screenshot_b64,
                screenshot_mime=req.screenshot_mime,
                screenshot_trigger=req.screenshot_trigger,
            )
            if ai_decision:
                applied_updates = await self._apply_plan_updates_from_ai(
                    run, ai_decision.get("plan_updates"),
                )
                terminal = await self._terminal_response_if_needed(
                    run, fallback_step_index=step_index,
                )
                if terminal:
                    return terminal
                snapshot = run.workflow_snapshot or {}
                steps = snapshot.get("steps", [])
                total_steps = len(steps)
                if step_index >= total_steps:
                    return PollResponse(
                        decision="COMPLETED",
                        confidence=0.99,
                        reasoning="All steps completed after plan update",
                        next_step_index=step_index,
                    )
                step = steps[step_index]
                command = self._build_command(step)
                decision_type: DecisionValue = ai_decision.get("decision", "EXECUTE")

                if decision_type == "WAIT":
                    return await self._handle_wait_decision(
                        run=run,
                        step_index=step_index,
                        ai_decision=ai_decision,
                        ctx=ctx,
                    )
                if decision_type == "ADAPT":
                    adapted_command = self._parse_adapted_command(
                        ai_decision.get("command", {}),
                    )
                    # Workstream A: enforce per-run quota on run_script primitive.
                    if (
                        adapted_command
                        and adapted_command.action == CommandAction.RUN_SCRIPT
                    ):
                        quota_response = self._check_run_script_quota(
                            run_id, step_index, ai_decision,
                        )
                        if quota_response:
                            return quota_response
                    _run_adapt_count[run_id] = _run_adapt_count.get(run_id, 0) + 1
                    _run_step_wait_count.pop((run_id, step_index), None)
                    await self._audit_decision(
                        run_id,
                        "ADAPT",
                        ai_decision.get("confidence", 0.7),
                        ai_decision.get("reasoning", "AI-adapted step"),
                        command=adapted_command or command,
                        extra_payload={"plan_updates": applied_updates} if applied_updates else None,
                        step_index=step_index,
                        thinking_steps=ai_decision.get("thinking_steps"),
                        page_context=ctx,
                        decision_context=ai_decision.get("decision_context"),
                        screenshot_meta=ai_decision.get("screenshot_meta"),
                    )
                    if run.status != RunStatus.RUNNING.value:
                        with contextlib.suppress(Exception):
                            await self._transition_to_running(run)
                    return PollResponse(
                        decision="ADAPT",
                        confidence=ai_decision.get("confidence", 0.7),
                        reasoning=ai_decision.get("reasoning", "AI-adapted step"),
                        command=adapted_command or command,
                        next_step_index=step_index,
                        plan_updates=applied_updates,
                    )
                if decision_type == "SKIP":
                    await self._audit_decision(
                        run_id,
                        "SKIP",
                        ai_decision.get("confidence", 0.7),
                        ai_decision.get("reasoning", "AI recommends skipping"),
                        extra_payload={"plan_updates": applied_updates} if applied_updates else None,
                        step_index=step_index,
                        thinking_steps=ai_decision.get("thinking_steps"),
                        page_context=ctx,
                        decision_context=ai_decision.get("decision_context"),
                        screenshot_meta=ai_decision.get("screenshot_meta"),
                    )
                    await self.execution.advance_step(run_id)
                    self._clear_recovery_state(run_id)
                    _run_step_wait_count.pop((run_id, step_index), None)
                    return PollResponse(
                        decision="SKIP",
                        confidence=ai_decision.get("confidence", 0.7),
                        reasoning=ai_decision.get("reasoning", "Step skipped by AI"),
                        next_step_index=step_index + 1,
                        plan_updates=applied_updates,
                    )
                if decision_type == "RESTART":
                    return await self._handle_restart_decision(
                        run, step_index, ai_decision, ctx,
                    )
                if decision_type == "ROLLBACK":
                    return await self._handle_rollback_decision(
                        run, step_index, ai_decision, ctx,
                    )
                if decision_type == "PAUSE":
                    return await self._autonomous_recovery_cycle(
                        run=run,
                        step_index=step_index,
                        step=step,
                        ctx=ctx,
                        trigger="ai_pause_non_blocking",
                        prior_ai_decision=ai_decision,
                    )
            else:
                terminal = await self._terminal_response_if_needed(
                    run, fallback_step_index=step_index,
                )
                if terminal:
                    return terminal
                wait_response = await self._fallback_after_ai_failure(run, step_index, step, ctx)
                if wait_response:
                    return wait_response

        # Workstream A: enforce per-run quota on run_script primitive (EXECUTE path).
        if command.action == CommandAction.RUN_SCRIPT:
            quota_response = self._check_run_script_quota(
                run_id, step_index, ai_decision,
            )
            if quota_response:
                return quota_response

        ai_confirmed = bool(ai_decision)
        reason_prefix = "AI confirmed EXECUTE" if ai_confirmed else "Fast path"
        ai_conf = (ai_decision or {}).get("confidence", 0.99) if ai_confirmed else 0.99
        _run_step_wait_count.pop((run_id, step_index), None)
        terminal = await self._terminal_response_if_needed(
            run, fallback_step_index=step_index,
        )
        if terminal:
            return terminal
        await self._audit_decision(
            run_id,
            "EXECUTE",
            ai_conf,
            f"{reason_prefix}: execute step {step_index} ({step.get('action_type', '')})",
            command=command,
            step_index=step_index,
            thinking_steps=(ai_decision or {}).get("thinking_steps") if ai_confirmed else None,
            page_context=ctx,
            decision_context=(ai_decision or {}).get("decision_context"),
            screenshot_meta=(ai_decision or {}).get("screenshot_meta") if ai_confirmed else None,
        )

        if run.status != "running":
            try:
                await self._transition_to_running(run)
            except Exception as e:
                logger.warning("Could not transition run %s to running: %s", run_id, e)

        return PollResponse(
            decision="EXECUTE",
            confidence=0.99,
            reasoning=f"Executing step {step_index}: {step.get('action_type', '')}",
            command=command,
            next_step_index=step_index,
        )

    _SESSION_ID_PATTERNS = (
        re.compile(r"#_[A-Za-z0-9_-]{6,}"),
        re.compile(r"#[a-z]+-[A-Fa-f0-9]{8,}"),
        re.compile(r"#[A-Za-z0-9]{20,}"),
    )

    @classmethod
    def _selectors_look_fragile(cls, selector_chain: list[dict]) -> bool:
        """Heuristic: are recorded selectors likely to break across sessions?

        Returns True when no selector has a stable semantic anchor
        (accessibility role/name, text content, data-testid, aria-label) at
        meaningful score, OR when the strongest css selector is a
        session-generated id like Google's `#_IvMFavSHKoOzqtsP4p6usQs_40`.
        """
        if not selector_chain:
            return True
        stable = False
        for sel in selector_chain:
            if not isinstance(sel, dict):
                continue
            kind = (sel.get("type") or "").lower()
            value = sel.get("value") or ""
            score = sel.get("score") or 0
            if kind in {"accessibility", "text", "aria", "aria-label", "data-testid", "role"} and score >= 0.6:
                stable = True
                break
            if kind == "css" and score >= 0.7:
                if any(p.match(value) for p in cls._SESSION_ID_PATTERNS):
                    continue
                if "data-testid" in value or "[aria-" in value or "role=" in value:
                    stable = True
                    break
                stable = True
                break
        return not stable

    def _should_consult_ai(
        self, run_id: str, step: dict[str, Any], _ctx: Any,
    ) -> bool:
        """AI owns strategy when configured.

        When AI IS configured, also consults for fragile selectors (session-specific
        IDs, low-score chains) so the AI can choose a better approach before the step
        fails — rather than burning through the retry/heal budget first.
        Only triggers AI if the API key is available; fragile-selector detection
        does NOT force AI consultation when no provider is configured.
        """
        _ = (run_id, _ctx)
        if not bool(settings.ai_api_key and not settings.deterministic_only):
            return False  # No AI provider — never consult
        # With AI available: always consult (standard behavior)
        return True

    @staticmethod
    def _extract_thinking_steps(raw: dict, max_steps: int = 10) -> list[dict]:
        """Extract and validate thinking_steps from an AI response dict.

        Always returns a list (possibly empty). Caps length and field sizes to
        bound storage. Never raises.
        """
        raw_steps = raw.get("thinking_steps")
        if not isinstance(raw_steps, list):
            return []
        validated: list[dict] = []
        for i, step in enumerate(raw_steps[:max_steps]):
            if not isinstance(step, dict):
                continue
            validated.append({
                "step": i + 1,
                "question":    str(step.get("question", ""))[:500],
                "observation": str(step.get("observation", ""))[:500],
                "conclusion":  str(step.get("conclusion", ""))[:300],
            })
        return validated

    @staticmethod
    def _is_transitional_page(ctx: Any) -> bool:
        page_diff = getattr(ctx, "page_diff", None) or {}
        if page_diff.get("url_changed") or page_diff.get("title_changed"):
            return True
        added = page_diff.get("added") or []
        visible_elements = getattr(ctx, "visible_elements", None) or []
        visible_text = (getattr(ctx, "visible_text", "") or "").strip()
        return bool(added) and len(visible_elements) <= 4 and len(visible_text) < 200

    def _touch_recovery_window(self, run_id: str, step_index: int) -> None:
        active_step = _run_active_step.get(run_id)
        if active_step != step_index:
            self._clear_recovery_state(run_id)
            _run_active_step[run_id] = step_index
        key = (run_id, step_index)
        _run_step_recovery_started_at.setdefault(key, datetime.now(UTC))
        _run_step_recovery_cycles.setdefault(key, 0)

    def _clear_recovery_state(self, run_id: str) -> None:
        _run_retries.pop(run_id, None)
        _run_heal_attempts.pop(run_id, None)
        _run_total_waits.pop(run_id, None)
        _run_restart_count.pop(run_id, None)
        _run_rollback_count.pop(run_id, None)
        _run_active_step.pop(run_id, None)
        _run_script_count.pop(run_id, None)
        keys = [k for k in _run_step_wait_count if k[0] == run_id]
        for key in keys:
            _run_step_wait_count.pop(key, None)
        recovery_keys = [k for k in _run_step_recovery_started_at if k[0] == run_id]
        for key in recovery_keys:
            _run_step_recovery_started_at.pop(key, None)
            _run_step_recovery_cycles.pop(key, None)
            _run_unusable_output_waits.pop(key, None)
        script_keys = [k for k in _run_script_failure_counts if k[0] == run_id]
        for key in script_keys:
            _run_script_failure_counts.pop(key, None)

    @staticmethod
    def _classify_script_failure(error: str | None) -> str | None:
        if not isinstance(error, str) or not error.strip():
            return None
        normalized = error.strip().lower()
        if "script_parse_error" in normalized or "content security policy" in normalized:
            return "fatal"
        if "js_click_fallback_no_target" in normalized or "js_type_fallback_no_target" in normalized:
            return "no-target"
        if "script_timeout" in normalized or "timed out" in normalized:
            return "timeout"
        if "run_script injection failed" in normalized or "referenceerror" in normalized:
            return "threw"
        if "missing 'script' source" in normalized or "no result returned" in normalized:
            return "no-target"
        return "threw"

    def _record_script_failure(
        self,
        run_id: str,
        step_index: int,
        category: str,
    ) -> int:
        key = (run_id, step_index, category)
        count = _run_script_failure_counts.get(key, 0) + 1
        _run_script_failure_counts[key] = count
        return count

    def _clear_script_failure_counts(self, run_id: str, step_index: int) -> None:
        keys = [
            key for key in _run_script_failure_counts
            if key[0] == run_id and key[1] == step_index
        ]
        for key in keys:
            _run_script_failure_counts.pop(key, None)

    async def _audit_script_execution(
        self, run_id: str, req: ResultRequest,
    ) -> None:
        """Emit a 'script_executed' EventLog row. The full script source is
        recovered indirectly from the snapshot or AI decision audit; here we
        only fingerprint the result + capture log/duration. Truncates large
        values to keep the audit row compact."""
        try:
            result_preview: Any = None
            result_len = 0
            if req.script_result is not None:
                try:
                    as_json = json.dumps(req.script_result)
                    result_len = len(as_json)
                    result_preview = as_json[:1024]
                except (TypeError, ValueError):
                    result_preview = str(req.script_result)[:1024]
            result_sha = (
                hashlib.sha256(
                    json.dumps(req.script_result, default=str).encode("utf-8"),
                ).hexdigest()
                if req.script_result is not None
                else None
            )
            payload: dict[str, Any] = {
                "step_index": req.step_index,
                "success": req.success,
                "error": req.error,
                "result_sha256": result_sha,
                "result_type": type(req.script_result).__name__ if req.script_result is not None else None,
                "result_preview": result_preview,
                "result_len_bytes": result_len,
                "logs": (req.script_logs or [])[:10],
                "duration_ms": req.script_duration_ms,
            }
            await self.audit.append(AppendEvent(
                event_type="script_executed",
                payload=payload,
                run_id=run_id,
            ))
        except Exception as exc:
            logger.debug("script_executed audit skipped: %s", exc)

    def _check_run_script_quota(
        self,
        run_id: str,
        step_index: int,
        ai_decision: dict[str, Any] | None,
    ) -> PollResponse | None:
        """Workstream A: cap how many run_script primitives a single run can
        invoke. Returns a PAUSE PollResponse when the budget is exhausted;
        otherwise increments the counter and returns None so the caller can
        proceed to emit the EXECUTE/ADAPT response."""
        cap = int(SAFETY_LIMITS.get("max_run_script_per_run", 30))
        current = _run_script_count.get(run_id, 0)
        if current >= cap:
            reason = f"run_script budget exhausted ({current}/{cap})"
            logger.warning("Run %s exceeded run_script quota: %s", run_id, reason)
            return PollResponse(
                decision="PAUSE",
                confidence=0.99,
                reasoning=reason,
                pause_reason="script_budget_exhausted",
                next_step_index=step_index,
                requires_human=False,
            )
        _run_script_count[run_id] = current + 1
        # Annotate the audit context if we have an ai_decision dict in hand.
        if isinstance(ai_decision, dict):
            ctx = ai_decision.setdefault("decision_context", {}) or {}
            ctx["run_script_count"] = current + 1
            ai_decision["decision_context"] = ctx
        return None

    def _recovery_window_seconds(self) -> int:
        return max(30, int(getattr(settings, "ai_step_recovery_window_seconds", 900)))

    async def _is_run_terminal(self, run_id: str) -> bool:
        """Read status from DB to avoid writing recovery/decision events after terminal."""
        try:
            run_uuid = to_uuid(run_id)
        except Exception:
            # Test stubs may use synthetic IDs; fail-open to keep behavior
            # deterministic outside the real DB-backed runtime.
            return False
        try:
            result = await self.session.execute(
                select(ExecutionRun.status).where(ExecutionRun.id == run_uuid)
            )
            status = result.scalar_one_or_none()
        except Exception:
            return False
        return bool(status in TERMINAL_RUN_STATUSES)

    async def _terminal_response_if_needed(
        self,
        run: ExecutionRun,
        *,
        fallback_step_index: int | None = None,
    ) -> PollResponse | None:
        """Refresh run status and short-circuit decision loops when terminal."""
        with contextlib.suppress(Exception):
            await self.session.refresh(run)
        if run.status not in TERMINAL_RUN_STATUSES:
            return None
        run_id = str(run.id)
        self._clear_recovery_state(run_id)
        return PollResponse(
            decision="COMPLETED",
            confidence=0.99,
            reasoning=f"Run already terminal: {run.status}",
            next_step_index=(
                run.current_step_index
                if fallback_step_index is None
                else fallback_step_index
            ),
        )

    def _seconds_in_recovery_window(self, run_id: str, step_index: int) -> int:
        started = _run_step_recovery_started_at.get((run_id, step_index))
        if not started:
            return 0
        return int((datetime.now(UTC) - started).total_seconds())

    async def _append_recovery_event(self, run_id: str, payload: dict[str, Any]) -> None:
        if await self._is_run_terminal(run_id):
            return
        await self.audit.append(
            AppendEvent(
                event_type="recovery_cycle",
                payload=payload,
                run_id=run_id,
                actor_type="ai",
            )
        )

    def _page_context_digest(self, ctx: Any) -> dict[str, Any]:
        visible_elements = getattr(ctx, "visible_elements", None) or []
        visible_text = (getattr(ctx, "visible_text", "") or "").strip()
        return {
            "url": (getattr(ctx, "url", "") or "")[:300],
            "title": (getattr(ctx, "title", "") or "")[:180],
            "visible_text_excerpt": visible_text[:400],
            "visible_elements_count": len(visible_elements),
            "page_diff": getattr(ctx, "page_diff", None),
        }

    @staticmethod
    def _build_ai_page_signals(ctx: Any, step: dict[str, Any]) -> dict[str, Any]:
        visible_elements = getattr(ctx, "visible_elements", None) or []
        page_diff = getattr(ctx, "page_diff", None) or {}
        visible_text = str(getattr(ctx, "visible_text", "") or "")

        def _normalize_number(raw: str) -> str:
            value = raw.strip()
            if "," in value and "." in value:
                if value.rfind(",") > value.rfind("."):
                    value = value.replace(".", "").replace(",", ".")
                else:
                    value = value.replace(",", "")
            elif "," in value:
                value = value.replace(".", "").replace(",", ".")
            return value

        candidates: list[dict[str, Any]] = []
        for raw in visible_elements:
            if not isinstance(raw, dict):
                continue
            selector = str(raw.get("selector") or "").strip()
            text = str(
                raw.get("text")
                or raw.get("aria_label")
                or raw.get("value")
                or raw.get("label")
                or ""
            ).strip()
            role = str(raw.get("role") or "").strip().lower()
            tag = str(raw.get("tag") or "").strip().lower()
            clickable = bool(raw.get("clickable")) or (
                role in {"button", "link", "tab", "option"}
                or tag in {"button", "a", "input", "label", "summary"}
            )
            score = 0
            if clickable:
                score += 8
            if text:
                score += min(len(text), 30) // 5
            if selector.startswith("#") or "[data-testid" in selector or "aria-" in selector:
                score += 3
            if "button" in selector.lower():
                score += 2
            candidates.append(
                {
                    "selector": selector[:200],
                    "text": text[:120],
                    "role": role[:40],
                    "tag": tag[:20],
                    "score": score,
                }
            )
        candidates.sort(key=lambda c: c.get("score", 0), reverse=True)

        number_tokens = re.findall(r"\d[\d.,]*", visible_text)
        for candidate in candidates[:8]:
            text = str(candidate.get("text") or "")
            number_tokens.extend(re.findall(r"\d[\d.,]*", text))
        normalized_numbers = []
        for token in number_tokens:
            normalized = _normalize_number(token)
            if normalized and normalized not in normalized_numbers:
                normalized_numbers.append(normalized)

        return {
            "step_action": str(step.get("action_type") or "")[:40],
            "step_intent": str(step.get("intent") or "")[:180],
            "interactive_candidates": candidates[:8],
            "normalized_numbers": normalized_numbers[:10],
            "settle_signals": {
                "page_unchanged": bool(getattr(ctx, "page_unchanged", False)),
                "url_changed": bool(page_diff.get("url_changed")),
                "title_changed": bool(page_diff.get("title_changed")),
                "dom_added_count": len(page_diff.get("added") or []),
                "dom_removed_count": len(page_diff.get("removed") or []),
            },
            "delta_summary": {
                "added_sample": (page_diff.get("added") or [])[:5],
                "removed_sample": (page_diff.get("removed") or [])[:5],
            },
        }

    async def _recent_decision_digest(self, run_id: str, limit: int) -> list[dict[str, Any]]:
        result = await self.session.execute(
            select(EventLog)
            .where(EventLog.run_id == to_uuid(run_id))
            .where(EventLog.event_type == "agent_decision")
            .order_by(EventLog.sequence_number.desc())
            .limit(limit)
        )
        rows = []
        for ev in result.scalars().all():
            payload = ev.payload or {}
            rows.append(
                {
                    "decision": payload.get("decision"),
                    "confidence": payload.get("confidence"),
                    "reasoning": (payload.get("reasoning") or "")[:220],
                    "step_index": payload.get("step_index"),
                    "decision_context": payload.get("decision_context"),
                }
            )
        rows.reverse()
        return rows

    async def _fail_on_step_recovery_timeout(
        self,
        run: ExecutionRun,
        step_index: int,
        ctx: Any,
        trigger: str,
    ) -> PollResponse | None:
        run_id = str(run.id)
        elapsed_seconds = self._seconds_in_recovery_window(run_id, step_index)
        window_seconds = self._recovery_window_seconds()
        if elapsed_seconds < window_seconds:
            return None
        if await self._is_run_terminal(run_id):
            self._clear_recovery_state(run_id)
            return PollResponse(
                decision="COMPLETED",
                confidence=0.99,
                reasoning=f"Run already terminal: {run.status}",
                next_step_index=run.current_step_index,
            )

        decision_limit = max(1, int(getattr(settings, "ai_timeout_decision_history_limit", 6)))
        recent_decisions = await self._recent_decision_digest(run_id, decision_limit)
        diagnostic_payload = {
            "trigger": trigger,
            "step_index": step_index,
            "elapsed_seconds": elapsed_seconds,
            "window_seconds": window_seconds,
            "page_context": self._page_context_digest(ctx),
            "recent_decisions": recent_decisions,
        }
        summary = (
            f"Step recovery window expired after {elapsed_seconds}s on step {step_index}. "
            f"Recent decisions={len(recent_decisions)}. "
            f"Page url={diagnostic_payload['page_context']['url'] or '(unknown)'}."
        )
        await self._append_recovery_event(
            run_id,
            {
                "kind": "timeout",
                **diagnostic_payload,
                "summary": summary,
            },
        )
        if await self._is_run_terminal(run_id):
            self._clear_recovery_state(run_id)
            return PollResponse(
                decision="COMPLETED",
                confidence=0.99,
                reasoning=f"Run already terminal: {run.status}",
                next_step_index=run.current_step_index,
            )
        with contextlib.suppress(Exception):
            await self.execution.fail(run_id, summary)
        run.error_summary = summary
        run.pause_reason = None
        await self.session.flush()
        self._clear_recovery_state(run_id)
        return PollResponse(
            decision="PAUSE",
            confidence=1.0,
            reasoning=summary,
            pause_reason=summary,
            requires_human=False,
        )

    async def _autonomous_recovery_cycle(
        self,
        run: ExecutionRun,
        step_index: int,
        step: dict[str, Any],
        ctx: Any,
        trigger: str,
        prior_ai_decision: dict[str, Any] | None = None,
    ) -> PollResponse:
        run_id = str(run.id)
        terminal = await self._terminal_response_if_needed(
            run, fallback_step_index=step_index,
        )
        if terminal:
            return terminal
        cycle_key = (run_id, step_index)
        cycle = _run_step_recovery_cycles.get(cycle_key, 0) + 1
        _run_step_recovery_cycles[cycle_key] = cycle
        strategy_order = ("ADAPT", "RESTART", "ROLLBACK", "EXECUTE")
        strategy = strategy_order[(cycle - 1) % len(strategy_order)]

        await self._append_recovery_event(
            run_id,
            {
                "kind": "cycle_started",
                "trigger": trigger,
                "step_index": step_index,
                "cycle": cycle,
                "strategy": strategy,
                "elapsed_seconds": self._seconds_in_recovery_window(run_id, step_index),
            },
        )

        ai_recovery = await self._consult_ai_for_step(
            run=run,
            step_index=step_index,
            step=step,
            _original_command=self._build_command(step),
            analysis=(run.workflow_snapshot or {}).get("analysis", {}) or {},
            ctx=ctx,
            recovery_mode=True,
            recovery_reason=trigger,
            strategy_hint=strategy,
            prior_ai_decision=prior_ai_decision,
        )

        if ai_recovery:
            decision_type: DecisionValue = ai_recovery.get("decision", "WAIT")
            if decision_type == "ADAPT":
                adapted_command = self._parse_adapted_command(ai_recovery.get("command", {}))
                _run_unusable_output_waits.pop(cycle_key, None)
                await self._audit_decision(
                    run_id,
                    "ADAPT",
                    ai_recovery.get("confidence", 0.65),
                    ai_recovery.get("reasoning", "Recovery adaptation"),
                    command=adapted_command or self._build_command(step),
                    step_index=step_index,
                    thinking_steps=ai_recovery.get("thinking_steps"),
                    page_context=ctx,
                    decision_context=ai_recovery.get("decision_context"),
                    extra_payload={"recovery_cycle": cycle, "recovery_trigger": trigger},
                )
                return PollResponse(
                    decision="ADAPT",
                    confidence=ai_recovery.get("confidence", 0.65),
                    reasoning=ai_recovery.get("reasoning", "Recovery adaptation"),
                    command=adapted_command or self._build_command(step),
                    next_step_index=step_index,
                )
            if decision_type == "RESTART":
                _run_unusable_output_waits.pop(cycle_key, None)
                return await self._handle_restart_decision(run, step_index, ai_recovery, ctx)
            if decision_type == "ROLLBACK":
                _run_unusable_output_waits.pop(cycle_key, None)
                return await self._handle_rollback_decision(run, step_index, ai_recovery, ctx)
            if decision_type == "EXECUTE":
                _run_unusable_output_waits.pop(cycle_key, None)
                command = self._build_command(step)
                await self._audit_decision(
                    run_id,
                    "EXECUTE",
                    ai_recovery.get("confidence", 0.6),
                    ai_recovery.get("reasoning", "Recovery execute"),
                    command=command,
                    step_index=step_index,
                    thinking_steps=ai_recovery.get("thinking_steps"),
                    page_context=ctx,
                    decision_context=ai_recovery.get("decision_context"),
                    extra_payload={"recovery_cycle": cycle, "recovery_trigger": trigger},
                )
                return PollResponse(
                    decision="EXECUTE",
                    confidence=ai_recovery.get("confidence", 0.6),
                    reasoning=ai_recovery.get("reasoning", "Recovery execute"),
                    command=command,
                    next_step_index=step_index,
                )
        # Always continue autonomously for non-blocking pages until timeout.
        fallback_wait_ms = max(SAFETY_LIMITS["wait_min_ms"], 1200)
        if trigger == "ai_unusable_output":
            stalled = _run_unusable_output_waits.get(cycle_key, 0) + 1
            _run_unusable_output_waits[cycle_key] = stalled
            stall_budget = int(SAFETY_LIMITS.get("max_ai_unusable_output_wait_cycles", 4))
            if stalled >= stall_budget:
                reason = "ai_unusable_output_budget_exhausted"
                await self._append_recovery_event(
                    run_id,
                    {
                        "kind": "budget_exhausted",
                        "trigger": trigger,
                        "step_index": step_index,
                        "cycle": cycle,
                        "stalled_wait_cycles": stalled,
                        "stall_budget": stall_budget,
                    },
                )
                await self._audit_decision(
                    run_id,
                    "PAUSE",
                    0.8,
                    "AI could not produce a usable decision within the bounded recovery budget.",
                    pause_reason=reason,
                    step_index=step_index,
                    page_context=ctx,
                    decision_context={
                        "reason_code": reason,
                        "stalled_wait_cycles": stalled,
                        "stall_budget": stall_budget,
                        "trigger": trigger,
                    },
                )
                with contextlib.suppress(Exception):
                    await self.execution.pause(run_id, reason=reason)
                return PollResponse(
                    decision="PAUSE",
                    confidence=0.8,
                    reasoning="AI recovery budget exhausted; pausing for deterministic handoff.",
                    pause_reason=reason,
                    next_step_index=step_index,
                    requires_human=False,
                )
        else:
            _run_unusable_output_waits.pop(cycle_key, None)
        await self._audit_decision(
            run_id,
            "WAIT",
            0.45,
            f"Recovery cycle {cycle} ({strategy}) still in progress",
            step_index=step_index,
            page_context=ctx,
            decision_context={"strategy": strategy, "trigger": trigger, "cycle": cycle},
            extra_payload={"wait_ms": fallback_wait_ms, "recovery_cycle": cycle},
        )
        timeout_response = await self._fail_on_step_recovery_timeout(
            run=run,
            step_index=step_index,
            ctx=ctx,
            trigger=f"{trigger}_cycle_{cycle}",
        )
        if timeout_response:
            return timeout_response
        return PollResponse(
            decision="WAIT",
            confidence=0.45,
            reasoning=f"Recovery cycle {cycle} ({strategy}) still in progress",
            next_step_index=step_index,
            wait_ms=fallback_wait_ms,
        )

    async def _fallback_after_ai_failure(
        self,
        run: ExecutionRun,
        step_index: int,
        step: dict[str, Any],
        ctx: Any,
    ) -> PollResponse | None:
        run_id = str(run.id)
        navigate_url: str | None = None
        # AI-first does not mean AI-only. If the model output is unusable but
        # the recorded step is a deterministic navigate, execute it instead of
        # pausing the run.
        if isinstance(step, dict) and step.get("action_type") == "navigate":
            navigate_url = self._resolve_step_navigate_url(step)
            if not navigate_url:
                navigate_url = _extract_first_http_url((step.get("intent") or ""))
        if (
            isinstance(step, dict)
            and step.get("action_type") == "navigate"
            and navigate_url
        ):
            command = self._build_command(step)
            command.value = navigate_url
            command.target = navigate_url
            reasoning = "AI output unusable; executing deterministic navigate fallback"
            await self._audit_decision(
                run_id,
                "EXECUTE",
                0.7,
                reasoning,
                command=command,
                step_index=step_index,
                page_context=ctx,
                decision_context={"origin": "ai-fallback", "step_action": step.get("action_type")},
            )
            return PollResponse(
                decision="EXECUTE",
                confidence=0.7,
                reasoning=reasoning,
                command=command,
                next_step_index=step_index,
            )

        site_command = compile_site_command(step, ctx)
        if site_command:
            reasoning = "AI output unusable; executing site adapter fallback"
            await self._audit_decision(
                run_id,
                "EXECUTE",
                0.78,
                reasoning,
                command=site_command,
                step_index=step_index,
                page_context=ctx,
                decision_context={
                    "origin": "ai-fallback",
                    "fallback": "site-adapter",
                    "site": site_command.script_args.get("site") if site_command.script_args else None,
                    "step_action": step.get("action_type"),
                },
            )
            return PollResponse(
                decision="EXECUTE",
                confidence=0.78,
                reasoning=reasoning,
                command=site_command,
                next_step_index=step_index,
            )

        js_click_command = self._build_js_click_fallback_command(step, ctx)
        if js_click_command:
            reasoning = "AI output unusable; executing deterministic JS click fallback"
            await self._audit_decision(
                run_id,
                "EXECUTE",
                0.65,
                reasoning,
                command=js_click_command,
                step_index=step_index,
                page_context=ctx,
                decision_context={
                    "origin": "ai-fallback",
                    "fallback": "js-click",
                    "page_content_analyzed": True,
                    "step_action": step.get("action_type"),
                },
            )
            return PollResponse(
                decision="EXECUTE",
                confidence=0.65,
                reasoning=reasoning,
                command=js_click_command,
                next_step_index=step_index,
            )

        js_type_command = self._build_js_type_fallback_command(step)
        if js_type_command:
            reasoning = "AI output unusable; executing deterministic JS type fallback"
            await self._audit_decision(
                run_id,
                "EXECUTE",
                0.65,
                reasoning,
                command=js_type_command,
                step_index=step_index,
                page_context=ctx,
                decision_context={
                    "origin": "ai-fallback",
                    "fallback": "js-type",
                    "page_content_analyzed": True,
                    "step_action": step.get("action_type"),
                },
            )
            return PollResponse(
                decision="EXECUTE",
                confidence=0.65,
                reasoning=reasoning,
                command=js_type_command,
                next_step_index=step_index,
            )

        if self._is_transitional_page(ctx):
            return await self._handle_wait_decision(
                run=run,
                step_index=step_index,
                ai_decision={
                    "confidence": 0.45,
                    "reasoning": "AI attempts failed while the page still looks transitional",
                    "wait_ms": 1500,
                    "thinking_steps": [],
                    "decision_context": {"origin": "ai-fallback"},
                },
                ctx=ctx,
            )
        return await self._autonomous_recovery_cycle(
            run=run,
            step_index=step_index,
            step=step,
            ctx=ctx,
            trigger="ai_unusable_output",
            prior_ai_decision={"decision_context": {"origin": "ai-fallback", "step_action": step.get("action_type")}},
        )

    @staticmethod
    def _extract_click_label(step: dict[str, Any]) -> str | None:
        return extract_click_label(step)

    @staticmethod
    def _analyze_click_candidates_from_page_content(
        ctx: Any,
        label: str,
    ) -> dict[str, list[str]]:
        label_l = label.lower()
        label_n = re.sub(r"[^a-z0-9]+", "", label_l)
        selectors: list[str] = []
        texts: list[str] = []
        visible_elements = getattr(ctx, "visible_elements", None) or []
        for raw in visible_elements:
            if not isinstance(raw, dict):
                continue
            text = str(
                raw.get("text")
                or raw.get("aria_label")
                or raw.get("value")
                or raw.get("label")
                or "",
            ).strip()
            selector = str(raw.get("selector") or "").strip()
            hay = text.lower()
            hay_n = re.sub(r"[^a-z0-9]+", "", hay)
            fuzzy_match = bool(
                label_l
                and hay
                and (
                    label_l in hay
                    or hay in label_l
                    or (label_n and hay_n and (label_n in hay_n or hay_n in label_n))
                )
            )
            if fuzzy_match:
                if selector and selector not in selectors:
                    selectors.append(selector[:220])
                if text and text not in texts:
                    texts.append(text[:120])
            if len(selectors) >= 8 and len(texts) >= 8:
                break
        visible_text = str(getattr(ctx, "visible_text", "") or "").strip()
        visible_text_l = visible_text.lower()
        visible_text_n = re.sub(r"[^a-z0-9]+", "", visible_text_l)
        if (
            not texts
            and label_l
            and (
                label_l in visible_text_l
                or (label_n and label_n in visible_text_n)
            )
        ):
            texts.append(label[:120])
        return {"selectors": selectors, "texts": texts}

    @staticmethod
    def _looks_like_dom_selector(candidate: str) -> bool:
        value = candidate.strip()
        if not value:
            return False
        if value.startswith("/") or value.startswith("("):
            return True
        if re.fullmatch(r"[0-9\s,._-]+", value):
            return False
        if re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]*", value):
            return True
        return bool(re.search(r"[#\[\]>\+~:]", value)) or ("." in value and bool(re.search(r"[a-zA-Z]", value)))

    @staticmethod
    def _selector_chain_has_shadow_host(step: dict[str, Any], host_fragment: str) -> bool:
        return selector_chain_has_shadow_host(step, host_fragment)

    @staticmethod
    def _selector_chain_texts(step: dict[str, Any]) -> list[str]:
        return selector_chain_texts(step)

    @classmethod
    def _build_linkedin_site_command(
        cls,
        step: dict[str, Any],
        ctx: Any,
    ) -> AgentCommand | None:
        return LinkedInSiteAdapter().compile_command(step, ctx)

    def _build_js_click_fallback_command(
        self, step: dict[str, Any], ctx: Any,
    ) -> AgentCommand | None:
        if not isinstance(step, dict):
            return None
        action_type = str(step.get("action_type") or "").lower()
        if action_type not in {"click", "select"}:
            return None
        label = self._extract_click_label(step)
        if not label:
            return None
        selector_chain = step.get("selector_chain") or []
        raw_candidates: list[str] = []
        shadow_selectors: list[dict] = []
        if isinstance(selector_chain, list):
            for sel in selector_chain:
                if not isinstance(sel, dict):
                    continue
                value = sel.get("value")
                if not isinstance(value, str) or not value.strip():
                    continue
                # shadow_css selectors are JSON {host_chain, target}; they are
                # piercing-aware and must NOT be dropped into the raw CSS bucket.
                if sel.get("type") == "shadow_css":
                    try:
                        import json as _json
                        parsed = _json.loads(value)
                        if (
                            isinstance(parsed, dict)
                            and isinstance(parsed.get("host_chain"), list)
                            and isinstance(parsed.get("target"), str)
                        ):
                            shadow_selectors.append({
                                "hostChain": [str(h) for h in parsed["host_chain"] if isinstance(h, str)],
                                "target": parsed["target"],
                            })
                    except Exception:
                        pass
                    continue
                raw_candidates.append(value.strip()[:220])
        page_candidates = self._analyze_click_candidates_from_page_content(ctx, label)
        for candidate in page_candidates["selectors"]:
            if candidate not in raw_candidates:
                raw_candidates.append(candidate)
        selector_candidates: list[str] = []
        text_candidates: list[str] = [label]
        # Extract anchor points (offset-from-anchor-element coordinates) so
        # JS_CLICK_HARNESS can use document.elementFromPoint() as a precise
        # fallback when CSS/text matching fails (e.g. generic "#interop-outlet").
        anchor_points: list[dict] = []
        for sel in selector_chain:
            if not isinstance(sel, dict):
                continue
            if sel.get("type") == "anchor":
                try:
                    import json as _json
                    anchor_data = _json.loads(sel.get("value", "{}"))
                    if isinstance(anchor_data, dict) and "anchor_selector" in anchor_data:
                        anchor_points.append({
                            "anchorSelector": anchor_data["anchor_selector"],
                            "offsetX": int(anchor_data.get("offset_x", 0)),
                            "offsetY": int(anchor_data.get("offset_y", 0)),
                        })
                except Exception:
                    pass
        for candidate in raw_candidates:
            if self._looks_like_dom_selector(candidate):
                if candidate not in selector_candidates:
                    selector_candidates.append(candidate)
                continue
            if candidate not in text_candidates:
                text_candidates.append(candidate)
        for candidate in page_candidates["texts"]:
            if candidate not in text_candidates:
                text_candidates.append(candidate)
        script = """
const label = String((args && args.label) || "").trim();
const labelLower = label.toLowerCase();
const selectors = Array.isArray(args?.selectorCandidates) ? args.selectorCandidates : [];
const shadowSelectors = Array.isArray(args?.shadowSelectors) ? args.shadowSelectors : [];
const textCandidates = Array.isArray(args?.textCandidates) ? args.textCandidates.map((t) => String(t).trim()).filter(Boolean) : [];
if (label) textCandidates.unshift(label);
const normalizeToken = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
// Shadow-DOM-piercing query: queries the given root, then recurses into
// every shadow root in the subtree. Needed for LinkedIn-style overlays.
const deepQuerySelector = (selector, root) => {
  root = root || document;
  try {
    const direct = root.querySelector(selector);
    if (direct) return direct;
  } catch (e) { return null; }
  const all = root.querySelectorAll("*");
  for (const node of all) {
    const sr = node.shadowRoot;
    if (sr) {
      const found = deepQuerySelector(selector, sr);
      if (found) return found;
    }
  }
  return null;
};
const deepQuerySelectorAll = (selector, root) => {
  root = root || document;
  const out = [];
  try { out.push(...root.querySelectorAll(selector)); } catch (e) { return out; }
  const all = root.querySelectorAll("*");
  for (const node of all) {
    const sr = node.shadowRoot;
    if (sr) out.push(...deepQuerySelectorAll(selector, sr));
  }
  return out;
};
// Resolve a shadow_css entry by walking host_chain through shadowRoot.querySelector.
const resolveShadowSelector = (entry) => {
  if (!entry || !entry.target) return null;
  const hostChain = Array.isArray(entry.hostChain) ? entry.hostChain : [];
  let root = document;
  for (const hostSel of hostChain) {
    let host = null;
    try { host = root.querySelector(hostSel); } catch (e) { /* invalid */ }
    if (!host) host = deepQuerySelector(hostSel, root);
    if (!host) return null;
    const sr = host.shadowRoot;
    root = sr || host;
  }
  let found = null;
  try { found = root.querySelector(entry.target); } catch (e) { /* invalid */ }
  if (!found) found = deepQuerySelector(entry.target, root);
  return found;
};
const isVisible = (el) => {
  if (!el || !(el instanceof Element)) return false;
  const s = window.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return s && s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
};
const isDisabled = (el) => {
  if (!el || !(el instanceof Element)) return false;
  if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    return !!el.disabled;
  }
  return el.getAttribute("aria-disabled") === "true";
};
const textFor = (el) => (
  (el.getAttribute("aria-label") || "") + " " +
  (el.getAttribute("title") || "") + " " +
  (el.getAttribute("data-testid") || "") + " " +
  ("value" in el ? String(el.value || "") : "") + " " +
  (el.textContent || "")
).replace(/\\s+/g, " ").trim();
const seemsInteractive = (el) => {
  if (!el || !(el instanceof Element)) return false;
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (el.matches("button, a, [role='button'], input[type='button'], input[type='submit'], input[type='radio'], input[type='checkbox'], summary, label")) return true;
  if (role === "button" || role === "link" || role === "tab" || role === "option") return true;
  if (el.hasAttribute("onclick") || el.hasAttribute("data-action")) return true;
  if (el.hasAttribute("tabindex") && Number(el.getAttribute("tabindex") || "0") >= 0) return true;
  const cls = `${el.className || ""} ${(el.getAttribute("data-testid") || "")}`.toLowerCase();
  if (cls.includes("btn") || cls.includes("button") || cls.includes("click")) return true;
  try {
    const cursor = window.getComputedStyle(el).cursor;
    if (cursor === "pointer") return true;
  } catch {}
  return false;
};
const bestActionableTarget = (node) => {
  if (!node || !(node instanceof Element)) return null;
  let current = node;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (isVisible(current) && !isDisabled(current) && seemsInteractive(current)) return current;
    current = current.parentElement;
  }
  current = node;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (isVisible(current) && !isDisabled(current)) return current;
    current = current.parentElement;
  }
  return null;
};
const matchesNeedle = (text, needle) => {
  const hay = String(text || "").toLowerCase();
  const needleL = String(needle || "").toLowerCase().trim();
  if (!needleL || !hay) return false;
  if (hay.includes(needleL) || needleL.includes(hay)) return true;
  const hayN = normalizeToken(hay);
  const needleN = normalizeToken(needleL);
  if (!hayN || !needleN) return false;
  return hayN.includes(needleN) || needleN.includes(hayN);
};
const score = (el) => {
  if (!isVisible(el) || isDisabled(el)) return -1;
  const t = textFor(el);
  const tLower = t.toLowerCase();
  const tNorm = normalizeToken(tLower);
  const labelNorm = normalizeToken(labelLower);
  const needleHit = textCandidates.some((needle) => matchesNeedle(t, needle));
  if (!needleHit) return -1;
  let s = 0;
  if (labelLower && tLower === labelLower) s += 120;
  if (labelNorm && tNorm && tNorm === labelNorm) s += 120;
  if (labelLower && tLower.includes(labelLower)) s += 70;
  if (labelNorm && tNorm.includes(labelNorm)) s += 65;
  if (textCandidates.some((needle) => {
    const nL = String(needle || "").toLowerCase().trim();
    const nN = normalizeToken(nL);
    return (nL && tLower.includes(nL)) || (nN && tNorm.includes(nN));
  })) s += 35;
  if (seemsInteractive(el)) s += 12;
  if (bestActionableTarget(el)) s += 8;
  return s;
};
const clickNode = (el, reason) => {
  const target = bestActionableTarget(el) || (el instanceof Element ? el : null);
  if (!target || !isVisible(target) || isDisabled(target)) return null;
  try { target.scrollIntoView({ block: "center", inline: "center" }); } catch {}
  try { target.focus?.({ preventScroll: true }); } catch {}
  try { target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", isPrimary: true, button: 0 })); } catch {}
  try { target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true, button: 0 })); } catch {}
  try { target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", isPrimary: true, button: 0 })); } catch {}
  try { target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, button: 0 })); } catch {}
  try { target.click(); } catch {}
  try { target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0 })); } catch {}
  return {
    clicked: true,
    reason,
    tag: target.tagName,
    text: textFor(target).slice(0, 160),
    originTag: el instanceof Element ? el.tagName : null,
  };
};
// 1) Shadow-piercing selectors recorded as shadow_css. Walk host_chain.
for (const entry of shadowSelectors) {
  try {
    const node = resolveShadowSelector(entry);
    const clicked = clickNode(node, "selector_shadow_css");
    if (clicked) return clicked;
  } catch {}
}
// 2) Plain selectors. Light DOM first, then pierce shadow roots if needed.
for (const candidate of selectors) {
  if (typeof candidate !== "string" || !candidate) continue;
  try {
    if (candidate.startsWith("/") || candidate.startsWith("(")) {
      const node = document.evaluate(candidate, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      const clicked = clickNode(node, "selector_xpath");
      if (clicked) return clicked;
      continue;
    }
    let node = document.querySelector(candidate);
    if (!node) node = deepQuerySelector(candidate);
    const clicked = clickNode(node, "selector_css");
    if (clicked) return clicked;
  } catch {}
}
const nodes = deepQuerySelectorAll("button,a,[role='button'],input,textarea,select,summary,label,[aria-label],[data-testid],[onclick],[tabindex],span,div,p,li,strong,b");
let best = null;
let bestScore = -1;
for (const el of nodes) {
  const s = score(el);
  if (s > bestScore) { bestScore = s; best = el; }
}
if (best && bestScore >= 18) {
  const clicked = clickNode(best, "text_rank");
  if (clicked) return { ...clicked, score: bestScore };
}
throw new Error(`JS_CLICK_FALLBACK_NO_TARGET:${label}`);
""".strip()
        return AgentCommand(
            action=CommandAction.RUN_SCRIPT,
            intent=f"click target via JS fallback: {label}",
            script=script,
            script_args={
                "__harness": "js_click",
                "label": label,
                "selectorCandidates": selector_candidates,
                "shadowSelectors": shadow_selectors,
                "textCandidates": text_candidates,
                "anchorPoints": anchor_points,
            },
            script_timeout_ms=5000,
            timeout_ms=15000,
            success_condition=(
                step.get("success_condition")
                if isinstance(step.get("success_condition"), dict)
                else None
            ),
        )

    @staticmethod
    def _build_js_type_fallback_command(
        step: dict[str, Any],
    ) -> "AgentCommand | None":
        """Deterministic TYPE fallback — mirrors js_click for input fields.

        Runs a browser-side script that inspects the live DOM to find the
        right input element (by placeholder, aria-label, role, or proximity
        to the previously-clicked element) and types the recorded value into
        it.  Works on both native inputs/textareas and contenteditable divs.
        """
        if not isinstance(step, dict):
            return None
        if str(step.get("action_type") or "").lower() != "type":
            return None
        value = step.get("value")
        if not isinstance(value, str):
            return None

        # Pull semantic hints out of the recorded intent so the script can
        # search the live DOM for the right element without needing selectors.
        intent = str(step.get("intent") or "")
        import re as _re
        ph_match = _re.search(r'placeholder\s*["\']([^"\']+)["\']', intent, _re.IGNORECASE)
        if not ph_match:
            ph_match = _re.search(r'\(placeholder\s+([^)]+)\)', intent, _re.IGNORECASE)
        placeholder_hint = ph_match.group(1).strip() if ph_match else ""

        aria_match = _re.search(r'(?:labeled?|aria[-\s]label)\s*["\']([^"\']+)["\']', intent, _re.IGNORECASE)
        aria_hint = aria_match.group(1).strip() if aria_match else ""

        field_match = _re.search(r'into\s+(\S+)\s+field', intent, _re.IGNORECASE)
        field_hint = field_match.group(1).strip() if field_match else ""

        # Pull CSS candidates from the selector_chain for a direct-selector attempt.
        css_candidates: list[str] = []
        type_shadow_selectors: list[dict] = []
        for sel in (step.get("selector_chain") or []):
            if not isinstance(sel, dict):
                continue
            v = str(sel.get("value") or "").strip()
            if not v:
                continue
            if sel.get("type") == "css":
                css_candidates.append(v[:220])
            elif sel.get("type") == "shadow_css":
                try:
                    import json as _json
                    parsed = _json.loads(v)
                    if (
                        isinstance(parsed, dict)
                        and isinstance(parsed.get("host_chain"), list)
                        and isinstance(parsed.get("target"), str)
                    ):
                        type_shadow_selectors.append({
                            "hostChain": [str(h) for h in parsed["host_chain"] if isinstance(h, str)],
                            "target": parsed["target"],
                        })
                except Exception:
                    pass

        script = r"""
const value        = String((args && args.value)           || "");
const phHint       = String((args && args.placeholderHint) || "").toLowerCase().trim();
const ariaHint     = String((args && args.ariaHint)        || "").toLowerCase().trim();
const fieldHint    = String((args && args.fieldHint)       || "").toLowerCase().trim();
const cssCandidates = Array.isArray(args && args.cssCandidates) ? args.cssCandidates : [];
const shadowSelectors = Array.isArray(args && args.shadowSelectors) ? args.shadowSelectors : [];

// Shadow-DOM-piercing query helpers.
const deepQuerySelector = (selector, root) => {
  root = root || document;
  try { const d = root.querySelector(selector); if (d) return d; } catch { return null; }
  const all = root.querySelectorAll("*");
  for (const node of all) {
    const sr = node.shadowRoot;
    if (sr) { const f = deepQuerySelector(selector, sr); if (f) return f; }
  }
  return null;
};
const deepQuerySelectorAll = (selector, root) => {
  root = root || document;
  const out = [];
  try { out.push(...root.querySelectorAll(selector)); } catch { return out; }
  const all = root.querySelectorAll("*");
  for (const node of all) {
    const sr = node.shadowRoot;
    if (sr) out.push(...deepQuerySelectorAll(selector, sr));
  }
  return out;
};
const resolveShadowSelector = (entry) => {
  if (!entry || !entry.target) return null;
  const hostChain = Array.isArray(entry.hostChain) ? entry.hostChain : [];
  let root = document;
  for (const hostSel of hostChain) {
    let host = null;
    try { host = root.querySelector(hostSel); } catch {}
    if (!host) host = deepQuerySelector(hostSel, root);
    if (!host) return null;
    root = host.shadowRoot || host;
  }
  let f = null;
  try { f = root.querySelector(entry.target); } catch {}
  return f || deepQuerySelector(entry.target, root);
};

const isVisible = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const s = window.getComputedStyle(el);
  return r.width > 0 && r.height > 0 &&
         s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
};
const isTypable = (el) =>
  el instanceof HTMLInputElement   ||
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLElement && el.isContentEditable);

// 0. Shadow_css selectors — pierce shadow DOM with the recorded host chain.
for (const entry of shadowSelectors) {
  try {
    const el = resolveShadowSelector(entry);
    if (el && isVisible(el) && isTypable(el)) { doType(el); return { success: true, via: "shadow_css" }; }
  } catch {}
}

// 1. Try stored CSS selectors first (light DOM, then pierce shadow if needed).
for (const css of cssCandidates) {
  try {
    let el = document.querySelector(css);
    if (!el) el = deepQuerySelector(css);
    if (el && isVisible(el) && isTypable(el)) { doType(el); return { success: true, via: "css", selector: css }; }
  } catch {}
}

// 2. Gather all visible, typable elements (deep query so shadow internals count).
const candidates = deepQuerySelectorAll(
  "input[type='text'], input[type='search'], input[type='email'], input[type='url'], " +
  "input:not([type]), textarea, [role='textbox'], [role='searchbox'], [contenteditable='true']"
).filter(el => isVisible(el) && isTypable(el));

const normalize = (s) => String(s || "").toLowerCase().trim();
const score = (el) => {
  let s = 0;
  const ph = normalize(el.getAttribute("placeholder"));
  const al = normalize(el.getAttribute("aria-label"));
  const nm = normalize(el.getAttribute("name"));
  if (phHint   && (ph.includes(phHint)   || phHint.includes(ph)))   s += 100;
  if (ariaHint && (al.includes(ariaHint) || ariaHint.includes(al))) s += 90;
  if (fieldHint && (nm.includes(fieldHint) || ph.includes(fieldHint) || al.includes(fieldHint))) s += 60;
  // Prefer focused element — it was just clicked by the previous step.
  if (el === document.activeElement) s += 40;
  return s;
};

let best = null, bestScore = -1;
for (const el of candidates) {
  const s = score(el);
  if (s > bestScore) { bestScore = s; best = el; }
}

// 3. Last resort: the focused element or the first visible typable element.
if (!best || bestScore <= 0) {
  if (document.activeElement && isTypable(document.activeElement) && isVisible(document.activeElement)) {
    best = document.activeElement;
  } else if (candidates.length > 0) {
    best = candidates[0];
  }
}

if (!best) throw new Error("JS_TYPE_FALLBACK_NO_TARGET");

doType(best);
return { success: true, via: "js_type", score: bestScore, tag: best.tagName,
         placeholder: best.getAttribute("placeholder"), ariaLabel: best.getAttribute("aria-label") };

function doType(el) {
  el.focus();
  if (el.isContentEditable) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel && sel.removeAllRanges();
    sel && sel.addRange(range);
    const ok = document.execCommand("insertText", false, value);
    if (!ok) el.textContent = value;
  } else {
    const proto = el instanceof HTMLInputElement
      ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter ? setter.call(el, value) : (el.value = value);
  }
  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
""".strip()

        return AgentCommand(
            action=CommandAction.RUN_SCRIPT,
            intent=f"type '{value}' via JS fallback (placeholder='{placeholder_hint}')",
            script=script,
            script_args={
                "__harness": "js_type",
                "value": value,
                "placeholderHint": placeholder_hint,
                "ariaHint": aria_hint,
                "fieldHint": field_hint,
                "cssCandidates": css_candidates,
                "shadowSelectors": type_shadow_selectors,
            },
            script_timeout_ms=5000,
            timeout_ms=15000,
            success_condition=(
                step.get("success_condition")
                if isinstance(step.get("success_condition"), dict)
                else None
            ),
        )

    async def _handle_wait_decision(
        self,
        run: ExecutionRun,
        step_index: int,
        ai_decision: dict[str, Any],
        ctx: Any,
    ) -> PollResponse:
        run_id = str(run.id)
        terminal = await self._terminal_response_if_needed(
            run, fallback_step_index=step_index,
        )
        if terminal:
            return terminal
        step_key = (run_id, step_index)
        step_waits = _run_step_wait_count.get(step_key, 0)
        total_waits = _run_total_waits.get(run_id, 0)
        if (
            step_waits >= SAFETY_LIMITS["max_consecutive_waits_per_step"]
            or total_waits >= SAFETY_LIMITS["max_total_waits_per_run"]
        ):
            return await self._autonomous_recovery_cycle(
                run=run,
                step_index=step_index,
                step=((run.workflow_snapshot or {}).get("steps", []) or [{}])[step_index]
                if step_index < len((run.workflow_snapshot or {}).get("steps", []) or [])
                else {},
                ctx=ctx,
                trigger="wait_limit_reached",
                prior_ai_decision=ai_decision,
            )
        wait_ms = int(ai_decision.get("wait_ms") or 1500)
        wait_ms = max(SAFETY_LIMITS["wait_min_ms"], min(wait_ms, SAFETY_LIMITS["wait_max_ms"]))
        _run_step_wait_count[step_key] = step_waits + 1
        _run_total_waits[run_id] = total_waits + 1
        await self._audit_decision(
            run_id,
            "WAIT",
            ai_decision.get("confidence", 0.45),
            ai_decision.get("reasoning", "Waiting for the page to settle"),
            extra_payload={"wait_ms": wait_ms, "wait_count": _run_step_wait_count[step_key]},
            step_index=step_index,
            thinking_steps=ai_decision.get("thinking_steps"),
            page_context=ctx,
            decision_context=ai_decision.get("decision_context"),
        )
        return PollResponse(
            decision="WAIT",
            confidence=ai_decision.get("confidence", 0.45),
            reasoning=ai_decision.get("reasoning", "Waiting for the page to settle"),
            next_step_index=step_index,
            wait_ms=wait_ms,
        )

    async def _handle_restart_decision(
        self,
        run: ExecutionRun,
        step_index: int,
        ai_decision: dict[str, Any],
        ctx: Any,
    ) -> PollResponse:
        run_id = str(run.id)
        terminal = await self._terminal_response_if_needed(
            run, fallback_step_index=step_index,
        )
        if terminal:
            return terminal
        restarts = _run_restart_count.get(run_id, 0)
        if restarts >= SAFETY_LIMITS["max_restarts_per_run"]:
            return await self._fallback_after_ai_failure(run, step_index, {}, ctx)
        _run_restart_count[run_id] = restarts + 1
        await self.execution.reset_to_start(run_id)
        restart_url = self._resolve_restart_url(run, step_index, ai_decision)
        if not restart_url:
            return await self._fallback_after_ai_failure(run, step_index, {}, ctx)

        command = AgentCommand(action=CommandAction.NAVIGATE, value=restart_url, target=restart_url)
        await self._audit_decision(
            run_id,
            "RESTART",
            ai_decision.get("confidence", 0.7),
            ai_decision.get("reasoning", "Restarting from the target URL"),
            command=command,
            step_index=step_index,
            thinking_steps=ai_decision.get("thinking_steps"),
            page_context=ctx,
            decision_context=ai_decision.get("decision_context"),
        )
        return PollResponse(
            decision="RESTART",
            confidence=ai_decision.get("confidence", 0.7),
            reasoning=ai_decision.get("reasoning", "Restarting from the target URL"),
            command=command,
            next_step_index=0,
        )

    def _resolve_restart_url(
        self,
        run: ExecutionRun,
        step_index: int,
        ai_decision: dict[str, Any],
    ) -> str | None:
        """Pick a restart URL that follows the recorded workflow blueprint.

        Priority:
        1) current step navigate URL (if any)
        2) first recorded navigate URL
        3) AI-proposed restart command URL
        4) workflow.target_url metadata
        """
        snapshot = run.workflow_snapshot or {}
        steps = snapshot.get("steps", []) or []

        if 0 <= step_index < len(steps):
            current = steps[step_index] or {}
            if current.get("action_type") == "navigate":
                current_url = self._resolve_step_navigate_url(current)
                if current_url:
                    return current_url

        for step in steps:
            if not isinstance(step, dict):
                continue
            if step.get("action_type") != "navigate":
                continue
            value = self._resolve_step_navigate_url(step)
            if value:
                return value

        ai_command = ai_decision.get("command")
        if isinstance(ai_command, dict):
            ai_value = ai_command.get("value") or ai_command.get("target")
            if _is_http_url(ai_value):
                return str(ai_value)

        target_url = ((snapshot.get("workflow") or {}).get("target_url"))
        if _is_http_url(target_url):
            return str(target_url)
        return None

    async def _handle_rollback_decision(
        self,
        run: ExecutionRun,
        step_index: int,
        ai_decision: dict[str, Any],
        ctx: Any,
    ) -> PollResponse:
        run_id = str(run.id)
        terminal = await self._terminal_response_if_needed(
            run, fallback_step_index=step_index,
        )
        if terminal:
            return terminal
        rollbacks = _run_rollback_count.get(run_id, 0)
        if rollbacks >= SAFETY_LIMITS["max_rollbacks_per_run"]:
            return await self._fallback_after_ai_failure(run, step_index, {}, ctx)
        rollback_to = ai_decision.get("rollback_to")
        if not isinstance(rollback_to, int) or rollback_to >= step_index or rollback_to < 0:
            return await self._fallback_after_ai_failure(run, step_index, {}, ctx)
        snapshot = run.workflow_snapshot or {}
        steps = snapshot.get("steps", []) or []
        if rollback_to >= len(steps) or not bool(steps[rollback_to].get("checkpoint")):
            return await self._fallback_after_ai_failure(run, step_index, {}, ctx)
        checkpoint_url = await self._resolve_checkpoint_url(run, rollback_to)
        if not checkpoint_url:
            return await self._fallback_after_ai_failure(run, step_index, {}, ctx)
        run.current_step_index = rollback_to
        await self.session.flush()
        _run_rollback_count[run_id] = rollbacks + 1
        command = AgentCommand(
            action=CommandAction.NAVIGATE,
            value=checkpoint_url,
            target=checkpoint_url,
        )
        await self._audit_decision(
            run_id,
            "ROLLBACK",
            ai_decision.get("confidence", 0.7),
            ai_decision.get("reasoning", f"Rolling back to checkpoint {rollback_to}"),
            command=command,
            step_index=step_index,
            thinking_steps=ai_decision.get("thinking_steps"),
            page_context=ctx,
            decision_context=ai_decision.get("decision_context"),
        )
        return PollResponse(
            decision="ROLLBACK",
            confidence=ai_decision.get("confidence", 0.7),
            reasoning=ai_decision.get("reasoning", f"Rolling back to checkpoint {rollback_to}"),
            command=command,
            next_step_index=rollback_to,
            rollback_to=rollback_to,
        )

    @staticmethod
    def _resolve_step_navigate_url(step: dict[str, Any]) -> str | None:
        if not isinstance(step, dict):
            return None
        raw_value = step.get("value")
        if _is_http_url(raw_value):
            return str(raw_value)
        from_intent = _extract_first_http_url(step.get("intent"))
        if from_intent:
            return from_intent
        selector_chain = step.get("selector_chain") or []
        if isinstance(selector_chain, list):
            for selector in selector_chain:
                if not isinstance(selector, dict):
                    continue
                resolved = _extract_first_http_url(selector.get("value"))
                if resolved:
                    return resolved
        return None

    async def _resolve_checkpoint_url(self, run: ExecutionRun, target_step_index: int) -> str | None:
        result = await self.session.execute(
            select(EventLog)
            .where(EventLog.run_id == run.id)
            .where(EventLog.event_type.in_(["checkpoint", "step_executed"]))
            .order_by(EventLog.sequence_number.desc())
        )
        for ev in result.scalars().all():
            payload = ev.payload or {}
            if int(payload.get("step_index", -1)) != target_step_index:
                continue
            if payload.get("success") is False:
                continue
            if payload.get("page_url"):
                return str(payload.get("page_url"))
            if ev.page_url:
                return ev.page_url
        workflow = (run.workflow_snapshot or {}).get("workflow") or {}
        return workflow.get("target_url")

    async def _maybe_persist_plan_mutations(self, run: ExecutionRun) -> None:
        """After a COMPLETED run, persist high-confidence AI plan_updates back to the
        canonical workflow so future runs start with improved selectors.

        Only MODIFY operations are persisted (not ADD/REMOVE which need human review).
        Gates: run must be COMPLETED, confidence >= 0.85, mutated step must have
        succeeded at least once in this run after the mutation.
        """
        try:
            workflow_id_str = str((run.workflow_snapshot or {}).get("workflow", {}).get("id") or "")
            if not workflow_id_str:
                return

            # Load all agent_decision events that included plan_updates.
            events_result = await self.session.execute(
                select(EventLog)
                .where(EventLog.run_id == run.id)
                .where(EventLog.event_type == "agent_decision")
                .order_by(EventLog.sequence_number.asc())
            )
            events = events_result.scalars().all()

            # Collect MODIFY mutations with confidence and their affected step_index.
            candidate_mutations: list[dict[str, Any]] = []
            for ev in events:
                payload = ev.payload or {}
                updates = payload.get("plan_updates") or []
                confidence = float(payload.get("confidence", 0.0))
                if confidence < 0.85:
                    continue
                for upd in updates:
                    if isinstance(upd, dict) and upd.get("operation") in ("MODIFY", "SIMPLIFY"):
                        candidate_mutations.append({
                            "step_index": int(upd.get("step_index", -1)),
                            "new_step": upd.get("new_step") or {},
                            "confidence": confidence,
                            "reason": upd.get("reason", ""),
                        })

            if not candidate_mutations:
                return

            # Verify each mutation: did the step succeed at least once AFTER the mutation?
            step_success_events = await self.session.execute(
                select(EventLog)
                .where(EventLog.run_id == run.id)
                .where(EventLog.event_type == "step_executed")
                .order_by(EventLog.sequence_number.asc())
            )
            successful_steps: set[int] = set()
            for ev in step_success_events.scalars().all():
                p = ev.payload or {}
                if p.get("success") and p.get("step_index") is not None:
                    successful_steps.add(int(p["step_index"]))

            # Apply validated mutations to the canonical WorkflowStep records.
            for mutation in candidate_mutations:
                step_idx = mutation["step_index"]
                if step_idx < 0 or step_idx not in successful_steps:
                    continue
                new_step = mutation["new_step"]
                new_selectors = new_step.get("selector_chain")
                if not new_selectors:
                    continue

                # Find the canonical WorkflowStep for this workflow + step_index.
                # workflow_id_str is stored as str in WorkflowStep; compare directly.
                ws_result = await self.session.execute(
                    select(WorkflowStep)
                    .where(WorkflowStep.workflow_id == workflow_id_str)
                    .where(WorkflowStep.step_index == step_idx)
                )
                ws = ws_result.scalar_one_or_none()
                if ws is None:
                    continue

                # Persist the improved selector chain.
                ws.selector_chain = new_selectors
                if new_step.get("value"):
                    ws.value = new_step["value"]

                await self.audit.append(AppendEvent(
                    event_type="workflow_evolved",
                    payload={
                        "step_index": step_idx,
                        "confidence": mutation["confidence"],
                        "reason": mutation["reason"],
                        "run_id": str(run.id),
                    },
                    run_id=str(run.id),
                ))
                logger.info(
                    "Persisted AI plan_update to workflow %s step %d (confidence=%.2f)",
                    workflow_id_str, step_idx, mutation["confidence"],
                )

            await self.session.flush()
        except Exception as exc:
            logger.debug("Could not persist plan mutations for run %s: %s", run.id, exc)

    async def _load_workflow_expertise(self, workflow_id: str, current_run_id: str) -> str | None:
        """Aggregate step outcomes from the last 5 completed/failed runs of this workflow.

        Returns a compact markdown block describing which steps are reliable vs.
        problem-prone, or None if there is no useful history yet.
        """
        try:
            # Find the last 5 terminal runs for this workflow (not the current run).
            # workflow_id is stored as str in ExecutionRun; compare directly.
            runs_result = await self.session.execute(
                select(ExecutionRun)
                .where(ExecutionRun.workflow_id == workflow_id)
                .where(ExecutionRun.id != to_uuid(current_run_id))
                .where(ExecutionRun.status.in_(["completed", "failed", "waiting_for_user"]))
                .order_by(ExecutionRun.created_at.desc())
                .limit(5)
            )
            prior_runs = runs_result.scalars().all()
            if not prior_runs:
                return None

            # For each prior run, aggregate step_executed events by step_index.
            step_stats: dict[int, dict[str, int]] = {}  # {step_index: {success, heal, fail}}
            total_runs = len(prior_runs)
            completed_runs = sum(1 for r in prior_runs if r.status == "completed")

            for run in prior_runs:
                events_result = await self.session.execute(
                    select(EventLog)
                    .where(EventLog.run_id == run.id)
                    .where(EventLog.event_type.in_(["step_executed", "selector_healed", "plan_update_applied"]))
                )
                for ev in events_result.scalars().all():
                    payload = ev.payload or {}
                    step_idx = payload.get("step_index")
                    if step_idx is None:
                        continue
                    step_idx = int(step_idx)
                    if step_idx not in step_stats:
                        step_stats[step_idx] = {"success": 0, "heal": 0, "fail": 0}
                    if ev.event_type == "step_executed":
                        if payload.get("success"):
                            step_stats[step_idx]["success"] += 1
                        else:
                            step_stats[step_idx]["fail"] += 1
                    elif ev.event_type in ("selector_healed", "plan_update_applied"):
                        step_stats[step_idx]["heal"] += 1

            if not step_stats:
                return None

            # Build a compact summary.
            problem_steps = [
                (idx, stats) for idx, stats in step_stats.items()
                if stats["heal"] + stats["fail"] > 0
            ]
            problem_steps.sort(key=lambda x: x[1]["heal"] + x[1]["fail"], reverse=True)

            lines = [
                f"## Workflow Expertise ({total_runs} prior runs; {completed_runs} reached COMPLETED)"
            ]
            if problem_steps:
                lines.append("Known problem steps (address proactively):")
                for idx, stats in problem_steps[:5]:
                    total = stats["success"] + stats["heal"] + stats["fail"]
                    heal_rate = int(round((stats["heal"] + stats["fail"]) / total * 100)) if total else 0
                    lines.append(
                        f"  • Step {idx}: needed healing/recovery {stats['heal'] + stats['fail']}/{total} "
                        f"times ({heal_rate}%) — prefer ADAPT or AI-assisted selectors upfront"
                    )
            reliable = [
                idx for idx, stats in step_stats.items()
                if stats["heal"] == 0 and stats["fail"] == 0 and stats["success"] >= 2
            ]
            if reliable:
                lines.append(f"Reliable steps (100% success): {sorted(reliable)}")
            return "\n".join(lines)
        except Exception:
            return None

    @staticmethod
    def _normalize_ai_decision(result: dict[str, Any]) -> dict[str, Any] | None:
        if not isinstance(result, dict):
            return None
        decision = str(result.get("decision", "EXECUTE")).upper()
        valid = {"EXECUTE", "ADAPT", "SKIP", "WAIT", "RESTART", "ROLLBACK", "PAUSE"}
        if decision not in valid:
            return None
        result["decision"] = decision
        return result

    async def _consult_ai_for_step(
        self,
        run: ExecutionRun,
        step_index: int,
        step: dict[str, Any],
        _original_command: AgentCommand,
        analysis: dict[str, Any],
        ctx: Any,
        recovery_mode: bool = False,
        recovery_reason: str | None = None,
        strategy_hint: str | None = None,
        prior_ai_decision: dict[str, Any] | None = None,
        screenshot_b64: str | None = None,
        screenshot_mime: str | None = None,
        screenshot_trigger: str | None = None,
    ) -> dict[str, Any] | None:
        if await self._is_run_terminal(str(run.id)):
            return None
        ai_api_key = settings.ai_api_key
        if not ai_api_key:
            return None

        # Workstream B (vision): validate and prepare in-flight screenshot data.
        # Bytes are passed to the provider and then DISCARDED. Only a small
        # metadata blob (sha256, dims, size, trigger, detail) is persisted in
        # the AIDecisionOutcome row.
        screenshot_meta: dict[str, Any] | None = None
        images_kwarg: list[dict[str, Any]] | None = None
        if (
            settings.vision_enabled
            and screenshot_b64
            and len(screenshot_b64) <= max(settings.vision_max_bytes, 1) * 2  # base64 is ~4/3 of bytes; loose upper bound
        ):
            try:
                raw_bytes = base64.b64decode(screenshot_b64, validate=False)
                if len(raw_bytes) > settings.vision_max_bytes:
                    logger.info(
                        "Dropping oversized screenshot (%d bytes > %d cap)",
                        len(raw_bytes),
                        settings.vision_max_bytes,
                    )
                else:
                    width, height = _peek_jpeg_dimensions(raw_bytes)
                    detail = (
                        "high"
                        if settings.vision_high_detail_on_failure and (
                            screenshot_trigger in {"post_failure", "blocking_modal"}
                        )
                        else "low"
                    )
                    screenshot_meta = {
                        "sha256": hashlib.sha256(raw_bytes).hexdigest(),
                        "width": width,
                        "height": height,
                        "mime": screenshot_mime or "image/jpeg",
                        "byte_size": len(raw_bytes),
                        "trigger": screenshot_trigger,
                        "detail": detail,
                    }
                    images_kwarg = [{
                        "b64": screenshot_b64,
                        "mime": screenshot_mime or "image/jpeg",
                        "detail": detail,
                    }]
            except (binascii.Error, ValueError) as exc:
                logger.warning("Invalid screenshot_b64: %s", exc)
                screenshot_meta = None
                images_kwarg = None

        selector_chain = step.get("selector_chain", [])
        visible_elements = []
        if hasattr(ctx, "visible_elements") and ctx.visible_elements:
            visible_elements = ctx.visible_elements[:25]
        visible_text = getattr(ctx, "visible_text", "") or ""

        previous_failures = await self._load_previous_failures(run, step_index)
        run_memory = await self.ai_outcomes.load_run_memory(str(run.id))
        checkpoint_steps = [
            idx for idx, raw_step in enumerate((run.workflow_snapshot or {}).get("steps", []) or [])
            if bool(raw_step.get("checkpoint"))
        ]

        # Selector stability score: from learning service EMA stored in snapshot.
        # None means no history yet (new step); provide it to the prompt so the
        # AI can decide how aggressively to ADAPT before trying EXECUTE.
        step_stability: float | None = step.get("selector_stability_score")

        # Cross-run expertise: aggregate patterns from prior completed/failed runs.
        # Injects known-problem steps so the AI handles them proactively.
        workflow_id = str((run.workflow_snapshot or {}).get("workflow", {}).get("id") or "")
        workflow_expertise = await self._load_workflow_expertise(workflow_id, str(run.id)) if workflow_id else None
        page_signals = self._build_ai_page_signals(ctx, step)

        # Surrounding steps window (±2): gives the AI causal and sequence context
        # so it can decide on skips, delays, and find-element strategies.
        snapshot_steps: list[dict[str, Any]] = (run.workflow_snapshot or {}).get("steps", []) or []
        surrounding_steps: list[dict[str, Any]] = []
        window_start = max(0, step_index - 2)
        window_end = min(len(snapshot_steps), step_index + 3)
        for win_i in range(window_start, window_end):
            s = snapshot_steps[win_i]
            meta = s.get("accessibility_metadata") or {}
            surrounding_steps.append({
                "step_index": win_i,
                "action_type": s.get("action_type", ""),
                "intent": s.get("intent") or "",
                "value": s.get("value"),
                "caused_url_change": bool(meta.get("caused_url_change", False)),
                "time_since_previous_ms": meta.get("time_since_previous_ms"),
                "context_url_before": meta.get("context_url_before"),
            })

        prompt = build_agent_decision_prompt(
            workflow_goal=analysis.get("workflow_goal"),
            workflow_summary=analysis.get("workflow_summary"),
            current_phase=self._get_current_phase(analysis, step_index),
            step_index=step_index,
            step_intent=step.get("intent"),
            step_action=step.get("action_type", "click"),
            step_selectors=selector_chain,
            step_value=step.get("value"),
            page_url=getattr(ctx, "url", "") or "",
            page_title=getattr(ctx, "title", "") or "",
            visible_text=visible_text[:1500],
            visible_elements=visible_elements,
            previous_failures=previous_failures,
            page_diff=getattr(ctx, "page_diff", None),
            goal_progress=run.goal_progress,
            run_memory=run_memory,
            checkpoint_steps=checkpoint_steps,
            step_stability_score=step_stability,
            workflow_expertise=workflow_expertise,
            has_screenshot=bool(images_kwarg),
            surrounding_steps=surrounding_steps or None,
        )
        prompt += (
            "\n\n## Actionable Page Signals\n"
            "Use these ranked candidates/deltas to converge quickly and avoid fragile selectors.\n"
            f"{json.dumps(page_signals, ensure_ascii=True)[:3000]}"
        )
        if recovery_mode:
            prompt += (
                "\n\n## Recovery Mode (non-blocking)\n"
                "You are in an autonomous recovery cycle. You MUST provide a concrete next action now. "
                "Do not PAUSE unless there is explicit blocking evidence (captcha/login/2FA/unexpected modal). "
                "If WAIT is absolutely needed, keep it short and explain exactly what signal is expected next."
            )
            if recovery_reason:
                prompt += f"\nRecovery trigger: {recovery_reason}"
            if strategy_hint:
                prompt += f"\nPreferred strategy for this cycle: {strategy_hint}"
            if prior_ai_decision:
                prompt += f"\nPrevious failed decision context: {json.dumps(prior_ai_decision)[:1400]}"

        # Workstream C: tool-use loop. The model emits one or more tool_calls
        # per turn; the dispatcher translates them back into the legacy
        # ai_decision dict so the rest of poll() works unchanged.
        provider = get_ai_provider(api_key_override=ai_api_key)
        messages = load_conversation(run)
        messages = append_user_turn(messages, prompt)

        _ai_start = time.monotonic()
        result: dict[str, Any] | None = None
        loop_exhaust_reason: str | None = None
        inner_max = max(2, int(SAFETY_LIMITS.get("max_ai_attempts_per_poll", 3)))
        for attempt in range(1, inner_max + 1):
            if await self._is_run_terminal(str(run.id)):
                return None
            try:
                tool_resp = await provider.generate_with_tools(
                    messages=messages,
                    tools=ALL_TOOLS,
                    system=AGENT_TOOL_USE_SYSTEM,
                    max_tokens=2048,
                    images=images_kwarg if attempt == 1 else None,
                )
            except Exception as exc:
                logger.warning("generate_with_tools failed on attempt %s: %s", attempt, exc)
                break

            # Persist the assistant turn (text + tool_calls) before deciding.
            messages = append_assistant_turn(
                messages, tool_resp.content, tool_resp.tool_calls,
            )

            translated = translate_tool_calls(
                tool_resp.tool_calls, recorded_step=step,
            )

            # PLAN_ONLY: model only asked for plan changes. Apply them, feed
            # back a tool_result acknowledging, and iterate to get an action.
            if translated and translated.get("decision") == "PLAN_ONLY":
                applied = await self._apply_plan_updates_from_ai(
                    run, translated.get("plan_updates"),
                )
                # Mirror the assistant's update_plan tool_call in tool_result
                for tc in tool_resp.tool_calls:
                    if tc.name == "update_plan":
                        messages = append_tool_result(
                            messages, tc.id,
                            {"ok": True, "applied": len(applied)},
                        )
                loop_exhaust_reason = "tool_loop_plan_only_exhausted"
                continue

            if not translated:
                # Empty turn or unmappable tool — give the model one more
                # chance by appending a nudge tool_result and iterating.
                loop_exhaust_reason = "tool_loop_invalid_or_unmappable"
                if attempt < inner_max:
                    messages.append({
                        "role": "user",
                        "content": "Your last turn did not call a valid tool. Call exactly one terminal tool now.",
                    })
                continue

            # PAUSE early-skip: if the model wants to pause but the page is
            # not actually blocking and we're not in recovery_mode, nudge it
            # to pick something else. This preserves the legacy guard.
            if (
                attempt < inner_max
                and translated.get("decision") == "PAUSE"
                and not getattr(ctx, "is_blocking", False)
                and not recovery_mode
            ):
                messages.append({
                    "role": "user",
                    "content": (
                        "PAUSE is reserved for blocking conditions (captcha/login/2FA/"
                        "unexpected modal). The page is not blocked. Pick a different "
                        "tool — wait, execute_action with adapted selectors, restart, or rollback."
                    ),
                })
                continue

            # Apply any plan_updates that came alongside the terminal tool.
            applied_updates = await self._apply_plan_updates_from_ai(
                run, translated.get("plan_updates"),
            )
            if applied_updates:
                translated["plan_updates"] = applied_updates

            result = translated
            result["thinking_steps"] = []  # tool-use replaces explicit reasoning chain
            result["prompt_summary"] = prompt[:500]
            result["latency_ms"] = int((time.monotonic() - _ai_start) * 1000)
            result["decision_context"] = {
                "attempt": attempt,
                "strategy": "tool_use",
                "stop_reason": tool_resp.stop_reason,
                "tokens_in": (tool_resp.usage or {}).get("prompt_tokens", 0),
                "tokens_out": (tool_resp.usage or {}).get("completion_tokens", 0),
            }
            if screenshot_meta:
                result["screenshot_meta"] = screenshot_meta
            # Bytes reference dropped so GC can reclaim promptly.
            images_kwarg = None
            break

        # Persist updated conversation (trimmed) for the next poll.
        save_conversation(run, messages)
        with contextlib.suppress(Exception):
            await self.session.flush()
        if result is None and loop_exhaust_reason:
            return {
                "decision": "WAIT",
                "confidence": 0.4,
                "reasoning": "AI tool loop produced no actionable terminal tool; using bounded fallback wait.",
                "wait_ms": 1200,
                "thinking_steps": [],
                "decision_context": {
                    "strategy": "tool_use",
                    "reason_code": loop_exhaust_reason,
                    "attempts": inner_max,
                },
            }
        return result

    @staticmethod
    def _canonical_plan_operation(operation: Any) -> str:
        op = str(operation or "").upper()
        alias = {
            "ADD": "INSERT",
            "INSERT": "INSERT",
            "SKIP": "REMOVE",
            "REMOVE": "REMOVE",
            "MODIFY": "MODIFY",
            "REORDER": "REORDER",
            "SIMPLIFY": "SIMPLIFY",
        }
        return alias.get(op, op)

    async def _apply_plan_updates_from_ai(
        self, run: ExecutionRun, raw: Any,
    ) -> list[dict[str, Any]]:
        """If the LLM returned `plan_updates`, validate and apply them to the
        run snapshot. Returns the list of successfully-applied ops (for the
        PollResponse and audit log)."""
        if not raw or not isinstance(raw, list):
            return []
        # Cap how many ops can be applied in a single decision to bound damage
        budget = SAFETY_LIMITS.get("max_plan_updates_per_run", 15)
        ops_to_apply: list[dict[str, Any]] = []
        for raw_op in raw[:budget]:
            if not isinstance(raw_op, dict):
                continue
            normalized = dict(raw_op)
            normalized["operation"] = self._canonical_plan_operation(
                normalized.get("operation"),
            )
            try:
                op = PlanUpdate(**normalized)
            except Exception as exc:
                logger.debug("Rejected invalid plan_update from LLM: %s (%s)", normalized, exc)
                continue
            ops_to_apply.append({
                "operation": self._canonical_plan_operation(op.operation.value),
                "step_index": op.step_index,
                "new_step": op.new_step,
                "reason": op.reason,
            })
        if not ops_to_apply:
            return []
        await self.healing.apply_plan_update(run, ops_to_apply)
        # Reload the run after the snapshot mutation
        await self.session.refresh(run)
        return ops_to_apply

    async def _load_previous_failures(
        self, run: ExecutionRun, current_step_index: int,
    ) -> list[dict[str, Any]] | None:
        """Read recent failed step events from the audit log to give the LLM
        context about what's been tried unsuccessfully on this run."""
        try:
            result = await self.session.execute(
                select(EventLog)
                .where(EventLog.run_id == run.id)
                .where(EventLog.event_type.in_(["step_executed", "recovery_failure"]))
                .order_by(EventLog.sequence_number.desc())
                .limit(20)
            )
            failures: list[dict[str, Any]] = []
            for ev in result.scalars().all():
                payload = ev.payload or {}
                if ev.event_type == "step_executed":
                    if payload.get("success") is False:
                        failures.append({
                            "step_index": payload.get("step_index"),
                            "action": payload.get("action_type"),
                            "error": payload.get("error") or "Step failed",
                        })
                elif ev.event_type == "recovery_failure":
                    failures.append({
                        "step_index": payload.get("step_index"),
                        "action": "recovery",
                        "error": payload.get("error") or "Recovery failed",
                    })
            failures.reverse()
            relevant = [f for f in failures if f.get("step_index") == current_step_index] or failures
            return relevant[-5:] if relevant else None
        except Exception as exc:
            logger.debug("Could not load previous failures for %s: %s", run.id, exc)
            return None

    def _get_current_phase(
        self, analysis: dict[str, Any], step_index: int,
    ) -> str | None:
        phases = analysis.get("phases", [])
        if not phases:
            return None
        for phase in phases:
            if phase.get("start_step", 0) <= step_index <= phase.get("end_step", 0):
                return phase.get("name")
        return None

    def _parse_adapted_command(self, command_data: dict[str, Any]) -> AgentCommand | None:
        if not command_data:
            return None
        try:
            action = self._map_action_type(command_data.get("action", "click"))
            selectors = command_data.get("selector_chain", [])
            if isinstance(selectors, list):
                selectors = [
                    s if isinstance(s, dict)
                    else {"type": "css", "value": str(s)}
                    for s in selectors
                ]
            return AgentCommand(
                action=action,
                target=command_data.get("value") or command_data.get("target"),
                value=command_data.get("value"),
                selector_chain=selectors,
                intent=command_data.get("intent"),
                methods=command_data.get("methods", []),
                timeout_ms=15000,
                pre_condition=None,
            )
        except Exception:
            return None

    async def report_result(self, run_id: str, req: ResultRequest) -> ResultResponse:
        run = await self._get_run(run_id)
        if run.status in TERMINAL_RUN_STATUSES:
            self._clear_recovery_state(run_id)
            return ResultResponse(
                accepted=False,
                decision="COMPLETED",
                next_step_index=run.current_step_index,
                should_poll=False,
            )
        if req.step_index != run.current_step_index:
            logger.warning(
                "Rejecting stale result for run %s: expected step %s, got %s",
                run_id,
                run.current_step_index,
                req.step_index,
            )
            return ResultResponse(
                accepted=False,
                next_step_index=run.current_step_index,
                should_poll=False,
            )

        if run.status in (RunStatus.RUNNING.value, RunStatus.RECOVERING.value):
            pass
        elif run.status != RunStatus.RUNNING.value:
            try:
                await self._transition_to_running(run)
            except Exception as e:
                logger.warning("Could not transition run %s to running: %s", run_id, e)

        # Phase 4: close the loop on the last unresolved decision for this step
        try:
            await self.ai_outcomes.resolve_latest(
                run_id, req.step_index,
                "success" if req.success else "failure",
            )
        except Exception as exc:
            logger.debug("ai_outcomes.resolve_latest skipped: %s", exc)

        # Workstream A: audit run_script executions. Triggered whenever the
        # extension reports back script outputs — success or failure. Never
        # stores the full script source; only a SHA-256 and a short preview.
        script_logged = (
            req.script_result is not None
            or (req.script_logs and len(req.script_logs) > 0)
            or req.script_duration_ms is not None
        )
        if script_logged:
            await self._audit_script_execution(run_id, req)

        if req.success:
            self._clear_script_failure_counts(run_id, req.step_index)
            self._clear_recovery_state(run_id)
            snapshot_steps = (run.workflow_snapshot or {}).get("steps", []) or []
            action_type = snapshot_steps[req.step_index].get("action_type") if req.step_index < len(snapshot_steps) else None
            if run.status != RunStatus.RUNNING.value:
                try:
                    await self._transition_to_running(run)
                    await self.session.refresh(run)
                except Exception as e:
                    logger.warning("Could not transition run %s to running: %s", run_id, e)
            run.pause_reason = None
            run.error_summary = None
            await self.session.flush()
            success_payload: dict = {
                "step_index": req.step_index,
                "action_type": action_type,
                "success": True,
                "page_url": getattr(req.page_context_after, "url", None),
            }
            if req.via_method_index is not None:
                success_payload["via_method_index"] = req.via_method_index
            await self.audit.append(AppendEvent(
                event_type="step_executed",
                payload=success_payload,
                run_id=run_id,
            ))
            await self._audit_decision(
                run_id, "EXECUTE", 0.99,
                f"Step {req.step_index} succeeded",
            )

            await self.execution.advance_step(run_id)
            await self.session.refresh(run)

            if await self._goal_predicate_satisfied(run, req.page_context_after):
                self._clear_recovery_state(run_id)
                with contextlib.suppress(Exception):
                    await self.execution.complete(run_id)
                with contextlib.suppress(Exception):
                    await self._maybe_persist_plan_mutations(run)
                return ResultResponse(
                    accepted=True,
                    decision="COMPLETED",
                    next_step_index=run.current_step_index,
                    should_poll=False,
                )

            if run.current_step_index >= run.total_steps:
                self._clear_recovery_state(run_id)
                with contextlib.suppress(Exception):
                    await self.execution.complete(run_id)
                with contextlib.suppress(Exception):
                    await self._maybe_persist_plan_mutations(run)
                return ResultResponse(
                    accepted=True,
                    decision="COMPLETED",
                    next_step_index=run.current_step_index,
                    should_poll=False,
                )

            return ResultResponse(
                accepted=True,
                next_step_index=run.current_step_index,
                should_poll=False,
            )

        # Save page state on failure for observability.
        if req.page_context_after is not None:
            with contextlib.suppress(Exception):
                await self.ai_outcomes.record_page_snapshot(
                    run_id, req.step_index, "on_failure", req.page_context_after,
                )
        error = req.error or "Step failed"
        snapshot_steps = (run.workflow_snapshot or {}).get("steps", []) or []
        action_type = snapshot_steps[req.step_index].get("action_type") if req.step_index < len(snapshot_steps) else None
        run.error_summary = error
        await self.audit.append(AppendEvent(
            event_type="step_executed",
            payload={
                "step_index": req.step_index,
                "action_type": action_type,
                "success": False,
                "error": error,
            },
            run_id=run_id,
        ))
        await self.audit.append(AppendEvent(
            event_type="recovery_failure",
            payload={
                "step_index": req.step_index,
                "error": error,
                "error_context": req.error_context,
            },
            run_id=run_id,
        ))
        await self.session.flush()

        script_failure_category = self._classify_script_failure(req.error)
        if script_failure_category == "fatal":
            with contextlib.suppress(Exception):
                await self.execution.fail(run_id, req.error or "fatal script error")
            self._clear_recovery_state(run_id)
            return ResultResponse(
                accepted=True,
                next_step_index=req.step_index,
                should_poll=False,
            )
        if script_failure_category:
            failure_count = self._record_script_failure(
                run_id, req.step_index, script_failure_category,
            )
            if (
                script_failure_category == "no-target"
                and failure_count >= int(SAFETY_LIMITS.get("max_script_no_target_repeats", 2))
            ):
                reason = "script_no_target_repeated"
                await self._audit_decision(
                    run_id,
                    "PAUSE",
                    0.82,
                    "run_script hit the same no-target error repeatedly on this step.",
                    pause_reason=reason,
                    step_index=req.step_index,
                    decision_context={
                        "reason_code": reason,
                        "script_failure_category": script_failure_category,
                        "repeat_count": failure_count,
                    },
                )
                with contextlib.suppress(Exception):
                    await self.execution.pause(run_id, reason=reason)
                return ResultResponse(
                    accepted=True,
                    decision="PAUSE",
                    next_step_index=req.step_index,
                    should_poll=True,
                )

        return ResultResponse(
            accepted=True,
            next_step_index=req.step_index,
            should_poll=True,
        )

    async def _goal_predicate_satisfied(
        self,
        run: ExecutionRun,
        page_context_after: Any | None,
    ) -> bool:
        snapshot = run.workflow_snapshot or {}
        analysis = snapshot.get("analysis") or {}
        predicate = analysis.get("goal_predicate") or {}
        if not isinstance(predicate, dict) or not predicate.get("type"):
            return False
        ptype = predicate.get("type")
        if ptype == "extract_count":
            minimum = int(predicate.get("min") or 1)
            return len(run.extracted_data or []) >= minimum
        if ptype == "url_matches":
            pattern = str(predicate.get("pattern") or "")
            url = getattr(page_context_after, "url", "") or ""
            return bool(pattern and re.search(pattern, url))
        if ptype == "element_visible":
            selector = str(predicate.get("selector") or "")
            visible_elements = getattr(page_context_after, "visible_elements", None) or []
            return bool(selector) and any(selector in str(el.get("selector", "")) for el in visible_elements)
        if ptype == "text_present":
            phrase = str(predicate.get("phrase") or "")
            visible_text = getattr(page_context_after, "visible_text", "") or ""
            return bool(phrase) and phrase.lower() in visible_text.lower()
        return False

    async def _last_chance_recovery(
        self,
        run: ExecutionRun,
        step_index: int,
        error: str,
        error_context: str | None,
        adapt_count: int,
    ) -> ResultResponse | None:
        """Final AI attempt to keep the run moving instead of pausing.

        Returns a ResultResponse to send back to the extension if the LLM
        produces an actionable plan; None to fall through to PAUSE.
        """
        if not settings.ai_api_key:
            return None
        run_id = str(run.id)
        analysis = await self._analyze_failure(
            run, step_index, error, error_context, last_chance=True,
        )
        if not analysis:
            return None

        # Skip if the AI says this step is no longer needed
        if analysis.get("should_skip"):
            _run_adapt_count[run_id] = adapt_count + 1
            _run_retries[run_id] = 0
            _run_heal_attempts[run_id] = 0
            try:
                await self.execution.transition(run_id, RunStatus.RUNNING)
            except Exception:
                pass
            await self._audit_decision(
                run_id, "SKIP", analysis.get("confidence", 0.6),
                f"Last-chance AI recommends SKIP for step {step_index}: "
                f"{analysis.get('analysis', '')[:160]}",
                extra_payload={"ai_analysis": analysis, "last_chance": True},
            )
            await self.execution.advance_step(run_id)
            await self.session.refresh(run)
            return ResultResponse(
                accepted=True,
                decision="SKIP",
                next_step_index=run.current_step_index,
                ai_analysis=analysis,
            )

        # Adapt if the AI suggested new selectors / a navigate / different action
        has_adaptation = bool(
            analysis.get("suggested_selectors")
            or (analysis.get("suggested_action") == "navigate" and analysis.get("suggested_value"))
        )
        if has_adaptation:
            _run_adapt_count[run_id] = adapt_count + 1
            _run_retries[run_id] = 0
            _run_heal_attempts[run_id] = 0
            try:
                await self.execution.transition(run_id, RunStatus.RECOVERING)
                await self.session.flush()
            except Exception:
                pass
            await self._audit_decision(
                run_id, "ADAPT", analysis.get("confidence", 0.7),
                f"Last-chance AI adaptation for step {step_index}: "
                f"{analysis.get('analysis', '')[:160]}",
                extra_payload={"ai_analysis": analysis, "last_chance": True},
            )
            return ResultResponse(
                accepted=True,
                decision="ADAPT",
                next_step_index=step_index,
                ai_analysis=analysis,
            )

        return None

    async def push_action(self, run_id: str, action: str) -> dict[str, Any]:
        _pending_actions[run_id] = action
        return {"accepted": True, "pending_action": action}

    async def get_decisions(self, run_id: str, limit: int = 100) -> list[dict[str, Any]]:
        uid = to_uuid(run_id)
        result = await self.session.execute(
            select(EventLog)
            .where(EventLog.run_id == uid)
            .where(EventLog.event_type == "agent_decision")
            .order_by(EventLog.sequence_number.desc())
            .limit(limit)
        )
        return [
            {
                "id": str(e.id),
                "payload": e.payload,
                "hash": e.hash,
                "created_at": e.created_at.isoformat(),
            }
            for e in result.scalars().all()
        ]

    def _build_command(self, step: dict[str, Any]) -> AgentCommand:
        action_type = step.get("action_type", "click")
        action = self._map_action_type(action_type)
        value = step.get("value")
        if action == CommandAction.NAVIGATE:
            value = self._resolve_step_navigate_url(step) or value
        # Give SPA pages 2 s to finish rendering before the extension tries to
        # locate a TYPE target.  This prevents premature ELEMENT_NOT_FOUND
        # failures on React/Vue apps where inputs mount asynchronously.
        delay_before_ms = 2000 if action_type == "type" else 0
        return AgentCommand(
            action=action,
            target=value,
            value=value,
            selector_chain=step.get("selector_chain") or [],
            intent=step.get("intent"),
            methods=step.get("methods") or [],
            timeout_ms=15000,
            success_condition=step.get("success_condition"),
            pre_condition=None,
            delay_before_ms=delay_before_ms,
        )

    @staticmethod
    def _map_action_type(action_type: str) -> CommandAction:
        mapping: dict[str, CommandAction] = {
            "navigate": CommandAction.NAVIGATE,
            "click": CommandAction.CLICK,
            "type": CommandAction.TYPE,
            "select": CommandAction.SELECT,
            "scroll": CommandAction.SCROLL,
            "extract": CommandAction.EXTRACT,
        }
        return mapping.get(action_type, CommandAction.CLICK)

    async def _get_run(self, run_id: str) -> ExecutionRun:
        uid = to_uuid(run_id)
        result = await self.session.execute(
            select(ExecutionRun).where(ExecutionRun.id == uid)
        )
        run = result.scalar_one_or_none()
        if not run:
            raise NotFoundError(f"Run {run_id} not found")
        return run

    async def _transition_to_running(self, run: ExecutionRun) -> None:
        current = RunStatus(run.status)
        if current == RunStatus.QUEUED:
            WorkflowStateMachine.transition(current, RunStatus.RUNNING)
            run.status = RunStatus.RUNNING.value
            if not run.started_at:
                run.started_at = datetime.now(UTC)
            await self.session.flush()
            await self.audit.append(
                AppendEvent(
                    event_type="run_running",
                    payload={"workflow_id": run.workflow_id},
                    run_id=str(run.id),
                )
            )
        elif current == RunStatus.RECOVERING:
            WorkflowStateMachine.transition(current, RunStatus.RUNNING)
            run.status = RunStatus.RUNNING.value
            await self.session.flush()
            await self.audit.append(
                AppendEvent(
                    event_type="run_running",
                    payload={"workflow_id": run.workflow_id, "recovered": True},
                    run_id=str(run.id),
                )
            )
        elif current == RunStatus.WAITING_FOR_USER:
            WorkflowStateMachine.transition(current, RunStatus.RUNNING)
            run.status = RunStatus.RUNNING.value
            await self.session.flush()
            await self.audit.append(
                AppendEvent(
                    event_type="run_running",
                    payload={"workflow_id": run.workflow_id, "resumed": True},
                    run_id=str(run.id),
                )
            )

    async def _audit_decision(
        self,
        run_id: str,
        decision: DecisionValue,
        confidence: float,
        reasoning: str,
        command: AgentCommand | None = None,
        pause_reason: str | None = None,
        extra_payload: dict[str, Any] | None = None,
        step_index: int | None = None,
        thinking_steps: list | None = None,
        page_context: Any | None = None,
        decision_context: dict | None = None,
        screenshot_meta: dict | None = None,
    ) -> bool:
        if await self._is_run_terminal(run_id):
            logger.info(
                "Skipping agent_decision audit for terminal run %s (%s)",
                run_id,
                decision,
            )
            return False
        payload: dict[str, Any] = {
            "decision": decision,
            "confidence": confidence,
            "reasoning": reasoning,
            "command": command.model_dump() if command else None,
            "pause_reason": pause_reason,
            "step_index": step_index,
            "decision_context": decision_context,
        }
        if extra_payload:
            payload.update(extra_payload)
        await self.audit.append(
            AppendEvent(
                event_type="agent_decision",
                payload=payload,
                run_id=run_id,
                actor_type="ai",
            )
        )

        # Phase 4: record per-decision telemetry for outcome correlation.
        # Best-effort: never let telemetry failures break a decision.
        try:
            effective_step = (
                step_index
                if step_index is not None
                else (extra_payload or {}).get("step_index", 0)
            )
            effective_step_int = int(effective_step or 0)
            model_name = settings.ai_model if settings.ai_api_key else "fast-path"
            await self.ai_outcomes.record_decision(
                run_id=run_id,
                step_index=effective_step_int,
                decision=decision,
                confidence=confidence,
                reasoning=reasoning,
                model=model_name,
                thinking_steps=thinking_steps,
                decision_context=decision_context,
                screenshot_meta=screenshot_meta,
            )
        except Exception as exc:
            logger.debug("ai_outcomes.record_decision skipped: %s", exc)

        # Record reasoning chain and page snapshot (observability).
        # Both are fail-open — any error is swallowed.
        with contextlib.suppress(Exception):
            effective_step_int = int(
                step_index if step_index is not None
                else (extra_payload or {}).get("step_index", 0) or 0
            )
            if thinking_steps is not None:
                await self.ai_outcomes.record_reasoning_chain(
                    run_id=run_id,
                    step_index=effective_step_int,
                    decision=decision,
                    thinking_steps=thinking_steps,
                    full_reasoning=reasoning,
                    invocation_type="step_decision",
                    model=settings.ai_model if settings.ai_api_key else "fast-path",
                )
        with contextlib.suppress(Exception):
            effective_step_int = int(
                step_index if step_index is not None
                else (extra_payload or {}).get("step_index", 0) or 0
            )
            if page_context is not None:
                await self.ai_outcomes.record_page_snapshot(
                    run_id=run_id,
                    step_index=effective_step_int,
                    trigger="before_step",
                    ctx=page_context,
                )
        return True

    async def _analyze_failure(
        self,
        run: ExecutionRun,
        step_index: int,
        error: str,
        error_context: str | None = None,
        last_chance: bool = False,
        trigger: str = "heal",
    ) -> dict[str, Any] | None:
        """Use AI to analyze why a step failed and suggest alternatives.

        The analyst can recommend:
        - new selectors for the same action
        - a different action altogether (e.g., navigate to a known URL
          instead of clicking a session-specific search result)
        - skipping the step if it's no longer needed
        """
        ai_api_key = settings.ai_api_key
        if not ai_api_key:
            return None

        snapshot = run.workflow_snapshot or {}
        steps = snapshot.get("steps", [])
        analysis = snapshot.get("analysis", {})
        if step_index >= len(steps):
            return None

        step = steps[step_index]
        # selector_chain may be None when the step was MODIFIED by an earlier
        # PlanUpdate to e.g. a navigate (no selectors needed). Treat as empty.
        selector_chain = step.get("selector_chain") or []
        old_selectors = [
            s.get("value", str(s)) if isinstance(s, dict) else str(s)
            for s in selector_chain
        ]
        intent = step.get("intent", f"Step {step_index}: {step.get('action_type', 'unknown')}")

        previous_failures = await self._load_previous_failures(run, step_index)

        context_parts = [
            f"Workflow goal: {analysis.get('workflow_goal') or '(unknown)'}",
            f"Step {step_index} ({step.get('action_type', 'unknown')}) failed.",
            f"Intent: {intent}",
            f"Error: {error}",
        ]
        if step.get("value"):
            context_parts.append(f"Recorded value: {step.get('value')}")
        if old_selectors:
            context_parts.append(f"Selectors tried: {', '.join(old_selectors)}")
        if previous_failures:
            failure_lines = [
                f"- step {f.get('step_index')} ({f.get('action')}): {f.get('error')}"
                for f in previous_failures
            ]
            context_parts.append("Previous failures on this run:\n" + "\n".join(failure_lines))
        if error_context:
            context_parts.append(f"Page context (DOM/text excerpt):\n{error_context[:3000]}")

        if last_chance:
            context_parts.insert(
                1,
                "THIS IS THE LAST CHANCE. Retries and selector healing have "
                "already been exhausted. The only alternative to your decision "
                "here is a hard PAUSE that requires a human. Strongly prefer "
                "ANY actionable recovery: new selectors, a navigate to a "
                "different URL, or a skip if the step is no longer needed. "
                "Only decline if absolutely nothing useful can be done.",
            )

        prompt = "\n".join(context_parts)

        system_prompt = (
            "You are a workflow recovery analyst. The recorded blueprint is "
            "guidance, not gospel — the page may have changed since recording. "
            "Given a failed step, decide the best recovery: new selectors, a "
            "different action (e.g. navigate to a known target URL when a "
            "search result link is broken), or skip if no longer needed. "
            "Strongly prefer accessibility role+name, visible text, and "
            "data-testid selectors over auto-generated CSS ids that look "
            "session-specific. "
            "Return JSON: {"
            "\"analysis\": str, \"likely_cause\": str, "
            "\"suggested_action\": \"navigate|click|type|select|scroll|extract\" (optional), "
            "\"suggested_value\": str (optional, e.g. URL for navigate), "
            "\"suggested_selectors\": [{\"type\": str, \"value\": str, \"score\": float}], "
            "\"confidence\": float, \"should_retry\": bool, \"should_skip\": bool, "
            "\"thinking_steps\": [{\"step\": int, \"question\": str, \"observation\": str, "
            "\"conclusion\": str}] (3-5 entries reasoning through: why failure occurred, "
            "whether element exists under different selector, what recovery action is best)}"
        )
        if last_chance:
            system_prompt += (
                " You MUST set should_skip=true OR provide suggested_selectors "
                "OR provide suggested_action+suggested_value. Returning nothing "
                "actionable will pause the run for a human."
            )

        provider = get_ai_provider(api_key_override=ai_api_key)
        _fa_start = time.monotonic()
        try:
            response = await provider.generate(
                prompt,
                system=system_prompt,
            )
            try:
                result = json.loads(response.content)
                latency_ms = int((time.monotonic() - _fa_start) * 1000)
                analysis_result = {
                    "likely_cause": result.get("likely_cause", "unknown"),
                    "analysis": result.get("analysis", ""),
                    "suggested_action": result.get("suggested_action"),
                    "suggested_value": result.get("suggested_value"),
                    "suggested_selectors": result.get("suggested_selectors", []),
                    "confidence": result.get("confidence", 0.0),
                    "should_retry": result.get("should_retry", False),
                    "should_skip": result.get("should_skip", False),
                    "thinking_steps": self._extract_thinking_steps(result),
                    "latency_ms": latency_ms,
                }
                with contextlib.suppress(Exception):
                    await self.ai_outcomes.record_recovery_trace(
                        run_id=str(run.id),
                        step_index=step_index,
                        attempt_number=_run_heal_attempts.get(str(run.id), 0) + 1,
                        trigger=trigger,
                        error=error,
                        analysis_result=analysis_result,
                        outcome=None,
                        model=settings.ai_model if settings.ai_api_key else None,
                        latency_ms=latency_ms,
                    )
                return analysis_result
            except (json.JSONDecodeError, ValueError):
                return {"analysis": response.content, "confidence": 0.0,
                        "thinking_steps": [], "latency_ms": None}
        except Exception as exc:
            logger.warning("AI failure analysis failed: %s", exc)
            return None

    async def _classify_blockage(
        self,
        _run: ExecutionRun,
        ctx: Any,
    ) -> dict[str, Any] | None:
        """Use AI to classify a blocking challenge and suggest resolution."""
        ai_api_key = settings.ai_api_key
        if not ai_api_key:
            return None

        visible_text = getattr(ctx, "visible_text", "") or ""
        dom_snippet = getattr(ctx, "dom_snippet", "") or ""
        if not visible_text and not dom_snippet:
            return None

        provider = get_ai_provider(api_key_override=ai_api_key)
        try:
            prompt = build_classify_prompt(visible_text[:1500], [])
            if dom_snippet:
                prompt += f"\n\nDOM excerpt:\n{dom_snippet[:2000]}"

            response = await provider.generate(
                prompt,
                system=(
                    "You are a page state classifier. "
                    "Classify the blocking challenge and suggest resolution."
                ),
            )
            try:
                result = json.loads(response.content)
                return {
                    "classification": result.get("classification", "ambiguous"),
                    "confidence": result.get("confidence", 0.0),
                    "reason": result.get("reason", ""),
                    "suggested_action": result.get("suggested_action", ""),
                }
            except (json.JSONDecodeError, ValueError):
                return None
        except Exception as exc:
            logger.warning("AI blockage classification failed: %s", exc)
            return None
