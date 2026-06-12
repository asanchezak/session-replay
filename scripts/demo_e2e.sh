#!/usr/bin/env bash
# ============================================================================
# LinkedIn Recruiter DEMO — end-to-end, one shot.
# Trigger phrase: "corre el test de linkedin para el demo" → run this script.
#
# DEFAULT = SAFE (no real InMail, no archive):
#   0. Pre-flight: warm /talent seat (Open Talent Home on fernanda).
#   1. Reset the demo project + Odoo job to ONLY Andrey:
#        - archive ALL candidates in the LinkedIn project   (wf 511ceaab)
#        - add Andrey to the LinkedIn project (/in/ bridge)  (wf f003f090)
#        - reset the Odoo job's linkedin.lead rows to Andrey (XML-RPC script)
#   2. Verify: LinkedIn project active count == 1 (wf b5e3d433).
#   3. PREVIEW the templated message (compose + STOP, no send) — prints the
#      recipient + the snapshot to pull.  (wf c46c296f via /send-messages)
#
# OPT-IN flags (env):
#   SEND=1      also send the REAL InMail to Andrey + verify Odoo
#              outreach_status=messaged.  ⚠️ sends a real message (to you).
#   ARCHIVE=1   archive the whole project at the end (wf 752753a9, testing).
#   SKIP_RESET=1  operate on the current project state (no reset).
#
# Overridable env: JOB_ID, PROJECT_URL, PROJECT_NAME, PROFILE_URL, MSG_SUBJECT,
#                  MSG_BODY, SR_BACKEND, SR_API_KEY, OPERATOR.
# Defaults target qaodoo job 323 / project 2057213706 / /in/crandrey/.
#
# NOTE: the Odoo-side template field + "Mandar mensaje" wizard need the qaodoo
# `-u akcr` upgrade (PR #1818, merged to the qaodoo branch — operator runs Jenkins).
# This script drives the LinkedIn + backend side directly, so the demo works
# regardless; MSG_BODY here stands in for the Odoo template until that upgrade.
# ============================================================================
set -uo pipefail  # NOT -e: a transient empty curl must not abort the demo
HERE="$(cd "$(dirname "$0")" && pwd)"

BASE="${SR_BACKEND:-https://52-5-45-84.sslip.io}/v1"
KEY="${SR_API_KEY:-28e54ef83e040faa366260aa13af5f5b1947b364731e1f22}"
OPERATOR="${OPERATOR:-fernanda}"
HOST="${BOT_HOST:-linkedin-bot@100.107.206.110}"

JOB_ID="${JOB_ID:-323}"
PROJECT_URL="${PROJECT_URL:-https://www.linkedin.com/talent/hire/2057213706/discover/recruiterSearch}"
PROJECT_NAME="${PROJECT_NAME:--EZ Senior QA Automation Engineer}"
PROFILE_URL="${PROFILE_URL:-https://www.linkedin.com/in/crandrey/}"
MSG_SUBJECT="${MSG_SUBJECT:-Oportunidad en Akurey}"
MSG_BODY="${MSG_BODY:-Hola {Nombre}, en Akurey tenemos abierta la posición de Senior QA Automation Engineer y tu perfil nos llamó la atención. ¿Te interesaría que conversemos? Saludos.}"

PREFLIGHT_WF="7246989f-a6ce-4b8a-b7f4-16a49d930cae"
ARCHIVE_ALL_WF="511ceaab-34c2-4d8b-9241-725a61e1cc32"
ADD_WF="f003f090-d74a-41bc-90a9-67f5fd603a5d"
READ_WF="b5e3d433-fa33-4795-881a-40d3125c773f"
ARCHIVE_PROJ_WF="752753a9-17b5-4e36-afcb-82bae204726e"

SEND="${SEND:-0}"; ARCHIVE="${ARCHIVE:-0}"; SKIP_RESET="${SKIP_RESET:-0}"

jqpy() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

run_wf() {  # $1=wf  $2=runtime_params_json  -> echoes run id
  curl -s -X POST "$BASE/workflows/$1/run-with-params" -H "X-API-Key: $KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"execution_target\":\"daemon\",\"operator_id\":\"$OPERATOR\",\"execution_options\":{\"use_profile\":true,\"snapshot\":true},\"runtime_params\":$2}" \
    | jqpy 'd["id"]'
}

