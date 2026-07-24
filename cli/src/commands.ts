import { join } from "node:path";
import { Effect, Option, Result } from "effect";
import { CliError, EXIT, VERSION, type JsonObject } from "./core";
import { clearPendingUp, credentials, pendingUpRequest, secureWrite } from "./dependencies";
import { handleDown } from "./archive";
import {
  decodeOperationResponse,
  decodeSessionsResponse,
  decodeVaporizeResponse,
  STANDARD_TOOLSET,
} from "./schemas";
import {
  assertNoFlags,
  browserUrl,
  COMMAND_HELP,
  durationSeconds,
  EMBEDDED_SKILL,
  humanResult,
  humanSession,
  invalidResponse,
  normalizeHost,
  optionalString,
  outputJson,
  parseGlobal,
  probeOutput,
  requireId,
  ROOT_HELP,
  sanitizeUrl,
  stableSession,
  stableUp,
  takeBoolean,
  takeValue,
  usage,
} from "./pure";
import { requestJson } from "./transport";
import { BrowserLauncher, CliRuntime, ProcessRunner } from "./services";

export const handleTools = Effect.fnUntraced(function* (args: string[], json: boolean) {
  const runtime = yield* CliRuntime;
  const processRunner = yield* ProcessRunner;
  yield* Effect.fromResult(assertNoFlags(args));
  if (args.length !== 1 || (args[0] !== "list" && args[0] !== "doctor"))
    return yield* usage(
      "Usage: scotty tools <list | doctor>",
      "Run scotty tools --help for examples.",
    );

  if (args[0] === "list") {
    if (json) outputJson(runtime.stdout, STANDARD_TOOLSET);
    else {
      runtime.stdout(`standard toolset (${STANDARD_TOOLSET.tools.length} tools)\n`);
      for (const tool of STANDARD_TOOLSET.tools) {
        const version = tool.expectedVersion ?? tool.versionPolicy;
        runtime.stdout(
          `${tool.category.padEnd(12)} ${tool.name.padEnd(20)} ${version.padEnd(12)} ${tool.commands.join(",") || "managed"}\n`,
        );
      }
    }
    return EXIT.OK;
  }

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
  if (json) outputJson(runtime.stdout, report);
  else {
    for (const tool of tools)
      runtime.stdout(
        `${tool.status.padEnd(16)} ${tool.name.padEnd(20)} ${tool.version ?? "no output"}${tool.expectedVersion ? ` (expected ${tool.expectedVersion})` : ""}\n`,
      );
  }
  return report.ok ? EXIT.OK : EXIT.GENERIC;
});

