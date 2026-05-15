# Autonomy Architecture v2 — AI-Driven, Self-Recovering Runtime

> Companion to `docs/autonomy-architecture.md`. v1 documented the surgical fixes
> shipped in the first session; v2 is the **full architectural redesign** to make
> the LLM the primary decision-maker, end-to-end.

## 1. Why we're doing this

Every recent run of workflow `cf7e5f3b-92c8-4bf9-93db-bfe278800129` (Indeed
search) stalls the same way:

```
agent_decision  EXECUTE (conf=0.99): Fast path: execute step N
agent_decision  RETRY 1/3 → 2/3 → 3/3
agent_decision  HEAL 1/2 → 2/2: Healing exhausted
agent_decision  PAUSE → waiting_for_user   ← run sits indefinitely
```

The AI is consulted *reactively*, capped at 5 adaptations per run, and only
selector-level. When it gives up the run waits for a human. There is no memory
of which selectors broke last run, no cross-workflow learning, no goal-progress
tracking.

The user's intent has always been the opposite: the LLM should read the
blueprint + the live page and decide what to do — including things the
blueprint never anticipated.

## 2. Current architecture (the reality)

### Record-time
- `backend/services/semantic_analysis_service.py:68-110` — auto-runs on
  `POST /workflows/record`. Produces `workflow_goal`, `phases`, `parameters`,
  `output_spec`, `replay_strategy`. **Frozen forever after creation.**
- `backend/services/workflow_service.py:154-167` — selectors stored raw,
  no AI scoring of stability at record time.

### Runtime agent loop
- `backend/services/agent_service.py:49-184` (`poll`) — fast-path EXECUTE
  with confidence 0.99 unless the heuristic `_should_consult_ai` returns True.
- `backend/services/agent_service.py:report_result` — retries × N → heals × M
  → PAUSE. The session-1 fix added a last-chance AI consult before PAUSE but
  the loop shape is still retry/heal-then-give-up, not goal-shaped.
- `backend/services/healing_service.py:188-202` — `apply_heal` only mutates
  one step's `selector_chain`. Cannot insert, remove, or reorder.
- `backend/services/agent_models.py:69-92` — `PlanUpdate`
  (ADD/REMOVE/MODIFY/REORDER/SIMPLIFY) is **defined and unused**.

### Extension
- `extension/src/background/service-worker.ts:493-771` — synchronous polling
  loop; fresh page context every poll; no diff tracking.
- `extension/src/content/capture.ts:266-391` — the "accessibility_tree" is a
  text summary of interactive elements, **not** a real a11y tree.
- `extension/src/shared/detector.ts` — challenge detection is hardcoded regex.
- `extension/src/background/retry.ts` — already implements run-scoped budget
  + circuit breaker but is **dead code** today.

### Observability
- `backend/services/log_service.py` — operational metrics only. No AI decision
  telemetry: confidence vs. outcome, which model versions adapted what.

## 3. Target architecture — five layers

```
┌─────────────────────────────────────────────┐
│  L5: Outcome-Driven Learning                │
│  every run feeds back into analysis;        │
│  selector/parameter confidence compounds    │
├─────────────────────────────────────────────┤
│  L4: Auto-Recovery Supervisor               │
│  watchdog over waiting_for_user runs;       │
│  no run sits forever                        │
├─────────────────────────────────────────────┤
│  L3: Continuous Plan Updates                │
│  AI can ADD/REMOVE/REORDER steps mid-run;   │
│  blueprint is a recipe, not a script        │
├─────────────────────────────────────────────┤
│  L2: Goal-First Runtime Cursor              │
│  agent answers "what intent advances the    │
│  goal?" not "execute step N"                │
├─────────────────────────────────────────────┤
│  L1: AI-First Decision Loop                 │
│  LLM consulted on every poll;               │
│  deterministic logic is fallback            │
└─────────────────────────────────────────────┘
```

### L1 — AI-First Decision Loop (landed in earlier sessions)
The LLM is the primary decider on every poll. Fast-path EXECUTE fires only
when AI is unavailable. Before any PAUSE the LLM gets a last-chance call
with full failure history. Adapt budget is generous (≥25 per run).