wait_run() {  # $1=run id  $2=label  -> waits to terminal, prints status
  local rid="$1" label="$2" st=""
  for _ in $(seq 1 60); do
    st=$(curl -s "$BASE/runs/$rid" -H "X-API-Key: $KEY" | jqpy 'd.get("status")')
    [ -n "$st" ] && echo "   [$label] $rid -> $st"
    case "$st" in completed|failed|canceled|waiting_for_user) return 0;; esac
    sleep 12
  done
}

result() {  # $1=run id  $2=extraction key -> pretty-prints that result object
  curl -s "$BASE/runs/$1/events?limit=80" -H "X-API-Key: $KEY" | python3 -c "
import sys,json
d=json.load(sys.stdin); evs=d if isinstance(d,list) else (d.get('events') or [])
for e in evs:
    if e.get('event_type')=='extraction':
        for r in ((e.get('payload') or {}).get('data') or []):
            if isinstance(r,dict) and '$2' in r: print(json.dumps(r['$2'],indent=2,ensure_ascii=False))" 2>/dev/null
}

echo "=================================================================="
echo " LinkedIn Recruiter DEMO E2E   (SEND=$SEND ARCHIVE=$ARCHIVE SKIP_RESET=$SKIP_RESET)"
echo " Project: $PROJECT_NAME   Job: $JOB_ID   Profile: $PROFILE_URL"
echo "=================================================================="

echo "==> 0/4 Pre-flight: warm /talent seat"
RID=$(run_wf "$PREFLIGHT_WF" "{}"); wait_run "$RID" "preflight"

if [ "$SKIP_RESET" != "1" ]; then
  echo "==> 1/4 Reset LinkedIn project to only Andrey"
  RID=$(run_wf "$ARCHIVE_ALL_WF" "{\"project_url\":\"$PROJECT_URL\"}"); wait_run "$RID" "archive-all"; result "$RID" archive_all_result
  RID=$(run_wf "$ADD_WF" "{\"candidate_url\":\"$PROFILE_URL\",\"project_name\":\"$PROJECT_NAME\",\"project_url\":\"$PROJECT_URL\"}"); wait_run "$RID" "add-andrey"; result "$RID" add_profile_result
  echo "   Reset Odoo job $JOB_ID leads to only Andrey:"
  python3 "$HERE/demo_odoo_reset_add_andrey.py" "$JOB_ID" 2>&1 | sed 's/^/     /' || echo "     (Odoo reset failed — check creds)"
else
  echo "==> 1/4 (skipped reset)"
fi

echo "==> 2/4 Verify LinkedIn project counts"
RID=$(run_wf "$READ_WF" "{\"project_url\":\"$PROJECT_URL\"}"); wait_run "$RID" "verify"; result "$RID" project_read

echo "==> 3/4 Templated message (send=$([ "$SEND" = 1 ] && echo true || echo false))"
RID=$(curl -s -X POST "$BASE/recruiter/jobs/$JOB_ID/send-messages" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "$(python3 -c "import json,os;print(json.dumps({'subject':os.environ['MSG_SUBJECT'],'body':os.environ['MSG_BODY'],'send':os.environ['SEND']=='1'}))")" | jqpy 'd.get("run_id")')
if [ -n "$RID" ]; then
  wait_run "$RID" "message"; result "$RID" message_compose_result
  echo "   Snapshot (recipient + composed message):"
  echo "     scp $HOST:'C:/Users/Public/extension/recruiter-snapshots/$RID/step-2-extract.png' /tmp/"
  if [ "$SEND" = "1" ]; then
    sleep 5
    echo "   Andrey outreach_status in Odoo:"
    python3 "$HERE/demo_odoo_check_andrey.py" "$JOB_ID" 2>&1 | sed 's/^/     /' || true
  fi
else
  echo "   (send-messages skipped — no project/lead for job $JOB_ID)"
fi

if [ "$ARCHIVE" = "1" ]; then
  echo "==> 4/4 Archive the project (testing)"
  RID=$(run_wf "$ARCHIVE_PROJ_WF" "{\"project_url\":\"$PROJECT_URL\",\"project_name\":\"$PROJECT_NAME\"}"); wait_run "$RID" "archive-project"; result "$RID" archive_project_result
else
  echo "==> 4/4 (archive-project skipped — set ARCHIVE=1 to archive)"
fi

echo "=================================================================="
echo " DEMO done. Project: $PROJECT_URL"
echo "=================================================================="
