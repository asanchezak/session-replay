from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.exceptions import NotFoundError
from services.workflow_service import WorkflowService


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
    action_type: str
    intent: str | None = None
    selector_chain: dict | None = None
    value: str | None = None
    methods: list[MethodDef] | None = None


class UpdateStatusRequest(BaseModel):
    status: str


class UpdateWorkflowRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    prompt: str | None = None
    target_url: str | None = None


class UpdateStepRequest(BaseModel):
    selector_chain: list[SelectorSet]


def _not_found(msg: str):
    return JSONResponse(
        status_code=404,
        content={"error": {"code": "NOT_FOUND", "message": msg}},
    )


class RecordEventInput(BaseModel):
    event_type: str
    payload: dict = {}
    page_url: str | None = None
    page_title: str | None = None
    timestamp: str | None = None


class RecordWorkflowRequest(BaseModel):
    name: str
    target_url: str | None = None
    events: list[RecordEventInput] = []


@router.post("/record")
async def record_workflow(
    req: RecordWorkflowRequest,
    db: AsyncSession = Depends(get_db),
):
    svc = WorkflowService(db)
    workflow = await svc.create(
        name=req.name,
        target_url=req.target_url,
    )
    for i, ev in enumerate(req.events):
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
        if not value and isinstance(target, dict):
            value = target.get("text")

        methods = payload.get("methods")
        if methods and isinstance(methods, list):
            methods = [
                {
                    "action_type": m["action_type"],
                    "selector_chain": m.get("selector_chain", []),
                    "value": m.get("value"),
                }
                for m in methods if isinstance(m, dict)
            ]

        await svc.add_step(
            workflow_id=str(workflow.id),
            step_index=i,
            action_type=ev.event_type,
            intent=payload.get("intent"),
            selector_chain=selector_chain,
            value=value,
            methods=methods,
        )
    steps = await svc.get_steps(str(workflow.id))
    return {
        "id": str(workflow.id),
        "name": workflow.name,
        "status": workflow.status,
        "version": workflow.version,
        "step_count": len(steps),
        "created_at": workflow.created_at.isoformat(),
    }


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
                "value": s.value,
                "methods": s.methods,
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

    methods_data = [m.model_dump() for m in req.methods] if req.methods else None

    step = await svc.add_step(
        workflow_id=workflow_id,
        step_index=req.step_index,
        action_type=req.action_type,
        intent=req.intent,
        selector_chain=req.selector_chain,
        value=req.value,
        methods=methods_data,
    )
    return {
        "id": str(step.id),
        "step_index": step.step_index,
        "action_type": step.action_type,
        "value": step.value,
        "methods": step.methods,
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
        "version": workflow.version,
    }


@router.post("/{workflow_id}/generate-prompt")
async def generate_workflow_prompt(
    workflow_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    from ai.client import get_ai_provider
    from core.config import settings

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

        provider = get_ai_provider(api_key_override=effective_key)
        ai_prompt = (
            f"Summarize what this browser workflow does in one short sentence.\n\n"
            f"{prompt_text}"
        )
        response = await provider.generate(ai_prompt, max_tokens=100)
        generated = response.content.strip().strip('"')
    else:
        generated = f"{action_summary}{target}"

    workflow = await svc.update_workflow(workflow_id=workflow_id, prompt=generated)
    return {"prompt": workflow.prompt, "generated": bool(effective_key)}


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
