import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
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
  planCreateInstallation: (request: InstallationDeployRequest) => Promise<InstallationPlan>;
  planInstallation: (request: InstallationDeployRequest) => Promise<InstallationPlan>;
  deployInstallation: (request: InstallationApplyRequest) => Promise<InstallationResult>;
  inspectInstallation: (request: InstallationInspectRequest) => Promise<InstallationResult>;
  recoverInstallation: (request: InstallationRecoverRequest) => Promise<InstallationResult>;
  uninstallInstallation: (
    request: InstallationUninstallRequest,
  ) => Promise<InstallationUninstallResult>;
  upgradeCli: (request: CliUpgradeRequest) => Promise<CliUpgradeResult>;
  inspectPiAuthTarget: (request: PiAuthTargetRequest) => Promise<PiAuthTargetResult>;
  uploadPiAuthSecret: (request: PiAuthUploadRequest) => Promise<PiAuthTargetResult>;
}

export interface InstallationCreateRequest {
  readonly installationName: string;
  readonly profile: string;
  readonly token: string;
  readonly expectedAccountId: string;
  readonly expectedPlanFingerprint: string;
  readonly mode: "fresh" | "resume";
}

export interface InstallationDeployRequest {
  readonly installationName: string;
  readonly profile: string;
  readonly adoptionManifestPath?: string;
  readonly previewBase?: string;
  readonly previewZoneId?: string;
}

export interface InstallationApplyRequest extends InstallationDeployRequest {
  readonly expectedAccountId: string;
  readonly expectedPlanFingerprint: string;
}

export interface InstallationInspectRequest {
  readonly installationName: string;
  readonly profile: string;
  readonly adoptionManifestPath?: string;
  readonly previewBase?: string;
  readonly previewZoneId?: string;
}

