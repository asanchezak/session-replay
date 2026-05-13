import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import NotFoundError
from core.models.artifact import Artifact
from services.storage_service import StorageService

logger = logging.getLogger(__name__)


_MIME_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "text/html": ".html",
    "application/json": ".json",
    "text/plain": ".txt",
    "application/xml": ".xml",
}


class ArtifactService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.storage = StorageService()

    def _get_extension(self, mime_type: str) -> str:
        return _MIME_EXTENSIONS.get(mime_type, ".bin")

    async def store_artifact(
        self,
        run_id: str,
        step_index: int | None,
        artifact_type: str,
        data: bytes,
        mime_type: str,
        metadata: dict | None = None,
    ) -> Artifact:
        artifact_id = uuid.uuid4()
        ext = self._get_extension(mime_type)
        file_path = f"{run_id}/{artifact_id}{ext}"
        stored_path = await self.storage.store(data, file_path)

        artifact = Artifact(
            id=artifact_id,
            run_id=run_id,
            step_index=step_index,
            artifact_type=artifact_type,
            file_path=stored_path,
            mime_type=mime_type,
            file_size=len(data),
            meta_data=metadata or {},
        )
        self.session.add(artifact)
        await self.session.flush()
        logger.info(
            "Stored artifact id=%s run_id=%s type=%s size=%d",
            artifact_id, run_id, artifact_type, len(data),
        )
        return artifact

    async def get_artifact(self, artifact_id: str) -> Artifact:
        try:
            uid = uuid.UUID(artifact_id)
        except ValueError:
            raise NotFoundError(f"Artifact {artifact_id} not found") from None
        result = await self.session.execute(
            select(Artifact).where(Artifact.id == uid)
        )
        artifact = result.scalar_one_or_none()
        if not artifact:
            raise NotFoundError(f"Artifact {artifact_id} not found")
        return artifact

    async def list_artifacts(self, run_id: str) -> list[Artifact]:
        result = await self.session.execute(
            select(Artifact)
            .where(Artifact.run_id == run_id)
            .order_by(Artifact.created_at)
        )
        return list(result.scalars().all())

    async def delete_artifact(self, artifact_id: str) -> None:
        artifact = await self.get_artifact(artifact_id)
        await self.storage.delete(artifact.file_path)
        await self.session.delete(artifact)
        await self.session.flush()
        logger.info("Deleted artifact id=%s", artifact_id)

    async def delete_artifacts_for_run(self, run_id: str) -> int:
        artifacts = await self.list_artifacts(run_id)
        for artifact in artifacts:
            await self.storage.delete(artifact.file_path)
            await self.session.delete(artifact)
        await self.session.flush()
        logger.info("Deleted %d artifacts for run_id=%s", len(artifacts), run_id)
        return len(artifacts)
