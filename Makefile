.PHONY: setup lint typecheck test clean docker-up docker-down

# ── Setup ──────────────────────────────────────────────
setup: setup-backend setup-extension

setup-backend:
	cd backend && uv venv && uv sync

setup-extension:
	cd extension && npm install

# ── Lint ───────────────────────────────────────────────
lint: lint-backend lint-extension

lint-backend:
	cd backend && uv run ruff check .

lint-extension:
	cd extension && npx tsc --noEmit && npx eslint src/

# ── Typecheck ──────────────────────────────────────────
typecheck: typecheck-backend typecheck-extension

typecheck-backend:
	cd backend && uv run mypy .

typecheck-extension:
	cd extension && npx tsc --noEmit

# ── Test ───────────────────────────────────────────────
test: test-backend test-extension

test-backend:
	cd backend && uv run pytest

test-backend-unit:
	cd backend && uv run pytest tests/unit

test-backend-integration:
	cd backend && uv run pytest tests/integration

test-extension:
	cd extension && npx vitest run

# ── Docker ─────────────────────────────────────────────
docker-up:
	docker compose up

docker-down:
	docker compose down

docker-build:
	docker compose build

# ── Clean ──────────────────────────────────────────────
clean:
	rm -rf backend/.venv extension/node_modules dist dist-extension
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
