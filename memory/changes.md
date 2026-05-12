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
