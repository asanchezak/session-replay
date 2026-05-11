# Architectural Audit — Full Report

**Date:** 2026-05-11
**Auditor:** Architect subagent

## Overall Assessment

The macro-architecture is sound — clean separation of concerns, well-reasoned decisions in `memory/decisions.md`, and the recording kernel is functional and tested. But there are significant gaps between the packages and several critical defects.

---

## Critical Risks (P0 — Fix Before Slice 1)

### R1 — Hash chain fork under concurrent writes
- **File:** `backend/services/audit.py`
- **Risk:** Two simultaneous events for the same run can read the same `previous_hash` value and both write with the same parent hash, forking the chain. Each new event does `SELECT MAX(id) ...` without locking.
- **Fix:** Wrap in `SELECT ... FOR UPDATE` on the last event + unique constraint on `(run_id, hash)`.

### R2 — HumanIntervention table never created
- **File:** `backend/core/models/intervention.py`
- **Risk:** Model exists in Python, but no Alembic migration creates the `human_interventions` table. Human-in-the-loop is a core product requirement — breaks completely.
- **Fix:** Create migration 003 with the `HumanIntervention` table.

### R3 — Extension popup messages silently fail
- **File:** `extension/src/background/service-worker.ts`
- **Risk:** `START_RECORDING` and `STOP_RECORDING` messages from the popup have no explicit handlers in the service worker. The popup buttons dispatch messages that go nowhere.
- **Fix:** Wire message handlers for recording lifecycle in the service worker.

### R4 — All GET endpoints are unprotected
- **File:** `backend/api/main.py:50-62`
- **Risk:** Auth middleware only checks `request.method != "GET"`. All workflow/run/event data is publicly readable.
- **Fix:** Remove GET exception or implement per-endpoint permissions.

### R5 — API key and base URL hardcoded in extension
- **File:** `extension/src/background/api.ts:4`
- **Risk:** `API_KEY = "dev-api-key-change-in-production"` is in the compiled bundle. The decision to use `chrome.storage.session` was never implemented.
- **Fix:** Move config to `chrome.storage.session` with an onboarding flow.

---

## Key Architecture Gaps (P1 — Fix for Slice 2)

### Missing API Endpoints (12 total)
- `POST /v1/workflows/{id}/run` — execute a workflow
- `POST /v1/runs/{id}/checkpoint` — checkpoint state
- `POST /v1/runs/{id}/fail` — mark run as failed
- `POST /v1/runs/{id}/complete` — mark run as completed
- `POST /v1/recovery/suggest` — AI recovery suggestion
- `POST /v1/extract` — data extraction
- `POST /v1/integrations/odoo/sync` — Odoo sync trigger
- `GET /v1/audit/{run_id}` — audit trail with chain verification
- `GET /v1/connectors` — list connectors
- `POST /v1/connectors` — configure a connector
- `POST /v1/connectors/{id}/test` — test connection
- `POST /v1/interventions` — record human intervention

### No worker architecture
- Step execution, AI calls, and recovery suggestions are synchronous in API handlers
- Will exceed HTTP timeouts for long-running operations
- **Deferred per decision** but needs planning for Slice 2

### Frontend has zero API integration
- All pages are static stubs
- No data fetching, no auth, no loading/error states
- No hooks, no API client

### State machine bypass
- `create_run` in `execution_service.py` sets `status="queued"` directly without calling `can_transition`
- Skips validation entirely

### Adapter persistence missing
- Connector configurations are in-memory only
- Lost on server restart

### No shared schema layer
- `shared/schemas/` is empty
- Types duplicated across backend (Pydantic), extension (TypeScript interfaces), and frontend (TypeScript)
- No synchronization mechanism

---

## Data Model Gaps (vs PRD §10)

| Model | Missing Fields | Impact |
|---|---|---|
| `ExecutionRun` | `total_steps` | UI can't show progress as fraction |
| `Workflow` | `connector_id` | No link to adapter config |
| — | `Artifact` model (screenshots, DOM snapshots) | No storage tracking |
| — | `RecoveryAttempt` model | No structured recovery history |
| `CandidateOrRecord` | Entire model missing | No structured output storage |

---

## Recommendations Summary

**Immediate (P0):**
1. Fix hash chain concurrency — atomic `previous_hash` fetch + unique constraint
2. Create migration 003 for `HumanIntervention` table
3. Wire extension message handlers for recording lifecycle
4. Protect all endpoints with auth middleware
5. Move extension config to `chrome.storage.session`

**Before Slice 2 (P1):**
6. Implement 12 missing API endpoints
7. Add Arq/RQ worker + Redis to docker-compose
8. Integrate frontend with backend (API client, auth, loading states)
9. Persist connector configurations
10. Fix state machine bypass in `create_run`
11. Add service-level tests for execution_service and workflow_service
