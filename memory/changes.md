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
