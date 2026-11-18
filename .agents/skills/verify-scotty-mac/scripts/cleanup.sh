#!/usr/bin/env bash
# End what this run started (by its process groups), drop its private home, keep its evidence.
# Usage: cleanup.sh <run-dir>
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need_run "${1:-}"
for pid in ${REC_PID:-} ${APP_PID:-} ${SEED_PID:-}; do
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
done
for pid in ${REC_PID:-} ${APP_PID:-} ${SEED_PID:-}; do
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi
done
rm -rf "$APP_HOME"
port="${SEED_URL##*:}"
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "FAIL port $port still listening" >&2; exit 1; fi
for pid in ${APP_PID:-} ${SEED_PID:-}; do
  if kill -0 "$pid" 2>/dev/null; then echo "FAIL $pid still running" >&2; exit 1; fi
done
echo "cleaned; evidence kept in $RUN/evidence:"
ls -1 "$RUN/evidence"
