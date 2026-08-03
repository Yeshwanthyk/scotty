import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Context, Effect, Layer } from "effect";
import lockfile from "proper-lockfile";
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
  createInstallation: (request: InstallationCreateRequest) => Promise<InstallationResult>;
  planInstallation: (request: InstallationDeployRequest) => Promise<InstallationPlan>;
  deployInstallation: (request: InstallationApplyRequest) => Promise<InstallationResult>;
  inspectInstallation: (request: InstallationInspectRequest) => Promise<InstallationResult>;
  recoverInstallation: (request: InstallationRecoverRequest) => Promise<InstallationResult>;
  uninstallInstallation: (
    request: InstallationUninstallRequest,
  ) => Promise<InstallationUninstallResult>;
  upgradeCli: (request: CliUpgradeRequest) => Promise<CliUpgradeResult>;
}

export interface InstallationCreateRequest {
  readonly installationName: string;
  readonly profile: string;
  readonly token: string;
}

export interface InstallationDeployRequest {
  readonly installationName: string;
  readonly profile: string;
  readonly adoptionManifestPath?: string;
}

export interface InstallationApplyRequest extends InstallationDeployRequest {
  readonly expectedPlanFingerprint: string;
}

export interface InstallationInspectRequest {
  readonly installationName: string;
  readonly profile: string;
  readonly adoptionManifestPath?: string;
}

export interface InstallationRecoverRequest extends InstallationInspectRequest {
  readonly token: string;
  readonly expectedAccountId: string;
  readonly expectedWorkerName: string;
  readonly expectedRunnerWorkerName: string;
  readonly expectedContainerName: string;
  readonly expectedKvTitle: string;
  readonly expectedBackupBucketName: string;
}

export interface InstallationPlanChange {
  readonly id: string;
  readonly action:
    | "create"
    | "update"
    | "replace"
    | "delete"
    | "run"
    | "binding-create"
    | "binding-update"
    | "binding-delete";
}

export interface InstallationPlan {
  readonly installationName: string;
  readonly hasExistingResources: boolean;
  readonly fingerprint: string;
  readonly changes: ReadonlyArray<InstallationPlanChange>;
}

export interface InstallationUninstallRequest extends InstallationInspectRequest {
  readonly deleteData: boolean;
  readonly expectedAccountId: string;
  readonly expectedWorkerName: string;
  readonly expectedRunnerWorkerName: string;
  readonly expectedContainerName: string;
  readonly expectedKvTitle: string;
  readonly expectedBackupBucketName: string;
}

export interface InstallationUninstallResult {
  readonly installationName: string;
  readonly deletedCompute: ReadonlyArray<string>;
  readonly retainedData: ReadonlyArray<string>;
  readonly deletedData: ReadonlyArray<string>;
}

export interface CliUpgradeRequest {
  readonly currentVersion: string;
  readonly executablePath: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
}

export interface CliUpgradeResult {
  readonly previousVersion: string;
  readonly version: string;
  readonly updated: boolean;
}

export interface InstallationResult {
  readonly installationName: string;
  readonly profile: string;
  readonly stackName: string;
  readonly stage: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly runnerWorkerName: string;
  readonly containerName: string;
  readonly kvTitle: string;
  readonly backupBucketName: string;
  readonly host: string;
}

interface CliRuntimeShape {
  readonly hostFetch: (request: Request) => Promise<Response>;
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

interface InstallationCreatorShape {
  readonly create: (
    request: InstallationCreateRequest,
  ) => Effect.Effect<InstallationResult, CliError>;
}

export class InstallationCreator extends Context.Service<
  InstallationCreator,
  InstallationCreatorShape
>()("scotty/cli/InstallationCreator") {}

interface InstallationDeployerShape {
  readonly plan: (request: InstallationDeployRequest) => Effect.Effect<InstallationPlan, CliError>;
  readonly deploy: (
    request: InstallationApplyRequest,
  ) => Effect.Effect<InstallationResult, CliError>;
}

export class InstallationDeployer extends Context.Service<
  InstallationDeployer,
  InstallationDeployerShape
>()("scotty/cli/InstallationDeployer") {}

interface InstallationRecoveryShape {
  readonly inspect: (
    request: InstallationInspectRequest,
  ) => Effect.Effect<InstallationResult, CliError>;
  readonly recover: (
    request: InstallationRecoverRequest,
  ) => Effect.Effect<InstallationResult, CliError>;
}

export class InstallationRecovery extends Context.Service<
  InstallationRecovery,
  InstallationRecoveryShape
>()("scotty/cli/InstallationRecovery") {}

interface InstallationUninstallerShape {
  readonly uninstall: (
    request: InstallationUninstallRequest,
  ) => Effect.Effect<InstallationUninstallResult, CliError>;
}

export class InstallationUninstaller extends Context.Service<
  InstallationUninstaller,
  InstallationUninstallerShape
>()("scotty/cli/InstallationUninstaller") {}

interface CliUpgraderShape {
  readonly upgrade: (request: CliUpgradeRequest) => Effect.Effect<CliUpgradeResult, CliError>;
}

export class CliUpgrader extends Context.Service<CliUpgrader, CliUpgraderShape>()(
  "scotty/cli/CliUpgrader",
) {}

interface FileSystemShape {
  readonly withLock: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CliError, R>;
  readonly stat: (path: string) => Effect.Effect<Stats, CliError>;
  readonly readText: (path: string) => Effect.Effect<string, NodeJS.ErrnoException>;
  readonly readLockedText: (path: string) => Effect.Effect<string, CliError>;
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
    const configuredBrowser = process.env.BROWSER?.trim();
    const command = configuredBrowser
      ? [configuredBrowser, url]
      : process.platform === "darwin"
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
  createInstallation: async (request) => {
    const { createInstallation } = await import("./installation-deployment.ts");
    return createInstallation(request);
  },
  planInstallation: async (request) => {
    const { planInstallation } = await import("./installation-deployment.ts");
    return planInstallation(request);
  },
  deployInstallation: async (request) => {
    const { deployInstallation } = await import("./installation-deployment.ts");
    return deployInstallation(request);
  },
  inspectInstallation: async (request) => {
    const { inspectInstallation } = await import("./installation-deployment.ts");
    return inspectInstallation(request);
  },
  recoverInstallation: async (request) => {
    const { recoverInstallation } = await import("./installation-deployment.ts");
    return recoverInstallation(request);
  },
  uninstallInstallation: async (request) => {
    const { uninstallInstallation } = await import("./installation-deployment.ts");
    return uninstallInstallation(request);
  },
  upgradeCli: async (request) => {
    const { upgradeCli } = await import("./upgrade-host.ts");
    return upgradeCli(request);
  },
});

