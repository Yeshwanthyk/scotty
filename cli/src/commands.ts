import { join } from "node:path";
import { Clock, Console, Effect, Option, Predicate, Ref, Result } from "effect";
import {
  Argument,
  CliConfig,
  CliError as EffectCliError,
  Command,
  Flag,
  GlobalFlag,
  Param,
} from "effect/unstable/cli";
import { handleDown } from "./archive";
import {
  CliError,
  EXIT,
  VERSION,
  type ExitCode,
  type GlobalOptions,
  type JsonObject,
  type Writer,
} from "./core";
import { clearPendingUp, credentials, pendingUpRequest, secureWrite } from "./dependencies";
import {
  decodeOperationResponse,
  decodeSessionsResponse,
  decodeVaporizeResponse,
  PROVIDERS,
  STANDARD_TOOLSET,
} from "./schemas";
import {
  browserUrl,
  durationSeconds,
  EMBEDDED_SKILL,
  humanResult,
  humanSession,
  invalidResponse,
  normalizeHost,
  optionalString,
  outputJson,
  probeOutput,
  sanitizeUrl,
  stableRecoveryGrant,
  stableSession,
  stableUp,
  usage,
} from "./pure";
import { BrowserLauncher, CliRuntime, ProcessRunner } from "./services";
import { requestJson } from "./transport";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const trailingArguments: Argument.Argument<ReadonlyArray<string>> = Param.withHidden(
  Argument.variadic(Argument.string("unexpected")),
);

const formatConsoleArguments = (args: ReadonlyArray<unknown>): string =>
  args.map((value) => String(value)).join(" ");

const captureConsole = (stdout: string[], stderr: string[]): Console.Console => ({
  assert: (condition, ...args) => {
    if (!condition) stderr.push(formatConsoleArguments(args));
  },
  clear: () => undefined,
  count: () => undefined,
  countReset: () => undefined,
  debug: (...args) => stdout.push(formatConsoleArguments(args)),
  dir: (item) => stdout.push(String(item)),
  dirxml: (...args) => stdout.push(formatConsoleArguments(args)),
  error: (...args) => stderr.push(formatConsoleArguments(args)),
  group: (...args) => stdout.push(formatConsoleArguments(args)),
  groupCollapsed: (...args) => stdout.push(formatConsoleArguments(args)),
  groupEnd: () => undefined,
  info: (...args) => stdout.push(formatConsoleArguments(args)),
  log: (...args) => stdout.push(formatConsoleArguments(args)),
  table: (data) => stdout.push(String(data)),
  time: () => undefined,
  timeEnd: () => undefined,
  timeLog: () => undefined,
  trace: (...args) => stderr.push(formatConsoleArguments(args)),
  warn: (...args) => stderr.push(formatConsoleArguments(args)),
});

const flushCapturedOutput = (
  stdoutWriter: Writer,
  stderrWriter: Writer,
  stdout: ReadonlyArray<string>,
  stderr: ReadonlyArray<string>,
): void => {
  for (const value of stdout) stdoutWriter(value.endsWith("\n") ? value : `${value}\n`);
  for (const value of stderr) stderrWriter(value.endsWith("\n") ? value : `${value}\n`);
};

const validateSessionId = (id: string): Effect.Effect<string, CliError> =>
  SESSION_ID_PATTERN.test(id) ? Effect.succeed(id) : Effect.fail(usage("Invalid session ID"));

const rejectTrailingArguments = (values: ReadonlyArray<string>): Effect.Effect<void, CliError> =>
  values.length === 0 ? Effect.void : Effect.fail(usage(`Unexpected argument: ${values[0]}`));

const parserUsage = (error: EffectCliError.ShowHelp): CliError => {
  for (const item of error.errors) {
    // Effect beta.99 currently exposes this misspelled runtime tag on the public error class.
    if (Predicate.isTagged(item, "UnknownSubcomand") && item.parent?.length === 1)
      return usage(`Unknown command: ${item.subcommand}`);
    if (Predicate.isTagged(item, "MissingOption")) {
      if (item.option === "repo") return usage("--repo OWNER/NAME is required");
      if (item.option === "provider") return usage("--provider cloudflare is required");
    }
    if (Predicate.isTagged(item, "InvalidValue") && item.option === "provider")
      return usage("--provider must be cloudflare");
  }
  return usage(error.errors.map((item) => item.message).join("; "));
};

