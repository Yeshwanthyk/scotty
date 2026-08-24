import { isAbsolute } from "node:path";
import { Clock, Console, Effect, FileSystem, Option, Predicate, Ref, Result, Schema } from "effect";
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
  beamUpSession,
  credentials,
  installationOrigin,
  readConfig,
  rootCredentials,
  secureWrite,
  sha256Hex,
} from "./dependencies";
import {
  decodeInitJournalJson,
  decodeClientCredential,
  decodeAuthLogoutResponse,
  decodeAuthMeResponse,
  decodeEnvironmentMutation,
  decodeEnvironmentResponse,
  decodeSessionEnvironmentStatus,
  decodeInspectResponse,
  decodeOperationResponse,
  decodeRepositoriesResponse,
  decodeRepositoryRemovalResponse,
  decodeRepositoryResponse,
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
import { isRepositoryIdentity } from "../../protocol/repository";
import {
  browserUrl,
  durationSeconds,
  EMBEDDED_SKILL,
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
  usage,
} from "./pure";
import { encodeSandboxSyncJson, formatSandboxSync, sandboxSyncOutput } from "./sandbox-bundle";
import { sandboxConfigPath, saveSandboxConfig, standardSandboxConfig } from "./sandbox-config";
import {
  formatSandboxActivationPlan,
  synchronizeLocalSandbox,
  type SandboxActivationPlan,
  type SandboxSyncTarget,
} from "./sandbox-sync";
import { installationStatePath, operationStatePath, stateLockPath } from "./local-paths";
import {
  BrowserLauncher,
  CredentialStore,
  CliRuntime,
  CliUpgrader,
  FileSystem as CliFileSystem,
  InstallationCreator,
  InstallationDeployer,
  InstallationRecovery,
  InstallationUninstaller,
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
import { runTuiConsole } from "../../tui/src/main.ts";
import { consumePairing } from "../../tui/src/pairing.ts";
import { readSecretLine } from "../../tui/src/secret-input.ts";
import {
  loadRootIdentity,
  loadClientIdentity,
  removeClientIdentity,
  removeRootIdentity,
  saveClientIdentity,
  saveRootIdentity,
  type LocalIdentityError,
} from "./local-identity";
import { PI_CONSOLE_MAX_STRING_BYTES } from "../../protocol/pi-console.ts";
import { ENVIRONMENT_NAME_PATTERN } from "../../worker/src/environment-contracts.ts";
import { PiThinkingLevelSchema } from "../../protocol/sandbox-config.ts";

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
const decodePiThinkingLevel = Schema.decodeUnknownResult(PiThinkingLevelSchema);
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

const localIdentityUpdateFailure = (error: LocalIdentityError): CliError =>
  new CliError(
    "local_identity_invalid",
    `Scotty ${error.kind} identity could not be updated safely`,
    "Retry; if this persists, inspect the local credential store before changing remote state.",
    error.reason === "empty" || error.reason.includes("permission") ? EXIT.USAGE : EXIT.GENERIC,
  );

const clientIdFromCredential = (credential: string): string | undefined => {
  const [, id] = credential.split(".");
  return id !== undefined && /^[0-9a-f]{12}$/u.test(id) ? id : undefined;
};

const synchronizeInstallationSandbox = Effect.fnUntraced(function* (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  target: SandboxSyncTarget,
  approveActivation: (plan: SandboxActivationPlan) => Effect.Effect<void, CliError>,
) {
  return yield* synchronizeLocalSandbox({
    home,
    env: { ...env },
    target,
    approveActivation,
  }).pipe(
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

const sandboxActivationApproval = (
  runtime: {
    readonly stdinIsTTY: boolean;
    readonly stdoutIsTTY: boolean;
    readonly stdout: (text: string) => void;
    readonly prompt: (question: string) => string | null;
  },
  yes: boolean,
  jsonOutput = false,
) =>
  Effect.fnUntraced(function* (plan: SandboxActivationPlan) {
    if (yes) return;
    if (jsonOutput)
      return yield* usage(
        "sandbox sync requires --yes before activation in non-interactive use",
        "Review the Plugin source and snapshot change plan, then retry with --yes.",
      );
    if (!runtime.stdinIsTTY || !runtime.stdoutIsTTY)
      return yield* usage(
        "sandbox sync requires --yes before activation in non-interactive use",
        "Review the Plugin source and snapshot change plan, then retry with --yes.",
      );
    runtime.stdout(formatSandboxActivationPlan(plan));
    const answer = runtime.prompt(`Activate Sandbox revision ${plan.nextRevision}? [y/N]: `);
    if (answer?.trim().toLowerCase() !== "y")
      return yield* new CliError(
        "cancelled",
        "Sandbox synchronization cancelled",
        "No immutable inputs were uploaded and the active snapshot was unchanged.",
        EXIT.USAGE,
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
    if (Predicate.isTagged(item, "UnknownSubcommand") && item.parent?.length === 1)
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

  const rootToken = (): string =>
    `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;

  const rootVerifier = (credential: string) => sha256Hex(credential);

  const loadSetupRoot = Effect.fnUntraced(function* (expectedVerifier: string) {
    const credential = yield* loadRootIdentity().pipe(Effect.mapError(localIdentityUpdateFailure));
    if (credential === undefined)
      return yield* new CliError(
        "local_identity_missing",
        "The pending setup root identity is missing",
        "Restore the original local root identity before resuming this operation.",
        EXIT.GENERIC,
      );
    if ((yield* rootVerifier(credential)) !== expectedVerifier)
      return yield* new CliError(
        "local_identity_conflict",
        "The pending setup root identity does not match its journal",
        "Restore the original local root identity before resuming this operation.",
        EXIT.GENERIC,
      );
    return credential;
  });

  const issueOwnerRecovery = Effect.fnUntraced(function* (host: string, credential: string) {
    const browser = yield* BrowserLauncher;
    const raw = yield* requestJson({ host, token: credential }, "/api/auth/recovery-grants", {
      method: "POST",
    });
    const nowMillis = yield* Clock.currentTimeMillis;
    const recovery = yield* Effect.fromResult(stableRecoveryGrant(raw, host, nowMillis));
    yield* browser.open(recovery.url);
    return recovery.expiresAt;
  });

  const managedConfig = (deployed: InstallationResult, adoptionManifestPath?: string) => ({
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
      piProvider: Flag.string("pi-provider").pipe(
        Flag.optional,
        Flag.withDescription("Pi provider ID for new Sessions"),
      ),
      piModel: Flag.string("pi-model").pipe(
        Flag.optional,
        Flag.withDescription("Pi model ID for new Sessions"),
      ),
      piThinking: Flag.choice("pi-thinking", [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ] as const).pipe(Flag.optional, Flag.withDescription("Pi thinking level for new Sessions")),
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Confirm the displayed installation")),
    },
    ({
      enableEvidence,
      name,
      piModel,
      piProvider,
      piThinking,
      previewBase,
      previewZoneId,
      profile,
      yes,
    }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (options.host || options.tokenFile)
          return yield* usage("init does not accept --host or --token-file");
        const installationName = yield* requireInstallationName("init", name);
        const preview = yield* optionalPreviewConfiguration(previewBase, previewZoneId);
        if (enableEvidence && preview === undefined)
          return yield* usage("--enable-evidence requires --preview-base and --preview-zone-id");
        const evidenceEnabled = enableEvidence ? (true as const) : undefined;
        const defaultProvider =
          Option.getOrUndefined(piProvider)?.trim() ||
          (runtime.stdinIsTTY ? runtime.prompt("Pi provider ID: ")?.trim() : undefined);
        const defaultModel =
          Option.getOrUndefined(piModel)?.trim() ||
          (runtime.stdinIsTTY ? runtime.prompt("Pi model ID: ")?.trim() : undefined);
        const defaultThinkingLevel =
          Option.getOrUndefined(piThinking) ??
          (runtime.stdinIsTTY
            ? runtime.prompt("Pi thinking level (off|minimal|low|medium|high|xhigh|max): ")?.trim()
            : undefined);
        const decodedThinkingLevel = decodePiThinkingLevel(defaultThinkingLevel);
        if (
          defaultProvider === undefined ||
          defaultProvider.length === 0 ||
          defaultModel === undefined ||
          defaultModel.length === 0 ||
          Result.isFailure(decodedThinkingLevel)
        )
          return yield* usage(
            "init requires explicit Pi provider, model, and thinking settings",
            "Pass --pi-provider, --pi-model, and --pi-thinking, or answer the interactive prompts.",
          );
        yield* ensureDocker();
        const fileSystem = yield* CliFileSystem;
        const journalPath = operationStatePath(
          runtime.home,
          runtime.env,
          `init-${installationName}.json`,
        );
        const lockPath = stateLockPath(runtime.home, runtime.env, `init-${installationName}`);
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
              ? yield* loadSetupRoot(existingJournal.value.rootVerifier)
              : rootToken();
            const verifier = yield* rootVerifier(token);
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
              rootVerifier: verifier,
            };
            if (Option.isNone(existingJournal)) {
              yield* saveRootIdentity(token).pipe(Effect.mapError(localIdentityUpdateFailure));
              yield* secureWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
            }
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
              rootVerifierBootstrap: verifier,
              expectedAccountId: plan.accountId,
              expectedPlanFingerprint: plan.fingerprint,
              mode: Option.isSome(existingJournal) ? "resume" : "fresh",
            });
            const host = yield* Effect.fromResult(normalizeHost(deployed.host));
            const configPath = sandboxConfigPath(runtime.home, runtime.env);
            const statePath = installationStatePath(runtime.home, runtime.env);
            yield* secureWrite(
              statePath,
              `${JSON.stringify(managedConfig({ ...deployed, host }), null, 2)}\n`,
            );
            yield* saveSandboxConfig(
              configPath,
              standardSandboxConfig({
                installationName,
                cloudflareAccountId: deployed.accountId,
                pi: {
                  defaultProvider,
                  defaultModel,
                  defaultThinkingLevel: decodedThinkingLevel.success,
                },
              }),
            );
            yield* issueOwnerRecovery(host, token);
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
            if (autoJson) outputJson(runtime.stdout, result);
            else {
              runtime.stdout(`Saved ${configPath} with mode 0600\n`);
              runtime.stdout(
                "Scotty is deployed. Complete owner recovery in the opened browser, then pair this client.\n",
              );
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

        const configPath = sandboxConfigPath(runtime.home, runtime.env);
        const statePath = installationStatePath(runtime.home, runtime.env);
        const journalPath = operationStatePath(
          runtime.home,
          runtime.env,
          `recover-${installationName}.json`,
        );
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
              existingJournal.adoptionManifestPath === adoptionManifestPath &&
              typeof existingJournal.rootVerifier === "string";
            const token = journalMatchesTarget
              ? yield* loadSetupRoot(existingJournal.rootVerifier ?? "")
              : rootToken();
            const verifier = yield* rootVerifier(token);
            if (!journalMatchesTarget)
              yield* saveRootIdentity(token).pipe(Effect.mapError(localIdentityUpdateFailure));
            yield* secureWrite(
              journalPath,
              `${JSON.stringify(
                {
                  ...managedConfig(inspected, adoptionManifestPath),
                  operation: "recover",
                  phase: "apply_started",
                  rootVerifier: verifier,
                },
                null,
                2,
              )}\n`,
            );
            const recovered = yield* recovery.recover({
              ...deploymentTarget,
              rootVerifierBootstrap: verifier,
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
            yield* issueOwnerRecovery(host, token);
            yield* secureWrite(
              statePath,
              `${JSON.stringify(
                managedConfig({ ...recovered, host }, adoptionManifestPath),
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
        const configPath = sandboxConfigPath(runtime.home, runtime.env);
        const statePath = installationStatePath(runtime.home, runtime.env);
        const config = yield* readConfig(statePath);
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
        yield* removeClientIdentity().pipe(Effect.mapError(localIdentityUpdateFailure));
        yield* removeRootIdentity().pipe(Effect.mapError(localIdentityUpdateFailure));
        for (const path of [configPath, statePath])
          yield* fileSystem
            .remove(path)
            .pipe(
              Effect.catch((error) =>
                error.code === "ENOENT"
                  ? Effect.void
                  : Effect.fail(
                      new CliError(
                        "config_cleanup_failed",
                        "Cloudflare resources were removed but local Scotty state remains",
                        `Remove ${path} manually.`,
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
        const statePath = installationStatePath(runtime.home, runtime.env);
        const config = yield* readConfig(statePath);
        if (!config.installationName || !config.profile || !config.accountId)
          return yield* usage(
            "No managed Scotty installation is configured",
            "Run scotty init or scotty recover first.",
          );
        const auth = yield* credentials(options);
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
        if (autoJson && !yes && plan.changes.length > 0)
          return yield* usage(
            "deploy requires --yes when the plan contains changes",
            "Review the deployment plan, then retry with --yes.",
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
          yield* synchronizeInstallationSandbox(
            runtime.home,
            runtime.env,
            { ...auth, host: yield* Effect.fromResult(normalizeHost(config.host)) },
            sandboxActivationApproval(runtime, yes, autoJson),
          );
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
          statePath,
          `${JSON.stringify(
            managedConfig({ ...deployed, host }, config.adoptionManifestPath),
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
        yield* synchronizeInstallationSandbox(
          runtime.home,
          runtime.env,
          { ...auth, host },
          sandboxActivationApproval(runtime, yes, autoJson),
        );
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
        const decoded = yield* beamUpSession(auth, body);
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

  const environmentRepoFlag = Flag.string("repo").pipe(
    Flag.optional,
    Flag.withDescription("Repository scope as OWNER/NAME"),
  );
  const environmentPath = (path: string, repo: Option.Option<string>): string =>
    Option.isSome(repo) ? `${path}?repo=${encodeURIComponent(repo.value)}` : path;
  const ENVIRONMENT_MAX_ORIGINS = 32;

  /**
   * Parses comma-separated origins into exact HTTPS origins. Bare hosts gain the https scheme so
   * `--origins github.com` and `--origins https://github.com` are equivalent.
   */
  const parseOrigins = Effect.fnUntraced(function* (raw: string) {
    const entries = raw.split(",");
    if (entries.some((entry) => entry.trim() === ""))
      return yield* usage("--origins must be a comma-separated list of hosts or HTTPS origins");
    if (entries.length > ENVIRONMENT_MAX_ORIGINS)
      return yield* usage(`--origins accepts at most ${ENVIRONMENT_MAX_ORIGINS} origins`);
    const origins: string[] = [];
    for (const entry of entries) {
      const candidate = entry.trim().toLowerCase();
      const parsed = Result.try(
        () => new URL(candidate.startsWith("https://") ? candidate : `https://${candidate}`),
      );
      if (Result.isFailure(parsed))
        return yield* usage(`--origins entry is invalid: ${entry.trim()}`);
      const url = parsed.success;
      const canonical = url.origin;
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== "" ||
        (url.port !== "" && url.port !== "443") ||
        url.origin === "null" ||
        canonical.length > 512
      )
        return yield* usage(
          `--origins entry must be an exact HTTPS origin without a path, query, fragment, or credentials: ${entry.trim()}`,
        );
      if (!origins.includes(canonical)) origins.push(canonical);
    }
    return origins;
  });

  const envList = Command.make("list", { repo: environmentRepoFlag }, ({ repo }) =>
    Effect.gen(function* () {
      if (Option.isSome(repo) && !isRepositoryIdentity(repo.value))
        return yield* usage("--repo must be OWNER/NAME");
      const { autoJson, options, runtime } = yield* commandContext();
      const decoded = decodeEnvironmentResponse(
        yield* requestJson(yield* credentials(options), environmentPath("/api/environment", repo)),
      );
      if (Option.isNone(decoded))
        return yield* invalidResponse("Server returned an invalid environment view");
      if (autoJson) outputJson(runtime.stdout, decoded.value);
      else {
        const lines = decoded.value.variables.map((variable) => {
          const scope = Option.isSome(repo) ? `\t${variable.source}` : "";
          const origins = variable.origins?.length ? `\t${variable.origins.join(",")}` : "";
          return variable.secret
            ? `${variable.name}\tsecret\tconfigured${origins}${scope}`
            : `${variable.name}\tplain\t${variable.value ?? ""}${origins}${scope}`;
        });
        runtime.stdout(
          lines.length === 0
            ? Option.isSome(repo)
              ? `No environment variables for ${repo.value}.\n`
              : "No global environment variables.\n"
            : `${lines.join("\n")}\n`,
        );
      }
    }),
  ).pipe(Command.withAlias("ls"), Command.withDescription("List global environment variables"));

  const envSet = Command.make(
    "set",
    {
      name: Argument.string("name").pipe(Argument.withDescription("Environment variable name")),
      value: Argument.string("value").pipe(Argument.optional),
      secret: Flag.boolean("secret").pipe(
        Flag.withDescription("Store a write-only secret read from stdin"),
      ),
      stdin: Flag.boolean("stdin").pipe(Flag.withDescription("Read the value from stdin")),
      origins: Flag.string("origins").pipe(
        Flag.optional,
        Flag.withDescription(
          "Comma-separated exact HTTPS origins where this credential may be injected",
        ),
      ),
      repo: environmentRepoFlag,
    },
    ({ name, origins, repo, secret, stdin, value }) =>
      Effect.gen(function* () {
        if (!ENVIRONMENT_NAME_PATTERN.test(name))
          return yield* usage("Environment variable name is invalid");
        if (Option.isSome(repo) && !isRepositoryIdentity(repo.value))
          return yield* usage("--repo must be OWNER/NAME");
        if (secret && !stdin) return yield* usage("Secret values must be supplied with --stdin");
        if (stdin && Option.isSome(value))
          return yield* usage("Do not pass a value when using --stdin");
        if (!stdin && Option.isNone(value))
          return yield* usage("Environment set needs a value or --stdin");
        const parsedOrigins = Option.isSome(origins)
          ? yield* parseOrigins(origins.value)
          : undefined;
        const { autoJson, options, runtime } = yield* commandContext();
        const inputValue = stdin
          ? (yield* Effect.tryPromise({
              try: runtime.readStdin,
              catch: () =>
                new CliError(
                  "stdin_error",
                  "Could not read the environment value from stdin",
                  "Pipe the value to scotty env set and retry.",
                  EXIT.GENERIC,
                ),
            })).replace(/\r?\n$/u, "")
          : Option.getOrElse(value, () => "");
        const decoded = decodeEnvironmentMutation(
          yield* requestJson(
            yield* credentials(options),
            environmentPath(`/api/environment/${encodeURIComponent(name)}`, repo),
            {
              method: "PUT",
              body: JSON.stringify({
                value: inputValue,
                secret,
                ...(parsedOrigins === undefined ? {} : { origins: parsedOrigins }),
              }),
            },
          ),
        );
        if (Option.isNone(decoded))
          return yield* invalidResponse("Server returned an invalid environment update");
        if (autoJson) outputJson(runtime.stdout, decoded.value);
        else
          runtime.stdout(
            `Set ${name} as ${secret ? "secret" : "plain"}${
              parsedOrigins === undefined ? "" : ` for ${parsedOrigins.join(", ")}`
            }.\n`,
          );
      }),
  ).pipe(Command.withDescription("Set a global environment variable"));

  const envRemove = Command.make(
    "remove",
    {
      name: Argument.string("name").pipe(Argument.withDescription("Environment variable name")),
      repo: environmentRepoFlag,
    },
    ({ name, repo }) =>
      Effect.gen(function* () {
        if (!ENVIRONMENT_NAME_PATTERN.test(name))
          return yield* usage("Environment variable name is invalid");
        if (Option.isSome(repo) && !isRepositoryIdentity(repo.value))
          return yield* usage("--repo must be OWNER/NAME");
        const { autoJson, options, runtime } = yield* commandContext();
        const decoded = decodeEnvironmentMutation(
          yield* requestJson(
            yield* credentials(options),
            environmentPath(`/api/environment/${encodeURIComponent(name)}`, repo),
            { method: "DELETE" },
          ),
        );
        if (Option.isNone(decoded))
          return yield* invalidResponse("Server returned an invalid environment removal");
        if (autoJson) outputJson(runtime.stdout, decoded.value);
        else
          runtime.stdout(decoded.value.removed ? `Removed ${name}.\n` : `${name} was not set.\n`);
      }),
  ).pipe(Command.withDescription("Remove a global environment variable"));

  const envRefresh = Command.make(
    "refresh",
    {
      id: Argument.string("session-id").pipe(Argument.withDescription("Warm session ID")),
    },
    ({ id }) =>
      Effect.gen(function* () {
        const sessionId = yield* validateSessionId(id);
        const { autoJson, options, runtime } = yield* commandContext();
        const decoded = decodeSessionEnvironmentStatus(
          yield* requestJson(
            yield* credentials(options),
            `/api/sessions/${encodeURIComponent(sessionId)}/environment/refresh`,
            { method: "POST" },
          ),
        );
        if (Option.isNone(decoded))
          return yield* invalidResponse("Server returned an invalid environment refresh");
        if (autoJson) outputJson(runtime.stdout, decoded.value);
        else
          runtime.stdout(
            decoded.value.stale
              ? `Session ${sessionId} environment remains stale.\n`
              : `Refreshed session ${sessionId} to environment revision ${decoded.value.appliedRevision}.\n`,
          );
      }),
  ).pipe(Command.withDescription("Refresh one warm session environment"));

  const environment = Command.make("env").pipe(
    Command.withDescription("Manage global environment variables"),
    Command.withSubcommands([envList, envSet, envRemove, envRefresh]),
  );

  const repoAdd = Command.make(
    "add",
    {
      repo: Argument.string("repo").pipe(
        Argument.withDescription("GitHub repository as OWNER/NAME"),
      ),
    },
    ({ repo }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (!isRepositoryIdentity(repo)) return yield* usage("Repository must be OWNER/NAME");
        const auth = yield* credentials(options);
        const decoded = decodeRepositoryResponse(
          yield* requestJson(auth, "/api/repos", {
            method: "POST",
            body: JSON.stringify({ repo }),
          }),
        );
        if (Option.isNone(decoded))
          return yield* invalidResponse("Server returned an invalid repository registration");
        if (autoJson) outputJson(runtime.stdout, decoded.value);
        else runtime.stdout(`Added ${decoded.value.repo} (${decoded.value.defaultBranch}).\n`);
      }),
  ).pipe(Command.withDescription("Verify and register a GitHub repository"));

  const repoList = Command.make("list", {}, () =>
    Effect.gen(function* () {
      const { autoJson, options, runtime } = yield* commandContext();
      const auth = yield* credentials(options);
      const decoded = decodeRepositoriesResponse(yield* requestJson(auth, "/api/repos"));
      if (Option.isNone(decoded))
        return yield* invalidResponse("Server returned an invalid repository list");
      if (autoJson) outputJson(runtime.stdout, decoded.value);
      else if (decoded.value.length === 0) runtime.stdout("No repositories.\n");
      else
        runtime.stdout(
          `${decoded.value
            .map(
              (entry) =>
                `${entry.repo}\t${entry.defaultBranch}\t${entry.addedAt}\t${entry.lastUsedAt}`,
            )
            .join("\n")}\n`,
        );
    }),
  ).pipe(Command.withAlias("ls"), Command.withDescription("List registered repositories"));

  const repoRemove = Command.make(
    "remove",
    {
      repo: Argument.string("repo").pipe(
        Argument.withDescription("Registered repository as OWNER/NAME"),
      ),
    },
    ({ repo }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (!isRepositoryIdentity(repo)) return yield* usage("Repository must be OWNER/NAME");
        const auth = yield* credentials(options);
        const [owner, name] = repo.split("/");
        const decoded = decodeRepositoryRemovalResponse(
          yield* requestJson(
            auth,
            `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
            { method: "DELETE" },
          ),
        );
        if (Option.isNone(decoded))
          return yield* invalidResponse("Server returned an invalid repository removal result");
        if (autoJson) outputJson(runtime.stdout, decoded.value);
        else
          runtime.stdout(
            decoded.value.removed
              ? `Removed ${decoded.value.repo}.\n`
              : `Repository ${decoded.value.repo} was not registered.\n`,
          );
      }),
  ).pipe(Command.withDescription("Remove a repository from the catalogue"));

  const repo = Command.make("repo").pipe(
    Command.withDescription("Manage registered GitHub repositories"),
    Command.withSubcommands([repoAdd, repoList, repoRemove]),
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
      const config = yield* readConfig(installationStatePath(runtime.home, runtime.env));
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
      const auth = yield* rootCredentials(options);
      const expiresAt = yield* issueOwnerRecovery(auth.host, auth.token);
      const result = { opened: true, expiresAt };
      if (autoJson) outputJson(runtime.stdout, result);
      else runtime.stdout(`Opened owner recovery in your browser. It expires at ${expiresAt}.\n`);
    }),
  ).pipe(Command.withDescription("Recover ownership on a replacement device"));

  const owner = Command.make("owner").pipe(
    Command.withDescription("Manage browser ownership"),
    Command.withSubcommands([ownerRecover]),
  );

  const skillsShow = Command.make("show", {}, () =>
    Effect.gen(function* () {
      const { options, runtime } = yield* commandContext();
      if (options.json)
        return yield* usage(
          "scotty skills show emits Markdown and does not support --json",
          "Run scotty skills show without flags.",
        );
      runtime.stdout(EMBEDDED_SKILL);
    }),
  ).pipe(Command.withDescription("Print the embedded agent skill"));

  const skills = Command.make("skills").pipe(
    Command.withDescription("Show embedded agent skills"),
    Command.withSubcommands([skillsShow]),
  );

  const emitSandboxSync = (
    autoJson: boolean,
    runtime: { readonly stdout: (text: string) => void },
    output: ReturnType<typeof sandboxSyncOutput>,
  ): void => {
    if (autoJson) outputJson(runtime.stdout, encodeSandboxSyncJson(output));
    else runtime.stdout(formatSandboxSync(output));
  };

  const sandboxSync = Command.make(
    "sync",
    {
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Approve snapshot activation")),
    },
    ({ yes }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        const target = yield* credentials(options);
        const synced = yield* synchronizeInstallationSandbox(
          runtime.home,
          runtime.env,
          target,
          sandboxActivationApproval(runtime, yes, autoJson),
        );
        emitSandboxSync(
          autoJson,
          runtime,
          sandboxSyncOutput(synced.config, synced.built, synced.remote),
        );
      }),
  ).pipe(Command.withDescription("Prepare the local sandbox bundle and synchronize it"));

  const sandbox = Command.make("sandbox").pipe(
    Command.withDescription("Synchronize installation Plugins and Sandbox setup"),
    Command.withSubcommands([sandboxSync]),
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
  ).pipe(Command.withDescription("Restore a stopped session"));

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

  const clientPair = Command.make(
    "pair",
    {
      origin: Argument.string("origin").pipe(
        Argument.withDescription("Exact Scotty Worker origin"),
      ),
      label: Flag.string("label").pipe(
        Flag.withDefault("scotty cli"),
        Flag.withDescription("Label for this standard client"),
      ),
    },
    ({ label, origin }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        const expectedOrigin = yield* installationOrigin(options, origin);
        const pairingInput = yield* Effect.tryPromise({
          try: () =>
            runtime.stdinIsTTY
              ? readSecretLine("Pairing credential or URL: ")
              : runtime.readStdin(),
          catch: tuiFailure,
        });
        const paired = yield* Effect.tryPromise({
          try: () =>
            consumePairing({
              origin: expectedOrigin,
              pairingInput,
              label,
              fetch: (input, init) => runtime.hostFetch(new Request(input, init)),
            }),
          catch: tuiFailure,
        });
        yield* saveClientIdentity(paired.credential).pipe(
          Effect.mapError(localIdentityUpdateFailure),
        );
        const clientId = clientIdFromCredential(paired.credential);
        if (clientId === undefined)
          return yield* invalidResponse("Pairing returned an invalid client identity");
        const result = { origin: expectedOrigin, clientId, status: "paired" as const };
        if (autoJson) outputJson(runtime.stdout, result);
        else runtime.stdout(`Paired client ${clientId} with ${expectedOrigin}.\n`);
      }),
  ).pipe(Command.withDescription("Pair this CLI as a standard Scotty client"));

  const clientStatus = Command.make("status", {}, () =>
    Effect.gen(function* () {
      const { autoJson, options, runtime } = yield* commandContext();
      const auth = yield* credentials(options);
      const raw = yield* requestJson(auth, "/api/auth/me", { cache: "no-store" });
      const decoded = decodeAuthMeResponse(raw);
      const clientId = clientIdFromCredential(auth.credential);
      if (
        Option.isNone(decoded) ||
        clientId === undefined ||
        decoded.value.client.id !== clientId ||
        decoded.value.client.current === false
      )
        return yield* invalidResponse("Server did not confirm the current client identity");
      const result = {
        origin: auth.host,
        scopes: decoded.value.scopes,
        client: decoded.value.client,
      };
      if (autoJson) outputJson(runtime.stdout, result);
      else
        runtime.stdout(
          `${decoded.value.client.label} (${clientId}) is paired as ${decoded.value.client.role}.\n`,
        );
    }),
  ).pipe(Command.withDescription("Verify this client with a fresh authentication request"));

  const clientUnpair = Command.make("unpair", {}, () =>
    Effect.gen(function* () {
      const { autoJson, options, runtime } = yield* commandContext();
      const auth = yield* credentials(options);
      const clientId = clientIdFromCredential(auth.credential);
      if (clientId === undefined)
        return yield* new CliError(
          "local_identity_invalid",
          "Scotty client identity is invalid",
          `Run scotty client pair ${auth.host} to replace it.`,
          EXIT.USAGE,
        );
      const raw = yield* requestJson(auth, "/api/auth/logout", { method: "POST" });
      if (Option.isNone(decodeAuthLogoutResponse(raw)))
        return yield* invalidResponse("Server did not confirm client logout");
      yield* removeClientIdentity().pipe(Effect.mapError(localIdentityUpdateFailure));
      const result = { origin: auth.host, clientId, status: "unpaired" as const };
      if (autoJson) outputJson(runtime.stdout, result);
      else runtime.stdout(`Unpaired client ${clientId}.\n`);
    }),
  ).pipe(Command.withDescription("Revoke this client and remove its local identity"));

  const client = Command.make("client").pipe(
    Command.withDescription("Manage this CLI client identity"),
    Command.withSubcommands([clientPair, clientStatus, clientUnpair]),
  );

  const tui = Command.make("tui", {}, () =>
    Effect.gen(function* () {
      const { options } = yield* commandContext();
      const origin = yield* installationOrigin(options);
      const credential = yield* loadClientIdentity().pipe(
        Effect.mapError(localIdentityUpdateFailure),
      );
      if (credential === undefined)
        return yield* usage(
          "Scotty client identity is not configured",
          `Run scotty client pair ${origin}.`,
        );
      const decodedCredential = decodeClientCredential(credential);
      if (Option.isNone(decodedCredential))
        return yield* usage(
          "Scotty client identity is invalid",
          `Run scotty client pair ${origin} to replace it.`,
        );
      const identityContext = yield* Effect.context<CliRuntime | CredentialStore | CliFileSystem>();
      yield* Effect.tryPromise({
        try: () =>
          runTuiConsole({ version: 1, origin, credential: decodedCredential.value }, (renewed) =>
            Effect.runPromiseWith(identityContext)(
              saveClientIdentity(renewed).pipe(Effect.mapError(localIdentityUpdateFailure)),
            ),
          ),
        catch: tuiFailure,
      });
    }),
  ).pipe(Command.withDescription("Open the interactive Scotty fleet console"));

  return scotty.pipe(
    Command.withSubcommands([
      init,
      recover,
      deployInstallationCommand,
      upgrade,
      uninstall,
      repo,
      environment,
      beam,
      list,
      inspect,
      steer,
      doctor,
      attach,
      skills,
      owner,
      snapshot,
      resume,
      sandbox,
      tools,
      runner,
      client,
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
