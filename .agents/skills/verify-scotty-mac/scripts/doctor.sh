#!/usr/bin/env bash
# Read-only: is this run's app the intended build, alive, on its own seed, and drivable?
# Usage: doctor.sh <run-dir>
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need_run "${1:-}"
bad=0
check() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; bad=1; fi; }
port="${SEED_URL##*:}"
check "seed process $SEED_PID alive" "kill -0 $SEED_PID"
check "seed answers $SEED_URL/api/sessions with the seeded sessions" "curl -sf $SEED_URL/api/sessions | grep -q $SESSION"
check "app process $APP_PID alive" "kill -0 $APP_PID"
check "app runs this checkout's release build" "ps -o command= -p $APP_PID | grep -q '^$root/mac/target/release/scotty-mac'"
check "app's private home opens the seed" "[ \"\$(jq -r .last '$APP_HOME/Library/Application Support/scotty-mac/servers.json')\" = $SEED_URL ]"
check "app holds a connection to the seed (its list socket)" "lsof -a -nP -p $APP_PID -iTCP:$port -sTCP:ESTABLISHED"
check "Accessibility: this shell can read the app's tree" "$ax $APP_PID has session-list"
check "app shows a window" "$ax $APP_PID window"
check "no other app's window covers it (Rune draws nothing while covered; launch.sh places it)" "$ax $APP_PID covered"
check "app drew the seed's list (row:$SESSION)" "$ax $APP_PID has row:$SESSION"
exit $bad
