"""WorkflowSimplifier — 5-pass cleanup pipeline run at record time.

Pass 1  URL cleaning (deterministic): strip session/tracking params from navigate URLs
Pass 2  Ephemeral selector filtering + intent enrichment (deterministic)
Pass 3  Sequence collapsing (heuristic): redundant search detours, consecutive same-domain navigates
Pass 3b Checkpoint marking: phase-entry navigate steps get checkpoint=True
Pass 4  AI holistic simplification (always runs; falls back to pass-3 result on error)
"""
from __future__ import annotations

import json
import logging
import re
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from ai.client import get_ai_provider

logger = logging.getLogger(__name__)

# --- Pass 1 constants -------------------------------------------------------

SESSION_PARAMS: frozenset[str] = frozenset({
    # Google session tokens
    "sxsrf", "ei", "iflsig", "ved", "sca_esv", "oq", "gs_lp", "gs_lcp",
    "source", "uact", "sclient", "bih", "biw",
    # Universal ad/analytics tracking
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "msclkid", "twclid", "_ga",
})

GOOGLE_SEARCH_DOMAINS: frozenset[str] = frozenset({
    "www.google.com", "google.com",
    "www.google.co.uk", "google.co.uk",
    "www.google.es", "google.es",
})

SEARCH_ENGINE_DOMAINS: frozenset[str] = frozenset({
    *GOOGLE_SEARCH_DOMAINS,
    "www.bing.com", "bing.com",
    "duckduckgo.com", "www.duckduckgo.com",
    "search.yahoo.com",
})

# --- Pass 2 constants -------------------------------------------------------

# Random/session CSS IDs: #<optional-underscore><letter><15+ alphanumeric/dash/underscore>
_EPHEMERAL_CSS_ID = re.compile(r"^#[_a-zA-Z][A-Za-z0-9_\-]{14,}$")
# Pure positional XPath with no semantic anchor: /html/body/div[1]/div[2]/...
_POSITIONAL_XPATH = re.compile(r"^(/[a-zA-Z]+\[\d+\]){3,}$")


