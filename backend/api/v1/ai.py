import logging

from fastapi import APIRouter
from pydantic import BaseModel

from ai.client import get_ai_provider
from ai.prompts import build_classify_prompt, build_extract_prompt, build_heal_prompt

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ai"])


class RecoverySuggestRequest(BaseModel):
    dom_snippet: str
    at_snippet: str | None = None
    old_selectors: list[str]
    intent: str


class ClassifyRequest(BaseModel):
    page_text: str
    visible_elements: list[str]


class ExtractRequest(BaseModel):
    page_content: str
    extraction_schema: dict


@router.post("/recovery/suggest")
async def suggest_recovery(req: RecoverySuggestRequest):
    logger.info("AI recovery suggest called")
    provider = get_ai_provider()
    prompt = build_heal_prompt(
        dom_snippet=req.dom_snippet,
        at_snippet=req.at_snippet,
        old_selectors=req.old_selectors,
        intent=req.intent,
    )
    response = await provider.generate(prompt, system="You are a DOM analysis assistant.")
    return {"suggestion": response.content, "confidence": response.confidence}


@router.post("/classify")
async def classify_page(req: ClassifyRequest):
    logger.info("AI classify called")
    provider = get_ai_provider()
    prompt = build_classify_prompt(req.page_text, req.visible_elements)
    response = await provider.generate(
        prompt, system="You are a page state classifier."
    )
    return {"classification": response.content}


@router.post("/extract")
async def extract_data(req: ExtractRequest):
    logger.info("AI extract called")
    provider = get_ai_provider()
    prompt = build_extract_prompt(req.page_content, req.extraction_schema)
    response = await provider.generate(
        prompt, system="You are a data extraction assistant."
    )
    return {"data": response.content}
