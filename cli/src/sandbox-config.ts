import { Effect, Option, Result, Schema } from "effect";
import { CliError, EXIT } from "./core";
import { scottyConfigPath, type LocalPathEnvironment } from "./local-paths";
import {
  SANDBOX_CONFIG_SCHEMA_VERSION,
  ScottyConfigSchema,
  type PiSettings,
  type SandboxStatusOutput,
  type ScottyConfig,
} from "./sandbox-config-contracts";
import { FileSystem } from "./services";

export const SANDBOX_CONFIG_FILE_NAME = "config.json";

export * from "./sandbox-config-contracts";

const decodeSandboxConfigJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(ScottyConfigSchema),
  {
    onExcessProperty: "error",
  },
);
const encodeSandboxConfig = Schema.encodeSync(ScottyConfigSchema);

export const sandboxConfigPath = (home: string, env: LocalPathEnvironment = process.env): string =>
  scottyConfigPath(home, env);

export const standardSandboxConfig = (input: {
  readonly installationName: string;
  readonly cloudflareAccountId: string;
  readonly pi: Pick<PiSettings, "defaultProvider" | "defaultModel" | "defaultThinkingLevel">;
}): ScottyConfig => ({
  schemaVersion: SANDBOX_CONFIG_SCHEMA_VERSION,
  installation: {
    name: input.installationName,
    cloudflareAccountId: input.cloudflareAccountId,
  },
  pi: {
    ...input.pi,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    theme: "dark",
    hideThinkingBlock: false,
    quietStartup: true,
    compaction: { enabled: true, reserveTokens: 40_960, keepRecentTokens: 20_000 },
    enableInstallTelemetry: false,
    enableAnalytics: false,
  },
  plugins: [
    {
      id: "cloudflare",
      type: "compute-provider",
      enabled: true,
      source: { kind: "builtin", name: "cloudflare" },
    },
    {
      id: "standard",
      type: "sandbox-tool",
      enabled: true,
      source: { kind: "builtin", name: "standard" },
    },
    {
      id: "pi-subagents-extension",
      type: "pi-extension",
      enabled: true,
      source: { kind: "builtin", name: "pi-subagents-extension" },
    },
    {
      id: "pi-subagents-skill",
      type: "skill",
      enabled: true,
      source: { kind: "builtin", name: "pi-subagents-skill" },
    },
  ],
  sandboxSetup: {
    piExtensions: ["pi-subagents-extension"],
    skills: ["pi-subagents-skill"],
    sandboxTools: ["standard"],
  },
});

export const sandboxConfigInvalid = (path: string, detail?: string): CliError =>
  new CliError(
    "sandbox_config_invalid",
    detail === undefined
      ? "Sandbox configuration is invalid"
      : `Sandbox configuration is invalid: ${detail}`,
    `Fix ${path} without removing valid entries, then retry.`,
    EXIT.USAGE,
  );

export const encodeSandboxConfigJson = (config: ScottyConfig): string =>
  `${JSON.stringify(encodeSandboxConfig(config), null, 2)}\n`;

export const decodeSandboxConfigText = (text: string): Result.Result<ScottyConfig, void> => {
  const decoded = decodeSandboxConfigJson(text);
  return Result.isFailure(decoded) ? Result.fail(undefined) : Result.succeed(decoded.success);
};

export const localSandboxStatus = (config: ScottyConfig): SandboxStatusOutput => ({
  schemaVersion: SANDBOX_CONFIG_SCHEMA_VERSION,
  installation: config.installation,
  pi: config.pi,
  plugins: config.plugins,
  sandboxSetup: config.sandboxSetup,
  remote: { status: "not_queried", activeSnapshotDigest: null },
});

const writeSandboxConfig = Effect.fnUntraced(function* (path: string, config: ScottyConfig) {
  const fileSystem = yield* FileSystem;
  yield* fileSystem.writeSecure(path, encodeSandboxConfigJson(config));
});

export const loadSandboxConfig = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem;
  const text = yield* fileSystem.readPrivateText(path).pipe(
    Effect.map(Option.some),
    Effect.catch((error) => {
      if (error.reason === "missing") return Effect.succeed(Option.none<string>());
      if (
        error.reason === "permissions" ||
        error.reason === "not_file" ||
        error.reason === "symlink"
      )
        return Effect.fail(
          new CliError(
            "sandbox_config_invalid",
            "Sandbox configuration must be a private regular file",
            `Use a non-symlinked mode-0600 file at ${path}.`,
            EXIT.USAGE,
          ),
        );
      return Effect.fail(
        new CliError(
          "sandbox_config_invalid",
          "Could not read sandbox configuration",
          `Check permissions on ${path}.`,
          EXIT.GENERIC,
        ),
      );
    }),
  );
  if (Option.isNone(text))
    return yield* new CliError(
      "sandbox_config_invalid",
      "Sandbox configuration is missing",
      `Run scotty init to create ${path}.`,
      EXIT.USAGE,
    );
  const decoded = decodeSandboxConfigText(text.value);
  if (Result.isFailure(decoded)) return yield* sandboxConfigInvalid(path);
  return decoded.success;
});

export const saveSandboxConfig = Effect.fnUntraced(function* (path: string, config: ScottyConfig) {
  yield* writeSandboxConfig(path, config);
  return config;
});
