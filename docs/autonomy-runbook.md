# Autonomy Runbook

Operational guide for the AI-driven runtime. Read this before starting,
debugging, or restarting a stuck run.

Pairs with the architecture doc at `docs/autonomy-architecture-v2.md`.

## TL;DR

- **The AI is the cursor, not the safety net.** Every poll consults the LLM
  unless AI is unconfigured.
- **Stuck runs auto-recover.** A backend supervisor wakes paused runs every
  30 s and gives the LLM another shot.
- **The blueprint is a recipe, not a script.** The AI can INSERT, REMOVE,
  MODIFY, or REORDER steps mid-run via `PlanUpdate` ops.
- **Every decision is logged.** `ai_decision_outcomes` rows tie confidence
  to outcome so you can see when the model is miscalibrated.

## Quick start

```bash
# 1. Start backend, frontend, and Seq
make dev

# 2. Reload the extension at chrome://extensions/ so it picks up
#    the latest DEV_DEFAULTS.apiBase (currently http://localhost:8091/v1).

# 3. Open the dashboard
open http://localhost:5173/dashboard

# 4. Trigger a workflow from /workflows/<id> and watch /runs/<run_id>
```

If a run gets stuck or you want to verify the autonomy loop in CI:

```bash
make autonomy-e2e
```

This runs the per-phase unit tests, hits the live backend, generates a
Markdown report at `test-results/autonomy-report-latest.md`.

## What "AI-driven" means in this codebase

| Layer | File | Behaviour |
|---|---|---|
| L1 — AI-first loop | `services/agent_service.py` | LLM consulted on every poll. Fast-path EXECUTE fires only when no AI is configured. |
| L2 — Goal-first cursor | `services/execution_service.py` + `_seed_goal_progress` | Each `ExecutionRun` carries a `goal_progress` JSON with phases (from semantic analysis) and intents (one per recorded step). |
| L2 — Page-state diff | `extension/src/background/command-executor.ts` | Per-tab `PageContext` cache; emits `{added, removed, url_changed, title_changed}` to the backend on every poll. |
| L3 — PlanUpdate | `services/healing_service.apply_plan_update` | MODIFY / INSERT / REMOVE / REORDER ops mutate `run.workflow_snapshot.steps` atomically with an audit event. |
| L4 — Auto-recovery | `services/recovery_supervisor.py` | Background task scans `waiting_for_user` runs every 30 s; capped at 5 attempts. |
| L5 — Telemetry | `services/ai_outcome_service.py` | One row per decision in `ai_decision_outcomes`; resolved on `report_result`. |
| L5 — Learning | `services/learning_service.py` | After each terminal run, updates `WorkflowStep.selector_stability_score` (EMA) and `WorkflowParameter.validation_count`. |

## Reading the dashboard

On a run detail page (`/runs/<id>`) you'll see:

1. **Status banner** — current run state from the state machine.
2. **Goal Progress ribbon** (new) — phases derived from the workflow's
   semantic analysis. `▶` is active, `✓` is done, `·` is pending.
3. **Step Timeline tab** — every recorded step, status icon from the run.
4. **Events tab** — full audit log. Watch for these event types:
   - `agent_decision` — every LLM consult or fast-path
   - `plan_update` — the AI rewrote the recipe
   - `run_auto_resumed` — the supervisor unstuck a run
   - `recovery_attempt` / `recovery_success` / `recovery_failure` — Phase-3 healing
5. **Extraction tab** — structured data if the workflow has an `output_spec`.

Action buttons (top right):

- **Pause** — manually pause a running run.
- **Resume** — manually resume a `waiting_for_user` run with no extra AI work.
- **Resume with AI** (new) — call `POST /v1/agent/<id>/resume`; the supervisor
  produces a fresh PlanUpdate and transitions back to running.
- **Stop** — cancel the run.
- **Retry from failure** — only shown on terminal failed runs.

## Reading the agent_decision events

Each decision payload has `decision`, `confidence`, `reasoning`, and optional
`command` / `plan_updates` / `ai_analysis`.

