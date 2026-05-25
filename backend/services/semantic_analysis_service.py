from __future__ import annotations

import json
import logging
import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ai.client import get_ai_provider
from ai.prompts import (
    SELECTION_INFERENCE_SYSTEM,
    SEMANTIC_ANALYSIS_SYSTEM,
    build_selection_inference_prompt,
    build_semantic_analysis_prompt,
)
from core.config import settings
from core.models.analysis import (
    OutputSpecification,
    SemanticAction,
    SemanticPhase,
    WorkflowAnalysis,
    WorkflowParameter,
    WorkflowTemplate,
)
from core.models.workflow import Workflow, WorkflowStep
from services.audit import AppendEvent, AuditService

logger = logging.getLogger(__name__)

HEURISTIC_ACTION_MAP: dict[str, str] = {
    "navigate": "open_page",
    "click": "interact",
    "type": "enter_data",
    "select": "select_option",
    "scroll": "scroll_content",
    "hover": "hover_element",
    "submit": "submit_form",
    "copy": "copy_data",
    "paste": "paste_data",
}

SEMANTIC_ACTION_TYPES: dict[str, list[str]] = {
    "open_platform": ["open_page", "navigate"],
    "configure_search": ["enter_data", "select_option"],
    "apply_filter": ["select_option", "interact", "click"],
    "navigate_results": ["interact", "scroll_content", "click"],
    "open_detail": ["interact", "click"],
    "extract_data": ["copy_data", "enter_data"],
    "submit_form": ["submit_form"],
    "authenticate": ["enter_data", "click"],
    "paginate": ["interact", "click"],
    "scroll_page": ["scroll_content"],
}

PARAMETER_PATTERNS: dict[str, dict] = {
    "search_query": {"action_types": ["type"], "hints": ["search", "query", "keyword"]},
    "location": {"action_types": ["type", "select"], "hints": ["location", "city", "region", "place"]},
    "technologies": {"action_types": ["type"], "hints": ["technology", "skill", "role", "position", "developer"]},
    "company": {"action_types": ["type", "select"], "hints": ["company", "employer", "organization"]},
    "salary": {"action_types": ["type", "select"], "hints": ["salary", "compensation", "pay"]},
    "recipient": {"action_types": ["type", "click"], "hints": ["recipient", "to:", "message", "send to"]},
    "filter_value": {"action_types": ["type", "select"], "hints": ["filter", "category", "type"]},
    "url_target": {"action_types": ["navigate"], "hints": ["http", "www."]},
}


