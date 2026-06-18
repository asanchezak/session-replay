# TESTING_STRATEGY.md — session-replay

Companion to [`AUDIT_FINDINGS.md`](./AUDIT_FINDINGS.md). Every test described here either covers a real feature (per PRD §7) or pins a real bug (per the audit). Test IDs that document a known bug carry an `xfail` marker so the fix automatically turns them green.

---

## §0 Goals and guardrails

- **Deterministic-first.** AI calls are stubbed by default; the real-AI suite is opt-in and runs nightly only.
- **Prod parity where it matters.** Hash chain, migrations, and JSONB constraints are covered against PostgreSQL via `testcontainers-postgres`. The default test DB stays SQLite for speed.
- **One test, one fact.** Each test asserts one observable behavior. No omnibus tests.
- **Real DOM, real browser, real extension where it counts.** Replay tests run inside `chromium` with the actual extension loaded. No JSDOM-only replay tests except for pure selector/utility logic.
- **Pin bugs.** Every Critical/Major finding has at least one test, even if that test is `xfail` today. When the bug is fixed, the test turns green.
- **No green-washing.** A passing test that doesn't exercise the real code path is worse than no test.

## §1 Test pyramid

```
              ┌────────────────┐
              │  E2E (Playwright)        ≈10 %
              │  - extension loaded in chromium
              │  - frontend + backend in real network calls
              ├────────────────┤
              │  Integration (pytest / vitest)         ≈20 %
              │  - API in-process with httpx
              │  - mocked OpenAI / Odoo via respx
              │  - real Postgres via testcontainers
              ├────────────────┤
              │  Unit (pytest / vitest)         ≈70 %
              │  - services, models, selectors, prompts
              │  - jsdom-based for capture/replay utilities
              └────────────────┘
   Cross-cutting:  Contract tests, property-based tests
```

## §2 Feature inventory

Every feature gets at least one test at each pyramid level (unit, integration, E2E) — unless explicitly waived with a one-line rationale in §3.

| # | Feature | PRD ref | Owner code |
|---:|---|---|---|
| 1 | Workflow CRUD | §10.1 | `backend/services/workflow_service.py` |
| 2 | Step authoring + ordering + validation | §10.2 | `backend/api/v1/workflows.py` |
| 3 | Recording (extension) | §7.1 | `extension/src/content/{capture,index}.ts` |
| 4 | Recording context capture (a11y / DOM / screenshot / intent) | §7.1 | same |
| 5 | Replay selector chain (a11y → stable → text → … → visual) | §7.2 | `extension/src/content/{replay,selectors}.ts` |
| 6 | Step execution & step-result reporting | §11 | `extension/src/background/service-worker.ts`, `backend/api/v1/runs.py` |
| 7 | Run state machine | §12 | `backend/core/state_machine.py`, `backend/services/execution_service.py` |
| 8 | Pause / resume / cancel | §11 | same |
| 9 | Checkpoint | §11 | `backend/api/v1/runs.py:checkpoint_run` |
| 10 | Self-healing (deterministic) | §7.3 | `extension/src/background/healer.ts` |
| 11 | Self-healing (AI + confidence + human gate) | §7.3 §13 | `backend/services/healing_service.py` + extension healer |
| 12 | Human intervention (CAPTCHA / login / 2FA / modal / ambiguity) | §7.4 | `extension/src/background/detector.ts` + backend `HumanIntervention` |
| 13 | Audit trail (hash chain + nonce + sequence + tamper-evident) | §7.6 | `backend/services/audit.py` + `core/models/event.py` |
| 14 | Artifacts (screenshots, DOM snapshots, a11y trees) | §10.5 | not yet implemented |
| 15 | Search & extraction | §7.7 | `backend/api/v1/ai.py:/extract` (stub) |
| 16 | Workflow templates | §7.8 | not implemented |
| 17 | Promptable workflow generation | §7.9 | `backend/api/v1/workflows.py:generate-prompt` |
| 18 | Odoo adapter | §7.5 | `backend/adapters/odoo/*.py` |
| 19 | Adapter registry / multi-adapter | §18 | `backend/adapters/registry.py` |
| 20 | Connector config CRUD + test connection | §16 | `backend/api/v1/connectors.py` |
| 21 | Event ingestion + idempotency | §11 | `backend/api/v1/events.py` |
| 22 | Debug log | n/a | `backend/api/v1/debug.py` |
| 23 | AI client (provider switching, errors, timeouts) | §13 | `backend/ai/client.py` |
| 24 | API auth (X-API-Key) | §15 | `backend/api/main.py:auth_middleware` |
| 25 | CORS + CSRF | §15 | `backend/api/main.py:CORSMiddleware` |
| 26 | Rate limiting | §15 | `backend/api/main.py:rate_limit_middleware` |
| 27 | Pagination | n/a | `*.list_*` endpoints |
| 28 | Error contract `{error:{code,message,details}}` | §15 | every endpoint |
| 29 | Migrations (alembic up/down, PG parity) | n/a | `backend/migrations/` |
| 30 | Frontend Dashboard | UX §3.1 | `frontend/src/pages/DashboardPage.tsx` |
| 31 | Frontend Workflows list | UX §3.2 | `frontend/src/pages/WorkflowsPage.tsx` |
| 32 | Frontend Workflow detail | UX §3.3 | `frontend/src/pages/WorkflowDetailPage.tsx` |
| 33 | Frontend Run viewer / live replay | UX §3.5 | not implemented |
| 34 | Frontend Audit explorer | UX §3.6 | `frontend/src/pages/AuditPage.tsx` |
| 35 | Frontend Connectors | UX §3.8 | `frontend/src/pages/ConnectorsPage.tsx` |
| 36 | Frontend Settings (persistence) | UX §3.9 | `frontend/src/pages/SettingsPage.tsx` (broken) |
| 37 | Frontend Global search | UX §2 | not implemented |
| 38 | Frontend Sidebar live counts | UX §2 | not implemented |
| 39 | Frontend Intervention modal | UX §3.7 | not implemented |
| 40 | Frontend Breadcrumbs / right drawer | UX §2 | not implemented |
| 41 | Extension popup: record / run / pause / resume | UX §4.1 | `extension/popup/App.tsx` |
| 42 | Extension panel: inline step list | UX §4.x | `extension/panel/index.tsx` |
| 43 | Extension service-worker lifecycle (durability, alarms) | n/a | `extension/src/background/service-worker.ts` |
| 44 | Extension content-script lifecycle (per-navigation cleanup) | n/a | `extension/src/content/index.ts` |
| 45 | Cross-frame / shadow-DOM target handling | n/a | replay + selectors |
| 46 | PII / password redaction | §15 | content/capture + backend/redact |
| 47 | Logger ring buffer + sink to backend | n/a | `extension/src/shared/logger.ts` + `/v1/debug/log` |

