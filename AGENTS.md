# AGENTS.md

Scotty runs Codex sessions in Cloudflare Containers, driven from a phone-friendly web UI and one CLI.

- `docs/design.md` says what is being built.
- `docs/plan.md` is the work queue. Start with its **Start here** section: take the next `todo` step, do only its scope, and prove it with its **Done when** checks.

## Rules

- **The Session DO is the only writer for a session.** Its state is `fold(events)`.
  - A handler appends an event, folds it, and maybe sends one command. It never awaits an outside party while changing state.
  - An outside action is an intent event; its result is a later event. An unknown result stays pending and is never reported as success.
- **`fold.ts` is pure.** It does no I/O, and it reads no clock or random numbers; time comes from each event's `at`. The DO's one alarm is derived from the state.
- **Real credentials live in the Creds DO.** The one exception: a session's Codex process gets the short-lived ChatGPT access token in its `config.toml` (chatgpt.com blocks Worker traffic, spike 1e); it is never in an environment variable, so commands the agent runs don't inherit it. The refresh token and every other real token stay in the Creds DO. Otherwise a real token never goes into container files, process arguments, logs, the event log, git config, R2, API responses, or Alchemy props, outputs or state.
- **Single user.** Cloudflare Access is the login. Don't add pairing, roles or multi-tenant machinery.
- **Names are explicit.** Never derive a stage or account name from a username, machine, repository or Cloudflare account.
- **`ui/` stays as it is** unless a plan step says to change it.
- **The old implementation is reference only.** It is at `3042018` on `main`; read it with `git show 3042018:<path>`. Port only what a plan step names. Add no compatibility with its formats.

## Code

- Effect `4.0.0-rc.117` and Alchemy `2.0.0-beta.79`. Their source is in `vendor/effect` and `vendor/alchemy` (run `git submodule update --init` if empty).
  - Check an API against that source and its tests before using it. Don't rely on Effect v3 docs or on remembered APIs.
  - Platform and Schema APIs come from `effect` and `effect/unstable/*`. Don't add `@effect/platform`, `@effect/schema` or `@cloudflare/sandbox`.
- Use Effect where typed errors, services, scopes or Schema help: the Worker, the DOs, the supervisor and the CLI. Write pure code as plain functions.
- Decode untrusted input with Schema where it enters: HTTP, WebSocket messages, R2 objects, OAuth responses, CLI arguments. No `any`, no casts that hide a type, no non-null assertions.
- All infrastructure lives in `alchemy.run.ts`. Don't patch dependencies unless a failure is shown and written down in `docs/design.md`.

## Tests

- Unit tests cover only `src/session/fold.ts` and replays of saved event logs in `e2e/logs/`.
- Everything else is proved end to end against a real deployment in `e2e/`. Don't mock Cloudflare, Codex or GitHub.
- Only `e2e github` and `hatch-env` use GitHub. The other e2e tests use `fixtureRepo` (`protocol/supervisor.ts`), a repository baked into the container image, so GitHub throttling can't fail them.
- When something breaks, save its event log to `e2e/logs/` and add a failing replay before fixing it.

## Git

- Work and commit directly on `rebuild/core`; no branch per step. Commit each finished piece of work. Don't commit to `main`.
- `vendor/` is read-only. `work/` is scratch space that is never committed; spikes go in `work/spikes/`.

## Checks

Run these before every commit. Report what ran and what didn't.

```sh
npm run fmt
npm run lint             # from step 0
npm run typecheck        # covers only ui/ until step 0 adds the root project
npm run ui:build
npm test                 # from step 2
npm run e2e -- <name>    # from step 2, against a deployment
```
