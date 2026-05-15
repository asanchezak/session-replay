# AGENTS.md — session-replay

## What this is

Browser extension + Python backend that records, replays, self-heals, and syncs browser workflows with backend systems (first adapter: Odoo).

## Current state

Fully implemented kernel (record→store→replay) with 49 backend tests (76% coverage), 13 extension tests. Backend and extension are functional. Frontend has stub pages plus live Dashboard/Workflows/WorkflowDetail plus foundation components.

## Workflow state machine

`idle → recording → validated → queued → running → waiting_for_user → recovering → failed → completed → canceled`

All transitions explicit and logged. State machine at `backend/core/state_machine.py`.

## Extension build

- `vite.config.ts` MUST have `base: "./"` — otherwise built HTML uses absolute paths (`/popup.js`) that break in Chrome extension context
- HTML entry files must be at extension root (`popup.html`, `panel.html`) NOT in subdirectories — relative paths resolve from extension root
- `manifest.json` references e.g. `dist/popup.html` (not `dist/popup/index.html`)
- Icons (16/48/128) must exist at `extension/icons/` — Chrome rejects load without them

## Quick start

```bash
make dev              # Starts backend + frontend (uses screen sessions)
# or individually:
make dev-backend      # Start just the backend (port 8081)
make dev-frontend     # Start just the frontend (port 5173)
```

Port 8000 conflict: `easy-recruit-workflow` Docker project uses 8000. If `make dev` fails or routes show `/api/v1/job-requests`, stop it with `docker compose -p easy-recruit-workflow down` first.

## Centralized logging (Seq)

All three layers log to Seq at `http://localhost:8082` (Docker container).

| Layer | Source | How to view |
|---|---|---|
| Backend | API middleware, services, DB | Seq → filter `Layer = 'backend'` |
| Frontend | Pages, components, hooks, useApi | Seq → filter `Layer = 'frontend'` |
| Extension | Content script, SW, popup | Seq → filter `Layer = 'extension'` |

```bash
# Start Seq (required once)
make dev-logs

# Open Seq UI in browser
make logs
# or: open http://localhost:8082

# Filter by layer in Seq query bar:
Layer = 'backend'
Layer = 'frontend'     
Layer = 'extension'
@Level = 'Error'
```

The dashboard top bar also has a **Logs** link (next to the status indicator).

## Debugging the extension

Extension logs are automatically sent to `POST /v1/debug/log` (no API key needed). View them:

```bash
# All recent logs
curl -H "X-API-Key: dev-api-key-change-in-production" http://localhost:8081/v1/debug/logs

# Filter by source
curl -H "X-API-Key: dev-api-key-change-in-production" "http://localhost:8081/v1/debug/logs?source=service-worker"

# Filter since a Unix timestamp
curl -H "X-API-Key: dev-api-key-change-in-production" "http://localhost:8081/v1/debug/logs?since=$(date +%s)"

# Tail logs (using jq)
curl -s -H "X-API-Key: dev-api-key-change-in-production" http://localhost:8081/v1/debug/logs | python3 -m json.tool
```

## Exact commands

| Command | What it does |
|---|---|
| `make lint` | ruff (backend) + tsc --noEmit (extension + frontend) |
| `make test` | pytest backend + vitest extension + playwright e2e |
| `make test-e2e` | playwright e2e tests only (extension loaded in Chromium) |
| `make autonomy-e2e` | Phase 0–6 autonomy gates + live HTTP probe + report (see `docs/autonomy-runbook.md`) |
| `make coverage` | pytest with HTML coverage report |
| `make coverage-e2e` | playwright with HTML report |
| `make check` | lint + typecheck + test + build (quality gate) |
| `make build` | tsc --noEmit + vite build (both extension + frontend) |
| `cd backend && uv run pytest tests/path -v` | single test file |
| `cd extension && npx vitest run` | extension unit tests |
| `cd extension && npx playwright test` | extension e2e tests |
| `cd backend && uv run ruff check --fix .` | auto-fix lint |
| `cd extension && npx tsc --noEmit` | extension typecheck |
| `python3 scripts/verify_autonomy.py` | live probe — proves the AI is consulted on `cf7e5f3b` |
| `python3 scripts/autonomy_report.py` | emit `test-results/autonomy-report-latest.md` decision-mix report |

## Backend conventions

- Python 3.12, FastAPI, SQLAlchemy async, Pydantic, ruff, mypy
- Tests: pytest + pytest-asyncio, SQLite `:memory:` (not `test.db` — do NOT commit db files)
- Error contract: `{error: {code, message, details}}` at top level on ALL endpoints
- API key: required on ALL `/v1/*` routes except `/v1/health` via `X-API-Key` header
- Migrations: Alembic targeting PostgreSQL with JSONB; models use JSON for SQLite compat
- Audit: all events stored in `EventLog` with SHA-256 hash chain + nonce

## Extension conventions

