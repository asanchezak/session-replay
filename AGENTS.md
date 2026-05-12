# AGENTS.md — session-replay

## What this is

Browser extension + Python backend that records, replays, self-heals, and syncs browser workflows with backend systems (first adapter: Odoo).

## Current state

Fully implemented kernel (record→store→replay) with 49 backend tests (76% coverage), 13 extension tests. Backend and extension are functional. Frontend has stub pages + live Dashboard/Workflows/WorkflowDetail plus foundation components.

## Workflow state machine

`idle → recording → validated → queued → running → waiting_for_user → recovering → failed → completed → canceled`

All transitions explicit and logged. State machine at `backend/core/state_machine.py`.

## Exact commands

| Command | What it does |
|---|---|
| `make lint` | ruff (backend) + tsc --noEmit (extension + frontend) |
| `make test` | pytest backend + vitest extension |
| `make coverage` | pytest with HTML coverage report |
| `make check` | lint + typecheck + test (quality gate) |
| `cd backend && uv run pytest tests/path -v` | single test file |
| `cd extension && npx vitest run` | extension tests |
| `cd backend && uv run ruff check --fix .` | auto-fix lint |
| `cd extension && npx tsc --noEmit` | extension typecheck |

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
- Event buffer: 2s flush interval, batch size 5, retry queue with exponential backoff

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
- **E2E tests**: Directory exists but is empty. Playwright setup is a separate effort.

## Memory files

- `memory/decisions.md` — durable architectural and product decisions
- `memory/changes.md` — record of significant changes
- Shared design tokens at `shared/design-tokens.css`

## Skills

- `code-review` — multi-lens review (architect, code-reviewer, QA)
- `pre-commit` — lint → typecheck → test → review
- `scaffold-module` — new module creation
