import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.v1.ai import router as ai_router
from api.v1.audit import router as audit_router
from api.v1.connectors import router as connectors_router
from api.v1.events import router as events_router
from api.v1.integrations import router as integrations_router
from api.v1.runs import router as runs_router
from api.v1.workflows import router as workflows_router
from core.config import settings
from core.database import engine
from core.models import Base


@asynccontextmanager
async def lifespan(_app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


app = FastAPI(
    title="Session Replay API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=r"chrome-extension://.*",
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
async def auth_middleware(request: Request, call_next):
    if request.url.path.startswith("/v1/") and request.url.path != "/v1/health":
        api_key = request.headers.get("X-API-Key", "")
        if not api_key or api_key != settings.api_key:
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


@app.exception_handler(Exception)
async def global_exception_handler(_request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL_ERROR", "message": str(exc)}},
    )


app.include_router(events_router, prefix="/v1")
app.include_router(workflows_router, prefix="/v1")
app.include_router(runs_router, prefix="/v1")
app.include_router(audit_router, prefix="/v1")
app.include_router(connectors_router, prefix="/v1")
app.include_router(ai_router, prefix="/v1")
app.include_router(integrations_router, prefix="/v1")


@app.get("/v1/health")
async def health():
    return {"status": "ok"}
