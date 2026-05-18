from __future__ import annotations

from adapters.base import BaseAdapter

_registry: dict[str, type[BaseAdapter]] = {}
_defaults_loaded = False


def register(name: str, adapter_cls: type[BaseAdapter]) -> None:
    _registry[name] = adapter_cls


def _ensure_default_adapters_registered() -> None:
    global _defaults_loaded
    if _defaults_loaded:
        return
    from adapters.odoo.adapter import OdooAdapter

    register("odoo", OdooAdapter)
    _defaults_loaded = True


def get_adapter(name: str) -> type[BaseAdapter]:
    _ensure_default_adapters_registered()
    if name not in _registry:
        raise ValueError(f"Adapter '{name}' not registered. Available: {list(_registry.keys())}")
    return _registry[name]


def list_available() -> list[str]:
    return list(_registry.keys())
