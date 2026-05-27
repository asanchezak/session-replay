#!/usr/bin/env bash
# Stop + unregister session-replay LaunchAgents.
#
# Usage:
#   scripts/launchd-uninstall.sh <service>
#   scripts/launchd-uninstall.sh all
set -euo pipefail

SERVICE="${1:-}"
if [[ -z "$SERVICE" ]]; then
    echo "usage: $0 <backend|frontend|daemon|all>"
    exit 2
fi

if [[ "$(uname)" != "Darwin" ]]; then
    echo "✗ macOS-only." >&2
    exit 2
fi

remove_one() {
    local svc="$1"
    local label="com.akurey.session-replay-$svc"
    local target="$HOME/Library/LaunchAgents/$label.plist"

    if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
        launchctl bootout "gui/$UID/$label" 2>/dev/null || true
        echo "→ unloaded $label"
    fi
    if [[ -f "$target" ]]; then
        rm -f "$target"
        echo "→ removed   $target"
    fi
}

case "$SERVICE" in
    all)
        remove_one daemon
        remove_one frontend
        remove_one backend
        ;;
    backend|frontend|daemon)
        remove_one "$SERVICE"
        ;;
    *)
        echo "unknown service: $SERVICE (backend|frontend|daemon|all)" >&2
        exit 2
        ;;
esac

echo "✓ done."
