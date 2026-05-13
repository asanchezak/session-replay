from __future__ import annotations

import json
import re

from sqlalchemy.ext.asyncio import AsyncSession

from ai.client import get_ai_provider
from ai.prompts import build_heal_prompt
from core.config import settings
from core.models.run import ExecutionRun
from core.state_machine import RunStatus
from services.audit import AuditService
from services.execution_service import ExecutionService

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
    if isinstance(sel, dict) and "type" in sel and "value" in sel:
        return sel
    if isinstance(sel, str):
        if sel.startswith("//") or sel.startswith("("):
            return {"type": "xpath", "value": sel}
        if sel.startswith("#") or sel.startswith(".") or sel.startswith("["):
            return {"type": "css", "value": sel}
        return {"type": "css", "value": sel}
    return {"type": "css", "value": str(sel)}


class HealingService:
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
    ) -> dict:
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
        )
        response = await provider.generate(
            prompt,
            system="You are a DOM analysis assistant.",
        )

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

            await self.audit.append(
                event_type="recovery_attempt",
                payload={
                    "step_index": step_index,
                    "old_selectors": old_selectors,
                    "intent": intent_text,
                    "method": "ai",
                    "confidence": result.get("confidence", 0.0),
                    "explanation": result.get("explanation", ""),
                    "new_selectors_count": len(new_selectors),
                },
                run_id=str(run.id),
            )

            return {
                "new_selectors": new_selectors,
                "confidence": result.get("confidence", 0.0),
                "explanation": result.get("explanation", ""),
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
        snapshot = run.workflow_snapshot or {}
        steps = snapshot.get("steps", [])
        if step_index < len(steps):
            steps[step_index]["selector_chain"] = new_selectors
            run.workflow_snapshot = snapshot
            await self.session.flush()
        return run

    async def recover(
        self, run_id: str, step_index: int, error: str
    ) -> ExecutionRun:
        _ = (step_index, error)
        run = await self.execution.transition(run_id, RunStatus.RECOVERING)
        return run

    async def heal_succeeded(
        self, run_id: str, step_index: int, new_selectors: list[dict] | None = None
    ) -> ExecutionRun:
        run = await self.execution.get_run(run_id)
        if new_selectors:
            await self.apply_heal(run, step_index, new_selectors)
        await self.audit.append(
            event_type="recovery_success",
            payload={
                "step_index": step_index,
                "new_selectors": new_selectors,
                "from_status": run.status,
            },
            run_id=run_id,
        )
        run = await self.execution.transition(run_id, RunStatus.RUNNING)
        return run

    async def heal_failed(
        self, run_id: str, step_index: int, error: str
    ) -> ExecutionRun:
        _ = step_index
        run = await self.execution.get_run(run_id)
        await self.audit.append(
            event_type="recovery_failure",
            payload={
                "step_index": step_index,
                "error": error,
                "from_status": run.status,
            },
            run_id=run_id,
        )
        run = await self.execution.transition(run_id, RunStatus.WAITING_FOR_USER)
        run.pause_reason = error
        await self.session.flush()
        return run
