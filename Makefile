.PHONY: setup lint typecheck test clean docker-up docker-down dev

# ── Setup ──────────────────────────────────────────────
setup: setup-backend setup-extension setup-frontend

setup-backend:
	cd backend && uv sync --all-extras

setup-extension:
	cd extension && npm install

setup-frontend:
	cd frontend && npm install

# ── Lint ───────────────────────────────────────────────
lint: lint-backend lint-extension

lint-backend:
	cd backend && uv run ruff check .

lint-extension:
	cd extension && npx tsc --noEmit && npx eslint src/

lint-frontend:
	cd frontend && npx tsc --noEmit && npx eslint src/

# ── Typecheck ──────────────────────────────────────────
typecheck: typecheck-backend typecheck-extension typecheck-frontend

typecheck-backend:
	cd backend && uv run mypy .

typecheck-extension:
	cd extension && npx tsc --noEmit

typecheck-frontend:
	cd frontend && npx tsc --noEmit

# ── Test ───────────────────────────────────────────────
test: test-backend test-extension test-e2e

test-backend:
	cd backend && uv run pytest tests/ -v --no-header --cov=. --cov-report=term-missing --cov-report=html

test-extension:
	cd extension && npx vitest run

test-e2e:
	@echo "Checking backend is running..."
	@curl -s http://localhost:8081/v1/health | grep -q ok || (echo "✗ Backend not running. Start it with: make dev-backend" && exit 1)
	cd extension && E2E_API_KEY="$$(awk 'match($$0,/^[[:space:]]*API_KEY[[:space:]]*=/){v=substr($$0,RSTART+RLENGTH); gsub(/\r/,"",v); sub(/^[[:space:]]+/,"",v); sub(/[[:space:]]+$$/,"",v); if ((v ~ /^".*"$$/) || (v ~ /^'\''.*'\''$$/)) v=substr(v,2,length(v)-2); print v; exit}' ../.env)" npx playwright test

# ── Autonomy E2E (Phase 0 / 1 / 3 verification) ────────
# Single command that proves the AI-driven autonomy fixes are wired in
# end-to-end. Writes a Markdown report to test-results/.
autonomy-e2e:
	@echo "▶ Autonomy E2E — full verification"
	@mkdir -p test-results
	@echo "  [1/4] Backend unit tests (PlanUpdate + RecoverySupervisor + agent)"
	@cd backend && uv run pytest tests/unit/test_plan_updates.py tests/unit/test_recovery_supervisor.py tests/unit/test_agent_service.py -q
	@echo "  [2/4] Checking backend is running (required for live probe)"
	@curl -s http://localhost:8081/v1/health | grep -q ok || (echo "✗ Backend not running. Start it with: make dev-backend" && exit 1)
	@echo "  [3/4] Live HTTP probe — agent must ADAPT past a session-specific selector"
	@python3 scripts/verify_autonomy.py
	@echo "  [4/4] Generating report"
	@python3 scripts/autonomy_report.py
	@echo "✓ Report written to test-results/autonomy-report-latest.md"

# ── Coverage ───────────────────────────────────────────
coverage:
	cd backend && uv run pytest tests/ --cov=. --cov-report=html --cov-report=term-missing

coverage-e2e:
	cd extension && npx playwright test --reporter=html

# ── Build ──────────────────────────────────────────────
build: build-extension build-frontend

build-extension:
	cd extension && npx tsc --noEmit && npx vite build

build-frontend:
	cd frontend && npx vite build

# ── Docker ─────────────────────────────────────────────
docker-up:
	docker compose up

docker-down:
	docker compose down

docker-build:
	docker compose build

# ── Dev Servers ─────────────────────────────────────────
dev: dev-check-env dev-backend dev-frontend
	@echo ""
	@echo "  ✓ Backend:  http://localhost:8081"
	@echo "  ✓ Frontend: http://localhost:5173"
	@echo "  ✓ Health:   curl http://localhost:8081/v1/health"
	@echo "  ✓ Logs:     http://localhost:8082 (Seq)"
	@echo ""

dev-logs:
	@echo "  Starting Seq log server on :8082..."
	@docker compose up -d 2>/dev/null; true
	@sleep 3
	@curl -s -o /dev/null http://localhost:8082 && echo "  ✓ Seq running on http://localhost:8082" || echo "  ✗ Seq failed to start"

logs:
	@open http://localhost:8082

dev-check-env:
	@test -f .env || cp .env.example .env 2>/dev/null; true
	@echo "  ✓ .env ready"
	@python3 scripts/check-config-consistency.py

