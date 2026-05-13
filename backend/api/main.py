import logging
import re
import time
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.v1.ai import router as ai_router
from api.v1.artifacts import router as artifacts_router
from api.v1.audit import router as audit_router
from api.v1.connectors import router as connectors_router
from api.v1.debug import router as debug_router
from api.v1.events import router as events_router
from api.v1.integrations import router as integrations_router
from api.v1.runs import router as runs_router
from api.v1.settings import router as settings_router
from api.v1.workflows import router as workflows_router
from core.config import settings
from core.database import engine
from core.models import Base
from services.outbox_service import OutboxService

logger = logging.getLogger(__name__)

_AUTH_EXEMPT = {"/v1/health"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.check_insecure_defaults()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    OutboxService.start_processor(_app)
    yield
    if hasattr(_app.state, "outbox_processor"):
        _app.state.outbox_processor.cancel()
    await engine.dispose()


app = FastAPI(
    title="Session Replay API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request_id = str(uuid.uuid4())
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response


@app.middleware("http")
async def csrf_origin_check(request: Request, call_next):
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("Origin")
        if origin:
            for allowed in settings.cors_origins:
                if allowed.endswith(":*"):
                    if origin.startswith(allowed[:-2]):
                        return await call_next(request)
                elif origin == allowed:
                    return await call_next(request)
            if settings.cors_origin_regex and re.fullmatch(
                settings.cors_origin_regex, origin
            ):
                return await call_next(request)
            return JSONResponse(
                status_code=403,
                content={
                    "error": {
                        "code": "FORBIDDEN",
                        "message": "Origin not allowed",
                    }
                },
            )
    return await call_next(request)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path.startswith("/v1/") and request.url.path not in _AUTH_EXEMPT:
        api_key = request.headers.get("X-API-Key", "")
        if not api_key or api_key != settings.api_key.get_secret_value():
            return JSONResponse(
                status_code=401,
                content={
                    "error": {
                        "code": "UNAUTHORIZED",
                        "message": "Invalid or missing API key",
                    }
                },
            )
    return await call_next(request)


# In-memory rate limiter: {ip: [(timestamp, endpoint), ...]}
_rate_limit_buckets: dict[str, list[tuple[float, str]]] = defaultdict(list)
RATE_WINDOW = 60


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    is_api = request.url.path.startswith("/v1/") and request.url.path not in _AUTH_EXEMPT
    if settings.rate_limit_enabled and is_api:
        client_ip = request.client.host if request.client else "unknown"
        now = time.time()
        bucket = _rate_limit_buckets[client_ip]
        # Prune expired entries
        _rate_limit_buckets[client_ip] = [
            (t, e) for t, e in bucket if now - t < RATE_WINDOW
        ]
        if len(_rate_limit_buckets[client_ip]) >= settings.rate_limit_per_minute:
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "code": "RATE_LIMITED",
                        "message": (
                            f"Rate limit exceeded: "
                            f"{settings.rate_limit_per_minute} requests per {RATE_WINDOW}s"
                        ),
                    }
                },
            )
        _rate_limit_buckets[client_ip].append((now, request.url.path))
    return await call_next(request)


@app.exception_handler(Exception)
async def global_exception_handler(_request: Request, exc: Exception):
    logger.exception("Unhandled exception")
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "Internal server error",
            }
        },
    )


app.include_router(events_router, prefix="/v1")
app.include_router(workflows_router, prefix="/v1")
app.include_router(runs_router, prefix="/v1")
app.include_router(audit_router, prefix="/v1")
app.include_router(connectors_router, prefix="/v1")
app.include_router(debug_router, prefix="/v1")
app.include_router(ai_router, prefix="/v1")
app.include_router(settings_router, prefix="/v1")
app.include_router(integrations_router, prefix="/v1")
app.include_router(artifacts_router, prefix="/v1")


@app.get("/v1/health")
async def health():
    return {"status": "ok"}
