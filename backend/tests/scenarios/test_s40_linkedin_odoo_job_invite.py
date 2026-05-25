"""S40 — LinkedIn live replay sends Odoo job-invite instead of a generic text.

The scenario exercises the full pipeline:
  1. OdooAdapter fetches the first open job post (Odoo transport mocked via respx).
  2. _compose_job_invite() builds a personalised invitation from job title/description.
  3. The LinkedIn site adapter compiles a type_message step that carries that invite.
  4. TemplateService substitutes {{message_text}} with the Odoo-sourced invite before replay.
"""
from __future__ import annotations

import copy

import pytest

respx = pytest.importorskip("respx")
import httpx  # noqa: E402

ODOO_URL = "https://odoo.example.com"

_FIRST_JOB = {
    "id": 1,
    "name": "Senior Python Engineer",
    "description": "Join our fast-growing team and work on cutting-edge products",
    "state": "recruit",
    "job_url": "/jobs/senior-python-engineer",
}

# A LinkedIn messaging workflow template with {{message_text}} placeholder.
_LINKEDIN_WORKFLOW_TEMPLATE = {
    "workflow_id": "00000000-0000-0000-0000-000000000040",
    "parameters": [
        {
            "key": "message_text",
            "type": "str",
            "default": "Hello, I wanted to reach out.",
            "required": True,
            "description": "Message body sent via LinkedIn messaging.",
            "step_index": 3,
        }
    ],
    "steps": [
        {
            "step_index": 0,
            "action_type": "navigate",
            "intent": "Navigate to LinkedIn feed",
            "value": "https://www.linkedin.com/feed/",
            "selector_chain": [],
        },
        {
            "step_index": 1,
            "action_type": "click",
            "intent": "Open LinkedIn messaging dock",
            "value": "Messaging",
            "selector_chain": [{"type": "text", "value": "Messaging"}],
        },
        {
            "step_index": 2,
            "action_type": "click",
            "intent": "Open conversation with target contact",
            "value": "Jane Doe",
            "selector_chain": [
                {
                    "type": "shadow_css",
                    "value": (
                        '{"host_chain":["div[data-testid=\\"interop-shadowdom\\"]"],'
                        '"target":"li[data-test-id=\\"jane-doe\\"]"}'
                    ),
                }
            ],
        },
        {
            "step_index": 3,
            "action_type": "type",
            "intent": 'Type invitation message into "Write a message…" composer',
            "value": "{{message_text}}",
            "selector_chain": [
                {
                    "type": "shadow_css",
                    "value": (
                        '{"host_chain":["div[data-testid=\\"interop-shadowdom\\"]"],'
                        '"target":"div[contenteditable=\\"true\\"]"}'
                    ),
                }
            ],
            "success_condition": {"type": "visible_text_contains", "value": "{{message_text}}"},
        },
        {
            "step_index": 4,
            "action_type": "click",
            "intent": 'Click the "Send" button',
            "value": "Send",
            "selector_chain": [
                {
                    "type": "shadow_css",
                    "value": (
                        '{"host_chain":["div[data-testid=\\"interop-shadowdom\\"]"],'
                        '"target":"button[aria-label=\\"Send\\"]"}'
                    ),
                }
            ],
        },
    ],
}


def _rpc(result):
    return {"jsonrpc": "2.0", "id": 1, "result": result}


def _compose_job_invite(job: dict) -> str:
    """Build a personalised LinkedIn invitation from an Odoo job record."""
    desc = (job.get("description") or "").rstrip(".")
    return (
        f"Hi! We have an exciting opening: '{job['name']}'. "
        f"{desc}. "
        "We'd love for you to apply — feel free to reply if you're interested!"
    )


@pytest.mark.asyncio
async def test_odoo_first_job_fetch():
    """OdooAdapter.list returns the mocked first open job."""
    from adapters.odoo.adapter import OdooAdapter

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        if b'"login"' in body:
            return httpx.Response(200, json=_rpc({"uid": 1}))
        return httpx.Response(200, json=_rpc([_FIRST_JOB]))

    with respx.mock() as r:
        r.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)
        adapter = OdooAdapter({"url": ODOO_URL, "database": "db", "username": "u", "password": "p"})
        await adapter.connect()
        jobs = await adapter.list("job", filters={"state": "recruit"}, limit=1)

    assert len(jobs) == 1
    assert jobs[0]["name"] == "Senior Python Engineer"
    assert jobs[0]["state"] == "recruit"


