#!/usr/bin/env bash
# Start a seed server and the Mac app on it, both owned by this run.
# Usage: launch.sh [run-dir]   (default work/verify-mac/<time>-<pid>); prints the run dir.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run="${1:-$root/work/verify-mac/$(date +%Y%m%d-%H%M%S)-$$}"
mkdir -p "$run/evidence" "$run/home"
build_ax
(cd "$root/mac" && cargo build --release --quiet)
exe="$root/mac/target/release/scotty-mac"

# A free loopback port for the seed.
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
url="http://127.0.0.1:$port"

set -m # each background job leads its own process group, so cleanup ends its children too
(cd "$root/ui" && exec "$root/node_modules/.bin/vite" --host 127.0.0.1 --port "$port" --strictPort) >"$run/seed.log" 2>&1 &
seed_pid=$!
echo "SEED_PID=$seed_pid" >"$run/run.env"
echo "SEED_URL=$url" >>"$run/run.env"
for _ in $(seq 1 120); do
  curl -sf "$url/api/sessions" >/dev/null && break
  sleep 0.5
done
curl -sf "$url/api/sessions" >/dev/null || { echo "seed never answered on $url; see $run/seed.log" >&2; exit 1; }

# The app keeps its server list under $HOME: a private home opens the seed at launch.
saved="$run/home/Library/Application Support/scotty-mac"
mkdir -p "$saved"
printf '{"servers":[{"name":"seed","url":"%s"}],"last":"%s"}\n' "$url" "$url" >"$saved/servers.json"
env -u APP_OFFLINE HOME="$run/home" "$exe" >"$run/app.log" 2>&1 &
app_pid=$!
{
  echo "APP_PID=$app_pid"
  echo "APP_HOME=$run/home"
  echo "RUN=$run"
} >>"$run/run.env"

# Rune builds no frame for a covered window: put it where no other app's window overlaps,
# then wait for the seeded list to draw.
for _ in $(seq 1 60); do "$ax" "$app_pid" window >/dev/null 2>&1 && break; sleep 0.5; done
"$ax" "$app_pid" place >/dev/null
"$ax" "$app_pid" wait "row:$SESSION" 30 >/dev/null
echo "$run"
