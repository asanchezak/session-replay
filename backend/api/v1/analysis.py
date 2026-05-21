import logging

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.database import get_db
from services.workflow_connector_service import WorkflowConnectorService
from services.semantic_analysis_service import SemanticAnalysisService

logger = logging.getLogger(__name__)

router = APIRouter(tags=["analysis"])


class UpdateAnalysisRequest(BaseModel):
    workflow_goal: str | None = None
    workflow_summary: str | None = None
    domain_context: str | None = None
    replay_strategy: str | None = Field(default=None, pattern=r"^(literal|parameterized|semantic)$")


class UpdateParameterRequest(BaseModel):
    default_value: str | None = None
    description: str | None = None
    parameter_type: str | None = Field(default=None, pattern=r"^(string|number|boolean|list)$")
    is_required: bool | None = None
    validation_rules: dict | None = None


class ConnectorBindingRequest(BaseModel):
    connector_id: str
    source_kind: str = Field(default="odoo_latest_job", pattern=r"^odoo_latest_job$")
    template: str
    job_filters: dict = Field(default_factory=dict)
    enabled: bool = True


def _serialize_binding(binding) -> dict:
    return {
        "parameter_key": binding.parameter_key,
        "connector_id": binding.connector_id,
        "source_kind": binding.source_kind,
        "template": binding.template,
        "job_filters": binding.job_filters or {},
        "enabled": binding.enabled,
    }


def _not_found(msg: str):
    return JSONResponse(status_code=404, content={"error": {"code": "NOT_FOUND", "message": msg}})


@router.post("/workflows/{workflow_id}/analyze")
async def analyze_workflow(
    workflow_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    logger.info("Analyzing workflow workflow_id=%s", workflow_id)
    svc = SemanticAnalysisService(db)
    try:
        ai_api_key = request.headers.get("X-AI-API-Key")
        analysis = await svc.analyze_workflow(workflow_id, ai_api_key=ai_api_key)
    except ValueError as e:
        return _not_found(str(e))

    phases = await svc.get_phases(workflow_id)
    parameters = await svc.get_parameters(workflow_id)
    output_spec = await svc.get_output_spec(workflow_id)
    template = await svc.get_template(workflow_id)

    return {
        "workflow_id": workflow_id,
        "analysis_version": analysis.analysis_version,
        "workflow_goal": analysis.workflow_goal,
        "workflow_summary": analysis.workflow_summary,
        "domain_context": analysis.domain_context,
        "confidence_overall": analysis.confidence_overall,
        "ai_model_used": analysis.ai_model_used,
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
                "inferred_from_step": p.inferred_from_step,
                "description": p.description,
                "confidence": p.confidence,
                "required": p.is_required,
                "validation_rules": p.validation_rules,
            }
            for p in parameters
        ],
        "output_spec": {
            "type": output_spec.output_type if output_spec else "unknown",
            "schema": output_spec.output_schema if output_spec else None,
            "confidence": output_spec.schema_confidence if output_spec else 0.0,
            "sample": output_spec.sample_output if output_spec else None,
        },
        "template": {
            "version": template.template_version if template else 0,
            "data": template.template_data if template else {},
        } if template else None,
    }


@router.get("/workflows/{workflow_id}/analysis")
async def get_analysis(workflow_id: str, db: AsyncSession = Depends(get_db)):
    svc = SemanticAnalysisService(db)
    connector_svc = WorkflowConnectorService(db)
    analysis = await svc.get_analysis(workflow_id)
    if not analysis:
        return _not_found("Analysis not found for this workflow. Run POST /analyze first.")

    phases = await svc.get_phases(workflow_id)
    parameters = await svc.get_parameters(workflow_id)
    output_spec = await svc.get_output_spec(workflow_id)
    bindings = await connector_svc.list_bindings(workflow_id)

    return {
        "workflow_id": workflow_id,
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
            for p in parameters
        ],
        "output_spec": {
            "type": output_spec.output_type if output_spec else "unknown",
            "schema": output_spec.output_schema if output_spec else None,
            "confidence": output_spec.schema_confidence if output_spec else 0.0,
        },
        "connector_bindings": [_serialize_binding(binding) for binding in bindings],
    }


