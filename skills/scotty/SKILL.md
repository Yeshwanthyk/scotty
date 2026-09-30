---
name: scotty
description: Set up Scotty and run Codex or Claude coding sessions in Cloudflare Containers with the `scotty` CLI. Use when asked to install or deploy Scotty, check it with doctor, start or follow a remote coding session, steer or stop one, open a preview of a server it runs, or give sessions skills and instructions.
---

# Scotty

Scotty runs Codex and Claude coding sessions in Cloudflare Containers, on the owner's own
Cloudflare account. The owner drives them from a phone-friendly web page; you drive them with
the `scotty` CLI. One person owns a deployment; Cloudflare Access is the login.

## Rules

- Never print, save or paste a token. `doctor` shows only names and expiry; keep it that way.
- Pipe the CLI (or pass `--json`) and read JSON. A failure is `{"error":{"code","message","hint"}}`
  on stdout with a non-zero exit; the `hint` is the command that fixes it. Do what it says.
- `teardown` deletes every session, sign-in and file. Run it only when the owner asks, by name.
- A command that opens a browser or asks a question needs the owner. Say what it is for, run
  it where they can see it, and wait.

## Is it set up?

```sh
scotty doctor --json
```

`"ok": true` means ready. Otherwise each check with `"status": "fail"` has a `fix`; run the
fixes top to bottom, then run `doctor` again. Exit 3 means setup is missing.

## Set it up

Needs, on the owner's side: a Cloudflare account on Workers Paid with Zero Trust on (free plan),
a domain on that account, a GitHub account, and ChatGPT (for Codex) or Claude (for Claude).
On the machine (macOS or Linux x64): `gh`, and `cloudflared` (brew installs it with scotty).

```sh
brew install yeshwanthyk/scotty/scotty
# or: curl -fsSL https://github.com/Yeshwanthyk/scotty/releases/latest/download/install.sh | sh
```

Then the owner runs `scotty init` in their own terminal. It asks the stage name, their email,
the Cloudflare account and domain, and the address (default `scotty.<domain>`); deploys (a few
minutes, and a new address's DNS can take several more); signs in to Access and the agents; and
ends with `doctor`. It is safe to rerun: finished steps are kept.

`init` needs a terminal. Without one, write `~/.config/scotty/config.json` (names and ids only):

```json
{
  "stage": "main",
  "email": "owner@example.com",
  "accountId": "<32 hex>",
  "domain": "example.com",
  "zoneId": "<32 hex>",
  "host": "scotty.example.com"
}
```

The domain's Overview page in the Cloudflare dashboard shows both ids. The stage is lowercase
letters, digits and dashes, at most 20. Then `scotty deploy`, then `scotty doctor --json` and follow its fixes. The sign-ins:

| Fix                              | What the owner does                                          |
| -------------------------------- | ------------------------------------------------------------ |
| `cloudflared access login <url>` | Signs in to Access in the browser that opens                 |
| `scotty login chatgpt`           | Enters the printed code at the printed URL                   |
| `scotty login github`            | Nothing if `gh auth login` was done; it uses `gh auth token` |
| `scotty login claude`            | Optional. Signs in at the printed URL                        |

One stage per domain: `init` refuses a domain another stage already uses.

## Sessions

A session is one agent working on one GitHub repository, on branch `scotty/<id>`. An id can be
shortened to its first 4+ characters.

```sh
scotty new owner/repo "Fix the failing test in src/parse.ts" --json   # Codex
scotty new owner/repo "Review the README" --agent claude --json
```

The reply has `id` and `url` (the page the owner can open). The first line of the prompt is the
title. Starting a container takes up to a minute or two. Then follow it:

```sh
scotty read <id> --json             # state, and the last message
scotty read <id> --last 5 --json    # more history
```

`turn.state` is `streaming` while the agent works, then `completed`, `aborted` or `failed`. Poll
`read` every 10–20 seconds until it is not `streaming`, then read the assistant message. A
message's `files` are links to files the agent attached.

| Want                                           | Command                    |
| ---------------------------------------------- | -------------------------- |
| List sessions, newest first                    | `scotty ls --json`         |
| Send more instructions (resumes a stopped one) | `scotty steer <id> "text"` |
| Stop the current turn                          | `scotty interrupt <id>`    |
| Stop the container (work is saved)             | `scotty stop <id>`         |
| Pick up from the last save                     | `scotty resume <id>`       |
| Delete stopped sessions                        | `scotty rm <id> [<id>…]`   |
| Preview a server on a port                     | `scotty hatch <id> <port>` |
| Open the page for the owner                    | `scotty open [id]`         |
| Raw events, for debugging                      | `scotty log <id>`          |

`authority.kind` in `ls` is `stable` (with `lifecycle`: `provisioning`, `running`, `stopped` or `failed`) or
`transitioning` (with `action`, such as `create` or `resume`). Wait out a transition.

To see a web app the agent runs, ask it to start the server on a port, then `hatch` that port
and give the owner the URL. It works only while the session is running.

## What sessions get

Every new or resumed session gets the enabled skills and the owner's instructions.

```sh
scotty push skill ./my-skill                 # a folder with SKILL.md, or a .zip; same name replaces
scotty push instructions ./AGENTS.md         # - reads stdin; an empty file clears them
scotty ls skills --json
scotty rm skill <name>
```

Turning a skill on or off is in the web page's Settings.

## Keeping it working

- After `brew upgrade scotty` (or the install script again): `scotty deploy`. `doctor` warns when the deployed version
  differs from the CLI's.
- ChatGPT and Claude sign-ins expire; `doctor` shows the days left and the `login` that renews them.
- Remove everything: `scotty teardown` (it asks for the stage name). Only when the owner asks.

## When something fails

| Code                     | Meaning                           | Do                                             |
| ------------------------ | --------------------------------- | ---------------------------------------------- |
| `setup`                  | No config, or it doesn't decode   | `scotty init`, or fix the config file          |
| `access_login`           | Access sign-in missing or expired | Owner runs the `cloudflared access login` hint |
| `not_found`, `ambiguous` | Bad or too-short id               | `scotty ls`, use more characters               |
| `deploy_failed`          | The deploy printed an error above | Fix it, rerun `scotty deploy`                  |
| `usage`                  | Wrong arguments                   | `scotty <command> --help`                      |

A session with `lifecycle: failed` says why in `scotty read`. It can't be resumed; start a new one.
