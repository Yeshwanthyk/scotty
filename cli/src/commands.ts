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
import { CliError, EXIT, VERSION, type ExitCode, type GlobalOptions, type Writer } from "./core";
import { managedInstallationPath } from "./managed-installation-path.mjs";
import {
  deploymentPlanPath,
  readDeploymentPlan,
  removeDeploymentPlan,
  writeDeploymentPlan,
  type DeploymentPlan,
} from "./deployment-plan";
import { loadEmbeddedScottySkill } from "./embedded-scotty-skill";
import { beamUpSession, credentials, readConfig, secureWrite } from "./dependencies";
import {
  decodeInitJournalJson,
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
  type AttachOutput,
  type BeamUpRequest,
  type Config,
  type InitJournal,
  type SessionOperationOutput,
  type VaporizeOutput,
} from "./schemas";
import { readLocalPiAuth } from "./pi-auth";
import { PI_AUTH_MAX_MATERIAL_BYTES, serializePiAuthProviders } from "../../protocol/pi-auth";
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
  sanitizeUrl,
  stableRecoveryGrant,
  stableSession,
  usage,
} from "./pure";
import {
  formatScottyConfigCheck,
  loadScottyTomlConfig,
  resolveConfiguredCredentialSource,
  scottyConfigCheckOutput,
} from "./scotty-config";
import {
  synchronizeCredentialedScottyToml,
  synchronizeScottyToml,
  type ScottyCredentialSyncMaterial,
  type SandboxSyncTarget,
} from "./sandbox-sync";
import { buildScottyTomlBundle, bundleItemSummaries } from "./scotty-bundle";
import {
  BrowserLauncher,
  CliRuntime,
  CliUpgrader,
  FileSystem as CliFileSystem,
  InstallationCreator,
  InstallationDeployer,
  InstallationRecovery,
  InstallationUninstaller,
  ProcessRunner,
  type InstallationPlan,
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

const readLocalGithubCliToken = Effect.fnUntraced(function* () {
  const processRunner = yield* ProcessRunner;
  const result = yield* processRunner
    .run(["gh", "auth", "token"])
    .pipe(
      Effect.mapError(
        () =>
          new CliError(
            "credential_registry_sync_invalid",
            "Could not read the GitHub CLI credential",
            "Run gh auth login, then retry scotty sync.",
            EXIT.USAGE,
          ),
      ),
    );
  const token = result.stdout.trim();
  const bytes = new TextEncoder().encode(token);
  const valid =
    result.exitCode === 0 &&
    token.length > 0 &&
    bytes.byteLength <= PI_AUTH_MAX_MATERIAL_BYTES &&
    [...token].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    });
  if (!valid)
    return yield* new CliError(
      "credential_registry_sync_invalid",
      "Could not read the GitHub CLI credential",
      "Run gh auth login, then retry scotty sync.",
      EXIT.USAGE,
    );
  return token;
});

const prepareScottyTomlBundle = Effect.fnUntraced(function* (home: string, cwd: string) {
  const loaded = yield* loadScottyTomlConfig({ home, cwd });
  return yield* buildScottyTomlBundle(loaded);
});

const prepareScottyTomlSync = Effect.fnUntraced(function* (home: string, cwd: string) {
  const loaded = yield* loadScottyTomlConfig({ home, cwd });
  const built = yield* buildScottyTomlBundle(loaded);
  const credentials: ScottyCredentialSyncMaterial[] = [];
  for (const [name, declaration] of Object.entries(loaded.config.credentials ?? {}).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (declaration.kind === "pi-auth") {
      const local = yield* readLocalPiAuth(
        resolveConfiguredCredentialSource(declaration.source, home, cwd),
      );
      if (
        new TextEncoder().encode(serializePiAuthProviders(local.providerStore)).byteLength >
        PI_AUTH_MAX_MATERIAL_BYTES
      )
        return yield* new CliError(
          "credential_registry_sync_invalid",
          "Declared Pi auth material exceeds the size limit",
          "Reduce the declared Pi auth file and retry scotty sync.",
          EXIT.USAGE,
        );
      credentials.push({
        name,
        kind: "pi-auth",
        scope: declaration.scope,
        providers: local.providerStore,
      });
    } else {
      const token = yield* readLocalGithubCliToken();
      credentials.push({
        name,
        kind: "github-cli",
        scope: declaration.scope,
        ...(declaration.repositories === undefined
          ? {}
          : { repositories: declaration.repositories }),
        token,
      });
    }
  }
  return { built, credentials } as const;
});