def _extract_domain(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Pass 1 — URL cleaning
# ---------------------------------------------------------------------------

def _clean_url(url: str) -> str:
    if not url or not url.startswith("http"):
        return url
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()

        if domain in GOOGLE_SEARCH_DOMAINS and parsed.path.startswith("/search"):
            qs = parse_qs(parsed.query, keep_blank_values=True)
            keep = {k: v for k, v in qs.items() if k == "q"}
            new_query = urlencode(keep, doseq=True)
            return urlunparse(parsed._replace(query=new_query))

        qs = parse_qs(parsed.query, keep_blank_values=True)
        cleaned = {k: v for k, v in qs.items() if k not in SESSION_PARAMS}
        new_query = urlencode(cleaned, doseq=True)
        return urlunparse(parsed._replace(query=new_query))
    except Exception:
        return url


def _pass1_clean_urls(steps: list[dict]) -> list[dict]:
    result = []
    for step in steps:
        s = dict(step)
        if s.get("action_type") == "navigate" and s.get("value"):
            s["value"] = _clean_url(s["value"])
        result.append(s)
    return result


# ---------------------------------------------------------------------------
# Pass 2 — Ephemeral selector filtering + intent enrichment
# ---------------------------------------------------------------------------

def _is_ephemeral_selector(sel: dict) -> bool:
    sel_type = (sel.get("type") or "").lower()
    value = sel.get("value") or ""

    if sel_type == "css":
        if _EPHEMERAL_CSS_ID.match(value):
            return True
        # Deep nth-of-type chains (4+ levels)
        if value.count(":nth-of-type") >= 4:
            return True

    if sel_type == "xpath" and _POSITIONAL_XPATH.match(value):
        return True

    return False


def _synthesize_intent(step: dict) -> str:
    action = step.get("action_type", "interact")
    value = step.get("value") or ""
    chain = step.get("selector_chain") or []
    first_sel = chain[0].get("value", "") if chain else ""

    if action == "navigate":
        return f"Navigate to {value}" if value else "Navigate to page"
    if action == "type":
        return f"Type \"{value}\"" if value else "Type text"
    if action == "click":
        hint = first_sel or value
        return f"Click {hint}" if hint else "Click element"
    if action == "scroll":
        return "Scroll page"
    if action == "select":
        return f"Select \"{value}\"" if value else "Select option"
    return f"{action.capitalize()} {value}".strip()


def _pass2_filter_selectors(steps: list[dict]) -> list[dict]:
    result = []
    for step in steps:
        s = dict(step)
        chain = s.get("selector_chain") or []
        if chain:
            filtered = [sel for sel in chain if not _is_ephemeral_selector(sel)]
            s["selector_chain"] = filtered
            if not filtered:
                s["intent_only"] = True

        intent = s.get("intent") or ""
        if len(intent.split()) < 4:
            s["intent"] = _synthesize_intent(s)

        result.append(s)
    return result


# ---------------------------------------------------------------------------
# Pass 3 — Sequence collapsing
# ---------------------------------------------------------------------------

def _same_domain(url_a: str, url_b: str) -> bool:
    return _extract_domain(url_a) == _extract_domain(url_b) != ""


def _is_search_engine_url(url: str) -> bool:
    return _extract_domain(url) in SEARCH_ENGINE_DOMAINS


def _pass3_collapse(steps: list[dict]) -> list[dict]:
    if not steps:
        return steps

    # Pattern A — Search detour collapse
    # Find navigate steps that go to a real (non-search-engine) destination.
    # Remove all preceding steps that are on search-engine domains.
    # Work from the last navigate step backwards so we keep the final destination.
    navigate_indices = [i for i, s in enumerate(steps) if s.get("action_type") == "navigate"]

    final_destination_idx: int | None = None
    for idx in reversed(navigate_indices):
        url = steps[idx].get("value") or ""
        if url and not _is_search_engine_url(url):
            final_destination_idx = idx
            break

    if final_destination_idx is not None and final_destination_idx > 0:
        # Check if any earlier steps are on a search engine domain
        preceding = steps[:final_destination_idx]
        search_detour_present = any(
            s.get("action_type") == "navigate" and _is_search_engine_url(s.get("value") or "")
            for s in preceding
        )
        if search_detour_present:
            # Keep only: steps after the last destination navigate (the on-site steps)
            # plus the destination navigate itself
            destination_and_after = steps[final_destination_idx:]
            logger.info(
                "Pass 3: collapsed search detour — removed %d steps before navigate to %s",
                final_destination_idx,
                steps[final_destination_idx].get("value"),
            )
            steps = destination_and_after

    # Pattern B — Consecutive same-domain navigates: keep only the last
    result: list[dict] = []
    i = 0
    while i < len(steps):
        current = steps[i]
        if current.get("action_type") == "navigate" and i + 1 < len(steps):
            next_step = steps[i + 1]
            if (next_step.get("action_type") == "navigate"
                    and _same_domain(current.get("value") or "", next_step.get("value") or "")):
                i += 1  # skip current, keep next
                continue
        result.append(current)
        i += 1

    # Pattern C — Duplicate consecutive actions
    deduped: list[dict] = []
    for i, step in enumerate(result):
        if i == 0:
            deduped.append(step)
            continue
        prev = deduped[-1]
        if (step.get("action_type") == prev.get("action_type")
                and step.get("value") == prev.get("value")
                and (step.get("selector_chain") or []) == (prev.get("selector_chain") or [])):
            continue  # duplicate — skip
        deduped.append(step)

    return deduped


def _final_non_search_navigate_index(steps: list[dict]) -> int | None:
    for i in range(len(steps) - 1, -1, -1):
        step = steps[i]
        if step.get("action_type") != "navigate":
            continue
        url = step.get("value") or ""
        if url and not _is_search_engine_url(url):
            return i
    return None


def _step_signature(step: dict) -> tuple[str, str, str]:
    action = str(step.get("action_type") or "")
    value = str(step.get("value") or "")
    selector_value = ""
    chain = step.get("selector_chain") or []
    if isinstance(chain, list):
        for sel in chain:
            if not isinstance(sel, dict):
                continue
            sel_type = (sel.get("type") or "").lower()
            if sel_type in {"text", "accessibility", "aria", "aria-label", "data-testid", "css", "xpath"}:
                selector_value = str(sel.get("value") or "")
                if selector_value:
                    break
    return action, value[:120], selector_value[:120]


def _critical_action(action_type: str) -> bool:
    return action_type in {"click", "type", "select", "submit", "extract", "copy", "paste", "tab_change"}


def _final_destination_domain(steps: list[dict]) -> str:
    idx = _final_non_search_navigate_index(steps)
    if idx is None:
        return ""
    return _extract_domain(str((steps[idx].get("value") or "")))


def _missing_post_destination_critical_actions(
    baseline_steps: list[dict],
    candidate_steps: list[dict],
) -> bool:
    baseline_dest_idx = _final_non_search_navigate_index(baseline_steps)
    candidate_dest_idx = _final_non_search_navigate_index(candidate_steps)
    if baseline_dest_idx is None or candidate_dest_idx is None:
        return False

    baseline_critical = [
        _step_signature(s)
        for s in baseline_steps[baseline_dest_idx + 1:]
        if _critical_action(str(s.get("action_type") or ""))
    ]
    if not baseline_critical:
        return False

    candidate_critical = [
        _step_signature(s)
        for s in candidate_steps[candidate_dest_idx + 1:]
        if _critical_action(str(s.get("action_type") or ""))
    ]
    if not candidate_critical:
        return True

    # Ensure baseline critical actions are preserved in order (subsequence match).
    cidx = 0
    for sig in baseline_critical:
        found = False
        while cidx < len(candidate_critical):
            if candidate_critical[cidx] == sig:
                found = True
                cidx += 1
                break
            cidx += 1
        if not found:
            return True
    return False


def _changes_destination_domain(
    baseline_steps: list[dict],
    candidate_steps: list[dict],
) -> bool:
    baseline_domain = _final_destination_domain(baseline_steps)
    if not baseline_domain:
        return False
    candidate_domain = _final_destination_domain(candidate_steps)
    if not candidate_domain:
        return True
    return baseline_domain != candidate_domain


def _drops_post_destination_interactions(
    baseline_steps: list[dict],
    candidate_steps: list[dict],
) -> bool:
    baseline_dest_idx = _final_non_search_navigate_index(baseline_steps)
    if baseline_dest_idx is None:
        return False

    baseline_has_post_actions = any(
        (s.get("action_type") or "") != "navigate"
        for s in baseline_steps[baseline_dest_idx + 1:]
    )
    if not baseline_has_post_actions:
        return False

    candidate_dest_idx = _final_non_search_navigate_index(candidate_steps)
    if candidate_dest_idx is None:
        return True

    candidate_has_post_actions = any(
        (s.get("action_type") or "") != "navigate"
        for s in candidate_steps[candidate_dest_idx + 1:]
    )
    return not candidate_has_post_actions


def _reject_ai_candidate(
    baseline_steps: list[dict],
    candidate_steps: list[dict],
) -> bool:
    if _changes_destination_domain(baseline_steps, candidate_steps):
        return True
    if _drops_post_destination_interactions(baseline_steps, candidate_steps):
        return True
    if _missing_post_destination_critical_actions(baseline_steps, candidate_steps):
        return True
    return False


# ---------------------------------------------------------------------------
# Pass 3b — Checkpoint marking
# ---------------------------------------------------------------------------

def _pass3b_mark_checkpoints(steps: list[dict], phases: list) -> list[dict]:
    if not phases:
        return steps

    phase_start_indices: set[int] = set()
    for phase in phases:
        idx = getattr(phase, "start_step_index", None)
        if idx is None and isinstance(phase, dict):
            idx = phase.get("start_step_index")
        if idx is not None:
            phase_start_indices.add(int(idx))

    result = []
    for step in steps:
        s = dict(step)
        original_idx = s.get("step_index")
        if (
            s.get("action_type") == "navigate"
            and original_idx is not None
            and int(original_idx) in phase_start_indices
        ):
            s["checkpoint"] = True
        result.append(s)
    return result


# ---------------------------------------------------------------------------
# Pass 4 — AI holistic simplification (always runs)
# ---------------------------------------------------------------------------

def _build_simplification_prompt(
    steps: list[dict],
    workflow_goal: str | None,
    target_url: str | None,
) -> str:
    import json as _json
    steps_json = _json.dumps(steps, indent=2)
    critical_hints_json = _json.dumps(_critical_hints_for_prompt(steps), indent=2)
    goal_str = workflow_goal or "not specified"
    target_str = target_url or "not specified"
    return (
        f"You are a browser automation optimizer.\n"
        f"Workflow recorded on: {target_str}\n"
        f"Goal: \"{goal_str}\"\n\n"
        f"Recorded steps after initial cleaning ({len(steps)} steps):\n"
        f"{steps_json}\n\n"
        f"Critical action hints inferred from the full plan:\n"
        f"{critical_hints_json}\n\n"
        "Problems to address:\n"
        "1. Any navigate step with remaining session params → strip them further\n"
        "2. Any step with no selectors and weak intent → strengthen the intent for AI-based finding\n"
        "3. Any step sequence that represents getting to a URL already captured in a later navigate "
        "→ collapse to the direct navigate\n"
        "4. Any typo in typed values (context: goal above) → correct them\n"
        "5. Steps on intermediate pages that are bypassed by a later navigate → remove them\n\n"
        "Return ONLY a JSON array (same structure, same fields). Rules:\n"
        "- Minimum 1 step\n"
        "- Never add steps that weren't in the input\n"
        "- Never remove the final meaningful navigate or click that achieves the goal\n"
        "- Preserve all steps that happen on the destination page after arrival\n"
        "- Use the critical action hints to keep goal-achieving actions. You may remove only actions "
        "that are clearly redundant and not required for the goal.\n"
        "- Return each step with: action_type, intent, selector_chain, value, checkpoint\n"
        "- Output only the JSON array, no explanation or markdown."
    )


def _critical_hints_for_prompt(steps: list[dict]) -> list[dict]:
    hints: list[dict] = []
    final_dest_idx = _final_non_search_navigate_index(steps)
    for i, step in enumerate(steps):
        action = str(step.get("action_type") or "")
        if not _critical_action(action):
            continue
        hint = {
            "step_index": i,
            "action_type": action,
            "intent": step.get("intent"),
            "value": step.get("value"),
            "selector_chain": step.get("selector_chain") or [],
            "is_after_destination": bool(final_dest_idx is not None and i > final_dest_idx),
        }
        hints.append(hint)
    return hints


async def _pass4_ai_simplify(
    steps: list[dict],
    workflow_goal: str | None,
    target_url: str | None,
) -> list[dict]:

    prompt = _build_simplification_prompt(steps, workflow_goal, target_url)
    try:
        provider = get_ai_provider()
        response = await provider.generate(
            prompt,
            system="You are a browser automation optimizer. Return only valid JSON arrays.",
            max_tokens=4096,
        )
        content = response.content.strip()
        # Strip markdown code fences if present
        if content.startswith("```"):
            content = re.sub(r"^```[a-z]*\n?", "", content)
            content = re.sub(r"\n?```$", "", content)
            content = content.strip()

        parsed = json.loads(content)
        if not isinstance(parsed, list) or len(parsed) == 0:
            logger.warning("Pass 4: AI returned empty/non-list; keeping pass-3 result")
            return steps

        # Validate each step has action_type
        for item in parsed:
            if not isinstance(item, dict) or "action_type" not in item:
                logger.warning("Pass 4: AI step missing action_type; keeping pass-3 result")
                return steps

        logger.info("Pass 4: AI simplified %d → %d steps", len(steps), len(parsed))
        return parsed

    except json.JSONDecodeError as exc:
        logger.warning("Pass 4: AI returned invalid JSON (%s); keeping pass-3 result", exc)
        return steps
    except Exception as exc:
        logger.warning("Pass 4: AI call failed (%s); keeping pass-3 result", exc)
        return steps


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

class WorkflowSimplifier:
    def __init__(self, workflow_goal: str | None = None, target_url: str | None = None):
        self.workflow_goal = workflow_goal
        self.target_url = target_url

    async def simplify(
        self,
        steps: list[dict],
        phases: list | None = None,
    ) -> list[dict]:
        if not steps:
            return steps

        logger.info("WorkflowSimplifier: starting with %d steps", len(steps))

        # Normalize: ensure each step is a plain dict
        normalized = []
        for i, s in enumerate(steps):
            if hasattr(s, "__dict__") or hasattr(s, "_asdict"):
                # SQLAlchemy ORM object
                d = {
                    "action_type": getattr(s, "action_type", ""),
                    "intent": getattr(s, "intent", None),
                    "selector_chain": getattr(s, "selector_chain", None) or [],
                    "value": getattr(s, "value", None),
                    "step_index": getattr(s, "step_index", i),
                    "checkpoint": getattr(s, "checkpoint", False),
                    "methods": getattr(s, "methods", None),
                }
            else:
                d = dict(s)
                if "step_index" not in d:
                    d["step_index"] = i
            normalized.append(d)

        p1 = _pass1_clean_urls(normalized)
        p2 = _pass2_filter_selectors(p1)
        p3 = _pass3_collapse(p2)
        p3b = _pass3b_mark_checkpoints(p3, phases or [])

        # Pass 4 always runs — AI is a core system requirement
        p4 = await _pass4_ai_simplify(p3b, self.workflow_goal, self.target_url)
        if _reject_ai_candidate(p3b, p4):
            logger.warning(
                "Pass 4 candidate rejected by safety invariants; keeping pass-3 result"
            )
            p4 = p3b

        # Re-index steps sequentially
        for i, step in enumerate(p4):
            step["step_index"] = i

        logger.info(
            "WorkflowSimplifier: done — %d → %d steps",
            len(steps),
            len(p4),
        )
        return p4
