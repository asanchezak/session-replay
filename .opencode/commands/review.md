---
description: Run code review using all four review lenses in parallel
---
Run a comprehensive code review by invoking the review agents in parallel:

1. Launch **@code-reviewer** from the correctness + security + performance lenses
2. Launch **@code-reviewer** from the maintainability + architecture lens
3. Launch **@qa** to attack the changes adversarially
4. Use sequential-thinking to synthesize findings from all three into a final report

The changes under review are the current working tree (unstaged + staged diff).
Run `git diff` and `git diff --cached` to identify what to review.
