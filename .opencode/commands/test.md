---
description: Run full test suite
---
Run the full test suite across both packages and report results.

1. Backend: `uv run pytest` in `backend/`
2. Extension: `npx vitest run` in `extension/`

Focus on failures and suggest fixes. Show coverage gaps.
