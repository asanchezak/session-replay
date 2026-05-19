SELECTOR_HEAL_SYSTEM = """You are a DOM analysis assistant. Given:
1. A snippet of the current page DOM around where the target element should be
2. The accessibility tree snippet for the same region
3. The old selectors that worked on a previous version of the page
4. The user's intent for this action

Return a JSON object with:
- "selector": The best CSS selector for the target element on the current page
- "confidence": A float between 0.0 and 1.0
- "explanation": Brief explanation of what changed and how you found it
- "fallback_selectors": Array of alternative selectors

Use text content, accessibility attributes, and DOM structure to find the element.
Only return valid JSON, no other text."""

CLASSIFY_CHALLENGE_SYSTEM = """You are a page state classifier. Given a snapshot of the current page, determine if the user needs to intervene.

Classify as one of:
- "clean": No intervention needed, automation can continue
- "captcha": CAPTCHA or bot challenge detected
- "login": Login or authentication form detected
- "2fa": Two-factor authentication challenge
- "modal": Unexpected dialog or modal blocking interaction
- "error": Error page or message
- "ambiguous": Cannot determine, needs human review

Return JSON: {"classification": str, "confidence": float, "reason": str}"""

EXTRACT_SYSTEM = """You are a data extraction assistant. Given page content and a schema, extract structured data.

Return a JSON array of objects matching the requested schema.
If no data is found, return an empty array.
Only return valid JSON."""


def build_heal_prompt(
    dom_snippet: str,
    at_snippet: str | None,
    old_selectors: list[str],
    intent: str,
    visible_text: str | None = None,
    page_url: str | None = None,
) -> str:
    parts = []
    if page_url:
        parts.append(f"## Current page URL: {page_url}")
    parts.append(f"## Current DOM snippet:\n{dom_snippet[:2000]}")
    if at_snippet:
        parts.append(f"\n## Accessibility tree:\n{at_snippet[:1000]}")
    if visible_text:
        parts.append(f"\n## Visible text on page:\n{visible_text[:1500]}")
    parts.append(f"\n## Old selectors:\n{', '.join(old_selectors)}")
    parts.append(f"\n## User intent:\n{intent}")
    return "\n".join(parts)


def build_classify_prompt(page_text: str, visible_elements: list[str]) -> str:
    return (
        f"## Page text content:\n{page_text[:1500]}\n"
        f"## Visible interactive elements:\n{', '.join(visible_elements[:30])}"
    )


def build_extract_prompt(page_content: str, extraction_schema: dict) -> str:
    import json
    return (
        f"## Page content:\n{page_content[:3000]}\n"
        f"## Expected schema:\n{json.dumps(extraction_schema, indent=2)}"
    )


SEMANTIC_ANALYSIS_SYSTEM = """You are a workflow intelligence analyst. Your job is to understand the USER'S GOAL — why they performed these browser actions.

Given a workflow with step-by-step browser actions, you must infer:
1. What business objective the user is trying to accomplish
2. What semantic phases the workflow can be grouped into
3. Which literal values should become runtime parameters (search terms, locations, filters)
4. What structured output the workflow produces
5. Which steps are fixed (navigation infrastructure) vs variable (runtime-configurable)

RULES:
- A value should become a parameter if: it's a search term, location, filter value, recipient name, or message content — things the user would want to change between runs.
- A value should remain literal if: it's a URL for the target platform, a button selector, or navigation structure.
- Group steps into phases based on URL changes, repeated patterns, and semantic purpose shifts.
- Be conservative: if uncertain whether a value should be a parameter, mark it as such with low confidence.
- The output schema describes what the workflow EXTRACTS or PRODUCES (structured data, submitted forms, etc.).

Return ONLY valid JSON in this exact structure:
{
  "workflow_goal": "one-sentence description of the user's business objective",
  "workflow_summary": "2-3 sentence summary of what this workflow does",
  "domain_context": "job_search|data_extraction|form_filling|outreach|crm_sync|authentication|general",
  "confidence_overall": 0.0-1.0,
  "phases": [
    {"index": 0, "name": "Phase Name", "goal": "What this phase accomplishes", "steps": [0, 1, 2]}
  ],
  "actions": [
    {"step_index": 0, "semantic_type": "open_platform|set_search_query|apply_filter|open_detail|extract_data|submit_form|authenticate|paginate|interact|scroll_page|other", "description": "what this step does semantically", "confidence": 0.0-1.0}
  ],
  "parameters": [
    {"key": "unique_key", "type": "string|number|boolean|list", "default": "value from recording", "step_index": 0, "description": "what this parameter controls", "confidence": 0.0-1.0, "required": true}
  ],
  "output_spec": {
    "type": "structured_data|submitted_form|sent_message|exported_record|unknown",
    "schema": {"type": "array", "items": {"type": "object", "properties": {"field_name": {"type": "string"}}}},
    "confidence": 0.0-1.0
  },
  "fixed_steps": [0, 1],
  "variable_steps": [2, 3],
  "ambiguity_notes": [{"step_index": 4, "note": "Could be X or Y", "confidence": 0.5}],
  "replay_strategy": "literal|parameterized|semantic",
  "healing_hints": "Guidance for finding elements if selectors break",
  "generalization_notes": "What reusable patterns exist"
}"""


