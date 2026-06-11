#!/usr/bin/env python3
"""DEMO Odoo side: reset a job's LinkedIn leads to ONLY Andrey.

Mirrors the LinkedIn-project reset (archive all + add Andrey) on the Odoo side so the
end-to-end demo can show the Odoo outreach-status update while messaging ONLY Andrey
(your own profile) — never real candidates.

Deletes every linkedin.lead for the job, then creates a single Andrey lead. On qaodoo
the deferred-removal unlink (akcr PR #1818) is not deployed, so unlink hard-deletes
directly (no archive callback) — exactly what the demo wants here.

Usage:
    python3 scripts/demo_odoo_reset_add_andrey.py [JOB_ID]
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

ANDREY = {
    "name": "Andrey Sanchez",
    # Use the /talent/hire/<project>/manage/all profile_url format (AEMAA…) so the
    # message-compose strategy's reported recipients match this lead for the Odoo
    # outreach-status update. (The public-profile bridge yields a different ACoAA… urn.)
    "profile_url": os.environ.get(
        "ANDREY_PROFILE_URL",
        "https://www.linkedin.com/talent/profile/AEMAACWxMLsB5kMmgFGox0pPupKEQfe9C-YJ3Sw",
    ),
    "headline": os.environ.get("ANDREY_HEADLINE", "Software Engineer @ Akurey"),
}


def main():
    common = xmlrpc.client.ServerProxy(f"{URL}/xmlrpc/2/common")
    uid = common.authenticate(DB, LOGIN, PASSWORD, {})
    if not uid:
        sys.exit("Odoo auth failed")
    models = xmlrpc.client.ServerProxy(f"{URL}/xmlrpc/2/object")

    def kw(model, method, args, kwargs=None):
        return models.execute_kw(DB, uid, PASSWORD, model, method, args, kwargs or {})

    existing = kw("linkedin.lead", "search", [[["job_id", "=", JOB_ID]]])
    if existing:
        kw("linkedin.lead", "unlink", [existing])
    print(f"deleted {len(existing)} existing lead(s) for job {JOB_ID}")

    # Avoid the (job_id, profile_url) unique-constraint if Andrey somehow lingered.
    dup = kw("linkedin.lead", "search",
             [[["job_id", "=", JOB_ID], ["profile_url", "=", ANDREY["profile_url"]]]])
    if dup:
        kw("linkedin.lead", "unlink", [dup])
    lead_id = kw("linkedin.lead", "create", [{
        "job_id": JOB_ID,
        "name": ANDREY["name"],
        "profile_url": ANDREY["profile_url"],
        "headline": ANDREY["headline"],
        "outreach_status": "new",
    }])
    total = kw("linkedin.lead", "search_count", [[["job_id", "=", JOB_ID]]])
    rows = kw("linkedin.lead", "read", [[lead_id]], {"fields": ["name", "outreach_status", "profile_url"]})
    print(f"created Andrey lead id={lead_id}; job {JOB_ID} now has {total} lead(s): {rows}")


if __name__ == "__main__":
    main()
