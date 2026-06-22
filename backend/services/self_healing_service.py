"""AI self-healing — Phase 1 (SHADOW mode).

When a Recruiter workflow run FAILS, this service automates the debug loop a human
would do: gather the failure evidence (the reason, the failed step's selector, the
strategy `diag` DOM fragments, and the page-capture screenshot), ask an LLM to
diagnose the root cause and propose a concrete fix (usually a selector swap), and
VALIDATE the proposed selector OFFLINE against the captured DOM before trusting it.

SHADOW: it applies NOTHING — it only persists the diagnosis (into `run.origin`, which
the run-detail API already returns) so the dashboard can surface it. Future phases
would apply a fix to a COPY of the workflow (canary), never the live one.

Fired detached (asyncio.create_task) from ExecutionService.transition so the slow AI
call never blocks the run's terminal transition; it opens its own DB session.
"""
from __future__ import annotations

import base64
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from ai.client import ImageBlock, get_ai_provider
from core.models.run import ExecutionRun
from services.artifact_service import ArtifactService
from services.recruiter_pipeline_service import RecruiterPipelineService
from services.recruiter_push_service import RecruiterPushService

logger = logging.getLogger(__name__)

_EXPECTATIONS_PATH = Path(__file__).with_name("recruiter_expectations.json")
_expectations_cache: dict | None = None

# Cap the screenshot we inline to the vision model (page captures are ~100KB).
_MAX_SHOT_BYTES = 4_000_000
# Cap the captured-DOM text we scan offline.
_MAX_DOM_TEXT = 200_000

_SYSTEM_PROMPT = (
    "You are a self-healing diagnostician for LinkedIn Recruiter (/talent) browser-automation "
    "workflows. A run FAILED. You are given the workflow's contract (what success means), the "
    "exact step that failed (with its selectors), the strategy's captured DOM fragments, and a "
    "screenshot of the page at failure. Diagnose the ROOT CAUSE and propose ONE concrete fix.\n\n"
    "The #1 failure mode is SELECTOR DRIFT (LinkedIn moved the DOM) or LOCALE FLIP (the seat "
    "language switched ES<->EN so a text/aria selector stopped matching). Prefer fixes that swap "
    "to a locale-proof data-test-* selector that you can SEE in the captured DOM/screenshot.\n\n"
    "Respond with ONLY a JSON object (no prose, no code fences):\n"
    "{\n"
    '  "failure_class": "selector_drift|locale_flip|walled_seat|timeout|logic|unknown",\n'
    '  "root_cause": "one or two sentences",\n'
    '  "proposed_fix": {"type": "selector_swap|add_wait|reorder|relaunch|none", "step_index": <int|null>, '
    '"old_selector": "<string|null>", "new_selector": "<string|null>", "rationale": "<string>"} ,\n'
    '  "confidence": 0.0,\n'
    '  "auto_heal_safe": true,\n'
    '  "human_summary": "one short actionable sentence for the recruiter/dev"\n'
    "}\n"
    "auto_heal_safe = true ONLY for a pure selector_swap or add_wait; false for anything that "
    "changes what is clicked/sent/saved, or for walled_seat/timeout (those need a human/relaunch)."
)

_DEFAULT_DIAGNOSIS = {
    "failure_class": "unknown",
    "root_cause": "",
    "proposed_fix": None,
    "confidence": 0.0,
    "auto_heal_safe": False,
    "human_summary": "",
}


def _load_expectations() -> dict:
    global _expectations_cache
    if _expectations_cache is None:
        try:
            _expectations_cache = json.loads(_EXPECTATIONS_PATH.read_text(encoding="utf-8"))
        except Exception:
            logger.exception("self-heal: failed to load expectations contracts")
            _expectations_cache = {"strategies": {}}
    return _expectations_cache


def _strategy_from_error(error_summary: str) -> str | None:
    """The daemon fails recruiter strategy steps as '<strategy> stage failed: <reason>'."""
    m = re.match(r"\s*(recruiter_[a-z_]+)\s+stage failed", error_summary or "")
    return m.group(1) if m else None


def _contract_for(strategy: str | None) -> dict:
    strategies = _load_expectations().get("strategies", {})
    if strategy and strategy in strategies:
        return strategies[strategy]
    return strategies.get("_generic_step", {})


