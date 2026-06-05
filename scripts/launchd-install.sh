#!/usr/bin/env bash
# Generic launchd LaunchAgent installer for session-replay services.
#
# Usage:
#   scripts/launchd-install.sh <service>
#   scripts/launchd-install.sh all
#
# Services: backend | frontend | daemon | all
#
# Renders scripts/launchd/<service>.plist.template against this machine's paths,
# writes the result to ~/Library/LaunchAgents/<label>.plist, and loads it via
# launchctl. Idempotent — re-running re-renders and re-loads.

set -euo pipefail

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
    echo "usage: $0 <backend|frontend|daemon|all>"
    exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${HOME}"
TARGET_DIR="$HOME_DIR/Library/LaunchAgents"
LOG_DIR="$HOME_DIR/Library/Logs/session-replay"
TEMPLATE_DIR="$REPO_ROOT/scripts/launchd"

if [[ "$(uname)" != "Darwin" ]]; then
    echo "✗ macOS-only (uses launchd). For Linux: write a systemd unit." >&2
    exit 2
fi

mkdir -p "$TARGET_DIR" "$LOG_DIR"

# Resolve binaries this installer might substitute. Fail closed on the ones the
# requested service actually needs.
NODE_BIN="$(command -v node 2>/dev/null || true)"
UVICORN_BIN="$REPO_ROOT/backend/.venv/bin/uvicorn"
VITE_BIN="$REPO_ROOT/frontend/node_modules/.bin/vite"

# Daemon runtime config (rendered into the daemon plist). Override via env to
# point the local daemon at a remote backend and give it a routing identity:
#   DAEMON_BACKEND=https://<host>/  DAEMON_API_KEY=<key>  DAEMON_OPERATOR_ID=andrey  make daemon-install
DAEMON_BACKEND="${DAEMON_BACKEND:-http://localhost:8081}"
DAEMON_API_KEY="${DAEMON_API_KEY:-dev-api-key-change-in-production}"
DAEMON_OPERATOR_ID="${DAEMON_OPERATOR_ID:-}"
# Testing toggle: set DAEMON_DISABLE_COOLDOWN=1 to skip the daemon's inter-run
# cooldown (LinkedIn runs fire back-to-back). Defaults 0 — keep the cooldown in
# production. Persisted into the rendered plist so it survives daemon-restart.
DAEMON_DISABLE_COOLDOWN="${DAEMON_DISABLE_COOLDOWN:-0}"

install_one() {
    local svc="$1"
    local label="com.akurey.session-replay-$svc"
    local template="$TEMPLATE_DIR/$svc.plist.template"
    local target="$TARGET_DIR/$label.plist"

    if [[ ! -f "$template" ]]; then
        echo "✗ template not found: $template" >&2
        return 2
    fi

    # Per-service prerequisite checks
    case "$svc" in
        backend)
            if [[ ! -x "$UVICORN_BIN" ]]; then
                echo "✗ backend venv missing — run: make setup-backend" >&2
                return 2
            fi
            ;;
        frontend)
            if [[ ! -x "$VITE_BIN" ]]; then
                echo "✗ frontend deps missing — run: make setup-frontend" >&2
                return 2
            fi
            ;;
        daemon)
            if [[ -z "$NODE_BIN" ]]; then
                echo "✗ node not on PATH (brew install node)" >&2
                return 2
            fi
            if [[ ! -d "$REPO_ROOT/extension/node_modules" ]]; then
                echo "→ installing extension deps..."
                (cd "$REPO_ROOT/extension" && npm install --no-audit --no-fund)
            fi
            if [[ ! -d "$REPO_ROOT/extension/.linkedin-profile" ]]; then
                echo "⚠  extension/.linkedin-profile is missing. The daemon"
                echo "   will fail to drive Chrome until you run:"
                echo "     node extension/prepare-stealth-profile.mjs"
                echo "     node extension/login-linkedin.mjs"
            fi
            ;;
    esac

    echo "→ rendering $label.plist"
    sed -e "s#__HOME__#$HOME_DIR#g" \
        -e "s#__REPO__#$REPO_ROOT#g" \
        -e "s#__NODE__#$NODE_BIN#g" \
        -e "s#__UVICORN__#$UVICORN_BIN#g" \
        -e "s#__VITE__#$VITE_BIN#g" \
        -e "s#__BACKEND__#$DAEMON_BACKEND#g" \
        -e "s#__API_KEY__#$DAEMON_API_KEY#g" \
        -e "s#__OPERATOR_ID__#$DAEMON_OPERATOR_ID#g" \
        -e "s#__DISABLE_COOLDOWN__#$DAEMON_DISABLE_COOLDOWN#g" \
        "$template" > "$target"

    if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
        launchctl bootout "gui/$UID/$label" 2>/dev/null || true
        sleep 1
    fi
    launchctl bootstrap "gui/$UID" "$target"
    launchctl enable "gui/$UID/$label"

    sleep 2
    local status_line
    status_line="$(launchctl list 2>/dev/null | grep "$label" || true)"
    if [[ -z "$status_line" ]]; then
        echo "✗ $label failed to register. Check $LOG_DIR/$svc.err.log" >&2
        return 1
    fi
    local pid="$(echo "$status_line" | awk '{print $1}')"
    local last_exit="$(echo "$status_line" | awk '{print $2}')"
    echo "✓ $label  pid=$pid  last_exit=$last_exit"
}

case "$SERVICE" in
    all)
        install_one backend
        install_one frontend
        install_one daemon
        ;;
    backend|frontend|daemon)
        install_one "$SERVICE"
        ;;
    *)
        echo "unknown service: $SERVICE (backend|frontend|daemon|all)" >&2
        exit 2
        ;;
esac

echo ""
echo "logs: tail -f $LOG_DIR/<service>.log"
echo "ops:  make services-status | services-restart | services-uninstall"
