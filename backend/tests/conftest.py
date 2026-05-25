import asyncio
import os
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from api.main import app
from core.config import settings
from core.database import get_db
from core.models import Base

TEST_DATABASE_URL = "sqlite+aiosqlite://"

# Disable rate limiting and set a known API key for tests
settings.rate_limit_enabled = False
settings.api_key = SecretStr("dev-api-key-change-in-production")
# Use the real AI key — pydantic-settings loads it from backend/.env automatically.
# Only fall back to the OS environment if the file didn't supply one.
if not settings.ai_api_key:
    settings.ai_api_key = os.environ.get("AI_API_KEY", "")
settings.deterministic_only = False


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def engine():
    engine = create_async_engine(TEST_DATABASE_URL, echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(engine) -> AsyncGenerator[AsyncSession, None]:
    # Bind the session to a connection with an *explicit* BEGIN sent directly to
    # the underlying SQLite connection.  Without this, Python's sqlite3 (default
    # "deferred" isolation mode) does NOT auto-begin before SAVEPOINT statements.
    # SQLite therefore treats the first SAVEPOINT as a top-level transaction;
    # RELEASE SAVEPOINT then commits it permanently, making the post-test ROLLBACK
    # a no-op and leaking rows into subsequent tests.
    async with engine.connect() as conn:
        await conn.execute(text("BEGIN"))
        session = AsyncSession(bind=conn, expire_on_commit=False)
        try:
            yield session
        finally:
            await session.close()
            try:
                await conn.execute(text("ROLLBACK"))
            except Exception:
                # A test that raised a DB error may have already triggered an
                # implicit rollback; "cannot rollback - no transaction is active"
                # is expected and harmless in that case.
                pass


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def api_client(client: AsyncClient) -> AsyncClient:
    return client
