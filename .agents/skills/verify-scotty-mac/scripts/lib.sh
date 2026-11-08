# shellcheck shell=bash
# Shared by the verify-scotty-mac scripts: the checkout, the run folder and its recorded state.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
ax="$root/work/verify-mac/ax"
# A seeded session that waits for input and shows without filters: drives steer it.
export SESSION=d0cc0de5000000000000000000000002

need_run() {
  run="${1:?usage: $0 <run-dir>}"
  [[ -f "$run/run.env" ]] || { echo "no run at $run (launch.sh makes one)" >&2; exit 1; }
  # shellcheck disable=SC1091
  source "$run/run.env"
}

# The helper is built from source on first use and whenever ax.swift changes.
build_ax() {
  if [[ ! -x "$ax" || "$here/ax.swift" -nt "$ax" ]]; then
    mkdir -p "$(dirname "$ax")"
    swiftc -O "$here/ax.swift" -o "$ax"
  fi
}
