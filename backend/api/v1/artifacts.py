import logging

from fastapi import APIRouter, Depends, UploadFile
from fastapi.responses import JSONResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.exceptions import NotFoundError
from services.artifact_service import ArtifactService

logger = logging.getLogger(__name__)

router = APIRouter(tags=["artifacts"])


def _error(code: str, message: str, status: int = 404):
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}},
    )


@router.post("/runs/{run_id}/artifacts")
async def upload_artifact(
    run_id: str,
    step_index: int = -1,
    artifact_type: str = "screenshot",
    file: UploadFile | None = None,
    db: AsyncSession = Depends(get_db),
):
    if not file:
        return _error("BAD_REQUEST", "No file provided", status=400)

    data = await file.read()
    svc = ArtifactService(db)
    metadata = {"original_filename": file.filename or "unknown"}
    step = step_index if step_index >= 0 else None
    artifact = await svc.store_artifact(
        run_id=run_id,
        step_index=step,
        artifact_type=artifact_type,
        data=data,
        mime_type=file.content_type or "application/octet-stream",
        metadata=metadata,
    )

    return {
        "id": str(artifact.id),
        "run_id": artifact.run_id,
        "step_index": artifact.step_index,
        "artifact_type": artifact.artifact_type,
        "mime_type": artifact.mime_type,
        "file_size": artifact.file_size,
        "created_at": artifact.created_at.isoformat(),
    }


@router.get("/runs/{run_id}/artifacts")
async def list_artifacts(
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = ArtifactService(db)
    artifacts = await svc.list_artifacts(run_id)
    return [
        {
            "id": str(a.id),
            "run_id": a.run_id,
            "step_index": a.step_index,
            "artifact_type": a.artifact_type,
            "mime_type": a.mime_type,
            "file_size": a.file_size,
            "created_at": a.created_at.isoformat(),
        }
        for a in artifacts
    ]


@router.get("/artifacts/{artifact_id}")
async def download_artifact(
    artifact_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = ArtifactService(db)
    try:
        artifact = await svc.get_artifact(artifact_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Artifact not found")

    try:
        data = await svc.storage.retrieve(artifact.file_path)
    except FileNotFoundError:
        return _error("NOT_FOUND", "Artifact file not found on storage")

    return Response(
        content=data,
        media_type=artifact.mime_type,
        headers={
            "Content-Disposition": f'attachment; filename="{artifact.id}.bin"',
            "Content-Length": str(len(data)),
        },
    )


@router.get("/artifacts/{artifact_id}/metadata")
async def get_artifact_metadata(
    artifact_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = ArtifactService(db)
    try:
        artifact = await svc.get_artifact(artifact_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Artifact not found")

    return {
        "id": str(artifact.id),
        "run_id": artifact.run_id,
        "step_index": artifact.step_index,
        "artifact_type": artifact.artifact_type,
        "mime_type": artifact.mime_type,
        "file_size": artifact.file_size,
        "metadata": artifact.meta_data or {},
        "created_at": artifact.created_at.isoformat(),
    }


@router.delete("/artifacts/{artifact_id}")
async def delete_artifact(
    artifact_id: str,
    db: AsyncSession = Depends(get_db),
):
    svc = ArtifactService(db)
    try:
        await svc.delete_artifact(artifact_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Artifact not found")

    return {"deleted": True}
