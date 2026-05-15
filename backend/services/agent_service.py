import contextlib
import json
import logging
import re
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ai.client import get_ai_provider
from ai.prompts import AGENT_EXECUTOR_SYSTEM, build_agent_decision_prompt, build_classify_prompt
from core.config import settings
from core.exceptions import NotFoundError
from core.models.event import EventLog
from core.models.run import ExecutionRun
from core.state_machine import RunStatus, WorkflowStateMachine
from core.utils import to_uuid
from services.agent_models import (
    SAFETY_LIMITS,
    AgentCommand,
    CommandAction,
    DecisionType,
    PlanUpdate,
    PollRequest,
    PollResponse,
    ResultRequest,
    ResultResponse,
)
from services.ai_outcome_service import AIOutcomeService
from services.audit import AppendEvent, AuditService
from services.execution_service import ExecutionService
from services.healing_service import HealingService

logger = logging.getLogger(__name__)

_run_retries: dict[str, int] = {}
_run_heal_attempts: dict[str, int] = {}
_run_adapt_count: dict[str, int] = {}
_run_plan_updates: dict[str, int] = {}
_run_last_poll: dict[str, datetime] = {}
_pending_actions: dict[str, str] = {}


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
                run_id, DecisionType.PAUSE, 0.99,
                reasoning,
                pause_reason=f"Blocking challenge detected: {ctx.blocking_type.value}",
                extra_payload=(
                    {"ai_classification": ai_classification}
                    if ai_classification else None
                ),
            )
            with contextlib.suppress(Exception):
                await self.execution.pause(
                    run_id,
                    reason=f"Blocking challenge: {ctx.blocking_type.value}",
                )
            return PollResponse(
                decision=DecisionType.PAUSE,
                confidence=0.99,
                reasoning=reasoning,
                pause_reason=f"Blocking challenge detected: {ctx.blocking_type.value}",
                requires_human=True,
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

        if step_index >= total_steps:
            return PollResponse(
                decision=DecisionType.COMPLETED,
                confidence=0.99,
                reasoning="All steps completed",
                next_step_index=step_index,
            )

        step = steps[step_index]
        command = self._build_command(step)

        should_use_ai = self._should_consult_ai(run_id, step, ctx)
        if should_use_ai:
            ai_decision = await self._consult_ai_for_step(
                run, step_index, step, command, analysis, ctx,
            )
            if ai_decision:
                decision_type = DecisionType(ai_decision.get("decision", "EXECUTE"))

                # Apply any plan_updates the LLM proposed BEFORE acting on the
                # decision — the snapshot may have shifted (insert/remove/reorder)
                # so step_index needs to be re-evaluated.
                applied_updates = await self._apply_plan_updates_from_ai(
                    run, ai_decision.get("plan_updates"),
                )

                if decision_type == DecisionType.ADAPT:
                    adapted_command = self._parse_adapted_command(
                        ai_decision.get("command", {}),
                    )
                    _run_adapt_count[run_id] = _run_adapt_count.get(run_id, 0) + 1
                    await self._audit_decision(
                        run_id, DecisionType.ADAPT,
                        ai_decision.get("confidence", 0.7),
                        ai_decision.get("reasoning", "AI-adapted step"),
                        command=adapted_command or command,
                        extra_payload={"plan_updates": applied_updates} if applied_updates else None,
                    )
                    if run.status != "running":
                        try:
                            await self._transition_to_running(run)
                        except Exception as e:
                            logger.warning("Could not transition run %s to running: %s", run_id, e)
                    return PollResponse(
                        decision=DecisionType.ADAPT,
                        confidence=ai_decision.get("confidence", 0.7),
                        reasoning=ai_decision.get("reasoning", "AI-adapted step"),
                        command=adapted_command or command,
                        next_step_index=step_index,
                        plan_updates=applied_updates,
                    )
                if decision_type == DecisionType.SKIP:
                    await self._audit_decision(
                        run_id, DecisionType.SKIP,
                        ai_decision.get("confidence", 0.7),
                        ai_decision.get("reasoning", "AI recommends skipping"),
                        extra_payload={"plan_updates": applied_updates} if applied_updates else None,
                    )
                    await self.execution.advance_step(run_id)
                    return PollResponse(
                        decision=DecisionType.SKIP,
                        confidence=ai_decision.get("confidence", 0.7),
                        reasoning=ai_decision.get("reasoning", "Step skipped by AI"),
                        next_step_index=step_index + 1,
                        plan_updates=applied_updates,
                    )
                if decision_type == DecisionType.PAUSE:
                    pause_reason = ai_decision.get("pause_reason", "AI recommends pausing")
                    await self._audit_decision(
                        run_id, DecisionType.PAUSE,
                        ai_decision.get("confidence", 0.5),
                        ai_decision.get("reasoning", pause_reason),
                        pause_reason=pause_reason,
                    )
                    with contextlib.suppress(Exception):
                        await self.execution.pause(run_id, reason=pause_reason)
                    return PollResponse(
                        decision=DecisionType.PAUSE,
                        confidence=ai_decision.get("confidence", 0.5),
                        reasoning=ai_decision.get("reasoning", pause_reason),
                        pause_reason=pause_reason,
                        requires_human=True,
                    )

        # If we got here after a successful AI consult, the LLM returned EXECUTE
        # (otherwise we'd have returned in the ADAPT/SKIP/PAUSE branches above).
        # Distinguish that case from a true fast-path so the audit log + report
        # show whether the AI was actually involved.
        ai_confirmed = bool(should_use_ai and 'ai_decision' in locals() and ai_decision)
        reason_prefix = "AI confirmed EXECUTE" if ai_confirmed else "Fast path"
        ai_conf = (ai_decision or {}).get("confidence", 0.99) if ai_confirmed else 0.99
        await self._audit_decision(
            run_id, DecisionType.EXECUTE, ai_conf,
            f"{reason_prefix}: execute step {step_index} ({step.get('action_type', '')})",
            command=command,
        )

        if run.status != "running":
            try:
                await self._transition_to_running(run)
            except Exception as e:
                logger.warning("Could not transition run %s to running: %s", run_id, e)

        return PollResponse(
            decision=DecisionType.EXECUTE,
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
        """Decide whether to consult the LLM before executing this step.

        Philosophy: when AI is configured, it is the PRIMARY decision maker.
        We only skip the consult when the step looks completely trivial
        (e.g., navigate with a literal URL) or when we've run out of budget.
        """
        if not settings.ai_api_key:
            return False
        adapt_count = _run_adapt_count.get(run_id, 0)
        if adapt_count >= SAFETY_LIMITS.get("max_adapt_per_run", 5):
            return False
        action_type = (step.get("action_type") or "").lower()
        # Pure navigate steps with a literal URL value rarely need adaptation
        if action_type == "navigate" and step.get("value", "").startswith(("http://", "https://")):
            return False
        return True

    async def _consult_ai_for_step(
        self,
        run: ExecutionRun,
        step_index: int,
        step: dict[str, Any],
        _original_command: AgentCommand,
        analysis: dict[str, Any],
        ctx: Any,
    ) -> dict[str, Any] | None:
        ai_api_key = settings.ai_api_key
        if not ai_api_key:
            return None

        selector_chain = step.get("selector_chain", [])
        visible_elements = []
        if hasattr(ctx, "visible_elements") and ctx.visible_elements:
            visible_elements = ctx.visible_elements[:25]
        visible_text = getattr(ctx, "visible_text", "") or ""

        previous_failures = await self._load_previous_failures(run, step_index)

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
        )

        provider = get_ai_provider(api_key_override=ai_api_key)
        try:
            response = await provider.generate(
                prompt,
                system=AGENT_EXECUTOR_SYSTEM,
                max_tokens=512,
            )
            try:
                result = json.loads(response.content)
                if not isinstance(result, dict):
                    return None
                decision = result.get("decision", "EXECUTE").upper()
                if decision not in ("EXECUTE", "ADAPT", "SKIP", "PAUSE", "RETRY"):
                    return None
                result["decision"] = decision
                return result
            except (json.JSONDecodeError, ValueError):
                logger.warning("AI agent decision not valid JSON: %s", response.content[:200])
                return None
        except Exception as exc:
            logger.warning("AI agent decision call failed: %s", exc)
            return None

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
            try:
                op = PlanUpdate(**raw_op)
            except Exception as exc:
                logger.debug("Rejected invalid plan_update from LLM: %s (%s)", raw_op, exc)
                continue
            ops_to_apply.append({
                "operation": op.operation.value,
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

        if req.success:
            _run_retries[run_id] = 0
            _run_heal_attempts[run_id] = 0
            await self._audit_decision(
                run_id, DecisionType.EXECUTE, 0.99,
                f"Step {req.step_index} succeeded",
            )

            await self.execution.advance_step(run_id)
            await self.session.refresh(run)

            if run.current_step_index >= run.total_steps:
                with contextlib.suppress(Exception):
                    await self.execution.complete(run_id)
                return ResultResponse(
                    accepted=True,
                    decision=DecisionType.COMPLETED,
                    next_step_index=run.current_step_index,
                )

            return ResultResponse(
                accepted=True,
                next_step_index=run.current_step_index,
            )

        retries = _run_retries.get(run_id, 0)
        heal_attempts = _run_heal_attempts.get(run_id, 0)
        adapt_count = _run_adapt_count.get(run_id, 0)
        error = req.error or "Step failed"

        if adapt_count < SAFETY_LIMITS.get("max_adapt_per_run", 5):
            ai_analysis = await self._analyze_failure(
                run, req.step_index, error, req.error_context,
            )
            has_adaptation = bool(
                ai_analysis and (
                    ai_analysis.get("suggested_selectors")
                    or ai_analysis.get("suggested_action") == "navigate"
                    and ai_analysis.get("suggested_value")
                )
            )
            if ai_analysis and ai_analysis.get("should_skip"):
                _run_adapt_count[run_id] = adapt_count + 1
                await self._audit_decision(
                    run_id, DecisionType.SKIP,
                    ai_analysis.get("confidence", 0.6),
                    (
                        f"AI recommends skipping step {req.step_index}: "
                        f"{ai_analysis.get('analysis', error)}"
                    ),
                    extra_payload={"ai_analysis": ai_analysis},
                )
                await self.execution.advance_step(run_id)
                await self.session.refresh(run)
                return ResultResponse(
                    accepted=True,
                    decision=DecisionType.SKIP,
                    next_step_index=run.current_step_index,
                    ai_analysis=ai_analysis,
                )
            if has_adaptation:
                _run_adapt_count[run_id] = adapt_count + 1
                try:
                    run = await self.execution.transition(run_id, RunStatus.RECOVERING)
                    await self.session.flush()
                except Exception:
                    logger.warning("Could not transition run %s to recovering", run_id)

                await self._audit_decision(
                    run_id, DecisionType.ADAPT,
                    ai_analysis.get("confidence", 0.7),
                    (
                        f"AI adaptation for step {req.step_index}: "
                        f"{ai_analysis.get('analysis', error)}"
                    ),
                    extra_payload={"ai_analysis": ai_analysis},
                )
                return ResultResponse(
                    accepted=True,
                    decision=DecisionType.ADAPT,
                    next_step_index=req.step_index,
                    ai_analysis=ai_analysis,
                )

        if retries < SAFETY_LIMITS["max_retries_per_step"]:
            _run_retries[run_id] = retries + 1
            msg = (
                f"Step {req.step_index} failed, retry {retries + 1}/"
                f"{SAFETY_LIMITS['max_retries_per_step']}: {error}"
            )
            await self._audit_decision(
                run_id, DecisionType.RETRY, 0.80, msg,
            )
            return ResultResponse(
                accepted=True,
                decision=DecisionType.RETRY,
                next_step_index=req.step_index,
            )

        if heal_attempts < SAFETY_LIMITS["max_heal_attempts_per_step"]:
            _run_heal_attempts[run_id] = heal_attempts + 1
            msg = (
                f"Step {req.step_index} failed after retries, "
                f"heal {heal_attempts + 1}: {error}"
            )
            try:
                run = await self.execution.transition(run_id, RunStatus.RECOVERING)
                await self.session.flush()
            except Exception:
                logger.warning("Could not transition run %s to recovering", run_id)

            ai_analysis = await self._analyze_failure(
                run, req.step_index, error, req.error_context,
            )

            await self._audit_decision(
                run_id, DecisionType.HEAL, 0.85, msg,
                command=None,
                extra_payload={"ai_analysis": ai_analysis},
            )
            return ResultResponse(
                accepted=True,
                decision=DecisionType.HEAL,
                next_step_index=req.step_index,
                ai_analysis=ai_analysis,
            )

        # Last-chance AI consult before pausing. By this point retries and
        # heals are exhausted; instead of falling back on the human, give the
        # LLM one final shot with the full failure history and ask it to make
        # ANY decision other than pause if it can — adapt, skip, navigate.
        last_chance = await self._last_chance_recovery(
            run, req.step_index, error, req.error_context, adapt_count,
        )
        if last_chance:
            return last_chance

        _run_retries[run_id] = 0
        _run_heal_attempts[run_id] = 0
        await self._audit_decision(
            run_id, DecisionType.PAUSE, 0.50,
            f"Step {req.step_index} failed after retries + heals + last-chance AI: {error}",
            pause_reason=error,
        )
        with contextlib.suppress(Exception):
            await self.execution.pause(run_id, reason=error)

        return ResultResponse(
            accepted=True,
            decision=DecisionType.PAUSE,
            next_step_index=req.step_index,
        )

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
                run_id, DecisionType.SKIP, analysis.get("confidence", 0.6),
                f"Last-chance AI recommends SKIP for step {step_index}: "
                f"{analysis.get('analysis', '')[:160]}",
                extra_payload={"ai_analysis": analysis, "last_chance": True},
            )
            await self.execution.advance_step(run_id)
            await self.session.refresh(run)
            return ResultResponse(
                accepted=True,
                decision=DecisionType.SKIP,
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
                run_id, DecisionType.ADAPT, analysis.get("confidence", 0.7),
                f"Last-chance AI adaptation for step {step_index}: "
                f"{analysis.get('analysis', '')[:160]}",
                extra_payload={"ai_analysis": analysis, "last_chance": True},
            )
            return ResultResponse(
                accepted=True,
                decision=DecisionType.ADAPT,
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
        return AgentCommand(
            action=action,
            target=step.get("value"),
            value=step.get("value"),
            selector_chain=step.get("selector_chain") or [],
            intent=step.get("intent"),
            methods=step.get("methods") or [],
            timeout_ms=15000,
            pre_condition=None,
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
        decision: DecisionType,
        confidence: float,
        reasoning: str,
        command: AgentCommand | None = None,
        pause_reason: str | None = None,
        extra_payload: dict[str, Any] | None = None,
        step_index: int | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "decision": decision.value,
            "confidence": confidence,
            "reasoning": reasoning,
            "command": command.model_dump() if command else None,
            "pause_reason": pause_reason,
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
            await self.ai_outcomes.record_decision(
                run_id=run_id,
                step_index=int(effective_step or 0),
                decision=decision.value,
                confidence=confidence,
                reasoning=reasoning,
                model=settings.ai_model if settings.ai_api_key else "fast-path",
            )
        except Exception as exc:
            logger.debug("ai_outcomes.record_decision skipped: %s", exc)

    async def _analyze_failure(
        self,
        run: ExecutionRun,
        step_index: int,
        error: str,
        error_context: str | None = None,
        last_chance: bool = False,
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
            "\"confidence\": float, \"should_retry\": bool, \"should_skip\": bool}"
        )
        if last_chance:
            system_prompt += (
                " You MUST set should_skip=true OR provide suggested_selectors "
                "OR provide suggested_action+suggested_value. Returning nothing "
                "actionable will pause the run for a human."
            )

        provider = get_ai_provider(api_key_override=ai_api_key)
        try:
            response = await provider.generate(
                prompt,
                system=system_prompt,
            )
            try:
                result = json.loads(response.content)
                return {
                    "likely_cause": result.get("likely_cause", "unknown"),
                    "analysis": result.get("analysis", ""),
                    "suggested_action": result.get("suggested_action"),
                    "suggested_value": result.get("suggested_value"),
                    "suggested_selectors": result.get("suggested_selectors", []),
                    "confidence": result.get("confidence", 0.0),
                    "should_retry": result.get("should_retry", False),
                    "should_skip": result.get("should_skip", False),
                }
            except (json.JSONDecodeError, ValueError):
                return {"analysis": response.content, "confidence": 0.0}
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