### L2 — Goal-First Runtime Cursor
Replace `current_step_index` as the primary cursor with a `goal_progress`
record on `ExecutionRun`:
```jsonc
{
  "workflow_goal": "Find Indeed jobs in Costa Rica",
  "phases": [
    {"name": "open_platform",    "status": "done",    "evidence": "url=indeed.com"},
    {"name": "set_search_query", "status": "active",  "evidence": "input filled"},
    {"name": "extract_results",  "status": "pending"}
  ],
  "intents_satisfied": ["search 'sin experiencia'", "set location Heredia"],
  "intents_outstanding": ["click first result", "extract job descriptions"]
}
```
The agent answers "what intent satisfies the next phase?" — not "execute
step N." A failed step can be replaced by an entirely different action.

### L3 — Continuous Plan Updates
Wire `PlanUpdate` through end-to-end. The LLM can return:
- `MODIFY` — change selectors/action/value of one step (today's ADAPT)
- `INSERT` — add a step the recording missed (e.g., dismiss a cookie banner)
- `REMOVE` / `SKIP` — drop a step that no longer applies
- `REORDER` — swap two steps the page now requires in reverse order
- `SIMPLIFY` — collapse "click box, click result" into "navigate URL"

`HealingService.apply_heal` is generalised to `apply_plan_update(run, ops)`,
mutating the run snapshot's `steps` array atomically inside the audit chain.

### L4 — Auto-Recovery Supervisor
A backend asyncio task watches every run in `waiting_for_user` / `recovering`.
If a run sits >300 s with no extension activity, the supervisor calls a
resume version of the AI consult and writes a fresh decision into the run.
Frontend exposes a **Resume with AI** button that triggers the same logic
on demand. Net effect: runs never sit indefinitely waiting for a human.

### L5 — Outcome-Driven Learning
After every terminal run (`completed` or `failed`), a post-run job:
1. Updates each step's `selector_stability_score` based on whether it healed.
2. Increments `validation_count` and `success_rate` on each workflow parameter.
3. Re-clusters the workflow against the template library and suggests reuse.
4. Emits structured AI-observability events to Seq.

## 4. File-level changes

### Backend

| File | Change | Layer |
|---|---|---|
| `services/agent_service.py:_should_consult_ai` | Default `True` when AI configured (DONE) | L1 |
| `services/agent_service.py:_last_chance_recovery` | Final consult before PAUSE (DONE) | L1 |
| `services/agent_service.py:_consult_ai_for_step` | Return `plan_updates: list[PlanUpdate]`, not a single command | L3 |
| `services/agent_models.py` | Wire `plan_updates` into `PollResponse` and `ResultResponse` | L3 |
| `services/healing_service.py` | Generalise to `apply_plan_update(run, ops)` | L3 |
| **new** `services/recovery_supervisor.py` | Scans stuck runs every 30 s; calls last-chance AI for any run paused >300 s | L4 |
| `core/models/run.py` | Add `goal_progress: jsonb` | L2 |
| `services/execution_service.py:create_run` | Seed `goal_progress` from `analysis.phases` | L2 |
| `services/agent_service.py:poll` | Walk intents, not step indices | L2 |
| **new** `services/learning_service.py` | Post-run callback updating stability, validation_count, similarity | L5 |
| `core/models/analysis.py` | `validation_count`, `success_rate`, `selector_stability_score` | L5 |
| **new** `core/models/ai_decision_outcome.py` | `(run_id, step_index, decision, confidence, outcome, latency_ms, model)` | L5 |
| `services/log_service.py` | Emit `ai_decision_made` / `ai_decision_resolved` | L5 |
| `services/semantic_analysis_service.py` | AI pass that scores each selector for stability | L1+L5 |
| `ai/prompts.py:build_agent_decision_prompt` | Accept `page_diff` and `goal_progress` | L2 |

### Extension

| File | Change | Layer |
|---|---|---|
| `src/content/capture.ts` | Real a11y tree; cache prior context; emit `page_diff` | L2 |
| `src/background/service-worker.ts` (agent loop) | Apply `plan_updates` locally; report op-level results | L3 |
| `src/background/service-worker.ts` (PAUSE branch) | Backoff 5 s and re-poll instead of breaking the loop | L4 |
| `src/shared/detector.ts` | Defer challenge classification to LLM | semantic |
| `src/background/healer.ts` | Local heuristic layer (text / a11y-role / proximity) before backend AI | latency |
| `src/background/retry.ts` | Wire into the agent loop (today dead code) | robustness |

### Frontend

| File | Change | Layer |
|---|---|---|
| `src/pages/RunDetailPage.tsx` | Render `goal_progress` ribbon; collapse step events under their intent | L2 |
| **new** `src/components/AIDecisionTrace.tsx` | Prompt + response + plan_updates per step | obs. |
| `src/pages/RunDetailPage.tsx` (top bar) | **Resume with AI** button → `POST /v1/agent/{run_id}/resume` | L4 |
| `src/components/StatusBadge.tsx` | Defensive lookup (DONE) | bug fix |
| **new** `src/pages/AnalyticsPage.tsx` | Confidence-vs-outcome charts from `ai_decision_outcomes` | L5 |

### Database (new migration)

```sql
CREATE TABLE ai_decision_outcomes (
  id UUID PRIMARY KEY,
  run_id UUID REFERENCES execution_runs(id),
  step_index INT,
  decision TEXT,
  confidence FLOAT,
  actual_outcome TEXT,
  latency_ms INT,
  model TEXT,
  prompt_hash TEXT,
  created_at TIMESTAMPTZ
);

ALTER TABLE workflow_parameters
  ADD COLUMN validation_count INT DEFAULT 0,
  ADD COLUMN success_count    INT DEFAULT 0,
  ADD COLUMN last_validated_at TIMESTAMPTZ;

ALTER TABLE workflow_steps
  ADD COLUMN selector_stability_score FLOAT,
  ADD COLUMN heal_count INT DEFAULT 0;

ALTER TABLE execution_runs
  ADD COLUMN goal_progress JSONB;
```

## 5. Phased roadmap (sequential, each independently deployable)

| Phase | Scope | Time | Layer |
|---|---|---|---|
| 0 | Restart backend so existing L1 fixes are live; verify | <1 day | L1 |
| 1 | Plumb `PlanUpdate` through PollResponse + ResultResponse; `apply_plan_update`; SW applies ops | ~2 days | L3 |
| 2 | Page-state diff caching + real a11y tree; pass `page_diff` to LLM | ~2 days | L2 |
| 3 | Recovery supervisor + Resume button + new `/agent/{run_id}/resume` endpoint | ~1 day | L4 |
| 4 | `ai_decision_outcomes` table; AIDecisionTrace UI; Seq events | ~2 days | L5 |
| 5 | `learning_service` post-run callback; selector stability scores; parameter validation counts | ~3 days | L5 |
| 6 | `goal_progress` column; refactor `poll` to walk intents; phase ribbon UI | ~5 days | L2 |

**Total estimate:** ~15 dev-days.

## 6. Verification — end-to-end test plan

Every phase ships with one repeatable e2e command that proves it works.

### 6.1 One-command full suite

```bash
make autonomy-e2e
```

This new top-level make target runs in order:
1. `cd backend && uv run pytest tests/integration/test_autonomy_phases.py -v`
2. `cd extension && npx playwright test e2e/autonomy/`
3. `python3 scripts/verify_autonomy.py --workflow cf7e5f3b-... --expect adapt`
4. Writes `test-results/autonomy-report-$(date +%s).md` with per-phase ✓/✗,
   created run-ids, Seq query links, audit hashes.

Exit code 0 = all phases pass; exit code N = phase N failing.

### 6.2 Per-phase gates

| Phase | Test | Gate |
|---|---|---|
| 0 | `scripts/verify_autonomy.py` | Poll on `cf7e5f3b` step 0 returns `decision=ADAPT` (not EXECUTE) with reasoning mentioning the session-id |
| 1 | `e2e/autonomy/01-plan-insert.spec.ts` | Workflow with cookie banner → audit log has `plan_update` event with `operation=INSERT`; run reaches `completed` |
| 2 | `e2e/autonomy/02-page-diff.spec.ts` | Two polls during SPA transition → backend prompt log includes `## Page Diff` with ≥1 `added` element |
| 3 | `e2e/autonomy/03-auto-resume.spec.ts` | Forced pause via inject-heal-override → without manual action, status transitions `waiting_for_user → running` within 60 s |
| 4 | `tests/integration/test_autonomy_phases.py::test_telemetry` | `COUNT(*) FROM ai_decision_outcomes WHERE run_id=...` equals `agent_decision` event count; every row has non-null `confidence`, `actual_outcome`, `latency_ms` |
| 5 | `tests/integration/test_autonomy_phases.py::test_learning` | Same workflow twice → run-2's `selector_stability_score` for previously-healed step is strictly higher than run-1 |
| 6 | `e2e/autonomy/06-goal-cursor.spec.ts` | 3-phase × 7-step workflow with 2 AI SKIPs in phase 2 → `run.goal_progress.phases[1].status = "done"`; run completes |

### 6.3 Manual smoke

1. `make dev-backend` (user-owned, `--reload`).
2. Reload extension at `chrome://extensions/`.
3. Run `cf7e5f3b` from the dashboard.
4. On `/runs/<new-id>` confirm:
   - **AIDecisionTrace** cards show prompt + LLM response per step (Phase 4)
   - **Goal Progress** ribbon advances phases (Phase 6)
   - Step 0's session-specific selector is annotated "Adapted by AI" (Phases 0/1)
5. Click **Pause**. Within ≤60 s the supervisor auto-resumes (Phase 3).
6. Run again; compare runs on the new **Analytics** page —
   `selector_stability_score` rises for the previously-fragile step (Phase 5).

### 6.4 Observability queries

```
Layer = 'backend' AND action = 'ai_decision_resolved'
  AND confidence < 0.6 AND actual_outcome = 'success'
  → underconfident wins (healthy signal)

Layer = 'backend' AND action = 'ai_decision_resolved'
  AND confidence > 0.9 AND actual_outcome = 'failure'
  → overconfident failures (calibration target, should trend → 0)

Layer = 'backend' AND action = 'run_auto_resumed'
  → ≥1 per autonomy-e2e invocation (Phase 3 gate)
```

### 6.5 Safety regression tests (must KEEP these guarding)

- `test_runaway_cost_limit` — when `max_tokens_per_run` exceeded, run pauses.
- `test_dangerous_plan_update_rejected` — `INSERT` with action=navigate to an
  off-domain host (vs. `workflow.target_url`) is rejected by the backend.
- `test_auto_resume_cap` — after 5 auto-resumes on the same run, true PAUSE
  is allowed.
- The existing **266 backend tests** continue to pass after every phase.

## 7. Risk register

| Risk | Mitigation |
|---|---|
| Every-step AI consult slow (1–2 s × 20 steps = 20–40 s/run) | Phase 2 page diff makes small-delta polls cacheable; Phase 4 telemetry exposes p95 latency |
| LLM cost explosion | `max_tokens_per_run` (raised to 200k); Anthropic prompt cache (5 min TTL) for short-lived contexts |
| Plan updates corrupt the snapshot | All ops go through audit chain (hash-linked); `apply_plan_update` is transactional with rollback |
| Auto-resume creates resume-loop | Per-run auto-resume cap (5); after cap, true PAUSE |
| Goal-first cursor breaks existing UI | Phase 6 is last; keep `current_step_index` as derived field for back-compat |

## 8. Out of scope

- Swapping the LLM provider — orthogonal.
- Visual workflow editor — orthogonal product surface.
- Multi-tenant / RBAC — not required for autonomy.
- Non-Chrome browsers — extension is MV3-only by design.

## 9. The one sentence

**Make the LLM the cursor, not the safety net** — every poll asks "what intent
advances the goal?", every plan update can rewrite the recipe, every outcome
feeds back into the analysis, and no run sits stuck waiting for a human.