def test_compose_invite_includes_title_and_cta():
    """Invite text must contain the job title and a call-to-action."""
    msg = _compose_job_invite(_FIRST_JOB)
    assert "Senior Python Engineer" in msg
    assert "apply" in msg.lower()
    assert len(msg) > 50


def test_compose_invite_handles_missing_description():
    """Compose must not crash when description is absent."""
    msg = _compose_job_invite({"id": 2, "name": "DevOps Engineer"})
    assert "DevOps Engineer" in msg
    assert "apply" in msg.lower()


@pytest.mark.asyncio
async def test_linkedin_replay_sends_odoo_job_invite(db_session):
    """Full pipeline: Odoo first-job → compose invite → substitute → site adapter."""
    from adapters.odoo.adapter import OdooAdapter
    from services.agent_models import PageContext
    from services.site_adapters.linkedin import LinkedInSiteAdapter
    from services.template_service import TemplateService

    # ── 1. Fetch the first open job from Odoo ──────────────────────────────
    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        if b'"login"' in body:
            return httpx.Response(200, json=_rpc({"uid": 1}))
        return httpx.Response(200, json=_rpc([_FIRST_JOB]))

    with respx.mock() as r:
        r.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)
        odoo = OdooAdapter({"url": ODOO_URL, "database": "db", "username": "u", "password": "p"})
        await odoo.connect()
        jobs = await odoo.list("job", filters={"state": "recruit"}, limit=1)

    assert jobs, "Odoo adapter must return at least one open job"
    invite_message = _compose_job_invite(jobs[0])

    # ── 2. Substitute {{message_text}} in the workflow template ───────────
    svc = TemplateService(db_session)
    substituted_steps = await svc.substitute_parameters(
        copy.deepcopy(_LINKEDIN_WORKFLOW_TEMPLATE),
        {"message_text": invite_message},
    )

    type_step = substituted_steps[3]
    assert type_step["value"] == invite_message, (
        f"type_message step must carry the Odoo invite, got: {type_step['value']!r}"
    )
    assert type_step["success_condition"]["value"] == invite_message

    # ── 3. Verify the LinkedIn site adapter compiles the enriched step ────
    linkedin = LinkedInSiteAdapter()
    ctx = PageContext(url="https://www.linkedin.com/feed/", title="LinkedIn")
    cmd = linkedin.compile_command(type_step, ctx)

    assert cmd is not None
    assert cmd.script_args["operation"] == "type_message"
    assert cmd.script_args["text"] == invite_message
    assert cmd.success_condition is None


@pytest.mark.asyncio
async def test_no_open_jobs_falls_back_to_template_default(db_session):
    """When Odoo returns no open jobs, {{message_text}} resolves to param default."""
    from adapters.odoo.adapter import OdooAdapter
    from services.template_service import TemplateService

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        if b'"login"' in body:
            return httpx.Response(200, json=_rpc({"uid": 1}))
        return httpx.Response(200, json=_rpc([]))

    with respx.mock() as r:
        r.post(f"{ODOO_URL}/jsonrpc").mock(side_effect=handler)
        odoo = OdooAdapter({"url": ODOO_URL, "database": "db", "username": "u", "password": "p"})
        await odoo.connect()
        jobs = await odoo.list("job", filters={"state": "recruit"}, limit=1)

    assert jobs == [], "Odoo returns empty list — no open postings"

    # No runtime param override → TemplateService uses default value
    svc = TemplateService(db_session)
    substituted_steps = await svc.substitute_parameters(
        copy.deepcopy(_LINKEDIN_WORKFLOW_TEMPLATE),
        {},
    )

    type_step = substituted_steps[3]
    assert type_step["value"] == "Hello, I wanted to reach out."
