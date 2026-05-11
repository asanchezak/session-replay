# AGENTS.md — session-replay

## What this is

Greenfield repo for an **AI Browser Workflow Runtime**: a browser extension + Python backend (Docker) that records, replays, self-heals, and syncs browser workflows with backend systems (first adapter: Odoo).

## Current state

Greenfield with monorepo scaffolded. PRD at `# PRD — AI Browser Workflow Runtime.md`, design spec at `UI-UX-SPEC.md`. Extension and backend packages have project configs and directory structure but no implementation code yet.

## Planned architecture (from PRD)

| Layer | Stack | Notes |
|---|---|---|
| Browser extension | TypeScript, Manifest V3, React popup, content scripts | Records actions, replays, detects challenges, pauses/resumes |
| Backend API | Python, FastAPI, Pydantic | Versioned REST API at `/v1/...` |
| Storage | PostgreSQL (durable), Redis (queue/locks), object storage (artifacts), pgvector (semantic) | |
| Workers | Celery or RQ | Background tasks, orchestration, retries |
| AI services | Separate logical modules (planner, summarizer, selector-healer, extractor, classifier, policy advisor) | Deterministic-first, AI fallback only |
| Testing | Playwright (browser automation), pytest (unit/integration) | Run in Docker |

## Key product principles (must follow)

1. **Deterministic first, AI second** — never invoke AI when a deterministic rule can handle it
2. **Intention over selector** — every action stores intent, not just CSS selectors
3. **Audit everything** — append-only, tamper-evident event log with hash chaining
4. **Human control always** — pause on CAPTCHA/login/2FA/unexpected modal; require confirmation to resume
5. **Reusable by design** — Odoo is only the first adapter; use a generic adapter interface
6. **Composable capabilities** — search, open, extract, paginate, fill_form, submit, wait, resume

## Workflow state machine

`idle → recording → validated → queued → running → waiting_for_user → recovering → failed → completed → canceled`

All transitions must be explicit and logged.

## Required API endpoints

`POST /v1/events/record`, `POST/GET /v1/workflows/{id}`, `POST /v1/workflows/{id}/run`, `POST /v1/runs/{id}/pause|resume|checkpoint`, `POST /v1/recovery/suggest`, `POST /v1/extract`, `POST /v1/integrations/odoo/sync`, `GET /v1/audit/{run_id}`

## Operating rules

- Use Sequential Thinking MCP on every request.
- Think in 3 passes before acting.
- Avoid unnecessary questions.
- Update memory after important discoveries.
- Prefer simple, correct, maintainable solutions.
- When reviewing code, invoke **@code-reviewer** and **@qa** in parallel from multiple lenses/perspectives, running as many instances as appropriate to cover different angles. Use sequential-thinking to coordinate and synthesize their findings.
- When given a task, first decompose it and analyze which subagents (**@architect**, **@designer**, **@code-reviewer**, **@qa**) would be valuable for different sections. Invoke them as appropriate — they can work in parallel on independent concerns.

## Current memory

- Add durable decisions here.
- Add recurring lessons here.
- Keep this file short.

## Memory files

- `memory/decisions.md` — durable architectural and product decisions
- `memory/lessons.md` — recurring lessons and patterns to remember
- `memory/conventions.md` — repo-specific conventions (use `opencode.json` instructions as source)
- `memory/changes.md` — record of significant changes made

## Custom slash commands

| Command | Description |
|---|---|
| `/lint` | Run lint across backend + extension |
| `/test` | Run full test suite (both packages) |
| `/checkpoint` | lint → typecheck → test (ordered, stops on failure) |
| `/docker-up` | Start all Docker services |
| `/review` | Multi-lens code review (launches @code-reviewer + @qa in parallel) |

## Agent skills (loaded on demand)

| Skill | Description |
|---|---|
| `code-review` | Multi-lens review using architect, code-reviewer, and QA in parallel |
| `pre-commit` | Full quality gate: lint → typecheck → test → review |
| `scaffold-module` | Create a new module following repo conventions |

## OpenCode MCP tools configured

- **playwright** — browser automation for testing
- **sequential-thinking** — structured reasoning (use on every request)
- **context7** — documentation lookup
- **memory** — persistent knowledge graph

## OpenCode subagents

- **@designer** — senior product designer and UX architect (`.opencode/agents/designer.md`)
- **@qa** — exhaustive breaker, test strategist, and QA engineer (`.opencode/agents/qa.md`)
- **@code-reviewer** — multi-perspective deep code reviewer (`.opencode/agents/code-reviewer.md`)
- **@architect** — system design, module boundaries, data models, API contracts, technical decisions (`.opencode/agents/architect.md`)

## Reference documents

- `UI-UX-SPEC.md` — full UI/UX design specification

## Developer commands

- `docker compose up` — start all services locally
- Tests: run via Playwright (browser E2E) and pytest (unit/integration)
- Lint/typecheck: follow Python + TypeScript project defaults once configured

## Conventions

- Backend: Python (FastAPI). Use Pydantic for all schemas.
- Extension: TypeScript, Manifest V3.
- Adapters: separate module per target system (Odoo first). Never couple core runtime to adapter logic.
- Audit events: append-only, each event includes `hash` and `previous_hash` for tamper evidence.
- AI recovery: must log confidence score, explanation, and whether human confirmation is required. Never silently execute low-confidence recovery.