def build_semantic_analysis_prompt(
    workflow_name: str,
    steps_summary: str,
    parameter_candidates: str,
    phase_boundaries: str,
    target_url: str | None = None,
    prompt_text: str | None = None,
) -> str:
    parts = [
        f"## Workflow Name: {workflow_name}",
    ]
    if target_url:
        parts.append(f"## Target URL: {target_url}")
    if prompt_text:
        parts.append(f"## User-Provided Prompt: {prompt_text}")
    parts.append(f"\n## Recorded Steps:\n{steps_summary[:3000]}")
    parts.append(f"\n## Heuristic Parameter Candidates:\n{parameter_candidates[:1500]}")
    parts.append(f"\n## Detected Phase Boundaries (step indices):\n{phase_boundaries[:500]}")
    parts.append("\n## Instructions:")
    parts.append("Analyze this workflow and infer the user's business objective. ")
    parts.append("Identify semantic phases, parameterizable values, expected outputs, and replay strategy. ")
    parts.append("Return only the JSON object as specified.")
    return "\n".join(parts)


def build_simplification_prompt(
    steps: list[dict],
    workflow_goal: str | None,
    target_url: str | None,
) -> str:
    import json as _json
    steps_json = _json.dumps(steps, indent=2)
    goal_str = workflow_goal or "not specified"
    target_str = target_url or "not specified"
    return (
        f"You are a browser automation optimizer.\n"
        f"Workflow recorded on: {target_str}\n"
        f"Goal: \"{goal_str}\"\n\n"
        f"Recorded steps after initial cleaning ({len(steps)} steps):\n"
        f"{steps_json}\n\n"
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
        "- Return each step with: action_type, intent, selector_chain, value, checkpoint\n"
        "- Output only the JSON array, no explanation or markdown."
    )


