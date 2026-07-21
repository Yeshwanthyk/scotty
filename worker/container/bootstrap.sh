#!/bin/sh
set -eu

usage() {
  echo "usage: scotty-bootstrap <session-id> <default-branch>" >&2
  exit 64
}

[ "$#" -eq 2 ] || usage

session_id=$1
default_branch=$2

case "$session_id" in
  *[!a-z0-9_-]*|'')
    echo "invalid session id" >&2
    exit 64
    ;;
esac

case "$default_branch" in
  -*|*..*|*' '*|'')
    echo "invalid default branch" >&2
    exit 64
    ;;
esac

cache=/cache/rift.git
session_root="/workspace/$session_id"
worktree="$session_root/repo"
branch="scotty/$session_id"

[ -d "$cache" ] || {
  echo "missing baked repository cache: $cache" >&2
  exit 1
}

[ ! -e "$session_root" ] || {
  echo "session root already exists: $session_root" >&2
  exit 73
}

install -d -m 0700 "$session_root/.codex"
git -C "$cache" fetch --prune origin
git -C "$cache" worktree prune
git -C "$cache" worktree add -b "$branch" "$worktree" "refs/remotes/origin/$default_branch"

git -C "$worktree" config core.askPass true
git -C "$worktree" config credential.helper ''

printf '%s\n' "CODEX_HOME=$session_root/.codex"
printf '%s\n' "WORKTREE=$worktree"
printf '%s\n' "BRANCH=$branch"
