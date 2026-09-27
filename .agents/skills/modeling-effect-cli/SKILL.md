---
name: modeling-effect-cli
description: Models the scotty CLI with Effect's unstable CLI (Command, Argument, Flag). Use when adding or changing a command, subcommand, argument, flag, help text, error envelope or exit code.
---

# Model Effect CLI

`cli/main.ts` is the one **runtime boundary**: it builds the `scotty` command tree, runs it with `Command.runWith`, and turns every failure into the JSON error envelope and exit code. Each command lives in `cli/commands/` and owns only its grammar and handler.

## Adding or changing a command

1. Read `vendor/effect/ai-docs/src/70_cli/10_basics.ts`, then the matching source and tests under `vendor/effect/packages/effect/src/unstable/cli/` and `test/unstable/cli/`. Use only exported APIs from the vendored version.
2. Declare the grammar with `Command.make(name, { ...args, ...flags }, handler)`: `Argument.*` for positional input, `Flag.*` for named input, `Flag.choice` for a closed vocabulary, `Flag.optional` for an `Option`. Reuse the shared `url` flag from `common.ts`.
3. Write the handler as `Effect.gen`: validate input the grammar can't express (fail with `usage(...)`, exit 2), call the API through `withClient`, decode the response with its Schema, print it with `output`.
4. Add the command to `withSubcommands` in `main.ts` and its entry to the `help` table there: a usage line, one sentence, one example.
5. Prove it against dev: run `npm run scotty -- <command> --help` and one real invocation, and check stdout is one JSON value and the exit code is right.

Done when the command appears in `scotty --help`, its own `--help` prints its entry, and a success and a usage error both print one JSON value with the documented exit code.

## Output contract

- Success: one JSON value on stdout.
- Failure: `{ "error": { code, message, hint } }` on stdout with the `CliFailure`'s exit code. `main` maps parser errors to `usage` (exit 2) and anything unexpected to `request_failed`.
- Effect CLI's own console output is silenced in `main`; help comes only from the `help` table.
- A token never appears in output, errors or arguments; the CLI reads secrets from stdin (`gh auth token | scotty auth login github`).

Domain decisions — decoding, retries, what to print — belong in the handler. Command combinators carry grammar only.
