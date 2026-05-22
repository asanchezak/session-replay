"""End-to-end verification of the autonomy fix without a real browser.

This script simulates what the extension does — polls the agent for a step,
posts a result, polls again — but supplies synthetic page context so we can
verify the agent makes adaptive decisions for fragile (session-specific)
selectors.

Usage:
    uv run python scripts/verify_autonomy.py <workflow_id>

If <workflow_id> is omitted, defaults to cf7e5f3b-92c8-4bf9-93db-bfe278800129
(the "indeed.com" workflow whose first step uses a Google-session id).
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any
from urllib import error, request

BACKEND = "http://localhost:8081"
ROOT = Path(__file__).resolve().parent.parent


def _load_api_key() -> str:
    key = os.environ.get("API_KEY", "").strip()
    if key:
        return key
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            k, _, v = stripped.partition("=")
            if k.strip() == "API_KEY":
                return v.strip().strip("\"'")
    return "dev-api-key-change-in-production"


HEADERS = {"X-API-Key": _load_api_key(), "Content-Type": "application/json"}

DEFAULT_WORKFLOW = "cf7e5f3b-92c8-4bf9-93db-bfe278800129"


def call(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    data = json.dumps(body).encode() if body is not None else None
    req = request.Request(f"{BACKEND}{path}", data=data, method=method, headers=HEADERS)
    try:
        with request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except error.HTTPError as e:
        return {"_error": e.code, "_body": e.read().decode()}


def _pick_fallback_workflow() -> str | None:
    workflows = call("GET", "/v1/workflows")
    if isinstance(workflows, dict) and "_error" in workflows:
        return None
    if isinstance(workflows, list) and workflows:
        return str(workflows[0].get("id", "")) or None
    return None


def make_page_context(url: str, title: str, visible_elements: list[dict]) -> dict:
    """Synthetic page context as the extension would send."""
    return {
        "url": url,
        "title": title,
        "dom_snippet": "",
        "accessibility_tree": "",
        "visible_text": " ".join(e.get("text", "") for e in visible_elements),
        "visible_elements": visible_elements,
        "is_blocking": False,
        "blocking_type": None,
        "page_unchanged": False,
    }


def run() -> int:
    workflow_id = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_WORKFLOW

    print(f"Workflow: {workflow_id}")
    wf = call("GET", f"/v1/workflows/{workflow_id}")
    if "_error" in wf and workflow_id == DEFAULT_WORKFLOW:
        fallback_workflow = _pick_fallback_workflow()
        if fallback_workflow:
            workflow_id = fallback_workflow
            print(f"  default workflow missing; falling back to {workflow_id}")
            wf = call("GET", f"/v1/workflows/{workflow_id}")
    if "_error" in wf:
        print(f"  ✗ Could not fetch workflow: {wf}")
        return 1
    print(f"  name='{wf['name']}'  status={wf['status']}  steps={len(wf['steps'])}")

    # Look at step 0 to see whether it has a session-specific id
    step0 = wf["steps"][0]
    fragile = any(
        s.get("type") == "css" and s.get("value", "").startswith("#_")
        for s in step0.get("selector_chain", [])
    )
    print(f"  step 0 intent: {step0.get('intent')!r}")
    print(f"  step 0 selectors: {[s.get('value') for s in step0.get('selector_chain', [])]}")
    print(f"  step 0 looks fragile? {fragile}")

    # Create a run via the dashboard path
    run_obj = call("POST", "/v1/runs", {"workflow_id": workflow_id})
    if "_error" in run_obj:
        print(f"  ✗ create_run failed: {run_obj}")
        return 1
    run_id = run_obj["id"]
    print(f"\n  Run created: {run_id}")

    # Simulate the extension being on a Google search-results page where the
    # recorded session id no longer exists, but a visible "Indeed: Job Search"
    # link is present.
    ctx = make_page_context(
        url="https://www.google.com/search?q=indeed.com",
        title="indeed.com - Google Search",
        visible_elements=[
            {"tag": "a", "role": "link", "text": "Indeed: Job Search"},
            {"tag": "h3", "role": "heading", "text": "Indeed: Job Search"},
            {"tag": "a", "role": "link", "text": "Buscar empleo en Indeed Costa Rica"},
        ],
    )

    poll = call("POST", f"/v1/agent/{run_id}/poll", {
        "page_context": ctx,
        "current_step_index": 0,
    })
    if "_error" in poll:
        print(f"  ✗ poll failed: {poll}")
        return 1

    print(f"\n  Poll response:")
    print(f"    decision    : {poll.get('decision')}")
    print(f"    confidence  : {poll.get('confidence')}")
    print(f"    reasoning   : {poll.get('reasoning', '')[:200]}")
    cmd = poll.get("command")
    if cmd:
        print(f"    cmd.action  : {cmd.get('action')}")
        print(f"    cmd.value   : {cmd.get('value')}")
        sels = cmd.get("selector_chain") or []
        print(f"    cmd.selectors:")
        for s in sels[:5]:
            print(f"      - {s.get('type')}: {s.get('value')} (score={s.get('score')})")

    # Verdict
    decision = poll.get("decision")
    if fragile and decision == "EXECUTE":
        print("\n  ⚠ Agent EXECUTED a fragile selector — autonomy fix not active.")
        print("    (Likely backend has not been restarted with the new code.)")
        return 2
    if decision == "ADAPT":
        print("\n  ✓ Agent ADAPTED — autonomy fix is active.")
        return 0
    if decision == "EXECUTE" and not fragile:
        print("\n  ✓ Agent EXECUTED a stable selector — fine.")
        return 0
    print(f"\n  Decision: {decision}")
    return 0


if __name__ == "__main__":
    sys.exit(run())
