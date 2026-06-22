from __future__ import annotations

import asyncio
import logging
import re
import uuid
from copy import deepcopy
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from core.database import async_session_factory
from core.exceptions import NotFoundError, StateTransitionError
from core.models.run import ExecutionRun
from core.state_machine import RunStatus, WorkflowStateMachine
from core.utils import to_uuid
from services.audit import AppendEvent, AuditService
from services.log_service import get_logger
from services.workflow_service import WorkflowService

logger = logging.getLogger(__name__)
log = get_logger()

_PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")

# Runs orchestrated by the backend (Odoo pipeline / webhook / reconciler) have NO
# human "watcher" — they are driven autonomously, not by a dashboard operator. The
# tab-closed suspend signal (a dashboard RunDetailPage unloading on pagehide) is a
# safety for INTERACTIVE daemon runs a human launched and is watching; it must NOT
# pause autonomous runs, or an automated pipeline stalls the moment anyone's
# dashboard tab navigates/closes. Identified by the run's origin.event_kind.
_AUTONOMOUS_EVENT_KINDS = frozenset({
    "recruiter_create_project", "recruiter_search", "recruiter_save", "recruiter_message",
    "recruiter_archive", "recruiter_recommendations", "recruiter_preview_count",
    "recruiter_demo_archive", "recruiter_demo_add", "recruiter_note",
    "new_job_position", "linkedin_lead_search", "recruiter_pipeline",
})

# Detached AI self-healing diagnosis tasks (fire-and-forget on FAILED recruiter runs).
# Kept referenced so the event loop doesn't GC them mid-run.
_DIAGNOSIS_TASKS: set = set()


def _substitute_runtime_params(steps: list[dict], runtime_params: dict) -> int:
    """In-place {{key}} substitution into each step's value / success_condition /
    methods using runtime_params.

    The lightweight "literal" counterpart of
    TemplateService.substitute_parameters: it lets a plain (non-analyzed,
    replay_strategy="literal") workflow be parameterized just by embedding
    {{placeholders}} in its step values — exactly what the machine-built
    Recruiter sub-workflows need (e.g. project name "-EZ {{position}}"). A step
    with no placeholder is left untouched, so this is a safe no-op for every
    existing literal workflow. Returns the number of placeholder hits.
    """
    if not runtime_params:
        return 0
    hits = 0

    def _repl(match: re.Match) -> str:
        nonlocal hits
        key = match.group(1)
        if key in runtime_params:
            hits += 1
            return str(runtime_params[key])
        return match.group(0)

    def _walk(node):
        if isinstance(node, str):
            return _PLACEHOLDER_RE.sub(_repl, node)
        if isinstance(node, list):
            return [_walk(x) for x in node]
        if isinstance(node, dict):
            return {k: _walk(v) for k, v in node.items()}
        return node

    for step in steps:
        if isinstance(step.get("value"), str):
            step["value"] = _walk(step["value"])
        if isinstance(step.get("success_condition"), dict):
            step["success_condition"] = _walk(step["success_condition"])
        if isinstance(step.get("methods"), list):
            step["methods"] = _walk(step["methods"])
    return hits


