import json
import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ai.client import get_ai_provider
from ai.prompts import (
    PAGE_FIELD_ANALYSIS_SYSTEM,
    build_page_field_analysis_prompt,
)
from core.config import settings
from core.database import get_db
from core.exceptions import NotFoundError, StateTransitionError
from core.state_machine import RunStatus
from services.execution_service import ExecutionService
from services.idempotency_cache import get_cache, hash_payload
from services.semantic_analysis_service import SemanticAnalysisService
from services.template_service import TemplateService
from services.workflow_connector_service import WorkflowConnectorService
from services.workflow_service import WorkflowService

logger = logging.getLogger(__name__)


class SelectorSet(BaseModel):
    type: str = Field(pattern=r"^(css|text|accessibility|xpath)$")
    value: str = Field(min_length=1)


class MethodDef(BaseModel):
    action_type: str = Field(pattern=r"^(click|type|select|scroll|hover)$")
    selector_chain: list[SelectorSet] = Field(min_length=1)
    value: str | None = None


router = APIRouter(prefix="/workflows", tags=["workflows"])


class CreateWorkflowRequest(BaseModel):
    name: str
    description: str | None = None
    prompt: str | None = None
    target_url: str | None = None
    created_by: str | None = None


class AddStepRequest(BaseModel):
    step_index: int
    action_type: Literal["click", "type", "select", "submit", "scroll", "navigate", "hover", "copy", "paste", "tab_change", "extract"]
    intent: str | None = None
    selector_chain: list[SelectorSet] | None = None
    value: str | None = None
    methods: list[MethodDef] | None = None
    success_condition: dict[str, Any] | None = None


class UpdateStatusRequest(BaseModel):
    status: str


class UpdateWorkflowRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    prompt: str | None = None
    target_url: str | None = None


class UpdateStepRequest(BaseModel):
    selector_chain: list[SelectorSet]


class ReplaceStepRequest(BaseModel):
    action_type: str
    intent: str | None = None
    selector_chain: list[dict[str, Any]] | None = None
    value: str | None = None
    methods: list[dict[str, Any]] | None = None
    success_condition: dict[str, Any] | None = None
    checkpoint: bool = False


class AnalyzePageStepRequest(BaseModel):
    page_url: str
    page_title: str | None = None
    visible_text: str = ""
    dom_snippet: str | None = None
    page_snapshots: list[dict[str, Any]] | None = None


PROFILE_SECTION_SUGGESTIONS: list[tuple[tuple[str, ...], str, str, str]] = [
    (("about",), "about", "About", "Profile summary section"),
    (("experience",), "experience", "Experience", "Professional experience section"),
    (("education",), "education", "Education", "Education history section"),
    (("skills", "top skills"), "skills", "Skills", "Skills section"),
    (
        ("certifications", "licenses & certifications", "licences & certifications"),
        "certifications",
        "Certifications",
        "Licenses and certifications section",
    ),
    (("projects",), "projects", "Projects", "Projects section"),
    (("languages",), "languages", "Languages", "Languages section"),
]


def _infer_visible_profile_sections(visible_text: str) -> list[dict[str, str]]:
    haystack = f" {visible_text.lower()} "
    suggestions: list[dict[str, str]] = []
    for needles, key, label, description in PROFILE_SECTION_SUGGESTIONS:
        if any(f" {needle.lower()} " in haystack for needle in needles):
            suggestions.append({
                "key": key,
                "label": label,
                "description": description,
            })
    return suggestions


def _merge_page_snapshot_content(
    visible_text: str,
    dom_snippet: str | None,
    page_snapshots: list[dict[str, Any]] | None,
) -> tuple[str, str | None]:
    if not page_snapshots:
        return visible_text, dom_snippet
    visible_parts: list[str] = []
    dom_parts: list[str] = []
    for entry in page_snapshots:
        if not isinstance(entry, dict):
            continue
        section_name = str(entry.get("section_name") or "page").strip() or "page"
        entry_text = str(entry.get("visible_text") or "").strip()
        entry_dom = str(entry.get("dom_snippet") or "").strip()
        if entry_text:
            visible_parts.append(f"## Section: {section_name}\n{entry_text[:12_000]}")
        if entry_dom:
            dom_parts.append(f"## Section: {section_name}\n{entry_dom[:12_000]}")
    merged_visible = "\n\n".join(visible_parts) if visible_parts else visible_text
    merged_dom = "\n\n".join(dom_parts) if dom_parts else dom_snippet
    return merged_visible, merged_dom


def _not_found(msg: str):
    return JSONResponse(
        status_code=404,
        content={"error": {"code": "NOT_FOUND", "message": msg}},
    )


