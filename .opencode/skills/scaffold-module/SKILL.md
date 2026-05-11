---
name: scaffold-module
description: Create a new module following the repo's conventions for structure, tests, and exports
---
## What it does
Creates a new module with the correct directory layout, init files, test stubs, and export wiring.

## When to use
Use this when adding a new:
- Backend service module (under backend/)
- Adapter (under backend/adapters/)
- AI module (under backend/ai/)
- API router (under backend/api/)
- Extension feature module (under extension/src/)

## Conventions enforced
- Python modules: `__init__.py`, `pyproject.toml` deps, test file in `tests/unit/`
- TypeScript modules: `index.ts`, barrel exports, test file in `__tests__/`
- Adapters: must implement the base adapter interface
- Every new module must have at minimum a unit test stub
