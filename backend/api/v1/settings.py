from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.models.settings import AppSetting

router = APIRouter(prefix="/settings", tags=["settings"])

DEFAULT_SETTINGS = {
    "ai_confidence_threshold": 0.85,
    "auto_retry_limit": 3,
    "retention_days": 90,
}


class UpdateSettingsRequest(BaseModel):
    ai_confidence_threshold: float | None = None
    auto_retry_limit: int | None = None
    retention_days: int | None = None


@router.get("")
async def get_settings(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(AppSetting))
    rows = result.scalars().all()
    stored = {row.key: row.value for row in rows}
    merged = {**DEFAULT_SETTINGS, **stored}
    return {"settings": merged}


@router.put("")
async def update_settings(
    req: UpdateSettingsRequest,
    db: AsyncSession = Depends(get_db),
):
    updates = req.model_dump(exclude_none=True)
    for key, value in updates.items():
        result = await db.execute(
            select(AppSetting).where(AppSetting.key == key)
        )
        existing = result.scalar_one_or_none()
        if existing:
            existing.value = value if isinstance(value, dict) else value
        else:
            db.add(AppSetting(key=key, value=value))
    await db.commit()
    result = await db.execute(select(AppSetting))
    rows = result.scalars().all()
    stored = {row.key: row.value for row in rows}
    merged = {**DEFAULT_SETTINGS, **stored}
    return {"settings": merged}
