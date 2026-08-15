import { isAbsolute, join } from "node:path";
import { Clock, Console, Effect, FileSystem, Option, Predicate, Ref, Result } from "effect";
import {
  Argument,
  CliConfig,
  CliError as EffectCliError,
  CliOutput,
  Command,
  Flag,
  GlobalFlag,
} from "effect/unstable/cli";
import { handleDown } from "./archive";
import { CliError, EXIT, VERSION, type ExitCode, type GlobalOptions, type Writer } from "./core";
import {
  clearPendingUp,
  credentials,
  pendingUpRequest,
  readConfig,
  secureWrite,
} from "./dependencies";
import {
  decodeInitJournalJson,
  decodeInspectResponse,
  decodeOperationResponse,
  decodePiAuthReseedResponse,
  decodePiAuthStatusResponse,
  decodeRunnerRegistrationResponse,
  decodeRunnerRemovalResponse,
  decodeRunnerStatusesResponse,
  decodeSessionsResponse,
  decodeSteerResponse,
  decodeVaporizeResponse,
  STANDARD_TOOLSET,
  type AttachOutput,
  type BeamUpRequest,
  type SessionOperationOutput,
  type VaporizeOutput,
} from "./schemas";
import { readLocalPiAuth } from "./pi-auth";
import { makeInstallationPiAuthRecord } from "../../protocol/pi-auth";
import { isRepositoryIdentity } from "../../protocol/repository";
import {
  browserUrl,
  durationSeconds,
  humanInspect,
  humanResult,
  humanSession,
  humanSteer,
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
import { encodeSandboxSyncJson, formatSandboxSync, sandboxSyncOutput } from "./sandbox-bundle";
import {
  formatSandboxStatus,
  loadSandboxConfig,
  localSandboxStatus,
  sandboxConfigPath,
  saveSandboxConfig,
} from "./sandbox-config";
import { synchronizeLocalSandbox, type SandboxSyncTarget } from "./sandbox-sync";
import {
  addPiPackageSource,
  addSkillSource,
  classifySandboxSource,
  mutateSandboxConfig,
  readSkillDirectoryName,
  removeSandboxSource,
} from "./sandbox-sources";
import {
  BrowserLauncher,
  CliRuntime,
  CliUpgrader,
  FileSystem as CliFileSystem,
  GitResolver,
  InstallationCreator,
  InstallationDeployer,
  InstallationRecovery,
  InstallationUninstaller,
  PiAuthSecretManager,
  ProcessRunner,
  type InstallationResult,
} from "./services";
import { runRunnerSupervisor } from "./runner-link";
import { RunnerRuntime, runnerRuntimeLayer } from "./runner-runtime";
import { setupRunner } from "./runner-setup";
import { requestJson } from "./transport";
import {
  decodeInstallationPreviewConfiguration,
  makeInstallationTopology,
  parseInstallationName,
} from "../../infra/installation.ts";
import { TuiError, safeErrorMessage } from "../../tui/src/errors.ts";
import { pairTuiClient, runTuiConsole } from "../../tui/src/main.ts";
import { PI_CONSOLE_MAX_STRING_BYTES } from "../../protocol/pi-console.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SANDBOX_PEER_HOST = "https://scotty.internal";
const RUNNER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RUNNER_IMAGE_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/;
const RUNNER_CONTAINER_PATH = "/usr/local/bin:/usr/bin:/bin";
const RUNNER_CHILD_ENV_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
] as const;
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

const tuiFailure = (error: unknown): CliError => {
  const message = safeErrorMessage(error);
  // oxlint-disable-next-line scotty/no-instanceof-tagged-error -- boundary: translate the TUI Promise adapter's declared host error
  const tuiError = error instanceof TuiError ? error : undefined;
  if (tuiError?.code === "input_invalid") return usage(message);
  return new CliError(
    tuiError?.code ?? "tui_failed",
    message,
    "Check the paired-client configuration and retry.",
    EXIT.GENERIC,
  );
};

const synchronizeInstallationSandbox = Effect.fnUntraced(function* (
  home: string,
  target: SandboxSyncTarget,
) {
  return yield* synchronizeLocalSandbox({ home, target }).pipe(
    Effect.mapError((failure) =>
      failure.hint.includes("sandbox sync")
        ? failure
        : new CliError(
            failure.code,
            failure.message,
            "Retry scotty sandbox sync.",
            failure.exitCode,
          ),
    ),
  );
});

const runnerChildEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const childEnvironment: Record<string, string> = {};
  for (const key of RUNNER_CHILD_ENV_KEYS) {
    const value = environment[key];
    if (value !== undefined) childEnvironment[key] = value;
  }
  return childEnvironment;
};

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "::1" ||
  hostname === "[::1]";

const processIdentity = (): { readonly uid: number; readonly gid: number } | undefined => {
  const getuid = process.getuid;
  const getgid = process.getgid;
  return getuid === undefined || getgid === undefined
    ? undefined
    : { uid: getuid(), gid: getgid() };
};

const validateCredentialSource = Effect.fnUntraced(function* (
  flag: "--codex-auth" | "--github-config",
  source: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* Effect.result(fs.stat(source));
  if (Result.isFailure(result) || result.success.type !== "File") {
    return yield* usage(`${flag} must reference an existing regular file`);
  }
  if ((result.success.mode & 0o077) !== 0) {
    return yield* usage(`${flag} source must not be accessible by group or other users`);
  }
});

