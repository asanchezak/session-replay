---
name: pre-commit
description: Run verification chain before committing — lint, typecheck, test, and review
---
## What it does
Runs the full pre-commit quality gate in order:
1. Lint (both packages)
2. Typecheck (both packages)
3. Test (both packages)
4. Code review if changes are significant

## When to use
Use this before creating any commit to ensure nothing is broken.

## Important
- Do NOT proceed past a failed step — fix and re-run
- For trivial changes (docs, config, typo fixes), skip the code review
