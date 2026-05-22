#!/bin/bash
#
# Verify the trusted-click LinkedIn replay path WITHOUT Playwright.
# Playwright owns the CDP master and prevents chrome.debugger.attach in the
# extension. This script launches Chrome directly with the extension and the
# saved LinkedIn profile, then uses the dashboard's autorun query param to
# kick off the workflow. Polls the backend until the run terminates.
#
# Usage: ./verify_trusted_click.sh <workflow-id>
set -e
WORKFLOW_ID="${1:-8b75b13f-a88c-4883-a4b6-add38a7a21ef}"
API_KEY="${E2E_API_KEY:-dev-api-key-change-in-production}"
BACKEND="http://localhost:8081"
FRONTEND="http://localhost:5173"
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
EXT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PROFILE="$EXT_ROOT/.linkedin-profile"
TEMP_PROFILE="$(mktemp -d -t sr-verify-XXXXX)"

cleanup() {
  if [[ -n "$CHROME_PID" ]]; then
    kill "$CHROME_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$CHROME_PID" 2>/dev/null || true
  fi
  rm -rf "$TEMP_PROFILE"
}
trap cleanup EXIT

# Activate workflow (Run requires active status)
echo "[setup] Activating workflow $WORKFLOW_ID"
curl -s -X PUT "$BACKEND/v1/workflows/$WORKFLOW_ID/status" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"status":"active"}' > /dev/null

# Copy profile so we don't conflict with user's Chrome / Playwright
echo "[setup] Copying LinkedIn profile to $TEMP_PROFILE"
cp -R "$SOURCE_PROFILE/." "$TEMP_PROFILE/"

# Snapshot the latest run id before launch so we can find the new one
PREV_RUN=$(curl -s "$BACKEND/v1/runs?workflow_id=$WORKFLOW_ID&limit=1" \
  -H "X-API-Key: $API_KEY" | python3 -c "import sys,json;r=json.load(sys.stdin);print(r[0]['id'] if r else '')")
echo "[setup] Previous run id: $PREV_RUN"

# Launch Chrome — autorun the dashboard so workflow fires on its own
URL="$FRONTEND/workflows/$WORKFLOW_ID?sr_autorun=$WORKFLOW_ID"
echo "[launch] $CHROME_BIN"
echo "[launch] profile=$TEMP_PROFILE ext=$EXT_ROOT/dist url=$URL"
"$CHROME_BIN" \
  --user-data-dir="$TEMP_PROFILE" \
  --load-extension="$EXT_ROOT/dist" \
  --disable-extensions-except="$EXT_ROOT/dist" \
  --no-first-run \
  --no-default-browser-check \
  --disable-default-apps \
  --new-window \
  "$URL" > /tmp/sr-verify-chrome.log 2>&1 &
CHROME_PID=$!
echo "[launch] Chrome PID: $CHROME_PID"

# Poll for new run
echo "[poll] Watching for new run..."
NEW_RUN=""
for i in $(seq 1 30); do
  sleep 2
  LATEST=$(curl -s "$BACKEND/v1/runs?workflow_id=$WORKFLOW_ID&limit=1" \
    -H "X-API-Key: $API_KEY" | python3 -c "import sys,json;r=json.load(sys.stdin);print(r[0]['id'] if r else '')")
  if [[ -n "$LATEST" && "$LATEST" != "$PREV_RUN" ]]; then
    NEW_RUN="$LATEST"
    echo "[poll] New run started: $NEW_RUN (after ${i}*2s)"
    break
  fi
done

if [[ -z "$NEW_RUN" ]]; then
  echo "[fail] No new run detected within 60s. Check /tmp/sr-verify-chrome.log"
  tail -20 /tmp/sr-verify-chrome.log
  exit 1
fi

# Poll run status
echo "[poll] Watching run $NEW_RUN..."
for i in $(seq 1 120); do
  sleep 3
  STATE=$(curl -s "$BACKEND/v1/runs/$NEW_RUN" -H "X-API-Key: $API_KEY" | python3 -c "
import sys, json
r = json.load(sys.stdin)
print(f\"{r['status']}|{r['current_step_index']}|{r['total_steps']}|{r.get('error_summary', '') or ''}\")")
  STATUS=$(echo "$STATE" | cut -d'|' -f1)
  STEP=$(echo "$STATE" | cut -d'|' -f2)
  TOTAL=$(echo "$STATE" | cut -d'|' -f3)
  ERR=$(echo "$STATE" | cut -d'|' -f4)
  echo "[poll #$i] status=$STATUS step=$STEP/$TOTAL err=${ERR:0:80}"
  if [[ "$STATUS" == "completed" ]] || [[ "$STATUS" == "failed" ]] || [[ "$STATUS" == "waiting_for_user" ]] || [[ "$STATUS" == "canceled" ]]; then
    break
  fi
done

# Final dump
echo ""
echo "=== FINAL ==="
curl -s "$BACKEND/v1/runs/$NEW_RUN" -H "X-API-Key: $API_KEY" | python3 -m json.tool | head -15
echo ""
echo "=== EVENTS ==="
curl -s "$BACKEND/v1/runs/$NEW_RUN/events?limit=40" -H "X-API-Key: $API_KEY" | python3 -c "
import sys, json
events = json.load(sys.stdin)
for e in events:
    typ = e.get('event_type'); payload = e.get('payload', {}) or {}; seq = e.get('sequence_number')
    if typ == 'step_executed':
        result = payload.get('result') or {}
        via = result.get('via') if isinstance(result, dict) else None
        print(f\"  #{seq} step={payload.get('step_index')} action={payload.get('action_type')} ok={payload.get('success')} via={via} err={(payload.get('error') or '')[:80]}\")
    elif typ in ('run_started','run_running','run_paused','run_waiting_for_user','run_completed','run_failed'):
        print(f\"  #{seq} {typ}\")
"

# Exit code from status
if [[ "$STATUS" == "completed" ]]; then exit 0; else exit 1; fi
