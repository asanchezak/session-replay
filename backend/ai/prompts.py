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


AGENT_EXECUTOR_SYSTEM = """You are an autonomous browser workflow agent.

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
4. RETRY  — page seems to be still loading; brief retry is appropriate
5. PAUSE  — only if no reasonable path forward exists (truly ambiguous, blocked)

For ADAPT you may change action_type entirely. Examples:
- A broken "click search result" can become a "navigate" to the target site
- A "type" with stale value can become a fresh "type" with the original intent's value

Return ONLY valid JSON:
{
  "decision": "EXECUTE|ADAPT|SKIP|RETRY|PAUSE",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of your decision (one sentence).",
  "command": {
    "action": "navigate|click|type|select|scroll|extract",
    "selector_chain": [{"type": "css|accessibility|text|xpath|aria-label|data-testid", "value": "...", "score": 0.0-1.0}],
    "value": "URL for navigate, text for type, etc.",
    "intent": "what this step accomplishes"
  },
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
also has an ADAPT command."""


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

    parts.append("\n## Current Page State (source of truth)")
    parts.append(f"URL: {page_url}")
    parts.append(f"Title: {page_title}")
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
                "If only minor elements changed and the recorded step still matches, "
                "EXECUTE quickly. If the page navigated or replaced its content, "
                "consider ADAPT or PlanUpdate.insert."
            )

    parts.append("\n## Decision Required")
    parts.append(
        "Pick ONE of: EXECUTE, ADAPT, SKIP, RETRY, PAUSE. "
        "Prefer ADAPT with stable selectors (role/text/data-testid) when the recorded "
        "selectors look session-specific or don't match the page. "
        "If the workflow goal can be reached more directly (e.g. navigate to a target URL "
        "instead of clicking a stale link), use ADAPT with action=navigate."
    )
    return "\n".join(parts)
