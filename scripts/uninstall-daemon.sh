#!/usr/bin/env bash
# Back-compat shim — the daemon uninstaller is now part of launchd-uninstall.sh.
exec "$(dirname "$0")/launchd-uninstall.sh" daemon
