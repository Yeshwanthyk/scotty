#!/usr/bin/env bash
# Record the app's window region to a video while a drive runs, then stop by PID.
# Usage: record.sh <run-dir> start <name> | stop
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need_run "${1:-}"
case "${2:?start|stop}" in
  start)
    name="${3:?name}"
    read -r _ x y w h < <("$ax" "$APP_PID" window)
    # The main display at its pixel scale; avfoundation's screen device is "Capture screen 0".
    scale="$(swift -e 'import AppKit; print(Int(NSScreen.main?.backingScaleFactor ?? 2))' 2>/dev/null || echo 2)"
    set -m
    ffmpeg -nostdin -loglevel error -f avfoundation -capture_cursor 1 -framerate 30 -i "Capture screen 0:none" \
      -vf "crop=$((w * scale)):$((h * scale)):$((x * scale)):$((y * scale)),scale=trunc(iw/4)*2:trunc(ih/4)*2" \
      -c:v libx264 -pix_fmt yuv420p -movflags +faststart -y "$RUN/evidence/$name.mp4" &
    echo "REC_PID=$!" >>"$RUN/run.env"
    echo "REC_OUT=$RUN/evidence/$name.mp4" >>"$RUN/run.env"
    sleep 1
    ;;
  stop)
    [[ -n "${REC_PID:-}" ]] || { echo "no recording in this run" >&2; exit 1; }
    kill -INT "$REC_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$REC_PID" 2>/dev/null || break; sleep 0.1; done
    sed -i '' '/^REC_PID=/d' "$RUN/run.env"
    echo "$REC_OUT"
    ;;
esac