## §3 Per-feature test plan

Each feature lists the unit/integration/E2E tests to be created, with the file path. Tests that pin a known bug are marked **[xfail]**. Tests that map to a numbered scenario (`Sxx`) are marked accordingly.

### F1 Workflow CRUD
- unit: `backend/tests/unit/test_workflow_service.py::test_create_get_list_update_delete` — happy paths.
- unit: `…test_delete_cascades_steps` **[xfail, B-C-05]** — pins the orphan-step bug.
- unit: `…test_update_status_state_machine` **[xfail, B-M-14]** — pins missing state machine on workflow status.
- integration: `backend/tests/integration/test_workflow_api.py::test_crud_via_api`.
- E2E: `frontend/e2e/workflows_list.spec.ts::create_then_delete_workflow`.

### F2 Step authoring + ordering + validation
- unit: `backend/tests/unit/test_workflow_service.py::test_add_step_validation` — accepts valid `action_type`, rejects unknown.
- unit: `…test_step_index_contiguity` **[xfail, B-M-21-ish]** — pins gaps in step_index.
- integration: `backend/tests/integration/test_value_and_methods_api.py` already exists; extend with `test_action_type_rejected` ensuring backend validates known set.

### F3 Recording (extension)
- unit (jsdom): `extension/tests/test_capture.test.ts` already exists for click; extend with `test_capture_select_keyboard_submit_hover_copy_paste_tabchange`.
- unit (jsdom): `extension/tests/test_capture_pii.test.ts` — `<input type="password">` redacted; cc-number redacted; ssn redacted. **[fails today]**
- E2E `extension/e2e/scenarios/s01_linkedin_like_search.spec.ts` — S01.
- E2E `extension/e2e/scenarios/s02_sw_restart_midflow.spec.ts` — S02.
- E2E `extension/e2e/scenarios/s03_record_popup_closed.spec.ts` — S03.
- E2E `extension/e2e/scenarios/s04_record_same_origin_iframe.spec.ts` — S04.
- E2E `extension/e2e/scenarios/s05_record_across_navigation.spec.ts` — S05.
- E2E `extension/e2e/scenarios/s06_record_password_redacted.spec.ts` — S06 **[expected to fail today]**.
- E2E `extension/e2e/scenarios/s07_record_file_upload.spec.ts` — S07.
- E2E `extension/e2e/scenarios/s08_record_keyboard_shortcuts.spec.ts` — S08.

### F4 Recording context (a11y / DOM / intent)
- unit (jsdom): `extension/tests/test_intent.test.ts` — `buildIntent` outputs the expected English for click/type/select/scroll/hover/navigate.
- unit (jsdom): `extension/tests/test_selectors_property.test.ts` — property-based via `fast-check` ensures `buildCssSelector(el)` always resolves back to `el`.

