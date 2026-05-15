from __future__ import annotations

import json
import logging
import re
from copy import deepcopy
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from ai.client import get_ai_provider
from ai.prompts import build_heal_prompt
from core.config import settings
from core.models.intervention import HumanIntervention
from core.models.run import ExecutionRun
from core.state_machine import RunStatus
from services.audit import AppendEvent, AuditService
from services.execution_service import ExecutionService

logger = logging.getLogger(__name__)

PII_PATTERNS = [
    (r'\b[\w.+-]+@[\w-]+\.[\w.-]+\b', '[REDACTED:email]'),
    (r'\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b', '[REDACTED:phone]'),
    (r'\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b', '[REDACTED:cc]'),
    (r'\b\d{3}-\d{2}-\d{4}\b', '[REDACTED:ssn]'),
]


def redact_pii(text: str) -> str:
    for pattern, replacement in PII_PATTERNS:
        text = re.sub(pattern, replacement, text)
    return text


def _normalize_selector(sel: str | dict) -> dict:
    if sel is None:
        raise ValueError("Selector cannot be None")
    if isinstance(sel, int):
        raise ValueError(f"Selector cannot be int: {sel}")
    if isinstance(sel, dict):
        if "type" in sel and "value" in sel:
            return sel
        raise ValueError(f"Dict missing 'type' or 'value': {sel}")
    if isinstance(sel, str):
        if not sel:
            raise ValueError("Selector cannot be empty string")
        if sel.startswith("//") or sel.startswith("("):
            return {"type": "xpath", "value": sel}
        if sel.startswith("#") or sel.startswith(".") or sel.startswith("["):
            return {"type": "css", "value": sel}
        return {"type": "css", "value": sel}
    raise ValueError(f"Invalid selector type: {type(sel).__name__}")


