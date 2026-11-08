#!/usr/bin/env bash
# Screenshot the app's window (only that window, no shadow) into the run's evidence.
# Usage: shot.sh <run-dir> <name>
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need_run "${1:-}"
name="${2:?name}"
read -r win _ < <("$ax" "$APP_PID" window)
screencapture -x -o -l "$win" "$RUN/evidence/$name.png"
echo "$RUN/evidence/$name.png"
