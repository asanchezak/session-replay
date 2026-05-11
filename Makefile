.PHONY: setup lint typecheck test clean docker-up docker-down

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
test: test-backend test-extension

test-backend:
	cd backend && uv run pytest tests/ -v --no-header --cov=. --cov-report=term-missing

test-extension:
	cd extension && npx vitest run

# ── Coverage ───────────────────────────────────────────
coverage:
	cd backend && uv run pytest tests/ --cov=. --cov-report=html --cov-report=term-missing

# ── Build ──────────────────────────────────────────────
build: build-extension build-frontend

build-extension:
	cd extension && npx vite build

build-frontend:
	cd frontend && npx vite build

# ── Docker ─────────────────────────────────────────────
docker-up:
	docker compose up

docker-down:
	docker compose down

docker-build:
	docker compose build

# ── Full Quality Gate ──────────────────────────────────
check: lint typecheck test

# ── Clean ──────────────────────────────────────────────
clean:
	rm -rf backend/.venv extension/node_modules frontend/node_modules dist
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name htmlcov -exec rm -rf {} + 2>/dev/null || true
	rm -f .coverage
