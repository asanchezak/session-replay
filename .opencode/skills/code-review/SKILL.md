---
name: code-review
description: Run a multi-lens code review using architect, code-reviewer, and QA agents in parallel
---
## What it does
Triggers a structured code review across multiple perspectives:
- @architect — checks architecture, module boundaries, data flow
- @code-reviewer (correctness + security lens) — finds logic bugs and vulnerabilities
- @code-reviewer (maintainability + performance lens) — checks code quality and efficiency
- @qa — adversarial testing perspective

## When to use
Use this when:
- Reviewing a PR or branch before merge
- Reviewing a significant chunk of new code
- Before running /checkpoint to catch design issues early

## How to use
1. Identify the changes (git diff, file list, or specific paths)
2. Launch the agents in parallel using Task tool
3. Use sequential-thinking to synthesize their findings
4. Present a consolidated report with severity-ranked findings