### F5 Replay selector chain
- unit (jsdom): `extension/tests/test_replay_selectors.test.ts` — each strategy resolves; chain falls through on failure.
- unit (jsdom): `extension/tests/test_replay_controlled_inputs.test.ts` — `simulateType` works on React-controlled input (mocked native setter). **[fails today, E-C-01]**
- E2E `extension/e2e/scenarios/s09_replay_stable_dom.spec.ts` — S09.
- E2E `extension/e2e/scenarios/s10_replay_css_mangled.spec.ts` — S10.
- E2E `extension/e2e/scenarios/s11_replay_sibling_reorder.spec.ts` — S11.
- E2E `extension/e2e/scenarios/s12_replay_react_controlled_input.spec.ts` — S12 **[expected to fail today]**.
- E2E `extension/e2e/scenarios/s13_replay_vue_v_model.spec.ts` — S13.
- E2E `extension/e2e/scenarios/s14_replay_shadow_dom.spec.ts` — S14.
- E2E `extension/e2e/scenarios/s15_replay_slow_network.spec.ts` — S15.
- E2E `extension/e2e/scenarios/s16_replay_step_opens_new_tab.spec.ts` — S16.

### F6 Step execution & step-result reporting
- unit: `backend/tests/unit/test_step_result.py::test_step_index_mismatch_rejected`.
- unit: `…test_step_result_records_audit_before_state_change` **[xfail, B-M-04]**.
- integration: `backend/tests/integration/test_step_result_api.py`.

### F7 Run state machine
- unit: existing `tests/unit/test_state_machine.py` (PRESERVED).
- unit (Hypothesis): `backend/tests/unit/test_state_machine_property.py::test_random_walk_never_leaves_legal_transitions`.
- unit: `…test_queued_to_failed_when_workflow_deleted` **[xfail, B-M-01]**.
- unit: `backend/tests/unit/test_state_machine_concurrency.py::test_two_concurrent_pause_attempts` — only one succeeds.

### F8 Pause / resume / cancel
- unit: existing coverage; add `…test_pause_then_resume_round_trip`.
- E2E `extension/e2e/scenarios/s23_pause_for_captcha.spec.ts` — S23.

### F9 Checkpoint
- integration: `backend/tests/integration/test_checkpoint.py::test_checkpoint_records_snapshot`.
- integration: `…test_resume_from_checkpoint` — S35.

### F10 Self-healing (deterministic)
- unit: `extension/tests/test_healer.test.ts::test_fallback_method_wins_no_ai_called`.
- E2E `extension/e2e/scenarios/s17_heal_deterministic_a11y_fallback.spec.ts` — S17.

### F11 Self-healing (AI + threshold)
- unit: `backend/tests/unit/test_healing_confidence.py::test_low_confidence_returns_below_threshold_flag` **[xfail, B-C-01]**.
- unit: `extension/tests/test_healer.test.ts::test_confidence_below_threshold_pauses_run` **[xfail, E-C-07]**.
- integration: `backend/tests/integration/test_ai_provider_failures.py::test_openai_timeout_returns_no_heal`.
- integration: `…test_openai_malformed_json_returns_no_heal`.
- E2E `extension/e2e/scenarios/s18_ai_heal_high_confidence.spec.ts` — S18.
- E2E `extension/e2e/scenarios/s19_ai_heal_mid_confidence_pauses.spec.ts` — S19 **[expected to fail today]**.
- E2E `extension/e2e/scenarios/s20_ai_heal_zero_confidence_not_applied.spec.ts` — S20 **[expected to fail today]**.
- E2E `extension/e2e/scenarios/s21_ai_heal_timeout_falls_back.spec.ts` — S21.
- E2E `extension/e2e/scenarios/s22_ai_heal_malformed_json.spec.ts` — S22.

### F12 Human intervention
- unit: `extension/tests/test_detector.test.ts::test_captcha_login_2fa_modal_detection_matrix` — pins detector behavior.
- unit: `extension/tests/test_detector.test.ts::test_detector_is_imported_somewhere` **[xfail, E-C-06]** — passes when detector is wired up.
- E2E `extension/e2e/scenarios/s24_login_modal_pause_resume.spec.ts` — S24.
- E2E `extension/e2e/scenarios/s25_2fa_pause_resume.spec.ts` — S25.
- E2E `extension/e2e/scenarios/s26_unexpected_modal.spec.ts` — S26.
- E2E `extension/e2e/scenarios/s27_ambiguous_result_set.spec.ts` — S27.

### F13 Audit trail
- unit: `backend/tests/unit/test_audit_chain_tamper.py::test_direct_payload_update_breaks_chain` — pins B-C-02.
- unit: `…test_nonce_uniqueness_per_run` **[xfail, B-C-03]**.
- unit: `…test_sequence_number_orders_chain` **[xfail, B-C-02]**.
- integration: `backend/tests/scenarios/test_s28_audit_chain_10k_events.py` — S28.
- integration: `…test_s29_tamper_payload_breaks_chain.py` — S29.
- integration: `…test_s30_duplicate_nonce_rejected.py` — S30 **[xfail today]**.
- integration: `…test_s31_concurrent_appenders_chain_linear.py` — S31.

