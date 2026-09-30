# Setup

How to get a machine (yours or an agent's) able to build, deploy and test Scotty on a test stage (the config's stage; the e2e tests use it). [plan.md](plan.md) says what to work on; [design.md](design.md) says what is being built.

Never print, log, commit or paste a real token anywhere in this process: ChatGPT, Cloudflare, Docker Hub, GitHub, or a Cloudflare Access JWT. When you need to check one, print its length, a SHA-256 prefix or its expiry.

## 1. Accounts

- **Cloudflare** account on the Workers Paid plan, with Containers available and Zero Trust (Access) enabled. The owner's email must be able to sign in to Access (one-time PIN works).
- **ChatGPT** account with Codex access. Scotty signs in with a device code; nothing is copied from `~/.codex`.
- **GitHub** access to this repository. For the image pipeline (section 4), admin access to its settings.
- **Docker Hub** account, only if you publish images (section 4).

## 2. Tools

| Tool        | Version    | Why                                                |
| ----------- | ---------- | -------------------------------------------------- |
| Node        | 22.22.2    | `.nvmrc`; npm scripts, typecheck, UI build         |
| Bun         | 1.3.13     | runs `deploy/`, `e2e/` and the CLI (`cli/main.ts`) |
| cloudflared | 2026.6.0+  | gets the Access token the CLI and e2e send         |
| gh          | any recent | watch the image workflow, read its summary         |
| git         | any recent | submodules                                         |

```sh
git clone <this repo> scotty-rebuild && cd scotty-rebuild
git switch rebuild/core
git submodule update --init vendor/effect vendor/alchemy   # read-only API reference
nvm use                                                    # or any Node 22.22.2
npm install
```

Check the toolchain: `npm run fmt && npm run lint && npm run typecheck && npm run ui:build && npm test`. All should pass on a clean checkout.

## 3. Cloudflare API token

`scotty init`, `deploy` and `teardown` call Cloudflare with an API token. In a terminal they open the dashboard's token page with the permissions filled in; create the token and paste it. The token is used for that run only and never saved. To deploy without a prompt (e2e), set `CLOUDFLARE_API_TOKEN`. Keep it in the macOS Keychain rather than a file:

```sh
security add-generic-password -a "$USER" -s scotty-cloudflare -w     # prompts for the token
export CLOUDFLARE_API_TOKEN=$(security find-generic-password -s scotty-cloudflare -w)
```

`CLOUDFLARE_ACCOUNT_ID` (section 5) is the account's 32-character ID from the dashboard URL or `Workers & Pages` overview.

## 4. The container image

The Session container runs a supervisor plus Codex. Its image is built by CI and pushed to Docker Hub; a deploy copies it by digest into Cloudflare's registry. You only need this section if you change `container/**`, `protocol/supervisor.ts`, `package-lock.json` or `.github/workflows/image.yml`, or if you need a fresh digest.

**One-time repository setup (owner):** in GitHub → Settings → Environments, create `image-release` with:

| Kind     | Name                                  | Value                                     |
| -------- | ------------------------------------- | ----------------------------------------- |
| Variable | `SCOTTY_DOCKERHUB_REPOSITORY`         | e.g. `yeshwanthyk/scotty`                 |
| Variable | `SCOTTY_IMAGE_PUBLICATION_AUTHORIZED` | exactly `publish-public-image`            |
| Secret   | `SCOTTY_DOCKERHUB_USERNAME`           | Docker Hub user                           |
| Secret   | `SCOTTY_DOCKERHUB_TOKEN`              | Docker Hub access token, read/write scope |

The image is public on Docker Hub. It contains no secrets.

**Getting a digest:** push `rebuild/core` with a change under one of the paths above, then:

```sh
gh run list --workflow image.yml --limit 1
gh run watch <run-id>
docker buildx imagetools inspect <repository>:rebuild-<full sha> | grep -m1 Digest   # gh run view does not print the job summary
```