const mapLifecycleSyncError = (failure: CliError): CliError => {
  const hint = failure.hint;
  const preservesCorrectionContext =
    failure.code === "scotty_config_invalid" ||
    failure.code === "scotty_config_read_failed" ||
    failure.code === "sandbox_source_invalid" ||
    failure.code === "sandbox_package_unsupported" ||
    failure.code === "sandbox_bundle_too_large";
  const mappedHint = hint.includes("scotty sync")
    ? hint
    : preservesCorrectionContext
      ? `${hint} Run scotty sync after correcting the issue.`
      : "Retry scotty sync.";
  return new CliError(failure.code, failure.message, mappedHint, failure.exitCode);
};

const synchronizeInstallationSandbox = Effect.fnUntraced(function* (
  home: string,
  cwd: string,
  target: SandboxSyncTarget,
) {
  return yield* Effect.gen(function* () {
    const built = yield* prepareScottyTomlBundle(home, cwd);
    return yield* synchronizeScottyToml({ built, target });
  }).pipe(Effect.mapError(mapLifecycleSyncError));
});

const consumeAuthorizedDeploymentPlan = Effect.fnUntraced(function* (
  home: string,
  current: DeploymentPlan,
) {
  const fileSystem = yield* CliFileSystem;
  yield* fileSystem.withLock(
    deploymentPlanPath(home),
    Effect.gen(function* () {
      const authorized = yield* readDeploymentPlan(home);
      if (authorized === undefined)
        return yield* usage(
          "deploy --yes requires a saved plan",
          "Run scotty deploy --plan --json, review it, then retry with --yes.",
        );
      const changed =
        authorized.cliVersion !== current.cliVersion ||
        authorized.installationName !== current.installationName ||
        authorized.accountId !== current.accountId ||
        authorized.planFingerprint !== current.planFingerprint ||
        authorized.bundleDigest !== current.bundleDigest;
      if (changed)
        return yield* new CliError(
          "deployment_plan_changed",
          "The deployment plan changed after it was reviewed",
          "Run scotty deploy --plan --json again and review the new plan.",
          EXIT.USAGE,
        );
      yield* removeDeploymentPlan(home);
    }),
  );
});