### F14 Artifacts — DEFERRED (no implementation).
- placeholder: `backend/tests/scenarios/test_artifacts_not_implemented.py::test_artifact_endpoint_returns_501`.

### F15 Search & extraction — DEFERRED (stub).
- placeholder: `backend/tests/scenarios/test_extract_not_implemented.py::test_extract_returns_501`.

### F16 Workflow templates — DEFERRED (not implemented).

### F17 Promptable workflows
- integration: `backend/tests/integration/test_generate_prompt.py::test_no_ai_key_uses_heuristic`.
- integration: `…test_with_ai_key_calls_provider_mock`.

### F18 Odoo adapter
- integration: `backend/tests/integration/test_odoo_adapter_mocked.py::test_list_open_jobs_paginated` — S36.
- integration: `…test_upsert_candidate_idempotent` — S37.
- integration: `…test_session_expired_reauths_once` — S38.
- integration: `…test_connector_test_endpoint_surfaces_latency_and_error` — S39.

### F19 Adapter registry
- unit: `backend/tests/unit/test_adapter_registry.py::test_register_and_resolve`.

### F20 Connector config CRUD
- integration: `backend/tests/integration/test_connectors_persistence.py::test_register_persists_across_restart` **[xfail, B-M-12]**.
- integration: `…test_test_connection_returns_health`.

### F21 Event ingestion + idempotency
- integration: `backend/tests/integration/test_events_idempotency.py::test_same_key_within_run_returns_same_event`.
- integration: `…test_same_key_across_runs_both_succeed_today` **[xfail, B-C-16]** — pins scope bug.

### F22 Debug log
- integration: `backend/tests/integration/test_debug_log_auth.py::test_post_debug_log_requires_auth_today` **[xfail, B-C-11]**.

### F23 AI client
- unit: `backend/tests/unit/test_ai_client.py::test_get_ai_provider_returns_mock_without_key`.
- unit: `…test_openai_provider_parses_response`.
- integration: `…test_openai_timeout` via `respx`.

### F24 API auth
- integration: `backend/tests/integration/test_auth_middleware.py::test_missing_api_key_returns_401`.
- integration: `…test_health_is_exempt`.

### F25 CORS + CSRF
- integration: `backend/tests/integration/test_cors_csrf.py::test_disallowed_origin_rejected`.
- integration: `…test_chrome_extension_origin_allowed_today` **[xfail, B-C-13]** — pins over-permissive regex.

### F26 Rate limiting
- integration: `backend/tests/integration/test_rate_limit.py::test_429_after_burst`.
- integration: `…test_redis_backed` — skipped today (no Redis), passes when ready.

### F27 Pagination
- unit: `backend/tests/unit/test_pagination_bounds.py::test_negative_offset_rejected` **[xfail today]**.
- unit: `…test_limit_too_large_rejected` **[xfail today]**.

### F28 Error contract
- unit: `backend/tests/unit/test_error_contract.py::test_404_shape`, `…::test_409_shape`, `…::test_422_shape`, `…::test_500_shape`.

### F29 Migrations
- integration: `backend/tests/integration/test_migrations_round_trip.py::test_upgrade_downgrade_upgrade_against_postgres` — S49.

### F30–F40 Frontend
- unit (vitest, RTL): `frontend/src/__tests__/components.test.tsx` — StatusBadge, Card, DataTable, EmptyState, Banner.
- unit: `frontend/src/__tests__/useApi.test.ts` — happy path, error contract, AbortController.
- unit: `frontend/src/__tests__/useRuns.test.ts` — refetch on `workflowId` change.
- unit: `frontend/src/__tests__/useWorkflows.test.ts`.
- unit: `frontend/src/__tests__/pages/Dashboard.test.tsx` — KPI rendering, banner shows all failures (not just 2) **[xfail, F-M-01]**.
- unit: `frontend/src/__tests__/pages/WorkflowDetail.test.tsx` — Run button.
- unit: `frontend/src/__tests__/pages/Audit.test.tsx` — filters.
- unit: `frontend/src/__tests__/pages/Settings.test.tsx` — persistence **[xfail, F-C-01]**.
- E2E: `frontend/e2e/dashboard.spec.ts` — S40.
- E2E: `frontend/e2e/workflow_detail.spec.ts` — S41.
- E2E: `frontend/e2e/audit_explorer.spec.ts` — S42.
- E2E: `frontend/e2e/intervention_modal.spec.ts` — S44 **[xfail, F-C-06]**.
- E2E: `frontend/e2e/settings_persistence.spec.ts` — S43 **[xfail, F-C-01]**.

