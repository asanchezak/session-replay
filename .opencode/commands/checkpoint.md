---
description: Run lint -> typecheck -> test in sequence
---
Run the full pre-commit verification chain in order. Stop and report if any step fails.

1. Lint: `cd backend && uv run ruff check .` then `cd extension && npx tsc --noEmit`
2. Typecheck: `cd backend && uv run mypy .` then `cd extension && npx tsc --noEmit`
3. Test: `cd backend && uv run pytest` then `cd extension && npx vitest run`

If lint fails, do not proceed to typecheck. If typecheck fails, do not proceed to test.
Report the first failure clearly with the command that failed and the error output.
