#!/usr/bin/env bash
# Install + load the session-replay driver-daemon as a launchd LaunchAgent.
#
# Idempotent: re-running re-renders the plist, boots out any existing agent,
# and boots the new one. Safe to run after pulling new daemon code.
#
# Prerequisites: macOS, node (>=18) on PATH, repo cloned, daemon dependencies
# installed (npm install in extension/). The installer checks all of these and
# bails with a helpful message if anything is missing.

set -euo pipefail

LABEL="com.akurey.session-replay-daemon"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${HOME}"
TEMPLATE="$REPO_ROOT/extension/com.akurey.session-replay-daemon.plist.template"
TARGET_DIR="$HOME_DIR/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/$LABEL.plist"
LOG_DIR="$HOME_DIR/Library/Logs/session-replay"

if [[ "$(uname)" != "Darwin" ]]; then
    echo "✗ This installer is macOS-only (uses launchd)."
    echo "  For Linux: write a systemd unit pointing at extension/driver-daemon.mjs."
    exit 2
fi

if ! command -v node >/dev/null 2>&1; then
    echo "✗ node not found on PATH. Install it (brew install node) and retry."
    exit 2
fi
NODE_BIN="$(command -v node)"
NODE_VERSION="$(node --version)"

if [[ ! -f "$TEMPLATE" ]]; then
    echo "✗ plist template not found at: $TEMPLATE"
    exit 2
fi

if [[ ! -d "$REPO_ROOT/extension/node_modules" ]]; then
    echo "→ Installing daemon dependencies..."
    (cd "$REPO_ROOT/extension" && npm install --no-audit --no-fund)
fi

if [[ ! -d "$REPO_ROOT/extension/.linkedin-profile" ]]; then
    echo "⚠  $REPO_ROOT/extension/.linkedin-profile is missing."
    echo "   The daemon will fail to drive Chrome until you stage a profile:"
    echo "     node extension/prepare-stealth-profile.mjs"
    echo "     node extension/login-linkedin.mjs"
    echo "   Continuing install — fix this when you're ready to drive real runs."
fi

mkdir -p "$TARGET_DIR" "$LOG_DIR"

echo "→ Rendering $LABEL.plist"
echo "    repo:  $REPO_ROOT"
echo "    home:  $HOME_DIR"
echo "    node:  $NODE_BIN  ($NODE_VERSION)"
sed -e "s#__HOME__#$HOME_DIR#g" \
    -e "s#__REPO__#$REPO_ROOT#g" \
    -e "s#__NODE__#$NODE_BIN#g" \
    "$TEMPLATE" > "$TARGET_PLIST"

if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    echo "→ Unloading existing agent"
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
    sleep 1
fi

echo "→ Loading agent into launchd (gui/$UID)"
launchctl bootstrap "gui/$UID" "$TARGET_PLIST"
launchctl enable "gui/$UID/$LABEL"

sleep 3
status_line="$(launchctl list 2>/dev/null | grep "$LABEL" || true)"
if [[ -z "$status_line" ]]; then
    echo "✗ Agent failed to register. Check $LOG_DIR/daemon.err.log"
    exit 1
fi

pid="$(echo "$status_line" | awk '{print $1}')"
last_exit="$(echo "$status_line" | awk '{print $2}')"
echo ""
echo "✓ daemon installed."
echo "    label:       $LABEL"
echo "    pid:         ${pid}"
echo "    last exit:   ${last_exit} (0 = healthy)"
echo "    log:         $LOG_DIR/daemon.log"
echo "    err log:     $LOG_DIR/daemon.err.log"
echo ""
echo "Useful commands:"
echo "    tail -f $LOG_DIR/daemon.log          # live"
echo "    launchctl list | grep session-replay  # state"
echo "    make daemon-uninstall                 # stop + remove"
echo ""
echo "Note: the daemon polls localhost:8081, so the backend (make dev-backend)"
echo "must be running for the daemon to do anything useful."