Put it in `container/image.digest` as `index.docker.io/<repository>@sha256:<digest>` and commit it; every deploy uses that file. If nothing under those paths changed, keep the digest that is there.

**Your own image:** build it `FROM` the ref in `container/image.digest`, for linux/amd64, keep its `scotty.supervisor` label, push it to Docker Hub, and deploy it by digest:

```sh
scotty deploy --image docker.io/<repository>@sha256:<digest>
```

An image whose label differs from this Scotty's supervisor version is refused before anything is copied; rebuild it on the current base. The next `scotty deploy` without `--image` goes back to Scotty's image.

## 5. Config and environment file

The CLI reads `~/.config/scotty/config.json` (names and IDs only, no tokens):

```json
{
  "stage": "dev",
  "email": "<owner email; the only identity Access lets in>",
  "accountId": "<32-hex account id (section 3)>",
  "domain": "<zone; previews at https://<port>-<id>.<zone>>",
  "zoneId": "<32-hex zone id>",
  "host": "scotty.<zone>"
}
```

Resource names start with `scotty-<stage>`; `host` must be under `domain` and not used by another Worker.

The e2e tests read the environment instead. Create `work/dev-env.sh` (`work/` is never committed):

```sh
export CLOUDFLARE_ACCOUNT_ID=<32-hex account id>
export CLOUDFLARE_API_TOKEN=$(security find-generic-password -s scotty-cloudflare -w)   # section 3
export SCOTTY_OWNER_EMAIL=<owner email>
export SCOTTY_HATCH_BASE=<zone>
export SCOTTY_HATCH_ZONE_ID=<32-hex zone id>
export SCOTTY_URL=https://scotty.<zone>             # the config's host; it overrides the config
export SCOTTY_HATCH_TEST_REPO=<owner>/<repo>       # a small Vite + React repo without .agents/setup; e2e hatch-env
```

Load it in every shell that tests: `. work/dev-env.sh`.

## 6. Deploy

```sh
npm run --silent scotty -- deploy
```

From a checkout this builds the UI and a release; the installed binary carries its own. Either copies the image in `container/image.digest` into `registry.cloudflare.com`, then makes or updates the config's stage over the Cloudflare API: the Worker on the config's host (DNS record and certificate included), its container app and bucket, the Access application (owner email only), and the preview record and route. `scotty teardown` removes them by name.

Never deploy to `production`, to any `scotty-baseline-*` stage, or to a name derived from a user, machine or account.

## 7. Access sign-in

Every request to the Worker goes through Cloudflare Access. The CLI and the e2e get a token from `cloudflared`:

```sh
cloudflared access login "$SCOTTY_URL"     # browser; once per ~24h
```

`cloudflared` caches the token under `~/.cloudflared/`. Don't copy it anywhere. The CLI runs `cloudflared access token -app=$SCOTTY_URL` on each command and sends the result as the `cf-access-token` header.

## 8. ChatGPT sign-in

```sh
npm run --silent scotty -- doctor     # exit 3 with a hint if not signed in
npm run --silent scotty -- login chatgpt     # prints a URL and code; open it and enter the code
npm run --silent scotty -- doctor     # now every check is ok
```

The Creds DO keeps the tokens. Sign-in lasts about 10 days; `doctor` shows the days left. Manual `login chatgpt` remains the owner-trial path; refresh and sign-out are deferred until after the trial. Don't sign in again while `doctor` says `ok`.

## 8b. Claude sign-in (optional; Claude sessions only)

```sh
npm run --silent scotty -- login claude     # runs claude setup-token; sign in in the browser
npm run --silent scotty -- login claude < token-file     # or pipe a token made elsewhere
```

The setup token lasts a year; `doctor` shows the days left and warns in its last 14 days. Settings → Accounts also takes it pasted, for the phone.

## 9. Run the checks