### F41–F47 Extension lifecycle + popup
- unit: `extension/tests/test_orchestrator.test.ts` — fake-chrome based.
- unit: `extension/tests/test_logger.test.ts` — ring buffer.
- E2E: `extension/e2e/scenarios/s02_sw_restart_midflow.spec.ts` (S02).
- E2E: `extension/e2e/scenarios/s32_two_clients_pause_same_run.spec.ts` — S32.
- E2E: `extension/e2e/scenarios/s33_cancel_during_heal.spec.ts` — S33.
- E2E: `extension/e2e/scenarios/s48_pii_never_leaves_browser.spec.ts` — S48.

## §4 Tooling decisions

| Concern | Tool | Notes |
|---|---|---|
| Backend unit + integration | `pytest`, `pytest-asyncio` | Already in use; `asyncio_mode="auto"`, `loop_scope="session"` |
| Property-based | `hypothesis` | State machine, selectors |
| HTTP mocking | `respx` | OpenAI + Odoo |
| Real PostgreSQL | `testcontainers-postgres` | Migration round-trip + JSONB tests |
| Extension unit | `vitest` + `jsdom` | already in `extension/package.json` |
| Browser-mocks for chrome.* | `@chrome-mocks/jest` ported to vitest, or `vitest-mock-extended` | Manual fakes for SW tests |
| Browser E2E | `@playwright/test` with `chromium.launchPersistentContext` | already used; reuse `e2e/fixtures.ts` |
| Frontend unit | `vitest` + `@testing-library/react` + `jsdom` | NEW for this project |
| Frontend E2E | `@playwright/test` | NEW config under `frontend/playwright.config.ts` |
| Coverage | `pytest --cov` + `vitest --coverage` + `playwright merge-reports` | `make coverage` already exists |
| Contract testing | Pact JSON | Generated from Pydantic & TS types (later) |

## §5 Test data & fixtures

