"""Seed the "LinkedIn People Search" workflow.

Idempotent by workflow name — re-running this script wipes the prior copy and
re-creates it, so it survives DB resets and ongoing schema fiddling.

Run from repo root:
    cd backend && source .venv/bin/activate && python ../scripts/seed_linkedin_people_search.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from core.models.analysis import (
    OutputSpecification,
    SemanticAction,
    SemanticPhase,
    WorkflowAnalysis,
    WorkflowParameter,
    WorkflowTemplate,
)
from core.models.workflow import Workflow, WorkflowStep
from services.template_service import TemplateService


WORKFLOW_NAME = "LinkedIn People Search"
SEARCH_URL_TEMPLATE = (
    "https://www.linkedin.com/search/results/people/"
    "?keywords={{keyword}}&origin=SWITCH_SEARCH_VERTICAL"
)


PROFILE_EXTRACT_SHAPES = [
    {"key": "about", "label": "About", "kind": "scalar", "item_keys": None},
    {"key": "skills", "label": "Skills", "kind": "string_list", "item_keys": None},
    {
        "key": "projects",
        "label": "Projects",
        "kind": "record_list",
        "item_keys": ["name", "description", "dates"],
    },
    {
        "key": "experience",
        "label": "Experience",
        "kind": "record_list",
        "item_keys": ["title", "company", "location", "dates", "description"],
    },
    {
        "key": "education",
        "label": "Education",
        "kind": "record_list",
        "item_keys": ["school", "degree", "field", "dates"],
    },
    {
        "key": "certifications",
        "label": "Certifications",
        "kind": "record_list",
        "item_keys": ["name", "issuer", "issued"],
    },
]




def _build_steps() -> list[dict]:
    profile_extract_methods = [
        {"kind": "extract_shapes", "shapes": PROFILE_EXTRACT_SHAPES},
    ]

    search_extract_methods = [
        {
            "kind": "extract_shapes",
            "shapes": [
                {
                    "key": "profile_urls",
                    "label": "Profile URLs",
                    "kind": "string_list",
                    "item_keys": None,
                }
            ],
        },
        {
            "kind": "extract_dom_anchors",
            "field": "profile_urls",
            "url_pattern": "linkedin_profile",
            "max": 30,
        },
    ]

    inner_steps = [
        {
            "action_type": "navigate",
            "value": "$item",
            "intent": "Open profile",
        },
        {
            "action_type": "extract",
            "value": "About, Skills, Projects, Experience, Education, Certifications",
            "intent": "Extract profile sections",
            "methods": profile_extract_methods,
        },
    ]

    return [
        {
            "step_index": 0,
            "action_type": "navigate",
            "value": SEARCH_URL_TEMPLATE,
            "intent": "Open LinkedIn people search",
            "methods": None,
            "selector_chain": None,
            "success_condition": None,
        },
        {
            "step_index": 1,
            "action_type": "extract",
            "value": "Profile URLs",
            "intent": "Pull profile URLs from page 1 of search results",
            "methods": search_extract_methods,
            "selector_chain": None,
            "success_condition": None,
        },
        {
            "step_index": 2,
            "action_type": "navigate",
            "value": SEARCH_URL_TEMPLATE + "&page=2",
            "intent": "Go to search results page 2",
            "methods": None,
            "selector_chain": None,
            "success_condition": None,
        },
        {
            "step_index": 3,
            "action_type": "extract",
            "value": "Profile URLs",
            "intent": "Pull profile URLs from page 2 of search results",
            "methods": search_extract_methods,
            "selector_chain": None,
            "success_condition": None,
        },
        {
            "step_index": 4,
            "action_type": "for_each",
            "value": None,
            "intent": "Iterate over top-N profile URLs and extract each profile",
            "methods": [
                {
                    "kind": "for_each_config",
                    "sources": [
                        {"step_index": 1, "field": "profile_urls"},
                        {"step_index": 3, "field": "profile_urls"},
                    ],
                    "limit_param": "count",
                    "item_var": "profile_url",
                    "item_sigil": "$item",
                    "inner_failure_policy": "continue",
                    # Anti-bot pacing: pause 20-50 s (jittered) between profile
                    # iterations. Observed: LinkedIn triggers a login_form
                    # blocker around the 5th rapid sequential profile visit
                    # even with in-tab navigation + webdriver masking. The
                    # longer the inter-profile gap, the less the pattern
                    # looks like an automated crawl.
                    "iteration_delay_ms": 20000,
                    "iteration_delay_jitter_ms": 30000,
                    "inner_steps": inner_steps,
                }
            ],
            "selector_chain": None,
            "success_condition": None,
        },
    ]


async def main() -> None:
    db_url = os.environ.get(
        "DATABASE_URL",
        "postgresql+asyncpg://workflow:workflow@localhost:5432/workflow",
    )
    engine = create_async_engine(db_url)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as session:
        # Idempotency: drop any prior copy by name (and cascade-delete its rows).
        existing = (
            await session.execute(select(Workflow).where(Workflow.name == WORKFLOW_NAME))
        ).scalars().all()
        for wf in existing:
            wf_id = str(wf.id)
            for model in (
                WorkflowStep,
                WorkflowParameter,
                WorkflowAnalysis,
                SemanticPhase,
                SemanticAction,
                OutputSpecification,
                WorkflowTemplate,
            ):
                rows = (
                    await session.execute(select(model).where(model.workflow_id == wf_id))
                ).scalars().all()
                for r in rows:
                    await session.delete(r)
            await session.delete(wf)
        await session.flush()

        wf = Workflow(
            name=WORKFLOW_NAME,
            description="Search LinkedIn for a keyword and extract structured profiles for the top-N results, paginating to page 2 if needed.",
            target_url=SEARCH_URL_TEMPLATE,
            status="active",
            version=1,
            workflow_type="user",
        )
        session.add(wf)
        await session.flush()
        workflow_id = str(wf.id)
        print(f"Created workflow {workflow_id}: {WORKFLOW_NAME}")

        steps = _build_steps()
        for sd in steps:
            session.add(WorkflowStep(
                workflow_id=workflow_id,
                step_index=sd["step_index"],
                action_type=sd["action_type"],
                intent=sd.get("intent"),
                selector_chain=sd.get("selector_chain"),
                value=sd.get("value"),
                methods=sd.get("methods"),
                success_condition=sd.get("success_condition"),
                checkpoint=False,
            ))
        await session.flush()
        print(f"Created {len(steps)} steps including the for_each iteration step")

        session.add(WorkflowAnalysis(
            workflow_id=workflow_id,
            analysis_version=1,
            workflow_goal="Extract structured profile data for the top-N results of a LinkedIn People search.",
            workflow_summary="Run a LinkedIn People Search for a keyword; capture each result's about/experience/education/skills/certifications/projects.",
            domain_context="data_extraction",
            confidence_overall=0.95,
            replay_strategy="parameterized",
            is_user_edited=True,
        ))
        session.add(WorkflowParameter(
            workflow_id=workflow_id,
            parameter_key="keyword",
            parameter_type="string",
            default_value="javascript",
            description="Search keyword (e.g., 'javascript', 'python', 'product manager').",
            confidence=0.99,
            is_required=True,
            # inferred_from_step intentionally left null: keyword is an embedded
            # placeholder inside the search URL, not a whole-value substitution.
            # Setting this would cause generate_template to replace the entire
            # step value with "{{keyword}}", losing the URL template.
        ))
        session.add(WorkflowParameter(
            workflow_id=workflow_id,
            parameter_key="count",
            parameter_type="number",
            default_value="5",
            description="Number of profiles to process (1-20). Paginates to page 2 when count > 10.",
            confidence=0.99,
            is_required=True,
            validation_rules={"min": 1, "max": 20},
        ))
        session.add(SemanticPhase(
            workflow_id=workflow_id,
            phase_index=0,
            phase_name="People Search and Profile Extraction",
            phase_goal="Search, paginate, and extract structured data for every relevant profile.",
            start_step_index=0,
            end_step_index=4,
        ))
        session.add(OutputSpecification(
            workflow_id=workflow_id,
            output_type="structured_data",
            output_schema={
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "page_title": {"type": "string"},
                        "url": {"type": "string"},
                        "about": {"type": "string"},
                        "skills": {"type": "array", "items": {"type": "string"}},
                        "experience": {"type": "array"},
                        "education": {"type": "array"},
                        "certifications": {"type": "array"},
                        "projects": {"type": "array"},
                    },
                },
            },
            schema_confidence=0.95,
        ))
        await session.flush()
        print("Created analysis, 2 parameters, phase, and output spec")

        # Generate the active template so run-with-params can substitute params.
        svc = TemplateService(session)
        template = await svc.generate_template(workflow_id)
        await session.commit()
        print(f"Generated template version {template.get('version', '?')}")

        print()
        print("Seed complete.")
        print(f"  Workflow ID: {workflow_id}")
        print(f"  Trigger via dashboard or:")
        print(
            "  curl -X POST 'http://localhost:8081/v1/workflows/"
            f"{workflow_id}/run-with-params' \\"
        )
        print("    -H 'X-API-Key: <KEY>' -H 'Content-Type: application/json' \\")
        print('    -d \'{"runtime_params": {"keyword": "javascript", "count": 5}}\'')


if __name__ == "__main__":
    asyncio.run(main())