def _error(code: str, message: str, status: int, details: dict[str, Any] | None = None) -> JSONResponse:
    payload: dict[str, Any] = {"error": {"code": code, "message": message}}
    if details is not None:
        payload["error"]["details"] = details
    return JSONResponse(status_code=status, content=payload)


class RecordEventInput(BaseModel):
    event_type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    page_url: str | None = None
    page_title: str | None = None
    timestamp: str | None = None


class RecordWorkflowRequest(BaseModel):
    name: str
    target_url: str | None = None
    prompt: str | None = None
    events: list[RecordEventInput] = Field(default_factory=list)


@router.post("/record")
async def record_workflow(
    req: RecordWorkflowRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    # Unit tests call this directly without FastAPI resolving Header(...);
    # in that case the default is a Header sentinel rather than None.
    if not isinstance(idempotency_key, str):
        idempotency_key = None
    cache = get_cache()
    payload_hash = hash_payload(req.model_dump()) if idempotency_key else ""
    if idempotency_key:
        lock = await cache.lock_for("workflow_record", idempotency_key)
        await lock.acquire()
    try:
        if idempotency_key:
            status, cached = cache.get("workflow_record", idempotency_key, payload_hash)
            if status == "hit":
                return cached
            if status == "conflict":
                return _error(
                    "CONFLICT",
                    "Idempotency-Key already used for a different payload",
                    status=409,
                )
        response = await _do_record_workflow(req, db)
        if idempotency_key and not isinstance(response, JSONResponse):
            cache.put("workflow_record", idempotency_key, payload_hash, response)
        return response
    finally:
        if idempotency_key:
            lock.release()


async def _do_record_workflow(
    req: RecordWorkflowRequest,
    db: AsyncSession,
):
    logger.info("Recording workflow name=%s", req.name)
    svc = WorkflowService(db)
    workflow = await svc.create(
        name=req.name,
        target_url=req.target_url,
        prompt=req.prompt,
    )

    # Collapse consecutive type events on the same element with the same value.
    # These are recording artifacts (e.g. React re-renders firing a second input
    # event for the same keystroke sequence). Keep only the first occurrence.
    def _primary_selector(sc) -> str | None:
        if isinstance(sc, list) and sc:
            return sc[0].get("value") if isinstance(sc[0], dict) else None
        return None

    deduped_events: list[RecordEventInput] = []
    for ev in req.events:
        if deduped_events and ev.event_type == "type":
            prev = deduped_events[-1]
            if (
                prev.event_type == "type"
                and prev.payload.get("value") == ev.payload.get("value")
                and _primary_selector(ev.payload.get("selector_chain")) is not None
                and _primary_selector(ev.payload.get("selector_chain"))
                == _primary_selector(prev.payload.get("selector_chain"))
            ):
                continue  # exact duplicate on the same element — drop it
        deduped_events.append(ev)

    step_objs = []
    last_typed_value: str | None = None
    for i, ev in enumerate(deduped_events):
        payload = ev.payload

        # Extract selector_chain from capture payload
        target = payload.get("target", {})
        raw_selector = None
        if isinstance(target, dict):
            raw_selector = target.get("selector")
        selector_chain = payload.get("selector_chain")
        if not selector_chain and raw_selector:
            selector_chain = [{"type": "css", "value": raw_selector}]

        value = payload.get("value")
        # Backward compatibility: older E2E helpers and recorded payloads may
        # store navigation destination under `url` instead of `value`.
        if not value and ev.event_type == "navigate":
            value = payload.get("url") or payload.get("target_url")
        if not value and ev.event_type == "scroll":
            scroll_y = payload.get("scroll_y")
            if scroll_y is not None:
                value = str(int(scroll_y))
        if not value and isinstance(target, dict):
            value = target.get("text")

        methods = payload.get("methods")
        if methods and isinstance(methods, list):
            normalized_methods: list[dict[str, Any]] = []
            for m in methods:
                if not isinstance(m, dict):
                    continue
                if "action_type" in m:
                    normalized_methods.append({
                        "action_type": m["action_type"],
                        "selector_chain": m.get("selector_chain", []),
                        "value": m.get("value"),
                    })
                else:
                    # Preserve non-action-method entries verbatim (e.g.
                    # extract-step shape metadata: {kind:"extract_shapes",
                    # shapes:[...]}). These are read by the extension at
                    # run-time and the dashboard's edit-fields modal.
                    normalized_methods.append(m)
            methods = normalized_methods

        success_condition = payload.get("success_condition")
        if not isinstance(success_condition, dict):
            success_condition = None

        if (
            ev.event_type == "type"
            and isinstance(value, str)
            and value
            and not value.startswith("[REDACTED")
        ):
            success_condition = {"type": "input_value_contains", "value": value}
            last_typed_value = value
        elif (
            ev.event_type == "click"
            and isinstance(last_typed_value, str)
            and last_typed_value
        ):
            intent_l = str(payload.get("intent") or "").lower()
            if "send" in intent_l:
                success_condition = {
                    "type": "visible_text_contains",
                    "value": last_typed_value,
                }

        step = await svc.add_step(
            workflow_id=str(workflow.id),
            step_index=i,
            action_type=ev.event_type,
            intent=payload.get("intent"),
            selector_chain=selector_chain,
            value=value,
            methods=methods,
            success_condition=success_condition,
            dom_context=payload.get("dom_context"),
        )
        step_objs.append(step)

    # Causal enrichment: annotate each step with timing and navigation causality
    # derived from the raw event stream.  Stored in accessibility_metadata (no
    # migration needed) so the AI can surface skip hints and timing guidance.
    from datetime import datetime
    for i, ev in enumerate(deduped_events):
        prev = deduped_events[i - 1] if i > 0 else None
        nxt = deduped_events[i + 1] if i < len(deduped_events) - 1 else None

        time_gap: int | None = None
        if prev and prev.timestamp and ev.timestamp:
            try:
                t0 = datetime.fromisoformat(prev.timestamp.replace("Z", "+00:00"))
                t1 = datetime.fromisoformat(ev.timestamp.replace("Z", "+00:00"))
                time_gap = max(0, int((t1 - t0).total_seconds() * 1000))
            except Exception:
                pass

        # Causal check: gap from THIS event to the NEXT (not from prev → this)
        gap_to_next: int | None = None
        if nxt and nxt.timestamp and ev.timestamp:
            try:
                tc = datetime.fromisoformat(ev.timestamp.replace("Z", "+00:00"))
                tn = datetime.fromisoformat(nxt.timestamp.replace("Z", "+00:00"))
                gap_to_next = max(0, int((tn - tc).total_seconds() * 1000))
            except Exception:
                pass

        caused_nav = bool(
            ev.event_type == "click"
            and nxt is not None
            and nxt.event_type == "navigate"
            and (gap_to_next is None or gap_to_next < 1500)
        )

        step_objs[i].accessibility_metadata = {
            "time_since_previous_ms": time_gap,
            "context_url_before": ev.page_url,
            "caused_url_change": caused_nav,
        }

    await db.flush()
    steps = await svc.get_steps(str(workflow.id))

    analysis = None
    # Auto-analyze workflow after recording
    try:
        analysis_svc = SemanticAnalysisService(db)
        analysis = await analysis_svc.analyze_workflow(str(workflow.id))
        logger.info("Auto-analysis complete for workflow=%s confidence=%.2f", workflow.id, analysis.confidence_overall)
    except Exception as exc:
        logger.warning("Auto-analysis failed for workflow=%s: %s", workflow.id, exc)

    # Generate a meaningful workflow name using AI
    if steps:
        try:
            step_lines = "; ".join(
                f"{s.action_type} {s.intent or s.value or ''}".strip()
                for s in steps[:10]
            )
            target_label = req.target_url or "a website"
            ai_name_prompt = (
                f"A browser automation workflow recorded on {target_label} "
                f"with {len(steps)} steps: {step_lines}.\n\n"
                "Generate a concise, descriptive workflow name (4-6 words, title case, no quotes, no punctuation)."
            )
            provider = get_ai_provider()
            name_response = await provider.generate(ai_name_prompt, max_tokens=30)
            ai_name = name_response.content.strip().strip('"').strip("'").rstrip(".")
            if ai_name and len(ai_name) < 100:
                svc2 = WorkflowService(db)
                await svc2.update_workflow(workflow_id=str(workflow.id), name=ai_name)
                workflow.name = ai_name
                logger.info("AI-generated name for workflow=%s: %s", workflow.id, ai_name)
        except Exception as exc:
            logger.warning("AI name generation failed for workflow=%s: %s", workflow.id, exc)

    logger.info("Recording workflow=%s: keeping all %d steps (simplification disabled)", workflow.id, len(steps))

    return {
        "id": str(workflow.id),
        "name": workflow.name,
        "status": workflow.status,
        "workflow_type": workflow.workflow_type,
        "version": workflow.version,
        "step_count": len(steps),
        "simplified_from": None,
        "simplification_status": "skipped",
        "simplification_error": None,
        "created_at": workflow.created_at.isoformat(),
        "analysis": {
            "goal": analysis.workflow_goal if analysis else None,
            "confidence": analysis.confidence_overall if analysis else 0.0,
        },
    }


@router.post("")
async def create_workflow(
    req: CreateWorkflowRequest,
    db: AsyncSession = Depends(get_db),
):
    logger.info("Creating workflow name=%s", req.name)
    svc = WorkflowService(db)
    workflow = await svc.create(
        name=req.name,
        description=req.description,
        prompt=req.prompt,
        target_url=req.target_url,
        created_by=req.created_by,
    )
    return {
        "id": str(workflow.id),
        "name": workflow.name,
        "status": workflow.status,
        "workflow_type": workflow.workflow_type,
        "version": workflow.version,
        "created_at": workflow.created_at.isoformat(),
    }


@router.get("")
async def list_workflows(
    status: str | None = None,
    type: str | None = Query(default=None, alias="type"),
    limit: int = Query(default=50, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    logger.info("Listing workflows status=%s type=%s", status, type)
    svc = WorkflowService(db)
    workflows = await svc.list(status=status, workflow_type=type, limit=limit, offset=offset)
    return [
        {
            "id": str(w.id),
            "name": w.name,
            "description": w.description,
            "status": w.status,
            "workflow_type": w.workflow_type,
            "version": w.version,
            "target_url": w.target_url,
            "created_at": w.created_at.isoformat(),
        }
        for w in workflows
    ]


@router.get("/{workflow_id}")
async def get_workflow(
    workflow_id: str,
    db: AsyncSession = Depends(get_db),
):
    logger.info("Getting workflow workflow_id=%s", workflow_id)
    svc = WorkflowService(db)
    try:
        workflow = await svc.get(workflow_id)
    except NotFoundError:
        return _not_found("Workflow not found")

    steps = await svc.get_steps(workflow_id)

    # Include semantic analysis data if available
    analysis_data = None
    connector_bindings: list[dict[str, Any]] = []
    try:
        analysis_svc = SemanticAnalysisService(db)
        connector_svc = WorkflowConnectorService(db)
        analysis = await analysis_svc.get_analysis(workflow_id)
        connector_bindings = [
            {
                "parameter_key": binding.parameter_key,
                "connector_id": binding.connector_id,
                "source_kind": binding.source_kind,
                "template": binding.template,
                "job_filters": binding.job_filters or {},
                "enabled": binding.enabled,
            }
            for binding in await connector_svc.list_bindings(workflow_id)
        ]
        if analysis:
            phases = await analysis_svc.get_phases(workflow_id)
            params = await analysis_svc.get_parameters(workflow_id)
            output_spec = await analysis_svc.get_output_spec(workflow_id)
            template = await analysis_svc.get_template(workflow_id)
            analysis_data = {
                "workflow_goal": analysis.workflow_goal,
                "workflow_summary": analysis.workflow_summary,
                "domain_context": analysis.domain_context,
                "confidence_overall": analysis.confidence_overall,
                "replay_strategy": analysis.replay_strategy,
                "is_user_edited": analysis.is_user_edited,
                "ambiguity_notes": analysis.ambiguity_notes,
                "phases": [
                    {
                        "phase_index": p.phase_index,
                        "phase_name": p.phase_name,
                        "phase_goal": p.phase_goal,
                        "start_step_index": p.start_step_index,
                        "end_step_index": p.end_step_index,
                    }
                    for p in phases
                ],
                "parameters": [
                    {
                        "key": p.parameter_key,
                        "type": p.parameter_type,
                        "default": p.default_value,
                        "description": p.description,
                        "confidence": p.confidence,
                        "required": p.is_required,
                    }
                    for p in params
                ],
                "output_spec": {
                    "type": output_spec.output_type if output_spec else "unknown",
                    "schema": output_spec.output_schema if output_spec else None,
                    "confidence": output_spec.schema_confidence if output_spec else 0.0,
                },
                "template_version": template.template_version if template else 0,
            }
    except Exception as _exc:
        logger.warning("Failed to load analysis data for workflow=%s: %s", workflow_id, _exc, exc_info=True)

    return {
        "id": str(workflow.id),
        "name": workflow.name,
        "description": workflow.description,
        "prompt": workflow.prompt,
        "target_url": workflow.target_url,
        "status": workflow.status,
        "workflow_type": workflow.workflow_type,
        "version": workflow.version,
        "created_at": workflow.created_at.isoformat(),
        "steps": [
            {
                "step_index": s.step_index,
                "action_type": s.action_type,
                "intent": s.intent,
                "selector_chain": s.selector_chain,
                "value": s.value,
                "methods": s.methods,
                "success_condition": s.success_condition,
                "dom_context": s.dom_context,
            }
            for s in steps
        ],
        "analysis": analysis_data,
        "connector_bindings": connector_bindings,
    }


async def _compute_field_suggestions(
    req: AnalyzePageStepRequest,
    ai_api_key: str | None,
) -> list[dict[str, object]] | JSONResponse:
    """Shared field-suggestion engine used by both the live-recording
    endpoint and the legacy per-step analyze-page route. Returns either
    a list of suggested-field dicts or a JSONResponse describing an
    error condition the caller should propagate as-is.
    """
    from ai.extraction_shapes import get_field_shape, shape_to_dict

    merged_visible_text, merged_dom_snippet = _merge_page_snapshot_content(
        req.visible_text,
        req.dom_snippet,
        req.page_snapshots,
    )

    if not merged_visible_text.strip() and not (merged_dom_snippet or "").strip():
        return _error("EMPTY_PAGE_CONTEXT", "Page analysis requires captured page content", status=400)

    effective_key = ai_api_key or settings.ai_api_key
    if not effective_key or settings.ai_provider == "mock":
        return _error("AI_UNAVAILABLE", "AI page analysis is not configured", status=503)

    provider = get_ai_provider(effective_key)
    prompt = build_page_field_analysis_prompt(
        page_url=req.page_url,
        page_title=req.page_title,
        visible_text=merged_visible_text,
        dom_snippet=merged_dom_snippet,
    )

    try:
        response = await provider.generate(prompt, system=PAGE_FIELD_ANALYSIS_SYSTEM)
        result = json.loads(response.content)
    except Exception as exc:
        logger.warning("Page field analysis failed for url=%s: %s", req.page_url, exc)
        return _error("ANALYSIS_FAILED", "AI page analysis failed", status=502)

    raw_fields = result.get("suggested_fields", [])
    inferred_fields = _infer_visible_profile_sections(merged_visible_text)
    suggested_fields: list[dict[str, object]] = []
    seen_keys: set[str] = set()
    for raw in [*inferred_fields, *raw_fields]:
        if not isinstance(raw, dict):
            continue
        key = str(raw.get("key") or "").strip().lower()
        label = str(raw.get("label") or "").strip()
        description = str(raw.get("description") or "").strip()
        if not key or not label or key in seen_keys:
            continue
        seen_keys.add(key)
        shape = shape_to_dict(get_field_shape(key))
        suggested_fields.append({
            "key": key,
            "label": label,
            "description": description,
            "shape": shape,
        })
    return suggested_fields


@router.post("/analyze-page-suggestions")
async def analyze_page_suggestions(
    req: AnalyzePageStepRequest,
    ai_api_key: str | None = Header(None, alias="X-AI-API-Key"),
):
    """Context-free field suggestions for the side-panel recording flow.

    Takes a page snapshot (URL, title, visible_text, dom_snippet) and
    returns ``suggested_fields`` with per-field ``shape`` hints. No
    workflow context required — used during recording before any step
    exists, and from the dashboard's "Edit fields" modal with a saved
    snapshot.
    """
    result = await _compute_field_suggestions(req, ai_api_key)
    if isinstance(result, JSONResponse):
        return result
    return {
        "page_url": req.page_url,
        "page_title": req.page_title,
        "suggested_fields": result,
    }


@router.post("/{workflow_id}/steps/{step_index}/analyze-page")
async def analyze_page_step(
    workflow_id: str,
    step_index: int,
    req: AnalyzePageStepRequest,
    db: AsyncSession = Depends(get_db),
    ai_api_key: str | None = Header(None, alias="X-AI-API-Key"),
):
    svc = WorkflowService(db)
    try:
        await svc.get(workflow_id)
    except NotFoundError:
        return _not_found("Workflow not found")

    steps = await svc.get_steps(workflow_id)
    step = next((candidate for candidate in steps if candidate.step_index == step_index), None)
    if step is None:
        return _error("NOT_FOUND", "Workflow step not found", status=404)
    if step.action_type != "navigate":
        return _error("INVALID_STEP", "Only navigate steps can be analyzed", status=400)

    result = await _compute_field_suggestions(req, ai_api_key)
    if isinstance(result, JSONResponse):
        return result
    return {
        "workflow_id": workflow_id,
        "step_index": step_index,
        "page_url": req.page_url,
        "page_title": req.page_title,
        "suggested_fields": result,
    }


@router.put("/{workflow_id}/steps")
async def replace_steps(
    workflow_id: str,
    steps: list[ReplaceStepRequest],
    db: AsyncSession = Depends(get_db),
):
    svc = WorkflowService(db)
    try:
        await svc.get(workflow_id)
    except NotFoundError:
        return _not_found("Workflow not found")

    new_steps = await svc.replace_steps(
        workflow_id,
        [step.model_dump() for step in steps],
    )
    return {
        "step_count": len(new_steps),
        "steps": [
            {
                "id": str(s.id),
                "step_index": s.step_index,
                "action_type": s.action_type,
                "intent": s.intent,
                "value": s.value,
                "checkpoint": s.checkpoint,
                "success_condition": s.success_condition,
            }
            for s in new_steps
        ],
    }


@router.post("/{workflow_id}/steps")
async def add_step(
    workflow_id: str,
    req: AddStepRequest,
    db: AsyncSession = Depends(get_db),
):
    logger.info("Adding step to workflow workflow_id=%s step_index=%d", workflow_id, req.step_index)
    svc = WorkflowService(db)
    try:
        await svc.get(workflow_id)
    except NotFoundError:
        return _not_found("Workflow not found")

    methods_data = [m.model_dump() for m in req.methods] if req.methods else None
    selector_chain_data = [s.model_dump() for s in req.selector_chain] if req.selector_chain else None

    step = await svc.add_step(
        workflow_id=workflow_id,
        step_index=req.step_index,
        action_type=req.action_type,
        intent=req.intent,
        selector_chain=selector_chain_data,
        value=req.value,
        methods=methods_data,
        success_condition=req.success_condition,
    )
    return {
        "id": str(step.id),
        "step_index": step.step_index,
        "action_type": step.action_type,
        "value": step.value,
        "methods": step.methods,
        "success_condition": step.success_condition,
    }


@router.put("/{workflow_id}/status")
async def update_workflow_status(
    workflow_id: str,
    req: UpdateStatusRequest,
    db: AsyncSession = Depends(get_db),
):
    valid_statuses = {"active", "archived"}
    # Backward compat: "draft" was the old initial status; treat as no-op activation.
    if req.status == "draft":
        req.status = "active"
    if req.status not in valid_statuses:
        return _error(
            "VALIDATION_ERROR",
            f"Invalid status '{req.status}'. Must be one of: {', '.join(sorted(valid_statuses))}",
            status=422,
        )
    svc = WorkflowService(db)
    try:
        workflow = await svc.get(workflow_id)
    except NotFoundError:
        return _not_found("Workflow not found")
    # No-op if already in target status
    if workflow.status == req.status:
        return {"id": str(workflow.id), "status": workflow.status, "workflow_type": workflow.workflow_type}
    try:
        workflow = await svc.update_status(workflow_id, req.status)
    except StateTransitionError as e:
        return _error("INVALID_TRANSITION", str(e), status=409)

    return {"id": str(workflow.id), "status": workflow.status, "workflow_type": workflow.workflow_type}


@router.post("/{workflow_id}/promote")
async def promote_workflow(
    workflow_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Promote a user workflow to a system workflow."""
    svc = WorkflowService(db)
    try:
        workflow = await svc.promote(workflow_id)
    except NotFoundError:
        return _not_found("Workflow not found")
    except StateTransitionError as e:
        return _error("INVALID_TRANSITION", str(e), status=409)
    await db.commit()
    return {"id": str(workflow.id), "status": workflow.status, "workflow_type": workflow.workflow_type}


@router.put("/{workflow_id}")
async def update_workflow(
    workflow_id: str,
    req: UpdateWorkflowRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = WorkflowService(db)
    try:
        workflow = await svc.update_workflow(
            workflow_id=workflow_id,
            name=req.name,
            description=req.description,
            prompt=req.prompt,
            target_url=req.target_url,
        )
    except NotFoundError:
        return _not_found("Workflow not found")

    return {
        "id": str(workflow.id),
        "name": workflow.name,
        "description": workflow.description,
        "prompt": workflow.prompt,
        "status": workflow.status,
        "workflow_type": workflow.workflow_type,
        "version": workflow.version,
    }


@router.delete("")
async def delete_all_workflows(
    type: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    logger.info("Deleting workflows type=%s", type)
    svc = WorkflowService(db)
    deleted = await svc.delete_all(workflow_type=type)
    logger.info("delete_all_workflows complete: %s", deleted)
    return {"deleted": deleted}


@router.delete("/{workflow_id}")
async def delete_workflow(
    workflow_id: str,
    db: AsyncSession = Depends(get_db),
):
    logger.info("Deleting workflow workflow_id=%s", workflow_id)
    svc = WorkflowService(db)
    try:
        await svc.delete(workflow_id)
    except NotFoundError:
        return _not_found("Workflow not found")
    return {"deleted": {"workflow_id": workflow_id}}


@router.post("/{workflow_id}/generate-prompt")
async def generate_workflow_prompt(
    workflow_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    logger.info("Generating prompt for workflow_id=%s", workflow_id)
    svc = WorkflowService(db)
    try:
        workflow = await svc.get(workflow_id)
    except NotFoundError:
        return _not_found("Workflow not found")

    steps = await svc.get_steps(workflow_id)
    action_summary = _summarize_actions(steps)
    target = f" on {workflow.target_url}" if workflow.target_url else ""

    ai_api_key = request.headers.get("X-AI-API-Key")
    effective_key = ai_api_key or settings.ai_api_key

    if effective_key:
        steps_desc = "\n".join(
            "  {}. {} — {} — selector: {}".format(
                s.step_index, s.action_type,
                s.intent or "no intent",
                s.selector_chain[0]["value"] if s.selector_chain else "none",
            )
            for s in steps
        )
        prompt_text = f"A workflow with {len(steps)} steps:\n{steps_desc}"

        try:
            provider = get_ai_provider(api_key_override=effective_key)
            ai_prompt = (
                f"Summarize what this browser workflow does in one short sentence.\n\n"
                f"{prompt_text}"
            )
            response = await provider.generate(ai_prompt, max_tokens=100)
            generated = response.content.strip().strip('"')
            used_ai = True
        except Exception:
            generated = f"{action_summary}{target}"
            used_ai = False
    else:
        generated = f"{action_summary}{target}"
        used_ai = False

    workflow = await svc.update_workflow(workflow_id=workflow_id, prompt=generated)
    return {"prompt": workflow.prompt, "generated": used_ai}


def _summarize_actions(steps) -> str:
    actions = {}
    for s in steps:
        at = s.action_type
        actions[at] = actions.get(at, 0) + 1
    parts = [f"{v} {k}" + ("s" if v > 1 else "") for k, v in actions.items()]
    return "A workflow that performs " + ", ".join(parts)


@router.put("/{workflow_id}/steps/{step_index}")
async def update_step_selectors(
    workflow_id: str,
    step_index: int,
    req: UpdateStepRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = WorkflowService(db)
    try:
        step = await svc.update_step(
            workflow_id=workflow_id,
            step_index=step_index,
            selector_chain=[s.model_dump() for s in req.selector_chain],
        )
    except NotFoundError:
        return _not_found("Workflow not found")

    return {
        "workflow_id": workflow_id,
        "step_index": step.step_index,
        "selector_chain": step.selector_chain,
    }


@router.post("/{workflow_id}/run")
async def run_workflow(
    workflow_id: str,
    db: AsyncSession = Depends(get_db),
):
    logger.info("Running workflow workflow_id=%s", workflow_id)
    wf_svc = WorkflowService(db)
    try:
        workflow = await wf_svc.get(workflow_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Workflow not found", status=404)

    steps = await wf_svc.get_steps(workflow_id)
    if len(steps) < 1:
        return _error("EMPTY_WORKFLOW", "Workflow has no steps", status=400)

    if workflow.status != "active":
        return _error(
            "INVALID_STATUS",
            f"Workflow status is '{workflow.status}', must be 'active'",
            status=409,
        )

    svc = ExecutionService(db)
    try:
        run = await svc.create_run(workflow_id=workflow_id)
        run = await svc.transition(str(run.id), RunStatus.RUNNING)
    except NotFoundError:
        return _error("NOT_FOUND", "Workflow not found", status=404)

    return {
        "id": str(run.id),
        "workflow_id": run.workflow_id,
        "status": run.status,
        "current_step_index": run.current_step_index,
        "total_steps": run.total_steps,
    }


class RunWithParamsRequest(BaseModel):
    runtime_params: dict[str, Any] = Field(default_factory=dict, description="key-value pairs for parameter substitution")
    execution_goal: str | None = Field(default=None, description="Optional per-run goal override")


@router.post("/{workflow_id}/run-with-params")
async def run_workflow_with_parameters(
    workflow_id: str,
    req: RunWithParamsRequest,
    db: AsyncSession = Depends(get_db),
):
    logger.info(
        "Running workflow with params workflow_id=%s params=%s goal=%s",
        workflow_id,
        req.runtime_params,
        bool(req.execution_goal),
    )
    wf_svc = WorkflowService(db)
    try:
        workflow = await wf_svc.get(workflow_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Workflow not found", status=404)

    steps = await wf_svc.get_steps(workflow_id)
    if len(steps) < 1:
        return _error("EMPTY_WORKFLOW", "Workflow has no steps", status=400)

    if workflow.status != "active":
        return _error(
            "INVALID_STATUS",
            f"Workflow status is '{workflow.status}', must be 'active'",
            status=409,
        )

    template_svc = TemplateService(db)
    plan_params = dict(req.runtime_params)
    if req.execution_goal:
        plan_params["__execution_goal__"] = req.execution_goal
    execution_plan = await template_svc.build_execution_plan(workflow_id, plan_params)
    if execution_plan.get("mode") == "confirmation_required":
        return _error(
            "GOAL_REQUIRED",
            str(execution_plan.get("reason", "Execution goal required")),
            status=409,
            details={
                "ambiguity_notes": execution_plan.get("ambiguity_notes", []),
                "questions": execution_plan.get("questions", []),
            },
        )

    svc = ExecutionService(db)
    try:
        run = await svc.create_run(
            workflow_id=workflow_id,
            execution_plan=execution_plan,
            execution_goal=req.execution_goal,
        )
        run = await svc.transition(str(run.id), RunStatus.RUNNING)
    except NotFoundError:
        return _error("NOT_FOUND", "Workflow not found", status=404)

    return {
        "id": str(run.id),
        "workflow_id": run.workflow_id,
        "status": run.status,
        "current_step_index": run.current_step_index,
        "total_steps": run.total_steps,
        "execution_plan": execution_plan,
    }


@router.get("/{workflow_id}/analyze")
async def analyze_workflow_blueprint(
    workflow_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Return a blueprint health report for the workflow.

    Analyzes each step's selector stability, detects redundant steps, and
    provides an overall completion-probability estimate based on historical runs.
    No AI call required — uses the learning data already stored in the DB.
    """
    wf_svc = WorkflowService(db)
    try:
        workflow = await wf_svc.get(workflow_id)
    except NotFoundError:
        return _error("NOT_FOUND", "Workflow not found", status=404)

    steps = await wf_svc.get_steps(workflow_id)

    # Build per-step risk analysis using selector_stability_score (Phase 5 EMA).
    step_risks = []
    stability_scores = []
    previous_navigate_url: str | None = None

    for s in steps:
        score = s.selector_stability_score  # None = no history yet
        stability_scores.append(score)

        # Determine risk level.
        if score is None:
            risk = "unknown"
            risk_note = "No execution history — risk is unknown for this step"
        elif score >= 0.8:
            risk = "low"
            risk_note = f"Reliable selector ({int(score * 100)}% stable across prior runs)"
        elif score >= 0.5:
            risk = "medium"
            risk_note = f"Selector occasionally needs healing ({int(score * 100)}% stable)"
        else:
            risk = "high"
            risk_note = f"Fragile selector — fails frequently ({int(score * 100)}% stable); ADAPT will be needed"

        # Detect redundant consecutive navigate steps.
        is_redundant = False
        if s.action_type == "navigate":
            current_url = (s.value or "").split("#")[0]  # normalize hash
            if previous_navigate_url and current_url == previous_navigate_url:
                is_redundant = True
                risk_note = "REDUNDANT — navigates to same URL as the previous navigate step; consider removing"
            previous_navigate_url = current_url
        else:
            previous_navigate_url = None  # reset on non-navigate steps

        step_risks.append({
            "step_index": s.step_index,
            "action_type": s.action_type,
            "intent": s.intent,
            "risk": risk,
            "stability_score": score,
            "redundant": is_redundant,
            "note": risk_note,
        })

    # Overall health score: average stability of known steps (ignore unknowns).
    known_scores = [sc for sc in stability_scores if sc is not None]
    health_score = round(sum(known_scores) / len(known_scores), 3) if known_scores else None

    # Completion probability estimate: high_risk steps each subtract 15%.
    high_risk_count = sum(1 for sr in step_risks if sr["risk"] == "high")
    redundant_count = sum(1 for sr in step_risks if sr["redundant"])
    est_completion = max(0.0, 1.0 - (high_risk_count * 0.15) - (redundant_count * 0.05))

    return {
        "workflow_id": workflow_id,
        "workflow_name": workflow.name,
        "total_steps": len(steps),
        "health_score": health_score,
        "estimated_completion_probability": round(est_completion, 2),
        "high_risk_steps": high_risk_count,
        "redundant_steps": redundant_count,
        "recommendations": [
            sr for sr in step_risks if sr["risk"] in ("high", "medium") or sr["redundant"]
        ],
        "step_analysis": step_risks,
    }