export const cliLayer = (
  overrides: Partial<CliDependencies>,
): Layer.Layer<
  | CliRuntime
  | HttpTransport
  | ProcessRunner
  | BrowserLauncher
  | FileSystem
  | InstallationCreator
  | InstallationDeployer
  | InstallationRecovery
  | InstallationUninstaller
  | CliUpgrader
> => {
  const dependencies = { ...defaultDependencies(), ...overrides };
  return Layer.mergeAll(
    Layer.succeed(CliRuntime)({
      hostFetch: (request) => dependencies.fetch(request),
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
    Layer.succeed(InstallationCreator)({
      create: (request) =>
        Effect.tryPromise({
          try: () => dependencies.createInstallation(request),
          catch: () =>
            new CliError(
              "installation_create_failed",
              "Could not create the Scotty installation",
              "Check Cloudflare authentication, Docker, and permissions, then retry scotty init.",
              EXIT.GENERIC,
            ),
        }),
    }),
    Layer.succeed(InstallationDeployer)({
      plan: (request) =>
        Effect.tryPromise({
          try: () => dependencies.planInstallation(request),
          catch: () =>
            new CliError(
              "installation_plan_failed",
              "Could not plan the Scotty deployment",
              "Check Cloudflare authentication and Docker, then retry scotty deploy.",
              EXIT.GENERIC,
            ),
        }),
      deploy: (request) =>
        Effect.tryPromise({
          try: () => dependencies.deployInstallation(request),
          catch: () =>
            new CliError(
              "installation_deploy_failed",
              "Could not deploy the Scotty installation",
              "Check Cloudflare authentication and Docker, then retry scotty deploy.",
              EXIT.GENERIC,
            ),
        }),
    }),
    Layer.succeed(CliUpgrader)({
      upgrade: (request) =>
        Effect.tryPromise({
          try: () => dependencies.upgradeCli(request),
          catch: () =>
            new CliError(
              "cli_upgrade_failed",
              "Could not upgrade the Scotty CLI",
              "Check GitHub access and the executable permissions, then retry.",
              EXIT.GENERIC,
            ),
        }),
    }),
    Layer.succeed(InstallationUninstaller)({
      uninstall: (request) =>
        Effect.tryPromise({
          try: () => dependencies.uninstallInstallation(request),
          catch: () =>
            new CliError(
              "installation_uninstall_failed",
              "Could not fully uninstall the Scotty installation",
              "Inspect Cloudflare resources, then rerun scotty uninstall with the same options.",
              EXIT.GENERIC,
            ),
        }),
    }),
    Layer.succeed(InstallationRecovery)({
      inspect: (request) =>
        Effect.tryPromise({
          try: () => dependencies.inspectInstallation(request),
          catch: () =>
            new CliError(
              "installation_inspection_failed",
              "Could not find the Scotty installation",
              "Check the installation name, Cloudflare profile, and resource mapping, then retry.",
              EXIT.NOT_FOUND,
            ),
        }),
      recover: (request) =>
        Effect.tryPromise({
          try: () => dependencies.recoverInstallation(request),
          catch: () =>
            new CliError(
              "installation_recovery_failed",
              "Could not recover the Scotty installation",
              "Check the installation name, Cloudflare profile, and permissions, then retry.",
              EXIT.GENERIC,
            ),
        }),
    }),
    Layer.succeed(FileSystem)({
      withLock: (path, effect) =>
        hostPromise(() => mkdir(dirname(path), { recursive: true })).pipe(
          Effect.andThen(
            Effect.acquireUseRelease(
              hostPromise(() =>
                lockfile.lock(path, {
                  realpath: false,
                  retries: { retries: 10, factor: 2, minTimeout: 50, maxTimeout: 1_000 },
                }),
              ),
              () => effect,
              (release) => Effect.promise(() => release()),
            ),
          ),
        ),
      stat: (path) => hostPromise(() => stat(path)),
      readText: (path) => Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: errno }),
      readLockedText: (path) =>
        Effect.acquireUseRelease(
          hostPromise(() =>
            lockfile.lock(path, {
              realpath: false,
              retries: { retries: 10, factor: 2, minTimeout: 50, maxTimeout: 1_000 },
            }),
          ),
          () => hostPromise(() => readFile(path, "utf8")),
          (release) => Effect.promise(() => release()),
        ),
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
