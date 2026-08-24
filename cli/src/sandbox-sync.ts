import { Effect, Schema } from "effect";
import {
  DigestSchema,
  SandboxActivationSchema,
  type ScottyConfig,
} from "../../protocol/sandbox-config";
import { CliError, EXIT } from "./core";
import { invalidResponse } from "./pure";
import { loadSandboxConfig, sandboxConfigPath } from "./sandbox-config";
import {
  sandboxArchiveInvalid,
  sandboxBundleTooLarge,
  type SandboxRemoteSnapshot,
} from "./sandbox-bundle";
import { buildSandboxBundle, type BuiltSandboxBundle } from "./sandbox-prepare";
import { FileSystem } from "./services";
import { type ApiRequestTarget, apiRequest, decodeJson, requestJson } from "./transport";

export const SandboxRemoteConfigStatusSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  installationName: Schema.NullOr(Schema.NonEmptyString),
  cloudflareAccountId: Schema.NullOr(Schema.NonEmptyString),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  activeSnapshot: Schema.NullOr(SandboxActivationSchema),
});
export type SandboxRemoteConfigStatus = typeof SandboxRemoteConfigStatusSchema.Type;

const PreparedUploadSchema = Schema.Struct({
  snapshotDigest: DigestSchema,
  pluginBundleDigest: DigestSchema,
});

export type SandboxSyncTarget = ApiRequestTarget & {
  readonly host: string;
  readonly credential: string;
};

export interface SandboxActivationPlan {
  readonly installationName: string;
  readonly currentRevision: number;
  readonly currentSnapshotDigest: string | null;
  readonly nextRevision: number;
  readonly snapshotDigest: string;
  readonly configDigest: string;
  readonly pluginBundleDigest: string;
  readonly plugins: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly source: string;
  }>;
  readonly sandboxSetup: ScottyConfig["sandboxSetup"];
}

export const formatSandboxActivationPlan = (plan: SandboxActivationPlan): string =>
  [
    `Installation: ${plan.installationName}`,
    `Current revision: ${plan.currentRevision}`,
    `Current snapshot: ${plan.currentSnapshotDigest ?? "none"}`,
    `Next revision: ${plan.nextRevision}`,
    `Snapshot: ${plan.snapshotDigest}`,
    `Config: ${plan.configDigest}`,
    `Plugin bundle: ${plan.pluginBundleDigest}`,
    "Plugins:",
    ...plan.plugins.map((plugin) => `  ${plugin.id}  ${plugin.type}  ${plugin.source}`),
    `Pi extensions: ${plan.sandboxSetup.piExtensions.join(", ") || "(none)"}`,
    `Skills: ${plan.sandboxSetup.skills.join(", ") || "(none)"}`,
    `Sandbox tools: ${plan.sandboxSetup.sandboxTools.join(", ") || "(none)"}`,
    "",
  ].join("\n");

const decodeSandboxRemoteConfigStatus = Schema.decodeUnknownEffect(
  SandboxRemoteConfigStatusSchema,
  {
    onExcessProperty: "error",
  },
);
const decodePreparedUpload = Schema.decodeUnknownEffect(PreparedUploadSchema, {
  onExcessProperty: "error",
});

const sandboxBundleActivationConflict = (message: string, hint: string): CliError =>
  new CliError("sandbox_bundle_activation_conflict", message, hint, EXIT.WRONG_STATE);

const sandboxBundleUploadFailed = (message: string, hint: string): CliError =>
  new CliError("sandbox_bundle_upload_failed", message, hint, EXIT.GENERIC);

const sandboxBundleUnavailable = (message: string, hint: string): CliError =>
  new CliError("sandbox_bundle_unavailable", message, hint, EXIT.GENERIC);

const mapSyncTransportError = (failure: CliError): CliError => {
  if (failure.code === "network_error" || failure.code === "timeout")
    return sandboxBundleUnavailable(failure.message, failure.hint);
  if (failure.code === "conflict")
    return sandboxBundleActivationConflict(failure.message, failure.hint);
  if (failure.code === "upstream") return sandboxBundleUploadFailed(failure.message, failure.hint);
  if (failure.code === "bad_request") {
    const lower = failure.message.toLowerCase();
    if (lower.includes("size") || lower.includes("limit") || lower.includes("exceed"))
      return sandboxBundleTooLarge(failure.message, failure.hint);
    return sandboxArchiveInvalid(failure.message, failure.hint);
  }
  return failure;
};

const withSyncTransportError = <A, R>(
  program: Effect.Effect<A, CliError, R>,
): Effect.Effect<A, CliError, R> => program.pipe(Effect.mapError(mapSyncTransportError));

const decodeStatusJson = Effect.fnUntraced(function* (value: unknown) {
  return yield* decodeSandboxRemoteConfigStatus(value).pipe(
    Effect.mapError(() => invalidResponse("Server returned invalid sandbox configuration")),
  );
});

const fetchRemoteConfiguration = Effect.fnUntraced(function* (target: SandboxSyncTarget) {
  const json = yield* withSyncTransportError(requestJson(target, "/api/sandbox/configuration"));
  return yield* decodeStatusJson(json);
});