- TypeScript, Manifest V3, React 19 popup, Vite 6 build
- Two-stage build: Vite (UI) + tsc (scripts) — `npx vite build`
- API key + base URL: stored in `chrome.storage.session` (NOT hardcoded)
- Content script events: bubble phase, check `event.defaultPrevented`
- Replay selector chain: css → text → accessibility → xpath
- Event buffer: local in-memory queue persisted to `chrome.storage.session` (survives SW restart)
- Recording state: stored in `chrome.storage.session`, content script uses `chrome.storage.onChanged` to react (no message race)
- Shadow DOM replay panel: `mode: 'closed'` for full CSS isolation

## Frontend conventions

- React 19, React Router 7, TailwindCSS 4, Vite 6
- Theme tokens in `frontend/src/index.css` (Tailwind v4 `@theme` directive)
- Components live in `frontend/src/components/` (StatusBadge, Card, DataTable, EmptyState, Banner)
- Hooks in `frontend/src/hooks/` (useApi, useWorkflows, useRuns)
- API base URL via `import.meta.env.VITE_API_URL` (defaults to `/v1` in dev via proxy)

## Known quirks & gotchas

- **SQLite UUID**: SQLAlchemy stores UUID as BLOB in SQLite. Always convert string IDs to `uuid.UUID()` before querying UUID columns when running tests.
- **Hash chain timestamps**: `AuditService.append()` sets `created_at` explicitly (NOT server_default) to ensure microsecond ordering for hash chain integrity.
- **created_at ordering**: All events for a run must have unique timestamps. The `server_default=func.now()` has only second precision in SQLite — always pass `created_at` explicitly.
- **Test isolation**: Tests use shared session (no commit). Use `await session.flush()` to persist within a test, `session.rollback()` cleans up.
- **FRONTEND**: Contains stub pages for Audit, Connectors, Settings, and Run/Replay views. These need full implementation following the `UI-UX-SPEC.md`. The component library foundation exists but needs expansion.
- **E2E tests**: Playwright tests in `extension/e2e/` load the full extension in Chromium via `launchPersistentContext`. Use `make test-e2e` or `cd extension && npx playwright test`.
- **SW state persistence**: Recording state is stored in `chrome.storage.session` with `setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')` so content scripts can read it directly. The `chrome.storage.onChanged` listener in the content script replaces the SET_RECORDING message as the primary mechanism.
- **Shadow DOM**: The content script's replay panel uses Shadow DOM (`mode: 'closed'`) for full CSS isolation from the host page.
- **Autonomy default**: AI is consulted on every agent poll when `AI_API_KEY` is set. To disable for a test/debug run, clear the key (the system falls back to fast-path EXECUTE). See `docs/autonomy-runbook.md`.
- **`DEV_DEFAULTS.apiBase`** in `extension/src/background/api.ts` and Vite proxy in `frontend/vite.config.ts` both point at the dev backend. Currently `http://localhost:8091`. Keep them in sync if you move the backend.
- **Stuck runs auto-recover**: a backend `RecoverySupervisor` task wakes paused runs every 30 s and gives the LLM another shot. Capped at 5 attempts per run. Manually force a try with the dashboard's **Resume with AI** button.
- **PlanUpdate ops** (INSERT/REMOVE/MODIFY/REORDER) mutate `run.workflow_snapshot.steps` atomically via `HealingService.apply_plan_update`. The extension mirrors the same ops locally so `currentStepIndex` stays aligned.

## Autonomy stack (Phases 0–6)

End-to-end AI-driven runtime. Architecture in `docs/autonomy-architecture-v2.md`; operations in `docs/autonomy-runbook.md`.

| Layer | Files |
|---|---|
| L1 AI-first poll | `services/agent_service.py:_should_consult_ai`, `_consult_ai_for_step`, `_last_chance_recovery` |
| L2 Goal-first cursor | `services/execution_service.py:_seed_goal_progress`, `_advance_goal_progress`; `core/models/run.py:goal_progress` |
| L2 Page-state diff | `extension/src/background/command-executor.ts`; `extension/src/shared/types.ts:PageDiff` |
| L3 PlanUpdate ops | `services/healing_service.py:apply_plan_update`; `services/agent_models.py:PlanUpdate` |
| L4 Recovery supervisor | `services/recovery_supervisor.py`; `POST /v1/agent/{id}/resume` |
| L5 Telemetry | `services/ai_outcome_service.py`; `core/models/ai_decision_outcome.py`; `GET /v1/agent/{id}/outcomes` |
| L5 Learning | `services/learning_service.py` (called from `ExecutionService.transition` on terminal states) |

Verification: `make autonomy-e2e` runs the full suite and emits `test-results/autonomy-report-latest.md`.

## Memory files

- `memory/decisions.md` — durable architectural and product decisions
- `memory/changes.md` — record of significant changes
- Shared design tokens at `shared/design-tokens.css`

## Skills

- `code-review` — multi-lens review (architect, code-reviewer, QA)
- `pre-commit` — lint → typecheck → test → review
- `scaffold-module` — new module creation
