"""Clone a workflow, append an `open_message_drafts` outreach step, and
seed a default LinkedIn message template into the clone's `config`.

Idempotent: re-running with the same `--name` returns the existing clone
id and makes no changes. To force a fresh clone, supply a different
--name.

Run from repo root:
    cd backend && uv run python ../scripts/clone_workflow_with_drafts.py \
        --source 25b3ed5c-9789-4c55-b19a-231ee1b6f164 \
        --name "LinkedIn People Search + Outreach Drafts"
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select  # noqa: E402

from core.database import async_session_factory  # noqa: E402
from core.models.workflow import Workflow, WorkflowStep  # noqa: E402

# Connector binding model — imported lazily inside _clone so the script can
# still report a clear error if the column layout drifts.


# LinkedIn caps connection-request notes at 300 chars. Keep the default
# well under that so candidate name + headline substitutions still fit.
DEFAULT_MESSAGE_TEMPLATE = (
    "Hi {{candidate_name}}, your background ({{candidate_headline}}) looks "
    "like a strong match for our {{job_title}} role at {{company}}. "
    "Open to a quick chat?"
)


def _build_open_message_drafts_step(step_index: int) -> dict:
    return {
        "step_index": step_index,
        "action_type": "open_message_drafts",
        "intent": (
            "Open a new tab per scored candidate with the outreach message "
            "pre-pasted into LinkedIn's compose dialog. Do not click send."
        ),
        "selector_chain": [],
        "value": None,
        "methods": [
            {
                "kind": "open_message_drafts_config",
                "source": "run_targets",
                "pacing_ms": 1500,
            }
        ],
        "accessibility_metadata": None,
        "text_anchors": None,
        "dom_context": None,
        "success_condition": {"type": "step_result", "value": "success"},
        "failure_condition": None,
        "ai_hint": (
            "After this run completes, the recruiter reviews each draft "
            "in the opened tabs and clicks Send manually."
        ),
        "checkpoint": True,
        "selector_stability_score": None,
        "heal_count": 0,
    }


async def _clone(source_id: str, target_name: str) -> None:
    async with async_session_factory() as session:
        # Idempotency — bail if the target name is already taken.
        existing = await session.execute(
            select(Workflow).where(Workflow.name == target_name)
        )
        existing_row = existing.scalar_one_or_none()
        if existing_row is not None:
            print(f"already_exists: {existing_row.id} (name={target_name!r})")
            return

        source = await session.get(Workflow, source_id)
        if source is None:
            print(f"ERROR: source workflow {source_id} not found", file=sys.stderr)
            sys.exit(1)

        steps_q = await session.execute(
            select(WorkflowStep)
            .where(WorkflowStep.workflow_id == source_id)
            .order_by(WorkflowStep.step_index.asc())
        )
        steps = list(steps_q.scalars().all())
        if not steps:
            print(f"ERROR: source workflow {source_id} has no steps", file=sys.stderr)
            sys.exit(1)

        now_iso = datetime.now(UTC).isoformat()
        clone = Workflow(
            name=target_name,
            description=(source.description or "")
            + "\n\nFork of base LinkedIn People Search — adds a final step that"
            " opens an outreach draft per scored candidate (no send).",
            prompt=source.prompt,
            target_url=source.target_url,
            created_by="clone_workflow_with_drafts.py",
            status="active",
            workflow_type="user",
            version=1,
            config={
                "message_template": DEFAULT_MESSAGE_TEMPLATE,
                "message_template_updated_at": now_iso,
            },
        )
        session.add(clone)
        await session.flush()  # populates clone.id

        # Copy every step shallowly with the new workflow_id.
        for s in steps:
            session.add(
                WorkflowStep(
                    workflow_id=str(clone.id),
                    step_index=s.step_index,
                    action_type=s.action_type,
                    intent=s.intent,
                    selector_chain=s.selector_chain,
                    value=s.value,
                    methods=s.methods,
                    accessibility_metadata=s.accessibility_metadata,
                    text_anchors=s.text_anchors,
                    dom_context=s.dom_context,
                    success_condition=s.success_condition,
                    failure_condition=s.failure_condition,
                    ai_hint=s.ai_hint,
                    checkpoint=s.checkpoint,
                    selector_stability_score=s.selector_stability_score,
                    heal_count=0,
                )
            )

        # Append the new outreach step at the next index.
        next_index = max(s.step_index for s in steps) + 1
        outreach = _build_open_message_drafts_step(next_index)
        session.add(WorkflowStep(workflow_id=str(clone.id), **outreach))

        # Copy connector bindings so the clone resolves the same runtime
        # parameters (notably `count` → candidate_count) as the source.
        # Without this, the for_each expansion has no iteration limit and
        # iterates over every extracted profile URL.
        from core.models.analysis import WorkflowConnectorBinding
        bindings_q = await session.execute(
            select(WorkflowConnectorBinding)
            .where(WorkflowConnectorBinding.workflow_id == source_id)
        )
        bindings = list(bindings_q.scalars().all())
        for b in bindings:
            session.add(
                WorkflowConnectorBinding(
                    workflow_id=str(clone.id),
                    parameter_key=b.parameter_key,
                    connector_id=b.connector_id,
                    source_kind=b.source_kind,
                    template=b.template,
                    job_filters=b.job_filters,
                    enabled=b.enabled,
                )
            )

        await session.commit()
        print(f"created: {clone.id}")
        print(f"steps_copied: {len(steps)}")
        print(f"outreach_step_index: {next_index}")
        print(f"connector_bindings_copied: {len(bindings)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="Source workflow id to clone")
    parser.add_argument(
        "--name",
        default="LinkedIn People Search + Outreach Drafts",
        help="Name for the clone (also used as idempotency key)",
    )
    args = parser.parse_args()
    asyncio.run(_clone(args.source, args.name))


if __name__ == "__main__":
    main()
