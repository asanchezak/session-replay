---
description: Run lint across backend and extension
---
Run linters across both packages and fix any issues found.

1. Backend: `uv run ruff check .` in `backend/`
2. Extension: `npx tsc --noEmit` in `extension/`

Report any failures and suggest fixes. Do not stop at the first error.