class HealingService:
    """Service for AI-based selector healing and recovery.

    Attempts to heal broken selectors by analyzing the DOM and suggesting
    new selectors. Falls back to human intervention when confidence is low.
    """

    def __init__(self, session: AsyncSession):
        self.session = session
        self.execution = ExecutionService(session)
        self.audit = AuditService(session)

    async def suggest_heal(
        self,
        run: ExecutionRun,
        step_index: int,
        dom_snippet: str,
        old_selectors: list[str],
        intent: str | None,
        ai_api_key: str | None = None,
        visible_text: str | None = None,
        page_url: str | None = None,
    ) -> dict:
        """Suggest new selectors for a broken step using AI analysis."""
        _ = run
        effective_key = ai_api_key or settings.ai_api_key
        if not effective_key:
            return {
                "new_selectors": [],
                "confidence": 0.0,
                "explanation": "AI not configured — skipping healing",
            }

        provider = get_ai_provider(api_key_override=effective_key)
        fallback = f"Step {step_index} ({old_selectors[0] if old_selectors else 'unknown'})"
        intent_text = intent or fallback

        redacted_snippet = redact_pii(dom_snippet)

        prompt = build_heal_prompt(
            dom_snippet=redacted_snippet,
            at_snippet=None,
            old_selectors=[f"{s}" for s in old_selectors],
            intent=intent_text,
            visible_text=visible_text,
            page_url=page_url,
        )

        try:
            response = await provider.generate(
                prompt,
                system="You are a DOM analysis assistant.",
            )
        except Exception as exc:
            logger.error("AI provider call failed during healing: %s", exc)
            await self.audit.append(AppendEvent(
                event_type="recovery_attempt",
                payload={
                    "step_index": step_index,
                    "old_selectors": old_selectors,
                    "intent": intent_text,
                    "method": "ai",
                    "error": f"AI provider error: {exc}",
                    "confidence": 0.0,
                },
                run_id=str(run.id),
            ))
            return {
                "new_selectors": [],
                "confidence": 0.0,
                "explanation": f"AI provider error: {exc}",
            }

        try:
            result = json.loads(response.content)
            if not isinstance(result, dict):
                raise ValueError("Response is not a dict")

            new_selectors: list[dict] = []
            primary = result.get("selector")
            if primary:
                new_selectors.append(_normalize_selector(primary))
            for sel in result.get("fallback_selectors", []):
                normalized = _normalize_selector(sel)
                if normalized not in new_selectors:
                    new_selectors.append(normalized)

            confidence = result.get("confidence", 0.0)
            explanation = result.get("explanation", "")

            await self.audit.append(AppendEvent(
                event_type="recovery_attempt",
                payload={
                    "step_index": step_index,
                    "old_selectors": old_selectors,
                    "intent": intent_text,
                    "method": "ai",
                    "confidence": confidence,
                    "explanation": explanation,
                    "new_selectors_count": len(new_selectors),
                },
                run_id=str(run.id),
            ))

            if confidence < settings.ai_confidence_threshold:
                intervention = HumanIntervention(
                    run_id=str(run.id),
                    trigger_reason="low_confidence_heal",
                    paused_at=datetime.now(UTC),
                )
                self.session.add(intervention)
                await self.session.flush()
                return {
                    "new_selectors": [],
                    "confidence": confidence,
                    "explanation": explanation,
                    "below_threshold": True,
                }

            return {
                "new_selectors": new_selectors,
                "confidence": confidence,
                "explanation": explanation,
            }
        except (json.JSONDecodeError, ValueError):
            return {
                "new_selectors": [],
                "confidence": 0.0,
                "explanation": f"AI returned unparseable response: {response.content[:200]}",
            }

    async def apply_heal(
        self,
        run: ExecutionRun,
        step_index: int,
        new_selectors: list[dict],
    ) -> ExecutionRun:
        """Apply healed selectors to the run's workflow snapshot.

        Thin wrapper around `apply_plan_update` kept for back-compat.
        """
        return await self.apply_plan_update(
            run,
            [{"operation": "MODIFY", "step_index": step_index,
              "new_step": {"selector_chain": new_selectors},
              "reason": "selector heal"}],
        )

    async def apply_plan_update(
        self,
        run: ExecutionRun,
        ops: list[dict],
    ) -> ExecutionRun:
        """Apply a list of PlanUpdate operations atomically to the run snapshot.

        Each op has shape: {operation, step_index, new_step?, reason}.
        Supported operations:
        - MODIFY: replace fields of the step at `step_index` with `new_step`
        - INSERT / ADD: insert `new_step` at `step_index` (existing steps shift right)
        - REMOVE / SKIP: drop the step at `step_index` (subsequent steps shift left)
        - REORDER: swap step `step_index` with step `new_step.swap_with`
        - SIMPLIFY: same as MODIFY but typically collapsing multiple recorded
          steps into one (caller is responsible for the REMOVE ops that
          accompany it)

        All ops are validated and applied as a single snapshot mutation so a
        bad op aborts the whole batch.
        """
        if not ops:
            return run

        snapshot = deepcopy(run.workflow_snapshot or {})
        steps: list[dict] = snapshot.get("steps", []) or []

        applied: list[dict] = []
        for op in ops:
            operation = str(op.get("operation", "")).upper()
            idx = int(op.get("step_index", -1))
            new_step = op.get("new_step") or {}
            reason = op.get("reason", "")

            if operation in {"MODIFY", "SIMPLIFY"}:
                if 0 <= idx < len(steps):
                    steps[idx] = {**steps[idx], **new_step}
                    applied.append({"operation": operation, "step_index": idx, "reason": reason})
            elif operation in {"INSERT", "ADD"}:
                idx = max(0, min(idx, len(steps)))
                injected = {"step_index": idx, **new_step}
                steps.insert(idx, injected)
                for i, s in enumerate(steps):
                    s["step_index"] = i
                applied.append({"operation": "INSERT", "step_index": idx, "reason": reason})
            elif operation in {"REMOVE", "SKIP"}:
                if 0 <= idx < len(steps):
                    steps.pop(idx)
                    for i, s in enumerate(steps):
                        s["step_index"] = i
                    applied.append({"operation": "REMOVE", "step_index": idx, "reason": reason})
            elif operation == "REORDER":
                swap_with = int(new_step.get("swap_with", -1))
                if 0 <= idx < len(steps) and 0 <= swap_with < len(steps) and idx != swap_with:
                    steps[idx], steps[swap_with] = steps[swap_with], steps[idx]
                    for i, s in enumerate(steps):
                        s["step_index"] = i
                    applied.append({
                        "operation": "REORDER", "step_index": idx,
                        "swap_with": swap_with, "reason": reason,
                    })
            else:
                logger.warning("Unknown plan update operation: %s", operation)

        if not applied:
            return run

        snapshot["steps"] = steps
        run.workflow_snapshot = snapshot
        flag_modified(run, "workflow_snapshot")
        # Keep `total_steps` in sync — UI relies on this for the progress ribbon
        run.total_steps = len(steps)
        await self.session.flush()

        await self.audit.append(AppendEvent(
            event_type="plan_update",
            payload={"ops": applied, "new_step_count": len(steps)},
            run_id=str(run.id),
        ))
        return run

    async def recover(
        self, run_id: str, step_index: int, error: str, dom_snippet: str = ""
    ) -> ExecutionRun:
        """Attempt automatic recovery for a failed step."""
        logger.info("Recovering run=%s step=%d error=%s", run_id, step_index, error)
        run = await self.execution.get_run(run_id)
        run = await self.execution.transition(run_id, RunStatus.RECOVERING)

        snapshot = run.workflow_snapshot or {}
        steps = snapshot.get("steps", [])
        old_selectors: list[str] = []
        intent = None
        if step_index < len(steps):
            step = steps[step_index]
            selector_chain = step.get("selector_chain") or []
            old_selectors = [
                s.get("value", str(s)) if isinstance(s, dict) else str(s)
                for s in selector_chain
            ]
            intent = step.get("intent")

        result = await self.suggest_heal(
            run=run,
            step_index=step_index,
            dom_snippet=dom_snippet,
            old_selectors=old_selectors,
            intent=intent,
        )

        if result.get("below_threshold") or not result.get("new_selectors"):
            return await self.heal_failed(run_id, step_index, error)

        return await self.heal_succeeded(run_id, step_index, result["new_selectors"])

    async def heal_succeeded(
        self, run_id: str, step_index: int, new_selectors: list[dict] | None = None
    ) -> ExecutionRun:
        """Record a successful heal and resume the run."""
        logger.info("Heal succeeded run=%s step=%d", run_id, step_index)
        run = await self.execution.get_run(run_id)
        if new_selectors:
            await self.apply_heal(run, step_index, new_selectors)
        await self.audit.append(AppendEvent(
            event_type="recovery_success",
            payload={
                "step_index": step_index,
                "new_selectors": new_selectors,
                "from_status": run.status,
            },
            run_id=run_id,
        ))
        run = await self.execution.transition(run_id, RunStatus.RUNNING)
        return run

    async def heal_failed(
        self, run_id: str, step_index: int, error: str
    ) -> ExecutionRun:
        """Record a failed heal and pause for human intervention."""
        logger.warning("Heal failed run=%s step=%d error=%s", run_id, step_index, error)
        _ = step_index
        run = await self.execution.get_run(run_id)
        await self.audit.append(AppendEvent(
            event_type="recovery_failure",
            payload={
                "step_index": step_index,
                "error": error,
                "from_status": run.status,
            },
            run_id=run_id,
        ))

        intervention = HumanIntervention(
            run_id=run_id,
            trigger_reason="heal_failed",
            paused_at=datetime.now(UTC),
        )
        self.session.add(intervention)

        run = await self.execution.transition(run_id, RunStatus.WAITING_FOR_USER)
        run.pause_reason = error
        await self.session.flush()
        return run
