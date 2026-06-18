#!/usr/bin/env python3
"""Generate a LinkedIn Recruiter BOOLEAN search from Odoo job positions.

For each position id: fetch its JD corpus (name + description + ak.job.requirement)
from the Odoo Postgres DB, run the AI BooleanQueryBuilder (the hybrid: AI extracts a
structured spec from the JD, our code assembles the boolean + a tightness knob), and
emit {position_id, title, tightness, boolean_query, spec}. Optionally write a manifest
so the per-position booleans are kept "in place" (versioned + reviewable + ready to run).

This is the offline generator (AI calls only — NO LinkedIn search, no anti-bot cost).
The live pipeline (recruiter_pipeline_service) does the same at runtime for qaodoo.

Run it so the backend config loads its .env (AI key):
    cd backend && python3 ../scripts/boolean_from_odoo.py 231 203 205 \
        --tightness 3 --out ../recruiter-workflows/odoo-position-booleans.json

Env (defaults = local morsoft): ODOO_DB, ODOO_PGUSER, ODOO_PGPASS, ODOO_PGHOST.
"""
import argparse
import asyncio
import html
import json
import os
import re
import subprocess
import sys

# backend/ must be importable for `services` + `ai`; run with cwd=backend so config
# loads backend/.env (the AI key). We also insert it explicitly for safety.
_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
sys.path.insert(0, _BACKEND)

from services.boolean_query_builder import BooleanQueryBuilder  # noqa: E402

DB = os.environ.get("ODOO_DB", "morsoft")
PGUSER = os.environ.get("ODOO_PGUSER", "odoo")
PGPASS = os.environ.get("ODOO_PGPASS", "odoopwd")
PGHOST = os.environ.get("ODOO_PGHOST", "localhost")


def _psql(query: str) -> str:
    env = {**os.environ, "PGPASSWORD": PGPASS}
    r = subprocess.run(
        ["psql", "-h", PGHOST, "-U", PGUSER, "-d", DB, "-t", "-A", "-c", query],
        capture_output=True, text=True, env=env,
    )
    return r.stdout


def _clean(s: str) -> str:
    s = (s or "").strip()
    if s.startswith("{"):  # Odoo jsonb-translated field -> take en_US
        try:
            s = json.loads(s).get("en_US", s)
        except Exception:
            pass
    s = re.sub(r"<[^>]+>", " ", s)        # strip HTML
    s = html.unescape(s)
    return re.sub(r"[ \t]+", " ", s).strip()


def corpus_for(pid: int):
    name = _clean(_psql(f"SELECT name::text FROM hr_job WHERE id={pid};"))
    desc = _clean(_psql(f"SELECT description::text FROM hr_job WHERE id={pid};"))
    reqs = _psql(
        "SELECT coalesce(string_agg('- ' || r.name::text, E'\\n'), '') "
        f"FROM ak_job_requirement r WHERE r.job_id={pid};"
    ).strip()
    if not name:
        return None, None
    return name, f"{name}\n\nDescription:\n{desc}\n\nRequirements:\n{reqs}"


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="+", type=int, help="Odoo hr.job ids")
    ap.add_argument("--tightness", type=int, default=3, help="# of skills AND'd (start point)")
    ap.add_argument("--out", help="write a JSON manifest of the generated booleans")
    a = ap.parse_args()

    b = BooleanQueryBuilder()
    manifest = []
    for pid in a.ids:
        title, corpus = corpus_for(pid)
        if not corpus:
            print(f"[{pid}] not found / empty", file=sys.stderr)
            continue
        spec = await b.extract_spec(corpus, title)
        t = max(0, min(a.tightness, b.max_tightness(spec)))
        entry = {
            "position_id": pid,
            "title": title,
            "tightness": t,
            "max_tightness": b.max_tightness(spec),
            "boolean_query": b.assemble(spec, t),
            "location": spec.get("location"),
            "years_min": spec.get("years_min"),
            "seniority": spec.get("seniority"),
            "spec": spec,
        }
        manifest.append(entry)
        print(json.dumps(
            {k: entry[k] for k in ("position_id", "title", "tightness", "boolean_query", "location")},
            ensure_ascii=False,
        ))

    if a.out:
        out = a.out if os.path.isabs(a.out) else os.path.abspath(a.out)
        with open(out, "w") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        print(f"wrote {len(manifest)} booleans -> {out}", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