async def gather_evidence(session, run: ExecutionRun) -> dict:
    """Assemble everything the backend has about a failed run for the AI + offline check."""
    origin = run.origin or {}
    error_summary = run.error_summary or ""
    snap = run.workflow_snapshot or {}
    steps = snap.get("steps") or []
    idx = run.current_step_index if run.current_step_index is not None else -1
    failed_step = steps[idx] if 0 <= idx < len(steps) else None

    strategy = _strategy_from_error(error_summary)
    if not strategy and isinstance(failed_step, dict):
        for m in failed_step.get("methods") or []:
            if isinstance(m, dict) and isinstance(m.get("strategy"), str):
                strategy = m["strategy"]
                break

    # Strategy diag (the *_result dicts carry captured DOM fragments).
    diag: dict = {}
    try:
        rows = await RecruiterPushService(session)._extraction_rows(run.id)
        for r in rows:
            for k, v in r.items():
                if k.endswith("_result") and isinstance(v, dict):
                    diag[k] = v
    except Exception:
        logger.debug("self-heal: no extraction diag for run %s", run.id, exc_info=True)

    # Structured page snapshot (visible elements/text) — extra offline-validation material.
    page_snapshot = None
    try:
        from core.models.page_state_snapshot import PageStateSnapshot

        ps = (
            await session.execute(
                select(PageStateSnapshot)
                .where(PageStateSnapshot.run_id == run.id)
                .order_by(PageStateSnapshot.captured_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if ps is not None:
            page_snapshot = {
                "url": ps.url,
                "title": ps.title,
                "visible_text_excerpt": ps.visible_text_excerpt,
                "visible_elements": ps.visible_elements,
            }
    except Exception:
        logger.debug("self-heal: no page snapshot for run %s", run.id, exc_info=True)

    # Latest page-capture screenshot (closest to failure) -> base64 for the vision model.
    screenshot_b64 = None
    try:
        asvc = ArtifactService(session)
        caps = [a for a in await asvc.list_artifacts(str(run.id)) if a.artifact_type == "page_capture"]
        if caps:
            target = caps[-1]
            data = await asvc.storage.retrieve(target.file_path)
            if data and len(data) <= _MAX_SHOT_BYTES:
                screenshot_b64 = base64.b64encode(data).decode("ascii")
    except Exception:
        logger.debug("self-heal: no screenshot for run %s", run.id, exc_info=True)

    return {
        "run_id": str(run.id),
        "event_kind": origin.get("event_kind") or "",
        "strategy": strategy,
        "error_summary": error_summary,
        "error_class": RecruiterPipelineService._classify_flow_error(error_summary),
        "current_step_index": run.current_step_index,
        "total_steps": run.total_steps,
        "failed_step": failed_step,
        "contract": _contract_for(strategy),
        "diag": diag,
        "page_snapshot": page_snapshot,
        "screenshot_b64": screenshot_b64,
    }


def _evidence_dom_text(evidence: dict) -> str:
    """Flatten every captured DOM/string in the evidence (diag fragments + page snapshot)
    so the offline validator can check a proposed selector against the REAL DOM."""
    chunks: list[str] = []

    def walk(o):
        if isinstance(o, str):
            chunks.append(o)
        elif isinstance(o, dict):
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(evidence.get("diag") or {})
    walk(evidence.get("page_snapshot") or {})
    return "\n".join(chunks)[:_MAX_DOM_TEXT]


def _selector_tokens(sel: str) -> list[str]:
    """The DISTINCTIVE tokens of a CSS selector — what we look for in the captured DOM.
    For an attribute with a value (`[data-test-action='add-note']`) the VALUE is what's
    distinctive (the bare name `data-test-action` is on every button), so prefer the value
    and only fall back to the bare name for a value-less `[data-test-x]`."""
    s = sel or ""
    toks: list[str] = []
    # data-test-* attributes: value if present, else the bare attribute name.
    for m in re.finditer(r"\[(data-(?:live-)?test-[a-z0-9-]+)(?:=['\"]([^'\"]+)['\"])?\]", s):
        name, val = m.group(1), m.group(2)
        toks.append(val if val else name)
    # other attribute values, e.g. [type='submit'], [aria-label='…'].
    for m in re.finditer(r"\[(?!data-(?:live-)?test)[a-z-]+=['\"]([^'\"]+)['\"]\]", s):
        toks.append(m.group(1))
    toks += re.findall(r"\.([\w-]{4,})", s)   # .classes (len>=4)
    toks += re.findall(r"#([\w-]{3,})", s)     # #ids
    return [t for t in dict.fromkeys(toks) if t]


def _offline_validate(proposed_fix, evidence: dict) -> dict:
    """The 'no live trial-and-error' gate: a selector swap is only trustworthy if the new
    selector actually appears in the captured DOM. Returns matched_in_evidence true/false/None."""
    if not isinstance(proposed_fix, dict) or proposed_fix.get("type") != "selector_swap":
        return {"performed": False, "matched_in_evidence": None, "note": "fix is not a selector_swap"}
    new_sel = (proposed_fix.get("new_selector") or "").strip()
    if not new_sel:
        return {"performed": False, "matched_in_evidence": None, "note": "no new_selector proposed"}
    dom = _evidence_dom_text(evidence)
    if not dom:
        return {"performed": False, "matched_in_evidence": None, "note": "no captured DOM in evidence to validate against"}
    tokens = _selector_tokens(new_sel)
    if not tokens:
        return {"performed": False, "matched_in_evidence": None, "note": "could not extract a checkable token from the selector"}
    matched = any(t in dom for t in tokens)
    return {
        "performed": True,
        "matched_in_evidence": matched,
        "checked_tokens": tokens,
        "note": "matched against captured DOM" if matched else "new_selector not found in captured DOM (low trust)",
    }


def _build_prompt(evidence: dict) -> str:
    """Trim the evidence to a compact prompt (the screenshot goes as an image block)."""
    ev = dict(evidence)
    ev.pop("screenshot_b64", None)
    # Cap the diag/page_snapshot text so the prompt stays bounded.
    return (
        "FAILED Recruiter run — diagnose and propose a fix.\n\n"
        f"error_summary: {ev.get('error_summary')}\n"
        f"error_class: {ev.get('error_class')}\n"
        f"strategy: {ev.get('strategy')}\n"
        f"event_kind: {ev.get('event_kind')}\n"
        f"failed step (index {ev.get('current_step_index')}/{ev.get('total_steps')}):\n"
        f"{json.dumps(ev.get('failed_step'), ensure_ascii=False)[:2000]}\n\n"
        f"workflow contract (what success means):\n{json.dumps(ev.get('contract'), ensure_ascii=False)[:2500]}\n\n"
        f"captured DOM fragments (diag):\n{json.dumps(ev.get('diag'), ensure_ascii=False)[:6000]}\n\n"
        f"page snapshot:\n{json.dumps(ev.get('page_snapshot'), ensure_ascii=False)[:3000]}\n\n"
        "A screenshot of the failing page is attached. Respond with ONLY the JSON object."
    )


def _parse_diagnosis(content: str) -> dict:
    """Parse the model's JSON, tolerating code fences / stray prose; merge with defaults."""
    raw = (content or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", raw).strip()
    out = dict(_DEFAULT_DIAGNOSIS)
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            for k in _DEFAULT_DIAGNOSIS:
                if k in parsed:
                    out[k] = parsed[k]
            return out
    except Exception:
        pass
    # Non-conforming output (e.g. MockProvider) — keep raw as the root cause for visibility.
    out["root_cause"] = raw[:500]
    out["human_summary"] = "AI returned non-structured output; see root_cause."
    return out


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def diagnose_failed_run(run_id: str) -> dict | None:
    """SHADOW diagnosis of a failed run. Opens its own session (detached task), gathers
    evidence, calls the configured AI provider, validates any selector fix offline, and
    persists the diagnosis into run.origin['ai_diagnosis']. Applies NOTHING."""
    from core.database import async_session_factory

    async with async_session_factory() as session:
        run = (
            await session.execute(select(ExecutionRun).where(ExecutionRun.id == run_id))
        ).scalar_one_or_none()
        if run is None:
            logger.warning("self-heal: run %s not found", run_id)
            return None

        evidence = await gather_evidence(session, run)
        provider = get_ai_provider()
        images: list[ImageBlock] = []
        if evidence.get("screenshot_b64"):
            images.append(ImageBlock(b64=evidence["screenshot_b64"], mime="image/png", detail="high"))

        try:
            resp = await provider.generate(
                _build_prompt(evidence),
                system=_SYSTEM_PROMPT,
                max_tokens=1200,
                images=images or None,
            )
            diagnosis = _parse_diagnosis(resp.content)
        except Exception as e:  # noqa: BLE001 — best-effort shadow diagnosis
            logger.exception("self-heal: AI generate failed for run %s", run_id)
            diagnosis = dict(_DEFAULT_DIAGNOSIS)
            diagnosis["root_cause"] = f"diagnosis_error: {e}"
            diagnosis["human_summary"] = "AI diagnosis call failed (see logs)."

        # The 'no live trial-and-error' gate.
        diagnosis["offline_validation"] = _offline_validate(diagnosis.get("proposed_fix"), evidence)
        diagnosis["mode"] = "shadow"
        diagnosis["strategy"] = evidence.get("strategy")
        diagnosis["error_summary"] = evidence.get("error_summary")
        diagnosis["provider"] = getattr(provider, "model", type(provider).__name__)
        diagnosis["had_screenshot"] = bool(evidence.get("screenshot_b64"))
        diagnosis["created_at"] = _now()

        # Persist into run.origin (zero-migration; GET /runs/{id} already returns origin).
        origin = dict(run.origin or {})
        origin["ai_diagnosis"] = diagnosis
        run.origin = origin
        from sqlalchemy.orm.attributes import flag_modified

        flag_modified(run, "origin")
        await session.commit()
        logger.info(
            "self-heal: diagnosed run %s class=%s fix=%s offline_matched=%s",
            run_id,
            diagnosis.get("failure_class"),
            (diagnosis.get("proposed_fix") or {}).get("type") if isinstance(diagnosis.get("proposed_fix"), dict) else None,
            diagnosis.get("offline_validation", {}).get("matched_in_evidence"),
        )
        return diagnosis
