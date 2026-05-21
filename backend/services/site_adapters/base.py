from __future__ import annotations

from typing import Any, Protocol

from services.agent_models import AgentCommand


class SiteAdapter(Protocol):
    """Compiles site-specific recorded steps into semantic replay commands."""

    site: str

    def compile_command(self, step: dict[str, Any], ctx: Any) -> AgentCommand | None:
        """Return a site operation command when this adapter owns the step."""