- **DB fixtures** — extend `backend/tests/conftest.py` with `postgres_engine` (containerized), `factory.* helpers (`make_workflow`, `make_run`, `make_event_chain(n)`).
- **AI fixtures** — `backend/tests/fixtures/ai_responses/*.json` — golden responses (high confidence, low confidence, malformed, empty).
- **Odoo fixtures** — `backend/tests/fixtures/odoo/*.xml` — XML-RPC method dumps.
- **Test pages** — `extension/e2e/helpers/test-pages/`:
  - `stable.html` — controlled IDs.
  - `mangled-css.html` — same DOM, randomized classes.
  - `react-controlled-input.html` — minimal CDN-React form.
  - `vue-vmodel.html` — minimal Vue 3 form.
  - `shadow-dom.html` — custom element with slot.
  - `iframe-same-origin.html` — nested form.
  - `slow-network.html` — `?delay=3000` HTML.
  - `captcha-mock.html`, `login-mock.html`, `2fa-mock.html`, `modal-unexpected.html`.
  - `ambiguous-search.html` — 12 results, look-alike rows.
  - `popup-tab.html` — opens new tab on click.
  - `file-upload.html` — `<input type="file">`.
  - `keyboard-spa.html` — Cmd+K / Enter / Tab routing.
  - `password-form.html` — type=password + cc-number.
- **Backend Postgres test fixture** — single shared container across the session for speed, `transactional_db` fixture per-test.

## §6 Fifty real-world scenarios

The same list as in the plan, restated here as canonical. Each item links to its test file.

### Recording (S01–S08)
| # | Scenario | File |
|---|---|---|
| **S01** | Record a 12-step LinkedIn-like candidate search (click → type → select → submit → paginate → click → extract). | `extension/e2e/scenarios/s01_linkedin_like_search.spec.ts` + `backend/tests/scenarios/test_s01_record_12_step_workflow.py` |
| **S02** | Recording survives a service-worker restart mid-flow (≥ 20 events buffered, none lost). | `extension/e2e/scenarios/s02_sw_restart_midflow.spec.ts` |
| **S03** | Recording with the extension popup closed (background-only capture). | `extension/e2e/scenarios/s03_record_popup_closed.spec.ts` |
| **S04** | Recording within a same-origin iframe (events captured with frame chain). | `extension/e2e/scenarios/s04_record_same_origin_iframe.spec.ts` |
| **S05** | Recording across a tab navigation (continuous run id, new content-script handoff). | `extension/e2e/scenarios/s05_record_across_navigation.spec.ts` |
| **S06** | Recording detects and refuses to capture `<input type="password">` values (replaced with `[REDACTED:password]`). | `extension/e2e/scenarios/s06_record_password_redacted.spec.ts` **[expected fail today]** |
| **S07** | Recording captures a file-upload step (path stripped, only filename retained). | `extension/e2e/scenarios/s07_record_file_upload.spec.ts` |
| **S08** | Recording captures keyboard shortcuts (Tab, Enter, Cmd+K) on a SPA. | `extension/e2e/scenarios/s08_record_keyboard_shortcuts.spec.ts` |

### Replay (S09–S16)
| # | Scenario | File |
|---|---|---|
| **S09** | Replay against a stable DOM — 100% pass, zero AI calls, complete audit. | `extension/e2e/scenarios/s09_replay_stable_dom.spec.ts` |
| **S10** | Replay after CSS classes mangled — a11y fallback succeeds without AI. | `extension/e2e/scenarios/s10_replay_css_mangled.spec.ts` |
| **S11** | Replay after sibling re-order — text anchor fallback succeeds. | `extension/e2e/scenarios/s11_replay_sibling_reorder.spec.ts` |
| **S12** | Replay on React controlled-input form (native setter path). | `extension/e2e/scenarios/s12_replay_react_controlled_input.spec.ts` **[expected fail today]** |
| **S13** | Replay on Vue 3 form (`v-model`). | `extension/e2e/scenarios/s13_replay_vue_v_model.spec.ts` |
| **S14** | Replay on shadow-DOM custom element with slot. | `extension/e2e/scenarios/s14_replay_shadow_dom.spec.ts` |
| **S15** | Replay on slow page (3G simulation) — waits hold, no flake. | `extension/e2e/scenarios/s15_replay_slow_network.spec.ts` |
| **S16** | Replay step opens a popup tab — orchestrator follows new tab. | `extension/e2e/scenarios/s16_replay_step_opens_new_tab.spec.ts` |

### Self-healing (S17–S22)
| # | Scenario | File |
|---|---|---|
| **S17** | Deterministic heal: primary CSS fails, a11y fallback wins (no AI). | `extension/e2e/scenarios/s17_heal_deterministic_a11y_fallback.spec.ts` |
| **S18** | AI heal: confidence 0.92 → applied. | `extension/e2e/scenarios/s18_ai_heal_high_confidence.spec.ts` |
| **S19** | AI heal: confidence 0.40 → **not** applied; pause for human. | `extension/e2e/scenarios/s19_ai_heal_mid_confidence_pauses.spec.ts` **[expected fail today]** |
| **S20** | AI heal: confidence 0.0 (today's bug) → **not** applied. | `extension/e2e/scenarios/s20_ai_heal_zero_confidence_not_applied.spec.ts` **[expected fail today]** |
| **S21** | AI heal: AI times out → falls back deterministically; audit shows timeout. | `extension/e2e/scenarios/s21_ai_heal_timeout_falls_back.spec.ts` |
| **S22** | AI heal: AI returns malformed JSON → audit logs parse error, run pauses. | `extension/e2e/scenarios/s22_ai_heal_malformed_json.spec.ts` |

### Human intervention (S23–S27)
| # | Scenario | File |
|---|---|---|
| **S23** | CAPTCHA appears → detector pauses, popup notifies, user resumes. | `extension/e2e/scenarios/s23_pause_for_captcha.spec.ts` **[expected fail today]** |
| **S24** | Login modal mid-replay → pause; resume from checkpoint. | `extension/e2e/scenarios/s24_login_modal_pause_resume.spec.ts` |
| **S25** | 2FA prompt → pause; resume after user enters code. | `extension/e2e/scenarios/s25_2fa_pause_resume.spec.ts` |
| **S26** | Unexpected confirm modal → pause; user "accept and continue". | `extension/e2e/scenarios/s26_unexpected_modal.spec.ts` |
| **S27** | Ambiguous result set → ranker policy triggers pause for confirmation. | `extension/e2e/scenarios/s27_ambiguous_result_set.spec.ts` |

### Audit & integrity (S28–S31)
| # | Scenario | File |
|---|---|---|
| **S28** | Append-only chain intact after 10k events on one run. | `backend/tests/scenarios/test_s28_audit_chain_10k_events.py` |
| **S29** | Tamper: UPDATE a payload directly → `verify_chain` reports breakpoint. | `backend/tests/scenarios/test_s29_tamper_payload_breaks_chain.py` |
| **S30** | Tamper: insert duplicate (payload, nonce) → DB rejects. | `backend/tests/scenarios/test_s30_duplicate_nonce_rejected.py` **[xfail today]** |
| **S31** | Concurrent appenders → chain remains linear. | `backend/tests/scenarios/test_s31_concurrent_appenders_chain_linear.py` |

### State machine & concurrency (S32–S35)
| # | Scenario | File |
|---|---|---|
| **S32** | Two clients try to pause same run → exactly one wins. | `backend/tests/scenarios/test_s32_concurrent_pause.py` |
| **S33** | Run is canceled while a heal is in flight → heal aborts gracefully. | `backend/tests/scenarios/test_s33_cancel_during_heal.py` |
| **S34** | Workflow deleted while run is queued → run transitions to failed. | `backend/tests/scenarios/test_s34_workflow_deleted_during_queued_run.py` **[xfail, B-M-01]** |
| **S35** | Resume after 24 h pause works; checkpoint snapshot drives replay restart. | `backend/tests/scenarios/test_s35_long_pause_resume.py` |

### Odoo & connector (S36–S39)
| # | Scenario | File |
|---|---|---|
| **S36** | `list_open_jobs` paginates. | `backend/tests/scenarios/test_s36_odoo_list_jobs_paginates.py` |
| **S37** | `upsert_candidate` is idempotent. | `backend/tests/scenarios/test_s37_odoo_upsert_idempotent.py` |
| **S38** | Odoo session expired → adapter re-auths once. | `backend/tests/scenarios/test_s38_odoo_session_reauth_once.py` |
| **S39** | Connector test endpoint surfaces latency + error. | `backend/tests/scenarios/test_s39_connector_test_health.py` |

### Frontend / UX (S40–S44)
| # | Scenario | File |
|---|---|---|
| **S40** | Dashboard refreshes KPIs every 30 s during a run; banner shows all failures. | `frontend/e2e/dashboard.spec.ts` |
| **S41** | Workflow detail Run button → run is created, viewer opens. | `frontend/e2e/workflow_detail.spec.ts` |
| **S42** | Audit page filters by all dimensions; hash copies to clipboard. | `frontend/e2e/audit_explorer.spec.ts` |
| **S43** | Settings persistence: change retention, reload, value persists. | `frontend/e2e/settings_persistence.spec.ts` **[xfail, F-C-01]** |
| **S44** | Intervention modal: paused run shows modal with Continue/Review/Cancel. | `frontend/e2e/intervention_modal.spec.ts` **[xfail, F-C-06]** |

### Cross-cutting & non-functional (S45–S50)
| # | Scenario | File |
|---|---|---|
| **S45** | Rate limit at 600 rpm → 429 with retry_after; multi-worker share limit. | `backend/tests/scenarios/test_s45_rate_limit.py` (Redis variant `@pytest.mark.redis`) |
| **S46** | Pagination boundary: `limit=99999` → 422; `offset=-1` → 422. | `backend/tests/scenarios/test_s46_pagination_bounds.py` **[xfail today]** |
| **S47** | CORS: non-whitelisted `chrome-extension://*` ID rejected. | `backend/tests/scenarios/test_s47_cors_extension_id_whitelist.py` **[xfail today]** |
| **S48** | PII never leaves the browser: typing a fake SSN → backend EventLog redacted. | `extension/e2e/scenarios/s48_pii_never_leaves_browser.spec.ts` **[xfail today]** |
| **S49** | Migrations: alembic upgrade head + downgrade base + upgrade head on fresh Postgres; data preserved one round trip. | `backend/tests/scenarios/test_s49_migrations_round_trip.py` |
| **S50** | Chaos: kill SW mid-run + drop 30 % of API requests for 60 s → system completes / fails cleanly / pauses. | `extension/e2e/scenarios/s50_chaos_sw_kill_plus_network_drop.spec.ts` |

## §7 CI plan

| Lane | Trigger | What runs | Budget |
|---|---|---|---|
| **fast** | every push | `make lint`, `make typecheck`, backend unit, extension unit, frontend unit (vitest --no-coverage) | ≤ 3 min |
| **pr** | PR opened/updated | fast + backend integration + extension/frontend E2E (chromium only) + coverage report | ≤ 12 min |
| **nightly** | cron 02:00 UTC | pr + real-AI suite + Postgres migrations round-trip + cross-browser E2E (chromium, firefox, webkit) | ≤ 45 min |
| **weekly** | cron Sat 04:00 UTC | nightly + chaos suite (S50) + load test (10k events, 100 concurrent runs) | ≤ 4 h |

CI uses GitHub Actions. The fast lane is required to merge; pr lane is required-green to merge to `main`; nightly and weekly post to Slack on red.

## §8 Coverage targets

| Layer | Lines | Branches | Notes |
|---|---:|---:|---|
| Backend `services/` | 95 % | 85 % | hash chain, state machine, healing must be 100 % branches |
| Backend `api/v1/` | 90 % | 80 % | every endpoint at least one 2xx + 4xx test |
| Backend `core/` | 95 % | 90 % | state machine 100 % |
| Backend `adapters/` | 80 % | 70 % | Odoo mocked |
| Backend `ai/` | 80 % | 70 % | every provider error mapped |
| Extension `src/` | 80 % | 70 % | selectors, capture, replay, healer, detector ≥ 90 % |
| Frontend `src/` | 80 % | 70 % | hooks and components ≥ 90 % |

Coverage cliffs (hard gate, fail the PR):
- `services/audit.py` ≥ 95 %.
- `core/state_machine.py` = 100 %.
- `services/healing_service.py` ≥ 90 %.
- `extension/src/content/replay.ts` ≥ 85 %.
- `extension/src/background/healer.ts` ≥ 90 %.

## §9 Acceptance criteria for "tested"

A feature is considered tested when:
1. At least one happy-path unit test exists and passes.
2. At least one negative-path unit test exists (invalid input, illegal state, malformed response).
3. At least one integration test exists that touches the real HTTP boundary.
4. At least one E2E test exists, OR an explicit waiver line in §3 with reason.
5. Every documented bug from `AUDIT_FINDINGS.md` has an `xfail`/`test.fail`/`test.failing` test that pins it.

## §10 New test files inventory (delivered in this pass)

Backend:
- `backend/tests/unit/test_audit_chain_tamper.py`
- `backend/tests/unit/test_healing_confidence.py`
- `backend/tests/unit/test_state_machine_concurrency.py`
- `backend/tests/unit/test_state_machine_property.py`
- `backend/tests/unit/test_selector_normalization.py`
- `backend/tests/unit/test_workflow_service_delete.py`
- `backend/tests/unit/test_pagination_bounds.py`
- `backend/tests/unit/test_error_contract.py`
- `backend/tests/unit/test_idempotency_scope.py`
- `backend/tests/unit/test_ai_client.py`
- `backend/tests/integration/test_odoo_adapter_mocked.py`
- `backend/tests/integration/test_ai_provider_failures.py`
- `backend/tests/integration/test_connectors_persistence.py`
- `backend/tests/integration/test_debug_log_auth.py`
- `backend/tests/integration/test_cors_csrf.py`
- `backend/tests/integration/test_rate_limit.py`
- `backend/tests/integration/test_migrations_round_trip.py`
- `backend/tests/integration/test_generate_prompt.py`
- `backend/tests/integration/test_auth_middleware.py`
- `backend/tests/integration/test_events_idempotency.py`
- `backend/tests/scenarios/test_s01_record_12_step_workflow.py`
- `backend/tests/scenarios/test_s28_audit_chain_10k_events.py`
- `backend/tests/scenarios/test_s29_tamper_payload_breaks_chain.py`
- `backend/tests/scenarios/test_s30_duplicate_nonce_rejected.py`
- `backend/tests/scenarios/test_s31_concurrent_appenders_chain_linear.py`
- `backend/tests/scenarios/test_s32_concurrent_pause.py`
- `backend/tests/scenarios/test_s33_cancel_during_heal.py`
- `backend/tests/scenarios/test_s34_workflow_deleted_during_queued_run.py`
- `backend/tests/scenarios/test_s35_long_pause_resume.py`
- `backend/tests/scenarios/test_s36_odoo_list_jobs_paginates.py`
- `backend/tests/scenarios/test_s37_odoo_upsert_idempotent.py`
- `backend/tests/scenarios/test_s38_odoo_session_reauth_once.py`
- `backend/tests/scenarios/test_s39_connector_test_health.py`
- `backend/tests/scenarios/test_s45_rate_limit.py`
- `backend/tests/scenarios/test_s46_pagination_bounds.py`
- `backend/tests/scenarios/test_s47_cors_extension_id_whitelist.py`
- `backend/tests/scenarios/test_s49_migrations_round_trip.py`

Extension:
- `extension/tests/test_capture_pii.test.ts`
- `extension/tests/test_replay_controlled_inputs.test.ts`
- `extension/tests/test_selectors_property.test.ts`
- `extension/tests/test_intent.test.ts`
- `extension/tests/test_replay_selectors.test.ts`
- `extension/tests/test_healer.test.ts`
- `extension/tests/test_detector.test.ts`
- `extension/tests/test_orchestrator.test.ts`
- `extension/tests/test_logger.test.ts`
- `extension/e2e/scenarios/s01..s27, s48, s50` — one Playwright spec each (mostly stubs that drive controlled test pages)
- `extension/e2e/helpers/test-pages/*.html`

Frontend:
- `frontend/playwright.config.ts`
- `frontend/vitest.config.ts`
- `frontend/src/__tests__/setup.ts`
- `frontend/src/__tests__/components.test.tsx`
- `frontend/src/__tests__/useApi.test.ts`
- `frontend/src/__tests__/useRuns.test.ts`
- `frontend/src/__tests__/useWorkflows.test.ts`
- `frontend/src/__tests__/pages/Dashboard.test.tsx`
- `frontend/src/__tests__/pages/WorkflowDetail.test.tsx`
- `frontend/src/__tests__/pages/Audit.test.tsx`
- `frontend/src/__tests__/pages/Settings.test.tsx`
- `frontend/e2e/dashboard.spec.ts`
- `frontend/e2e/workflow_detail.spec.ts`
- `frontend/e2e/audit_explorer.spec.ts`
- `frontend/e2e/intervention_modal.spec.ts`
- `frontend/e2e/settings_persistence.spec.ts`

Makefile additions:
- `make test-scenarios`
- `make test-real-ai`
- `make test-postgres`
