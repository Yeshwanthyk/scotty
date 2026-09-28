---
name: verify-scotty
description: Verify a deployed Scotty stage end to end through the scotty CLI (sign-in, create a session, answer, steer, interrupt, reconnect, stop and resume, GitHub push, previews, files in chat). Use after any change to the Worker, Session or Creds DO, supervisor, image or CLI, and before calling a plan step done.
---

# Verify Scotty

Scotty is proved only against a real deployment. This skill drives it through the agent-first
`scotty` CLI (`docs/design.md` "CLI"): every command prints one JSON value on stdout, hints on
stderr, and exits 0 ok, 1 failed, 2 usage, 3 setup missing.

## Launch

The stage must already be deployed; this skill does not deploy. To deploy the dev stage (owner
authorized, never `production` or `scotty-baseline-*`):

```sh
source work/dev-env.sh          # account, owner email, image digest, SCOTTY_URL, test repos
npm run --silent deploy -- --stage dev
```

`work/dev-env.sh` is never committed; `docs/setup.md` lists its variables. After a change under
`container/**`, get the new digest from the `image` workflow run for the pushed commit
(`docker buildx imagetools inspect yeshwanthyk/scotty:rebuild-<full sha>`; `gh run view` does not
print the job summary) and update `SCOTTY_SOURCE_IMAGE` there. Wait about 2 minutes after a deploy
before driving.

## Doctor

```sh
npm run --silent scotty -- doctor
```

Passes when it exits 0 and reports `access`, `worker` and `chatgpt` as `ok` (`chatgptExpiresAt`
is the token expiry; doctor exits 3 when the token is missing or has under a day left). On exit 3, run the
`hint` it prints. Access needs `cloudflared access login $SCOTTY_URL` once (a browser step for
the owner); ChatGPT needs `scotty auth login chatgpt` once (the owner approves a device code). An agent
cannot do either browser step: stop and ask the owner, quoting the hint.

Record existing sessions as unowned before driving: `npm run --silent scotty -- ls > $EVIDENCE/before.json`.

## Drive

Make a fresh evidence directory per run and never reuse one:

```sh
export EVIDENCE="work/verify/$(date -u +%Y%m%dT%H%M%SZ)-$$"; mkdir -p "$EVIDENCE"
```

Pick recipes from [features](features/README.md). Each command's stdout goes to a numbered file
in `$EVIDENCE` (e.g. `03-steer.json`), and its exit code is recorded next to it. Use a small
public repository and short prompts with a marker word, so the answer is checkable.

Driving one stage from two runs at once is safe only on separate sessions. Don't redeploy while
another run is driving unless the recipe is the redeploy recipe.

## Evidence

A recipe passes only with, for each step: the command, its exit code, its JSON, and the state it
caused, read back through a second view (`show` after `steer`, `log` for the raw events). Save
`log <id>` at the end of every run, pass or fail. Save a failed run's log to `e2e/logs/` before
fixing it; a fold bug needs a failing replay, and other bugs need one e2e assertion (plan.md
"When something breaks").

Never write tokens into evidence. The CLI never prints them; don't add `cloudflared access
token` output or headers to files.

## Cleanup

Each `read` exits after one snapshot. List the IDs this run created in `$EVIDENCE/owned.json`, and
`scotty stop <id>` each one that is still running when the run ends (a stopped session costs no
container). Never touch sessions from `before.json`. Evidence under `work/verify/` stays (it is
never committed).

## Features

[Feature index](features/README.md) lists every recipe and what it covers. Passing one recipe
proves only that recipe.

## Keeping this current

Every plan step that changes a user-visible behaviour updates the matching recipe (or adds one)
and re-drives it on `dev` before the step is done.
