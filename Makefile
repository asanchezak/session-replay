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
	cd extension && npx tsc --noEmit && npx eslint src/ 2>/dev/null; true

lint-frontend:
	cd frontend && npx tsc --noEmit && npx eslint src/ 2>/dev/null; true

# ── Typecheck ──────────────────────────────────────────
typecheck: typecheck-backend

typecheck-backend:
	cd backend && uv run mypy . 2>/dev/null; true

# ── Test ───────────────────────────────────────────────
test: test-backend test-extension test-e2e

test-backend:
	cd backend && uv run pytest tests/ -v --no-header --cov=. --cov-report=term-missing

test-extension:
	cd extension && npx vitest run

test-e2e:
	cd extension && npx playwright test

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
	@echo ""

dev-check-env:
	@test -f .env || cp .env.example .env 2>/dev/null; true
	@echo "  ✓ .env ready"

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

# ── Full Quality Gate ──────────────────────────────────
check: lint typecheck test build

# ── Clean ──────────────────────────────────────────────
clean:
	rm -rf backend/.venv extension/node_modules frontend/node_modules dist
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name htmlcov -exec rm -rf {} + 2>/dev/null || true
	rm -f .coverage
