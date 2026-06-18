#!/usr/bin/env python3
"""LinkedIn Recruiter DEMO — end-to-end orchestrator (Python; replaces demo_e2e.sh).

Trigger phrase: "corre el test de linkedin para el demo".

Why Python: the old bash version had shell-fragility bugs (brace-expansion of the JSON
payload, unexported env vars) and could not loop archive-all (the 175s/step budget
archives ~15 at a time, so a project with >15 active needed manual re-runs). This driver
asserts each stage, LOOPS archive-all until the project is empty, and only messages when
exactly Andrey is active.

DEFAULT = SAFE (no real InMail, no archive):
  0. preflight: warm the /talent seat (wf 7246989f)
  1. reset to ONLY Andrey: archive-all in a LOOP until active==0 (wf 511ceaab,
     uses the strategy's `more_remaining` flag), add Andrey (wf f003f090), reset the
     Odoo job's linkedin.lead rows to Andrey (demo_odoo_reset_add_andrey.py — hard-delete
     via the akcr_removal_confirmed bypass).
  2. verify: project active==1 (wf b5e3d433).
  3. PREVIEW the templated message (compose + STOP, no send) via /send-messages.

OPT-IN flags (env):
  SEND=1        also send the REAL InMail (only fires if active==1) + verify Odoo
                outreach_status=messaged. ⚠️ real message.
  ARCHIVE=1     archive the whole project at the end (wf 752753a9).
  SKIP_RESET=1  operate on the current project state (no reset).

Overridable env: JOB_ID, PROJECT_URL, PROJECT_NAME, PROFILE_URL, MSG_SUBJECT, MSG_BODY,
                 SR_BACKEND, SR_API_KEY, OPERATOR, ARCHIVE_ROUNDS (default 5).
Defaults target qaodoo job 323 / project 2057213706 / /in/crandrey/.
⚠️ NOTE: job 323's LinkedIn project is ARCHIVED — add-Andrey can't target an archived
project. For a real run, point at an ACTIVE project (a fresh -EZ pipeline project).
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("SR_BACKEND", "https://52-5-45-84.sslip.io").rstrip("/") + "/v1"
KEY = os.environ.get("SR_API_KEY", "28e54ef83e040faa366260aa13af5f5b1947b364731e1f22")
OPERATOR = os.environ.get("OPERATOR", "fernanda")

JOB_ID = os.environ.get("JOB_ID", "323")
PROJECT_URL = os.environ.get("PROJECT_URL", "https://www.linkedin.com/talent/hire/2057213706/manage/all")
PROJECT_NAME = os.environ.get("PROJECT_NAME", "-EZ Senior QA Automation Engineer")
PROFILE_URL = os.environ.get("PROFILE_URL", "https://www.linkedin.com/in/crandrey/")
MSG_SUBJECT = os.environ.get("MSG_SUBJECT", "Oportunidad en Akurey")
MSG_BODY = os.environ.get(
    "MSG_BODY",
    "Hola {Nombre}, en Akurey tenemos una posición abierta y tu perfil nos llamó la "
    "atención. ¿Te interesaría conversar? Saludos.",
)
SEND = os.environ.get("SEND", "0") == "1"
ARCHIVE = os.environ.get("ARCHIVE", "0") == "1"
SKIP_RESET = os.environ.get("SKIP_RESET", "0") == "1"
ARCHIVE_ROUNDS = int(os.environ.get("ARCHIVE_ROUNDS", "5"))

WF = {  # from recruiter-workflows/registry.json
    "preflight": "7246989f-a6ce-4b8a-b7f4-16a49d930cae",
    "archive_all": "511ceaab-34c2-4d8b-9241-725a61e1cc32",
    "add": "f003f090-d74a-41bc-90a9-67f5fd603a5d",
    "read": "b5e3d433-fa33-4795-881a-40d3125c773f",
    "archive_project": "752753a9-17b5-4e36-afcb-82bae204726e",
}


def _req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"X-API-Key": KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def run_wf(wf, params, snapshot=False):
    body = {"execution_target": "daemon", "operator_id": OPERATOR,
            "execution_options": {"use_profile": True, "snapshot": snapshot},
            "runtime_params": params}
    return _req("POST", f"/workflows/{wf}/run-with-params", body)["id"]


def wait_run(run_id, label, timeout_s=720):
    deadline = time.time() + timeout_s
    st = ""
    while time.time() < deadline:
        try:
            st = _req("GET", f"/runs/{run_id}").get("status", "")
        except urllib.error.URLError:
            time.sleep(8); continue
        if st in ("completed", "failed", "canceled", "waiting_for_user"):
            break
        time.sleep(12)
    print(f"   [{label}] {run_id} -> {st}")
    return st


def result(run_id, key):
    try:
        d = _req("GET", f"/runs/{run_id}/events?limit=100")
    except urllib.error.URLError:
        return None
    evs = d if isinstance(d, list) else (d.get("events") or [])
    for e in evs:
        if e.get("event_type") == "extraction":
            for r in ((e.get("payload") or {}).get("data") or []):
                if isinstance(r, dict) and key in r:
                    return r[key]
    return None


def read_active():
    rid = run_wf(WF["read"], {"project_url": PROJECT_URL})
    wait_run(rid, "read-counts")
    pr = result(rid, "project_read") or {}
    return pr.get("active"), pr.get("archived")


def main():
    print("=" * 66)
    print(f" LinkedIn Recruiter DEMO E2E (py)  SEND={int(SEND)} ARCHIVE={int(ARCHIVE)} SKIP_RESET={int(SKIP_RESET)}")
    print(f" Project: {PROJECT_NAME}  Job: {JOB_ID}  Profile: {PROFILE_URL}")
    print("=" * 66)

    print("==> 0 Pre-flight: warm /talent seat")
    wait_run(run_wf(WF["preflight"], {}), "preflight")

    if not SKIP_RESET:
        print("==> 1 Reset project to ONLY Andrey")
        # 1a. archive-all in a LOOP until the project is empty (budget archives ~15/run).
        for rnd in range(1, ARCHIVE_ROUNDS + 1):
            rid = run_wf(WF["archive_all"], {"project_url": PROJECT_URL})
            wait_run(rid, f"archive-all r{rnd}")
            r = result(rid, "archive_all_result") or {}
            print(f"      archived_count={r.get('archived_count')} active_after={r.get('active_after')} more_remaining={r.get('more_remaining')}")
            if not r.get("more_remaining"):
                break
        # 1b. add Andrey (ACTIVE project required).
        rid = run_wf(WF["add"], {"candidate_url": PROFILE_URL, "project_name": PROJECT_NAME,
                                 "project_url": PROJECT_URL}, snapshot=True)
        wait_run(rid, "add-andrey")
        add = result(rid, "add_profile_result") or {}
        if not add.get("ok"):
            print(f"   ✗ add-Andrey FAILED: {add.get('reason')} (options_seen={add.get('options_seen')})")
            if add.get("reason") == "project_archived_or_inactive":
                print("     → the project is ARCHIVED/inactive; point PROJECT_URL/PROJECT_NAME at an ACTIVE project.")
            sys.exit(1)
        # 1c. reset Odoo leads to Andrey (hard-delete via bypass context).
        print("   Reset Odoo job leads to only Andrey:")
        subprocess.run([sys.executable, os.path.join(HERE, "demo_odoo_reset_add_andrey.py"), JOB_ID],
                       check=False)

    print("==> 2 Verify project counts")
    active, archived = read_active()
    print(f"   active={active} archived={archived}")

    print(f"==> 3 Templated message (send={SEND})")
    if SEND and active != 1:
        print(f"   ✗ REFUSING to send: active={active} (must be exactly 1 = only Andrey). Aborting send.")
        sys.exit(2)
    payload = {"subject": MSG_SUBJECT, "body": MSG_BODY, "send": SEND}
    try:
        rid = _req("POST", f"/recruiter/jobs/{JOB_ID}/send-messages", payload).get("run_id")
    except urllib.error.HTTPError as e:
        print(f"   send-messages error: {e}")
        rid = None
    if rid:
        wait_run(rid, "message")
        print("   message_compose_result:", json.dumps(result(rid, "message_compose_result")))
        if SEND:
            time.sleep(5)
            subprocess.run([sys.executable, os.path.join(HERE, "demo_odoo_check_andrey.py"), JOB_ID],
                           check=False)
    else:
        print("   (send-messages skipped — no project/lead for this job)")

    if ARCHIVE:
        print("==> 4 Archive the project (testing)")
        rid = run_wf(WF["archive_project"], {"project_url": PROJECT_URL, "project_name": PROJECT_NAME})
        wait_run(rid, "archive-project")
        print("   archive_project_result:", json.dumps(result(rid, "archive_project_result")))
    else:
        print("==> 4 (archive-project skipped — set ARCHIVE=1)")

    print("=" * 66)
    print(f" DEMO done. Project: {PROJECT_URL}")
    print("=" * 66)


if __name__ == "__main__":
    main()
