from __future__ import annotations

from typing import Any

from services.agent_models import AgentCommand
from services.site_adapters.base import SiteAdapter
from services.site_adapters.linkedin import LinkedInSiteAdapter

_ADAPTERS: tuple[SiteAdapter, ...] = (LinkedInSiteAdapter(),)


def compile_site_command(step: dict[str, Any], ctx: Any) -> AgentCommand | None:
    """Compile a recorded step using the first site adapter that recognizes it."""
    for adapter in _ADAPTERS:
        command = adapter.compile_command(step, ctx)
        if command is not None:
            return command
    return None
