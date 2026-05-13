from __future__ import annotations

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

        timeout = httpx.Timeout(connect=5, read=20, write=5, pool=5)
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{self.url}/jsonrpc",
                json={
                    "jsonrpc": "2.0",
                    "method": "call",
                    "params": {
                        "service": "common",
                        "method": "login",
                        "args": [self.database, self.username, self.password],
                    },
                },
            )
            resp.raise_for_status()
            data = resp.json()
            self._uid = data["result"]
            return self._uid

    async def call(
        self, model: str, method: str, args: list | None = None
    ) -> Any:
        if self._uid is None and method != "login":
            await self.authenticate()
        return await self._request_with_reauth(model, method, args or [])

    async def _request(self, model: str, method: str, args: list) -> Any:
        timeout = httpx.Timeout(connect=5, read=20, write=5, pool=5)
        async with httpx.AsyncClient(timeout=timeout) as client:
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
                },
            }
            resp = await client.post(
                f"{self.url}/jsonrpc",
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            if "error" in data:
                error_msg = data["error"].get("message", str(data["error"]))
                if "AccessError" in error_msg or "Access Denied" in error_msg:
                    raise AccessError(error_msg)
                raise Exception(f"Odoo RPC error: {error_msg}")
            return data["result"]

    async def _request_with_reauth(
        self, model: str, method: str, args: list, retry: bool = True
    ) -> Any:
        try:
            return await self._request(model, method, args)
        except AccessError:
            if not retry:
                raise
            self._uid = None
            await self.authenticate()
            return await self._request(model, method, args)

    async def search_read(
        self,
        model: str,
        domain: list,
        fields: list[str] | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        kwargs: dict[str, Any] = {"limit": limit, "offset": offset}
        if fields:
            kwargs["fields"] = fields
        result = await self.call(model, "search_read", [domain, kwargs])
        if isinstance(result, list):
            return result
        return []
