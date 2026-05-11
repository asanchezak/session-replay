# Durable Decisions

| Date | Decision | Rationale |
|---|---|---|
| 2025-05-11 | Vertical slice delivery — build record→store kernel first | Avoids months of horizontal infrastructure before any working feature |
| 2025-05-11 | Two-stage extension build: Vite (UI) + tsc (scripts) | Avoids MV3 service worker bundling issues with Vite alone |
| 2025-05-11 | SQLite for tests with JSON columns (not JSONB) | Enables fast local test without PostgreSQL dependency |
| 2025-05-11 | Migration files use JSONB explicitly for PG prod | Alembic migrations target PostgreSQL, ORM models use compat JSON |
| 2025-05-11 | No worker until Slice 2+ | Direct API calls are sufficient for MVP. Deferred: Arq when background queue needed |
| 2025-05-11 | SHA-256 hash chain with nonce | Nonce prevents identical-payload hash collisions |
| 2025-05-11 | Error contract: {error: {code, message, details}} | Consistent machine-readable errors across all endpoints |
| 2025-05-11 | API key in chrome.storage.session (not local) | Reduced exposure window — wiped when browser closes |
| 2025-05-11 | Single AI client with modular prompt builders | 6 separate AI modules is over-engineering for v1 |
| 2025-05-11 | fsspec for storage abstraction | Same API for Minio (dev), S3 (prod), local disk (test) |
