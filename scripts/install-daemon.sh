#!/usr/bin/env bash
# Back-compat shim — the daemon installer is now part of launchd-install.sh.
exec "$(dirname "$0")/launchd-install.sh" daemon