| `reasoning` prefix | Means |
|---|---|
| `Fast path: …` | AI not configured (or budget exhausted); deterministic execute. |
| `AI confirmed EXECUTE: …` | LLM consulted, said the recorded step looks fine. |
| `AI-adapted step` | LLM proposed a different command (selectors / action / value). |
| `AI recommends skipping …` | LLM judged the step unnecessary on this page. |
| `Last-chance AI adaptation …` | Retries + heals were exhausted; LLM produced a final recovery. |
| `Blocking challenge: captcha/login_form/…` | Page state detector tripped; run paused for human. |

## When a run gets stuck

1. **Check the events feed.** Look for the most recent `recovery_failure`
   or `run_waiting_for_user` to see what triggered the pause.
2. **Wait 30–60 s.** The recovery supervisor will try the LLM one more time
   automatically. Look for a `run_auto_resumed` event.
3. **If after 5 auto-resumes the run is still paused**, the supervisor stops
   retrying. Click **Resume with AI** once (it forces the cap-bypass path) or
   click **Resume** to put the run back into the agent loop without invoking
   the AI again.
4. **If even that fails**, you have two options:
   - Inspect the failed step's `recovery_attempt` payloads in the events
     feed and edit the workflow's recorded selectors directly.
   - **Stop** the run, fix the workflow, and re-run.

## When the AI is making bad decisions

Look at `ai_decision_outcomes` rows to find miscalibration:

```sql
-- Overconfident failures (the LLM was sure but it failed):
SELECT * FROM ai_decision_outcomes
WHERE confidence > 0.9 AND actual_outcome = 'failure'
ORDER BY created_at DESC LIMIT 20;

-- Underconfident successes (the LLM was uncertain but it worked):
SELECT * FROM ai_decision_outcomes
WHERE confidence < 0.5 AND actual_outcome = 'success'
ORDER BY created_at DESC LIMIT 20;
```

The first query helps tune the system prompt — if the LLM keeps confidently
choosing broken selectors, add a guardrail. The second is reassuring: it
means the LLM is appropriately cautious before it succeeds.

In Seq (`http://localhost:8082`), the equivalent queries are:

```
Layer = 'backend' AND action = 'ai_decision_resolved' AND confidence > 0.9 AND actual_outcome = 'failure'
Layer = 'backend' AND action = 'ai_decision_resolved' AND confidence < 0.6 AND actual_outcome = 'success'
Layer = 'backend' AND @EventName = 'plan_update'
Layer = 'backend' AND @EventName = 'run_auto_resumed'
```

## Working with PlanUpdate ops

A `plan_update` event has shape:

```json
{
  "ops": [
    {"operation": "INSERT", "step_index": 2,
     "new_step": {"action_type": "click", "selector_chain": [...], "intent": "dismiss cookie banner"},
     "reason": "page rendered a cookie banner not in the recording"}
  ],
  "new_step_count": 15
}
```

Operations:

- **MODIFY** — replace fields of the step at `step_index` with `new_step`.
- **INSERT** / **ADD** — splice `new_step` in at `step_index`; existing
  steps shift right; `step_index` fields are renumbered.
- **REMOVE** / **SKIP** — drop the step at `step_index`; shift left and
  renumber.
- **REORDER** — swap step `step_index` with the one at `new_step.swap_with`.
- **SIMPLIFY** — treated as MODIFY; the LLM is responsible for emitting
  any companion REMOVE ops.

The extension's service worker mirrors the same ops on its local step cache
(`extension/src/background/service-worker.ts`) so `currentStepIndex` stays
aligned after an INSERT or REMOVE.

## Selector stability scores

After each terminal run, `learning_service.py` walks the audit events and
updates each step's `selector_stability_score`:

- **Healed step:** score decays toward 0 with an EMA penalty.
- **Executed cleanly:** score grows toward 1 with an EMA reward.
- **Step not touched this run:** no change.

You can inspect scores with:

```sql
SELECT workflow_id, step_index, action_type, intent,
       selector_stability_score, heal_count
FROM workflow_steps
WHERE workflow_id = '<workflow-id>'
ORDER BY step_index;
```

Steps with a score below ~0.3 should be candidates for re-recording or
manual selector edits.

