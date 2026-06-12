#!/usr/bin/env python3
"""Export deployed Recruiter workflows from the AWS backend DB into versioned spec files.

The backend is authoritative at RUNTIME, but the spec files in recruiter-workflows/ are the
reviewable SOURCE OF TRUTH. This script pulls each workflow listed in
recruiter-workflows/registry.json (GET /v1/workflows/{id}) and writes a normalized spec so
git always reflects what's actually deployed — no more silent drift (the kind that hid the
2026-06-12 locale fix from the repo).

Spec shape written (matches scripts/create_recruiter_workflow.py input):
  { "name", "description", "target_url",
    "steps": [ {action_type, intent, selector_chain, value, methods, success_condition}, ... ] }

Usage:
  python3 scripts/export_recruiter_workflows.py            # export all registry entries
  python3 scripts/export_recruiter_workflows.py --only 1bc44128   # one id/prefix
  python3 scripts/export_recruiter_workflows.py --check    # exit 1 if any spec differs from DB
Env: SR_BACKEND, SR_API_KEY (defaults = AWS prod).
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WF_DIR = os.path.join(ROOT, "recruiter-workflows")
REGISTRY = os.path.join(WF_DIR, "registry.json")

BASE = os.environ.get("SR_BACKEND", "https://52-5-45-84.sslip.io").rstrip("/") + "/v1"
KEY = os.environ.get("SR_API_KEY", "28e54ef83e040faa366260aa13af5f5b1947b364731e1f22")

# Step fields we persist (drop runtime-only/derived columns like dom_context, scores, ids).
STEP_FIELDS = ["action_type", "intent", "selector_chain", "value", "methods", "success_condition", "checkpoint"]


def get(path):
    req = urllib.request.Request(BASE + path, headers={"X-API-Key": KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def normalize(wf):
    """Workflow GET response -> canonical spec dict (stable, diff-friendly)."""
    steps = []
    for s in sorted(wf.get("steps") or [], key=lambda x: x.get("step_index", 0)):
        step = {}
        for f in STEP_FIELDS:
            v = s.get(f)
            # Omit nulls AND falsy `checkpoint` (the common case) so specs stay clean —
            # only steps explicitly marked critical carry "checkpoint": true.
            if v is None or (f == "checkpoint" and not v):
                continue
            step[f] = v
        steps.append(step)
    return {
        "name": wf.get("name"),
        "description": wf.get("description"),
        "target_url": wf.get("target_url"),
        "steps": steps,
    }


def dumps(spec):
    return json.dumps(spec, ensure_ascii=False, indent=2) + "\n"


def main():
    only = None
    check = "--check" in sys.argv
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]

    registry = json.load(open(REGISTRY))
    drift = 0
    for entry in registry["workflows"]:
        wid = entry["workflow_id"]
        if only and not wid.startswith(only) and only != entry["spec"]:
            continue
        wf = get("/workflows/" + wid)
        spec = normalize(wf)
        path = os.path.join(WF_DIR, entry["spec"])
        new = dumps(spec)
        old = open(path).read() if os.path.exists(path) else None
        if old == new:
            print(f"  = {entry['spec']:<46} (in sync)")
            continue
        drift += 1
        if check:
            print(f"  ! {entry['spec']:<46} DIFFERS from DB")
        else:
            open(path, "w").write(new)
            print(f"  > {entry['spec']:<46} written ({len(spec['steps'])} steps)")

    if check and drift:
        sys.exit(f"{drift} spec(s) differ from the deployed DB — run without --check to sync")
    print("done" if not check else "all specs match the DB" if not drift else "")


if __name__ == "__main__":
    main()
