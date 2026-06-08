#!/usr/bin/env python3
"""Create (+activate) a Recruiter sub-workflow from a JSON spec via the AWS API.

Why this exists: the Recruiter /talent sub-workflows (search, save-to-project,
bulk-message) are built as plain generic workflows the daemon drives — navigate +
Phase-A click/type + existing extract strategies. Creating them needs only the public
AWS API (POST /v1/workflows then POST /{id}/steps), so NO daemon restart / SSH is
required (the running daemon claims the run). Keeps the warm /talent seat intact.

Spec JSON shape:
  {
    "name": "...", "description": "...", "target_url": "https://www.linkedin.com/talent/home",
    "steps": [
      {"action_type":"navigate","intent":"...","value":"https://..."},
      {"action_type":"click","intent":"...","selector_chain":[{"type":"text","value":"Save to project"},
                                                              {"type":"css","value":"button.foo"}]},
      {"action_type":"type","intent":"...","value":"Easy Recruit","selector_chain":[{"type":"css","value":"#x"}]},
      {"action_type":"extract","intent":"...","methods":[{"kind":"extract_strategy","strategy":"recruiter_search_people"}]}
    ]
  }

NOTE selector_chain values must be STRINGS (type in css|text|accessibility|xpath|anchor|shadow_css).
The recording's `anchor` selectors carry dict values and will 422 — lift text/css/xpath only.

Usage:  SR_API_KEY=... python3 scripts/create_recruiter_workflow.py spec.json
Prints WORKFLOW_ID=<uuid> on success.
"""
import json
import os
import sys
import urllib.request

BASE = os.environ.get("SR_BACKEND", "https://52-5-45-84.sslip.io").rstrip("/") + "/v1"
KEY = os.environ.get("SR_API_KEY", "28e54ef83e040faa366260aa13af5f5b1947b364731e1f22")


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"HTTP {e.code} on {method} {path}: {e.read().decode()[:300]}\n")
        raise


def main():
    spec = json.load(open(sys.argv[1]))
    wf = call("POST", "/workflows", {
        "name": spec["name"],
        "description": spec.get("description"),
        "target_url": spec.get("target_url"),
        "created_by": "claude-recruiter-builder",
    })
    wid = wf["id"]
    print("created", wid)
    for i, st in enumerate(spec["steps"]):
        st.setdefault("step_index", i)
        call("POST", f"/workflows/{wid}/steps", st)
        label = (st.get("intent") or st.get("value") or "")[:48]
        print(f"  + step {st['step_index']:>2} {st['action_type']:<9} {label}")
    try:
        call("PUT", f"/workflows/{wid}/status", {"status": "active"})
        print("activated")
    except Exception as e:
        print("activate skipped:", e)
    print("WORKFLOW_ID=" + wid)


if __name__ == "__main__":
    main()