class ExecutionService:
    """Service for managing execution runs and their state transitions."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.audit = AuditService(session)
        self.workflows = WorkflowService(session)

    async def create_run(
        self,
        workflow_id: str,
        user_id: str | None = None,
        execution_plan: dict | None = None,
        execution_goal: str | None = None,
        runtime_params: dict | None = None,
    ) -> ExecutionRun:
        """Create a new execution run for a workflow."""
        logger.info("Creating run for workflow_id=%s", workflow_id)
        workflow = await self.workflows.get(workflow_id)
        steps = await self.workflows.get_steps(workflow_id)

        WorkflowStateMachine.transition(RunStatus.IDLE, RunStatus.QUEUED)

        snapshot: dict = {
            "workflow": {
                "id": str(workflow.id),
                "name": workflow.name,
                "version": workflow.version,
                "target_url": workflow.target_url,
                # Daemon reads this (via origin) to pick hardcoded vs generic.
                "execution_mode": workflow.execution_mode,
            },
            "steps": [
                {
                    "step_index": s.step_index,
                    "action_type": s.action_type,
                    "intent": s.intent,
                    "selector_chain": s.selector_chain,
                    "value": s.value,
                    "methods": s.methods,
                    "success_condition": s.success_condition,
                    # Critical-step flag: the daemon HARD-FAILS the run if a checkpoint
                    # step doesn't act / its success_condition fails (vs soft-miss).
                    "checkpoint": s.checkpoint,
                    "dom_context": s.dom_context,
                    # Phase 5: selector stability from EMA learning (None = no history yet)
                    "selector_stability_score": s.selector_stability_score,
                }
                for s in steps
            ],
        }
        # Literal-workflow parameterization: substitute {{key}} placeholders in
        # the snapshot's step values with runtime_params. For "parameterized"
        # workflows the substituted steps arrive via execution_plan and overwrite
        # these in apply_execution_plan below; this pass is what lets the plain
        # machine-built Recruiter sub-workflows be driven with runtime params
        # too. No-op when there are no placeholders.
        if runtime_params:
            hits = _substitute_runtime_params(snapshot["steps"], runtime_params)
            if hits:
                logger.info(
                    "create_run: substituted %d runtime placeholder(s) for workflow %s",
                    hits, workflow_id,
                )
        snapshot["original_steps"] = deepcopy(snapshot["steps"])

        analysis_data = await self._load_analysis(workflow_id)
        if analysis_data:
            snapshot["analysis"] = analysis_data

        # Phase 6: seed goal_progress from the workflow analysis (if any).
        # phases come from semantic analysis; intents come from each step's
        # recorded intent so the LLM can see "what still needs to happen."
        goal_progress = _seed_goal_progress(analysis_data, snapshot["steps"])

        run = ExecutionRun(
            workflow_id=workflow_id,
            workflow_snapshot=snapshot,
            user_id=user_id,
            total_steps=len(steps),
            status="queued",
            goal_progress=goal_progress,
        )
        self.session.add(run)
        await self.session.flush()

        if execution_plan or execution_goal:
            await self.apply_execution_plan(run, execution_plan or {}, execution_goal)

        await self.audit.append(AppendEvent(
            event_type="run_started",
            payload={"workflow_id": workflow_id, "step_count": run.total_steps},
            run_id=str(run.id),
        ))
        logger.info("Created run id=%s workflow_id=%s", run.id, workflow_id)
        return run

    async def apply_execution_plan(
        self,
        run: ExecutionRun,
        execution_plan: dict,
        execution_goal: str | None = None,
    ) -> ExecutionRun:
        snapshot = deepcopy(run.workflow_snapshot or {})
        analysis = dict(snapshot.get("analysis") or {})
        planned_steps = execution_plan.get("steps")

        if isinstance(planned_steps, list) and planned_steps:
            snapshot["steps"] = [
                {
                    "step_index": i,
                    "action_type": step.get("action_type"),
                    "intent": step.get("intent"),
                    "selector_chain": step.get("selector_chain"),
                    "value": step.get("value"),
                    "methods": step.get("methods"),
                    "success_condition": step.get("success_condition"),
                    "dom_context": step.get("dom_context"),
                }
                for i, step in enumerate(planned_steps)
            ]
            run.total_steps = len(snapshot["steps"])
        snapshot["original_steps"] = deepcopy(snapshot.get("steps", []))

        if execution_goal:
            analysis["workflow_goal"] = execution_goal
        if execution_plan:
            analysis["execution_plan"] = {
                "strategy": execution_plan.get("strategy"),
                "mode": execution_plan.get("mode"),
                "resolved_parameters": execution_plan.get("resolved_parameters") or execution_plan.get("parameters") or {},
                "connector_resolution": execution_plan.get("connector_resolution") or [],
            }
        if analysis:
            snapshot["analysis"] = analysis
        snapshot["resolved_parameters"] = execution_plan.get("resolved_parameters") or execution_plan.get("parameters") or {}
        snapshot["connector_resolution"] = execution_plan.get("connector_resolution") or []

        run.workflow_snapshot = snapshot
        run.goal_progress = _seed_goal_progress(snapshot.get("analysis"), snapshot.get("steps", []))
        if execution_plan.get("mode") == "confirmation_required" and isinstance(run.goal_progress, dict):
            run.goal_progress["confirmation_required"] = True

        flag_modified(run, "workflow_snapshot")
        flag_modified(run, "goal_progress")
        await self.session.flush()
        return run

    async def expand_for_each(self, run_id: str, step_index: int) -> dict:
        """Materialize a for_each step by reading the configured source URLs from
        prior extraction events and splicing inner_steps copies into the run's
        snapshot — one per item, with $item substituted.

        Idempotent: if the for_each step is already marked expanded, returns the
        current snapshot without re-splicing.
        """
        from core.models.event import EventLog

        run = await self.get_run(run_id)
        snapshot = deepcopy(run.workflow_snapshot or {})
        steps = snapshot.get("steps") or []
        if step_index < 0 or step_index >= len(steps):
            raise NotFoundError(f"Step {step_index} not in snapshot")

        step = steps[step_index]
        if step.get("action_type") != "for_each":
            raise StateTransitionError(
                f"Step {step_index} is action_type={step.get('action_type')}, not for_each"
            )

        methods = step.get("methods") or []
        config = None
        for m in methods:
            if isinstance(m, dict) and m.get("kind") == "for_each_config":
                config = m
                break
        if not config:
            raise StateTransitionError("for_each step is missing a for_each_config method")
        if config.get("expanded"):
            return {"steps": steps, "iterations": 0, "already_expanded": True}

        sources = config.get("sources") or []
        item_sigil = str(config.get("item_sigil") or "$item")
        limit_param = str(config.get("limit_param") or "")
        inner_steps = config.get("inner_steps") or []
        inner_failure_policy = str(config.get("inner_failure_policy") or "continue")
        def _int_or_zero(key: str) -> int:
            try:
                return int(config.get(key) or 0)
            except (TypeError, ValueError):
                return 0
        iteration_delay_ms = _int_or_zero("iteration_delay_ms")
        iteration_delay_jitter_ms = _int_or_zero("iteration_delay_jitter_ms")
        extended_cooldown_every_n = _int_or_zero("extended_cooldown_every_n")
        extended_cooldown_ms = _int_or_zero("extended_cooldown_ms")
        extended_cooldown_jitter_ms = _int_or_zero("extended_cooldown_jitter_ms")
        noise_navigations = bool(config.get("noise_navigations"))
        # random_seed for tests and stable replay; if absent, use system entropy
        seed_raw = config.get("random_seed")
        try:
            random_seed = int(seed_raw) if seed_raw is not None else None
        except (TypeError, ValueError):
            random_seed = None

        # Resolve the iteration limit from runtime parameters first, then
        # fall back to webhook origin payload for connector-triggered runs.
        limit = None
        raw_limit = None
        if limit_param:
            analysis = snapshot.get("analysis") or {}
            execution_plan = analysis.get("execution_plan") or {}
            resolved = execution_plan.get("resolved_parameters") or {}
            raw_limit = resolved.get(limit_param)

            if raw_limit is None:
                origin = run.origin or {}
                job_payload = origin.get("job_payload") or {}
                fallback_keys = [limit_param]
                if limit_param == "count":
                    fallback_keys.extend(["candidate_count", "count"])
                for key in fallback_keys:
                    raw_limit = job_payload.get(key)
                    if raw_limit is None:
                        raw_limit = origin.get(key)
                    if raw_limit is not None:
                        break

            if raw_limit is not None:
                try:
                    limit = int(raw_limit)
                except (TypeError, ValueError):
                    limit = None

        # Pull source items from event_log extraction payloads, keyed by step_index.
        result = await self.session.execute(
            select(EventLog).where(
                EventLog.run_id == to_uuid(run_id),
                EventLog.event_type == "extraction",
            )
        )
        extractions_by_step: dict[int, list] = {}
        for ev in result.scalars().all():
            payload = ev.payload or {}
            si = payload.get("step_index")
            data = payload.get("data") or []
            if isinstance(si, int) and isinstance(data, list):
                extractions_by_step.setdefault(si, []).extend(data)

        items: list[str] = []
        seen: set[str] = set()
        for source in sources:
            if not isinstance(source, dict):
                continue
            src_idx = source.get("step_index")
            field = source.get("field")
            if not isinstance(src_idx, int) or not isinstance(field, str):
                continue
            for record in extractions_by_step.get(src_idx, []) or []:
                if not isinstance(record, dict):
                    continue
                value = record.get(field)
                if isinstance(value, list):
                    for v in value:
                        if isinstance(v, str) and v not in seen:
                            seen.add(v)
                            items.append(v)
                elif isinstance(value, str) and value not in seen:
                    seen.add(value)
                    items.append(value)

        if limit is not None:
            items = items[:limit]

        # Build the materialized inner steps with $item replaced.
        def _substitute(node, item: str):
            if isinstance(node, str):
                return node.replace(item_sigil, item)
            if isinstance(node, list):
                return [_substitute(x, item) for x in node]
            if isinstance(node, dict):
                return {k: _substitute(v, item) for k, v in node.items()}
            return node

        import random as _random

        rng = _random.Random(random_seed) if random_seed is not None else _random.Random()

        # Probability-weighted distribution of noise_break kinds. Keep this in
        # sync with the extension's executeNoiseBreak implementation.
        noise_kinds: list[tuple[str, float]] = [
            ("search_bounce", 0.35),
            ("feed_scroll", 0.20),
            ("profile_hover", 0.25),
            ("idle_scroll", 0.20),
        ]

        def _pick_noise_kind() -> str:
            r = rng.random()
            acc = 0.0
            for kind, prob in noise_kinds:
                acc += prob
                if r <= acc:
                    return kind
            return noise_kinds[-1][0]

        materialized: list[dict] = []
        for iter_index, item in enumerate(items):
            # Optional inter-iteration jittered delay: first iteration has no
            # pre-wait. Encoded as `delay_before_ms` on the first inner step
            # so the extension's existing per-step delay path handles it.
            pre_delay = 0
            extended = False
            if iter_index > 0 and iteration_delay_ms > 0:
                jitter = rng.randint(0, iteration_delay_jitter_ms) if iteration_delay_jitter_ms > 0 else 0
                pre_delay = iteration_delay_ms + jitter
                # Stack the extended-cooldown pause on every Nth iteration.
                if (
                    extended_cooldown_every_n > 0
                    and extended_cooldown_ms > 0
                    and iter_index % extended_cooldown_every_n == 0
                ):
                    cooldown_jitter = (
                        rng.randint(0, extended_cooldown_jitter_ms)
                        if extended_cooldown_jitter_ms > 0
                        else 0
                    )
                    pre_delay += extended_cooldown_ms + cooldown_jitter
                    extended = True

            # Insert a noise_break pseudo-step BEFORE this iteration's first
            # inner step (except the very first iteration). The break carries
            # the iteration's pre_delay so the existing delay_before_ms hook
            # applies before any noise navigation.
            if iter_index > 0 and noise_navigations:
                noise_kind = _pick_noise_kind()
                noise_seed = rng.randrange(2**31)
                noise_step: dict = {
                    "action_type": "noise_break",
                    "value": None,
                    "intent": f"Noise break ({noise_kind})",
                    "_for_each_origin_step": step_index,
                    "_for_each_iteration": iter_index,
                    "_noise_kind": noise_kind,
                    "_noise_seed": noise_seed,
                    "_inner_failure_policy": inner_failure_policy,
                }
                if pre_delay > 0:
                    noise_step["delay_before_ms"] = pre_delay
                if extended:
                    noise_step["_extended_cooldown"] = True
                materialized.append(noise_step)
                # Iteration's delay is now carried by the noise step; don't
                # double-apply it on the first inner step below.
                pre_delay = 0
                extended = False

            for inner_pos, tmpl in enumerate(inner_steps):
                if not isinstance(tmpl, dict):
                    continue
                inner = _substitute(deepcopy(tmpl), item)
                inner["_for_each_item"] = item
                inner["_for_each_origin_step"] = step_index
                inner["_for_each_iteration"] = iter_index
                inner["_inner_failure_policy"] = inner_failure_policy
                if inner_pos == 0 and pre_delay > 0:
                    inner["delay_before_ms"] = pre_delay
                if inner_pos == 0 and extended:
                    inner["_extended_cooldown"] = True
                materialized.append(inner)

        # Splice: keep everything up to and including the for_each step, append
        # materialized inner steps, then keep everything after.
        before = steps[: step_index + 1]
        after = steps[step_index + 1 :]
        new_steps = before + materialized + after
        for i, s in enumerate(new_steps):
            s["step_index"] = i

        # Mark the for_each step as expanded (idempotency) and record the
        # iteration metadata for the UI.
        for m in new_steps[step_index].get("methods") or []:
            if isinstance(m, dict) and m.get("kind") == "for_each_config":
                m["expanded"] = True
                m["expanded_iterations"] = len(items)
                m["expanded_items"] = items
                break

        snapshot["steps"] = new_steps
        run.workflow_snapshot = snapshot
        run.total_steps = len(new_steps)
        flag_modified(run, "workflow_snapshot")
        await self.session.flush()

        await self.audit.append(AppendEvent(
            event_type="for_each_expanded",
            payload={
                "step_index": step_index,
                "iterations": len(items),
                "inner_steps_per_iteration": len(inner_steps),
                "total_steps_after": len(new_steps),
            },
            run_id=run_id,
        ))
        return {"steps": new_steps, "iterations": len(items), "items": items}

    async def reset_to_start(self, run_id: str) -> ExecutionRun:
        """Reset a run to its original executable snapshot and step 0."""
        run = await self.get_run(run_id)
        snapshot = deepcopy(run.workflow_snapshot or {})
        original_steps = deepcopy(snapshot.get("original_steps") or snapshot.get("steps") or [])
        snapshot["steps"] = original_steps
        for i, step in enumerate(snapshot.get("steps", [])):
            step["step_index"] = i
        run.workflow_snapshot = snapshot
        run.current_step_index = 0
        run.total_steps = len(snapshot.get("steps", []))
        run.goal_progress = _seed_goal_progress(snapshot.get("analysis"), snapshot.get("steps", []))
        flag_modified(run, "workflow_snapshot")
        flag_modified(run, "goal_progress")
        await self.session.flush()
        await self.audit.append(AppendEvent(
            event_type="run_restarted",
            payload={"current_step_index": 0, "total_steps": run.total_steps},
            run_id=run_id,
        ))
        return run

    async def rerun(self, source_run_id: str) -> ExecutionRun:
        """Create a NEW run that re-executes a previous run's substituted plan.

        Clones the source run's workflow_snapshot (preserving any runtime
        parameter substitutions that were baked in by `apply_execution_plan`)
        and seeds a fresh queued run. The caller is expected to transition the
        returned run to RUNNING.
        """
        source = await self.get_run(source_run_id)
        source_snapshot = deepcopy(source.workflow_snapshot or {})

        # Prefer original_steps (the pre-execution baseline that already
        # carries any param substitution). Fall back to current steps.
        baseline_steps = deepcopy(
            source_snapshot.get("original_steps") or source_snapshot.get("steps") or []
        )
        for i, step in enumerate(baseline_steps):
            step["step_index"] = i

        snapshot: dict = {
            "workflow": source_snapshot.get("workflow"),
            "steps": baseline_steps,
            "original_steps": deepcopy(baseline_steps),
        }
        if "analysis" in source_snapshot:
            snapshot["analysis"] = deepcopy(source_snapshot["analysis"])

        WorkflowStateMachine.transition(RunStatus.IDLE, RunStatus.QUEUED)

        goal_progress = _seed_goal_progress(snapshot.get("analysis"), snapshot.get("steps", []))

        run = ExecutionRun(
            workflow_id=source.workflow_id,
            workflow_snapshot=snapshot,
            user_id=source.user_id,
            total_steps=len(baseline_steps),
            status="queued",
            goal_progress=goal_progress,
        )
        self.session.add(run)
        await self.session.flush()

        await self.audit.append(AppendEvent(
            event_type="run_started",
            payload={
                "workflow_id": source.workflow_id,
                "step_count": run.total_steps,
                "rerun_of": str(source.id),
            },
            run_id=str(run.id),
        ))
        logger.info("Created rerun id=%s source_run_id=%s", run.id, source.id)
        return run

    async def relaunch(self, source_run_id: str) -> ExecutionRun:
        """Re-launch a terminal run (e.g. a search that FAILED on a walled /talent seat):
        clone it like rerun BUT preserve the source `origin` (pipeline context +
        execution_target=daemon + target_operator + execution_options + runtime_params +
        event_kind) and leave it QUEUED — so the SAME operator's daemon re-claims it and
        the pipeline terminal hook (`_after_search`) still fires on completion.
        """
        source = await self.get_run(source_run_id)
        new_run = await self.rerun(source_run_id)  # cloned snapshot, status=queued
        if source.origin:
            new_run.origin = deepcopy(source.origin)
            flag_modified(new_run, "origin")
            await self.session.flush()
        logger.info(
            "Relaunched run id=%s from source=%s (origin/target preserved, queued)",
            new_run.id, source_run_id,
        )
        return new_run

    async def get_run(self, run_id: str) -> ExecutionRun:
        """Get a run by ID."""
        try:
            uid = uuid.UUID(run_id)
        except ValueError:
            raise NotFoundError(f"Run {run_id} not found") from None
        result = await self.session.execute(
            select(ExecutionRun).where(ExecutionRun.id == uid)
        )
        run = result.scalar_one_or_none()
        if not run:
            raise NotFoundError(f"Run {run_id} not found")
        return run

    async def get_run_for_update(self, run_id: str) -> ExecutionRun:
        """Get a run by ID under row lock for stateful mutations."""
        uid = to_uuid(run_id)
        result = await self.session.execute(
            select(ExecutionRun).where(ExecutionRun.id == uid).with_for_update()
        )
        run = result.scalar_one_or_none()
        if not run:
            raise NotFoundError(f"Run {run_id} not found")
        return run

    async def transition(self, run_id: str, target_status: RunStatus) -> ExecutionRun:
        """Transition a run to a new status."""
        run = await self.get_run_for_update(run_id)

        old_status = run.status
        try:
            new_status = WorkflowStateMachine.transition(
                RunStatus(old_status), target_status
            )
        except ValueError:
            raise StateTransitionError(
                f"Invalid status: {target_status}"
            ) from None

        run.status = new_status.value

        now = datetime.now(UTC)
        if new_status == RunStatus.RUNNING and not run.started_at:
            run.started_at = now
        if new_status in (RunStatus.FAILED, RunStatus.COMPLETED, RunStatus.CANCELED):
            run.ended_at = now

        try:
            await self.session.flush()
            logger.info("Run %s transitioned %s -> %s", run_id, old_status, new_status.value)
            log.backend("execution", "run_transition", status="success", details={
                "run_id": run_id,
                "from_status": old_status,
                "to_status": new_status.value,
                "current_step": run.current_step_index,
            })
            await self.audit.append(AppendEvent(
                event_type=f"run_{new_status.value}",
                payload={
                    "from_status": old_status,
                    "to_status": new_status.value,
                    "current_step": run.current_step_index,
                },
                run_id=run_id,
            ))
        except Exception:
            await self.session.rollback()
            raise

        # Phase 5: on terminal state, fold this run's outcome back into the
        # workflow's stability scores. Best-effort; learning failures must
        # not block run termination.
        if new_status in (RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELED):
            try:
                from services.learning_service import LearningService
                summary = await LearningService(self.session).record_run_outcome(run)
                logger.info(
                    "Learning recorded for run %s: steps=%d params=%d",
                    run_id, summary.get("steps_updated", 0),
                    summary.get("params_updated", 0),
                )
            except Exception:
                logger.exception("Learning service failed for run %s", run_id)

            try:
                from services.ai_outcome_service import AIOutcomeService
                await AIOutcomeService(self.session).finalize_run_summary(run)
            except Exception:
                logger.exception("RunSummary finalization failed for run %s", run_id)

            event_kind = (run.origin or {}).get("event_kind") if run.origin else None
            if new_status == RunStatus.COMPLETED and event_kind in (
                "new_job_position", "linkedin_lead_search",
            ):
                # The push hook makes a synchronous HTTP call to Odoo that can
                # take 30–240s per applicant (8 AI agents serially). Commit
                # the outer session first so we release the SELECT FOR UPDATE
                # row lock on this run + any pending UPDATEs against it;
                # otherwise concurrent daemon/heartbeat/step updates queue
                # behind the lock and produce a "idle in transaction" chain.
                # The push hook uses its own session via async_session_factory.
                try:
                    await self.session.commit()
                except Exception:
                    logger.exception(
                        "Pre-push session commit failed for run %s", run_id
                    )
                try:
                    if event_kind == "linkedin_lead_search":
                        push_result = await self._push_linkedin_leads_after_completion(run)
                        logger.info(
                            "LinkedIn lead push for run %s: %s", run_id, push_result
                        )
                    else:
                        push_result = await self._push_linkedin_applicants_after_completion(run)
                        logger.info(
                            "LinkedIn applicant push for run %s: %s", run_id, push_result
                        )
                except Exception:
                    logger.exception(
                        "LinkedIn push failed for run %s (event_kind=%s)",
                        run_id, event_kind,
                    )

            # Recruiter (/talent) automation pipeline: chain to the next step
            # (create-project → search → save). advance() pushes the relevant
            # write-back to Odoo and enqueues the next daemon run. Same
            # commit-before-await discipline as the push hooks above.
            if new_status == RunStatus.COMPLETED and (event_kind or "").startswith(
                "recruiter_"
            ):
                try:
                    await self.session.commit()
                except Exception:
                    logger.exception(
                        "Pre-advance session commit failed for run %s", run_id
                    )
                try:
                    adv = await self._advance_recruiter_pipeline_after_completion(run)
                    logger.info(
                        "Recruiter pipeline advance for run %s (%s): %s",
                        run_id, event_kind, adv,
                    )
                except Exception:
                    logger.exception(
                        "Recruiter pipeline advance failed for run %s (%s)",
                        run_id, event_kind,
                    )

            # Recruiter automation FAILED → surface it on the Odoo hr.job (status +
            # chatter note + a to-do for the recruiter) so a stalled flow is visible
            # instead of silently failing. Same commit-before-await discipline as the
            # hooks above; the notify runs in a fresh session.
            if new_status == RunStatus.FAILED and (event_kind or "").startswith(
                "recruiter_"
            ):
                try:
                    await self.session.commit()
                except Exception:
                    logger.exception(
                        "Pre-failure-notify commit failed for run %s", run_id
                    )
                try:
                    notified = await self._notify_recruiter_failure(run)
                    logger.info(
                        "Recruiter failure notify for run %s (%s): %s",
                        run_id, event_kind, notified,
                    )
                except Exception:
                    logger.exception(
                        "Recruiter failure notify failed for run %s (%s)",
                        run_id, event_kind,
                    )

            # AI SELF-HEALING (SHADOW): diagnose a FAILED recruiter run in the BACKGROUND so
            # the slow LLM call never blocks this terminal transition (it opens its own session).
            # Best-effort; applies NOTHING — it persists a diagnosis into run.origin.ai_diagnosis.
            if new_status == RunStatus.FAILED and self._is_recruiter_run(run, event_kind):
                try:
                    from services.self_healing_service import diagnose_failed_run

                    task = asyncio.create_task(diagnose_failed_run(str(run_id)))
                    _DIAGNOSIS_TASKS.add(task)
                    task.add_done_callback(_DIAGNOSIS_TASKS.discard)
                except Exception:
                    logger.exception("self-heal: failed to spawn diagnosis for run %s", run_id)

        return run

    @staticmethod
    def _is_recruiter_run(run: ExecutionRun, event_kind: str) -> bool:
        """A failed run worth AI-diagnosing: a recruiter pipeline event_kind, OR any workflow
        whose snapshot name starts with 'Recruiter:' / targets /talent/ (covers ad-hoc + test
        copies run via run-with-params, which carry no recruiter event_kind)."""
        if (event_kind or "").startswith("recruiter_"):
            return True
        wf = (run.workflow_snapshot or {}).get("workflow") or {}
        name = str(wf.get("name") or "")
        target = str(wf.get("target_url") or "")
        return name.startswith("Recruiter:") or "/talent/" in target

    async def _advance_recruiter_pipeline_after_completion(self, run: ExecutionRun) -> dict:
        """Advance the Recruiter automation pipeline in a fresh session.

        Sibling of the push hooks: when a recruiter_* run COMPLETES, dispatch to
        RecruiterPipelineService.advance, which performs the Odoo write-back for the
        finished stage and enqueues the next daemon run. The lazy import avoids a
        circular import (recruiter_pipeline_service imports ExecutionService).
        """
        from services.recruiter_pipeline_service import RecruiterPipelineService

        async with async_session_factory() as adv_session:
            from sqlalchemy import select as _select
            stmt = _select(ExecutionRun).where(ExecutionRun.id == run.id)
            adv_run = (await adv_session.execute(stmt)).scalar_one_or_none()
            svc = RecruiterPipelineService(adv_session)
            result = await svc.advance(adv_run if adv_run is not None else run)
            await adv_session.commit()
            return result

    async def _notify_recruiter_failure(self, run: ExecutionRun) -> dict:
        """Surface a FAILED recruiter_* run on the Odoo position, in a fresh session.

        Sibling of the advance/push hooks: when a recruiter run FAILS (walled seat,
        step timeout, checkpoint, pipeline stage error), notify Odoo so the hr.job
        shows the failure (status + chatter + recruiter to-do). Best-effort."""
        from services.recruiter_pipeline_service import RecruiterPipelineService

        async with async_session_factory() as fail_session:
            from sqlalchemy import select as _select
            stmt = _select(ExecutionRun).where(ExecutionRun.id == run.id)
            fail_run = (await fail_session.execute(stmt)).scalar_one_or_none()
            svc = RecruiterPipelineService(fail_session)
            result = await svc.notify_failure(fail_run if fail_run is not None else run)
            await fail_session.commit()
            return result

    async def _push_linkedin_applicants_after_completion(self, run: ExecutionRun) -> dict:
        """Run post-completion Odoo applicant push in a fresh session.

        Completion-time learning/finalization hooks are best-effort and may
        leave the request session in a failed transaction state even when the
        run itself legitimately completes. Use an independent session for the
        external Odoo push so applicant ingestion is not coupled to that ORM
        state.
        """
        from services.linkedin_applicant_push_service import (
            LinkedInApplicantPushService,
        )

        async with async_session_factory() as push_session:
            # Re-load the run in the push session so push_from_run can
            # persist linkedin_applicants on it.
            from sqlalchemy import select as _select
            stmt = _select(ExecutionRun).where(ExecutionRun.id == run.id)
            push_run = (await push_session.execute(stmt)).scalar_one_or_none()
            if push_run is None:
                # Fall back to origin-only push without snapshot persistence.
                service = LinkedInApplicantPushService(push_session)
                result = await service.push_for_origin(
                    run_id=run.id,
                    origin=run.origin or {},
                )
            else:
                service = LinkedInApplicantPushService(push_session)
                result = await service.push_from_run(push_run)
            await push_session.commit()
            return result

    async def _push_linkedin_leads_after_completion(self, run: ExecutionRun) -> dict:
        """Run post-completion Odoo lead push in a fresh session.

        Sibling of _push_linkedin_applicants_after_completion for the
        lightweight lead-sourcing flow (event_kind == "linkedin_lead_search").
        Uses an independent session so lead ingestion isn't coupled to any
        failed transaction state left by completion-time hooks.
        """
        from services.linkedin_lead_push_service import LinkedInLeadPushService

        async with async_session_factory() as push_session:
            from sqlalchemy import select as _select
            stmt = _select(ExecutionRun).where(ExecutionRun.id == run.id)
            push_run = (await push_session.execute(stmt)).scalar_one_or_none()
            service = LinkedInLeadPushService(push_session)
            if push_run is None:
                result = await service.push_for_origin(
                    run_id=run.id,
                    origin=run.origin or {},
                )
            else:
                result = await service.push_from_run(push_run)
            await push_session.commit()
            return result

    async def advance_step(
        self, run_id: str, *, expected_step_index: int | None = None
    ) -> ExecutionRun:
        """Advance the current step index by one."""
        run = await self.get_run_for_update(run_id)
        if run.status != RunStatus.RUNNING.value:
            raise StateTransitionError(
                f"Cannot advance step: run is '{run.status}', must be 'running'"
            )
        if (
            expected_step_index is not None
            and run.current_step_index != expected_step_index
        ):
            raise StateTransitionError(
                f"Expected step {expected_step_index}, got {run.current_step_index}"
            )
        run.current_step_index += 1
        # Phase 6: keep goal_progress in sync with the cursor
        if run.goal_progress:
            run.goal_progress = _advance_goal_progress(
                run.goal_progress, run.current_step_index,
            )
            from sqlalchemy.orm.attributes import flag_modified
            flag_modified(run, "goal_progress")
        if run.current_step_index >= run.total_steps:
            return await self.complete(run_id)
        await self.session.flush()
        logger.info("Advanced step run=%s step=%d", run_id, run.current_step_index)
        return run

    async def pause(self, run_id: str, reason: str) -> ExecutionRun:
        """Pause a run and set the pause reason."""
        run = await self.transition(run_id, RunStatus.WAITING_FOR_USER)
        run.pause_reason = reason
        await self.session.flush()

        await self.audit.append(AppendEvent(
            event_type="run_paused",
            payload={
                "reason": reason,
                "from_status": RunStatus.RUNNING.value,
                "to_status": RunStatus.WAITING_FOR_USER.value,
            },
            run_id=run_id,
        ))
        return run

    async def tab_closed(self, run_id: str) -> ExecutionRun:
        """Mark a run as waiting_for_user with pause_reason='tab_closed'.

        Idempotent: only acts on runs that have an active browser tab
        (running, recovering, waiting_for_user). Terminal and pre-running
        states are returned unchanged.
        """
        run = await self.get_run(run_id)
        # Autonomous (pipeline/webhook/reconciler) runs have no dashboard watcher —
        # a RunDetailPage unloading must never suspend them. Only interactive daemon
        # runs (no autonomous event_kind) are watch-gated.
        event_kind = (run.origin or {}).get("event_kind")
        if event_kind in _AUTONOMOUS_EVENT_KINDS:
            logger.info(
                "tab_closed ignored for autonomous run %s (event_kind=%s) — "
                "pipeline/webhook runs are not gated by a dashboard watcher",
                run_id, event_kind,
            )
            return run
        active_states = {
            RunStatus.RUNNING.value,
            RunStatus.RECOVERING.value,
            RunStatus.WAITING_FOR_USER.value,
        }
        if run.status not in active_states:
            return run  # no active tab for queued/terminal states
        if run.pause_reason == "tab_closed":
            return run  # already recorded — idempotent
        previous_status = run.status
        if run.status == RunStatus.WAITING_FOR_USER.value:
            # Already paused — just stamp the reason without re-transitioning
            run.pause_reason = "tab_closed"
            await self.session.flush()
            await self.audit.append(AppendEvent(
                event_type="run_tab_closed",
                payload={"previous_status": previous_status, "step_index": run.current_step_index},
                run_id=run_id,
            ))
            return run
        run = await self.transition(run_id, RunStatus.WAITING_FOR_USER)
        run.pause_reason = "tab_closed"
        await self.session.flush()
        await self.audit.append(AppendEvent(
            event_type="run_tab_closed",
            payload={"previous_status": previous_status, "step_index": run.current_step_index},
            run_id=run_id,
        ))
        return run

    async def resume(self, run_id: str) -> ExecutionRun:
        """Resume a paused run. Raises StateTransitionError if the tab was closed."""
        uid = to_uuid(run_id)
        # Read under lock so the pause_reason guard can't race with tab_closed().
        result = await self.session.execute(
            select(ExecutionRun).where(ExecutionRun.id == uid).with_for_update()
        )
        run = result.scalar_one_or_none()
        if not run:
            raise NotFoundError(f"Run {run_id} not found")
        if run.pause_reason == "tab_closed":
            raise StateTransitionError(
                "Cannot resume: the browser tab was closed. Use Re-run to start a new execution."
            )
        logger.info("Resuming run=%s", run_id)
        return await self.transition(run_id, RunStatus.RUNNING)

    async def fail(self, run_id: str, error: str) -> ExecutionRun:
        """Mark a run as failed."""
        logger.warning("Failing run=%s error=%s", run_id, error)
        run = await self.get_run(run_id)
        run.error_summary = error
        return await self.transition(run_id, RunStatus.FAILED)

    async def complete(self, run_id: str) -> ExecutionRun:
        """Mark a run as completed."""
        logger.info("Completing run=%s", run_id)
        return await self.transition(run_id, RunStatus.COMPLETED)

    async def cancel(self, run_id: str) -> ExecutionRun:
        """Cancel a run."""
        logger.info("Canceling run=%s", run_id)
        return await self.transition(run_id, RunStatus.CANCELED)

    async def _load_analysis(self, workflow_id: str) -> dict | None:
        """Load workflow analysis for the execution snapshot."""
        from services.semantic_analysis_service import SemanticAnalysisService
        try:
            svc = SemanticAnalysisService(self.session)
            phases = await svc.get_phases(workflow_id)
            parameters = await svc.get_parameters(workflow_id)
            analysis = await svc.get_analysis(workflow_id)
            if not analysis and not phases:
                return None
            result: dict = {}
            if analysis:
                result["workflow_goal"] = analysis.workflow_goal
                result["domain_context"] = analysis.domain_context
                result["replay_strategy"] = analysis.replay_strategy
                result["confidence_overall"] = analysis.confidence_overall
                result["goal_predicate"] = analysis.goal_predicate
            if phases:
                result["phases"] = [
                    {
                        "name": p.phase_name,
                        "goal": p.phase_goal,
                        "start_step": p.start_step_index,
                        "end_step": p.end_step_index,
                    }
                    for p in phases
                ]
            if parameters:
                result["parameters"] = [
                    {
                        "key": p.parameter_key,
                        "type": p.parameter_type,
                        "default": p.default_value,
                        "step_index": p.inferred_from_step,
                        "description": p.description,
                    }
                    for p in parameters
                ]
            return result
        except Exception:
            logger.debug("No analysis available for workflow_id=%s", workflow_id)
            return None

    async def list_runs(
        self, workflow_id: str | None = None, status: str | None = None,
        limit: int = 50, offset: int = 0,
    ) -> list[dict]:
        """List runs with optional filters."""
        logger.info("Listing runs workflow_id=%s status=%s", workflow_id, status)
        query = select(ExecutionRun)
        if workflow_id:
            query = query.where(ExecutionRun.workflow_id == workflow_id)
        if status:
            query = query.where(ExecutionRun.status == status)
        query = query.order_by(ExecutionRun.created_at.desc()).limit(limit).offset(offset)
        result = await self.session.execute(query)
        runs = list(result.scalars().all())
        # Detach ORM objects — return dicts
        return [
            {
                "id": str(r.id),
                "workflow_id": r.workflow_id,
                "status": r.status,
                "current_step_index": r.current_step_index,
                "total_steps": r.total_steps,
                "pause_reason": r.pause_reason,
                "error_summary": r.error_summary,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "ended_at": r.ended_at.isoformat() if r.ended_at else None,
                "created_at": r.created_at.isoformat(),
                "origin": r.origin or None,
            }
            for r in runs
        ]


# ── Phase 6: goal-first cursor helpers ─────────────────────────────────────

def _seed_goal_progress(
    analysis: dict | None,
    steps: list[dict],
) -> dict:
    """Build the initial goal_progress payload from semantic analysis.

    Always returns a usable structure even when analysis is missing — the
    intents list is derived from each step's recorded `intent`, so the AI
    can see what every step is supposed to accomplish.
    """
    intents = [
        {"step_index": s.get("step_index", i), "intent": s.get("intent") or "", "status": "pending"}
        for i, s in enumerate(steps)
    ]
    phases: list[dict] = []
    if analysis and isinstance(analysis, dict):
        for raw_phase in (analysis.get("phases") or []):
            phases.append({
                "name": raw_phase.get("name", "phase"),
                "goal": raw_phase.get("goal", ""),
                "start_step": int(raw_phase.get("start_step", 0)),
                "end_step": int(raw_phase.get("end_step", 0)),
                "status": "pending",
            })
    # Mark the first phase active so the LLM sees state from poll 1.
    if phases:
        phases[0]["status"] = "active"
    return {
        "workflow_goal": (analysis or {}).get("workflow_goal") if analysis else None,
        "phases": phases,
        "intents": intents,
    }


def _advance_goal_progress(progress: dict, new_step_index: int) -> dict:
    """Update phase + intent statuses after the cursor moves forward."""
    if not isinstance(progress, dict):
        return progress
    intents = list(progress.get("intents") or [])
    for it in intents:
        idx = it.get("step_index")
        if isinstance(idx, int):
            if idx < new_step_index and it.get("status") != "satisfied":
                it["status"] = "satisfied"
            elif idx == new_step_index:
                it["status"] = "active"
            elif idx > new_step_index and it.get("status") not in {"satisfied", "skipped"}:
                it["status"] = "pending"

    phases = list(progress.get("phases") or [])
    for ph in phases:
        start = ph.get("start_step", 0)
        end = ph.get("end_step", 0)
        if new_step_index > end:
            ph["status"] = "done"
        elif start <= new_step_index <= end:
            ph["status"] = "active"
        elif new_step_index < start:
            ph["status"] = "pending"

    return {**progress, "intents": intents, "phases": phases}
