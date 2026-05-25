import json
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

    try:
        result = json.loads(response.content)
        confidence = float(result.get("confidence", response.confidence))
        new_selectors = []
        primary = result.get("selector")
        if primary:
            new_selectors.append(primary)
        fallbacks = result.get("fallback_selectors", [])
        for sel in fallbacks:
            if sel not in new_selectors:
                new_selectors.append(sel)
        return {
            "suggestion": result,
            "new_selectors": new_selectors,
            "confidence": confidence,
            "explanation": result.get("explanation", ""),
        }
    except (json.JSONDecodeError, ValueError):
        return {
            "suggestion": response.content,
            "new_selectors": [],
            "confidence": response.confidence,
            "explanation": "AI returned unparseable response",
        }


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
    # The prompt drives the model to return one JSON object whose values are
    # per-field shaped (scalar / string_list / record_list). Parse it but do
    # NOT collapse arrays — the structured nested shape is the whole point.
    raw = (response.content or "").strip()
    if raw.startswith("```"):
        # Strip accidental markdown code fences; the prompt forbids them but
        # some models still wrap output, especially when the page content
        # contains backticks.
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
        raw = raw.strip()

    parsed: dict[str, object] = {}
    try:
        decoded = json.loads(raw)
        if isinstance(decoded, list):
            # Legacy fallback: if the model returned a top-level array, treat
            # it as the value of the first requested field if there is one.
            field_keys = list(
                (req.extraction_schema.get("properties") or {}).keys()
                if isinstance(req.extraction_schema.get("properties"), dict)
                else req.extraction_schema.keys()
            )
            decoded = {field_keys[0]: decoded} if field_keys else {}
        if isinstance(decoded, dict):
            # Strip top-level nulls only; never recurse into records.
            parsed = {k: v for k, v in decoded.items() if v is not None}
    except (json.JSONDecodeError, ValueError):
        logger.warning("AI extract returned non-JSON content: %r", raw[:200])
    return {"data": parsed}
