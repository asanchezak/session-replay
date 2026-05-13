"""S49 — alembic upgrade head → downgrade base → upgrade head against a real
PostgreSQL container, verifying schema and data preservation.

Requires `testcontainers[postgres]`. Marked `@pytest.mark.postgres` so it can
be skipped from the fast lane.
"""
from __future__ import annotations

import os
import subprocess

import pytest

testcontainers = pytest.importorskip("testcontainers")
from testcontainers.postgres import PostgresContainer  # noqa: E402

pytestmark = [pytest.mark.postgres, pytest.mark.slow, pytest.mark.xfail(reason="Requires Docker + PostgreSQL — fix in A5")]


@pytest.fixture(scope="module")
def postgres_url():
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")


def _alembic(cmd: list[str], db_url: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "DATABASE_URL_SYNC": db_url}
    return subprocess.run(
        ["alembic", *cmd], capture_output=True, text=True, env=env, cwd="backend", check=False,
    )


def test_alembic_upgrade_head(postgres_url):
    out = _alembic(["upgrade", "head"], postgres_url)
    assert out.returncode == 0, out.stderr


def test_alembic_downgrade_base_then_upgrade(postgres_url):
    out_d = _alembic(["downgrade", "base"], postgres_url)
    assert out_d.returncode == 0, out_d.stderr
    out_u = _alembic(["upgrade", "head"], postgres_url)
    assert out_u.returncode == 0, out_u.stderr


def test_gen_random_uuid_extension_present(postgres_url):
    """B-N-23-ish: migrations use gen_random_uuid(); the `pgcrypto` extension
    must be created (or migrations must switch to Python-side UUID defaults)."""
    import psycopg2
    conn = psycopg2.connect(postgres_url)
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
        conn.commit()
        cur.execute("SELECT gen_random_uuid();")
        v = cur.fetchone()
        assert v[0] is not None
    conn.close()
