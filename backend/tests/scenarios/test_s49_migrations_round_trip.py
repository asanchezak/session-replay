"""S49 — alembic upgrade → downgrade → upgrade against a real Postgres container.

Pure delegate to the integration variant so the scenario is picked up by
`make test-scenarios`.
"""
from __future__ import annotations

import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.slow]


def test_delegates_to_integration(request):
    pytest.skip("See backend/tests/integration/test_migrations_round_trip.py for the real test.")
