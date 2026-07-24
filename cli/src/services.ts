import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Context, Effect, Layer } from "effect";
import { CliError, EXIT, type Writer } from "./core";

export interface CliDependencies {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  stdout: Writer;
  stderr: Writer;
  prompt: (label: string) => string | null;
  openBrowser: (url: string) => Promise<void>;
  run: (command: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

interface CliRuntimeShape {
  readonly env: Record<string, string | undefined>;
  readonly home: string;
  readonly cwd: string;
  readonly stdoutIsTTY: boolean;
  readonly stdinIsTTY: boolean;
  readonly stdout: Writer;
  readonly stderr: Writer;
  readonly prompt: (label: string) => string | null;
}

export class CliRuntime extends Context.Service<CliRuntime, CliRuntimeShape>()(
  "scotty/cli/CliRuntime",
) {}

interface HttpTransportShape {
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<Response, CliError>;
}

export class HttpTransport extends Context.Service<HttpTransport, HttpTransportShape>()(
  "scotty/cli/HttpTransport",
) {}

interface ProcessRunnerShape {
  readonly run: (
    command: ReadonlyArray<string>,
  ) => Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, CliError>;
}

export class ProcessRunner extends Context.Service<ProcessRunner, ProcessRunnerShape>()(
  "scotty/cli/ProcessRunner",
) {}

interface BrowserLauncherShape {
  readonly open: (url: string) => Effect.Effect<void, CliError>;
}

export class BrowserLauncher extends Context.Service<BrowserLauncher, BrowserLauncherShape>()(
  "scotty/cli/BrowserLauncher",
) {}

interface FileSystemShape {
  readonly readText: (path: string) => Effect.Effect<string, NodeJS.ErrnoException>;
  readonly remove: (path: string) => Effect.Effect<void, NodeJS.ErrnoException>;
  readonly writeExclusive: (
    path: string,
    data: string,
  ) => Effect.Effect<void, NodeJS.ErrnoException>;
  readonly writeText: (path: string, data: string) => Effect.Effect<void, CliError>;
  readonly writeSecure: (path: string, data: string) => Effect.Effect<void, CliError>;
  readonly appendOnce: (
    path: string,
    marker: string,
    content: string,
  ) => Effect.Effect<boolean, CliError>;
}

export class FileSystem extends Context.Service<FileSystem, FileSystemShape>()(
  "scotty/cli/FileSystem",
) {}

const unexpected = (): CliError =>
  new CliError(
    "internal_error",
    "Scotty failed unexpectedly",
    "Retry with --json; if it persists, inspect the local error and Worker logs.",
    EXIT.GENERIC,
  );

const networkFailure = (): CliError =>
  new CliError(
    "network_error",
    "Could not reach the Scotty Worker",
    "Check --host and your network, then retry.",
    EXIT.GENERIC,
  );

const errno = (cause: unknown): NodeJS.ErrnoException => cause as NodeJS.ErrnoException;

const hostPromise = <A>(operation: () => Promise<A>): Effect.Effect<A, CliError> =>
  Effect.tryPromise({ try: operation, catch: unexpected });

const withFile = <A>(
  path: string,
  flags: string,
  mode: number,
  use: (file: Awaited<ReturnType<typeof open>>) => Effect.Effect<A, CliError>,
): Effect.Effect<A, CliError> =>
  Effect.acquireUseRelease(
    hostPromise(() => open(path, flags, mode)),
    use,
    (file) => Effect.promise(() => file.close()),
  );

const writeSecure = Effect.fnUntraced(function* (path: string, data: string) {
  yield* hostPromise(() => mkdir(dirname(path), { recursive: true }));
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  yield* withFile(temporary, "wx", 0o600, (file) =>
    hostPromise(() => file.writeFile(data, "utf8")).pipe(
      Effect.andThen(hostPromise(() => file.sync())),
    ),
  );
  yield* hostPromise(() => chmod(temporary, 0o600));
  yield* hostPromise(() => rename(temporary, path));
  yield* hostPromise(() => chmod(path, 0o600));
});

const appendOnce = Effect.fnUntraced(function* (path: string, marker: string, content: string) {
  const existing = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: errno,
  }).pipe(
    Effect.catch((error) =>
      error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(unexpected()),
    ),
  );
  if (existing.includes(marker)) return false;
  const next = existing.length === 0 ? content : `${existing.replace(/\s*$/, "")}\n\n${content}`;
  yield* hostPromise(() => mkdir(dirname(path), { recursive: true }));
  yield* withFile(path, "w", 0o644, (file) => hostPromise(() => file.writeFile(next, "utf8")));
  return true;
});

