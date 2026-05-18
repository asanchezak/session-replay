from __future__ import annotations

import logging
from copy import deepcopy
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.models.analysis import WorkflowTemplate
from core.models.workflow import WorkflowStep
from services.audit import AppendEvent, AuditService
from services.semantic_analysis_service import SemanticAnalysisService

logger = logging.getLogger(__name__)


class TemplateService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.audit = AuditService(session)

    async def generate_template(self, workflow_id: str) -> dict:
        analysis_svc = SemanticAnalysisService(self.session)
        steps = await self._get_steps(workflow_id)
        parameters = await analysis_svc.get_parameters(workflow_id)
        analysis = await analysis_svc.get_analysis(workflow_id)
        output_spec = await analysis_svc.get_output_spec(workflow_id)
        phases = await analysis_svc.get_phases(workflow_id)

        template = {
            "workflow_id": workflow_id,
            "version": (await analysis_svc.get_template(workflow_id)).template_version + 1 if await analysis_svc.get_template(workflow_id) else 1,
            "workflow_goal": analysis.workflow_goal if analysis else None,
            "ambiguity_notes": analysis.ambiguity_notes if analysis else [],
            "parameters": [
                {
                    "key": p.parameter_key,
                    "type": p.parameter_type,
                    "default": p.default_value,
                    "required": p.is_required,
                    "description": p.description,
                    "step_index": p.inferred_from_step,
                }
                for p in parameters
            ],
            "phases": [
                {
                    "index": p.phase_index,
                    "name": p.phase_name,
                    "goal": p.phase_goal,
                    "steps": list(range(p.start_step_index, p.end_step_index + 1)),
                }
                for p in phases
            ],
            "fixed_steps": [],
            "variable_steps": [],
            "steps": [
                {
                    "step_index": s.step_index,
                    "action_type": s.action_type,
                    "selector_chain": s.selector_chain,
                    "intent": s.intent,
                    "value": s.value,
                    "methods": s.methods,
                    "checkpoint": s.checkpoint,
                }
                for s in steps
            ],
            "output_spec": {
                "type": output_spec.output_type if output_spec else "unknown",
                "schema": output_spec.output_schema if output_spec else None,
            },
            "replay_strategy": analysis.replay_strategy if analysis else "literal",
            "healing_hints": {},
        }

        # Mark variable steps: steps that have parameters targeting them
        param_step_indices = {p.inferred_from_step for p in parameters if p.inferred_from_step is not None}
        for step in template["steps"]:
            if step["step_index"] in param_step_indices:
                template["variable_steps"].append(step["step_index"])
                # Replace the literal value with a parameter reference
                matching_params = [p for p in parameters if p.inferred_from_step == step["step_index"]]
                if matching_params and matching_params[0].parameter_key:
                    step["value"] = f"{{{{{matching_params[0].parameter_key}}}}}"
            else:
                template["fixed_steps"].append(step["step_index"])

        # Save template version
        existing = await self.session.execute(
            select(WorkflowTemplate).where(WorkflowTemplate.workflow_id == workflow_id, WorkflowTemplate.is_active)
        )
        old = existing.scalar_one_or_none()
        if old:
            old.is_active = False

        new_template = WorkflowTemplate(
            workflow_id=workflow_id,
            template_version=template["version"],
            template_data=template,
            is_active=True,
        )
        self.session.add(new_template)
        await self.session.flush()

        await self.audit.append(AppendEvent(
            event_type="template_generated",
            payload={"workflow_id": workflow_id, "version": template["version"], "param_count": len(parameters)},
            run_id=workflow_id,
        ))
        return template

    async def substitute_parameters(self, template: dict, runtime_params: dict) -> list[dict]:
        steps = deepcopy(template.get("steps", []))
        params_config = {p["key"]: p for p in template.get("parameters", [])}

        for step in steps:
            value = step.get("value")
            if isinstance(value, str) and value.startswith("{{") and value.endswith("}}"):
                param_key = value[2:-2].strip()
                if param_key in runtime_params:
                    step["value"] = str(runtime_params[param_key])
                elif param_key in params_config and params_config[param_key].get("default"):
                    step["value"] = str(params_config[param_key]["default"])

        # Mark which steps were substituted
        for step in steps:
            step["_substituted"] = step.get("value") != template["steps"][step["step_index"]].get("value") if step["step_index"] < len(template["steps"]) else False

        await self.audit.append(AppendEvent(
            event_type="parameter_substituted",
            payload={"params": {k: str(v)[:50] for k, v in runtime_params.items()}},
            run_id=template.get("workflow_id"),
        ))
        return steps

    async def validate_parameters(self, workflow_id: str, runtime_params: dict) -> dict:
        analysis_svc = SemanticAnalysisService(self.session)
        db_params = await analysis_svc.get_parameters(workflow_id)

        missing: list[str] = []
        invalid_type: list[dict] = []

        for p in db_params:
            if p.is_required and p.parameter_key not in runtime_params:
                if not p.default_value:
                    missing.append(p.parameter_key)
                continue

            value = runtime_params.get(p.parameter_key)
            if value is None:
                continue

            if p.parameter_type == "number" and not str(value).replace(".", "").isdigit():
                invalid_type.append({"key": p.parameter_key, "expected": "number", "got": type(value).__name__})

            if p.validation_rules:
                if "min_length" in p.validation_rules and len(str(value)) < p.validation_rules["min_length"]:
                    invalid_type.append({"key": p.parameter_key, "reason": f"min_length {p.validation_rules['min_length']}"})

                if "pattern" in p.validation_rules:
                    import re
                    if not re.match(p.validation_rules["pattern"], str(value)):
                        invalid_type.append({"key": p.parameter_key, "reason": f"pattern {p.validation_rules['pattern']}"})

        return {
            "valid": len(missing) == 0 and len(invalid_type) == 0,
            "missing": missing,
            "invalid": invalid_type,
        }

    async def build_execution_plan(self, workflow_id: str, runtime_params: dict | None = None) -> dict:
        analysis_svc = SemanticAnalysisService(self.session)
        analysis = await analysis_svc.get_analysis(workflow_id)
        template = await analysis_svc.get_template(workflow_id)
        params = runtime_params or {}
        execution_goal = str(params.pop("__execution_goal__", "") or "").strip()

        if not analysis:
            return {"strategy": "literal", "mode": "exact", "reason": "No analysis available — using literal replay"}

        strategy = analysis.replay_strategy or "literal"
        if not template or "steps" not in (template.template_data or {}):
            generated = await self.generate_template(workflow_id)
            template = await analysis_svc.get_template(workflow_id)
            if not template:
                return {"strategy": "literal", "mode": "exact", "reason": "Template generation failed"}
            template_data = generated
        else:
            template_data = template.template_data

        raw_notes = analysis.ambiguity_notes or []
        ambiguity_notes = raw_notes if isinstance(raw_notes, list) else [raw_notes]
        if (
            strategy == "semantic"
            and ambiguity_notes
            and not execution_goal
            and any(note.get("requires_confirmation") for note in ambiguity_notes if isinstance(note, dict))
        ):
            return {
                "strategy": strategy,
                "mode": "confirmation_required",
                "reason": "Workflow needs an execution goal before it can generalize safely.",
                "ambiguity_notes": ambiguity_notes,
                "questions": [
                    "What is the real outcome you want from this run?",
                ],
            }

        if strategy == "parameterized" and params and template:
            validation = await self.validate_parameters(workflow_id, params)
            if validation["valid"]:
                substituted_steps = await self.substitute_parameters(template_data, params)
                return {
                    "strategy": "parameterized",
                    "mode": "substituted",
                    "parameters": params,
                    "steps": substituted_steps,
                    "original_template_version": template.template_version,
                }
            else:
                return {
                    "strategy": "parameterized",
                    "mode": "validation_failed",
                    "validation": validation,
                }

        if strategy == "semantic" or execution_goal:
            semantic_source_steps = template_data.get("steps", [])
            substituted_steps = semantic_source_steps
            if params:
                substituted_steps = await self.substitute_parameters(template_data, params)
            compacted_steps, omitted_steps = self._compact_semantic_steps(
                substituted_steps,
                execution_goal=execution_goal or analysis.workflow_goal,
            )
            return {
                "strategy": "semantic",
                "mode": "goal_driven",
                "execution_goal": execution_goal or analysis.workflow_goal,
                "parameters": params,
                "steps": compacted_steps,
                "omitted_steps": omitted_steps,
                "original_template_version": template.template_version if template else None,
            }

        return {
            "strategy": strategy,
            "mode": "literal" if strategy == "literal" else "default",
            "reason": "Using exact trace replay",
        }

    def _compact_semantic_steps(
        self,
        steps: list[dict[str, Any]],
        execution_goal: str | None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        goal_text = (execution_goal or "").lower()
        compacted: list[dict[str, Any]] = []
        omitted: list[dict[str, Any]] = []

        for raw_step in steps:
            step = deepcopy(raw_step)
            selector_chain = step.get("selector_chain") or []
            is_bare_scroll = (
                step.get("action_type") == "scroll"
                and not selector_chain
                and not step.get("value")
            )
            if is_bare_scroll and any(token in goal_text for token in ("extract", "description", "job", "search", "submit", "form")):
                omitted.append({
                    "step_index": step.get("step_index"),
                    "action_type": step.get("action_type"),
                    "reason": "Dropped exploratory scroll in goal-driven replay.",
                })
                continue
            compacted.append(step)

        if not compacted:
            compacted = [deepcopy(step) for step in steps]

        for index, step in enumerate(compacted):
            step["step_index"] = index

        return compacted, omitted

    async def _get_steps(self, workflow_id: str) -> list[WorkflowStep]:
        result = await self.session.execute(
            select(WorkflowStep)
            .where(WorkflowStep.workflow_id == workflow_id)
            .order_by(WorkflowStep.step_index)
        )
        return list(result.scalars().all())
