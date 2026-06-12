#!/usr/bin/env python3
"""Deploy Recruiter workflow specs from the repo to the AWS backend DB (spec -> DB).

The inverse of export_recruiter_workflows.py. For each entry in recruiter-workflows/registry.json
it pushes the spec's steps to the deployed workflow_id with PUT /v1/workflows/{id}/steps
(atomic replace_steps) and updates name/description via PUT /v1/workflows/{id}. This is how a
selector edit in a spec reaches production — no hand-curl, no daemon restart (the running daemon
hot-claims the next run; literal-workflow steps live in the DB).

Usage:
  python3 scripts/deploy_recruiter_workflows.py --only 7f11deb6   # one id/prefix/spec (recommended)
  python3 scripts/deploy_recruiter_workflows.py                   # ALL registry entries (careful)
  python3 scripts/deploy_recruiter_workflows.py --only 7f11deb6 --dry-run
Env: SR_BACKEND, SR_API_KEY (defaults = AWS prod).
"""
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WF_DIR = os.path.join(ROOT, "recruiter-workflows")
REGISTRY = os.path.join(WF_DIR, "registry.json")

BASE = os.environ.get("SR_BACKEND", "https://52-5-45-84.sslip.io").rstrip("/") + "/v1"
KEY = os.environ.get("SR_API_KEY", "28e54ef83e040faa366260aa13af5f5b1947b364731e1f22")

STEP_FIELDS = ["action_type", "intent", "selector_chain", "value", "methods", "success_condition"]


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
        sys.stderr.write(f"HTTP {e.code} on {method} {path}: {e.read().decode()[:400]}\n")
        raise


def main():
    only = None
    dry = "--dry-run" in sys.argv
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]
    if only is None and "--all" not in sys.argv:
        sys.exit("refusing to deploy ALL workflows without --all (use --only <id/prefix/spec>)")

    registry = json.load(open(REGISTRY))
    for entry in registry["workflows"]:
        wid = entry["workflow_id"]
        if only and not wid.startswith(only) and only != entry["spec"]:
            continue
        spec = json.load(open(os.path.join(WF_DIR, entry["spec"])))
        steps = [{f: s.get(f) for f in STEP_FIELDS} for s in spec["steps"]]
        print(f"{entry['spec']} -> {wid}  ({len(steps)} steps){'  [dry-run]' if dry else ''}")
        if dry:
            continue
        # workflow metadata (name/description)
        call("PUT", f"/workflows/{wid}", {
            "name": spec.get("name"),
            "description": spec.get("description"),
            "target_url": spec.get("target_url"),
        })
        res = call("PUT", f"/workflows/{wid}/steps", steps)
        print(f"  replaced -> {res.get('step_count')} steps live")


if __name__ == "__main__":
    main()
