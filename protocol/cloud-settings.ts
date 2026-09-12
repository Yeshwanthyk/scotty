import { Schema } from "effect";
import { CodexAgentSelectionSchema, PiAgentSelectionSchema } from "./agent-selection";

const SettingEnvironmentKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  Schema.isMaxLength(128),
);
const SettingEnvironmentValue = Schema.String.check(
  Schema.isMaxLength(16_384),
  Schema.makeFilter(
    (value) => !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    { expected: "an environment value without control separators" },
  ),
);
const RESERVED_ENVIRONMENT_KEY_PATTERN =
  /^(?:SCOTTY_|CODEX_|GH_|GITHUB_|HOME$|PATH$|PI_CODING_AGENT_DIR$|GIT_CONFIG_GLOBAL$|GIT_TERMINAL_PROMPT$|NODE_OPTIONS$|TERM$|LANG$|LC_ALL$|TMPDIR$|USER$|SHELL$|TZ$|OPENAI_API_KEY$|OPENAI_BASE_URL$|PI_AUTH_JSON$|CREDENTIAL_WRAPPING_KEY$|LD_PRELOAD$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/u;

export const CloudSettingsEnvironmentSchema = Schema.Record(
  SettingEnvironmentKey,
  SettingEnvironmentValue,
).check(
  Schema.makeFilter(
    (environment) =>
      Object.keys(environment).length <= 128 &&
      new TextEncoder().encode(JSON.stringify(environment)).byteLength <= 32 * 1024 &&
      Object.keys(environment).every((key) => !RESERVED_ENVIRONMENT_KEY_PATTERN.test(key)),
    { expected: "a bounded environment without Scotty runtime keys" },
  ),
);

export const CloudSettingsSchema = Schema.Struct({
  agent: Schema.Literals(["pi", "codex"]),
  pi: PiAgentSelectionSchema,
  codex: CodexAgentSelectionSchema,
  environment: CloudSettingsEnvironmentSchema,
});
export type CloudSettings = typeof CloudSettingsSchema.Type;

export const CloudSettingsSnapshotSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  activeDigest: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
  settings: CloudSettingsSchema,
});
export type CloudSettingsSnapshot = typeof CloudSettingsSnapshotSchema.Type;

export const CloudSettingsUpdateSchema = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  settings: CloudSettingsSchema,
});
export type CloudSettingsUpdate = typeof CloudSettingsUpdateSchema.Type;
export const CLOUD_SETTINGS_MAX_BODY_BYTES = 64 * 1024;
export const decodeCloudSettingsUpdate = Schema.decodeUnknownResult(CloudSettingsUpdateSchema, {
  onExcessProperty: "error",
});

export const defaultCloudSettings: CloudSettings = {
  agent: "pi",
  pi: { agent: "pi" },
  codex: { agent: "codex", model: "gpt-5.6-sol", effort: "high" },
  environment: {},
};

export const decodeCloudSettingsSnapshot = Schema.decodeUnknownResult(CloudSettingsSnapshotSchema, {
  onExcessProperty: "error",
});