export const execute = Effect.fnUntraced(function* (rawArgs: string[]) {
  const runtime = yield* CliRuntime;
  const browser = yield* BrowserLauncher;
  const { args, options } = yield* Effect.fromResult(parseGlobal(rawArgs));
  const command = args.shift();
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    (command === "help" && args.length === 0)
  ) {
    runtime.stdout(`${ROOT_HELP}\n`);
    return EXIT.OK;
  }
  if (command === "--version" || command === "-V" || command === "version") {
    runtime.stdout(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (command === "help") {
    const target = args[0];
    if (!target || args.length !== 1 || !COMMAND_HELP[target])
      return yield* usage("Unknown help topic");
    runtime.stdout(`${COMMAND_HELP[target]}\n`);
    return EXIT.OK;
  }
  const helpIndex = args.findIndex((arg) => arg === "--help" || arg === "-h");
  if (helpIndex >= 0) {
    if (!COMMAND_HELP[command]) return yield* usage(`Unknown command: ${command}`);
    runtime.stdout(`${COMMAND_HELP[command]}\n`);
    return EXIT.OK;
  }
  if (command === "skills") {
    if (options.json)
      return yield* usage(
        "scotty skills emits Markdown and does not support --json",
        "Run scotty skills without flags.",
      );
    yield* Effect.fromResult(assertNoFlags(args));
    if (args.length) return yield* usage(`Unexpected argument: ${args[0]}`);
    runtime.stdout(EMBEDDED_SKILL);
    return EXIT.OK;
  }
  const autoJson = options.json || !runtime.stdoutIsTTY;
  if (command === "tools") return yield* handleTools(args, autoJson);
  if (command === "init") {
    yield* Effect.fromResult(assertNoFlags(args));
    if (args.length) return yield* usage(`Unexpected argument: ${args[0]}`);
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
    return EXIT.OK;
  }
  if (!COMMAND_HELP[command]) return yield* usage(`Unknown command: ${command}`);

  if (command === "attach") {
    const id = yield* Effect.fromResult(requireId(args, command));
    const auth = yield* credentials(options);
    const safeUrl = `${auth.host}/s/${encodeURIComponent(id)}`;
    const targetUrl = yield* Effect.fromResult(browserUrl(undefined, auth.host, auth.token, id));
    yield* browser.open(targetUrl);
    const result = { id, url: safeUrl, opened: true };
    if (autoJson) outputJson(runtime.stdout, result);
    else runtime.stdout(humanResult(command, result));
    return EXIT.OK;
  }

  if (command === "ls") {
    yield* Effect.fromResult(assertNoFlags(args));
    if (args.length) return yield* usage(`Unexpected argument: ${args[0]}`);
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
    return EXIT.OK;
  }

  if (command === "up") {
    const repo = yield* Effect.fromResult(takeValue(args, "--repo"));
    const cap = yield* Effect.fromResult(takeValue(args, "--cap"));
    const detach = takeBoolean(args, "--detach");
    yield* Effect.fromResult(assertNoFlags(args));
    if (args.length !== 1 || !args[0].trim())
      return yield* usage(
        'Usage: scotty up "PROMPT"',
        "Run scotty up --help for flags and examples.",
      );
    if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
      return yield* usage("--repo must be OWNER/NAME");
    const auth = yield* credentials(options);
    const body: JsonObject = { prompt: args[0] };
    if (repo) body.repo = repo;
    if (cap) {
      body.cap = cap;
      body.hardCapSeconds = yield* Effect.fromResult(durationSeconds(cap));
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
        yield* Effect.fromResult(browserUrl(decoded.terminalUrl, auth.host, auth.token, result.id)),
      );
    if (autoJson) outputJson(runtime.stdout, result);
    else runtime.stdout(humanResult(command, result));
    return EXIT.OK;
  }

  if (command === "down") {
    const id = yield* Effect.fromResult(requireId(args, command));
    const result = yield* handleDown(id, options);
    if (autoJson) outputJson(runtime.stdout, result);
    else runtime.stdout(humanResult(command, result));
    return EXIT.OK;
  }

  const yes = command === "vaporize" ? takeBoolean(args, "--yes") : false;
  const id = yield* Effect.fromResult(requireId(args, command));
  if (command === "vaporize" && runtime.stdoutIsTTY && runtime.stdinIsTTY && !yes) {
    const answer = runtime.prompt(`Permanently vaporize ${id}? Type ${id} to confirm: `);
    if (answer !== id)
      return yield* new CliError(
        "cancelled",
        "Vaporize cancelled",
        "Pass --yes to skip confirmation.",
        EXIT.USAGE,
      );
  }
  const auth = yield* credentials(options);
  const path = `/api/sessions/${encodeURIComponent(id)}${command === "vaporize" ? "" : `/${command}`}`;
  const method = command === "vaporize" ? "DELETE" : "POST";
  const raw = yield* requestJson(auth, path, { method });
  let result: JsonObject;
  if (command === "vaporize") {
    const decoded = decodeVaporizeResponse(raw);
    if (Option.isNone(decoded) || decoded.value.id !== id)
      return yield* new CliError(
        "invalid_response",
        "Server returned an invalid vaporize result",
        "Inspect the Worker before assuming resources were deleted.",
        EXIT.GENERIC,
      );
    result = { id: id, status: "gone" };
  } else {
    const decoded = decodeOperationResponse(raw);
    if (Option.isNone(decoded)) return yield* invalidResponse();
    result = { id: optionalString(decoded.value.id) ?? id, status: decoded.value.status };
    const url = optionalString(decoded.value.url);
    const branch = optionalString(decoded.value.branch);
    const backupId = optionalString(decoded.value.backupId);
    if (url) result.url = yield* Effect.fromResult(sanitizeUrl(url, auth.host, id));
    if (branch) result.branch = branch;
    if (backupId) result.backupId = backupId;
  }
  if (autoJson) outputJson(runtime.stdout, result);
  else runtime.stdout(humanResult(command, result));
  return EXIT.OK;
});
