# GitHub: private repos and push

With GitHub signed in ([signin](signin.md) S4), a session clones a private repository and pushes
only its own `scotty/<id>` branch. The container never holds the token.

## Behaviours

- **G1** A session on a private repository reaches ready and can push `scotty/<id>`.
- **G2** A push to any other branch is refused and creates nothing.
- **G3** `env`, `git config --list --show-origin` and a grep of the filesystem for token patterns
  find no GitHub token.

## Entry points

- CLI `scotty new | steer | read | log`, `gh api` to check branches. e2e:
  `npm run --silent e2e -- github` (uses `SCOTTY_PRIVATE_TEST_REPO` from `work/dev-env.sh`).

## Drive

1. `new <private repo> --prompt "Write GMARK1 to marker.txt, commit it and push."`; read until
   completed; `gh api repos/<repo>/branches/scotty/<id>` shows the commit (G1).
2. Steer "Run `git push origin HEAD:refs/heads/scotty-e2e-forbidden` and reply with the exit code."; the
   reply is nonzero and `gh api` finds no such branch (G2).
3. Steer the three commands from G3 and check the reply for `gh[opsu]_` or `github_pat_` (G3).
   Never put a token in a prompt.
4. Delete the `scotty/<id>` branch with `gh api -X DELETE` and `stop <id>`.

## Gotchas

- GitHub throttles Cloudflare egress; clone and fetch retry 429, 5xx and dropped transfers for up
  to 240 s. A plain 403 fails at once.