dev-backend:
	@echo "  Starting backend on :8081..."
	@lsof -ti :8081 | xargs kill 2>/dev/null; true
	@sleep 1
	@cd backend && screen -dmS sr-backend uv run uvicorn api.main:app --host 0.0.0.0 --port 8081
	@sleep 3
	@curl -s http://localhost:8081/v1/health | grep -q ok && echo "  ✓ Backend running on :8081" || echo "  ✗ Backend failed to start"

dev-frontend:
	@echo "  Starting frontend..."
	@cd frontend && screen -dmS sr-frontend npx vite --host 0.0.0.0
	@sleep 3
	@curl -s -o /dev/null http://localhost:5173 && echo "  ✓ Frontend running on :5173" || echo "  ✗ Frontend failed to start"

# ── Smoke / Regression / Security / Chaos ─────────────
test-smoke:
	cd backend && uv run pytest tests/ -v --no-header -m "smoke" --no-header
	cd extension && npx vitest run tests/test_capture.test.ts tests/test_replay_selectors.test.ts --reporter=verbose

test-security:
	cd backend && uv run pytest tests/ -v -m "security"
	cd extension && npx vitest run tests/test_security.test.ts

test-chaos:
	cd extension && npx playwright test e2e/chaos.spec.ts

test-performance:
	cd backend && uv run pytest tests/ -v -m "performance"
	cd extension && npx vitest run tests/test_performance.test.ts

test-all:
	cd backend && uv run pytest tests/ -v --no-header --cov=. --cov-report=term-missing
	cd extension && npx vitest run
	cd frontend && npx vitest run

# ── Config Consistency ─────────────────────────────────
check-config:
	@echo "Checking cross-layer config consistency..."
	@python3 scripts/check-config-consistency.py

# ── Full Quality Gate ──────────────────────────────────
check: check-config lint typecheck test build

# ── Clean ──────────────────────────────────────────────
clean:
	rm -rf backend/.venv extension/node_modules frontend/node_modules dist
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name htmlcov -exec rm -rf {} + 2>/dev/null || true
	rm -f .coverage
# ────────────────────────────────────────────────────────────────
# Appended by tests-new/. Concatenate into the main Makefile after
# `make test-scenarios` etc. are wired up.
# ────────────────────────────────────────────────────────────────

# Runs the new scenarios + new unit/integration tests. Skips real-AI and
# Postgres-only tests (marked @pytest.mark.postgres or @pytest.mark.slow).
test-scenarios:
	cd backend && uv run pytest tests/scenarios/ tests/unit/test_audit_chain_tamper.py tests/unit/test_healing_confidence.py tests/unit/test_state_machine_concurrency.py tests/unit/test_state_machine_property.py tests/unit/test_selector_normalization.py tests/unit/test_workflow_service_delete.py tests/unit/test_pagination_bounds.py tests/unit/test_error_contract.py tests/unit/test_idempotency_scope.py tests/unit/test_ai_client.py tests/integration/test_odoo_adapter_mocked.py tests/integration/test_ai_provider_failures.py tests/integration/test_connectors_persistence.py tests/integration/test_debug_log_auth.py tests/integration/test_cors_csrf.py tests/integration/test_rate_limit.py tests/integration/test_generate_prompt.py tests/integration/test_auth_middleware.py tests/integration/test_events_idempotency.py -v -m "not postgres and not slow"

# Runs the AI-backed tests against the real provider. Requires AI_API_KEY in env.
test-real-ai:
	@if [ -z "$$AI_API_KEY" ]; then echo "✗ AI_API_KEY not set; aborting"; exit 1; fi
	cd backend && AI_API_KEY=$$AI_API_KEY uv run pytest tests/integration/test_ai_provider_failures.py -v -m "real_ai"

# Runs the full suite against a real PostgreSQL container.
# Requires `testcontainers[postgres]` and Docker.
test-postgres:
	cd backend && uv run pytest tests/integration/test_migrations_round_trip.py tests/scenarios/test_s49_migrations_round_trip.py -v -m "postgres or slow"

# Run the new extension unit suite.
test-extension-new:
	cd extension && npx vitest run tests/test_capture_pii.test.ts tests/test_replay_controlled_inputs.test.ts tests/test_selectors_property.test.ts tests/test_intent.test.ts tests/test_replay_selectors.test.ts tests/test_healer.test.ts tests/test_detector.test.ts tests/test_orchestrator.test.ts tests/test_logger.test.ts

# Run the new extension scenario specs (S01–S50 portion).
test-extension-scenarios:
	cd extension && npx playwright test e2e/scenarios/

# Run the new frontend suite (unit + e2e).
test-frontend-new:
	cd frontend && npx vitest run
	cd frontend && npx playwright test
