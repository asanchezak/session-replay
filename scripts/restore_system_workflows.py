#!/usr/bin/env python3
"""Restore the 15 LinkedIn Recruiter *system* workflows from the versioned backup.

The backup file recruiter-workflows/system-workflows-backup.json holds a FULL snapshot
(complete GET /v1/workflows/{id}, every step + all fields) of the workflows the LinkedIn
/talent automation runs. This script re-applies each one to a backend, in place, by id:

  * PUT /v1/workflows/{id}          -> name, description, target_url, config
  * PUT /v1/workflows/{id}/steps    -> full step list (action_type, intent, selector_chain,
                                       value, methods, success_condition, checkpoint)
  * POST /v1/workflows/{id}/promote -> workflow_type = system (idempotent)

It is idempotent and safe to re-run. It restores the *executable* definition faithfully
(generic workflows run purely off these step fields). It does NOT recreate a HARD-DELETED
workflow (the API mints a new random id on create) and cannot un-archive one (the state
machine forbids archived->active) — both of those need a DB-level restore from the backup.

Usage:
  python3 scripts/restore_system_workflows.py                 # DRY RUN against DEV (default)
  python3 scripts/restore_system_workflows.py --apply         # apply to DEV
  python3 scripts/restore_system_workflows.py --apply --only 1bc44128
  SR_BACKEND=https://54-211-23-18.sslip.io SR_API_KEY=<prodkey> \
      python3 scripts/restore_system_workflows.py --apply     # apply to PROD

Env: SR_BACKEND, SR_API_KEY (defaults = DEV, matching export/deploy scripts).
"""
import json
import os
import sys
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BACKUP = os.path.join(ROOT, "recruiter-workflows", "system-workflows-backup.json")

BASE = os.environ.get("SR_BACKEND", "https://52-5-45-84.sslip.io").rstrip("/") + "/v1"
KEY = os.environ.get("SR_API_KEY", "28e54ef83e040faa366260aa13af5f5b1947b364731e1f22")

STEP_FIELDS = ["action_type", "intent", "selector_chain", "value", "methods",
               "success_condition", "checkpoint"]


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"X-API-Key": KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def main():
    apply = "--apply" in sys.argv
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None

    backup = json.load(open(BACKUP))
    print(f"{'DRY RUN' if not apply else 'APPLY'} -> {BASE}  ({len(backup['workflows'])} workflows in backup)\n")

    for wf in backup["workflows"]:
        wid = wf["id"]
        if only and not wid.startswith(only):
            continue
        s, cur = call("GET", f"/workflows/{wid}")
        if s != 200:
            print(f"  {wid[:8]} | MISSING on target (hard-deleted?) — needs DB-level restore, skipping")
            continue

        steps = [{k: st[k] for k in STEP_FIELDS if st.get(k) is not None}
                 for st in sorted(wf.get("steps") or [], key=lambda x: x.get("step_index", 0))]
        actions = []

        if not apply:
            drift = []
            if cur.get("name") != wf.get("name"): drift.append("name")
            if cur.get("workflow_type") != wf.get("workflow_type"): drift.append("type")
            if len(cur.get("steps") or []) != len(steps): drift.append("step-count")
            if cur.get("status") != wf.get("status"): drift.append(f"status({cur.get('status')}!={wf.get('status')})")
            print(f"  {wid[:8]} | {'in sync' if not drift else 'DRIFT: ' + ', '.join(drift)} | {wf['name'][:42]}")
            continue

        # 1) metadata
        ms, _ = call("PUT", f"/workflows/{wid}", {
            "name": wf.get("name"), "description": wf.get("description"),
            "target_url": wf.get("target_url"), "config": wf.get("config"),
        })
        actions.append("meta" if ms == 200 else f"meta-ERR{ms}")
        # 2) steps
        ss, _ = call("PUT", f"/workflows/{wid}/steps", steps)
        actions.append(f"{len(steps)} steps" if ss == 200 else f"steps-ERR{ss}")
        # 3) type = system
        if cur.get("workflow_type") != "system":
            ps, _ = call("POST", f"/workflows/{wid}/promote")
            actions.append("promoted" if ps == 200 else f"promote-ERR{ps}")
        # 4) status (best effort; archived->active is blocked by the state machine)
        if cur.get("status") != wf.get("status"):
            xs, xr = call("PUT", f"/workflows/{wid}/status", {"status": wf.get("status")})
            actions.append(f"status={wf.get('status')}" if xs == 200
                           else f"status-ERR{xs}(fix in DB)")
        print(f"  {wid[:8]} | {', '.join(actions)} | {wf['name'][:40]}")

    print("\nDONE" + ("" if apply else "  (dry run — re-run with --apply to write)"))


if __name__ == "__main__":
    main()
