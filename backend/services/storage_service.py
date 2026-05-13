import logging
import os

import fsspec

from core.config import settings

logger = logging.getLogger(__name__)


class StorageService:
    def __init__(self):
        protocol = settings.storage_protocol
        options = dict(settings.storage_options) if settings.storage_options else {}
        self.fs = fsspec.filesystem(protocol, **options)
        self.base_path = str(settings.storage_path).rstrip("/")

    def _full_path(self, path: str) -> str:
        return f"{self.base_path}/{path}"

    async def store(self, file_data: bytes, path: str) -> str:
        full_path = self._full_path(path)
        parent = os.path.dirname(full_path)
        self.fs.makedirs(parent, exist_ok=True)
        with self.fs.open(full_path, "wb") as f:
            f.write(file_data)
        logger.info("Stored artifact at %s (%d bytes)", full_path, len(file_data))
        return full_path

    async def retrieve(self, path: str) -> bytes:
        with self.fs.open(path, "rb") as f:
            return f.read()

    async def delete(self, path: str) -> None:
        if self.fs.exists(path):
            self.fs.rm(path)
            logger.info("Deleted artifact at %s", path)

    async def exists(self, path: str) -> bool:
        return self.fs.exists(path)
