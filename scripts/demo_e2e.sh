#!/usr/bin/env bash
# DEPRECATED shim → the demo is now the Python orchestrator scripts/demo_e2e.py
# (typed, per-stage asserts, loops archive-all until empty, refuses to send unless
# exactly Andrey is active). Env vars pass straight through. Trigger phrase:
# "corre el test de linkedin para el demo".
exec python3 "$(dirname "$0")/demo_e2e.py" "$@"
