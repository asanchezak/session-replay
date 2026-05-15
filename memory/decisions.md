# Durable Decisions

| Date | Decision | Rationale |
|---|---|---|
| 2025-05-11 | Vertical slice delivery — build record→store kernel first | Avoids months of horizontal infrastructure before any working feature |
| 2025-05-11 | Two-stage extension build: Vite (UI) + tsc (scripts) | Avoids MV3 service worker bundling issues with Vite alone |
| 2025-05-11 | SQLite for tests with JSON columns (not JSONB) | Enables fast local test without PostgreSQL dependency |
| 2025-05-11 | Migration files use JSONB explicitly for PG prod | Alembic migrations target PostgreSQL, ORM models use compat JSON |
| 2025-05-11 | No worker until Slice 2+ | Direct API calls are sufficient for MVP. Deferred: Arq when background queue needed |
| 2025-05-11 | SHA-256 hash chain with nonce | Nonce prevents identical-payload hash collisions |
| 2025-05-11 | Error contract: {error: {code, message, details}} | Consistent machine-readable errors across all endpoints |
| 2025-05-11 | API key in chrome.storage.session (not local) | Reduced exposure window — wiped when browser closes |
| 2025-05-11 | Single AI client with modular prompt builders | 6 separate AI modules is over-engineering for v1 |
| 2025-05-11 | fsspec for storage abstraction | Same API for Minio (dev), S3 (prod), local disk (test) |
| 2026-05-15 | **AI is the cursor, not the safety net.** LLM is consulted on every agent poll when configured; deterministic fast-path is the fallback, not the default. | Pre-fix runs stalled at `waiting_for_user` because the AI was only invoked reactively after retries + heals were exhausted. Inverting the default removes the entire stall pattern. |
| 2026-05-15 | **Blueprint is a recipe, not a script.** The LLM may emit `PlanUpdate` ops (INSERT/REMOVE/MODIFY/REORDER) that mutate `run.workflow_snapshot.steps` mid-run; `current_step_index` is no longer the only source of truth — `goal_progress` carries phases + intents. | Recorded workflows go stale (session-specific selectors, new cookie banners, dropped steps). Allowing the agent to rewrite the recipe means a single recording survives page changes that previously required re-recording. |
| 2026-05-15 | **Stuck runs auto-recover.** A backend `RecoverySupervisor` task wakes paused runs every 30 s and gives the LLM another shot, capped at 5 attempts per run. | The point of an "autonomous" agent is that it doesn't sit waiting for a human. A capped retry loop preserves that property while still surfacing truly hopeless failures. |
| 2026-05-15 | **Every decision is logged in `ai_decision_outcomes`.** Confidence at decision time + actual outcome on completion. | Without this, calibration drift (overconfident failures, underconfident successes) is invisible. The table powers analytics and a future RLHF-style feedback loop. |
| 2026-05-15 | **Stability scores compound across runs.** After each terminal run, `LearningService` updates each step's `selector_stability_score` via an EMA. | A workflow that has run successfully 50 times should be trusted differently from one that has never run. Selectors that always need healing should bubble up for re-recording. |