class SemanticAnalysisService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.audit = AuditService(session)

    async def analyze_workflow(
        self,
        workflow_id: str,
        ai_api_key: str | None = None,
    ) -> WorkflowAnalysis:
        wf = await self._get_workflow(workflow_id)
        steps = await self._get_steps(workflow_id)

        # Determine step indices that changed URL (phase boundaries)
        phase_boundaries, _url_groups = self._detect_phase_boundaries(steps)

        # Heuristic: classify each step
        heuristic_actions = self._classify_steps_heuristic(steps)

        # Heuristic: detect parameter candidates
        parameter_candidates = self._detect_parameter_candidates(steps)

        # AI synthesis (if key available) — else return heuristics-only
        effective_key = ai_api_key or settings.ai_api_key
        logger.info("AI synthesis check: effective_key=%s provider=%s", bool(effective_key), settings.ai_provider)
        if effective_key and settings.ai_provider != "mock":
            logger.info("Running AI synthesis for workflow_id=%s", workflow_id)
            ai_result = await self._run_ai_synthesis(
                wf, steps, heuristic_actions, parameter_candidates, phase_boundaries,
                api_key=effective_key,
            )
        else:
            logger.info("Falling back to heuristics for workflow_id=%s", workflow_id)
            ai_result = self._fallback_synthesis(
                wf, heuristic_actions, parameter_candidates, phase_boundaries, steps,
            )

        # Persist everything
        analysis = await self._persist_analysis(workflow_id, ai_result, steps)

        # Post-analysis: infer extraction fields from selection_intent events
        await self._infer_extract_fields(workflow_id, steps, api_key=effective_key)

        await self.audit.append(AppendEvent(
            event_type="analysis_completed",
            payload={
                "workflow_id": workflow_id,
                "confidence": analysis.confidence_overall,
                "phases": len(ai_result.get("phases", [])),
                "parameters": len(ai_result.get("parameters", [])),
            },
            run_id=workflow_id,
        ))
        return analysis

    def _detect_phase_boundaries(self, steps: list[WorkflowStep]) -> tuple[list[int], dict[int, str]]:
        boundaries: list[int] = []
        url_groups: dict[int, str] = {}
        current_url = ""
        seen_domains: set[str] = set()

        for i, step in enumerate(steps):
            page_url = ""
            if step.selector_chain and isinstance(step.selector_chain, dict):
                page_url = step.selector_chain.get("page_url", "")
            if not page_url and hasattr(step, "dom_context") and step.dom_context:
                page_url = step.dom_context.get("url", "")

            extraction = self._extract_domain(page_url)
            if extraction:
                if extraction not in seen_domains:
                    boundaries.append(i)
                    seen_domains.add(extraction)
                if extraction != current_url:
                    current_url = extraction
            url_groups[i] = current_url or "unknown"

            if step.value and isinstance(step.value, str) and ("http" in step.value):
                extraction = self._extract_domain(step.value)
                if extraction and extraction not in seen_domains:
                    boundaries.append(i)
                    seen_domains.add(extraction)

        if not boundaries and len(steps) > 0:
            boundaries.append(0)

        # Detect repeated click type => extraction loop
        click_runs: list[tuple[int, int]] = []
        run_start = -1
        for i, step in enumerate(steps):
            if step.action_type == "click":
                if run_start == -1:
                    run_start = i
            else:
                if run_start != -1 and i - run_start >= 3:
                    click_runs.append((run_start, i - 1))
                run_start = -1
        if run_start != -1 and len(steps) - run_start >= 3:
            click_runs.append((run_start, len(steps) - 1))

        for cs, _ce in click_runs:
            if cs not in boundaries and cs > 0:
                boundaries.append(cs)

        return sorted(set(boundaries)), url_groups

    def _classify_steps_heuristic(self, steps: list[WorkflowStep]) -> list[dict]:
        actions: list[dict] = []
        for step in steps:
            at = step.action_type
            intent = step.intent or ""
            value = (step.value or "").lower()

            heuristic_type = HEURISTIC_ACTION_MAP.get(at, at)
            semantic_type = "other"
            confidence = 0.5

            action = {
                "step_index": step.step_index,
                "action_type": at,
                "heuristic_type": heuristic_type,
                "semantic_type": semantic_type,
                "description": intent or f"{at} on element",
                "confidence": confidence,
            }

            # Refine: navigation → open_platform
            if at == "navigate" and value:
                url_lower = value.lower()
                if any(t in url_lower for t in ["google", "search"]):
                    action["semantic_type"] = "acquire_target_platform"
                    action["description"] = "Open search engine to find target platform"
                    action["confidence"] = 0.95
                elif any(t in url_lower for t in ["linkedin", "indeed", "glassdoor", "monster"]):
                    action["semantic_type"] = "open_platform"
                    action["description"] = f"Open {self._extract_platform_name(value)}"
                    action["confidence"] = 0.98
                else:
                    action["semantic_type"] = "open_page"
                    action["description"] = f"Navigate to {value[:60]}"
                    action["confidence"] = 0.90

            # Refine: type action → set_search_query, set_location, etc.
            elif at == "type":
                if not value or value.startswith("[REDACTED"):
                    action["semantic_type"] = "enter_data"
                    action["confidence"] = 0.40
                elif self._looks_like_search_query(value):
                    action["semantic_type"] = "set_search_query"
                    action["description"] = f"Enter search query: {value}"
                    action["confidence"] = 0.88
                elif self._looks_like_location(value):
                    action["semantic_type"] = "set_location"
                    action["description"] = f"Set location: {value}"
                    action["confidence"] = 0.85
                elif self._looks_like_filter(value):
                    action["semantic_type"] = "apply_filter"
                    action["description"] = f"Apply filter: {value}"
                    action["confidence"] = 0.75
                else:
                    action["semantic_type"] = "enter_data"
                    action["description"] = f"Type: {value}"
                    action["confidence"] = 0.60

            elif at == "click":
                intent_lower = intent.lower()
                if "search" in intent_lower or "submit" in intent_lower or "find" in intent_lower:
                    action["semantic_type"] = "submit_search"
                    action["confidence"] = 0.90
                elif "next" in intent_lower or "page" in intent_lower or ">" in intent_lower:
                    action["semantic_type"] = "paginate"
                    action["confidence"] = 0.85
                elif "filter" in intent_lower:
                    action["semantic_type"] = "apply_filter"
                    action["confidence"] = 0.80
                elif "link" in intent_lower:
                    action["semantic_type"] = "open_detail"
                    action["confidence"] = 0.75
                else:
                    action["semantic_type"] = "interact"
                    action["confidence"] = 0.50

            elif at == "select":
                action["semantic_type"] = "select_option"
                action["confidence"] = 0.70

            elif at == "scroll":
                action["semantic_type"] = "scroll_page"
                action["confidence"] = 0.80

            elif at == "copy":
                action["semantic_type"] = "extract_data"
                action["confidence"] = 0.75

            actions.append(action)
        return actions

    def _detect_parameter_candidates(self, steps: list[WorkflowStep]) -> list[dict]:
        params: list[dict] = []
        seen_keys: set[str] = set()
        # Maps a typed value to the parameter key that already covers it, so
        # duplicate type steps with the same value don't create extra parameters.
        seen_typed_values: dict[str, str] = {}

        for step in steps:
            value = (step.value or "").strip()
            if not value or len(value) < 1 or value.startswith("[REDACTED"):
                continue

            if len(value) > 200:
                continue

            if step.action_type in ("click", "scroll", "hover"):
                continue

            candidate = None

            for param_key, pattern in PARAMETER_PATTERNS.items():
                if step.action_type in pattern["action_types"]:
                    value_lower = value.lower()
                    field_name = ""
                    if step.selector_chain and isinstance(step.selector_chain, dict):
                        field_name = (step.selector_chain.get("field_name") or "").lower()
                    if not field_name and step.accessibility_metadata:
                        field_name = (str(step.accessibility_metadata.get("aria_label", ""))).lower()

                    hints = pattern["hints"]
                    hint_match = any(h in value_lower or h in field_name for h in hints)

                    if step.action_type == "navigate" and param_key == "url_target" or hint_match and param_key not in seen_keys:
                        candidate = param_key
                        break

            if not candidate and step.action_type in ("type", "select"):
                # If an earlier type step already captured the same value, this
                # step is a duplicate input event (e.g. React re-render, autocomplete
                # confirmation). Skip creating a new parameter for it.
                if value in seen_typed_values:
                    continue
                candidate = f"input_{step.step_index}"

            if candidate and candidate not in seen_keys:
                param_type = "string"
                if value.isdigit():
                    param_type = "number"

                params.append({
                    "key": candidate,
                    "type": param_type,
                    "default": value,
                    "step_index": step.step_index,
                    "inferred_value": value,
                    "description": f"Value entered at step {step.step_index}: {value[:80]}",
                    "confidence": 0.65,
                    "required": True,
                })
                seen_keys.add(candidate)
                if step.action_type in ("type", "select"):
                    seen_typed_values[value] = candidate

        return params

    async def _run_ai_synthesis(
        self,
        wf: Workflow,
        steps: list[WorkflowStep],
        heuristic_actions: list[dict],
        parameter_candidates: list[dict],
        phase_boundaries: list[int],
        api_key: str,
    ) -> dict:
        summary = self._build_step_summary(steps, heuristic_actions)
        params_text = json.dumps(parameter_candidates, indent=2)
        boundaries_text = json.dumps(phase_boundaries)

        prompt = build_semantic_analysis_prompt(
            workflow_name=wf.name or "Untitled",
            steps_summary=summary,
            parameter_candidates=params_text,
            phase_boundaries=boundaries_text,
            target_url=wf.target_url,
            prompt_text=wf.prompt,
        )

        try:
            provider = get_ai_provider(api_key_override=api_key)
            logger.info("AI provider type: %s", type(provider).__name__)
            response = await provider.generate(
                prompt,
                system=SEMANTIC_ANALYSIS_SYSTEM,
                max_tokens=2048,
            )
            logger.info("AI response received, model=%s, content length=%d", response.model, len(response.content))
            result = json.loads(response.content)
            if not isinstance(result, dict):
                raise ValueError("AI response is not a dict")
            if "workflow_goal" not in result and "phases" not in result:
                raise ValueError("AI response missing required fields — falling back to heuristics")
            result["_ai_model"] = response.model or "unknown"
            result["_ai_confidence"] = response.confidence
            result["_raw_response"] = response.content[:500]
            logger.info("AI synthesis successful")
            return result
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning("AI synthesis failed: %s — falling back to heuristics", e)
            return self._fallback_synthesis(
                wf, heuristic_actions, parameter_candidates, phase_boundaries, steps,
            )
        except Exception as e:
            logger.warning("AI synthesis unexpected error: %s — falling back to heuristics", e)
            return self._fallback_synthesis(
                wf, heuristic_actions, parameter_candidates, phase_boundaries, steps,
            )

    def _fallback_synthesis(
        self,
        wf: Workflow,
        heuristic_actions: list[dict],
        parameter_candidates: list[dict],
        phase_boundaries: list[int],
        steps: list[WorkflowStep],
    ) -> dict:
        actions_by_type: dict[str, int] = {}
        for a in heuristic_actions:
            t = a["semantic_type"]
            actions_by_type[t] = actions_by_type.get(t, 0) + 1

        prompt_text = (wf.prompt or "").strip()
        goal = prompt_text or "Automated browser workflow"
        if not prompt_text and actions_by_type.get("set_search_query"):
            goal = "Search and extract structured data"
        elif actions_by_type.get("submit_form"):
            goal = "Fill and submit forms"
        elif actions_by_type.get("extract_data"):
            goal = "Extract structured data from pages"

        summary = f"A workflow with {len(steps)} steps"
        if prompt_text:
            summary = f"Goal-driven workflow recorded to: {prompt_text}"
        domain = "general"
        if actions_by_type.get("set_search_query") or actions_by_type.get("open_platform"):
            domain = "data_extraction"

        phases = self._build_phases(phase_boundaries, steps, heuristic_actions)
        output_spec = self._infer_output_spec(actions_by_type, heuristic_actions)
        ambiguity_notes = self._detect_ambiguity_notes(steps, heuristic_actions, prompt_text)
        replay_strategy = self._infer_replay_strategy(
            prompt_text,
            parameter_candidates,
            actions_by_type,
            ambiguity_notes,
        )

        return {
            "workflow_goal": goal,
            "workflow_summary": summary,
            "domain_context": domain,
            "confidence_overall": 0.6,
            "phases": phases,
            "actions": heuristic_actions,
            "parameters": parameter_candidates,
            "output_spec": output_spec,
            "fixed_steps": [i for i, a in enumerate(heuristic_actions) if a.get("semantic_type") in ("open_platform", "open_page")],
            "variable_steps": [i for i, a in enumerate(heuristic_actions) if a.get("semantic_type") in ("set_search_query", "set_location", "apply_filter")],
            "ambiguity_notes": ambiguity_notes or [{"note": "Heuristic analysis only — no AI synthesis available", "confidence": 0.4}],
            "replay_strategy": replay_strategy,
            "_ai_model": "heuristics-only",
            "_ai_confidence": 0.0,
        }

    async def _persist_analysis(self, workflow_id: str, ai_result: dict, steps: list[WorkflowStep]) -> WorkflowAnalysis:
        # Clear prior analysis
        await self._clear_prior_analysis(workflow_id)

        analysis = WorkflowAnalysis(
            workflow_id=workflow_id,
            analysis_version=1,
            workflow_goal=ai_result.get("workflow_goal"),
            workflow_summary=ai_result.get("workflow_summary"),
            domain_context=ai_result.get("domain_context"),
            confidence_overall=float(ai_result.get("confidence_overall", 0.6)),
            ai_model_used=ai_result.get("_ai_model"),
            ai_inference_metadata={"phases": ai_result.get("phases", []), "actions": ai_result.get("actions", []), "raw": ai_result.get("_raw_response")},
            ambiguity_notes=ai_result.get("ambiguity_notes"),
            is_user_edited=False,
            replay_strategy=ai_result.get("replay_strategy", "literal"),
        )
        self.session.add(analysis)
        await self.session.flush()

        # Phases
        for phase in ai_result.get("phases", []):
            sp = SemanticPhase(
                workflow_id=workflow_id,
                phase_index=phase.get("index", 0),
                phase_name=phase.get("name", "Unnamed Phase"),
                phase_goal=phase.get("goal"),
                start_step_index=phase.get("steps", [0])[0] if phase.get("steps") else 0,
                end_step_index=phase.get("steps", [-1])[-1] if phase.get("steps") else 0,
            )
            self.session.add(sp)

        # Actions
        for action in ai_result.get("actions", []):
            step_id = None
            for s in steps:
                if s.step_index == action.get("step_index"):
                    step_id = str(s.id)
                    break
            sa = SemanticAction(
                workflow_id=workflow_id,
                step_id=step_id,
                step_index=action.get("step_index", 0),
                semantic_action_type=action.get("semantic_type", action.get("type", "other")),
                semantic_description=action.get("description"),
                confidence=float(action.get("confidence", 0.5)),
            )
            self.session.add(sa)

        # Parameters
        for param in ai_result.get("parameters", []):
            wp = WorkflowParameter(
                workflow_id=workflow_id,
                parameter_key=param.get("key", "unknown"),
                parameter_type=param.get("type", "string"),
                default_value=str(param.get("default", "")),
                inferred_from_step=param.get("step_index"),
                inferred_value=str(param.get("inferred_value", param.get("default", ""))),
                description=param.get("description"),
                confidence=float(param.get("confidence", 0.5)),
                is_required=param.get("required", False),
                validation_rules=param.get("validation_rules"),
            )
            self.session.add(wp)

        # Output spec
        output_spec = ai_result.get("output_spec", {})
        if not output_spec:
            output_spec = {}
        ospec = OutputSpecification(
            workflow_id=workflow_id,
            output_type=output_spec.get("type", "unknown"),
            output_schema=output_spec.get("schema"),
            schema_confidence=float(output_spec.get("confidence", 0.0)),
            sample_output=output_spec.get("sample"),
        )
        self.session.add(ospec)

        # Template
        template_data = {
            "workflow_id": workflow_id,
            "parameters": [{"key": p.get("key"), "type": p.get("type"), "default": p.get("default")} for p in ai_result.get("parameters", [])],
            "phases": ai_result.get("phases", []),
            "output_spec": output_spec,
            "replay_strategy": ai_result.get("replay_strategy", "literal"),
        }
        wt = WorkflowTemplate(
            workflow_id=workflow_id,
            template_version=1,
            template_data=template_data,
            is_active=True,
        )
        self.session.add(wt)

        await self.session.flush()
        return analysis

    async def _clear_prior_analysis(self, workflow_id: str) -> None:
        for model in [WorkflowParameter, SemanticAction, SemanticPhase, OutputSpecification, WorkflowTemplate]:
            await self.session.execute(delete(model).where(model.workflow_id == workflow_id))

        existing = await self.session.execute(
            select(WorkflowAnalysis).where(WorkflowAnalysis.workflow_id == workflow_id)
        )
        old = existing.scalar_one_or_none()
        if old:
            await self.session.delete(old)

        await self.session.flush()

    async def get_analysis(self, workflow_id: str) -> WorkflowAnalysis | None:
        result = await self.session.execute(
            select(WorkflowAnalysis).where(WorkflowAnalysis.workflow_id == workflow_id)
        )
        return result.scalar_one_or_none()

    async def get_phases(self, workflow_id: str) -> list[SemanticPhase]:
        result = await self.session.execute(
            select(SemanticPhase).where(SemanticPhase.workflow_id == workflow_id).order_by(SemanticPhase.phase_index)
        )
        return list(result.scalars().all())

    async def get_parameters(self, workflow_id: str) -> list[WorkflowParameter]:
        result = await self.session.execute(
            select(WorkflowParameter).where(WorkflowParameter.workflow_id == workflow_id)
        )
        return list(result.scalars().all())

    async def get_output_spec(self, workflow_id: str) -> OutputSpecification | None:
        result = await self.session.execute(
            select(OutputSpecification).where(OutputSpecification.workflow_id == workflow_id)
        )
        return result.scalar_one_or_none()

    async def get_template(self, workflow_id: str) -> WorkflowTemplate | None:
        result = await self.session.execute(
            select(WorkflowTemplate).where(WorkflowTemplate.workflow_id == workflow_id, WorkflowTemplate.is_active)
        )
        return result.scalar_one_or_none()

    async def update_analysis(self, workflow_id: str, updates: dict) -> WorkflowAnalysis:
        analysis = await self.get_analysis(workflow_id)
        if not analysis:
            raise ValueError(f"No analysis found for workflow {workflow_id}")

        for field in ("workflow_goal", "workflow_summary", "domain_context", "ambiguty_notes", "replay_strategy"):
            if field in updates and updates[field] is not None:
                setattr(analysis, field, updates[field])

        analysis.is_user_edited = True
        analysis.analysis_version += 1
        await self.session.flush()

        await self.audit.append(AppendEvent(
            event_type="analysis_edited",
            payload={"workflow_id": workflow_id, "fields": list(updates.keys())},
            run_id=workflow_id,
        ))
        return analysis

    async def update_parameter(self, workflow_id: str, param_key: str, updates: dict) -> WorkflowParameter:
        result = await self.session.execute(
            select(WorkflowParameter).where(
                WorkflowParameter.workflow_id == workflow_id,
                WorkflowParameter.parameter_key == param_key,
            )
        )
        param = result.scalar_one_or_none()
        if not param:
            raise ValueError(f"Parameter {param_key} not found for workflow {workflow_id}")

        for field in ("default_value", "description", "parameter_type", "is_required", "validation_rules"):
            if field in updates and updates[field] is not None:
                setattr(param, field, updates[field])

        await self.session.flush()
        await self.audit.append(AppendEvent(
            event_type="parameter_edited",
            payload={"workflow_id": workflow_id, "parameter_key": param_key},
            run_id=workflow_id,
        ))
        return param

    @staticmethod
    def _extract_domain(url: str) -> str:
        if not url:
            return ""
        try:
            from urllib.parse import urlparse
            parsed = urlparse(url if "://" in url else f"https://{url}")
            netloc = parsed.netloc.lower()
            netloc = netloc.replace("www.", "")
            if netloc:
                return netloc
            return parsed.path.split("/")[0] if parsed.path else ""
        except Exception:
            return ""

    @staticmethod
    def _extract_platform_name(url: str) -> str:
        domain = SemanticAnalysisService._extract_domain(url)
        if not domain:
            return url
        name = domain.split(".")[0]
        return name.title()

    @staticmethod
    def _looks_like_search_query(value: str) -> bool:
        if not value:
            return False
        return (
            len(value) > 2 and
            len(value) < 100 and
            not value.startswith("http") and
            not value.isdigit() and
            not value.startswith("[REDACTED") and
            " " in value and
            not any(c in value for c in ("@", ":", "//"))
        )

    @staticmethod
    def _detect_ambiguity_notes(
        steps: list[WorkflowStep],
        heuristic_actions: list[dict],
        prompt_text: str | None,
    ) -> list[dict]:
        if prompt_text:
            return []

        notes: list[dict] = []
        scroll_steps = [
            s for s in steps
            if s.action_type == "scroll" and not s.selector_chain and not s.value
        ]
        copy_steps = [s for s in steps if s.action_type in {"copy", "paste"}]
        generic_clicks = [
            a for a in heuristic_actions
            if a.get("semantic_type") == "interact" and (a.get("description") or "").startswith("click")
        ]

        if scroll_steps:
            notes.append({
                "note": "The recording includes exploratory scroll steps. A run goal should clarify whether these are needed or can be skipped.",
                "step_index": scroll_steps[0].step_index,
                "confidence": 0.82,
                "requires_confirmation": True,
            })
        if copy_steps:
            notes.append({
                "note": "The workflow copies data from the page. Confirm whether the real goal is extraction rather than clipboard replay.",
                "step_index": copy_steps[0].step_index,
                "confidence": 0.86,
                "requires_confirmation": True,
            })
        if generic_clicks:
            notes.append({
                "note": "Some clicks are generic interactions without a clear business goal. Add a goal before running to let the agent generalize safely.",
                "step_index": generic_clicks[0].get("step_index", 0),
                "confidence": 0.7,
                "requires_confirmation": True,
            })
        return notes

    @staticmethod
    def _infer_replay_strategy(
        prompt_text: str | None,
        parameter_candidates: list[dict],
        actions_by_type: dict[str, int],
        ambiguity_notes: list[dict],
    ) -> str:
        if prompt_text and (
            actions_by_type.get("scroll_page")
            or actions_by_type.get("extract_data")
            or actions_by_type.get("open_detail")
        ):
            return "semantic"
        if ambiguity_notes and any(note.get("requires_confirmation") for note in ambiguity_notes):
            return "semantic"
        if parameter_candidates:
            return "parameterized"
        return "literal"

    @staticmethod
    def _looks_like_location(value: str) -> bool:
        if not value:
            return False
        locations = {"alajuela", "san jose", "san francisco", "new york", "london", "berlin", "paris", "tokyo", "remote", "heredia", "cartago"}
        return value.lower() in locations or value.lower().startswith("san ") or value.lower().startswith("new ")

    @staticmethod
    def _looks_like_filter(value: str) -> bool:
        if not value:
            return False
        filters = {"full-time", "part-time", "contract", "remote", "onsite", "hybrid", "entry-level", "senior", "mid-level", "internship"}
        return value.lower() in filters

    def _build_step_summary(self, steps: list[WorkflowStep], heuristic_actions: list[dict]) -> str:
        lines: list[str] = []
        for i, step in enumerate(steps):
            action = heuristic_actions[i] if i < len(heuristic_actions) else {}
            lines.append(
                f"Step {step.step_index}: {step.action_type} — "
                f"intent: {step.intent or 'none'} — "
                f"value: {(step.value or '')[:50]} — "
                f"semantic: {action.get('semantic_type', 'unknown')}"
            )
        return "\n".join(lines)

    def _build_phases(self, boundaries: list[int], steps: list[WorkflowStep], actions: list[dict]) -> list[dict]:
        phases: list[dict] = []
        phase_name_map = {
            0: "Navigation Phase",
            1: "Search Configuration Phase",
            2: "Filtering Phase",
            3: "Extraction Phase",
            4: "Submission Phase",
        }

        for pi in range(len(boundaries)):
            start = boundaries[pi]
            end = boundaries[pi + 1] - 1 if pi + 1 < len(boundaries) else len(steps) - 1
            if start > end:
                continue

            action_types_in_phase: dict[str, int] = {}
            for i in range(start, min(end + 1, len(actions))):
                st = actions[i].get("semantic_type", "unknown")
                action_types_in_phase[st] = action_types_in_phase.get(st, 0) + 1

            name = phase_name_map.get(pi, f"Phase {pi + 1}")
            goal = self._infer_phase_goal(action_types_in_phase)

            phases.append({
                "index": pi,
                "name": name,
                "goal": goal,
                "steps": list(range(start, end + 1)),
            })

        return phases

    def _infer_phase_goal(self, action_counts: dict[str, int]) -> str:
        if action_counts.get("set_search_query"):
            return "Configure search parameters"
        if action_counts.get("set_location") or action_counts.get("apply_filter"):
            return "Apply filters and refine results"
        if action_counts.get("extract_data") or action_counts.get("copy_data"):
            return "Extract structured data from results"
        if action_counts.get("open_platform") or action_counts.get("open_page"):
            return "Navigate to target platform"
        if action_counts.get("submit_form"):
            return "Submit form data"
        if action_counts.get("paginate"):
            return "Navigate through paginated results"
        return "Execute workflow steps"

    def _infer_output_spec(self, action_counts: dict[str, int], _actions: list[dict]) -> dict:
        if action_counts.get("extract_data") or action_counts.get("copy_data"):
            return {
                "type": "structured_data",
                "confidence": 0.6,
                "schema": {"type": "array", "items": {"type": "object"}},
            }
        if action_counts.get("submit_form"):
            return {
                "type": "submitted_form",
                "confidence": 0.5,
            }
        return {"type": "unknown", "confidence": 0.0}

    async def _infer_extract_fields(
        self,
        workflow_id: str,
        steps: list[WorkflowStep],
        api_key: str | None = None,
    ) -> None:
        """For extract steps that have dom_context (from selection_intent events),
        use AI to infer the field names from the selected text + page content."""
        extract_steps_with_context = [
            s for s in steps
            if s.action_type == "extract"
            and s.dom_context
            and isinstance(s.dom_context, dict)
            and s.dom_context.get("selected_text")
            and s.dom_context.get("container_text")
        ]
        if not extract_steps_with_context:
            return

        effective_key = api_key or settings.ai_api_key
        if not effective_key or settings.ai_provider == "mock":
            logger.info(
                "Skipping extract field inference for workflow_id=%s: AI not available",
                workflow_id,
            )
            return

        provider = get_ai_provider()
        for step in extract_steps_with_context:
            ctx = step.dom_context
            selected_text = str(ctx.get("selected_text", "") or "")
            container_text = str(ctx.get("container_text", "") or "")
            page_url = str(ctx.get("page_url", "") or "")

            prompt = build_selection_inference_prompt(
                selected_text=selected_text,
                container_text=container_text,
                page_url=page_url,
            )

            try:
                response = await provider.generate(
                    prompt,
                    system=SELECTION_INFERENCE_SYSTEM,
                )
                result = json.loads(response.content)
                fields = result.get("fields", [])
                if fields and isinstance(fields, list):
                    field_str = ", ".join(str(f) for f in fields)
                    step.value = field_str
                    logger.info(
                        "Inferred extract fields for step %d: %s → %s",
                        step.step_index,
                        field_str,
                        result.get("description", ""),
                    )
                else:
                    logger.info(
                        "No fields inferred for extract step %d (selected: %s...)",
                        step.step_index,
                        selected_text[:60],
                    )
            except Exception as exc:
                logger.error(
                    "Failed to infer extract fields for step %d: %s",
                    step.step_index,
                    exc,
                )

    async def _get_workflow(self, workflow_id: str) -> Workflow:
        result = await self.session.execute(select(Workflow).where(Workflow.id == uuid.UUID(workflow_id)))
        wf = result.scalar_one_or_none()
        if not wf:
            raise ValueError(f"Workflow {workflow_id} not found")
        return wf

    async def _get_steps(self, workflow_id: str) -> list[WorkflowStep]:
        result = await self.session.execute(
            select(WorkflowStep)
            .where(WorkflowStep.workflow_id == workflow_id)
            .order_by(WorkflowStep.step_index)
        )
        return list(result.scalars().all())
