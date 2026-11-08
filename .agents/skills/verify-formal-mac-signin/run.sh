#!/usr/bin/env bash
# Model-check the Mac app's sign-in (MacSignIn.cfg, the current code) against chart.viz.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 tlc_chart.py run MacSignIn.tla --viz chart.viz "$@"
