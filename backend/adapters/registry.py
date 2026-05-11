from __future__ import annotations

from adapters.base import BaseAdapter

_registry: dict[str, type[BaseAdapter]] = {}


def register(name: str, adapter_cls: type[BaseAdapter]) -> None:
    _registry[name] = adapter_cls


def get_adapter(name: str) -> type[BaseAdapter]:
    if name not in _registry:
        raise ValueError(f"Adapter '{name}' not registered. Available: {list(_registry.keys())}")
    return _registry[name]


def list_available() -> list[str]:
    return list(_registry.keys())
