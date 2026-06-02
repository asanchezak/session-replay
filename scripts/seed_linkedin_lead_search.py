"""Seed the "LinkedIn Lead Search" workflow.

Lightweight sibling of seed_linkedin_people_search.py. This workflow only
searches LinkedIn and extracts name+headline+profile_url from the first two
search-result pages — it has NO for_each and NO per-profile visit steps, so a
run auto-completes right after step 5 (total_steps = 6). The terminal-state
hook then pushes the collected leads to Odoo as linkedin.lead rows.

Idempotent by workflow name — re-running wipes the prior copy and re-creates it.

Run from repo root:
    cd backend && source .venv/bin/activate && python ../scripts/seed_linkedin_lead_search.py
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


WORKFLOW_NAME = "LinkedIn Lead Search"
SEARCH_URL_TEMPLATE = (
    "https://www.linkedin.com/search/results/people/"
    "?keywords={{keyword}}&origin=SWITCH_SEARCH_VERTICAL"
)


def _build_steps() -> list[dict]:
    # Lead extraction: name + headline + profile_url per search-result card.
    # The daemon's lead branch ignores the step `methods` (it has a dedicated
    # scrapeSearchPeople DOM routine), but we declare the output shape here so
    # the workflow's output spec / template are self-describing.
    # `strategy: linkedin_search_people` routes the daemon's extract step to its
    # scrapeSearchPeople DOM routine (Phase B/C). Only consulted on the generic
    # preamble path (DAEMON_GENERIC_PREAMBLE=1); the legacy hardcoded lead branch
    # ignores step methods and calls scrapeSearchPeople directly.
    search_extract_methods = [
        {
            "kind": "extract_shapes",
            "strategy": "linkedin_search_people",
            "shapes": [
                {
                    "key": "people",
                    "label": "People",
                    "kind": "record_list",
                    "item_keys": ["name", "headline", "profile_url"],
                }
            ],
        },
    ]

    # Session pre-warm: land on /feed/ first (where real users start) and
    # idle-scroll before navigating to search — deep-linking cold to
    # /search/results/?keywords=... is a behavioural-analytics tell.
    return [
        {
            "step_index": 0,
            "action_type": "navigate",
            "value": "https://www.linkedin.com/feed/",
            "intent": "Warm up the session by visiting the feed",
            "methods": None,
            "selector_chain": None,
            "success_condition": None,
        },
        {
            "step_index": 1,
            "action_type": "noise_break",
            "value": None,
            "intent": "Read the feed for a moment",
            "methods": [{
                "kind": "noise_config",
                "_noise_kind": "idle_scroll",
                "_noise_seed": 24_681_357,
            }],
            "selector_chain": None,
            "success_condition": None,
        },
        {
            "step_index": 2,
            # linkedin_people_search → the daemon's humanized typeahead + "People"
            # pill click (NOT a cold deep-link to /search/results/, which is a
            # behavioural-analytics tell). `value` is the deep-link fallback.
            "action_type": "linkedin_people_search",
            "value": SEARCH_URL_TEMPLATE,
            "intent": "Open LinkedIn people search (humanized typeahead + People filter)",
            "methods": None,
            "selector_chain": None,
            "success_condition": None,
        },
        {
            "step_index": 3,
            "action_type": "extract",
            "value": "People",
            "intent": "Pull name/headline/profile_url from page 1 of search results",
            "methods": search_extract_methods,
            "selector_chain": None,
            "success_condition": None,
        },
        {
            "step_index": 4,
            "action_type": "navigate",
            "value": SEARCH_URL_TEMPLATE + "&page=2",
            "intent": "Go to search results page 2",
            "methods": None,
            "selector_chain": None,
            "success_condition": None,
        },
        {
            "step_index": 5,
            "action_type": "extract",
            "value": "People",
            "intent": "Pull name/headline/profile_url from page 2 of search results",
            "methods": search_extract_methods,
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
            description="Search LinkedIn for a keyword and collect name/headline/profile_url from the first two search-result pages (lead sourcing — no profile visits).",
            target_url=SEARCH_URL_TEMPLATE,
            status="active",
            version=1,
            workflow_type="user",
            # Bespoke daemon flow (steps-0-5 preamble), not the generic interpreter.
            execution_mode="hardcoded",
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
        print(f"Created {len(steps)} steps (search-only, no for_each)")

        session.add(WorkflowAnalysis(
            workflow_id=workflow_id,
            analysis_version=1,
            workflow_goal="Collect name/headline/profile_url for the people on the first two pages of a LinkedIn People search.",
            workflow_summary="Run a LinkedIn People Search for a keyword and capture each result's name, headline, and profile URL — no profile visits.",
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
        ))
        session.add(WorkflowParameter(
            workflow_id=workflow_id,
            parameter_key="count",
            parameter_type="number",
            default_value="20",
            description="Max number of leads to push to Odoo (the run always scans 2 pages).",
            confidence=0.99,
            is_required=False,
            validation_rules={"min": 1, "max": 50},
        ))
        session.add(SemanticPhase(
            workflow_id=workflow_id,
            phase_index=0,
            phase_name="People Search and Lead Capture",
            phase_goal="Search, paginate to page 2, and capture name/headline/profile_url for every result.",
            start_step_index=0,
            end_step_index=5,
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
                        "people": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "headline": {"type": "string"},
                                    "profile_url": {"type": "string"},
                                },
                            },
                        },
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
        print("  Next: wire the connector trigger:")
        print(
            "  python ../scripts/seed_linkedin_lead_search_bindings.py <connector_id>"
        )


if __name__ == "__main__":
    asyncio.run(main())
