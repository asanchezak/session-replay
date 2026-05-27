#!/usr/bin/env bash
# Stop + unregister the session-replay driver-daemon LaunchAgent.
set -euo pipefail

LABEL="com.akurey.session-replay-daemon"
TARGET_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
    echo "✗ macOS-only."
    exit 2
fi

if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    echo "→ bootout gui/$UID/$LABEL"
    launchctl bootout "gui/$UID/$LABEL" || true
else
    echo "agent not currently loaded."
fi

if [[ -f "$TARGET_PLIST" ]]; then
    rm -f "$TARGET_PLIST"
    echo "removed $TARGET_PLIST"
fi

echo "✓ uninstalled."