## API endpoints (new in this branch)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/agent/{run_id}/resume` | Force the supervisor to produce a fresh PlanUpdate and resume a paused run (bypasses the 5-attempt cap). |
| GET | `/v1/agent/{run_id}/outcomes` | Per-decision telemetry rows for the run. Powers the AIDecisionTrace UI. |
| GET | `/v1/runs/{run_id}` | Now also returns `goal_progress`. |

## Configuration knobs

In `backend/services/agent_models.py`:

```python
SAFETY_LIMITS = {
    "max_retries_per_step": 3,
    "max_heal_attempts_per_step": 2,
    "max_adapt_per_run": 25,          # bumped this session (was 5)
    "max_plan_updates_per_run": 15,
    "max_loop_iterations": 200,
    "max_tokens_per_run": 200000,
    ...
}
```

In `backend/services/recovery_supervisor.py`:

```python
MAX_AUTO_RESUMES_PER_RUN = 5
STUCK_THRESHOLD_SECONDS = 300         # 5 minutes idle = "stuck"
SUPERVISOR_POLL_INTERVAL = 30
```

Bump these only when you understand the failure mode you're enabling.

## Troubleshooting

### Run shows nothing but "Fast path: …" decisions

The AI key is not loading. Check `backend/.env`:

```
AI_API_KEY=sk-proj-...
```

Restart the backend after editing the env file.

### Run sits in `waiting_for_user` and supervisor is silent

Check the supervisor task is alive:

```bash
grep -i "recovery supervisor" /tmp/sr-backend*.log | tail -5
```

You should see `Recovery supervisor loop started` on startup. If not, the
lifespan hook failed — check the backend log for the traceback.

### Frontend shows `Cannot read properties of undefined (reading 'color')`

This was fixed in `StatusBadge.tsx` this session via an alias map for
`getStepStatus` short-names (`waiting` → `waiting_for_user`,
`pending` → `queued`). If you see it again, the frontend dev server
is serving stale code — restart Vite.

### `apply_plan_update` ops are ignored

The op shape must match the `PlanUpdate` Pydantic model:

```json
{"operation": "INSERT|REMOVE|MODIFY|REORDER|SIMPLIFY",
 "step_index": <int>, "new_step": {...}, "reason": "..."}
```

Unknown operations log a `Unknown plan update operation` warning and are
dropped. If nothing is applied, the audit log gets NO `plan_update` event.

## Tests for each phase

| Phase | Test file |
|---|---|
| 0 — L1 | `tests/unit/test_agent_service.py` |
| 1 — PlanUpdate | `tests/unit/test_plan_updates.py` |
| 2 — page diff prompt | `tests/unit/test_page_diff_prompt.py` |
| 3 — recovery supervisor | `tests/unit/test_recovery_supervisor.py` |
| 4 — AI decision outcomes | `tests/unit/test_ai_outcome_service.py` |
| 5 — learning service | `tests/unit/test_learning_service.py` |
| 6 — goal progress | `tests/unit/test_goal_progress.py` |

Run them all:

```bash
cd backend && uv run pytest tests/unit/test_plan_updates.py \
                            tests/unit/test_recovery_supervisor.py \
                            tests/unit/test_page_diff_prompt.py \
                            tests/unit/test_ai_outcome_service.py \
                            tests/unit/test_learning_service.py \
                            tests/unit/test_goal_progress.py -v
```

## Where to look when things change

| What changed | Where to look |
|---|---|
| Agent loop behaviour | `services/agent_service.py` |
| What the LLM sees | `ai/prompts.py:build_agent_decision_prompt` |
| What ops the LLM can issue | `services/agent_models.py:PlanUpdate` |
| How ops are applied | `services/healing_service.py:apply_plan_update` |
| Extension execution loop | `extension/src/background/service-worker.ts` |
| Page state captured | `extension/src/content/capture.ts` |
| Diff computation | `extension/src/background/command-executor.ts` |
| Stability scoring | `services/learning_service.py` |
| Auto-recovery rules | `services/recovery_supervisor.py` |
| Telemetry | `services/ai_outcome_service.py` |
| Goal progress | `services/execution_service.py:_seed_goal_progress / _advance_goal_progress` |
