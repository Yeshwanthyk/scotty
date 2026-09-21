# Setup and updates

For installation and first-time setup, start with the [README](../README.md#setup).

## Update the CLI

```sh
scotty upgrade
scotty --version
scotty --build-info
```

`upgrade` installs the latest published signed release and its bundled agent guides. It does not
update the Worker. Main-branch pushes do not publish a release.

`--version` shows the release version. `--build-info` shows the build commit and whether the
executable includes the deployment archive. Use the packaged release for deployment; compiling
`cli/scotty.ts` directly with Bun omits that archive.

## Update the cloud installation

Deployment requires the managed installation and Cloudflare profile, Cloudflare authentication,
and Docker. It uses the code bundled in the installed release.

```sh
scotty deploy --plan --json
```

Review the plan before applying it:

```sh
scotty deploy --yes --json
scotty doctor --json
```

See the [production runbook](../README.md#production-runbook) for rollout checks and troubleshooting.
Publishing sandbox resources is a separate operation; see
[Cloudflare deployment](../README.md#cloudflare-deployment).

## Agent guides

```sh
scotty skill show
scotty skill show scotty-live-observability
```

The guides are bundled with the CLI, so upgrading the executable updates them too.

`init` and `upgrade` do not install skills into your local coding agent. Your agent can read the
main guide by running `scotty skill show`.

For automatic discovery, add a small `SKILL.md` in your agent’s configured skill directory that
instructs it to run `scotty skill show` and follow the result. Review any existing skill first,
preserve custom delegation instructions, and verify discovery in a fresh agent session. This keeps
the guide current without overwriting local skills.

Local skill discovery is separate from a public shared skill catalog, which Scotty does not
currently provide.