const putBytes = Effect.fnUntraced(function* (
  target: SandboxSyncTarget,
  path: string,
  contentType: string,
  body: Uint8Array,
) {
  const response = yield* withSyncTransportError(
    apiRequest(target, path, {
      method: "PUT",
      headers: { "content-type": contentType },
      // lint-allow-double-cast: boundary: fetch BodyInit typings reject Uint8Array<ArrayBufferLike> views that Bun and Workers accept at runtime
      body: body as unknown as BodyInit,
    }),
  );
  return yield* decodeJson(response.bytes);
});

const uploadPreparedInputs = Effect.fnUntraced(function* (
  target: SandboxSyncTarget,
  built: BuiltSandboxBundle,
) {
  yield* putBytes(
    target,
    `/api/sandbox/plugin-bundles/${encodeURIComponent(built.pluginBundleDigest)}`,
    "application/gzip",
    built.archive,
  );
  const uploaded = yield* putBytes(
    target,
    `/api/sandbox/snapshots/${encodeURIComponent(built.snapshotDigest)}`,
    "application/json",
    new TextEncoder().encode(built.snapshotJson),
  );
  const decoded = yield* decodePreparedUpload(uploaded).pipe(
    Effect.mapError(() => invalidResponse("Server returned invalid snapshot preparation proof")),
  );
  if (
    decoded.snapshotDigest !== built.snapshotDigest ||
    decoded.pluginBundleDigest !== built.pluginBundleDigest
  )
    return yield* invalidResponse("Server returned mismatched snapshot preparation proof");
});

const activatePreparedSnapshot = Effect.fnUntraced(function* (
  target: SandboxSyncTarget,
  built: BuiltSandboxBundle,
  cloudflareAccountId: string,
  expectedRevision: number,
) {
  const json = yield* withSyncTransportError(
    requestJson(target, "/api/sandbox/configuration/activate", {
      method: "POST",
      body: JSON.stringify({
        installationName: built.snapshot.installationName,
        cloudflareAccountId,
        snapshotDigest: built.snapshotDigest,
        configDigest: built.configDigest,
        expectedRevision,
        idempotencyKey: `snapshot:${built.snapshotDigest}`,
      }),
    }),
  );
  return yield* decodeStatusJson(json);
});

const remoteSnapshot = (
  built: BuiltSandboxBundle,
  status: SandboxRemoteConfigStatus,
): SandboxRemoteSnapshot => ({
  status:
    status.activeSnapshot?.snapshotDigest === built.snapshotDigest ? "synchronized" : "diverged",
  activeSnapshotDigest: status.activeSnapshot?.snapshotDigest ?? null,
  revision: status.revision,
});

export const synchronizeSandboxBundle = Effect.fnUntraced(function* (input: {
  readonly target: SandboxSyncTarget;
  readonly config: ScottyConfig;
  readonly approveActivation: (plan: SandboxActivationPlan) => Effect.Effect<void, CliError>;
}) {
  const configuration = yield* fetchRemoteConfiguration(input.target);
  const currentCandidate = yield* buildSandboxBundle(input.config, configuration.revision);
  if (configuration.activeSnapshot?.snapshotDigest === currentCandidate.snapshotDigest)
    return { built: currentCandidate, remote: remoteSnapshot(currentCandidate, configuration) };
  const built = yield* buildSandboxBundle(input.config, configuration.revision + 1);
  yield* input.approveActivation({
    installationName: input.config.installation.name,
    currentRevision: configuration.revision,
    currentSnapshotDigest: configuration.activeSnapshot?.snapshotDigest ?? null,
    nextRevision: built.snapshot.revision,
    snapshotDigest: built.snapshotDigest,
    configDigest: built.configDigest,
    pluginBundleDigest: built.pluginBundleDigest,
    plugins: input.config.plugins.map((plugin) => ({
      id: plugin.id,
      type: plugin.type,
      source:
        plugin.source.kind === "builtin"
          ? `builtin:${plugin.source.name}`
          : `path:${plugin.source.path}`,
    })),
    sandboxSetup: input.config.sandboxSetup,
  });
  yield* uploadPreparedInputs(input.target, built);
  const activated = yield* activatePreparedSnapshot(
    input.target,
    built,
    input.config.installation.cloudflareAccountId,
    configuration.revision,
  );
  return { built, remote: remoteSnapshot(built, activated) };
});

export const synchronizeLocalSandbox = Effect.fnUntraced(function* (input: {
  readonly home: string;
  readonly env?: Record<string, string | undefined>;
  readonly target: SandboxSyncTarget;
  readonly approveActivation: (plan: SandboxActivationPlan) => Effect.Effect<void, CliError>;
}) {
  const path = sandboxConfigPath(input.home, input.env ?? process.env);
  const fileSystem = yield* FileSystem;
  const config = yield* fileSystem.withLock(path, loadSandboxConfig(path));
  const synchronized = yield* synchronizeSandboxBundle({
    target: input.target,
    config,
    approveActivation: input.approveActivation,
  });
  return { config, built: synchronized.built, remote: synchronized.remote };
});
