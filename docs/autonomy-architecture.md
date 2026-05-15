# Autonomy Architecture — From Strict Replay to Goal-Driven Agent

## Today's behavior (why runs like `0dd2bccd-...` fail)

The blueprint is treated as the **strict source of truth**:

- `agent_service.poll()` reads `workflow_snapshot["steps"][step_index]` and
  returns `EXECUTE` with the recorded selectors. AI is consulted only after
  failures (`_should_consult_ai` returned `False` by default).
- Healing only edits the `selector_chain` of a single failed step. It cannot
  insert, remove, reorder, or replace steps.
- `previous_failures` was hardcoded to `None` in the planner prompt, so the
  LLM had no memory of what already failed on this run.
- The extension polls `/agent/poll` synchronously, executes one command,
  posts a result, and increments a cursor — there is no parallel planning.
- Page state is captured at every poll but is not used to score how close
  we are to the workflow goal; it's only used to detect blocking challenges.

For run `0dd2bccd`, step 2 wanted to click a Google search result by
`#_IvMFavSHKoOzqtsP4p6usQs_40` — a session-specific id that doesn't exist on
a fresh search. The recorded text selector "Buscar empleo en Indeed Costa
Rica…" is a stable anchor, but the executor tried css first, healing was
asked to suggest new selectors, low confidence, run paused.

## Shipped in this branch (surgical autonomy fix)

1. **Proactive AI consult** — `_should_consult_ai` now triggers when
   recorded selectors look fragile (session-like ids, no stable
   accessibility/text/data-testid anchor) **or** when prior retries
   exist, instead of only after failure.
2. **Failure memory** — `_load_previous_failures` reads `step_executed` and
   `recovery_failure` events from the audit log and feeds them to the
   planner prompt so the LLM does not repeat a strategy that already failed.
3. **Goal-aware recovery** — `_analyze_failure` now passes the workflow
   goal and lets the LLM suggest a completely different action
   (`suggested_action: navigate` + `suggested_value: <url>`) when the
   recorded step is unreachable. The extension honors `suggested_action`
   and `suggested_value`, so a stale "click search result" can become
   "navigate directly to the target site."
2. **Prompt rewrite** — `AGENT_EXECUTOR_SYSTEM` and
   `build_agent_decision_prompt` now explicitly:
   - Frame the blueprint as guidance, the page as ground truth
   - Call out session-id-shaped selectors as fragile
   - Allow `ADAPT` to change `action_type` and `value`, not just selectors
   - Add `RETRY` (loading page) as a first-class decision
   - Include `workflow_summary` and a list of prior failures
3. **Extension** — service-worker handles `ADAPT` with a suggested
   `navigate` URL, and a top-level `SKIP` decision returned from
   `/agent/result`.

These changes are surgical and backwards-compatible: when no AI key is
configured the fast path is unchanged, and existing unit tests still pass.

## Recommended next steps (larger architecture moves)

### 1. Blueprint as recipe, not cursor

Replace `current_step_index` as the run's primary cursor with a
**goal-progress vector**:

```
{
  "goal": "Find Indeed jobs in Costa Rica",
  "phases_completed": ["open_platform"],
  "phase_in_progress": "set_search_query",
  "outstanding_intents": ["click result", "open detail"],
  "evidence": { "url": "...", "matched_phase_signals": [...] }
}
```

The agent loop becomes: "what intent must I satisfy next to advance the
goal?" The blueprint contributes candidate steps; the LLM picks/orders
them based on the page. This is how you go from "replay" to "agent."

### 2. Plan-update operations as first-class decisions

`PlanUpdate` already exists in `agent_models.py` (ADD/REMOVE/MODIFY/
REORDER/SIMPLIFY) but is never used. Wire it through `PollResponse` and
the extension so the LLM can return:

```json
{
  "decision": "ADAPT",
  "plan_updates": [
    { "operation": "REMOVE", "step_index": 2, "reason": "stale result link" },
    { "operation": "ADD", "step_index": 2, "new_step":
        { "action_type": "navigate", "value": "https://cr.indeed.com" } }
  ]
}
```

`HealingService.apply_heal()` should be generalized to `apply_plan_update()`.

### 3. Page-state evaluator (signal extraction)

Add a small service that, given a page snapshot and the workflow's
semantic analysis (`workflow_goal`, `phases`, `actions`), computes a
"distance to goal" score. Examples:

- URL matches expected phase signal → +1 phase done
- Element matching a phase's intent visible → can advance
- Unexpected modal/error overlay → blocker

This feeds the planner: instead of "what does step N say?" the planner
asks "where are we relative to the goal?"

### 4. Pipelined planning

Today the extension waits for `/agent/poll` synchronously. Move to:

- Extension executes step N
- Backend, in parallel, computes the *expected* page state after step N
  and pre-plans step N+1
- When the extension reports success, the next decision is already cached

This cuts LLM latency from a sequential cost (`N * 1s`) to roughly a
single LLM call's worth of overhead per run.

### 5. Adaptive safety limits

`SAFETY_LIMITS.max_adapt_per_run = 5` is a hard ceiling and kills
autonomy on long workflows. Replace with:

- Per-phase adapt budget (resets when a phase advances)
- Confidence-weighted budget (high-confidence adaptations cost less)
- Token budget driven by `max_tokens_per_run`

### 6. Stable-selector preference at record time

The replay engine's `_SESSION_ID_PATTERNS` heuristic in `agent_service.py`
is reactive. At record time, score CSS selectors that contain
hash-like ids low (≤0.3) and boost accessibility / text / data-testid
selectors. This is a backend-only change in
`SemanticAnalysisService.score_selector()` (or wherever scoring lives).

### 7. End-to-end LLM observation

Surface every prompt + response pair as `agent_decision` events with the
full LLM transcript in `payload.reasoning` and `payload.raw_prompt`.
RunDetailPage already shows `agent_decision` events — extend it to render
the prompts (collapsed) so engineers can audit why the agent chose
what it chose.

## Files touched in this branch

- `backend/services/agent_service.py` — proactive AI consult, failure
  memory, navigate-or-skip recovery
- `backend/ai/prompts.py` — rewritten system + decision prompts
- `extension/src/background/service-worker.ts` — adapt-navigate, skip
- `docs/autonomy-architecture.md` — this doc
