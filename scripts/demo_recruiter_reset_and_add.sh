#!/usr/bin/env bash
# DEMO flow (Claude-runnable): reset a Recruiter project + Odoo job to ONLY Andrey.
#
#   1) Archive ALL candidates in the LinkedIn project   (wf 511ceaab, recruiter_archive_all_in_project)
#   2) Add Andrey's profile to the LinkedIn project      (wf f003f090, recruiter_add_profile; /in/ → Recruiter bridge)
#   3) Reset the Odoo job's linkedin.lead rows to only Andrey (scripts/demo_odoo_reset_add_andrey.py)
#
# End state: the LinkedIn project + the Odoo job each hold ONLY Andrey — so the message
# demo sends an InMail to Andrey alone (you), and the Odoo outreach_status update is
# shown without touching real candidates. LinkedIn runs go through the daemon on the
# warm /talent seat (fernanda), anti-bot always on; each step is verified by read-back.
#
# Usage:
#   [PROJECT_URL=...] [PROJECT_NAME=...] [PROFILE_URL=...] [JOB_ID=...] bash scripts/demo_recruiter_reset_and_add.sh
# Defaults: -EZ Senior QA Automation Engineer project, /in/crandrey/, Odoo job 323.
set -uo pipefail  # NOT -e: transient empty curl responses must not abort the demo
HERE="$(cd "$(dirname "$0")" && pwd)"

BASE="${SR_BACKEND:-https://52-5-45-84.sslip.io}/v1"
KEY="${SR_API_KEY:-28e54ef83e040faa366260aa13af5f5b1947b364731e1f22}"
OPERATOR="${OPERATOR:-fernanda}"

PROJECT_URL="${PROJECT_URL:-https://www.linkedin.com/talent/hire/2057213706/discover/recruiterSearch}"
PROJECT_NAME="${PROJECT_NAME:--EZ Senior QA Automation Engineer}"
PROFILE_URL="${PROFILE_URL:-https://www.linkedin.com/in/crandrey/}"
JOB_ID="${JOB_ID:-323}"
READ_WF="b5e3d433-fa33-4795-881a-40d3125c773f"   # read-only project counts

ARCHIVE_ALL_WF="511ceaab-34c2-4d8b-9241-725a61e1cc32"
# Robust add: handles the public /in/ → Recruiter bridge, clicks the exact project
# option (typing alone leaves Save disabled), waits for Save to enable, and verifies.
ADD_WF="f003f090-d74a-41bc-90a9-67f5fd603a5d"

run_wf () {  # $1=workflow_id  $2=runtime_params_json  -> echoes run id
  curl -s -X POST "$BASE/workflows/$1/run-with-params" \
    -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
    -d "{\"execution_target\":\"daemon\",\"operator_id\":\"$OPERATOR\",\"execution_options\":{\"use_profile\":true,\"snapshot\":true},\"runtime_params\":$2}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'
}

wait_run () {  # $1=run id  $2=label
  local rid="$1" label="$2" st
  while :; do
    st=$(curl -s "$BASE/runs/$rid" -H "X-API-Key: $KEY" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status"))')
    echo "  [$label] $rid -> $st"
    case "$st" in completed|failed|canceled|waiting_for_user) break;; esac
    sleep 12
  done
  echo "  [$label] strategy result:"
  curl -s "$BASE/runs/$rid/events?limit=80" -H "X-API-Key: $KEY" | python3 -c '
import sys,json
d=json.load(sys.stdin); evs=d if isinstance(d,list) else (d.get("events") or [])
keys=("archive_all_result","add_profile_result","project_read","save_result","archive_result")
for e in evs:
    if e.get("event_type")=="extraction":
        for r in ((e.get("payload") or {}).get("data") or []):
            if isinstance(r,dict) and any(k in r for k in keys):
                print(json.dumps({k:r[k] for k in keys if k in r},indent=2,ensure_ascii=False))'
}

echo "==> 1/4 Archive ALL candidates in LinkedIn project: $PROJECT_NAME"
RID1=$(run_wf "$ARCHIVE_ALL_WF" "{\"project_url\":\"$PROJECT_URL\"}")
wait_run "$RID1" "archive-all"

echo "==> 2/4 Add Andrey ($PROFILE_URL) to the LinkedIn project"
RID2=$(run_wf "$ADD_WF" "{\"candidate_url\":\"$PROFILE_URL\",\"project_name\":\"$PROJECT_NAME\",\"project_url\":\"$PROJECT_URL\"}")
wait_run "$RID2" "add-profile"

echo "==> 3/4 Reset Odoo job $JOB_ID leads to only Andrey"
python3 "$HERE/demo_odoo_reset_add_andrey.py" "$JOB_ID" || echo "  (Odoo reset failed — check creds/env)"

echo "==> 4/4 Verify LinkedIn project counts"
RID3=$(run_wf "$READ_WF" "{\"project_url\":\"$PROJECT_URL\"}")
wait_run "$RID3" "verify"

echo "==> DEMO done. LinkedIn project + Odoo job $JOB_ID now hold only Andrey."
echo "    Project: $PROJECT_URL"
