---
name: modeling-effect-cli
description: Models Scotty CLI grammar with the pinned Effect v4 Command, Argument, Flag, and GlobalFlag APIs. Use when adding or changing commands, subcommands, positional arguments, flags, help, parser errors, CLI exit behavior, or replacing manual argv dispatch.
---

# Model Effect CLI

Treat command grammar as data and keep transport, credentials, output policy, and process effects in
Scotty handlers.

## Source gate

Before changing a non-trivial CLI pattern:

1. Read `vendor/effect/AGENTS.md` and `vendor/effect/.patterns/effect.md`.
2. Read `vendor/effect/ai-docs/src/70_cli/10_basics.ts`.
3. Inspect the public implementations under
   `vendor/effect/packages/effect/src/unstable/cli/`, especially `Command.ts`, `Argument.ts`,
   `Flag.ts`, `GlobalFlag.ts`, `CliConfig.ts`, and `CliOutput.ts`.
4. Inspect the analogous tests under `vendor/effect/packages/effect/test/unstable/cli/`.
5. Verify every API against Scotty's pinned Effect version. Do not use remembered v3 APIs,
   third-party examples, or `effect/unstable/cli/internal/*`.

## Ownership

- `Command`, `Argument`, and `Flag` own command grammar, typed parsing, help metadata, and
  subcommand selection.
- Scotty command handlers own API calls, credentials, filesystem changes, browser launch, output
  schemas, and domain validation.
- `main` owns the one runtime boundary, parser-output policy, error-envelope translation, and exit
  code.
- `CliRuntime`, `HttpTransport`, `ProcessRunner`, `BrowserLauncher`, and Scotty's `FileSystem`
  remain injectable services. Effect CLI's platform environment supports parsing; it does not
  replace these product services.

## Command shape

- Declare one root `scotty` command and compose every public command with
  `Command.withSubcommands`.
- Represent `beam up`, `owner recover`, and `tools list|doctor` as real nested commands. Do not
  inspect or shift action strings in handlers.
- Use `Argument` for positional input and `Flag` for named input. Use `Flag.choice` when the public
  vocabulary is closed, such as the currently supported provider.
- Use root `Command.withSharedFlags` for `host`, `token`, and `json` so they remain available across
  descendants and before or after subcommand names.
- Put descriptions, aliases, examples, and metavariables on the command definitions. Use
  `Command.unlisted` (the rc.109 replacement for `Command.withHidden`) for commands that must
  stay runnable but out of generated help. Do not
  maintain parallel help strings or a command-name registry.
- Use `Command.runWith` at Scotty's explicit-argv Bun boundary so production and tests execute the
  same tree.
- Configure `CliConfig` with only the built-ins Scotty intentionally exposes. Do not accidentally
  add wizard, completions, log-level, or a conflicting version alias.
- Pinned Effect rc.109 does not reject undeclared leftover positional arguments. Give each leaf
  one shared hidden variadic trailing `Argument` and reject any values before the handler performs
  side effects. Keep this guard until a pinned-source test proves the parser rejects leftovers.

```ts
const up = Command.make(
  "up",
  {
    prompt: Argument.string("prompt"),
    repo: Flag.string("repo"),
    provider: Flag.choice("provider", ["cloudflare"]),
    cap: Flag.string("cap").pipe(Flag.optional),
    detach: Flag.boolean("detach"),
  },
  handleBeamUp,
);

const beam = Command.make("beam").pipe(Command.withSubcommands([up]));
```

Normal branching inside a handler is fine. Do not replace domain decisions such as optional cap
conversion, response decoding, or browser launch with command combinators.

## Output and failure boundary

`Command.runWith` writes generated help before failing with `CliError.ShowHelp`. Adapt that behavior
once at `main`:

- Successful `--help` and `--version` go to stdout.
- Non-TTY operational success remains one stable JSON value on stdout.
- Parse and domain failures remain one redacted Scotty error envelope on stderr with the intended
  exit code.
- Parser help must not contaminate machine-readable stdout on failure.
- Non-error statuses such as an unhealthy `tools doctor` report may return a non-zero code without
  inventing an error envelope.

Use a small scoped output buffer or equivalent host adapter. Do not import CLI internals to bypass
the public runner, and do not let Effect CLI write directly around Scotty's injected writers.

## Migration discipline

- Migrate the complete command grammar as one CLI-only vertical slice. A hybrid manual/Effect
  parser creates two sources of truth.
- Reuse existing domain functions and services; do not rewrite transport, archive, credential, or
  response-decoding modules.
- Delete manual parser helpers and help constants only after every command is represented and the
  complete command tests pass.
- Do not add a Scotty command framework or handler registry around Effect CLI.

## Proof

- Add focused `@effect/vitest` tests for the command tree, nested help, required input, closed
  choices, shared-flag placement, unknown subcommands, and the built-in allowlist.
- Keep Bun boundary tests for injected services, stable JSON, redaction, exit codes, browser
  behavior, idempotency, and `tools doctor`.
- Run `npm run fmt`, `npm run lint:skills`, `npm run lint`, `npm run typecheck`,
  `npm run test:cli`, `npm run test:e2e:static`, `npm run test:e2e:local-live:helpers`,
  `node e2e/scripts/scan.mjs`, and compile the CLI.