type SetExitCode = (code: ExitCode) => Effect.Effect<void>;

export const makeScottyCommand = (setExitCode: SetExitCode) => {
  const version = GlobalFlag.action({
    flag: Flag.boolean("version").pipe(
      Flag.withAlias("V"),
      Flag.withDescription("Show version information"),
    ),
    run: (_enabled, context) => Console.log(context.version),
  });

  const scotty = Command.make("scotty").pipe(
    Command.withSharedFlags({
      host: Flag.string("host").pipe(
        Flag.optional,
        Flag.withDescription("Override the configured Scotty Worker origin"),
      ),
      token: Flag.string("token").pipe(
        Flag.optional,
        Flag.withDescription("Override the configured Scotty bearer token"),
      ),
      json: Flag.boolean("json").pipe(Flag.withDescription("Emit stable machine-readable output")),
    }),
    Command.withGlobalFlags([version]),
    Command.withDescription("Run durable coding-agent sessions"),
  );

  const commandContext = Effect.fnUntraced(function* () {
    const root = yield* scotty;
    const runtime = yield* CliRuntime;
    const options: GlobalOptions = {
      json: root.json,
      ...(Option.isSome(root.host) ? { host: root.host.value } : {}),
      ...(Option.isSome(root.token) ? { token: root.token.value } : {}),
    };
    return {
      autoJson: options.json || !runtime.stdoutIsTTY,
      options,
      runtime,
    };
  });

  const init = Command.make("init", { trailing: trailingArguments }, ({ trailing }) =>
    Effect.gen(function* () {
      yield* rejectTrailingArguments(trailing);
      const { autoJson, options, runtime } = yield* commandContext();
      let host = options.host;
      let token = options.token;
      if ((!host || !token) && !runtime.stdinIsTTY)
        return yield* usage("init needs --host and --token when stdin is not a TTY");
      host ||= runtime.prompt("Scotty Worker host: ")?.trim();
      token ||= runtime.prompt("Scotty token: ")?.trim();
      if (!host || !token) return yield* usage("Host and token are required");
      host = yield* Effect.fromResult(normalizeHost(host));
      const configPath = join(runtime.home, ".scotty.json");
      yield* secureWrite(configPath, `${JSON.stringify({ host, token }, null, 2)}\n`);
      const result = { configPath, host };
      if (autoJson) outputJson(runtime.stdout, result);
      else runtime.stdout(`Saved ${configPath} with mode 0600\n`);
    }),
  ).pipe(
    Command.withDescription("Save the Worker host and token"),
    Command.withExamples([
      { command: "scotty init", description: "Configure Scotty interactively" },
    ]),
  );

  const beamUp = Command.make(
    "up",
    {
      prompt: Argument.string("prompt").pipe(Argument.withDescription("Initial agent prompt")),
      repo: Flag.string("repo").pipe(Flag.withDescription("GitHub repository as OWNER/NAME")),
      provider: Flag.choice("provider", PROVIDERS).pipe(Flag.withDescription("Execution provider")),
      cap: Flag.string("cap").pipe(
        Flag.optional,
        Flag.withDescription("Hard cap such as 30m, 4h, or 1d"),
      ),
      detach: Flag.boolean("detach").pipe(Flag.withDescription("Do not open the session browser")),
      trailing: trailingArguments,
    },
    ({ cap, detach, prompt, provider, repo, trailing }) =>
      Effect.gen(function* () {
        yield* rejectTrailingArguments(trailing);
        const { autoJson, options, runtime } = yield* commandContext();
        const browser = yield* BrowserLauncher;
        if (!prompt.trim()) return yield* usage("Prompt must not be empty");
        if (!REPOSITORY_PATTERN.test(repo)) return yield* usage("--repo must be OWNER/NAME");
        const auth = yield* credentials(options);
        const body: JsonObject = { prompt, provider, repo };
        if (Option.isSome(cap)) {
          body.cap = cap.value;
          body.hardCapSeconds = yield* Effect.fromResult(durationSeconds(cap.value));
        }
        const pending = yield* pendingUpRequest(auth.host, body);
        const requested = yield* Effect.result(
          requestJson(auth, "/api/sessions", {
            method: "POST",
            headers: { "idempotency-key": pending.key },
            body: JSON.stringify(body),
          }).pipe(Effect.flatMap((raw) => Effect.fromResult(stableUp(raw, auth.host)))),
        );
        if (Result.isFailure(requested)) {
          if (requested.failure.code === "conflict") yield* clearPendingUp(pending.path);
          return yield* requested.failure;
        }
        const decoded = requested.success;
        if (decoded.output.status !== "booting") yield* clearPendingUp(pending.path);
        const result = decoded.output;
        if (!detach)
          yield* browser.open(
            yield* Effect.fromResult(browserUrl(decoded.sessionUrl, auth.host, result.id)),
          );
        if (autoJson) outputJson(runtime.stdout, result);
        else runtime.stdout(humanResult("beam up", result));
      }),
  ).pipe(
    Command.withDescription("Start an agent session"),
    Command.withExamples([
      {
        command:
          'scotty beam up "fix the failing tests" --repo owner/project --provider cloudflare',
        description: "Start a Cloudflare session",
      },
    ]),
  );

  const beam = Command.make("beam").pipe(
    Command.withDescription("Create agent sessions"),
    Command.withSubcommands([beamUp]),
  );

  const list = Command.make("ls", { trailing: trailingArguments }, ({ trailing }) =>
    Effect.gen(function* () {
      yield* rejectTrailingArguments(trailing);
      const { autoJson, options, runtime } = yield* commandContext();
      const auth = yield* credentials(options);
      const value = yield* requestJson(auth, "/api/sessions");
      const decoded = decodeSessionsResponse(value);
      if (Option.isNone(decoded))
        return yield* invalidResponse("Server response is not a valid session array");
      const sessions = decoded.value.map(stableSession);
      if (autoJson) outputJson(runtime.stdout, sessions);
      else
        runtime.stdout(
          sessions.length ? `${sessions.map(humanSession).join("\n")}\n` : "No sessions.\n",
        );
    }),
  ).pipe(Command.withDescription("List sessions"));

  const attach = Command.make(
    "attach",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
      trailing: trailingArguments,
    },
    ({ id, trailing }) =>
      Effect.gen(function* () {
        yield* rejectTrailingArguments(trailing);
        const { autoJson, options, runtime } = yield* commandContext();
        const browser = yield* BrowserLauncher;
        const sessionId = yield* validateSessionId(id);
        const auth = yield* credentials(options);
        const safeUrl = `${auth.host}/s/${encodeURIComponent(sessionId)}`;
        const targetUrl = yield* Effect.fromResult(browserUrl(undefined, auth.host, sessionId));
        yield* browser.open(targetUrl);
        const result = { id: sessionId, url: safeUrl, opened: true };
        if (autoJson) outputJson(runtime.stdout, result);
        else runtime.stdout(humanResult("attach", result));
      }),
  ).pipe(Command.withDescription("Open a session"));

  const ownerRecover = Command.make("recover", { trailing: trailingArguments }, ({ trailing }) =>
    Effect.gen(function* () {
      yield* rejectTrailingArguments(trailing);
      const { autoJson, options, runtime } = yield* commandContext();
      const browser = yield* BrowserLauncher;
      const auth = yield* credentials(options);
      const raw = yield* requestJson(auth, "/api/auth/recovery-grants", {
        method: "POST",
      });
      const nowMillis = yield* Clock.currentTimeMillis;
      const recovery = yield* Effect.fromResult(stableRecoveryGrant(raw, auth.host, nowMillis));
      yield* browser.open(recovery.url);
      const result = { opened: true, expiresAt: recovery.expiresAt };
      if (autoJson) outputJson(runtime.stdout, result);
      else
        runtime.stdout(
          `Opened owner recovery in your browser. It expires at ${recovery.expiresAt}.\n`,
        );
    }),
  ).pipe(Command.withDescription("Recover ownership on a replacement device"));

  const owner = Command.make("owner").pipe(
    Command.withDescription("Manage browser ownership"),
    Command.withSubcommands([ownerRecover]),
  );

  const skills = Command.make("skills", { trailing: trailingArguments }, ({ trailing }) =>
    Effect.gen(function* () {
      yield* rejectTrailingArguments(trailing);
      const { options, runtime } = yield* commandContext();
      if (options.json)
        return yield* usage(
          "scotty skills emits Markdown and does not support --json",
          "Run scotty skills without flags.",
        );
      runtime.stdout(EMBEDDED_SKILL);
    }),
  ).pipe(Command.withDescription("Print the embedded agent skill"));

  const toolsList = Command.make("list", { trailing: trailingArguments }, ({ trailing }) =>
    Effect.gen(function* () {
      yield* rejectTrailingArguments(trailing);
      const { autoJson, runtime } = yield* commandContext();
      if (autoJson) outputJson(runtime.stdout, STANDARD_TOOLSET);
      else {
        runtime.stdout(`standard toolset (${STANDARD_TOOLSET.tools.length} tools)\n`);
        for (const tool of STANDARD_TOOLSET.tools) {
          const version = tool.expectedVersion ?? tool.versionPolicy;
          runtime.stdout(
            `${tool.category.padEnd(12)} ${tool.name.padEnd(20)} ${version.padEnd(12)} ${tool.commands.join(",") || "managed"}\n`,
          );
        }
      }
    }),
  ).pipe(Command.withDescription("Print the standard sandbox tool manifest"));

  const toolsDoctor = Command.make("doctor", { trailing: trailingArguments }, ({ trailing }) =>
    Effect.gen(function* () {
      yield* rejectTrailingArguments(trailing);
      const { autoJson, runtime } = yield* commandContext();
      const processRunner = yield* ProcessRunner;
      const tools = [];
      for (const tool of STANDARD_TOOLSET.tools) {
        const result = yield* processRunner
          .run([...tool.probe])
          .pipe(
            Effect.catch(() =>
              Effect.succeed({ exitCode: 127, stdout: "", stderr: "command not found" }),
            ),
          );
        const output = probeOutput(result.stdout, result.stderr);
        const versionMatches =
          tool.expectedVersion === undefined || output.includes(tool.expectedVersion);
        const status =
          result.exitCode === 127
            ? "missing"
            : result.exitCode !== 0
              ? "failed"
              : versionMatches
                ? "ok"
                : "version-mismatch";
        tools.push({
          name: tool.name,
          status,
          version: output || null,
          expectedVersion: tool.expectedVersion ?? null,
        });
      }
      const report = {
        toolset: STANDARD_TOOLSET.name,
        ok: tools.every((tool) => tool.status === "ok"),
        tools,
      };
      if (autoJson) outputJson(runtime.stdout, report);
      else {
        for (const tool of tools)
          runtime.stdout(
            `${tool.status.padEnd(16)} ${tool.name.padEnd(20)} ${tool.version ?? "no output"}${tool.expectedVersion ? ` (expected ${tool.expectedVersion})` : ""}\n`,
          );
      }
      if (!report.ok) yield* setExitCode(EXIT.GENERIC);
    }),
  ).pipe(Command.withDescription("Verify the standard sandbox tools"));

  const tools = Command.make("tools").pipe(
    Command.withDescription("Inspect the standard sandbox tools"),
    Command.withSubcommands([toolsList, toolsDoctor]),
  );

  const sessionOperation = Effect.fnUntraced(function* (
    command: "snapshot" | "resume" | "vaporize",
    id: string,
    yes: boolean,
  ) {
    const { autoJson, options, runtime } = yield* commandContext();
    const sessionId = yield* validateSessionId(id);
    if (command === "vaporize" && runtime.stdoutIsTTY && runtime.stdinIsTTY && !yes) {
      const answer = runtime.prompt(
        `Permanently vaporize ${sessionId}? Type ${sessionId} to confirm: `,
      );
      if (answer !== sessionId)
        return yield* new CliError(
          "cancelled",
          "Vaporize cancelled",
          "Pass --yes to skip confirmation.",
          EXIT.USAGE,
        );
    }
    const auth = yield* credentials(options);
    const path = `/api/sessions/${encodeURIComponent(sessionId)}${command === "vaporize" ? "" : `/${command}`}`;
    const method = command === "vaporize" ? "DELETE" : "POST";
    const raw = yield* requestJson(auth, path, { method });
    let result: JsonObject;
    if (command === "vaporize") {
      const decoded = decodeVaporizeResponse(raw);
      if (Option.isNone(decoded) || decoded.value.id !== sessionId)
        return yield* new CliError(
          "invalid_response",
          "Server returned an invalid vaporize result",
          "Inspect the Worker before assuming resources were deleted.",
          EXIT.GENERIC,
        );
      result = { id: sessionId, status: "gone" };
    } else {
      const decoded = decodeOperationResponse(raw);
      if (Option.isNone(decoded)) return yield* invalidResponse();
      result = {
        id: optionalString(decoded.value.id) ?? sessionId,
        status: decoded.value.status,
      };
      const url = optionalString(decoded.value.url);
      const branch = optionalString(decoded.value.branch);
      const backupId = optionalString(decoded.value.backupId);
      if (url) result.url = yield* Effect.fromResult(sanitizeUrl(url, auth.host, sessionId));
      if (branch) result.branch = branch;
      if (backupId) result.backupId = backupId;
    }
    if (autoJson) outputJson(runtime.stdout, result);
    else runtime.stdout(humanResult(command, result));
  });

  const snapshot = Command.make(
    "snapshot",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
      trailing: trailingArguments,
    },
    ({ id, trailing }) =>
      rejectTrailingArguments(trailing).pipe(
        Effect.andThen(sessionOperation("snapshot", id, false)),
      ),
  ).pipe(Command.withDescription("Checkpoint a warm session"));

  const resume = Command.make(
    "resume",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
      trailing: trailingArguments,
    },
    ({ id, trailing }) =>
      rejectTrailingArguments(trailing).pipe(Effect.andThen(sessionOperation("resume", id, false))),
  ).pipe(Command.withDescription("Restore a sleeping session"));

  const down = Command.make(
    "down",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
      trailing: trailingArguments,
    },
    ({ id, trailing }) =>
      Effect.gen(function* () {
        yield* rejectTrailingArguments(trailing);
        const { autoJson, options, runtime } = yield* commandContext();
        const sessionId = yield* validateSessionId(id);
        const result = yield* handleDown(sessionId, options);
        if (autoJson) outputJson(runtime.stdout, result);
        else runtime.stdout(humanResult("down", result));
      }),
  ).pipe(Command.withDescription("Fetch the branch and install the local rollout"));

  const vaporize = Command.make(
    "vaporize",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Skip the TTY confirmation")),
      trailing: trailingArguments,
    },
    ({ id, trailing, yes }) =>
      rejectTrailingArguments(trailing).pipe(Effect.andThen(sessionOperation("vaporize", id, yes))),
  ).pipe(Command.withDescription("Permanently delete a session"));

  return scotty.pipe(
    Command.withSubcommands([
      init,
      beam,
      list,
      attach,
      owner,
      snapshot,
      resume,
      down,
      vaporize,
      skills,
      tools,
    ]),
  );
};

