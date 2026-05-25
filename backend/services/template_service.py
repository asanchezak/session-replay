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
from services.workflow_connector_service import WorkflowConnectorService

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
                    "success_condition": s.success_condition,
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
                    original_value = step.get("value")
                    placeholder = f"{{{{{matching_params[0].parameter_key}}}}}"
                    step["value"] = placeholder
                    success_condition = step.get("success_condition")
                    if (
                        isinstance(success_condition, dict)
                        and isinstance(success_condition.get("value"), str)
                        and isinstance(original_value, str)
                        and success_condition.get("value") == original_value
                    ):
                        success_condition["value"] = placeholder
            else:
                template["fixed_steps"].append(step["step_index"])

        # Steps whose value or success_condition matches a parameter default but
        # weren't given their own parameter (e.g. duplicate type events) should
        # also use the same {{param}} placeholder.
        defaults_to_param = {
            p.default_value: p.parameter_key
            for p in parameters
            if p.default_value and p.parameter_key
        }
        for step in template["steps"]:
            # Substitute step value if it matches a known parameter default.
            step_val = step.get("value")
            if (
                isinstance(step_val, str)
                and step_val in defaults_to_param
                and step["step_index"] not in param_step_indices
            ):
                placeholder = f"{{{{{defaults_to_param[step_val]}}}}}"
                step["value"] = placeholder
                if step["step_index"] not in template["variable_steps"]:
                    template["variable_steps"].append(step["step_index"])
                if step["step_index"] in template["fixed_steps"]:
                    template["fixed_steps"].remove(step["step_index"])
                # Also rewrite matching success_condition in the same pass.
                sc = step.get("success_condition")
                if isinstance(sc, dict) and sc.get("value") == step_val:
                    sc["value"] = placeholder
                continue

            # Promote matching success_condition literals on remaining steps.
            success_condition = step.get("success_condition")
            if not isinstance(success_condition, dict):
                continue
            sc_value = success_condition.get("value")
            if isinstance(sc_value, str) and sc_value in defaults_to_param:
                success_condition["value"] = f"{{{{{defaults_to_param[sc_value]}}}}}"

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
        default_to_param = {
            str(p.get("default")): key
            for key, p in params_config.items()
            if p.get("default") is not None
        }

        def _resolve_param_key(raw_value: str) -> str | None:
            if raw_value.startswith("{{") and raw_value.endswith("}}"):
                return raw_value[2:-2].strip()
            return default_to_param.get(raw_value)

        def _resolve_param_value(param_key: str) -> str | None:
            if param_key in runtime_params:
                return str(runtime_params[param_key])
            if param_key in params_config and params_config[param_key].get("default") is not None:
                return str(params_config[param_key]["default"])
            return None

        for step in steps:
            value = step.get("value")
            if isinstance(value, str):
                param_key = _resolve_param_key(value)
                if param_key:
                    resolved = _resolve_param_value(param_key)
                    if resolved is not None:
                        step["value"] = resolved

            success_condition = step.get("success_condition")
            if isinstance(success_condition, dict):
                sc_value = success_condition.get("value")
                if isinstance(sc_value, str):
                    param_key = _resolve_param_key(sc_value)
                    if param_key:
                        resolved = _resolve_param_value(param_key)
                        if resolved is not None:
                            success_condition["value"] = resolved

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
        connector_svc = WorkflowConnectorService(self.session)
        analysis = await analysis_svc.get_analysis(workflow_id)
        template = await analysis_svc.get_template(workflow_id)
        params, connector_resolution = await connector_svc.resolve_runtime_params(workflow_id, runtime_params or {})
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
                    "resolved_parameters": params,
                    "connector_resolution": connector_resolution,
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
                "resolved_parameters": params,
                "connector_resolution": connector_resolution,
                "steps": compacted_steps,
                "omitted_steps": omitted_steps,
                "original_template_version": template.template_version if template else None,
            }

        return {
            "strategy": strategy,
            "mode": "literal" if strategy == "literal" else "default",
            "resolved_parameters": params,
            "connector_resolution": connector_resolution,
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