AGENT_EXECUTOR_SYSTEM = """You are an autonomous browser workflow agent.

NAVIGATE VALIDATION: After every navigate step, compare the Target URL with the Actual URL.
- Same domain → proceed normally
- Different domain (redirect, auth wall, 404) → act on the mismatch:
  * Login/auth page detected → PAUSE with pause_reason "authentication required"
  * 404 or error page → ADAPT: navigate directly to the known correct URL
  * Consent/cookie banner page → ADAPT: dismiss banner, then proceed
- Never silently accept a wrong-domain landing as success.

GROUND RULES:
- The recorded blueprint is GUIDANCE, not a script. The page is the source of truth.
- Each step has an INTENT (what the user wanted to accomplish). Honor the intent
  even if the recorded selectors/values no longer match the page.
- The user's WORKFLOW GOAL takes priority over any individual step's specifics.
  If you can shortcut to the goal (e.g. navigate directly to a known target URL
  instead of clicking a stale search result), prefer that.

SELECTOR QUALITY:
- Auto-generated CSS ids that look session-specific are unreliable. Examples:
  `#_IvMFavSHKoOzqtsP4p6usQs_40`, `#abc-3f4a1c9e`, `#R7p2x9...` — any short id
  with a hash-like or random suffix.
- Prefer accessibility selectors (role+name), visible text content, data-testid,
  and aria-label. These survive across sessions.
- If the recorded selectors look fragile but you can see a clearly equivalent
  element on the page (matching the intent), ADAPT with stable selectors.

DECISIONS (return one):
1. EXECUTE — recorded step looks fine, run it as-is
2. ADAPT  — change selectors / action / value to fit the current page state
3. SKIP   — step is unnecessary on this page (already done, or no longer applies)
4. WAIT   — the page is transitional or still loading; wait 500-5000ms and re-poll
5. RESTART — abandon the current path and restart from the workflow target URL
6. ROLLBACK — return to a recorded checkpoint step K and continue from there
7. PAUSE  — only if no reasonable path forward exists or the page truly needs a human

For ADAPT you may change action_type entirely. Examples:
- A broken "click search result" can become a "navigate" to the target site
- A "type" with stale value can become a fresh "type" with the original intent's value

Return ONLY valid JSON:
{
  "decision": "EXECUTE|ADAPT|SKIP|WAIT|RESTART|ROLLBACK|PAUSE",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of your decision (one sentence).",
  "command": {
    "action": "navigate|click|type|select|scroll|extract",
    "selector_chain": [{"type": "css|accessibility|text|xpath|aria-label|data-testid", "value": "...", "score": 0.0-1.0}],
    "value": "URL for navigate, text for type, etc.",
    "intent": "what this step accomplishes"
  },
  "wait_ms": 1500,
  "rollback_to": 0,
  "plan_updates": [
    {"operation": "INSERT|REMOVE|MODIFY|REORDER", "step_index": <int>,
     "new_step": {"action_type": "...", "selector_chain": [...], "value": "...", "intent": "..."},
     "reason": "why"}
  ],
  "pause_reason": "only for PAUSE decisions"
}

The command field is REQUIRED for EXECUTE and ADAPT. For ADAPT the command should
reflect the new approach (new selectors, possibly new action). Confidence 0.5+
is enough to ADAPT — don't be overly cautious.

WAIT should be preferred over PAUSE when the page looks mid-load, recently
navigated, or key content is likely still rendering.
RESTART should restore the run to the target URL when the current trajectory is
globally bad but the workflow goal is still achievable.
ROLLBACK is valid only when checkpoint steps are available. Always provide the
target step index in `rollback_to`.

`plan_updates` is OPTIONAL but powerful. Use it when the blueprint itself needs
to change, not just the current step's parameters. Examples:
- INSERT: a cookie banner is blocking — add a step to dismiss it BEFORE the
  recorded steps continue. step_index = where to insert (existing steps push
  right). Combine with `decision: ADAPT` whose command does the same dismiss
  so the extension runs it immediately.
- REMOVE: a recorded step is no longer needed because the page changed (e.g.,
  a confirmation dialog is gone). Pair with `decision: SKIP`.
- REORDER: the page now requires two steps in the opposite order.
- MODIFY: same as adapting `command` but expressed as a snapshot mutation
  (useful when the change applies to a different step than the current one).

You may emit `plan_updates` alongside any decision. They are applied BEFORE the
decision's command runs, so the snapshot is updated even if the current step
also has an ADAPT command.

REASONING PROTOCOL — include in every response:
Add a "thinking_steps" array (3–5 entries) as a sibling to "decision". Each entry:
  {"step": <int>, "question": "<what you asked yourself>",
   "observation": "<what you saw in page/context>",
   "conclusion": "<what you concluded>"}
Example:
[{"step":1,"question":"Is the recorded selector present?",
  "observation":"#btn-xK9 not found in visible elements",
  "conclusion":"Selector is stale, likely session-generated id"},
 {"step":2,"question":"Is an equivalent element visible?",
  "observation":"button[type=submit] with text 'Log in' is in interactive elements",
  "conclusion":"Element exists; selector needs healing"},
 {"step":3,"question":"What is the best decision?",
  "observation":"Stable button[type=submit] available, confidence high",
  "conclusion":"ADAPT with healed selector"}]"""


