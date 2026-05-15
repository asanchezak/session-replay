# Significant Changes

| Date | Change | Reason | Impact |
|---|---|---|---|
| 2025-05-11 | Initial implementation of Slice 1-6 | Greenfield project — no prior code | Full record→store→replay pipeline working |
| 2025-05-11 | Backend: core models, audit service, API endpoints | Foundation for event recording with hash chain | 19 unit/integration tests passing |
| 2025-05-11 | Extension: content script, background SW, popup UI, replay engine | Browser-side capture and replay | 13 vitest tests passing |
| 2025-05-11 | State machine: 10 states with explicit transitions | PRD requirement for run lifecycle | 8 state machine tests passing |
| 2025-05-11 | Frontend scaffold: React SPA with TailwindCSS | Dashboard UI per UI-UX-SPEC | Read-only pages, deferred full implementation |
| 2025-05-11 | AI client: OpenAI + Mock providers | Deterministic-first with AI fallback | Deployed when AI API key configured |
| 2025-05-11 | Odoo adapter: BaseAdapter interface + Odoo implementation | First target system adapter | JSON-RPC based (not deprecated xmlrpc) |
| 2026-05-11 | Full project audit remediation (4-agent parallel analysis) | Address findings from architect/designer/code-reviewer/QA | All 4 lenses applied, 50+ issues fixed |
| 2026-05-11 | Security fixes: API key to chrome.storage.session, auth on all endpoints, CORS fix | Hardcoded key + open GET endpoints in audit | P0 risks resolved |
| 2026-05-11 | Data integrity fixes: audit from_status bug, hash chain ordering, state machine transitions | Code-reviewer found from_status==to_status bug, QA found missing transition | 3 production bugs fixed |
| 2026-05-11 | 12 missing API endpoints implemented: audit, connectors, recovery, extract, sync, interventions | Architect identified gaps vs PRD spec | Full API surface now matches PRD |
| 2026-05-11 | Frontend: 6 components, 3 live pages, NavLink routing, design tokens | Designer audit found 85% UI unimplemented | Dashboard, Workflows List, Workflow Detail now live |
| 2026-05-11 | Extension RunningView, message wiring, buffer retry, bubble phase events | Extension had unhandled messages, race condition, capture-phase bugs | All popup states functional |
| 2026-05-11 | Tests: 21 new (49 total), 76% coverage, :memory: SQLite, CI coverage gate | QA audit found <15% coverage, committed test.db | Test quality gate established |
| 2026-05-12 | Replay execution wired: EXECUTE_STEP forwards to content script, next-step/step-result endpoints | Slice 1 gap — replay engine returned "Not implemented" | Full record→store→replay pipeline now functional |
| 2026-05-12 | Step orchestration endpoints: next-step, step-result, advance_step route | Extension needs to know what step to execute and report results | Backend drives replay execution flow |
| 2026-05-12 | Event deduplication: idempotency_key column on EventLog, dedup check in record_event | No dedup means retry floods duplicate events | Duplicate-safe event ingestion |
| 2026-05-12 | Rate limiting middleware: configurable per-minute limit, disabled in tests | Missing PRD requirement, DoS vector | Production safety net |
| 2026-05-12 | Frontend Audit/Trace page: run selector, event table, hash chain verification, expandable payload | 4 remaining stub pages — Audit, Connectors, Settings, Replay | Full UI-UX spec parity |
| 2026-05-12 | Frontend Connectors page: add/list/test connectors with status indicators | Stub page had no real implementation | Operational connector management |
| 2026-05-12 | Frontend Settings page: policies, retention, API keys, team, notifications | Stub page had no real implementation | Full settings interface |
| 2026-05-12 | Rate limit configurable via env (rate_limit_per_minute), disabled in test conftest | Tests were rate-limited by aggressive default | Test isolation preserved |
| 2026-05-12 | Playwright e2e test suite: 10 tests (popup, recording, content script, SW persistence) | Zero e2e coverage before — couldn't catch MV3 SW restart bugs | 10 passing tests with extension loaded in Chromium |
| 2026-05-12 | storage.session.setAccessLevel + onChanged listener in content script | Eliminates race between SET_RECORDING message and SW restart | Content script reads recording state directly from storage |
| 2026-05-12 | Shadow DOM replay panel with full CSS isolation | Host page CSS leaked into replay overlay, overlay styles leaked to page | Closed Shadow DOM isolates all styles |
| 2026-05-12 | Extension build now includes tsc --noEmit before vite build | Type errors could reach production builds | Typecheck gated in build pipeline |
| 2026-05-12 | Extension build fixed: Vite base=./, HTML entries at root, icons created | Chrome rejected extension due to missing icons and absolute paths in built HTML | Extension now loads correctly in Chrome |
| 2026-05-14 | Agentic RunDetailPage: fetches workflow steps, shows step timeline, current step card, adaptive polling, retry/recover, skip step | Page was a passive viewer — no workflow context, no step-level detail, no orchestration controls | Run page now actively drives execution view with per-step status |
| 2026-05-14 | Global intervention modal: fetches workflow name, persists dismiss state, suppressed on current run page | Modal showed "Workflow f8a1a16a" (useless ID) and re-appeared every 5s after dismiss | Shows workflow name, dismiss is sticky per run |
| 2026-05-14 | Event feed: human-readable event labels (Started, Step executed, Recovering, etc.) instead of raw snake_case | Raw event types like run_started, recovery_failure were not user-facing | Event descriptions are now readable |
| 2026-05-15 | **Autonomy v2 — Phases 0–6 landed.** AI is now the primary decision-maker for every poll (L1). `PlanUpdate` ops let the LLM rewrite the recorded blueprint mid-run (L3, `apply_plan_update`). Background `RecoverySupervisor` unsticks paused runs every 30 s (L4). Per-decision telemetry in `ai_decision_outcomes` (L5). Post-run `LearningService` updates `selector_stability_score` per step (L5). `goal_progress` jsonb on `ExecutionRun` seeded from semantic analysis; phase ribbon in `RunDetailPage` (L2/L6). New endpoints `POST /v1/agent/{id}/resume`, `GET /v1/agent/{id}/outcomes`. New columns: `workflow_steps.selector_stability_score`, `workflow_steps.heal_count`, `workflow_parameters.validation_count`, `workflow_parameters.success_count`, `workflow_parameters.last_validated_at`, `execution_runs.goal_progress`. Migration `012_create_ai_decision_outcomes.py`. | Reactive heuristic AI couldn't make runs autonomous; system stalled at `waiting_for_user` indefinitely; no cross-run learning. Architecture plan in `docs/autonomy-architecture-v2.md`; runbook at `docs/autonomy-runbook.md`. | 289 backend tests pass (+23 new). One-command suite: `make autonomy-e2e`. Dev `DEV_DEFAULTS.apiBase` and Vite proxy point at `localhost:8091`. `StatusBadge` defensive lookup for step-status aliases (`waiting`, `pending`). |
