# QA Audit Report — Full

**Date:** 2026-05-11
**Auditor:** QA subagent

## Key Metrics

| Metric | Value |
|---|---|
| Total tests | 33 (20 backend + 13 extension) |
| Source files | 43 |
| Files with tests | 8 (~19%) |
| Estimated line coverage | **<15%** |
| Bugs found in prod code | **3** |

---

## Critical Test Coverage Black Holes

| Module | Lines | Tests | Risk |
|---|---|---|---|
| `execution_service.py` | 141 | **0** | 🔴 Core run lifecycle untested |
| `workflow_service.py` | 102 | **0** | 🔴 All CRUD untested |
| `detector.ts` | 119 | **0** | 🔴 Challenge detection untested |
| `orchestrator.ts` | 76 | **0** | 🔴 Buffer flush, retry, state broadcast |
| `api.ts` | 47 | **0** | 🔴 HTTP client, error handling |
| `ai/client.py` | 119 | **0** | 🔴 Both providers untested |
| `odoo/adapter.py` | 107 | **0** | 🟡 Entire adapter layer |
| `odoo/client.py` | 94 | **0** | 🟡 JSON-RPC client |
| Frontend (8 files) | ~400 | **0** | 🔴 All pages, components, hooks |
| Extension popup/panel | ~200 | **0** | 🟡 UI logic |

---

## 3 Production Bugs Found

### 🔴 HIGH — Audit log corruption
- **File:** `backend/services/execution_service.py:76-93`
- **What:** `from_status` is captured AFTER `run.status` is reassigned, so every transition log shows `from_status == to_status`
- **Fix:** Capture status before assignment

### 🟡 MEDIUM — Odoo search_read double-call
- **File:** `backend/adapters/odoo/client.py:82-94`
- **What:** Makes two API calls to Odoo when `fields` parameter provided
- **Fix:** Single `search_read` call with kwargs

### 🟡 MEDIUM — Missing state transition
- **File:** `backend/core/state_machine.py`
- **What:** `WAITING_FOR_USER → RECOVERING` not in transition table
- **Fix:** Add transition

---

## Infrastructure Issues

| Issue | Severity | Detail |
|---|---|---|
| `test.db` committed | 🔴 | Persists between runs — test pollution risk |
| No coverage reporting | 🟡 | `pytest-cov` installed but never run in CI |
| No E2E tests | 🔴 | Directory exists, completely empty |
| No factory fixtures | 🟡 | `factory-boy` installed but unused |
| CI: no coverage gates | 🟡 | Tests can pass at 0% coverage |
| CI: no E2E job | 🟡 | No integration testing at all |
| CI: no security scan | 🟡 | No dependency audit, no SAST |
| CI: no frontend tests | 🟡 | No vitest job in CI |
| CI: no perf benchmarks | 🟢 | Acceptable for MVP |

---

## Prioritized Test Implementation Roadmap

### Phase 1 — Foundation (this week)
1. Remove `test.db` from git + add to `.gitignore`
2. Configure coverage reporting (pytest-cov, thresholds)
3. Add `verify_chain` unit tests (edge cases: empty chain, tampered middle, multi-branch)
4. Add `execution_service` unit tests (all 10 state transitions, illegal transitions, advance_step validation)
5. Add DB override fixture to conftest so tests use `:memory:` SQLite

### Phase 2 — Core Coverage (next week)
6. `workflow_service` unit tests (CRUD + status transitions)
7. `detector.ts` unit tests (CAPTCHA, login, 2FA, modals, false positives)
8. `orchestrator.ts` unit tests (buffer flush, batch size, retry, concurrent calls)
9. `api.ts` unit tests (success, network error, auth error, malformed response)
10. Replay engine tests: iframe, shadow DOM, disabled elements, form with `preventDefault`
11. Integration tests for ALL API routes (workflows, runs, events)

### Phase 3 — Integration & Edge Cases (week 3)
12. Auth enforcement integration test (all endpoints × all methods)
13. Error contract compliance test (all endpoints return `{error: {code, message, details}}`)
14. Odoo adapter tests (auth, CRUD, error handling)
15. AI prompt builder tests (selector healing, challenge classification, extraction)
16. Hash chain edge cases (fork detection, large payloads, concurrent writes)
17. Event deduplication test (duplicate event_id → idempotent)
18. CORS test (extension origin, localhost, non-whitelisted origin)

### Phase 4 — E2E & Frontend (week 4)
19. Playwright Docker setup
20. E2E: record workflow → store → verify chain → replay
21. E2E: human intervention flow (detect → pause → resume)
22. E2E: Odoo sync flow
23. Frontend component tests (StatusBadge, DataTable, EmptyState, Modal)
24. Extension popup tests (IdleView, RecordingView, WaitingView, ErrorView)
25. State machine integration test (full lifecycle from recording → completed)

### Phase 5 — CI & Quality Gates (week 4+)
26. Coverage enforcement (≥80% target)
27. E2E CI job in GitHub Actions
28. Security scanning (pip-audit, npm audit)
29. Performance benchmarks for hash chain verification
30. Migration tests (apply/rollback all migrations)

---

## Bug Reproduction Scripts

### Bug 1: Audit log corruption
```python
# Run this against the test DB
run = await execution_service.create_run(workflow_id="...")
await execution_service.pause_run(run_id=run.id)
# Check audit log — from_status and to_status are identical
```

### Bug 2: Odoo double-call
```python
adapter = OdooAdapter(config)
result = await adapter.search_read("hr.candidate", [("id", ">", 0)], fields=["name"])
# Odoo server logs show two search_read calls
```

### Bug 3: Missing transition
```python
sm = WorkflowStateMachine()
# This raises KeyError:
sm.can_transition(RunStatus.WAITING_FOR_USER, RunStatus.RECOVERING)
```