export const execute = Effect.fnUntraced(function* (rawArgs: ReadonlyArray<string>) {
  const runtime = yield* CliRuntime;
  const exitCode = yield* Ref.make<ExitCode>(EXIT.OK);
  const parserStdout: string[] = [];
  const parserStderr: string[] = [];
  const command = makeScottyCommand((code) => Ref.set(exitCode, code));
  const executed = yield* Effect.result(
    Command.runWith(command, { version: VERSION })(rawArgs).pipe(
      Effect.provide(CliConfig.layer({ builtIns: [GlobalFlag.Help] })),
      Effect.provideService(Console.Console, captureConsole(parserStdout, parserStderr)),
    ),
  );

  if (Result.isSuccess(executed)) {
    flushCapturedOutput(runtime.stdout, runtime.stderr, parserStdout, parserStderr);
    return yield* Ref.get(exitCode);
  }

  const error = executed.failure;
  if (!EffectCliError.isCliError(error)) return yield* Effect.fail(error);
  if (Predicate.isTagged(error, "ShowHelp")) {
    if (error.errors.length === 0) {
      flushCapturedOutput(runtime.stdout, runtime.stderr, parserStdout, parserStderr);
      return yield* Ref.get(exitCode);
    }
    return yield* parserUsage(error);
  }
  // oxlint-disable-next-line scotty/no-unknown-error-message -- boundary: isCliError narrows the public Effect CLI error union
  return yield* usage(error.message);
});
