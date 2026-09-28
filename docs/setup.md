# Setup

How to get a machine (yours or an agent's) able to build, deploy and test Scotty on the `dev` stage. [plan.md](plan.md) says what to work on; [design.md](design.md) says what is being built.

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

## 3. Cloudflare credentials for Alchemy

Alchemy (the infrastructure tool, `alchemy.run.ts`) deploys with a local profile named `default`:

```sh
npx alchemy profile edit --add Cloudflare
```

This opens a browser OAuth flow. Grant the account that will host Scotty, including Workers, Durable Objects, R2, Containers and Access. The profile lives under your home directory, not in the repo. Alchemy's deploy state lives in `.alchemy/` at the repository root (git-ignored); keep it, since deleting it makes Alchemy forget what it created.

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
gh run view <run-id>          # the summary shows "linux/amd64 digest: sha256:…"
```

Use it as `SCOTTY_SOURCE_IMAGE=index.docker.io/<repository>@sha256:<digest>`. If nothing under those paths changed, reuse the digest from the latest successful run.

## 5. Environment file

Create `work/dev-env.sh` (`work/` is never committed). It holds names and IDs only, no tokens:

```sh
export SCOTTY_SOURCE_IMAGE=index.docker.io/yeshwanthyk/scotty@sha256:<digest>   # section 4
export CLOUDFLARE_ACCOUNT_ID=<32-hex account id>                                # section 3
export SCOTTY_REGISTRY_REPOSITORY=scotty            # repository name in registry.cloudflare.com
export SCOTTY_OWNER_EMAIL=<owner email>             # the only identity Access lets in
export SCOTTY_HATCH_BASE=<zone>                     # previews at https://<port>-<id>.<zone>; a bare zone, since Universal SSL covers one level
export SCOTTY_HATCH_ZONE_ID=<32-hex zone id>        # that zone's id
export SCOTTY_URL=https://<worker host>             # printed by the first deploy (section 6)
export SCOTTY_TEST_REPO=octocat/Hello-World         # any public owner/repo; e2e clones it
```

Load it in every shell that deploys or tests: `. work/dev-env.sh`.

## 6. Deploy `dev`

```sh
. work/dev-env.sh
npm run deploy -- --stage dev
```

This copies the image into `registry.cloudflare.com`, then runs `alchemy deploy --profile default --stage dev`. `alchemy.run.ts` accepts only `--stage dev` and fails without `SCOTTY_OWNER_EMAIL`. The Worker's URL is in the deploy output; put it in `SCOTTY_URL` after the first deploy. Alchemy also creates the Access application and its policy (owner email only).

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
npm run --silent scotty -- auth login chatgpt     # prints a URL and code; open it and enter the code
npm run --silent scotty -- doctor     # now {"access":"ok","worker":"ok","chatgpt":"ok",...}
```

The Creds DO keeps the tokens. Sign-in lasts about 10 days; `doctor` reports `chatgptExpiresAt`. Manual `auth login chatgpt` remains the owner-trial path; refresh and sign-out are deferred until after the trial. Don't sign in again while `doctor` says `ok`.

## 9. Run the checks

```sh
npm run --silent e2e -- core          # create, answer, redeploy, steer, interrupt on dev
```

For agents: the `.agents/skills/verify-scotty` skill drives the CLI through feature recipes (`features/*.md`) and saves evidence to `work/verify/`.

Useful CLI commands (`npm run --silent scotty -- <command>`): `doctor`, `auth login chatgpt|github`, `auth status`, `new`, `ls`, `show <id>`, `read <id> --last 5`, `read <id> --role assistant`, `steer <id>`, `interrupt <id>`, `log <id>`. `read` returns recent messages and the latest turn state in one snapshot; callers choose when to read again. Output and errors are JSON on stdout; errors include a `hint` and a nonzero exit code (3 means a setup or sign-in problem).

## Troubleshooting

| Symptom                                         | Fix                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `access_login` error, exit 3                    | `cloudflared access login "$SCOTTY_URL"`                                        |
| `doctor` says ChatGPT not signed in or expiring | `npm run --silent scotty -- auth login chatgpt`                                 |
| Deploy fails before Alchemy runs                | Check `SCOTTY_SOURCE_IMAGE` is a `@sha256:` ref and the Docker Hub image exists |
| Deploy fails with a Cloudflare auth error       | `npx alchemy profile edit --add Cloudflare` again                               |
| `vendor/` is empty                              | `git submodule update --init vendor/effect vendor/alchemy`                      |
| A session fails                                 | `npm run --silent scotty -- log <id>`; then plan.md "When something breaks"     |
