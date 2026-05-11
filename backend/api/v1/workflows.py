from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.exceptions import NotFoundError
from services.workflow_service import WorkflowService

router = APIRouter(prefix="/workflows", tags=["workflows"])


class CreateWorkflowRequest(BaseModel):
    name: str
    description: str | None = None
    prompt: str | None = None
    target_url: str | None = None
    created_by: str | None = None


class AddStepRequest(BaseModel):
    step_index: int
    action_type: str
    intent: str | None = None
    selector_chain: dict | None = None


class UpdateStatusRequest(BaseModel):
    status: str  # validated in handler


def _not_found(msg: str):
    return JSONResponse(
        status_code=404,
        content={"error": {"code": "NOT_FOUND", "message": msg}},
    )


@router.post("")
async def create_workflow(
    req: CreateWorkflowRequest,
    db: AsyncSession = Depends(get_db),
):
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
        "version": workflow.version,
        "created_at": workflow.created_at.isoformat(),
    }


@router.get("")
async def list_workflows(
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    svc = WorkflowService(db)
    workflows = await svc.list(status=status, limit=limit, offset=offset)
    return [
        {
            "id": str(w.id),
            "name": w.name,
            "description": w.description,
            "status": w.status,
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
    svc = WorkflowService(db)
    try:
        workflow = await svc.get(workflow_id)
    except NotFoundError:
        return _not_found("Workflow not found")

    steps = await svc.get_steps(workflow_id)
    return {
        "id": str(workflow.id),
        "name": workflow.name,
        "description": workflow.description,
        "prompt": workflow.prompt,
        "target_url": workflow.target_url,
        "status": workflow.status,
        "version": workflow.version,
        "created_at": workflow.created_at.isoformat(),
        "steps": [
            {
                "step_index": s.step_index,
                "action_type": s.action_type,
                "intent": s.intent,
                "selector_chain": s.selector_chain,
            }
            for s in steps
        ],
    }


@router.post("/{workflow_id}/steps")
async def add_step(
    workflow_id: str,
    req: AddStepRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = WorkflowService(db)
    try:
        await svc.get(workflow_id)
    except NotFoundError:
        return _not_found("Workflow not found")
    step = await svc.add_step(
        workflow_id=workflow_id,
        step_index=req.step_index,
        action_type=req.action_type,
        intent=req.intent,
        selector_chain=req.selector_chain,
    )
    return {
        "id": str(step.id),
        "step_index": step.step_index,
        "action_type": step.action_type,
    }


@router.put("/{workflow_id}/status")
async def update_workflow_status(
    workflow_id: str,
    req: UpdateStatusRequest,
    db: AsyncSession = Depends(get_db),
):
    valid_statuses = {"draft", "active", "archived"}
    if req.status not in valid_statuses:
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": (
                        f"Invalid status '{req.status}'. "
                        f"Must be one of: {', '.join(sorted(valid_statuses))}"
                    ),
                }
            },
        )
    svc = WorkflowService(db)
    try:
        workflow = await svc.update_status(workflow_id, req.status)
    except NotFoundError:
        return _not_found("Workflow not found")

    return {"id": str(workflow.id), "status": workflow.status}


@router.post("/{workflow_id}/run")
async def run_workflow(
    workflow_id: str,
    db: AsyncSession = Depends(get_db),
):
    from core.state_machine import RunStatus
    from services.execution_service import ExecutionService
    svc = ExecutionService(db)
    try:
        run = await svc.create_run(workflow_id=workflow_id)
        run = await svc.transition(str(run.id), RunStatus.RUNNING)
    except NotFoundError:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Workflow not found"}},
        )

    return {
        "id": str(run.id),
        "workflow_id": run.workflow_id,
        "status": run.status,
        "current_step_index": run.current_step_index,
        "total_steps": run.total_steps,
    }