export const defaultDependencies = (): CliDependencies => ({
  // oxlint-disable-next-line scotty/no-raw-fetch -- boundary: CliDependencies captures native fetch for the interruptible CLI host adapter
  fetch: globalThis.fetch,
  env: process.env,
  home: homedir(),
  cwd: process.cwd(),
  stdoutIsTTY: Boolean(process.stdout.isTTY),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  prompt: (label) => globalThis.prompt(label),
  openBrowser: async (url) => {
    const command =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
    const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    const code = await child.exited;
    if (code !== 0) {
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: CliDependencies preserves the Promise-rejection host contract for injected browser openers
      throw new CliError(
        "browser_open_failed",
        "Could not open the session browser",
        "Open the session URL manually.",
        EXIT.GENERIC,
      );
    }
  },
  run: async (command) => {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", cwd: process.cwd() });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  },
});

export const cliLayer = (
  overrides: Partial<CliDependencies>,
): Layer.Layer<CliRuntime | HttpTransport | ProcessRunner | BrowserLauncher | FileSystem> => {
  const dependencies = { ...defaultDependencies(), ...overrides };
  return Layer.mergeAll(
    Layer.succeed(CliRuntime)({
      env: dependencies.env,
      home: dependencies.home,
      cwd: dependencies.cwd,
      stdoutIsTTY: dependencies.stdoutIsTTY,
      stdinIsTTY: dependencies.stdinIsTTY,
      stdout: dependencies.stdout,
      stderr: dependencies.stderr,
      prompt: dependencies.prompt,
    }),
    Layer.succeed(HttpTransport)({
      fetch: (input, init) =>
        Effect.tryPromise({
          try: (signal) => dependencies.fetch(input, { ...init, signal }),
          catch: networkFailure,
        }),
    }),
    Layer.succeed(ProcessRunner)({
      run: (command) =>
        Effect.tryPromise({
          try: () => dependencies.run([...command]),
          catch: unexpected,
        }),
    }),
    Layer.succeed(BrowserLauncher)({
      open: (url) =>
        Effect.tryPromise({
          try: () => dependencies.openBrowser(url),
          catch: unexpected,
        }),
    }),
    Layer.succeed(FileSystem)({
      readText: (path) => Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: errno }),
      remove: (path) => Effect.tryPromise({ try: () => unlink(path), catch: errno }),
      writeExclusive: (path, data) =>
        Effect.tryPromise({
          try: () => mkdir(dirname(path), { recursive: true }),
          catch: errno,
        }).pipe(
          Effect.andThen(
            Effect.acquireUseRelease(
              Effect.tryPromise({ try: () => open(path, "wx", 0o600), catch: errno }),
              (file) =>
                Effect.tryPromise({ try: () => file.writeFile(data, "utf8"), catch: errno }).pipe(
                  Effect.andThen(Effect.tryPromise({ try: () => file.sync(), catch: errno })),
                ),
              (file) => Effect.promise(() => file.close()),
            ),
          ),
        ),
      writeText: (path, data) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true });
            await Bun.write(path, data);
          },
          catch: unexpected,
        }),
      writeSecure,
      appendOnce,
    }),
  );
};
