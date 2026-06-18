#!/usr/bin/env python3
"""Teardown / housekeeping for the Recruiter demo+pipeline test data.

Two jobs (run independently):

  --free-slot         Disable linkedin_sync on the OLDEST test hr.job so a new synced
                      position can be created. akcr caps LinkedIn sync at 4 jobs; this
                      frees one while protecting the real jobs (KEEP_JOB_IDS, default
                      304,307). Pure Odoo XML-RPC.

  --archive-projects  Archive leftover "-EZ " test PROJECTS in LinkedIn Recruiter via the
                      archive-project workflow (752753a9) on the daemon. Pass project ids
                      with --project-ids 2058...,2058... (there is no list-projects
                      workflow, so ids are explicit). ⚠️ touches the sensitive account.

NOTE: the akcr 4-job sync cap itself is an Odoo (qaodoo) limit — out of this repo. This is
only the operational workaround. Env: ODOO_* (defaults qaodoo), SR_BACKEND, SR_API_KEY,
OPERATOR(fernanda), KEEP_JOB_IDS.

Usage:
  python3 scripts/recruiter_cleanup.py --free-slot
  python3 scripts/recruiter_cleanup.py --archive-projects --project-ids 2058483586,2058576386
"""
import argparse
import json
import os
import time
import urllib.request
import xmlrpc.client

ODOO_URL = os.environ.get("ODOO_URL", "https://qaodoo.akurey.com")
ODOO_DB = os.environ.get("ODOO_DB", "qaodoo")
ODOO_LOGIN = os.environ.get("ODOO_LOGIN", "support@akurey.com")
ODOO_PW = os.environ.get("ODOO_PASSWORD", "Akurey1234*")
KEEP = {s.strip() for s in os.environ.get("KEEP_JOB_IDS", "304,307").split(",") if s.strip()}

BASE = os.environ.get("SR_BACKEND", "https://52-5-45-84.sslip.io").rstrip("/") + "/v1"
KEY = os.environ.get("SR_API_KEY", "28e54ef83e040faa366260aa13af5f5b1947b364731e1f22")
OPERATOR = os.environ.get("OPERATOR", "fernanda")
ARCHIVE_PROJECT_WF = "752753a9-17b5-4e36-afcb-82bae204726e"


def _odoo():
    uid = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common").authenticate(ODOO_DB, ODOO_LOGIN, ODOO_PW, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    return uid, models


def free_slot():
    uid, models = _odoo()

    def kw(model, method, args, kwargs=None):
        return models.execute_kw(ODOO_DB, uid, ODOO_PW, model, method, args, kwargs or {})

    synced = kw("hr.job", "search_read", [[["linkedin_sync", "=", True]]],
                {"fields": ["id", "name"], "order": "id asc"})
    print("synced jobs:", [(j["id"], j["name"]) for j in synced])
    candidates = [j for j in synced if str(j["id"]) not in KEEP]
    if len(synced) < 4:
        print(f"{len(synced)} synced (< 4) — a slot is already free; nothing to do.")
        return
    if not candidates:
        print("no non-protected synced job to disable (only KEEP_JOB_IDS are synced).")
        return
    victim = candidates[0]  # oldest non-protected
    kw("hr.job", "write", [[victim["id"]], {"linkedin_sync": False}])
    print(f"disabled linkedin_sync on job {victim['id']} ({victim['name']}) → slot freed")


def _run_wf(project_id):
    purl = f"https://www.linkedin.com/talent/hire/{project_id}/discover/recruiterSearch"
    body = {"execution_target": "daemon", "operator_id": OPERATOR,
            "execution_options": {"use_profile": True, "snapshot": False},
            "runtime_params": {"project_url": purl, "project_name": ""}}
    req = urllib.request.Request(f"{BASE}/workflows/{ARCHIVE_PROJECT_WF}/run-with-params",
                                 data=json.dumps(body).encode(), method="POST",
                                 headers={"X-API-Key": KEY, "Content-Type": "application/json"})
    rid = json.load(urllib.request.urlopen(req, timeout=30))["id"]
    print(f"  archive-project run {rid} for project {project_id} …")
    deadline = time.time() + 300
    while time.time() < deadline:
        st = json.load(urllib.request.urlopen(urllib.request.Request(
            f"{BASE}/runs/{rid}", headers={"X-API-Key": KEY}), timeout=20)).get("status")
        if st in ("completed", "failed", "canceled", "waiting_for_user"):
            print(f"    -> {st}")
            return
        time.sleep(12)


def archive_projects(ids):
    for pid in ids:
        _run_wf(pid.strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--free-slot", action="store_true")
    ap.add_argument("--archive-projects", action="store_true")
    ap.add_argument("--project-ids", default="")
    a = ap.parse_args()
    if a.free_slot:
        free_slot()
    if a.archive_projects:
        ids = [x for x in a.project_ids.split(",") if x.strip()]
        if not ids:
            raise SystemExit("--archive-projects needs --project-ids 2058...,2058...")
        archive_projects(ids)
    if not (a.free_slot or a.archive_projects):
        ap.print_help()


if __name__ == "__main__":
    main()