const parserUsage = (error: EffectCliError.ShowHelp): CliError => {
  for (const item of error.errors) {
    // Effect beta.99 currently exposes this misspelled runtime tag on the public error class.
    if (Predicate.isTagged(item, "UnknownSubcomand") && item.parent?.length === 1)
      return usage(`Unknown command: ${item.subcommand}`);
    if (Predicate.isTagged(item, "MissingOption")) {
      if (item.option === "repo") return usage("--repo OWNER/NAME is required");
      if (item.option === "provider") return usage("--provider cloudflare is required");
      if (item.option === "isolation") return usage("--isolation process|docker is required");
    }
    if (Predicate.isTagged(item, "InvalidValue") && item.option === "provider")
      return usage("--provider must be cloudflare");
    if (Predicate.isTagged(item, "InvalidValue") && item.option === "isolation")
      return usage("--isolation must be process or docker");
    if (Predicate.isTagged(item, "UnexpectedArgument") && item.arguments[0] !== undefined)
      return usage(`Unexpected argument: ${item.arguments[0]}`);
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
      tokenFile: Flag.string("token-file").pipe(
        Flag.optional,
        Flag.withDescription("Read a Scotty bearer token from a private file"),
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
      ...(Option.isSome(root.tokenFile) ? { tokenFile: root.tokenFile.value } : {}),
    };
    return {
      autoJson: options.json || !runtime.stdoutIsTTY,
      options,
      runtime,
    };
  });

  const peerControlTarget = Effect.fnUntraced(function* (options: GlobalOptions) {
    const runtime = yield* CliRuntime;
    if (runtime.env.SCOTTY_SESSION_ID !== undefined) return { host: SANDBOX_PEER_HOST } as const;
    return yield* credentials(options);
  });

  const requireInstallationName = Effect.fnUntraced(function* (
    command: "init" | "recover",
    name: Option.Option<string>,
  ) {
    const runtime = yield* CliRuntime;
    let installationName = Option.getOrUndefined(name)?.trim();
    if (!installationName && runtime.stdinIsTTY)
      installationName = runtime.prompt("Installation name: ")?.trim();
    if (!installationName) return yield* usage(`${command} needs --name when stdin is not a TTY`);
    if (Option.isNone(parseInstallationName(installationName)))
      return yield* usage("Installation name must be 2-32 lowercase letters, numbers, or hyphens");
    return installationName;
  });

  const optionalPreviewConfiguration = Effect.fnUntraced(function* (
    previewBase: Option.Option<string>,
    previewZoneId: Option.Option<string>,
  ) {
    if (Option.isNone(previewBase) && Option.isNone(previewZoneId)) return undefined;
    const decoded = decodeInstallationPreviewConfiguration({
      base: Option.getOrUndefined(previewBase)?.trim(),
      zoneId: Option.getOrUndefined(previewZoneId)?.trim(),
    });
    if (Option.isNone(decoded))
      return yield* usage(
        "--preview-base and --preview-zone-id must both provide a valid explicit Cloudflare preview topology",
      );
    return decoded.value;
  });

  const ensureDocker = Effect.fnUntraced(function* () {
    const runtime = yield* CliRuntime;
    const processRunner = yield* ProcessRunner;
    const first = yield* processRunner.run(["docker", "info", "--format", "{{.ServerVersion}}"]);
    if (first.exitCode === 0) return;
    if (process.platform === "darwin" && runtime.stdinIsTTY && runtime.stdoutIsTTY) {
      const answer = runtime.prompt("Docker is unavailable. Start Colima? [y/N]: ");
      if (answer?.trim().toLowerCase() === "y") {
        const started = yield* processRunner.run(["colima", "start"]);
        if (started.exitCode === 0) {
          const retried = yield* processRunner.run([
            "docker",
            "info",
            "--format",
            "{{.ServerVersion}}",
          ]);
          if (retried.exitCode === 0) return;
        }
      }
    }
    return yield* new CliError(
      "docker_unavailable",
      "Docker is not available in the current Docker context",
      "Start your Docker runtime or select a working Docker context, then retry.",
      EXIT.GENERIC,
    );
  });

  const requireGithubToken = Effect.fnUntraced(function* () {
    const processRunner = yield* ProcessRunner;
    const result = yield* processRunner.run(["gh", "auth", "token"]);
    const token = result.stdout.trim();
    if (result.exitCode !== 0 || token.length === 0 || token.includes("\n") || token.includes("\r"))
      return yield* new CliError(
        "github_auth_unavailable",
        "GitHub CLI is not authenticated",
        "Run gh auth login, then retry scotty init.",
        EXIT.GENERIC,
      );
    return token;
  });

  const rootToken = (): string =>
    `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;

  const managedConfig = (
    deployed: InstallationResult,
    token: string,
    adoptionManifestPath?: string,
  ) => ({
    version:
      deployed.evidenceEnabled === true
        ? (3 as const)
        : deployed.previewBase === undefined
          ? (1 as const)
          : (2 as const),
    installationName: deployed.installationName,
    profile: deployed.profile,
    stackName: deployed.stackName,
    stage: deployed.stage,
    accountId: deployed.accountId,
    workerName: deployed.workerName,
    runnerWorkerName: deployed.runnerWorkerName,
    containerName: deployed.containerName,
    kvTitle: deployed.kvTitle,
    backupBucketName: deployed.backupBucketName,
    ...(deployed.previewBase === undefined || deployed.previewZoneId === undefined
      ? {}
      : { previewBase: deployed.previewBase, previewZoneId: deployed.previewZoneId }),
    ...(deployed.evidenceEnabled === true ? { evidenceEnabled: true as const } : {}),
    ...(adoptionManifestPath === undefined ? {} : { adoptionManifestPath }),
    host: deployed.host,
    token,
  });

  const init = Command.make(
    "init",
    {
      name: Flag.string("name").pipe(
        Flag.optional,
        Flag.withDescription("Unique lowercase name for this Scotty installation"),
      ),
      profile: Flag.string("profile").pipe(
        Flag.withDefault("default"),
        Flag.withDescription("Alchemy Cloudflare authentication profile"),
      ),
      previewBase: Flag.string("preview-base").pipe(
        Flag.optional,
        Flag.withDescription("Explicit installation preview DNS base"),
      ),
      previewZoneId: Flag.string("preview-zone-id").pipe(
        Flag.optional,
        Flag.withDescription("Explicit Cloudflare zone ID owning the preview base"),
      ),
      enableEvidence: Flag.boolean("enable-evidence").pipe(
        Flag.withDescription("Explicitly enable the preview-backed evidence deployment gate"),
      ),
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Confirm the displayed installation")),
    },
    ({ enableEvidence, name, previewBase, previewZoneId, profile, yes }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (options.host || options.tokenFile)
          return yield* usage("init does not accept --host or --token-file");
        const installationName = yield* requireInstallationName("init", name);
        const preview = yield* optionalPreviewConfiguration(previewBase, previewZoneId);
        if (enableEvidence && preview === undefined)
          return yield* usage("--enable-evidence requires --preview-base and --preview-zone-id");
        const evidenceEnabled = enableEvidence ? (true as const) : undefined;
        yield* ensureDocker();
        const githubToken = yield* requireGithubToken();
        const fileSystem = yield* CliFileSystem;
        const journalPath = join(runtime.home, ".scotty", `init-${installationName}.json`);
        const lockPath = join(runtime.home, ".scotty", "locks", `init-${installationName}`);
        yield* fileSystem.withLock(
          lockPath,
          Effect.gen(function* () {
            const journalText = yield* fileSystem.readPrivateText(journalPath).pipe(
              Effect.map(Option.some),
              Effect.catch((error) =>
                error.reason === "missing"
                  ? Effect.succeed(Option.none<string>())
                  : Effect.fail(
                      new CliError(
                        "init_journal_invalid",
                        "The pending init journal is not a private regular file",
                        `Repair or remove ${journalPath} after verifying Cloudflare state.`,
                        EXIT.GENERIC,
                      ),
                    ),
              ),
            );
            const existingJournal = Option.flatMap(journalText, decodeInitJournalJson);
            if (Option.isSome(journalText) && Option.isNone(existingJournal))
              return yield* new CliError(
                "init_journal_invalid",
                "The pending init journal is invalid",
                `Repair or remove ${journalPath} after verifying Cloudflare state.`,
                EXIT.GENERIC,
              );
            const creator = yield* InstallationCreator;
            const deploymentTarget = {
              installationName,
              profile,
              ...(preview === undefined
                ? {}
                : { previewBase: preview.base, previewZoneId: preview.zoneId }),
              ...(evidenceEnabled === true ? { evidenceEnabled } : {}),
            };
            const plan = yield* creator.plan(deploymentTarget);
            const topology = makeInstallationTopology(
              installationName,
              undefined,
              preview,
              evidenceEnabled === true,
            );
            const journalMatches =
              Option.isSome(existingJournal) &&
              existingJournal.value.installationName === installationName &&
              existingJournal.value.profile === profile &&
              existingJournal.value.accountId === plan.accountId &&
              existingJournal.value.stackName === topology.stackName &&
              existingJournal.value.workerName === topology.workerName &&
              existingJournal.value.runnerWorkerName === topology.runnerWorkerName &&
              existingJournal.value.containerName === topology.containerName &&
              existingJournal.value.kvTitle === topology.kvTitle &&
              existingJournal.value.backupBucketName === topology.backupBucketName &&
              existingJournal.value.previewBase === topology.preview?.base &&
              existingJournal.value.previewZoneId === topology.preview?.zoneId &&
              existingJournal.value.evidenceEnabled === topology.evidenceEnabled;
            if (Option.isSome(existingJournal) && !journalMatches)
              return yield* new CliError(
                "init_journal_conflict",
                "The pending init journal targets a different installation",
                `Use the original profile or move ${journalPath} aside after verifying Cloudflare state.`,
                EXIT.GENERIC,
              );
            const freshPlanIsUnsafe =
              plan.hasExistingResources ||
              plan.changes.length === 0 ||
              plan.changes.some(
                (change) =>
                  change.action !== "create" &&
                  change.action !== "run" &&
                  change.action !== "binding-create",
              );
            if (Option.isNone(existingJournal) && freshPlanIsUnsafe)
              return yield* new CliError(
                "installation_not_empty",
                "The named Scotty installation already exists or is not empty",
                "Use scotty recover for an existing installation.",
                EXIT.GENERIC,
              );
            if (
              Option.isSome(existingJournal) &&
              existingJournal.value.phase === "prepared" &&
              existingJournal.value.planFingerprint !== plan.fingerprint
            )
              return yield* new CliError(
                "init_plan_changed",
                "The installation plan changed before deployment started",
                `Remove ${journalPath} only after confirming no Cloudflare resources were changed.`,
                EXIT.GENERIC,
              );
            if (Option.isNone(existingJournal) && !yes) {
              if (!runtime.stdinIsTTY || !runtime.stdoutIsTTY)
                return yield* usage(
                  "init requires --yes in non-interactive use",
                  "Run scotty init interactively to review the account and resources, or retry with --yes.",
                );
              runtime.stdout(
                [
                  `Installation: ${installationName}`,
                  `Profile: ${profile}`,
                  `Account: ${plan.accountId}`,
                  `Worker: ${topology.workerName}`,
                  `Runner Worker: ${topology.runnerWorkerName}`,
                  `Container: ${topology.containerName}`,
                  `KV: ${topology.kvTitle}`,
                  `R2: ${topology.backupBucketName}`,
                  ...(topology.preview === undefined
                    ? []
                    : [
                        `Preview base: ${topology.preview.base}`,
                        `Preview zone: ${topology.preview.zoneId}`,
                      ]),
                  ...(topology.evidenceEnabled === true ? ["Evidence gate: enabled"] : []),
                  "",
                ].join("\n"),
              );
              const answer = runtime.prompt(
                `Create ${installationName}? Type ${installationName}: `,
              );
              if (answer !== installationName)
                return yield* new CliError(
                  "cancelled",
                  "Installation creation cancelled",
                  "No resources were changed.",
                  EXIT.USAGE,
                );
            }
            const token = Option.isSome(existingJournal)
              ? existingJournal.value.token
              : rootToken();
            const journal = {
              version:
                evidenceEnabled === true
                  ? (3 as const)
                  : preview === undefined
                    ? (1 as const)
                    : (2 as const),
              operation: "init" as const,
              phase: "prepared" as const,
              installationName,
              profile,
              accountId: plan.accountId,
              stackName: topology.stackName,
              workerName: topology.workerName,
              runnerWorkerName: topology.runnerWorkerName,
              containerName: topology.containerName,
              kvTitle: topology.kvTitle,
              backupBucketName: topology.backupBucketName,
              ...(preview === undefined
                ? {}
                : { previewBase: preview.base, previewZoneId: preview.zoneId }),
              ...(evidenceEnabled === true ? { evidenceEnabled } : {}),
              planFingerprint: plan.fingerprint,
              token,
            };
            if (Option.isNone(existingJournal))
              yield* secureWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
            yield* secureWrite(
              journalPath,
              `${JSON.stringify({ ...journal, phase: "apply_started" }, null, 2)}\n`,
            );
            if (!autoJson)
              runtime.stdout(
                `${Option.isSome(existingJournal) ? "Resuming" : "Creating"} installation ${installationName} in account ${plan.accountId}...\n`,
              );
            const deployed = yield* creator.create({
              ...deploymentTarget,
              token,
              githubToken,
              expectedAccountId: plan.accountId,
              expectedPlanFingerprint: plan.fingerprint,
              mode: Option.isSome(existingJournal) ? "resume" : "fresh",
            });
            const host = yield* Effect.fromResult(normalizeHost(deployed.host));
            const configPath = join(runtime.home, ".scotty.json");
            yield* secureWrite(
              configPath,
              `${JSON.stringify(managedConfig({ ...deployed, host }, token), null, 2)}\n`,
            );
            yield* fileSystem
              .remove(journalPath)
              .pipe(
                Effect.catch((error) =>
                  error.code === "ENOENT"
                    ? Effect.void
                    : Effect.fail(
                        new CliError(
                          "init_journal_cleanup_failed",
                          "The installation completed but its init journal could not be removed",
                          `Remove ${journalPath} after confirming ${configPath} exists.`,
                          EXIT.GENERIC,
                        ),
                      ),
                ),
              );
            const result = {
              configPath,
              installationName: deployed.installationName,
              profile: deployed.profile,
              accountId: deployed.accountId,
              workerName: deployed.workerName,
              host,
              rootTokenRotated: true,
            };
            yield* synchronizeInstallationSandbox(runtime.home, { host, token });
            if (autoJson) outputJson(runtime.stdout, result);
            else {
              runtime.stdout(`Saved ${configPath} with mode 0600\n`);
              runtime.stdout("Scotty is deployed. Run scotty auth sync next.\n");
            }
          }),
        );
      }),
  ).pipe(
    Command.withDescription("Create a new Scotty installation"),
    Command.withExamples([
      { command: "scotty init --name home", description: "Create a named installation" },
    ]),
  );

  const recover = Command.make(
    "recover",
    {
      name: Flag.string("name").pipe(
        Flag.optional,
        Flag.withDescription("Existing Scotty installation name"),
      ),
      profile: Flag.string("profile").pipe(
        Flag.withDefault("default"),
        Flag.withDescription("Alchemy Cloudflare authentication profile"),
      ),
      adoptionManifest: Flag.string("adoption-manifest").pipe(
        Flag.optional,
        Flag.withDescription("Private legacy resource-name mapping"),
      ),
      previewBase: Flag.string("preview-base").pipe(
        Flag.optional,
        Flag.withDescription("Explicit installation preview DNS base"),
      ),
      previewZoneId: Flag.string("preview-zone-id").pipe(
        Flag.optional,
        Flag.withDescription("Explicit Cloudflare zone ID owning the preview base"),
      ),
      enableEvidence: Flag.boolean("enable-evidence").pipe(
        Flag.withDescription("Explicitly preserve an enabled preview-backed evidence gate"),
      ),
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Confirm the displayed resource mapping")),
    },
    ({ adoptionManifest, enableEvidence, name, previewBase, previewZoneId, profile, yes }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (options.host || options.tokenFile)
          return yield* usage("recover does not accept --host or --token-file");
        const installationName = yield* requireInstallationName("recover", name);
        const preview = yield* optionalPreviewConfiguration(previewBase, previewZoneId);
        if (enableEvidence && preview === undefined)
          return yield* usage("--enable-evidence requires --preview-base and --preview-zone-id");
        const evidenceEnabled = enableEvidence ? (true as const) : undefined;
        const adoptionManifestPath = Option.getOrUndefined(adoptionManifest);
        const recovery = yield* InstallationRecovery;
        const deploymentTarget = {
          installationName,
          profile,
          ...(adoptionManifestPath === undefined ? {} : { adoptionManifestPath }),
          ...(preview === undefined
            ? {}
            : { previewBase: preview.base, previewZoneId: preview.zoneId }),
          ...(evidenceEnabled === true ? { evidenceEnabled } : {}),
        };
        const inspected = yield* recovery.inspect(deploymentTarget);
        if (!yes) {
          if (!runtime.stdinIsTTY || !runtime.stdoutIsTTY)
            return yield* usage(
              "recover requires --yes in non-interactive use",
              "Review the resource mapping in an interactive terminal, or retry with --yes.",
            );
          runtime.stdout(
            [
              `Installation: ${inspected.installationName}`,
              `Account: ${inspected.accountId}`,
              `Worker: ${inspected.workerName}`,
              `Runner Worker: ${inspected.runnerWorkerName}`,
              `Container: ${inspected.containerName}`,
              `KV: ${inspected.kvTitle}`,
              `R2: ${inspected.backupBucketName}`,
              ...(inspected.previewBase === undefined
                ? []
                : [
                    `Preview base: ${inspected.previewBase}`,
                    `Preview zone: ${inspected.previewZoneId}`,
                  ]),
              `Host: ${inspected.host}`,
              "",
            ].join("\n"),
          );
          const answer = runtime.prompt(
            `Rotate access for ${installationName}? Type ${installationName}: `,
          );
          if (answer !== installationName)
            return yield* new CliError(
              "cancelled",
              "Installation recovery cancelled",
              "No credentials were changed.",
              EXIT.USAGE,
            );
        }

        const configPath = join(runtime.home, ".scotty.json");
        const journalPath = join(runtime.home, ".scotty", `recover-${installationName}.json`);
        const fileSystem = yield* CliFileSystem;
        yield* fileSystem.withLock(
          journalPath,
          Effect.gen(function* () {
            const existingJournal = yield* readConfig(journalPath);
            const journalMatchesTarget =
              existingJournal.installationName === installationName &&
              existingJournal.profile === profile &&
              existingJournal.accountId === inspected.accountId &&
              existingJournal.workerName === inspected.workerName &&
              existingJournal.runnerWorkerName === inspected.runnerWorkerName &&
              existingJournal.containerName === inspected.containerName &&
              existingJournal.kvTitle === inspected.kvTitle &&
              existingJournal.backupBucketName === inspected.backupBucketName &&
              existingJournal.previewBase === inspected.previewBase &&
              existingJournal.previewZoneId === inspected.previewZoneId &&
              existingJournal.evidenceEnabled === inspected.evidenceEnabled &&
              existingJournal.adoptionManifestPath === adoptionManifestPath;
            const token =
              journalMatchesTarget && existingJournal.token ? existingJournal.token : rootToken();
            yield* secureWrite(
              journalPath,
              `${JSON.stringify(managedConfig(inspected, token, adoptionManifestPath), null, 2)}\n`,
            );
            const recovered = yield* recovery.recover({
              ...deploymentTarget,
              token,
              expectedAccountId: inspected.accountId,
              expectedWorkerName: inspected.workerName,
              expectedRunnerWorkerName: inspected.runnerWorkerName,
              expectedContainerName: inspected.containerName,
              expectedKvTitle: inspected.kvTitle,
              expectedBackupBucketName: inspected.backupBucketName,
              ...(inspected.previewBase === undefined || inspected.previewZoneId === undefined
                ? {}
                : {
                    expectedPreviewBase: inspected.previewBase,
                    expectedPreviewZoneId: inspected.previewZoneId,
                  }),
            });
            const host = yield* Effect.fromResult(normalizeHost(recovered.host));
            yield* secureWrite(
              configPath,
              `${JSON.stringify(
                managedConfig({ ...recovered, host }, token, adoptionManifestPath),
                null,
                2,
              )}\n`,
            );
            yield* fileSystem
              .remove(journalPath)
              .pipe(
                Effect.catch((error) =>
                  error.code === "ENOENT"
                    ? Effect.void
                    : Effect.fail(
                        new CliError(
                          "recovery_journal_cleanup_failed",
                          "Access was recovered but the recovery journal could not be removed",
                          `Remove ${journalPath} after confirming ${configPath} exists.`,
                          EXIT.GENERIC,
                        ),
                      ),
                ),
              );
            const result = {
              configPath,
              installationName,
              profile,
              accountId: recovered.accountId,
              workerName: recovered.workerName,
              host,
              rootTokenRotated: true,
            };
            if (autoJson) outputJson(runtime.stdout, result);
            else
              runtime.stdout(
                `Recovered ${installationName} and saved ${configPath} with mode 0600.\n`,
              );
          }),
        );
      }),
  ).pipe(Command.withDescription("Recover access to an existing Scotty installation"));

  const uninstall = Command.make(
    "uninstall",
    {
      deleteData: Flag.boolean("delete-data").pipe(
        Flag.withDescription(
          "Also delete the retained KV session index, R2 backups, and evidence artifacts",
        ),
      ),
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Confirm installation removal")),
    },
    ({ deleteData, yes }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (options.host || options.tokenFile)
          return yield* usage("uninstall does not accept --host or --token-file");
        const configPath = join(runtime.home, ".scotty.json");
        const config = yield* readConfig(configPath);
        if (!config.installationName || !config.profile)
          return yield* usage(
            "No managed Scotty installation is configured",
            "Run uninstall on a machine with the installation config, or recover it first.",
          );
        const conventional = makeInstallationTopology(config.installationName);
        const workerName = config.workerName ?? conventional.workerName;
        const runnerWorkerName = config.runnerWorkerName ?? conventional.runnerWorkerName;
        const containerName = config.containerName ?? conventional.containerName;
        const kvTitle = config.kvTitle ?? conventional.kvTitle;
        const backupBucketName = config.backupBucketName ?? conventional.backupBucketName;
        if (
          !config.accountId ||
          (config.adoptionManifestPath !== undefined &&
            (!config.workerName ||
              !config.runnerWorkerName ||
              !config.containerName ||
              !config.kvTitle ||
              !config.backupBucketName))
        )
          return yield* usage(
            "Installation ownership details are incomplete",
            "Run scotty recover --name NAME before uninstalling.",
          );
        if (!yes) {
          if (!runtime.stdinIsTTY || !runtime.stdoutIsTTY)
            return yield* usage(
              "uninstall requires --yes in non-interactive use",
              "Run scotty uninstall interactively to review the impact, or retry with --yes.",
            );
          runtime.stdout(
            deleteData
              ? "This stops every session and deletes Scotty compute, the KV session index, every R2 backup, and every evidence artifact.\n"
              : "This stops every session and deletes Scotty compute. KV and R2 data stay in Cloudflare.\n",
          );
          const answer = runtime.prompt(
            `Uninstall ${config.installationName}? Type ${config.installationName}: `,
          );
          if (answer !== config.installationName)
            return yield* new CliError(
              "cancelled",
              "Installation uninstall cancelled",
              "No resources were changed.",
              EXIT.USAGE,
            );
        }
        const uninstaller = yield* InstallationUninstaller;
        const result = yield* uninstaller.uninstall({
          installationName: config.installationName,
          profile: config.profile,
          deleteData,
          expectedAccountId: config.accountId,
          expectedWorkerName: workerName,
          expectedRunnerWorkerName: runnerWorkerName,
          expectedContainerName: containerName,
          expectedKvTitle: kvTitle,
          expectedBackupBucketName: backupBucketName,
          ...(config.previewBase === undefined || config.previewZoneId === undefined
            ? {}
            : {
                previewBase: config.previewBase,
                previewZoneId: config.previewZoneId,
                expectedPreviewBase: config.previewBase,
                expectedPreviewZoneId: config.previewZoneId,
              }),
          ...(config.evidenceEnabled === true ? { evidenceEnabled: true as const } : {}),
          ...(config.adoptionManifestPath === undefined
            ? {}
            : { adoptionManifestPath: config.adoptionManifestPath }),
        });
        const fileSystem = yield* CliFileSystem;
        yield* fileSystem
          .remove(configPath)
          .pipe(
            Effect.catch((error) =>
              error.code === "ENOENT"
                ? Effect.void
                : Effect.fail(
                    new CliError(
                      "config_cleanup_failed",
                      "Cloudflare resources were removed but the local config remains",
                      `Remove ${configPath} manually.`,
                      EXIT.GENERIC,
                    ),
                  ),
            ),
          );
        const output = { ...result, configRemoved: true };
        if (autoJson) outputJson(runtime.stdout, output);
        else {
          runtime.stdout(`Uninstalled ${result.installationName}.\n`);
          if (result.retainedData.length > 0)
            runtime.stdout(`Retained data: ${result.retainedData.join(", ")}\n`);
        }
      }),
  ).pipe(Command.withDescription("Remove Scotty compute and retain data by default"));

  const upgrade = Command.make("upgrade", {}, () =>
    Effect.gen(function* () {
      const { autoJson, options, runtime } = yield* commandContext();
      if (options.host || options.tokenFile)
        return yield* usage("upgrade does not accept --host or --token-file");
      const upgrader = yield* CliUpgrader;
      const result = yield* upgrader.upgrade({
        currentVersion: VERSION,
        executablePath: process.execPath,
        platform: process.platform,
        architecture: process.arch,
      });
      if (autoJson) outputJson(runtime.stdout, result);
      else if (result.updated)
        runtime.stdout(`Upgraded Scotty from ${result.previousVersion} to ${result.version}.\n`);
      else runtime.stdout(`Scotty ${result.version} is already current.\n`);
    }),
  ).pipe(Command.withDescription("Install the latest signed Scotty CLI release"));

  const deployInstallationCommand = Command.make(
    "deploy",
    {
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Apply a deployment with changes")),
    },
    ({ yes }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (options.host || options.tokenFile)
          return yield* usage("deploy does not accept --host or --token-file");
        const config = yield* readConfig(join(runtime.home, ".scotty.json"));
        if (!config.installationName || !config.profile || !config.accountId)
          return yield* usage(
            "No managed Scotty installation is configured",
            "Run scotty init or scotty recover first.",
          );
        if (!config.token)
          return yield* usage(
            "Managed installation credentials are missing",
            "Run scotty recover --name NAME first.",
          );
        yield* ensureDocker();
        const deployer = yield* InstallationDeployer;
        const request = {
          installationName: config.installationName,
          profile: config.profile,
          ...(config.adoptionManifestPath === undefined
            ? {}
            : { adoptionManifestPath: config.adoptionManifestPath }),
          ...(config.previewBase === undefined || config.previewZoneId === undefined
            ? {}
            : { previewBase: config.previewBase, previewZoneId: config.previewZoneId }),
          ...(config.evidenceEnabled === true ? { evidenceEnabled: true as const } : {}),
        };
        const plan = yield* deployer.plan(request);
        if (plan.accountId !== config.accountId)
          return yield* new CliError(
            "deployment_account_changed",
            "The Cloudflare account does not match the saved installation",
            "Select the saved Alchemy profile or recover the installation before deploying.",
            EXIT.GENERIC,
          );
        if (plan.changes.length === 0) {
          const result = {
            installationName: config.installationName,
            changed: false,
            changes: [],
            rootTokenRotated: false,
          };
          if (config.host === undefined)
            return yield* usage(
              "Scotty host is not configured",
              "Run scotty init or pass --host / SCOTTY_HOST.",
            );
          if (config.token === undefined)
            return yield* usage(
              "Scotty token is not configured",
              "Run scotty init or pass --token-file / SCOTTY_TOKEN.",
            );
          yield* synchronizeInstallationSandbox(runtime.home, {
            host: yield* Effect.fromResult(normalizeHost(config.host)),
            token: config.token,
          });
          if (autoJson) outputJson(runtime.stdout, result);
          else runtime.stdout(`${config.installationName} is already up to date.\n`);
          return;
        }
        if (!yes) {
          if (!runtime.stdinIsTTY || !runtime.stdoutIsTTY)
            return yield* usage(
              "deploy requires --yes when the plan contains changes",
              "Run scotty deploy interactively to review the plan, or retry with --yes.",
            );
          runtime.stdout(
            `Account: ${plan.accountId}\n${plan.changes.map((change) => `${change.action.padEnd(7)} ${change.id}`).join("\n")}\n`,
          );
          const answer = runtime.prompt(`Deploy ${config.installationName}? [y/N]: `);
          if (answer?.trim().toLowerCase() !== "y")
            return yield* new CliError(
              "cancelled",
              "Deployment cancelled",
              "No resources were changed.",
              EXIT.USAGE,
            );
        }
        if (!autoJson) runtime.stdout(`Deploying ${config.installationName}...\n`);
        const deployed = yield* deployer.deploy({
          ...request,
          expectedAccountId: plan.accountId,
          expectedPlanFingerprint: plan.fingerprint,
        });
        const host = yield* Effect.fromResult(normalizeHost(deployed.host));
        yield* secureWrite(
          join(runtime.home, ".scotty.json"),
          `${JSON.stringify(
            managedConfig({ ...deployed, host }, config.token, config.adoptionManifestPath),
            null,
            2,
          )}\n`,
        );
        const result = {
          installationName: deployed.installationName,
          profile: deployed.profile,
          workerName: deployed.workerName,
          host,
          changed: true,
          changes: plan.changes,
          rootTokenRotated: false,
        };
        yield* synchronizeInstallationSandbox(runtime.home, { host, token: config.token });
        if (autoJson) outputJson(runtime.stdout, result);
        else
          runtime.stdout(
            `Deployed ${deployed.installationName}. Root credentials were unchanged.\n`,
          );
      }),
  ).pipe(Command.withDescription("Deploy Scotty code without changing credentials"));

  const beamUp = Command.make(
    "up",
    {
      prompt: Argument.string("prompt").pipe(Argument.withDescription("Initial agent prompt")),
      title: Flag.string("title").pipe(Flag.withDescription("Short task or outcome title")),
      repo: Flag.string("repo").pipe(Flag.withDescription("GitHub repository as OWNER/NAME")),
      newRepo: Flag.boolean("new-repo").pipe(
        Flag.withDescription("Create a local workspace when the GitHub repository is missing"),
      ),
      provider: Flag.choice("provider", ["cloudflare"] as const).pipe(
        Flag.withDescription("Execution provider"),
      ),
      cap: Flag.string("cap").pipe(
        Flag.optional,
        Flag.withDescription("Hard cap such as 30m, 4h, or 1d"),
      ),
      detach: Flag.boolean("detach").pipe(Flag.withDescription("Do not open the session browser")),
    },
    ({ cap, detach, newRepo, prompt, provider, repo, title }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        const browser = yield* BrowserLauncher;
        if (!prompt.trim()) return yield* usage("Prompt must not be empty");
        const normalizedTitle = title.trim();
        if (!normalizedTitle || normalizedTitle.length > 120)
          return yield* usage("--title must be between 1 and 120 characters");
        if (!isRepositoryIdentity(repo)) return yield* usage("--repo must be OWNER/NAME");
        const auth = yield* credentials(options);
        const hardCapSeconds = Option.isSome(cap)
          ? yield* Effect.fromResult(durationSeconds(cap.value))
          : undefined;
        const body: BeamUpRequest = {
          title: normalizedTitle,
          prompt,
          provider,
          repo,
          ...(newRepo ? { newRepo: true } : {}),
          ...(Option.isSome(cap) ? { cap: cap.value, hardCapSeconds } : {}),
        };
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
        else runtime.stdout(humanResult({ command: "beam up", value: result }));
      }),
  ).pipe(
    Command.withDescription("Start an agent session"),
    Command.withExamples([
      {
        command:
          'scotty beam up "fix the failing tests" --title "Repair test suite" --repo owner/project --provider cloudflare',
        description: "Start a Cloudflare session",
      },
    ]),
  );

  const list = Command.make("ls", {}, () =>
    Effect.gen(function* () {
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

  const inspect = Command.make(
    "inspect",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
    },
    ({ id }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        const sessionId = yield* validateSessionId(id);
        const target = yield* peerControlTarget(options);
        const decoded = decodeInspectResponse(
          yield* requestJson(target, `/api/sessions/${encodeURIComponent(sessionId)}/inspect`, {
            cache: "no-store",
            redirect: "manual",
          }),
        );
        if (Option.isNone(decoded))
          return yield* invalidResponse("Server returned an invalid Pi snapshot");
        if (autoJson) outputJson(runtime.stdout, { id: sessionId, ...decoded.value });
        else runtime.stdout(humanInspect(sessionId, decoded.value));
      }),
  ).pipe(Command.withDescription("Inspect a warm session or sandbox peer without waking it"));

  const steer = Command.make(
    "steer",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
      message: Argument.string("message").pipe(
        Argument.withDescription("Prompt or steering message"),
      ),
    },
    ({ id, message }) =>
      Effect.gen(function* () {
        if (!message.trim()) return yield* usage("Message must not be empty");
        if (new TextEncoder().encode(message).byteLength > PI_CONSOLE_MAX_STRING_BYTES)
          return yield* usage(`Message must be at most ${PI_CONSOLE_MAX_STRING_BYTES} UTF-8 bytes`);
        if (message.trimStart().startsWith("/"))
          return yield* usage("Message must be a prompt, not a slash command");
        const { autoJson, options, runtime } = yield* commandContext();
        const sessionId = yield* validateSessionId(id);
        const target = yield* peerControlTarget(options);
        const decoded = decodeSteerResponse(
          yield* requestJson(target, `/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
            method: "POST",
            body: JSON.stringify({ message }),
            cache: "no-store",
            redirect: "manual",
          }),
        );
        if (Option.isNone(decoded))
          return yield* invalidResponse("Server returned an invalid steer outcome");
        const result = decoded.value;
        if (result.status === "stale" || result.status === "unavailable")
          yield* setExitCode(EXIT.WRONG_STATE);
        else if (result.status === "ambiguous") yield* setExitCode(EXIT.GENERIC);
        if (autoJson) outputJson(runtime.stdout, result);
        else runtime.stdout(humanSteer(result));
      }),
  ).pipe(
    Command.withDescription("Prompt or steer a warm session or sandbox peer without waking it"),
  );

  const doctor = Command.make("doctor", {}, () =>
    Effect.gen(function* () {
      const { autoJson, options, runtime } = yield* commandContext();
      const config = yield* readConfig(join(runtime.home, ".scotty.json"));
      const auth = yield* credentials(options);
      const value = yield* requestJson(auth, "/api/sessions");
      if (Option.isNone(decodeSessionsResponse(value)))
        return yield* invalidResponse("Server response is not a valid session array");
      const result = {
        ok: true,
        mode: config.installationName ? "managed" : "connected",
        host: auth.host,
        ...(config.installationName ? { installationName: config.installationName } : {}),
        ...(config.profile ? { profile: config.profile } : {}),
        ...(config.accountId ? { accountId: config.accountId } : {}),
        ...(config.workerName ? { workerName: config.workerName } : {}),
      };
      if (autoJson) outputJson(runtime.stdout, result);
      else
        runtime.stdout(
          config.installationName
            ? `Scotty installation ${config.installationName} is reachable and authenticated.\n`
            : "Scotty is reachable and authenticated.\n",
        );
    }),
  ).pipe(Command.withDescription("Check local installation metadata, reachability, and auth"));

  const attach = Command.make(
    "attach",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
    },
    ({ id }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        const browser = yield* BrowserLauncher;
        const sessionId = yield* validateSessionId(id);
        const auth = yield* credentials(options);
        const safeUrl = `${auth.host}/s/${encodeURIComponent(sessionId)}`;
        const targetUrl = yield* Effect.fromResult(browserUrl(undefined, auth.host, sessionId));
        yield* browser.open(targetUrl);
        const result: AttachOutput = { id: sessionId, url: safeUrl, opened: true };
        if (autoJson) outputJson(runtime.stdout, result);
        else runtime.stdout(humanResult({ command: "attach", value: result }));
      }),
  ).pipe(Command.withDescription("Open a session"));

  const ownerRecover = Command.make("recover", {}, () =>
    Effect.gen(function* () {
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

  const readPiAuthStatus = Effect.fnUntraced(function* (auth: {
    readonly host: string;
    readonly token: string;
  }) {
    const raw = yield* requestJson(auth, "/api/auth/pi");
    const decoded = decodePiAuthStatusResponse(raw);
    if (Option.isNone(decoded))
      return yield* invalidResponse("Server response is not a valid Pi auth status");
    return decoded.value;
  });

  const authStatus = Command.make("status", {}, () =>
    Effect.gen(function* () {
      const { autoJson, options, runtime } = yield* commandContext();
      const status = yield* readPiAuthStatus(yield* credentials(options));
      if (autoJson) outputJson(runtime.stdout, status);
      else
        runtime.stdout(
          `${status.providers.map((provider) => `${provider.id} ${provider.type} ${provider.adapter}`).join("\n")}\n`,
        );
    }),
  ).pipe(Command.withDescription("Show redacted Pi credential status"));

  const authSync = Command.make(
    "sync",
    {
      authFile: Flag.string("auth-file").pipe(
        Flag.optional,
        Flag.withDescription("Override ~/.pi/agent/auth.json"),
      ),
    },
    ({ authFile }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (options.host || options.tokenFile)
          return yield* usage(
            "auth sync does not accept --host or --token-file",
            "Use the managed installation saved by scotty init or scotty recover.",
          );
        const config = yield* readConfig(join(runtime.home, ".scotty.json"));
        if (
          !config.installationName ||
          !config.profile ||
          !config.accountId ||
          !config.workerName ||
          !config.runnerWorkerName ||
          !config.containerName ||
          !config.kvTitle ||
          !config.backupBucketName ||
          !config.host ||
          !config.token ||
          !/^[0-9a-f]{32}$/u.test(config.accountId) ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(config.workerName)
        )
          return yield* usage(
            "auth sync requires a complete managed Scotty installation",
            "Run scotty init or scotty recover, then retry.",
          );
        const host = yield* Effect.fromResult(normalizeHost(config.host));
        const targetRequest = {
          profile: config.profile,
          expectedAccountId: config.accountId,
          expectedWorkerName: config.workerName,
          expectedRunnerWorkerName: config.runnerWorkerName,
          expectedContainerName: config.containerName,
          expectedKvTitle: config.kvTitle,
          expectedBackupBucketName: config.backupBucketName,
          expectedHost: host,
        } as const;
        const secretManager = yield* PiAuthSecretManager;
        yield* secretManager.inspect(targetRequest);
        const local = yield* readLocalPiAuth(Option.getOrUndefined(authFile));
        const workerAuth = { host, token: config.token };
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        const record = yield* Effect.tryPromise({
          try: () => makeInstallationPiAuthRecord(local.providerStore, now, "sync"),
          catch: () =>
            new CliError(
              "pi_auth_sync_failed",
              "Could not prepare the Pi credential record",
              "Retry scotty auth sync.",
              EXIT.GENERIC,
            ),
        });
        const remoteRaw = yield* requestJson(workerAuth, "/api/auth/pi", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(record),
        });
        const remote = decodePiAuthStatusResponse(remoteRaw);
        if (Option.isNone(remote))
          return yield* invalidResponse("Server response is not a valid Pi auth status");
        const sessionsRaw = yield* requestJson(workerAuth, "/api/sessions");
        const sessions = decodeSessionsResponse(sessionsRaw);
        if (Option.isNone(sessions))
          return yield* invalidResponse("Server response is not a valid session array");
        const warmIds = sessions.value
          .filter((session) => session.provider === "cloudflare" && session.status === "warm")
          .map((session) => session.id);
        const reconciled: string[] = [];
        const failed: string[] = [];
        for (const sessionId of warmIds) {
          const outcome = yield* Effect.result(
            requestJson(workerAuth, `/api/sessions/${encodeURIComponent(sessionId)}/auth/reseed`, {
              method: "POST",
            }),
          );
          if (Result.isSuccess(outcome)) reconciled.push(sessionId);
          else failed.push(sessionId);
        }
        const result = {
          synchronized: true,
          sourceDigest: local.sourceDigest,
          worker: targetRequest.expectedWorkerName,
          providers: remote.value.providers,
          reconciled,
          failed,
          partial: failed.length > 0,
        };
        if (autoJson) outputJson(runtime.stdout, result);
        else {
          runtime.stdout(
            `Synchronized ${result.providers.length} Pi provider credentials to ${result.worker}.\n`,
          );
          if (result.failed.length > 0)
            runtime.stdout(
              `Reconciled ${result.reconciled.length} warm sessions; ${result.failed.length} failed: ${result.failed.join(", ")}.\n`,
            );
        }
      }),
  ).pipe(Command.withDescription("Synchronize local Pi credentials"));

  const authReseed = Command.make(
    "reseed",
    {
      id: Argument.string("id").pipe(
        Argument.withDescription("Warm Cloudflare session ID"),
        Argument.optional,
      ),
      allActive: Flag.boolean("all-active").pipe(
        Flag.withDescription("Reseed every warm Cloudflare session"),
      ),
    },
    ({ allActive, id }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (Option.isSome(id) === allActive)
          return yield* usage("Pass exactly one session ID or --all-active");
        const workerAuth = yield* credentials(options);
        let ids: ReadonlyArray<string>;
        if (Option.isSome(id)) {
          ids = [yield* validateSessionId(id.value)];
        } else {
          const raw = yield* requestJson(workerAuth, "/api/sessions");
          const decoded = decodeSessionsResponse(raw);
          if (Option.isNone(decoded))
            return yield* invalidResponse("Server response is not a valid session array");
          ids = decoded.value
            .filter((session) => session.provider === "cloudflare" && session.status === "warm")
            .map((session) => session.id);
        }
        const results = yield* Effect.forEach(
          ids,
          (sessionId) =>
            requestJson(workerAuth, `/api/sessions/${encodeURIComponent(sessionId)}/auth/reseed`, {
              method: "POST",
            }).pipe(
              Effect.flatMap((raw) => {
                const decoded = decodePiAuthReseedResponse(raw);
                return Option.isSome(decoded)
                  ? Effect.succeed(decoded.value)
                  : invalidResponse("Server response is not a valid Pi auth reseed result");
              }),
            ),
          { concurrency: 1 },
        );
        const result = { reseeded: results };
        if (autoJson) outputJson(runtime.stdout, result);
        else runtime.stdout(`Reseeded ${results.length} warm Cloudflare sessions.\n`);
      }),
  ).pipe(Command.withDescription("Explicitly replace session Pi credentials"), Command.withHidden);

  const auth = Command.make("auth").pipe(
    Command.withDescription("Manage Pi credentials"),
    Command.withSubcommands([authStatus, authSync, authReseed]),
  );

  const emitSandboxStatus = (
    autoJson: boolean,
    runtime: { readonly stdout: (text: string) => void },
    status: ReturnType<typeof localSandboxStatus>,
    prefix?: string,
  ): void => {
    if (autoJson) outputJson(runtime.stdout, status);
    else {
      if (prefix !== undefined) runtime.stdout(`${prefix}\n`);
      runtime.stdout(formatSandboxStatus(status));
    }
  };

  const emitSandboxSync = (
    autoJson: boolean,
    runtime: { readonly stdout: (text: string) => void },
    output: ReturnType<typeof sandboxSyncOutput>,
  ): void => {
    if (autoJson) outputJson(runtime.stdout, encodeSandboxSyncJson(output));
    else runtime.stdout(formatSandboxSync(output));
  };

  const sandboxAdd = Command.make(
    "add",
    {
      source: Argument.string("source").pipe(
        Argument.withDescription("Local Skill directory or Git repository URL"),
      ),
      ref: Flag.string("ref").pipe(
        Flag.optional,
        Flag.withDescription("Git tag or commit for a Pi package repository"),
      ),
    },
    ({ ref, source }) =>
      Effect.gen(function* () {
        const { autoJson, runtime } = yield* commandContext();
        const requestedRef = Option.getOrUndefined(ref);
        const classified = yield* classifySandboxSource(source, runtime.cwd, requestedRef);
        const path = sandboxConfigPath(runtime.home);
        if (classified.kind === "skill") {
          const name = yield* readSkillDirectoryName(classified.path);
          const saved = yield* mutateSandboxConfig(path, (config) =>
            addSkillSource(config, { name, path: classified.path }),
          );
          emitSandboxStatus(
            autoJson,
            runtime,
            localSandboxStatus(saved),
            `Added skill ${name} to the local sandbox configuration.`,
          );
          return;
        }
        if (requestedRef === undefined) return yield* usage("Git package sources require --ref");
        const git = yield* GitResolver;
        const resolved = yield* git.resolvePackage(classified.repository, requestedRef);
        const saved = yield* mutateSandboxConfig(path, (config) =>
          addPiPackageSource(config, {
            name: resolved.name,
            repository: classified.repository,
            commit: resolved.commit,
            requestedRef,
          }),
        );
        emitSandboxStatus(
          autoJson,
          runtime,
          localSandboxStatus(saved),
          `Added Pi package ${resolved.name} to the local sandbox configuration.`,
        );
      }),
  ).pipe(Command.withDescription("Add a Skill directory or Git-backed Pi package"));

  const sandboxRemove = Command.make(
    "remove",
    {
      name: Argument.string("name").pipe(
        Argument.withDescription("Configured Skill or Pi package name"),
      ),
    },
    ({ name }) =>
      Effect.gen(function* () {
        const { autoJson, runtime } = yield* commandContext();
        const path = sandboxConfigPath(runtime.home);
        const fileSystem = yield* CliFileSystem;
        const removed = yield* fileSystem.withLock(
          path,
          Effect.gen(function* () {
            const current = yield* loadSandboxConfig(path, true);
            const next = yield* Effect.fromResult(removeSandboxSource(current, name));
            const saved = yield* saveSandboxConfig(path, next.config);
            return { kind: next.kind, saved };
          }),
        );
        const label = removed.kind === "skill" ? "skill" : "Pi package";
        emitSandboxStatus(
          autoJson,
          runtime,
          localSandboxStatus(removed.saved),
          `Removed ${label} ${name} from the local sandbox configuration.`,
        );
      }),
  ).pipe(Command.withDescription("Remove a configured Skill or Pi package"));

  const sandboxList = Command.make("list", {}, () =>
    Effect.gen(function* () {
      const { autoJson, runtime } = yield* commandContext();
      const path = sandboxConfigPath(runtime.home);
      const fileSystem = yield* CliFileSystem;
      const config = yield* fileSystem.withLock(path, loadSandboxConfig(path, true));
      emitSandboxStatus(autoJson, runtime, localSandboxStatus(config));
    }),
  ).pipe(Command.withDescription("List local sandbox sources and remote status"));

  const sandboxSync = Command.make("sync", {}, () =>
    Effect.gen(function* () {
      const { autoJson, options, runtime } = yield* commandContext();
      const target = yield* credentials(options);
      const synced = yield* synchronizeInstallationSandbox(runtime.home, target);
      emitSandboxSync(
        autoJson,
        runtime,
        sandboxSyncOutput(
          synced.config,
          synced.built.digest,
          synced.built.bytes,
          synced.built.fileCount,
          synced.remote,
        ),
      );
    }),
  ).pipe(Command.withDescription("Prepare the local sandbox bundle and synchronize it"));

  const sandbox = Command.make("sandbox").pipe(
    Command.withDescription("Manage installation sandbox Skills and Pi packages"),
    Command.withSubcommands([sandboxAdd, sandboxRemove, sandboxList, sandboxSync]),
  );

  const toolsList = Command.make("list", {}, () =>
    Effect.gen(function* () {
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

  const toolsDoctor = Command.make("doctor", {}, () =>
    Effect.gen(function* () {
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

  const runnerServe = Command.make(
    "serve",
    {
      name: Flag.string("name").pipe(Flag.withDescription("Stable runner name")),
      root: Flag.string("root").pipe(Flag.withDescription("Absolute runner workspace root")),
      isolation: Flag.choice("isolation", ["process", "docker"]).pipe(
        Flag.withDescription("Runner isolation mode"),
      ),
      image: Flag.string("image").pipe(
        Flag.withDescription("Digest-pinned Docker image"),
        Flag.optional,
      ),
      codexAuth: Flag.string("codex-auth").pipe(
        Flag.withDescription("Absolute host path to Codex auth.json"),
        Flag.optional,
      ),
      githubConfig: Flag.string("github-config").pipe(
        Flag.withDescription("Absolute host path to GitHub CLI hosts.yml"),
        Flag.optional,
      ),
    },
    ({ codexAuth, githubConfig, image, isolation, name, root }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (options.tokenFile !== undefined)
          return yield* usage(
            "runner serve does not accept --token-file",
            "Set SCOTTY_RUNNER_TOKEN in the runner process environment.",
          );
        if (!RUNNER_NAME_PATTERN.test(name))
          return yield* usage("--name must contain only letters, numbers, underscores, or dashes");
        if (!isAbsolute(root)) return yield* usage("--root must be an absolute path");
        const hostValue = options.host ?? runtime.env.SCOTTY_HOST;
        if (!hostValue)
          return yield* usage(
            "Scotty host is not configured",
            "Pass --host or set SCOTTY_HOST in the runner process environment.",
          );
        const token = runtime.env.SCOTTY_RUNNER_TOKEN?.trim();
        if (!token)
          return yield* usage(
            "Runner token is not configured",
            "Set SCOTTY_RUNNER_TOKEN in the runner process environment.",
          );
        const host = yield* Effect.fromResult(normalizeHost(hostValue));
        const hostUrl = new URL(host);
        if (hostUrl.protocol !== "https:" && !isLoopbackHost(hostUrl.hostname))
          return yield* usage(
            "runner serve requires an HTTPS Scotty host",
            "Use HTTPS, or use HTTP only for a loopback development host.",
          );
        const imageValue = Option.getOrUndefined(image);
        const codexAuthValue = Option.getOrUndefined(codexAuth);
        const githubConfigValue = Option.getOrUndefined(githubConfig);
        if (isolation === "process" && !isLoopbackHost(hostUrl.hostname))
          return yield* usage(
            "--isolation process is only allowed with a loopback Scotty host",
            "Use --isolation docker for remote runners.",
          );
        if (isolation === "process" && imageValue !== undefined)
          return yield* usage("--image is only valid with --isolation docker");
        if (isolation === "process" && codexAuthValue !== undefined)
          return yield* usage("--codex-auth is only valid with --isolation docker");
        if (isolation === "process" && githubConfigValue !== undefined)
          return yield* usage("--github-config is only valid with --isolation docker");
        if (isolation === "docker" && imageValue === undefined)
          return yield* usage(
            "--image is required with --isolation docker",
            "Use a digest-pinned image: REPOSITORY@sha256:DIGEST.",
          );
        if (
          isolation === "docker" &&
          imageValue !== undefined &&
          !RUNNER_IMAGE_PATTERN.test(imageValue)
        )
          return yield* usage(
            "--image must be digest-pinned as REPOSITORY@sha256:64_LOWER_HEX or sha256:64_LOWER_HEX",
          );
        if (isolation === "docker" && codexAuthValue === undefined)
          return yield* usage("--codex-auth is required with --isolation docker");
        if (isolation === "docker" && githubConfigValue === undefined)
          return yield* usage("--github-config is required with --isolation docker");
        if (codexAuthValue !== undefined && !isAbsolute(codexAuthValue))
          return yield* usage("--codex-auth must be an absolute path");
        if (githubConfigValue !== undefined && !isAbsolute(githubConfigValue))
          return yield* usage("--github-config must be an absolute path");
        if (isolation === "docker" && codexAuthValue !== undefined)
          yield* validateCredentialSource("--codex-auth", codexAuthValue);
        if (isolation === "docker" && githubConfigValue !== undefined)
          yield* validateCredentialSource("--github-config", githubConfigValue);
        const runtimeIsolation =
          isolation === "process"
            ? ({ type: "process" } as const)
            : yield* Effect.gen(function* () {
                if (imageValue === undefined)
                  return yield* usage("--image is required with --isolation docker");
                if (codexAuthValue === undefined)
                  return yield* usage("--codex-auth is required with --isolation docker");
                if (githubConfigValue === undefined)
                  return yield* usage("--github-config is required with --isolation docker");
                const identity = processIdentity();
                if (identity === undefined)
                  return yield* usage("--isolation docker requires a numeric process uid and gid");
                return {
                  type: "docker" as const,
                  image: imageValue,
                  uid: identity.uid,
                  gid: identity.gid,
                  safePath: RUNNER_CONTAINER_PATH,
                  codexAuthSource: codexAuthValue,
                  githubConfigSource: githubConfigValue,
                };
              });
        const url = new URL(`/api/runners/${encodeURIComponent(name)}/connect`, host);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const runtimeLayer = runnerRuntimeLayer({
          root,
          runnerIdentity: name,
          hostFetch: runtime.hostFetch,
          childEnvironment: runnerChildEnvironment(runtime.env),
          isolation: runtimeIsolation,
        });
        yield* Effect.gen(function* () {
          const runnerRuntime = yield* RunnerRuntime;
          return yield* runRunnerSupervisor({
            url: url.href,
            runnerName: name,
            token,
            httpHandler: (identity, request) => runnerRuntime.mountedHttp(identity, request),
            onOpen: Effect.sync(() => {
              if (autoJson) outputJson(runtime.stdout, { runner: name, status: "connected" });
              else runtime.stdout(`Runner ${name} connected.\n`);
            }),
          });
        }).pipe(
          Effect.provide(runtimeLayer),
          Effect.mapError(
            () =>
              new CliError(
                "runner_connection_failed",
                "Runner connection ended unexpectedly",
                "Check the Scotty host, runner token, and network, then retry.",
                EXIT.GENERIC,
              ),
          ),
        );
      }),
  ).pipe(Command.withDescription("Serve work over an outbound control-plane connection"));

  const runnerSetup = Command.make(
    "setup",
    {
      name: Flag.string("name").pipe(Flag.withDescription("Stable runner name")),
      root: Flag.string("root").pipe(Flag.withDescription("Absolute runner workspace root")),
      image: Flag.string("image").pipe(Flag.withDescription("Digest-pinned Docker image")),
      codexAuth: Flag.string("codex-auth").pipe(
        Flag.withDescription("Absolute host path to Codex auth.json"),
      ),
      sourceBinary: Flag.string("source-binary").pipe(
        Flag.withDescription("Absolute path to the compiled Scotty executable"),
        Flag.optional,
      ),
      replace: Flag.boolean("replace").pipe(
        Flag.withDescription("Rotate an existing registration before reinstalling"),
      ),
    },
    ({ codexAuth, image, name, replace, root, sourceBinary }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (!RUNNER_NAME_PATTERN.test(name))
          return yield* usage("--name must contain only letters, numbers, underscores, or dashes");
        if (!isAbsolute(root)) return yield* usage("--root must be an absolute path");
        if (!RUNNER_IMAGE_PATTERN.test(image))
          return yield* usage(
            "--image must be digest-pinned as REPOSITORY@sha256:64_LOWER_HEX or sha256:64_LOWER_HEX",
          );
        if (!isAbsolute(codexAuth)) return yield* usage("--codex-auth must be an absolute path");
        const sourceBinaryValue = Option.getOrUndefined(sourceBinary) ?? process.execPath;
        if (!isAbsolute(sourceBinaryValue))
          return yield* usage("--source-binary must be an absolute path");
        const auth = yield* credentials(options);
        const hostUrl = new URL(auth.host);
        if (hostUrl.protocol !== "https:" && !isLoopbackHost(hostUrl.hostname))
          return yield* usage(
            "runner setup requires an HTTPS Scotty host",
            "Use HTTPS, or use HTTP only for a loopback development host.",
          );
        const provisionRunnerToken = requestJson(auth, "/api/runners", {
          method: "POST",
          body: JSON.stringify({ name, replace }),
        }).pipe(
          Effect.flatMap((raw) => {
            const registered = decodeRunnerRegistrationResponse(raw);
            return Option.isSome(registered)
              ? Effect.succeed(registered.value.credential)
              : Effect.fail(invalidResponse("Server returned an invalid runner registration"));
          }),
        );
        const result = yield* setupRunner({
          codexAuthSource: codexAuth,
          host: auth.host,
          image,
          name,
          provisionRunnerToken,
          root,
          sourceBinary: sourceBinaryValue,
        });
        if (autoJson) outputJson(runtime.stdout, result);
        else runtime.stdout(`Runner ${result.runner} service is active at ${result.service}.\n`);
      }),
  ).pipe(Command.withDescription("Install and start a trusted runner user service"));

  const runnerList = Command.make("list", {}, () =>
    Effect.gen(function* () {
      const { autoJson, options, runtime } = yield* commandContext();
      const decoded = decodeRunnerStatusesResponse(
        yield* requestJson(yield* credentials(options), "/api/runners"),
      );
      if (Option.isNone(decoded))
        return yield* invalidResponse("Server returned an invalid runner list");
      if (autoJson) outputJson(runtime.stdout, decoded.value);
      else
        runtime.stdout(
          decoded.value.length === 0
            ? "No runners registered.\n"
            : `${decoded.value
                .map(
                  (runner) =>
                    `${runner.name}: ${runner.desired}, ${runner.connection}, ${runner.assignedSessions} assigned`,
                )
                .join("\n")}\n`,
        );
    }),
  ).pipe(Command.withAlias("ls"), Command.withDescription("List registered runners"));

  const runnerRemove = Command.make(
    "remove",
    {
      name: Argument.string("name").pipe(Argument.withDescription("Registered runner name")),
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Confirm runner removal")),
    },
    ({ name, yes }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (!RUNNER_NAME_PATTERN.test(name))
          return yield* usage(
            "Runner name must contain only letters, numbers, underscores, or dashes",
          );
        if (!yes) {
          if (!runtime.stdoutIsTTY || !runtime.stdinIsTTY)
            return yield* usage(
              "runner remove requires --yes in non-interactive use",
              "Review assigned sessions with scotty runner list, then retry with --yes.",
            );
          const answer = runtime.prompt(`Remove runner ${name}? Type ${name} to confirm: `);
          if (answer !== name)
            return yield* new CliError(
              "cancelled",
              "Runner removal cancelled",
              "Pass --yes to skip confirmation.",
              EXIT.USAGE,
            );
        }
        const auth = yield* credentials(options);
        const decoded = decodeRunnerRemovalResponse(
          yield* requestJson(auth, `/api/runners/${encodeURIComponent(name)}`, {
            method: "DELETE",
          }),
        );
        if (Option.isNone(decoded) || decoded.value.name !== name)
          return yield* invalidResponse("Server returned an invalid runner removal result");
        if (autoJson) outputJson(runtime.stdout, decoded.value);
        else runtime.stdout(`Runner ${name} removed.\n`);
      }),
  ).pipe(Command.withDescription("Disable, disconnect, and unregister a runner"));

  const runner = Command.make("runner").pipe(
    Command.withDescription("Set up and manage Scotty compute runners"),
    Command.withSubcommands([runnerServe, runnerSetup, runnerList, runnerRemove]),
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
    if (command === "vaporize") {
      const decoded = decodeVaporizeResponse(raw);
      if (Option.isNone(decoded) || decoded.value.id !== sessionId)
        return yield* new CliError(
          "invalid_response",
          "Server returned an invalid vaporize result",
          "Inspect the Worker before assuming resources were deleted.",
          EXIT.GENERIC,
        );
      const result: VaporizeOutput = { id: sessionId, status: "gone" };
      if (autoJson) outputJson(runtime.stdout, result);
      else runtime.stdout(humanResult({ command: "vaporize", value: result }));
      return;
    }
    const decoded = decodeOperationResponse(raw);
    if (Option.isNone(decoded)) return yield* invalidResponse();
    const operationId = optionalString(decoded.value.id) ?? sessionId;
    const url = optionalString(decoded.value.url);
    const branch = optionalString(decoded.value.branch);
    const backupId = optionalString(decoded.value.backupId);
    const sanitizedUrl = url
      ? yield* Effect.fromResult(sanitizeUrl(url, auth.host, sessionId))
      : undefined;
    const result: SessionOperationOutput = {
      id: operationId,
      status: decoded.value.status,
      ...(sanitizedUrl === undefined ? {} : { url: sanitizedUrl }),
      ...(branch === undefined ? {} : { branch }),
      ...(backupId === undefined ? {} : { backupId }),
    };
    if (autoJson) outputJson(runtime.stdout, result);
    else runtime.stdout(humanResult({ command, value: result }));
  });

  const snapshot = Command.make(
    "snapshot",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
    },
    ({ id }) => sessionOperation("snapshot", id, false),
  ).pipe(Command.withDescription("Checkpoint a warm session"));

  const resume = Command.make(
    "resume",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
    },
    ({ id }) => sessionOperation("resume", id, false),
  ).pipe(Command.withDescription("Restore a sleeping session"));

  const down = Command.make(
    "down",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
    },
    ({ id }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        const sessionId = yield* validateSessionId(id);
        const result = yield* handleDown(sessionId, options);
        if (autoJson) outputJson(runtime.stdout, result);
        else runtime.stdout(humanResult({ command: "down", value: result }));
      }),
  ).pipe(Command.withDescription("Fetch the branch and install the local rollout"));

  const vaporize = Command.make(
    "vaporize",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Skip the TTY confirmation")),
    },
    ({ id, yes }) => sessionOperation("vaporize", id, yes),
  ).pipe(Command.withDescription("Permanently delete a session"));

  const beam = Command.make("beam").pipe(
    Command.withDescription("Manage agent session lifecycle"),
    Command.withSubcommands([beamUp, down, vaporize]),
  );

  const tuiPair = Command.make(
    "pair",
    {
      origin: Argument.string("origin").pipe(
        Argument.withDescription("Exact Scotty Worker origin"),
      ),
      label: Flag.string("label").pipe(
        Flag.withDefault("scotty tui"),
        Flag.withDescription("Label for this standard client"),
      ),
      config: Flag.path("config").pipe(
        Flag.optional,
        Flag.withDescription("Paired-client configuration path"),
      ),
    },
    ({ config, label, origin }) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () =>
            pairTuiClient({
              origin,
              label,
              ...(Option.isSome(config) ? { configPath: config.value } : {}),
            }),
          catch: tuiFailure,
        });
      }),
  ).pipe(Command.withDescription("Pair this terminal as a standard Scotty client"));

  const tui = Command.make(
    "tui",
    {
      config: Flag.path("config").pipe(
        Flag.optional,
        Flag.withDescription("Paired-client configuration path"),
      ),
    },
    ({ config }) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => runTuiConsole(Option.getOrUndefined(config)),
          catch: tuiFailure,
        });
      }),
  ).pipe(
    Command.withDescription("Open the interactive Scotty fleet console"),
    Command.withSubcommands([tuiPair]),
  );

  return scotty.pipe(
    Command.withSubcommands([
      init,
      recover,
      deployInstallationCommand,
      upgrade,
      uninstall,
      beam,
      list,
      inspect,
      steer,
      doctor,
      attach,
      auth,
      owner,
      snapshot,
      resume,
      sandbox,
      tools,
      runner,
      tui,
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
      Effect.provideService(CliOutput.Formatter, CliOutput.defaultFormatter()),
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