const validateDeploymentMode = (
  planOnly: boolean,
  apply: boolean,
): Effect.Effect<void, CliError> => {
  if (planOnly && apply) return usage("deploy does not accept --plan with --yes");
  if (!planOnly && !apply)
    return usage(
      "deploy requires --plan or --yes",
      "Run scotty deploy --plan --json, review it, then apply it with --yes.",
    );
  return Effect.void;
};

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

  const credentialWrappingKey = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Buffer.from(bytes).toString("base64url");
  };

  const managedConfig = (deployed: InstallationResult, token: string) => ({
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
    host: deployed.host,
    token,
  });

  const configuredPreview = (config: Config) =>
    config.previewBase === undefined || config.previewZoneId === undefined
      ? {}
      : { previewBase: config.previewBase, previewZoneId: config.previewZoneId };

  const configuredEvidence = (config: Config) =>
    config.evidenceEnabled === true ? { evidenceEnabled: true as const } : {};

  const completeInstallationOwnership = (
    config: Config,
  ): config is Config & { readonly accountId: string } => config.accountId !== undefined;

  const initJournalMatches = (
    journal: InitJournal,
    installationName: string,
    profile: string,
    plan: InstallationPlan,
    topology: ReturnType<typeof makeInstallationTopology>,
  ): boolean =>
    journal.installationName === installationName &&
    journal.profile === profile &&
    journal.accountId === plan.accountId &&
    journal.stackName === topology.stackName &&
    journal.workerName === topology.workerName &&
    journal.runnerWorkerName === topology.runnerWorkerName &&
    journal.containerName === topology.containerName &&
    journal.kvTitle === topology.kvTitle &&
    journal.backupBucketName === topology.backupBucketName &&
    journal.previewBase === topology.preview?.base &&
    journal.previewZoneId === topology.preview?.zoneId &&
    journal.evidenceEnabled === topology.evidenceEnabled;

  const validateInitPlan = Effect.fnUntraced(function* (
    existingJournal: Option.Option<InitJournal>,
    installationName: string,
    profile: string,
    plan: InstallationPlan,
    topology: ReturnType<typeof makeInstallationTopology>,
    journalPath: string,
  ) {
    if (
      Option.isSome(existingJournal) &&
      !initJournalMatches(existingJournal.value, installationName, profile, plan, topology)
    )
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
        Flag.withDescription("Hatch and Evidence preview DNS base"),
      ),
      previewZoneId: Flag.string("preview-zone-id").pipe(
        Flag.optional,
        Flag.withDescription("Cloudflare zone ID owning the Hatch and Evidence preview base"),
      ),
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Confirm the displayed installation")),
    },
    ({ name, previewBase, previewZoneId, profile, yes }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (options.host || options.tokenFile)
          return yield* usage("init does not accept --host or --token-file");
        const installationName = yield* requireInstallationName("init", name);
        const preview = yield* optionalPreviewConfiguration(previewBase, previewZoneId);
        if (preview === undefined)
          return yield* usage(
            "init requires --preview-base and --preview-zone-id for Hatch and Evidence",
          );
        const evidenceEnabled = true as const;
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
            if (Option.isSome(existingJournal) && existingJournal.value.phase === "apply_started")
              return yield* new CliError(
                "init_outcome_ambiguous",
                "The previous installation initialization has an ambiguous outcome",
                `Verify Cloudflare state before removing ${journalPath} or retrying scotty init; the journal was preserved and init will not retry automatically.`,
                EXIT.GENERIC,
              );
            yield* ensureDocker();
            const creator = yield* InstallationCreator;
            const deploymentTarget = {
              installationName,
              profile,
              previewBase: preview.base,
              previewZoneId: preview.zoneId,
              evidenceEnabled,
            };
            const plan = yield* creator.plan(deploymentTarget);
            const topology = makeInstallationTopology(installationName, preview, true);
            yield* validateInitPlan(
              existingJournal,
              installationName,
              profile,
              plan,
              topology,
              journalPath,
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
                  `Preview base: ${preview.base}`,
                  `Preview zone: ${preview.zoneId}`,
                  "Hatch and Evidence: enabled",
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
            const wrappingKey = Option.isSome(existingJournal)
              ? existingJournal.value.credentialWrappingKey
              : credentialWrappingKey();
            const journal = {
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
              previewBase: preview.base,
              previewZoneId: preview.zoneId,
              evidenceEnabled,
              planFingerprint: plan.fingerprint,
              token,
              credentialWrappingKey: wrappingKey,
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
              credentialWrappingKey: wrappingKey,
              expectedAccountId: plan.accountId,
              expectedPlanFingerprint: plan.fingerprint,
              mode: Option.isSome(existingJournal) ? "resume" : "fresh",
            });
            const host = yield* Effect.fromResult(normalizeHost(deployed.host));
            const configPath = managedInstallationPath(runtime.home);
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
            yield* synchronizeInstallationSandbox(runtime.home, runtime.cwd, { host, token });
            if (autoJson) outputJson(runtime.stdout, result);
            else {
              runtime.stdout(`Saved ${configPath} with mode 0600\n`);
              runtime.stdout(
                "Scotty is deployed and synchronized. Browser access is not active yet.\nRun `scotty owner recover` next to activate it.\n",
              );
            }
          }),
        );
      }),
  ).pipe(
    Command.withDescription("Create a new Scotty installation"),
    Command.withExamples([
      {
        command:
          "scotty init --name home --preview-base example.com --preview-zone-id 0123456789abcdef0123456789abcdef",
        description: "Create a Hatch and Evidence-capable installation",
      },
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
    ({ enableEvidence, name, previewBase, previewZoneId, profile, yes }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (options.host || options.tokenFile)
          return yield* usage("recover does not accept --host or --token-file");
        const installationName = yield* requireInstallationName("recover", name);
        const preview = yield* optionalPreviewConfiguration(previewBase, previewZoneId);
        if (enableEvidence && preview === undefined)
          return yield* usage("--enable-evidence requires --preview-base and --preview-zone-id");
        const evidenceEnabled = enableEvidence ? (true as const) : undefined;
        const recovery = yield* InstallationRecovery;
        const deploymentTarget = {
          installationName,
          profile,
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

        const configPath = managedInstallationPath(runtime.home);
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
              existingJournal.evidenceEnabled === inspected.evidenceEnabled;
            const token =
              journalMatchesTarget && existingJournal.token ? existingJournal.token : rootToken();
            yield* secureWrite(
              journalPath,
              `${JSON.stringify(managedConfig(inspected, token), null, 2)}\n`,
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
              `${JSON.stringify(managedConfig({ ...recovered, host }, token), null, 2)}\n`,
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
        const configPath = managedInstallationPath(runtime.home);
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
        if (!completeInstallationOwnership(config))
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
          ...configuredPreview(config),
          ...(config.previewBase === undefined || config.previewZoneId === undefined
            ? {}
            : {
                expectedPreviewBase: config.previewBase,
                expectedPreviewZoneId: config.previewZoneId,
              }),
          ...configuredEvidence(config),
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
      plan: Flag.boolean("plan").pipe(
        Flag.withDescription("Save and print the exact deployment plan without applying it"),
      ),
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Apply the saved exact deployment plan")),
    },
    ({ plan: planOnly, yes }) =>
      Effect.gen(function* () {
        const { autoJson, options, runtime } = yield* commandContext();
        if (options.host || options.tokenFile)
          return yield* usage("deploy does not accept --host or --token-file");
        yield* validateDeploymentMode(planOnly, yes);
        const config = yield* readConfig(managedInstallationPath(runtime.home));
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
        const built = yield* prepareScottyTomlBundle(runtime.home, runtime.cwd).pipe(
          Effect.mapError(mapLifecycleSyncError),
        );
        yield* ensureDocker();
        const deployer = yield* InstallationDeployer;
        const request = {
          installationName: config.installationName,
          profile: config.profile,
          ...configuredPreview(config),
          ...configuredEvidence(config),
        };
        const plan = yield* deployer.plan(request);
        if (plan.accountId !== config.accountId)
          return yield* new CliError(
            "deployment_account_changed",
            "The Cloudflare account does not match the saved installation",
            "Select the saved Alchemy profile or recover the installation before deploying.",
            EXIT.GENERIC,
          );
        const savedPlan = {
          version: 1 as const,
          cliVersion: VERSION,
          installationName: config.installationName,
          accountId: plan.accountId,
          planFingerprint: plan.fingerprint,
          bundleDigest: built.digest,
        };
        if (planOnly) {
          yield* writeDeploymentPlan(runtime.home, savedPlan);
          const result = {
            installationName: config.installationName,
            version: VERSION,
            plan: plan.fingerprint,
            bundle: built.digest,
            changes: plan.changes,
          };
          if (autoJson) outputJson(runtime.stdout, result);
          else
            runtime.stdout(
              `Installation: ${config.installationName}\nVersion: ${VERSION}\nPlan: ${plan.fingerprint}\nBundle: ${built.digest}\n${plan.changes.map((change) => `${change.action.padEnd(7)} ${change.id}`).join("\n")}${plan.changes.length === 0 ? "No infrastructure changes.\n" : "\n"}Run scotty deploy --yes to apply this exact plan.\n`,
            );
          return;
        }
        if (plan.changes.length === 0) {
          const result = {
            installationName: config.installationName,
            version: VERSION,
            plan: plan.fingerprint,
            bundle: built.digest,
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
          yield* consumeAuthorizedDeploymentPlan(runtime.home, savedPlan);
          yield* synchronizeScottyToml({
            built,
            target: {
              host: yield* Effect.fromResult(normalizeHost(config.host)),
              token: config.token,
            },
          }).pipe(Effect.mapError(mapLifecycleSyncError));
          if (autoJson) outputJson(runtime.stdout, result);
          else runtime.stdout(`${config.installationName} is already up to date.\n`);
          return;
        }
        if (config.host === undefined)
          return yield* usage(
            "Scotty host is not configured",
            "Run scotty init or scotty recover first.",
          );
        const readinessHost = yield* Effect.fromResult(normalizeHost(config.host));
        yield* consumeAuthorizedDeploymentPlan(runtime.home, savedPlan);
        if (!autoJson) runtime.stdout(`Deploying ${config.installationName}...\n`);
        const deployed = yield* deployer.deploy(
          {
            ...request,
            expectedAccountId: plan.accountId,
            expectedPlanFingerprint: plan.fingerprint,
          },
          { host: readinessHost, token: config.token },
        );
        const host = yield* Effect.fromResult(normalizeHost(deployed.host));
        yield* secureWrite(
          managedInstallationPath(runtime.home),
          `${JSON.stringify(managedConfig({ ...deployed, host }, config.token), null, 2)}\n`,
        );
        const result = {
          installationName: deployed.installationName,
          version: VERSION,
          plan: plan.fingerprint,
          bundle: built.digest,
          profile: deployed.profile,
          workerName: deployed.workerName,
          host,
          changed: true,
          changes: plan.changes,
          rootTokenRotated: false,
        };
        yield* synchronizeScottyToml({ built, target: { host, token: config.token } }).pipe(
          Effect.mapError(mapLifecycleSyncError),
        );
        if (autoJson) outputJson(runtime.stdout, result);
        else
          runtime.stdout(
            `Deployed ${deployed.installationName}. Root credentials were unchanged.\n`,
          );
      }),
  ).pipe(Command.withDescription("Deploy Scotty code without changing credentials"));

  const beam = Command.make(
    "beam",
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
        else runtime.stdout(humanResult({ command: "beam", value: result }));
      }),
  ).pipe(
    Command.withDescription("Start an agent session"),
    Command.withExamples([
      {
        command:
          'scotty beam "fix the failing tests" --title "Repair test suite" --repo owner/project --provider cloudflare',
        description: "Start a Cloudflare session",
      },
    ]),
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

  const list = Command.make("list", {}, () =>
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

  const configCheck = Command.make("check", {}, () =>
    Effect.gen(function* () {
      const { autoJson, options, runtime } = yield* commandContext();
      if (options.host !== undefined || options.tokenFile !== undefined)
        return yield* usage(
          "config check does not accept --host or --token-file",
          "This command only reads the local TOML configuration.",
        );
      const loaded = yield* loadScottyTomlConfig({ home: runtime.home, cwd: runtime.cwd });
      const result = scottyConfigCheckOutput(loaded);
      if (autoJson) outputJson(runtime.stdout, result);
      else runtime.stdout(formatScottyConfigCheck(loaded));
    }),
  ).pipe(Command.withDescription("Validate the local TOML configuration without network access"));

  const config = Command.make("config").pipe(
    Command.withDescription("Inspect local Scotty configuration"),
    Command.withSubcommands([configCheck]),
  );

  const sync = Command.make("sync", {}, () =>
    Effect.gen(function* () {
      const { autoJson, options, runtime } = yield* commandContext();
      const prepared = yield* prepareScottyTomlSync(runtime.home, runtime.cwd);
      const target = yield* credentials(options);
      const synced = yield* synchronizeCredentialedScottyToml({
        built: prepared.built,
        credentials: prepared.credentials,
        target,
      });
      const result = {
        digest: synced.built.digest,
        items: bundleItemSummaries(synced.built.manifest),
      };
      if (autoJson) outputJson(runtime.stdout, result);
      else runtime.stdout(`Synchronized bundle ${result.digest} (${result.items.length} items).\n`);
    }),
  ).pipe(Command.withDescription("Build and synchronize the configured TOML bundle"));

  const skillShow = Command.make("show", {}, () =>
    Effect.gen(function* () {
      const { autoJson, options, runtime } = yield* commandContext();
      if (options.host !== undefined || options.tokenFile !== undefined)
        return yield* usage(
          "skill show does not accept --host or --token-file",
          "This command prints the embedded Scotty skill.",
        );
      const scottySkillContent = yield* loadEmbeddedScottySkill();
      if (autoJson) outputJson(runtime.stdout, { name: "scotty", content: scottySkillContent });
      else runtime.stdout(scottySkillContent);
    }),
  ).pipe(Command.withDescription("Print the embedded Scotty agent skill"));

  const skill = Command.make("skill").pipe(
    Command.withDescription("Inspect Scotty's embedded agent skill"),
    Command.withSubcommands([skillShow]),
  );

  const doctor = Command.make("doctor", {}, () =>
    Effect.gen(function* () {
      const { autoJson, options, runtime } = yield* commandContext();
      const config = yield* readConfig(managedInstallationPath(runtime.home));
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

  const processRunnerIsolation = Effect.fnUntraced(function* (
    hostUrl: URL,
    image: string | undefined,
    codexAuth: string | undefined,
    githubConfig: string | undefined,
  ) {
    if (!isLoopbackHost(hostUrl.hostname))
      return yield* usage(
        "--isolation process is only allowed with a loopback Scotty host",
        "Use --isolation docker for remote runners.",
      );
    if (image !== undefined) return yield* usage("--image is only valid with --isolation docker");
    if (codexAuth !== undefined)
      return yield* usage("--codex-auth is only valid with --isolation docker");
    if (githubConfig !== undefined)
      return yield* usage("--github-config is only valid with --isolation docker");
    return { type: "process" } as const;
  });

  const dockerRunnerIsolation = Effect.fnUntraced(function* (
    image: string | undefined,
    codexAuth: string | undefined,
    githubConfig: string | undefined,
  ) {
    if (image === undefined)
      return yield* usage(
        "--image is required with --isolation docker",
        "Use a digest-pinned image: REPOSITORY@sha256:DIGEST.",
      );
    if (!RUNNER_IMAGE_PATTERN.test(image))
      return yield* usage(
        "--image must be digest-pinned as REPOSITORY@sha256:64_LOWER_HEX or sha256:64_LOWER_HEX",
      );
    if (codexAuth === undefined)
      return yield* usage("--codex-auth is required with --isolation docker");
    if (githubConfig === undefined)
      return yield* usage("--github-config is required with --isolation docker");
    if (!isAbsolute(codexAuth)) return yield* usage("--codex-auth must be an absolute path");
    if (!isAbsolute(githubConfig)) return yield* usage("--github-config must be an absolute path");
    yield* validateCredentialSource("--codex-auth", codexAuth);
    yield* validateCredentialSource("--github-config", githubConfig);
    const identity = processIdentity();
    if (identity === undefined)
      return yield* usage("--isolation docker requires a numeric process uid and gid");
    return {
      type: "docker" as const,
      image,
      uid: identity.uid,
      gid: identity.gid,
      safePath: RUNNER_CONTAINER_PATH,
      codexAuthSource: codexAuth,
      githubConfigSource: githubConfig,
    };
  });

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
        const runtimeIsolation =
          isolation === "process"
            ? yield* processRunnerIsolation(hostUrl, imageValue, codexAuthValue, githubConfigValue)
            : yield* dockerRunnerIsolation(imageValue, codexAuthValue, githubConfigValue);
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

  const vaporize = Command.make(
    "vaporize",
    {
      id: Argument.string("id").pipe(Argument.withDescription("Session ID")),
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Skip the TTY confirmation")),
    },
    ({ id, yes }) => sessionOperation("vaporize", id, yes),
  ).pipe(Command.withDescription("Permanently delete a session"));

  return scotty.pipe(
    Command.withSubcommands([
      init,
      recover,
      deployInstallationCommand,
      upgrade,
      uninstall,
      repo,
      config,
      sync,
      skill,
      beam,
      list,
      inspect,
      steer,
      doctor,
      attach,
      owner,
      snapshot,
      resume,
      vaporize,
      runner,
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