export interface InstallationRecoverRequest extends InstallationInspectRequest {
  readonly token: string;
  readonly expectedAccountId: string;
  readonly expectedWorkerName: string;
  readonly expectedRunnerWorkerName: string;
  readonly expectedContainerName: string;
  readonly expectedKvTitle: string;
  readonly expectedBackupBucketName: string;
  readonly expectedPreviewBase?: string;
  readonly expectedPreviewZoneId?: string;
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
  readonly accountId: string;
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
  readonly expectedPreviewBase?: string;
  readonly expectedPreviewZoneId?: string;
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

export interface PiAuthTargetRequest {
  readonly profile: string;
  readonly expectedAccountId: string;
  readonly expectedWorkerName: string;
  readonly expectedRunnerWorkerName: string;
  readonly expectedContainerName: string;
  readonly expectedKvTitle: string;
  readonly expectedBackupBucketName: string;
  readonly expectedHost: string;
}

export interface PiAuthUploadRequest extends PiAuthTargetRequest {
  readonly json: string;
}

export interface PiAuthTargetResult {
  readonly accountId: string;
  readonly workerName: string;
  readonly host: string;
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
  readonly previewBase?: string;
  readonly previewZoneId?: string;
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

interface PiAuthSecretManagerShape {
  readonly inspect: (request: PiAuthTargetRequest) => Effect.Effect<PiAuthTargetResult, CliError>;
  readonly upload: (request: PiAuthUploadRequest) => Effect.Effect<PiAuthTargetResult, CliError>;
}

export class PiAuthSecretManager extends Context.Service<
  PiAuthSecretManager,
  PiAuthSecretManagerShape
>()("scotty/cli/PiAuthSecretManager") {}

interface InstallationCreatorShape {
  readonly plan: (request: InstallationDeployRequest) => Effect.Effect<InstallationPlan, CliError>;
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

export class PrivateFileError extends Data.TaggedError("PrivateFileError")<{
  readonly path: string;
  readonly reason: "missing" | "not_file" | "permissions" | "symlink" | "read_failed";
}> {}

interface FileSystemShape {
  readonly withLock: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CliError, R>;
  readonly stat: (path: string) => Effect.Effect<Stats, CliError>;
  readonly readText: (path: string) => Effect.Effect<string, NodeJS.ErrnoException>;
  readonly readPrivateText: (path: string) => Effect.Effect<string, PrivateFileError>;
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

const privateFileFailure = (path: string, reason: PrivateFileError["reason"]): PrivateFileError =>
  new PrivateFileError({ path, reason });

const privateFileSystemFailure = (path: string, cause: unknown): PrivateFileError => {
  const code = errno(cause).code;
  if (code === "ENOENT") return privateFileFailure(path, "missing");
  if (code === "ELOOP") return privateFileFailure(path, "symlink");
  return privateFileFailure(path, "read_failed");
};

const validatePrivateMetadata = (
  path: string,
  metadata: Stats,
): Effect.Effect<void, PrivateFileError> => {
  if (metadata.isSymbolicLink()) return Effect.fail(privateFileFailure(path, "symlink"));
  if (!metadata.isFile()) return Effect.fail(privateFileFailure(path, "not_file"));
  if (
    process.platform !== "win32" &&
    ((metadata.mode & 0o077) !== 0 ||
      (typeof process.geteuid === "function" && metadata.uid !== process.geteuid()))
  )
    return Effect.fail(privateFileFailure(path, "permissions"));
  return Effect.void;
};

const readPrivateText = Effect.fnUntraced(function* (path: string) {
  const pathMetadata = yield* Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) => privateFileSystemFailure(path, cause),
  });
  yield* validatePrivateMetadata(path, pathMetadata);
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(path, flags),
      catch: (cause) => privateFileSystemFailure(path, cause),
    }),
    (file) =>
      Effect.gen(function* () {
        const openedMetadata = yield* Effect.tryPromise({
          try: () => file.stat(),
          catch: (cause) => privateFileSystemFailure(path, cause),
        });
        yield* validatePrivateMetadata(path, openedMetadata);
        if (pathMetadata.dev !== openedMetadata.dev || pathMetadata.ino !== openedMetadata.ino)
          return yield* privateFileFailure(path, "symlink");
        return yield* Effect.tryPromise({
          try: () => file.readFile("utf8"),
          catch: (cause) => privateFileSystemFailure(path, cause),
        });
      }),
    (file) => Effect.promise(() => file.close()),
  );
});

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
  planCreateInstallation: async (request) => {
    const { planCreateInstallation } = await import("./installation-deployment.ts");
    return planCreateInstallation(request);
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
  inspectPiAuthTarget: async (request) => {
    const { inspectPiAuthTarget } = await import("./installation-deployment.ts");
    return inspectPiAuthTarget(request);
  },
  uploadPiAuthSecret: async (request) => {
    const { uploadPiAuthSecret } = await import("./installation-deployment.ts");
    return uploadPiAuthSecret(request);
  },
});

export const cliLayer = (
  overrides: Partial<CliDependencies>,
): Layer.Layer<
  | CliRuntime
  | HttpTransport
  | ProcessRunner
  | BrowserLauncher
  | PiAuthSecretManager
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
    Layer.succeed(PiAuthSecretManager)({
      inspect: (request) =>
        Effect.tryPromise({
          try: () => dependencies.inspectPiAuthTarget(request),
          catch: () =>
            new CliError(
              "pi_auth_target_failed",
              "Could not verify the managed Pi auth destination",
              "Check the saved Cloudflare profile, account, Worker, and origin.",
              EXIT.GENERIC,
            ),
        }),
      upload: (request) =>
        Effect.tryPromise({
          try: () => dependencies.uploadPiAuthSecret(request),
          catch: () =>
            new CliError(
              "pi_auth_upload_failed",
              "Could not upload PI_AUTH_JSON to the managed Worker",
              "The upload may have succeeded. Run scotty auth status before retrying.",
              EXIT.GENERIC,
            ),
        }),
    }),
    Layer.succeed(InstallationCreator)({
      plan: (request) =>
        Effect.tryPromise({
          try: () => dependencies.planCreateInstallation(request),
          catch: () =>
            new CliError(
              "installation_create_plan_failed",
              "Could not plan the Scotty installation",
              "Check Cloudflare authentication, Docker, and permissions, then retry scotty init.",
              EXIT.GENERIC,
            ),
        }),
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
      readPrivateText,
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
