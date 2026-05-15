"""
Centralized logging service that sends structured logs to Seq.

Supports three layers:
- backend: API routes, services, database, middleware
- extension: content script, service worker, popup, panel
- frontend: pages, components, hooks

Every log entry includes:
- layer: which part of the system
- component: specific module/file
- action: what was done
- status: success/failure
- elapsed_ms: duration (if applicable)
"""

import asyncio
import json
import logging
from datetime import UTC, datetime

import httpx

from core.config import settings

logger = logging.getLogger(__name__)


class LogLevel:
    VERBOSE = "Verbose"
    DEBUG = "Debug"
    INFORMATION = "Information"
    WARNING = "Warning"
    ERROR = "Error"
    FATAL = "Fatal"


class LogService:
    """Sends structured logs to Seq via HTTP ingestion API."""

    _instance: "LogService | None" = None
    _client: httpx.AsyncClient | None = None

    def __init__(self):
        self._seq_url = getattr(settings, "seq_url", "http://localhost:5341")

    @classmethod
    def get(cls) -> "LogService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def _send(self, event: dict):
        """Send a single event to Seq immediately."""
        try:
            if self._client is None:
                self._client = httpx.AsyncClient(timeout=httpx.Timeout(5.0))
            body = json.dumps({"Events": [event]})
            resp = await self._client.post(
                f"{self._seq_url}/api/events/raw",
                content=body,
                headers={"Content-Type": "application/json"},
            )
            if resp.status_code >= 400:
                logger.warning("Seq send failed: %s %s", resp.status_code, resp.text)
        except Exception as e:
            logger.warning("Seq send error: %s", e)

    def _enqueue(
        self,
        level: str,
        message_template: str,
        properties: dict,
        exception: Exception | None = None,
    ):
        """Queue a log event and send it to Seq."""
        now = datetime.now(UTC).isoformat()
        event: dict = {
            "Timestamp": now,
            "Level": level,
            "MessageTemplate": message_template,
            "Properties": dict(properties),
        }
        if exception:
            event["Exception"] = f"{type(exception).__name__}: {exception}"
            event["Properties"]["error_type"] = type(exception).__name__

        # Log to Python logger for local visibility
        log_msg = f"[{properties.get('Layer', '?')}][{properties.get('Component', '?')}] {message_template.format(**properties) if '{' in message_template else message_template}"
        if level == LogLevel.ERROR or level == LogLevel.FATAL:
            logger.error(log_msg)
        elif level == LogLevel.WARNING:
            logger.warning(log_msg)
        else:
            logger.info(log_msg)

        # Fire-and-forget to Seq (don't block the caller)
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(self._send(event))
        except RuntimeError:
            pass

    # ── Per-layer convenience methods ──────────────────────────────

    def log(
        self,
        layer: str,
        component: str,
        action: str,
        level: str = LogLevel.INFORMATION,
        status: str = "success",
        details: dict | None = None,
        elapsed_ms: float | None = None,
        exception: Exception | None = None,
    ):
        """Log an event from any layer."""
        props = {
            "Layer": layer,
            "Component": component,
            "Action": action,
            "Status": status,
        }
        if details:
            # Flatten nested dicts as JSON strings so Seq can index them
            for k, v in details.items():
                if isinstance(v, (dict, list)):
                    props[k] = json.dumps(v, default=str)
                else:
                    props[k] = str(v) if v is not None else "null"
        if elapsed_ms is not None:
            props["ElapsedMs"] = elapsed_ms

        msg = f"{action}"
        if details:
            msg += " " + " ".join(
                f"{k}={v}" for k, v in details.items() if not isinstance(v, (dict, list))
            )

        self._enqueue(level, msg, props, exception)

    # ── Backend helpers ────────────────────────────────────────────

    def backend(
        self,
        component: str,
        action: str,
        level: str = LogLevel.INFORMATION,
        status: str = "success",
        details: dict | None = None,
        elapsed_ms: float | None = None,
        exception: Exception | None = None,
    ):
        self.log("backend", component, action, level, status, details, elapsed_ms, exception)

    def backend_request(
        self,
        component: str,
        method: str,
        path: str,
        status_code: int,
        elapsed_ms: float,
        detail: str = "",
    ):
        status = "success" if 200 <= status_code < 400 else "failure"
        self.log(
            "backend",
            component,
            f"{method} {path}",
            LogLevel.WARNING if status_code >= 400 else LogLevel.INFORMATION,
            status,
            {"status_code": status_code, "elapsed_ms": elapsed_ms},
            elapsed_ms,
        )

    # ── Extension helpers ──────────────────────────────────────────

    def extension(
        self,
        component: str,
        action: str,
        level: str = LogLevel.INFORMATION,
        status: str = "success",
        details: dict | None = None,
    ):
        self.log("extension", component, action, level, status, details)

    # ── Frontend helpers ───────────────────────────────────────────

    def frontend(
        self,
        component: str,
        action: str,
        level: str = LogLevel.INFORMATION,
        status: str = "success",
        details: dict | None = None,
    ):
        self.log("frontend", component, action, level, status, details)


# Singleton accessor
def get_logger() -> LogService:
    return LogService.get()