def build_agent_decision_prompt(
    workflow_goal: str | None,
    current_phase: str | None,
    step_index: int,
    step_intent: str | None,
    step_action: str,
    step_selectors: list[dict],
    step_value: str | None,
    page_url: str,
    page_title: str,
    visible_text: str,
    visible_elements: list[dict],
    previous_failures: list[dict] | None = None,
    workflow_summary: str | None = None,
    page_diff: dict | None = None,
    goal_progress: dict | None = None,
    run_memory: dict | None = None,
    checkpoint_steps: list[int] | None = None,
    step_stability_score: float | None = None,
    workflow_expertise: str | None = None,
    page_context_error: str | None = None,
    actual_url: str | None = None,
) -> str:
    parts = ["## Workflow Context"]
    if workflow_goal:
        parts.append(f"Goal: {workflow_goal}")
    if workflow_summary:
        parts.append(f"Summary: {workflow_summary}")
    if current_phase:
        parts.append(f"Current phase: {current_phase}")

    if goal_progress and isinstance(goal_progress, dict):
        phase_summary = []
        for ph in (goal_progress.get("phases") or []):
            marker = {"done": "✓", "active": "▶", "pending": "·"}.get(ph.get("status"), "?")
            phase_summary.append(f"  {marker} {ph.get('name')}: {ph.get('goal', '')[:80]}")
        if phase_summary:
            parts.append("Phase progress:")
            parts.extend(phase_summary)
        outstanding = [
            it for it in (goal_progress.get("intents") or [])
            if it.get("status") not in {"satisfied", "skipped"}
        ]
        if outstanding:
            parts.append("Outstanding intents (next steps to satisfy):")
            for it in outstanding[:5]:
                parts.append(
                    f"  · step {it.get('step_index')}: {it.get('intent', '')[:100]}"
                )

    if run_memory and isinstance(run_memory, dict):
        decisions = list(run_memory.get("decisions") or [])
        traces = list(run_memory.get("traces") or [])
        if decisions or traces:
            parts.append("\n## Run History (oldest to newest)")
            for d in decisions[-10:]:
                parts.append(
                    f"  [step {d.get('step', '?')}] {d.get('decision', '?')} "
                    f"(conf {float(d.get('confidence', 0.0)):.2f}) "
                    f"-> {d.get('outcome') or '?'}: {str(d.get('summary', ''))[:120]}"
                )
            for t in traces[-5:]:
                parts.append(
                    f"  [step {t.get('step', '?')} recovery via {t.get('trigger', '?')}] "
                    f"error: {str(t.get('error', ''))[:100]} -> "
                    f"suggested {t.get('suggested_action') or '?'} -> "
                    f"{t.get('outcome') or '?'}"
                )
            parts.append(
                "Do not repeat strategies above that already failed. "
                "If WAIT has already happened multiple times without progress, "
                "escalate to ADAPT, plan_updates, ROLLBACK, or RESTART."
            )

    # Cross-run expertise: patterns learned from prior runs of this workflow.
    # Use this to handle known-fragile steps proactively instead of reactively.
    if workflow_expertise:
        parts.append(f"\n{workflow_expertise}")

    parts.append(f"Step {step_index} (recorded action: {step_action})")
    if step_intent:
        parts.append(f"Intent: {step_intent}")
    if step_value:
        parts.append(f"Recorded value: {step_value}")
    if step_selectors:
        sel_strs = [
            f"  {s.get('type', '?')}: {s.get('value', '?')} (score: {s.get('score', '?')})"
            for s in step_selectors[:5]
        ]
        parts.append("Recorded selectors (guidance only — verify against page):")
        parts.extend(sel_strs)

    # Selector stability from historical runs (Phase 5 EMA learning).
    # Use this to decide how aggressively to ADAPT vs. EXECUTE as-is.
    if step_stability_score is not None:
        pct = int(round(step_stability_score * 100))
        if step_stability_score >= 0.8:
            label = f"STABLE ({pct}%) — recorded selectors are reliable; prefer EXECUTE"
        elif step_stability_score >= 0.5:
            label = f"MODERATE ({pct}%) — selectors occasionally need healing; verify on page before executing"
        else:
            label = (
                f"FRAGILE ({pct}%) — selectors fail frequently; "
                "ADAPT proactively using text/role/aria selectors from the page"
            )
        parts.append(f"Historical selector stability: {label}")

    if checkpoint_steps:
        parts.append(f"Available checkpoint steps: {checkpoint_steps}")

    parts.append("\n## Current Page State (source of truth)")
    parts.append(f"URL: {page_url}")
    parts.append(f"Title: {page_title}")

    if step_action == "navigate" and step_value:
        from urllib.parse import urlparse as _up
        try:
            expected_host = _up(step_value).netloc.lower()
            actual_host = _up(actual_url or page_url).netloc.lower()
            url_match = expected_host == actual_host
        except Exception:
            url_match = True
        parts.append(f"Target URL: {step_value}")
        parts.append(f"Actual URL: {actual_url or page_url}")
        parts.append(f"URL match: {'YES' if url_match else 'NO — landed on different domain'}")
        if not url_match:
            parts.append(
                "WARNING: The navigate step landed on a different domain than expected. "
                "Apply NAVIGATE VALIDATION rules from the system prompt."
            )
    if page_context_error:
        parts.append(f"Page context error: {page_context_error}")
    if visible_text:
        parts.append(f"Visible text (truncated):\n{visible_text[:1500]}")
    if visible_elements:
        elem_strs = [
            f"  {e.get('tag', '?')} role={e.get('role', '')} text={e.get('text', '')[:60]}"
            for e in visible_elements[:25]
        ]
        parts.append("Interactive elements:")
        parts.extend(elem_strs)

    if previous_failures:
        parts.append("\n## Previous Failures on this run")
        for f in previous_failures[:5]:
            parts.append(
                f"  - step {f.get('step_index', '?')} ({f.get('action', '?')}): "
                f"{f.get('error', 'unknown')}"
            )
        parts.append(
            "Do NOT repeat a strategy that already failed above. Try something different."
        )

    if page_diff:
        diff_parts: list[str] = []
        if page_diff.get("url_changed"):
            diff_parts.append(
                f"  - URL changed from {page_diff.get('previous_url', '?')} → current URL"
            )
        if page_diff.get("title_changed"):
            diff_parts.append(
                f"  - Title changed from \"{page_diff.get('previous_title', '?')}\""
            )
        added = page_diff.get("added") or []
        removed = page_diff.get("removed") or []
        for a in added[:10]:
            diff_parts.append(
                f"  + appeared: [{a.get('role', a.get('tag'))}] \"{a.get('text', '')[:60]}\""
            )
        for r in removed[:10]:
            diff_parts.append(
                f"  - disappeared: [{r.get('role', r.get('tag'))}] \"{r.get('text', '')[:60]}\""
            )
        if diff_parts:
            parts.append("\n## Page Diff (since last poll)")
            parts.extend(diff_parts)
            parts.append(
                "If the page navigated or looks partially loaded, prefer WAIT "
                "(1500-3000ms) before PAUSE. If the page replaced its content "
                "and the recorded step no longer matches, consider ADAPT, "
                "ROLLBACK to a checkpoint, or RESTART."
            )

    parts.append("\n## Decision Required")
    parts.append(
        "Pick ONE of: EXECUTE, ADAPT, SKIP, WAIT, RESTART, ROLLBACK, PAUSE. "
        "Prefer ADAPT with stable selectors (role/text/data-testid) when the recorded "
        "selectors look session-specific or don't match the page. "
        "Prefer WAIT over PAUSE for transitional pages. "
        "If the workflow goal can be reached more directly (e.g. navigate to a target URL "
        "instead of clicking a stale link), use ADAPT with action=navigate. "
        "Only PAUSE when the page truly requires a human or every bounded path is exhausted."
    )
    return "\n".join(parts)
