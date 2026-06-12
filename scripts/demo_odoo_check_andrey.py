#!/usr/bin/env python3
"""Print the job's linkedin.lead rows (name + outreach_status + message_count) — used by
the demo E2E to show Andrey's status flip to 'messaged' after a real send.

Usage: python3 scripts/demo_odoo_check_andrey.py [JOB_ID]
Env: ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD (defaults = qaodoo).
"""
import os
import sys
import xmlrpc.client

URL = os.environ.get("ODOO_URL", "https://qaodoo.akurey.com")
DB = os.environ.get("ODOO_DB", "qaodoo")
LOGIN = os.environ.get("ODOO_LOGIN", "support@akurey.com")
PASSWORD = os.environ.get("ODOO_PASSWORD", "Akurey1234*")
JOB_ID = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("JOB_ID", "323"))

common = xmlrpc.client.ServerProxy(f"{URL}/xmlrpc/2/common")
uid = common.authenticate(DB, LOGIN, PASSWORD, {})
if not uid:
    sys.exit("Odoo auth failed")
models = xmlrpc.client.ServerProxy(f"{URL}/xmlrpc/2/object")
ids = models.execute_kw(DB, uid, PASSWORD, "linkedin.lead", "search", [[["job_id", "=", JOB_ID]]])
rows = models.execute_kw(DB, uid, PASSWORD, "linkedin.lead", "read", [ids],
                         {"fields": ["name", "outreach_status", "message_count", "last_message_date"]})
for r in rows:
    print(f"{r['name']}: outreach_status={r['outreach_status']} "
          f"messages={r['message_count']} last={r.get('last_message_date')}")
if not rows:
    print(f"(no linkedin.lead rows for job {JOB_ID})")
