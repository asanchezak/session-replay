from __future__ import annotations

import asyncio
from typing import Any

import httpx


class OdooClientError(Exception):
    pass


class AccessError(OdooClientError):
    pass


class OdooClient:
    def __init__(
        self,
        url: str,
        database: str,
        username: str,
        password: str | None = None,
        api_key: str | None = None,
    ):
        self.url = url.rstrip("/")
        self.database = database
        self.username = username
        self.password = password
        self.api_key = api_key
        self._uid: int | None = None

    async def authenticate(self) -> int:
        if self.api_key:
            self._uid = 2
            return self._uid

        data = await self._post_json(
            {
                "jsonrpc": "2.0",
                "method": "call",
                "params": {
                    "service": "common",
                    "method": "login",
                    "args": [self.database, self.username, self.password],
                },
            }
        )
        self._uid = data["result"]
        return self._uid

    async def call(
        self,
        model: str,
        method: str,
        args: list | None = None,
        kwargs: dict[str, Any] | None = None,
    ) -> Any:
        if self._uid is None and method != "login":
            await self.authenticate()
        return await self._request_with_reauth(model, method, args or [], kwargs or {})

    async def _request(
        self,
        model: str,
        method: str,
        args: list,
        kwargs: dict[str, Any],
    ) -> Any:
        payload = {
            "jsonrpc": "2.0",
            "method": "call",
            "params": {
                "service": "object",
                "method": "execute_kw",
                "args": [
                    self.database,
                    self._uid or 2,
                    self.api_key or self.password or "",
                    model,
                    method,
                    args,
                ],
                "kwargs": kwargs,
            },
        }
        data = await self._post_json(payload)
        if "error" in data:
            error = data["error"]
            error_data = error.get("data") or {}
            error_msg = (
                error_data.get("message")
                or error.get("message")
                or str(error)
            )
            if "AccessError" in error_msg or "Access Denied" in error_msg:
                raise AccessError(error_msg)
            raise Exception(f"Odoo RPC error: {error_msg}")
        return data["result"]

    async def _post_json(self, payload: dict[str, Any]) -> dict[str, Any]:
        timeout = httpx.Timeout(connect=5, read=20, write=5, pool=5)

        def _send() -> dict[str, Any]:
            with httpx.Client(timeout=timeout) as client:
                resp = client.post(f"{self.url}/jsonrpc", json=payload)
                resp.raise_for_status()
                return resp.json()

        return await asyncio.to_thread(_send)

    async def _request_with_reauth(
        self,
        model: str,
        method: str,
        args: list,
        kwargs: dict[str, Any],
        retry: bool = True,
    ) -> Any:
        try:
            return await self._request(model, method, args, kwargs)
        except AccessError:
            if not retry:
                raise
            self._uid = None
            await self.authenticate()
            return await self._request(model, method, args, kwargs)

    async def search_read(
        self,
        model: str,
        domain: list,
        fields: list[str] | None = None,
        limit: int = 100,
        offset: int = 0,
        order: str | None = None,
    ) -> list[dict]:
        kwargs: dict[str, Any] = {"limit": limit, "offset": offset}
        if fields:
            kwargs["fields"] = fields
        if order:
            kwargs["order"] = order
        result = await self.call(model, "search_read", [domain], kwargs)
        if isinstance(result, list):
            return result
        return []
