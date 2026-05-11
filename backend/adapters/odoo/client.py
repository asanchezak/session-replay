from __future__ import annotations

from typing import Any

import httpx


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
            self._uid = 2  # API key auth
            return self._uid

        async with httpx.AsyncClient(timeout=30) as client:
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

        async with httpx.AsyncClient(timeout=60) as client:
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
                        args or [],
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
                    self._uid = None
                    await self.authenticate()
                    return await self.call(model, method, args)
                raise Exception(f"Odoo RPC error: {error_msg}")
            return data["result"]

    async def search_read(
        self, model: str, domain: list, fields: list[str] | None = None
    ) -> list[dict]:
        args = [domain]
        if fields:
            args.append({"fields": fields})
        result = await self.call(model, "search_read", args)
        if isinstance(result, list):
            return result
        return []