@router.put("/workflows/{workflow_id}/analysis")
async def update_analysis(workflow_id: str, req: UpdateAnalysisRequest, db: AsyncSession = Depends(get_db)):
    svc = SemanticAnalysisService(db)
    try:
        analysis = await svc.update_analysis(workflow_id, req.model_dump(exclude_none=True))
    except ValueError as e:
        return _not_found(str(e))
    return {"workflow_id": workflow_id, "is_user_edited": analysis.is_user_edited}


@router.put("/workflows/{workflow_id}/parameters/{param_key}")
async def update_parameter(workflow_id: str, param_key: str, req: UpdateParameterRequest, db: AsyncSession = Depends(get_db)):
    svc = SemanticAnalysisService(db)
    try:
        await svc.update_parameter(workflow_id, param_key, req.model_dump(exclude_none=True))
    except ValueError as e:
        return _not_found(str(e))
    return {"workflow_id": workflow_id, "parameter_key": param_key, "updated": True}


@router.get("/workflows/{workflow_id}/template")
async def get_template(workflow_id: str, db: AsyncSession = Depends(get_db)):
    svc = SemanticAnalysisService(db)
    template = await svc.get_template(workflow_id)
    if not template:
        return _not_found("No template found. Run analysis first.")
    return {
        "workflow_id": workflow_id,
        "version": template.template_version,
        "is_active": template.is_active,
        "template_data": template.template_data,
    }


@router.get("/workflows/{workflow_id}/connector-bindings")
async def list_connector_bindings(workflow_id: str, db: AsyncSession = Depends(get_db)):
    svc = WorkflowConnectorService(db)
    bindings = await svc.list_bindings(workflow_id)
    return {"workflow_id": workflow_id, "bindings": [_serialize_binding(binding) for binding in bindings]}


@router.put("/workflows/{workflow_id}/connector-bindings/{parameter_key}")
async def upsert_connector_binding(
    workflow_id: str,
    parameter_key: str,
    req: ConnectorBindingRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = WorkflowConnectorService(db)
    try:
        binding = await svc.save_binding(
            workflow_id,
            parameter_key,
            connector_id=req.connector_id,
            source_kind=req.source_kind,
            template=req.template,
            job_filters=req.job_filters,
            enabled=req.enabled,
        )
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"code": "INVALID_REQUEST", "message": str(e)}})
    return {"workflow_id": workflow_id, "binding": _serialize_binding(binding)}


@router.delete("/workflows/{workflow_id}/connector-bindings/{parameter_key}", status_code=204)
async def delete_connector_binding(
    workflow_id: str,
    parameter_key: str,
    db: AsyncSession = Depends(get_db),
):
    svc = WorkflowConnectorService(db)
    await svc.delete_binding(workflow_id, parameter_key)


@router.post("/workflows/{workflow_id}/connector-bindings/{parameter_key}/preview")
async def preview_connector_binding(
    workflow_id: str,
    parameter_key: str,
    req: ConnectorBindingRequest | None = None,
    db: AsyncSession = Depends(get_db),
):
    svc = WorkflowConnectorService(db)
    try:
        preview = await svc.preview_binding(
            workflow_id,
            parameter_key,
            connector_id=req.connector_id if req else None,
            source_kind=req.source_kind if req else None,
            template=req.template if req else None,
            job_filters=req.job_filters if req else None,
            enabled=req.enabled if req else None,
        )
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": {"code": "INVALID_REQUEST", "message": str(e)}})
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": {"code": "CONNECTOR_PREVIEW_FAILED", "message": str(e)}})
    return {"workflow_id": workflow_id, "preview": preview}


@router.get("/ai/status")
async def ai_status():
    key = settings.ai_api_key
    return {
        "provider": settings.ai_provider,
        "key_configured": bool(key),
        "key_preview": f"...{key[-4:]}" if key else "not configured",
        "model": settings.ai_model,
        "confidence_threshold": settings.ai_confidence_threshold,
    }