```sh
npm run --silent e2e -- core          # create, answer, scotty deploy, steer, interrupt
npm run --silent e2e -- stop-resume   # stop, resume, crash mid-turn (SCOTTY_CONTAINER_APP_ID: scotty-<stage>-sessions in `npx wrangler containers list`)
npm run --silent e2e -- github        # private clone, push scotty/<id> only, no token (SCOTTY_PRIVATE_TEST_REPO)
npm run --silent e2e -- hatch         # preview routing (SCOTTY_HATCH_BASE)
npm run --silent e2e -- hatch-env     # agent sets up the dev env and brings it back (SCOTTY_HATCH_TEST_REPO)
npm run --silent e2e -- files         # screenshot and video in chat, from R2 (SCOTTY_HATCH_TEST_REPO)
npm run --silent e2e -- settings      # skills and instructions reach new and resumed sessions
npm run --silent e2e -- terminal      # the side panel shell; no token in its env
# core, stop-resume, settings, terminal and hatch run the scripted stand-in (no sign-in);
# --agent claude picks Claude's, --real the real agent. github, hatch-env and files run the real Codex
npm run --silent e2e -- init --stage <name>   # scotty init in a terminal: Ctrl-C mid-deploy, again until live, teardown
```

`e2e init` deploys a stage of its own at `scotty-<name>.<SCOTTY_HATCH_BASE>` and tears it down at the end. Its domain must have no other stage on it: a stage owns its domain's preview record and route, so `init` refuses a domain another stage uses.

`scotty skill` prints [skills/scotty/SKILL.md](../skills/scotty/SKILL.md), the guide for an owner's own agent; keep it under 150 lines and in step with `scotty --help`.

For agents: the `.agents/skills/verify-scotty` skill drives the CLI through feature recipes (`features/*.md`) and saves evidence to `work/verify/`, scratch that is deleted once the step's notes record the result.

Useful CLI commands (`scotty --help` lists them all): `doctor`, `login chatgpt|github|claude`, `new <repo> <prompt> [--agent codex|claude]`, `ls`, `read <id> --last 5`, `read <id> --role assistant`, `steer <id>`, `interrupt <id>`, `stop <id>`, `resume <id>`, `hatch <id> <port>`, `log <id>`. `read` returns recent messages and the latest turn state in one snapshot; callers choose when to read again. Piped output and errors are JSON on stdout (`--json` forces it); errors include a `hint` and a nonzero exit code (3 means a setup or sign-in problem).

## 10. Releases

Tagging `v<version>` (it must match `src/version.ts`) runs `.github/workflows/release.yml`: it builds the three binaries with `npm run compile`, publishes them with `checksums.txt` and `install.sh` on GitHub Releases, and pushes `Formula/scotty.rb` to `Yeshwanthyk/homebrew-scotty`. One-time setup (owner): the public tap repository, and in GitHub → Settings → Environments → `release`, a secret `SCOTTY_TAP_TOKEN` (a fine-grained token with Contents read/write on the tap only). To try a binary locally: `npm run ui:build && npm run compile darwin-arm64`, then `dist/bin/scotty-darwin-arm64`.

## Troubleshooting

| Symptom                                         | Fix                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `access_login` error, exit 3                    | `cloudflared access login "$SCOTTY_URL"`                                           |
| `doctor` says ChatGPT not signed in or expiring | `npm run --silent scotty -- login chatgpt`                                         |
| `doctor` says Claude missing or expiring        | `npm run --silent scotty -- login claude`                                          |
| Deploy fails copying the image                  | Check `container/image.digest` is a `@sha256:` ref and the Docker Hub image exists |
| Deploy fails with a Cloudflare auth error       | Create a new token from the page `scotty deploy` opens                             |
| `vendor/` is empty                              | `git submodule update --init vendor/effect vendor/alchemy`                         |
| A session fails                                 | `npm run --silent scotty -- log <id>`; then plan.md "When something breaks"        |
