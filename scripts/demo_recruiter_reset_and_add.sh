#!/usr/bin/env bash
# DEMO flow (Claude-runnable): wipe a LinkedIn Recruiter project, then add one profile.
#
#   1) Archive ALL candidates in the project   (workflow 511ceaab, recruiter_archive_all_in_project)
#   2) Add a single (public /in/ or /talent/profile/) profile to the project (workflow a352e1e4, save-to-project-param)
#
# Both run on the LinkedIn operator's warm /talent seat (fernanda) via the daemon, with
# anti-bot always on. Verification is read back from each run's strategy result.
#
# Usage:
#   PROJECT_URL=... PROJECT_NAME="..." [PROFILE_URL=...] bash scripts/demo_recruiter_reset_and_add.sh
# Defaults target the -EZ Senior QA Automation Engineer demo project + /in/crandrey/.
set -uo pipefail  # NOT -e: transient empty curl responses must not abort the demo

BASE="${SR_BACKEND:-https://52-5-45-84.sslip.io}/v1"
KEY="${SR_API_KEY:-28e54ef83e040faa366260aa13af5f5b1947b364731e1f22}"
OPERATOR="${OPERATOR:-fernanda}"

PROJECT_URL="${PROJECT_URL:-https://www.linkedin.com/talent/hire/2057213706/discover/recruiterSearch}"
PROJECT_NAME="${PROJECT_NAME:--EZ Senior QA Automation Engineer}"
PROFILE_URL="${PROFILE_URL:-https://www.linkedin.com/in/crandrey/}"

ARCHIVE_ALL_WF="511ceaab-34c2-4d8b-9241-725a61e1cc32"
SAVE_WF="a352e1e4-4536-4746-bcd4-9a588275b6c5"

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
for e in evs:
    if e.get("event_type")=="extraction":
        for r in ((e.get("payload") or {}).get("data") or []):
            if isinstance(r,dict) and ("archive_all_result" in r or "save_result" in r or "archive_result" in r):
                print(json.dumps(r,indent=2,ensure_ascii=False))'
}

echo "==> 1/2 Archive ALL candidates in: $PROJECT_NAME"
RID1=$(run_wf "$ARCHIVE_ALL_WF" "{\"project_url\":\"$PROJECT_URL\"}")
wait_run "$RID1" "archive-all"

echo "==> 2/2 Add profile $PROFILE_URL to: $PROJECT_NAME"
RID2=$(run_wf "$SAVE_WF" "{\"candidate_url\":\"$PROFILE_URL\",\"project_name\":\"$PROJECT_NAME\"}")
wait_run "$RID2" "add-profile"

echo "==> DEMO done. Project: $PROJECT_URL"
